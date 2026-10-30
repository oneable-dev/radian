import { createHash } from "node:crypto";
import { fstatSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { capture, parseJson, StorageError, withCleanup, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { privateDirectory } from "../runtime/storage.ts";
import { preferencesSchema, workViewSchema, type RuntimePreferences } from "../runtime/protocol.ts";
import type { AppView } from "./view-state.ts";
import { restoreWorkViews, saveWorkViews } from "../runtime/work-view-preferences.ts";

const navigationSchema = Type.Object({
  version: Type.Literal(1),
  view: Type.Union([Type.Literal("chat"), workViewSchema]),
  chatSessionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  selection: preferencesSchema.properties.selection,
});
const stateSchema = Type.Object({
  version: Type.Literal(1),
  view: navigationSchema.properties.view,
  chatSessionId: navigationSchema.properties.chatSessionId,
  preferences: preferencesSchema,
  sessionScopes: Type.Optional(Type.Record(Type.String(), Type.String())),
});

type Navigation = Static<typeof navigationSchema>;
export type UiState = {
  version: 1;
  view: AppView;
  chatSessionId: string | null;
  preferences: RuntimePreferences;
  sessionScopes?: Record<string, string>;
};

// A cold runtime catalog does not prove that its sessions were closed. Keep local
// drafts until their owning scope has published an authoritative session snapshot.
export function retainedUiDrafts(
  state: UiState,
  ready: (scope: string) => boolean,
): ReadonlySet<string> {
  return new Set(
    [
      ...Object.keys(state.preferences.drafts),
      ...Object.keys(state.preferences.inputDrafts ?? {}),
    ].filter((id) => {
      const scope = state.sessionScopes?.[id];
      return !scope || !ready(scope);
    }),
  );
}

function restoreNavigation(state: UiState): UiState {
  const worktreeId = state.preferences.selection.worktreeId;
  if (state.view !== "chat" && worktreeId) {
    const views = restoreWorkViews(state.preferences);
    views.active[worktreeId] = state.view;
    saveWorkViews(state.preferences, views);
  }
  return state;
}

// A terminal/pane can reconnect to its own drafts without sharing mutable UI state
// with another attached window. Noninteractive callers get a fresh identity.
export async function currentUiIdentity(): Promise<Result<string, ExpectedError>> {
  if (process.env.TMUX_PANE) {
    return ok(`tmux:${process.env.TMUX ?? ""}:${process.env.TMUX_PANE}`);
  }
  if (process.env.TERM_SESSION_ID) {
    return ok(`terminal:${process.env.TERM_SESSION_ID}`);
  }
  if (process.env.SSH_TTY) {
    return ok(`ssh:${process.env.SSH_TTY}`);
  }
  if (!process.stdin.isTTY) {
    return ok(`client:${crypto.randomUUID()}`);
  }
  return capture(async () => {
    const info = fstatSync(process.stdin.fd);
    return `tty:${process.getuid?.() ?? "user"}:${info.rdev}:${info.ino}`;
  });
}

// The daemon owns conversations; these files own only one attached UI's state.
// Only the navigation seed is shared, so a new terminal never inherits another
// terminal's unsubmitted draft. Atomic replacement makes the last seed coherent.
export class UiStateStore {
  private readonly directory: string;
  readonly file: string;
  private readonly navigationFile: string;
  private tail: Promise<Result<void, ExpectedError>> = Promise.resolve(ok(undefined));
  private loadFailure: ExpectedError | undefined;

  constructor(directory: string, identity: string) {
    this.directory = join(directory, "ui");
    const key = createHash("sha256").update(identity).digest("hex");
    this.file = join(this.directory, `${key}.json`);
    this.navigationFile = join(this.directory, "last.json");
  }

  async load(defaults: RuntimePreferences): Promise<Result<UiState, ExpectedError>> {
    const stored = await this.read(this.file);
    if (!stored.ok) return this.failed(stored.error);
    if (stored.value !== undefined) {
      if (!Value.Check(stateSchema, stored.value)) {
        return this.failed(
          new StorageError("Invalid client UI state; the original file was retained."),
        );
      }
      return ok(restoreNavigation(structuredClone(stored.value)));
    }

    const navigation = await this.read(this.navigationFile);
    if (!navigation.ok) return this.failed(navigation.error);
    if (navigation.value !== undefined && !Value.Check(navigationSchema, navigation.value)) {
      return this.failed(
        new StorageError("Invalid last-view state; the original file was retained."),
      );
    }
    const previous = navigation.value;
    const preferences = structuredClone(defaults);
    if (previous) preferences.selection = structuredClone(previous.selection);
    return ok(
      restoreNavigation({
        version: 1,
        view: previous?.view ?? "chat",
        chatSessionId: previous?.chatSessionId ?? null,
        preferences,
      }),
    );
  }

  save(state: UiState): Promise<Result<void, ExpectedError>> {
    if (this.loadFailure) return Promise.resolve(err(this.loadFailure));
    if (!Value.Check(stateSchema, state)) {
      return Promise.resolve(err(new StorageError("Invalid client UI state was not saved.")));
    }
    const snapshot = structuredClone(state);
    this.tail = this.tail.then(() =>
      capture(async () => {
        await privateDirectory(this.directory);
        await this.write(this.file, snapshot);
        const navigation: Navigation = {
          version: 1,
          view: snapshot.view,
          chatSessionId: snapshot.chatSessionId,
          selection: snapshot.preferences.selection,
        };
        await this.write(this.navigationFile, navigation);
      }),
    );
    return this.tail;
  }

  private failed(error: ExpectedError): Result<never, ExpectedError> {
    this.loadFailure = error;
    return err(error);
  }

  private async read(file: string): Promise<Result<unknown, ExpectedError>> {
    const read = await capture(() => readFile(file, "utf8"));
    if (!read.ok) {
      return read.error instanceof StorageError && read.error.systemCode === "ENOENT"
        ? ok(undefined)
        : read;
    }
    return parseJson(read.value, "client UI state");
  }

  private async write(file: string, value: unknown): Promise<void> {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await withCleanup(
      async () => {
        await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
        await rename(temporary, file);
      },
      () => rm(temporary, { force: true }),
    );
  }
}
