import { createHash } from "node:crypto";
import { fstatSync } from "node:fs";
import { lstat, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  capture,
  parseJson,
  StorageError,
  withCleanup,
  type ErrorCode,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { privateDirectory } from "../runtime/storage.ts";
import { preferencesSchema, workViewSchema, type RuntimePreferences } from "../runtime/protocol.ts";
import type { AppView } from "./view-state.ts";
import { restoreWorkViews, saveWorkViews } from "../runtime/work-view-preferences.ts";
import {
  cleanupScopes,
  readCleanupLedger,
  withCleanupLock,
  type CleanupScope,
  type CleanupScrubSets,
} from "../runtime/restore-state.ts";
import { scrubPreferences } from "../runtime/workspace-preferences.ts";
import type { CleanupLedger } from "../runtime/daemon-protocol.ts";

// Master cleanup-ledger revision the file was scrubbed against. Files without it predate
// cleanup support and are treated as revision 0.
const cleanupRevisionSchema = Type.Optional(Type.Integer({ minimum: 0 }));
// Repository that owned each worktree key when the state was saved. Worktree IDs are paths, so
// another repository may reuse one; a deletion of the old owner must not scrub the new one.
// Files without it predate ownership tracking, and their worktree owners are unknown.
const worktreeRepositoriesSchema = Type.Optional(Type.Record(Type.String(), Type.String()));
// Ledger revision at which a cleanup scrub cleared the selected worktree. A UI that was
// detached during the deletion uses it once at startup to fall back to the existing CHAT view.
const deletedSelectionSchema = Type.Optional(Type.Integer({ minimum: 1 }));

const navigationSchema = Type.Object({
  version: Type.Literal(1),
  view: Type.Union([Type.Literal("chat"), workViewSchema]),
  chatSessionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  selection: preferencesSchema.properties.selection,
  worktreeRepositories: worktreeRepositoriesSchema,
  cleanupRevision: cleanupRevisionSchema,
  deletedSelectionRevision: deletedSelectionSchema,
});
const stateSchema = Type.Object({
  version: Type.Literal(1),
  view: navigationSchema.properties.view,
  chatSessionId: navigationSchema.properties.chatSessionId,
  preferences: preferencesSchema,
  sessionScopes: Type.Optional(Type.Record(Type.String(), Type.String())),
  worktreeRepositories: worktreeRepositoriesSchema,
  cleanupRevision: cleanupRevisionSchema,
  deletedSelectionRevision: deletedSelectionSchema,
});

type Navigation = Static<typeof navigationSchema>;
export type UiState = {
  version: 1;
  view: AppView;
  chatSessionId: string | null;
  preferences: RuntimePreferences;
  sessionScopes?: Record<string, string>;
  worktreeRepositories?: Record<string, string>;
  cleanupRevision?: number;
  deletedSelectionRevision?: number;
};

/** Worktree IDs that key any state in `state`. */
export function referencedWorktrees(
  state: Pick<UiState, "preferences" | "sessionScopes" | "worktreeRepositories">,
) {
  const { selection, workViews, gitViews, terminalViews } = state.preferences;

  return new Set([
    ...(selection.worktreeId ? [selection.worktreeId] : []),
    ...Object.keys(selection.sessions),
    ...Object.keys(workViews?.active ?? {}),
    ...Object.keys(gitViews ?? {}),
    ...(terminalViews?.active ?? []),
    ...Object.keys(terminalViews?.selected ?? {}),
    ...Object.values(state.sessionScopes ?? {}),
    ...Object.keys(state.worktreeRepositories ?? {}),
  ]);
}

/** Deletions to apply to one UI state, and worktree keys retained because their owner is unknown. */
export type UiScrub = CleanupScrubSets & { readonly ambiguous: ReadonlySet<string> };

type OwnedState = Pick<UiState, "preferences" | "sessionScopes" | "worktreeRepositories">;

/** Owner lookup for persisted state: its recorded owner first, then `fallback` (current catalog). */
export function recordedOwner(
  state: Pick<UiState, "worktreeRepositories">,
  fallback: (worktreeId: string) => string | undefined = () => undefined,
): (worktreeId: string) => string | undefined {
  return (id) => state.worktreeRepositories?.[id] ?? fallback(id);
}

/**
 * Resolves which worktree keys of `state` belong to the deleted scopes.
 *
 * Session IDs of a receipt are precise and always deleted. A worktree key is deleted only when
 * `owner` reports the receipt's repository. When the owner is unknown (state saved before
 * ownership tracking), the key is deleted only if the state links it to one of the receipt's own
 * sessions; otherwise it is retained and reported as ambiguous instead of guessing and erasing
 * another repository's state at a reused path.
 */
export function resolveUiScrub(
  state: Pick<UiState, "preferences" | "sessionScopes" | "worktreeRepositories">,
  scopes: readonly CleanupScope[],
  owner: (worktreeId: string) => string | undefined,
): UiScrub {
  const worktreeIds = new Set<string>();
  const sessionIds = new Set<string>();
  const ambiguous = new Set<string>();
  const referenced = referencedWorktrees(state);
  for (const scope of scopes) {
    const receiptSessions = new Set(scope.sessionIds);
    for (const id of receiptSessions) sessionIds.add(id);

    const candidates = new Set(scope.worktreeIds);
    if (scope.wholeRepository) {
      for (const id of referenced) {
        if (owner(id) === scope.repositoryId) candidates.add(id);
      }
    }
    for (const id of candidates) {
      const known = owner(id);
      if (known !== undefined) {
        if (known === scope.repositoryId) worktreeIds.add(id);
        continue;
      }

      const selected = state.preferences.selection.sessions[id];
      const linked =
        (selected !== undefined && receiptSessions.has(selected)) ||
        Object.entries(state.sessionScopes ?? {}).some(
          ([session, tree]) => tree === id && receiptSessions.has(session),
        );
      if (linked) worktreeIds.add(id);
      else if (referenced.has(id)) ambiguous.add(id);
    }
  }
  for (const id of worktreeIds) ambiguous.delete(id);

  return { worktreeIds, sessionIds, ambiguous };
}

/**
 * Removes UI state of deleted worktrees and sessions while keeping CHAT navigation, its
 * conversation and drafts, and every unrelated scope. Sessions recorded under a deleted
 * worktree scope are treated as deleted too. `sets` must already be ownership-resolved.
 */
export function scrubUiState(state: UiState, sets: CleanupScrubSets): UiState {
  const sessionIds = new Set(sets.sessionIds);
  for (const [sessionId, scope] of Object.entries(state.sessionScopes ?? {})) {
    if (sets.worktreeIds.has(scope)) sessionIds.add(sessionId);
  }

  const scrubbed: UiState = {
    ...structuredClone(state),
    preferences: scrubPreferences(state.preferences, {
      worktreeIds: sets.worktreeIds,
      sessionIds,
    }),
  };
  if (state.sessionScopes) {
    scrubbed.sessionScopes = Object.fromEntries(
      Object.entries(state.sessionScopes).filter(
        ([sessionId, scope]) => !sessionIds.has(sessionId) && !sets.worktreeIds.has(scope),
      ),
    );
  }
  if (state.worktreeRepositories) {
    scrubbed.worktreeRepositories = withoutKeys(state.worktreeRepositories, sets.worktreeIds);
  }

  return scrubbed;
}

function scrubNavigation(navigation: Navigation, sets: CleanupScrubSets): Navigation {
  const preferences = scrubPreferences(
    { selection: navigation.selection, drafts: {} },
    { worktreeIds: sets.worktreeIds, sessionIds: sets.sessionIds },
  );
  const scrubbed: Navigation = { ...structuredClone(navigation), selection: preferences.selection };
  if (navigation.worktreeRepositories) {
    scrubbed.worktreeRepositories = withoutKeys(navigation.worktreeRepositories, sets.worktreeIds);
  }

  return scrubbed;
}

const withoutKeys = (record: Record<string, string>, keys: ReadonlySet<string>) =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !keys.has(key)));

const navigationState = (navigation: Navigation): OwnedState => ({
  preferences: { selection: navigation.selection, drafts: {} },
  ...(navigation.worktreeRepositories
    ? { worktreeRepositories: navigation.worktreeRepositories }
    : {}),
});

// The marker of a scrub that cleared a selected worktree, else the one already recorded.
function selectionMarker(
  before: string | null,
  after: string | null,
  revision: number,
  previous: number | undefined,
): number | undefined {
  return before !== null && after === null ? revision : previous;
}

// The shared navigation seed with the owners of its selection keys only.
function navigationOf(state: UiState): Navigation {
  const { selection } = state.preferences;
  const keys = new Set([
    ...(selection.worktreeId ? [selection.worktreeId] : []),
    ...Object.keys(selection.sessions),
  ]);
  const owners = Object.fromEntries(
    Object.entries(state.worktreeRepositories ?? {}).filter(([id]) => keys.has(id)),
  );

  return {
    version: 1,
    view: state.view,
    chatSessionId: state.chatSessionId,
    selection,
    ...(state.worktreeRepositories ? { worktreeRepositories: owners } : {}),
    ...(state.cleanupRevision !== undefined ? { cleanupRevision: state.cleanupRevision } : {}),
    ...(state.deletedSelectionRevision !== undefined
      ? { deletedSelectionRevision: state.deletedSelectionRevision }
      : {}),
  };
}

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
//
// Every read-modify-write runs under the daemon's cleanup lock and is scrubbed against the
// cleanup ledger read inside it, so a snapshot captured before a workspace deletion, in this or
// another TUI process, cannot restore the deleted scope after the daemon purged it.
export class UiStateStore {
  private readonly daemonDirectory: string;
  private readonly directory: string;
  readonly file: string;
  private readonly navigationFile: string;
  private tail: Promise<Result<void, ExpectedError>> = Promise.resolve(ok(undefined));
  private loadFailure: ExpectedError | undefined;
  private acknowledged = 0;
  private deletedSelection = false;

  constructor(directory: string, identity: string) {
    this.daemonDirectory = directory;
    this.directory = join(directory, "ui");
    const key = createHash("sha256").update(identity).digest("hex");
    this.file = join(this.directory, `${key}.json`);
    this.navigationFile = join(this.directory, "last.json");
  }

  /**
   * Records that this UI scrubbed its in-memory state for every cleanup up to `revision`
   * (`snapshot.deletedScopes.revision`). Call it only after scrubbing; saves requested earlier
   * keep the revision they captured, so their snapshots are still scrubbed.
   */
  acknowledgeCleanup(revision: number): void {
    this.acknowledged = Math.max(this.acknowledged, revision);
  }

  /** Highest cleanup revision this UI has scrubbed for (from load() or acknowledgeCleanup()). */
  get acknowledgedCleanup(): number {
    return this.acknowledged;
  }

  /**
   * True when a cleanup scrub (this load, an earlier save or the daemon's purge while this UI was
   * detached) cleared the selected worktree and no later save of this UI consumed that. The caller
   * falls back from a Code view once; cold or unavailable workspaces never set it.
   */
  get selectionDeleted(): boolean {
    return this.deletedSelection;
  }

  /**
   * Loads this UI's state scrubbed against the cleanup ledger. `owners` maps worktree IDs of the
   * current catalog to their repositories; it resolves worktree keys without a recorded owner.
   */
  async load(
    defaults: RuntimePreferences,
    owners: ReadonlyMap<string, string> = new Map(),
  ): Promise<Result<UiState, ExpectedError>> {
    // Files and the ledger are read together under the lock so a purge cannot interleave.
    const loaded = await this.withLock(() => this.loadLocked(defaults, owners));
    if (!loaded.ok) return this.failed(loaded.error);

    return loaded;
  }

  private async loadLocked(
    defaults: RuntimePreferences,
    owners: ReadonlyMap<string, string>,
  ): Promise<Result<UiState, ExpectedError>> {
    const ledger = await readCleanupLedger(this.daemonDirectory);
    if (!ledger.ok) return ledger;
    const current = (id: string) => owners.get(id);

    const stored = await this.read(this.file);
    if (!stored.ok) return stored;
    if (stored.value !== undefined) {
      if (!Value.Check(stateSchema, stored.value)) {
        return err(new StorageError("Invalid client UI state; the original file was retained."));
      }
      const scopes = cleanupScopes(ledger.value.receipts, stored.value.cleanupRevision ?? 0);
      const sets = resolveUiScrub(stored.value, scopes, recordedOwner(stored.value, current));
      this.acknowledge(ledger.value);
      const {
        cleanupRevision: _revision,
        deletedSelectionRevision: marker,
        ...state
      } = scrubUiState(stored.value, sets);
      this.deletedSelection =
        selectionMarker(
          stored.value.preferences.selection.worktreeId,
          state.preferences.selection.worktreeId,
          ledger.value.revision,
          marker,
        ) !== undefined;
      return ok(restoreNavigation(state));
    }

    const navigation = await this.read(this.navigationFile);
    if (!navigation.ok) return navigation;
    if (navigation.value !== undefined && !Value.Check(navigationSchema, navigation.value)) {
      return err(new StorageError("Invalid last-view state; the original file was retained."));
    }
    let previous: Navigation | undefined;
    if (navigation.value) {
      const seed = navigationState(navigation.value);
      const scopes = cleanupScopes(ledger.value.receipts, navigation.value.cleanupRevision ?? 0);
      previous = scrubNavigation(
        navigation.value,
        resolveUiScrub(seed, scopes, recordedOwner(seed, current)),
      );
      this.deletedSelection =
        selectionMarker(
          navigation.value.selection.worktreeId,
          previous.selection.worktreeId,
          ledger.value.revision,
          navigation.value.deletedSelectionRevision,
        ) !== undefined;
    }
    // Defaults come from the current daemon snapshot, so reopened scopes in them are fresh;
    // deleted sessions and unreopened scopes are still removed in case the daemon lags behind.
    this.acknowledge(ledger.value);
    const preferences = scrubPreferences(
      defaults,
      resolveUiScrub(
        { preferences: defaults },
        cleanupScopes(ledger.value.receipts, ledger.value.revision),
        current,
      ),
    );
    if (previous) preferences.selection = structuredClone(previous.selection);
    return ok(
      restoreNavigation({
        version: 1,
        view: previous?.view ?? "chat",
        chatSessionId: previous?.chatSessionId ?? null,
        preferences,
        ...(previous?.worktreeRepositories
          ? { worktreeRepositories: structuredClone(previous.worktreeRepositories) }
          : {}),
      }),
    );
  }

  save(state: UiState): Promise<Result<void, ExpectedError>> {
    if (this.loadFailure) return Promise.resolve(err(this.loadFailure));
    if (!Value.Check(stateSchema, state)) {
      return Promise.resolve(err(new StorageError("Invalid client UI state was not saved.")));
    }
    const snapshot = structuredClone(state);
    // Captured now: an acknowledgement after this call does not cover this older snapshot.
    const acknowledged = this.acknowledged;
    this.tail = this.tail.then(() =>
      this.withLock(async () => {
        const ledger = await readCleanupLedger(this.daemonDirectory);
        if (!ledger.ok) return ledger;

        // Worktree keys without a recorded owner are kept unless linked to a deleted session.
        const scopes = cleanupScopes(ledger.value.receipts, acknowledged);
        const scrubbed = scrubUiState(
          snapshot,
          resolveUiScrub(snapshot, scopes, recordedOwner(snapshot)),
        );
        const marker = selectionMarker(
          snapshot.preferences.selection.worktreeId,
          scrubbed.preferences.selection.worktreeId,
          ledger.value.revision,
          snapshot.deletedSelectionRevision,
        );
        const clean: UiState = {
          ...scrubbed,
          cleanupRevision: ledger.value.revision,
          ...(marker !== undefined ? { deletedSelectionRevision: marker } : {}),
        };
        if (marker === undefined) delete clean.deletedSelectionRevision;
        return capture(async () => {
          await privateDirectory(this.directory);
          await this.write(this.file, clean);
          await this.write(this.navigationFile, navigationOf(clean));
        });
      }),
    );
    return this.tail;
  }

  private async withLock<T>(
    task: () => Promise<Result<T, ExpectedError>>,
  ): Promise<Result<T, ExpectedError>> {
    const prepared = await capture(() => privateDirectory(this.daemonDirectory));

    return prepared.ok ? withCleanupLock(this.daemonDirectory, task) : prepared;
  }

  private acknowledge(ledger: CleanupLedger): void {
    this.acknowledged = Math.max(this.acknowledged, ledger.revision);
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
    await writeAtomically(file, value);
  }
}

async function writeAtomically(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await withCleanup(
    async () => {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    },
    () => rm(temporary, { force: true }),
  );
}

export type UiCleanupItem = { path: string; reason: string; code?: ErrorCode };
export type UiPurgeReport = {
  // Documents rewritten without deleted scopes, including unpublished temporary documents.
  rewritten: string[];
  // Kept for the cleanup report shape; the UI purge never removes files.
  removed: string[];
  // Files that could not be verified or scrubbed, and worktree state retained because its owner is
  // unknown. Any residual makes the cleanup incomplete.
  residuals: UiCleanupItem[];
};

// `<file>.json.<uuid>.tmp`: a document whose atomic replacement did not finish.
const temporaryDocument = /^(.+\.json)\.[0-9a-f-]{36}\.tmp$/;

/**
 * Scrubs every attached UI's persisted state (`ui/*.json`, including `last.json`, and unpublished
 * temporary documents) against the master cleanup ledger. Acquires the cleanup lock itself;
 * callers must not hold it.
 *
 * Nothing is removed: a crashed temporary document may still hold unrelated CHAT or sibling
 * drafts, so it is scrubbed like a published one. Invalid or unreadable documents, non-regular
 * entries and a `ui` directory that is not this user's real directory (for example a symlink to
 * another state directory) are residuals and never traversed or overwritten. Worktree state with
 * an unknown owner is retained and reported as a residual while a receipt covering it is still
 * being purged, so that cleanup never completes silently.
 */
export function purgeUiState(
  daemonDirectory: string,
): Promise<Result<UiPurgeReport, ExpectedError>> {
  return withCleanupLock(daemonDirectory, async () => {
    const ledger = await readCleanupLedger(daemonDirectory);
    if (!ledger.ok) return ledger;

    const report: UiPurgeReport = { rewritten: [], removed: [], residuals: [] };
    const directory = join(daemonDirectory, "ui");
    const verified = await ownedDirectory(directory);
    if (!verified.ok) {
      report.residuals.push(residual(directory, verified.error));
      return ok(report);
    }
    if (!verified.value) return ok(report);

    const listed = await capture(() => readdir(directory));
    if (!listed.ok) {
      return listed.error instanceof StorageError && listed.error.systemCode === "ENOENT"
        ? ok(report)
        : listed;
    }

    for (const name of listed.value.toSorted()) {
      const document = temporaryDocument.exec(name)?.[1] ?? name;
      if (!document.endsWith(".json")) continue;

      const path = join(directory, name);
      const scrubbed = await purgeUiFile(path, document === "last.json", ledger.value);
      if (!scrubbed.ok) {
        report.residuals.push(residual(path, scrubbed.error));
        continue;
      }
      if (scrubbed.value.rewritten) report.rewritten.push(path);
      if (scrubbed.value.ambiguous.size) {
        report.residuals.push({
          path,
          reason: `Retained UI state of worktrees with an unknown owner: ${[...scrubbed.value.ambiguous].join(", ")}`,
          code: "CLEANUP_FAILED",
        });
      }
    }

    return ok(report);
  });
}

// Ok(false) when the directory does not exist. A symlink, non-directory or foreign owner is an
// error: following it could rewrite another state directory's documents.
async function ownedDirectory(directory: string): Promise<Result<boolean, ExpectedError>> {
  const stat = await capture(() => lstat(directory));
  if (!stat.ok) {
    return stat.error instanceof StorageError && stat.error.systemCode === "ENOENT"
      ? ok(false)
      : stat;
  }
  const info = stat.value;
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) {
    return err(new StorageError("UI state directory is not this user's directory; not traversed."));
  }

  return ok(true);
}

const residual = (path: string, error: ExpectedError): UiCleanupItem => ({
  path,
  reason: error.message,
  code: error.code,
});

type PurgedFile = { rewritten: boolean; ambiguous: ReadonlySet<string> };

async function purgeUiFile(
  path: string,
  navigation: boolean,
  ledger: CleanupLedger,
): Promise<Result<PurgedFile, ExpectedError>> {
  const unchanged: PurgedFile = { rewritten: false, ambiguous: new Set() };
  const stat = await capture(() => lstat(path));
  if (!stat.ok) {
    return stat.error instanceof StorageError && stat.error.systemCode === "ENOENT"
      ? ok(unchanged)
      : stat;
  }
  if (!stat.value.isFile()) {
    return err(new StorageError("UI state entry is not a regular file; it was retained."));
  }
  const read = await capture(() => readFile(path, "utf8"));
  if (!read.ok) {
    return read.error instanceof StorageError && read.error.systemCode === "ENOENT"
      ? ok(unchanged)
      : read;
  }
  const json = parseJson(read.value, "client UI state");
  if (!json.ok) return json;

  // Receipts still being purged report retained unknown-owner state even when this document was
  // already saved against their revision, so the cleanup cannot complete silently.
  const purging = cleanupScopes(
    ledger.receipts.filter((receipt) => receipt.state === "fenced"),
    ledger.revision,
  );
  let next: UiState | Navigation;
  let sets: UiScrub;
  let ambiguous: ReadonlySet<string>;
  if (navigation && Value.Check(navigationSchema, json.value)) {
    const seed = navigationState(json.value);
    const scopes = cleanupScopes(ledger.receipts, json.value.cleanupRevision ?? 0);
    sets = resolveUiScrub(seed, scopes, recordedOwner(seed));
    ambiguous = union(sets.ambiguous, resolveUiScrub(seed, purging, recordedOwner(seed)).ambiguous);
    if (scrubSetsEmpty(sets)) return ok({ rewritten: false, ambiguous });
    next = withCleanupMarks(scrubNavigation(json.value, sets), json.value, ledger.revision);
  } else if (!navigation && Value.Check(stateSchema, json.value)) {
    const owner = recordedOwner(json.value);
    const scopes = cleanupScopes(ledger.receipts, json.value.cleanupRevision ?? 0);
    sets = resolveUiScrub(json.value, scopes, owner);
    ambiguous = union(sets.ambiguous, resolveUiScrub(json.value, purging, owner).ambiguous);
    if (scrubSetsEmpty(sets)) return ok({ rewritten: false, ambiguous });
    next = withCleanupMarks(scrubUiState(json.value, sets), json.value, ledger.revision);
  } else {
    return err(new StorageError("Unrecognized client UI state; the file was retained."));
  }
  if (JSON.stringify(next) === read.value) return ok({ rewritten: false, ambiguous });

  const written = await capture(() => writeAtomically(path, next));
  return written.ok ? ok({ rewritten: true, ambiguous }) : written;
}

const union = (a: ReadonlySet<string>, b: ReadonlySet<string>) => new Set([...a, ...b]);

// Records the purge revision and marks a selection the purge cleared, so the detached UI falls
// back to the existing CHAT view when it reconnects.
function withCleanupMarks<T extends UiState | Navigation>(
  scrubbed: T,
  original: T,
  revision: number,
): T {
  const selection = (value: UiState | Navigation) =>
    "preferences" in value ? value.preferences.selection : value.selection;
  const marker = selectionMarker(
    selection(original).worktreeId,
    selection(scrubbed).worktreeId,
    revision,
    original.deletedSelectionRevision,
  );
  const next: T = { ...scrubbed, cleanupRevision: revision };
  if (marker !== undefined) next.deletedSelectionRevision = marker;

  return next;
}

const scrubSetsEmpty = (sets: CleanupScrubSets) =>
  sets.worktreeIds.size === 0 && sets.sessionIds.size === 0;
