import { createHash, randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  manifestSchema,
  sessionRecordSchema,
  type RuntimeManifest,
  type RuntimePreferences,
} from "./protocol.ts";
import type { SessionDeletionCandidate, SessionRecord } from "../agents/session-registry.ts";
import type { CleanupReceipt, ScopeWorktree } from "./daemon-protocol.ts";
import {
  deleteWorkflowForPurge,
  deleteWorkflowForRetention,
  inspectWorkflowForRetention,
  inspectedWorkflowSchema,
  recheckWorkflowForRetention,
  workflowBackupFilePath,
  workflowFilePath,
  workflowLinkFilePath,
  workflowRetentionMatches,
  type InspectedWorkflow,
} from "../agents/task-workflow-store.ts";
import {
  deleteTaskPlanForPurge,
  deleteTaskPlanForRetention,
  planFilePath,
  inspectTaskPlanForRetention,
  recheckTaskPlanForRetention,
  type InspectedTaskPlan,
  type PlanOwner,
} from "../agents/task-plan-store.ts";
import {
  sessionRecordKey,
  type SessionSnapshotInfo,
  type SessionSnapshotSource,
} from "../agents/session-snapshot.ts";
import {
  CancelledError,
  capture,
  CleanupError,
  InputError,
  parseJson,
  StorageError,
  withCleanup,
  type ErrorCode,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import {
  deleteRetainedFile,
  inspectRetainedFile,
  removeRetentionFile,
  sessionExpired,
} from "./session-retention.ts";
import { withStateLock } from "./state-lock.ts";

export type RuntimePaths = {
  directory: string;
  socket: string;
  lock: string;
  log: string;
  manifest: string;
};

export function runtimePaths(
  repositoryId: string,
  offline: boolean,
  stateRoot = process.env.RADIAN_STATE_DIR ?? join(homedir(), ".radian"),
): RuntimePaths {
  const key = createHash("sha256")
    .update(`${resolve(stateRoot)}\0${repositoryId}\0${offline}`)
    .digest("hex")
    .slice(0, 32);
  const directory = join(resolve(stateRoot), "workspaces", key);
  // Keep the address below macOS's Unix socket path limit, even with long state-directory names.
  const endpoint = join("/tmp", `radian-${process.getuid?.() ?? "user"}`);

  return {
    directory,
    socket: join(endpoint, `${key}.sock`),
    lock: join(endpoint, `${key}.lock`),
    log: join(directory, "runtime.log"),
    manifest: join(directory, "workspace.json"),
  };
}

// The process identity is independent of repositories; their persisted paths above stay unchanged.
export function daemonPaths(
  offline: boolean,
  stateRoot = process.env.RADIAN_STATE_DIR ?? join(homedir(), ".radian"),
): RuntimePaths {
  const key = createHash("sha256")
    .update(`daemon-v1\0${resolve(stateRoot)}\0${offline}`)
    .digest("hex")
    .slice(0, 32);
  const directory = join(resolve(stateRoot), "daemon", offline ? "offline" : "live");
  const endpoint = join("/tmp", `radian-${process.getuid?.() ?? "user"}`);

  return {
    directory,
    socket: join(endpoint, `${key}.sock`),
    lock: join(endpoint, `${key}.lock`),
    log: join(directory, "runtime.log"),
    manifest: join(directory, "repositories.json"),
  };
}

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });

  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new StorageError(`Runtime directory is not owned by this user: ${path}`);
  }

  await chmod(path, 0o700);
}

const snapshotIndexSchema = Type.Object({
  key: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  revision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  id: sessionRecordSchema.properties.id,
  name: Type.String(),
  worktreeId: sessionRecordSchema.properties.worktreeId,
  conversationId: Type.Optional(sessionRecordSchema.properties.id),
  sessionFile: sessionRecordSchema.properties.sessionFile,
  cwd: sessionRecordSchema.properties.cwd,
  closedAt: sessionRecordSchema.properties.closedAt,
  managed: sessionRecordSchema.properties.managed,
  cleanupPending: Type.Optional(Type.Boolean()),
  cleanupPlan: Type.Optional(
    Type.Union([
      Type.Object({ kind: Type.Literal("absent") }),
      Type.Object({
        kind: Type.Literal("ready"),
        fingerprint: Type.Object({
          dev: Type.Number(),
          ino: Type.Number(),
          size: Type.Number(),
          mtimeMs: Type.Number(),
          ctimeMs: Type.Number(),
        }),
        updatedAt: Type.Number(),
      }),
    ]),
  ),
  cleanupWorkflow: Type.Optional(inspectedWorkflowSchema),
  expiredAt: sessionRecordSchema.properties.updatedAt,
  lifecycle: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
  updatedAt: Type.Integer({ minimum: 0, maximum: 8640000000000000 }),
  title: Type.String(),
  messageCount: Type.Integer({ minimum: 0 }),
});
const storedManifestSchema = Type.Object({
  ...manifestSchema.properties,
  storageVersion: Type.Literal(2),
  records: Type.Array(snapshotIndexSchema),
});

type SnapshotIndex = Static<typeof snapshotIndexSchema>;

// ---------------------------------------------------------------------------------------------
// Workspace-deletion fences
//
// `cleanup.json` is a per-repository ledger of deletion receipts. It stores identities only.
// Every RuntimeStore operation and every purge step runs under `state.lock`, so stores in
// different instances or processes cannot interleave a stale checkpoint with a purge.
// ---------------------------------------------------------------------------------------------

export class ScopeDeletedError extends CancelledError {
  constructor(
    readonly token: string,
    message = "This workspace scope was deleted; its state is no longer written.",
  ) {
    super(message);
  }
}

export type RuntimeCleanupState = "fenced" | "purged" | "reopened";
export type RuntimeCleanupItem = { path: string; reason: string; code?: ErrorCode };
export type RuntimeCleanupStatus = {
  token: string;
  repositoryId: string;
  kind: "repository" | "worktrees";
  worktreeIds: string[];
  worktrees?: ScopeWorktree[];
  state: RuntimeCleanupState;
  sessionIds: string[];
  candidates: number;
};
export type RuntimeCleanupReport = RuntimeCleanupStatus & {
  complete: boolean;
  removed: string[];
  preserved: RuntimeCleanupItem[];
  residuals: RuntimeCleanupItem[];
};

const pathText = Type.String({ minLength: 1, maxLength: 4096, pattern: "^[^\\u0000]+$" });
const ledgerCandidateSchema = Type.Object(
  {
    worktreeId: pathText,
    sessionId: pathText,
    conversationId: pathText,
    sessionFile: Type.Optional(pathText),
  },
  { additionalProperties: false },
);
const ledgerReceiptSchema = Type.Object(
  {
    token: Type.String({ pattern: "^[A-Za-z0-9-]{8,128}$" }),
    repositoryId: pathText,
    kind: Type.Union([Type.Literal("repository"), Type.Literal("worktrees")]),
    worktrees: Type.Array(Type.Object({ id: pathText, path: pathText }), { maxItems: 4096 }),
    sessionIds: Type.Array(pathText, { maxItems: 65536 }),
    masterRevision: Type.Integer({ minimum: 0 }),
    // Ledger revision at which this receipt was recorded or last reopened.
    localRevision: Type.Integer({ minimum: 1 }),
    state: Type.Union([Type.Literal("fenced"), Type.Literal("purged"), Type.Literal("reopened")]),
    candidates: Type.Array(ledgerCandidateSchema, { maxItems: 65536 }),
  },
  { additionalProperties: false },
);
const ledgerSchema = Type.Object(
  {
    version: Type.Literal(1),
    // Changes only on repository reopen; RuntimeStores of an older generation never write again.
    generation: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    revision: Type.Integer({ minimum: 0 }),
    receipts: Type.Array(ledgerReceiptSchema, { maxItems: 1024 }),
  },
  { additionalProperties: false },
);

type LedgerReceipt = Static<typeof ledgerReceiptSchema>;
type Ledger = Static<typeof ledgerSchema>;

const emptyLedger = (): Ledger => ({ version: 1, generation: null, revision: 0, receipts: [] });
const ledgerPath = (paths: RuntimePaths) => join(paths.directory, "cleanup.json");
const lockPath = (paths: RuntimePaths) => join(paths.directory, "state.lock");

type InProcessFence = { token: string; kind: "repository" | "worktrees"; worktreeIds: Set<string> };
// Keyed by resolved runtime directory; shared by every RuntimeStore instance in this process.
const processFences = new Map<string, Map<string, InProcessFence>>();

function fencesOf(paths: RuntimePaths): Map<string, InProcessFence> {
  const key = resolve(paths.directory);
  let fences = processFences.get(key);
  if (!fences) {
    fences = new Map();
    processFences.set(key, fences);
  }

  return fences;
}

/**
 * Blocks persisted writes of a deletion scope in this process immediately and synchronously.
 * Repository fences reject queued and future saves; worktree fences strip that scope from them.
 */
export function fenceRuntimeWrites(
  paths: RuntimePaths,
  fence: { token: string; kind: "repository" | "worktrees"; worktreeIds: readonly string[] },
): void {
  fencesOf(paths).set(fence.token, {
    token: fence.token,
    kind: fence.kind,
    worktreeIds: new Set(fence.worktreeIds),
  });
}

function unfenceRuntimeWrites(paths: RuntimePaths, token: string): void {
  fencesOf(paths).delete(token);
}

function parseLedger(text: string): Result<Ledger, StorageError> {
  const parsed = parseJson(text, "runtime cleanup ledger");
  if (!parsed.ok || !Value.Check(ledgerSchema, parsed.value)) {
    return err(new StorageError("Invalid runtime cleanup ledger; the original file was retained."));
  }

  return ok(parsed.value);
}

function readLedgerSync(paths: RuntimePaths): Result<Ledger, StorageError> {
  try {
    return parseLedger(readFileSync(ledgerPath(paths), "utf8"));
  } catch (error) {
    const code = systemCodeOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return ok(emptyLedger());
    }
    if (code) {
      return err(new StorageError(`Could not read runtime cleanup ledger (${code}).`, code));
    }

    throw error;
  }
}

async function readLedger(paths: RuntimePaths): Promise<Result<Ledger, ExpectedError>> {
  const read = await capture(() => readFile(ledgerPath(paths), "utf8"));
  if (!read.ok) {
    return read.error instanceof StorageError && read.error.systemCode === "ENOENT"
      ? ok(emptyLedger())
      : read;
  }

  return parseLedger(read.value);
}

function writeLedger(paths: RuntimePaths, ledger: Ledger): Promise<Result<void, ExpectedError>> {
  return capture(() => atomicWrite(ledgerPath(paths), JSON.stringify(ledger)));
}

function systemCodeOf(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function statusOf(receipt: LedgerReceipt): RuntimeCleanupStatus {
  return {
    token: receipt.token,
    repositoryId: receipt.repositoryId,
    kind: receipt.kind,
    worktreeIds: receipt.worktrees.map((tree) => tree.id),
    worktrees: receipt.worktrees.map((tree) => ({ ...tree })),
    state: receipt.state,
    sessionIds: [...receipt.sessionIds],
    candidates: receipt.candidates.length,
  };
}

// What a RuntimeStore may still write, given the ledger and fences it observed.
type WriteGuard = { hidden: Set<string>; rejected: string | undefined };

function guardFor(
  ledger: Ledger,
  observed: { generation: string | null; revision: number },
  fences: readonly InProcessFence[],
): WriteGuard {
  const hidden = new Set<string>();
  let rejected: string | undefined;
  if (ledger.generation !== observed.generation) {
    rejected = ledger.receipts.findLast((receipt) => receipt.kind === "repository")?.token ?? "";
  }
  for (const receipt of ledger.receipts) {
    // A reopened scope stays hidden from stores that observed it before reopening.
    const active = receipt.state !== "reopened" || receipt.localRevision > observed.revision;
    if (!active) continue;
    if (receipt.kind === "repository") {
      rejected ??= receipt.token;
    } else {
      for (const tree of receipt.worktrees) hidden.add(tree.id);
    }
  }
  for (const fence of fences) {
    if (fence.kind === "repository") {
      rejected ??= fence.token;
    } else {
      for (const id of fence.worktreeIds) hidden.add(id);
    }
  }

  return { hidden, rejected };
}

/** Removes every persisted preference entry that belongs to hidden worktrees or sessions. */
function scrubPreferences(
  preferences: RuntimePreferences,
  worktrees: ReadonlySet<string>,
  sessions: ReadonlySet<string>,
): RuntimePreferences {
  if (!worktrees.size && !sessions.size) {
    return preferences;
  }

  const byTree = <T>(record: Readonly<Record<string, T>> | undefined): Record<string, T> =>
    Object.fromEntries(Object.entries(record ?? {}).filter(([id]) => !worktrees.has(id)));
  const bySession = <T>(record: Readonly<Record<string, T>> | undefined): Record<string, T> =>
    Object.fromEntries(Object.entries(record ?? {}).filter(([id]) => !sessions.has(id)));
  const selected = preferences.selection.worktreeId;

  return {
    ...preferences,
    selection: {
      worktreeId: selected && worktrees.has(selected) ? null : selected,
      sessions: Object.fromEntries(
        Object.entries(preferences.selection.sessions).filter(
          ([tree, session]) => !worktrees.has(tree) && !sessions.has(session),
        ),
      ),
    },
    drafts: bySession(preferences.drafts),
    ...(preferences.inputDrafts ? { inputDrafts: bySession(preferences.inputDrafts) } : {}),
    ...(preferences.workViews
      ? {
          workViews: {
            active: byTree(preferences.workViews.active),
            agentScroll: bySession(preferences.workViews.agentScroll),
          },
        }
      : {}),
    ...(preferences.gitViews ? { gitViews: byTree(preferences.gitViews) } : {}),
    ...(preferences.agentViews ? { agentViews: bySession(preferences.agentViews) } : {}),
    ...(preferences.terminalViews
      ? {
          terminalViews: {
            active: preferences.terminalViews.active.filter((id) => !worktrees.has(id)),
            selected: byTree(preferences.terminalViews.selected),
          },
        }
      : {}),
  };
}

function scrubRepositories(
  repositories: RuntimeManifest["repositories"],
  worktrees: ReadonlySet<string>,
): RuntimeManifest["repositories"] {
  if (!worktrees.size) return repositories;

  return repositories.map((repository) => ({
    ...repository,
    worktrees: repository.worktrees.filter((tree) => !worktrees.has(tree.id)),
  }));
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const snapshotKey = (record: SessionRecord) => digest(sessionRecordKey(record));

// One shared session record per conversation. The workspace file holds only a small index;
// closed bodies with SDK originals are read lazily by History, never instantiated for recovery.
export class RuntimeStore implements SessionSnapshotSource {
  readonly retentionWarnings: string[] = [];
  private tail: Promise<Result<unknown, ExpectedError>> = Promise.resolve(ok(undefined));
  private entries = new Map<string, SnapshotIndex>();
  private readonly legacy = new Map<string, SessionRecord>();
  private initialized = false;
  private repositoryId: string | undefined;
  private metadata: Omit<RuntimeManifest, "records"> | undefined;
  // The cleanup ledger state this store's in-memory view was derived from.
  private observed: { generation: string | null; revision: number };
  private observedFailure: StorageError | undefined;
  private hidden = new Set<string>();

  constructor(readonly paths: RuntimePaths) {
    // Observe synchronously, so a save queued before any later fence still carries this view.
    const ledger = readLedgerSync(paths);
    if (ledger.ok) {
      this.observed = { generation: ledger.value.generation, revision: ledger.value.revision };
    } else {
      this.observed = { generation: null, revision: 0 };
      this.observedFailure = ledger.error;
    }
  }

  private visible(worktreeId: string | undefined): boolean {
    if (worktreeId && this.hidden.has(worktreeId)) return false;
    for (const fence of fencesOf(this.paths).values()) {
      if (fence.kind === "repository") return false;
      if (worktreeId && fence.worktreeIds.has(worktreeId)) return false;
    }

    return true;
  }

  listSessions(worktreeId: string): readonly SessionSnapshotInfo[] {
    if (!this.visible(worktreeId)) return [];

    return [...this.entries.values()].filter(
      (entry) =>
        entry.worktreeId === worktreeId && !entry.cleanupPending && entry.expiredAt === undefined,
    );
  }

  async readSession(
    worktreeId: string,
    conversationId: string,
  ): Promise<Result<SessionRecord | null, ExpectedError>> {
    if (!this.visible(worktreeId)) return ok(null);
    const entry = [...this.entries.values()].find(
      (entry) =>
        entry.worktreeId === worktreeId && (entry.conversationId ?? entry.id) === conversationId,
    );

    return entry && !entry.cleanupPending && entry.expiredAt === undefined
      ? this.readRecord(entry)
      : ok(null);
  }

  isExpired(worktreeId: string, conversationId: string): boolean {
    const entry = this.entries.get(digest(JSON.stringify([worktreeId, conversationId])));

    return !!entry && (!!entry.cleanupPending || entry.expiredAt !== undefined);
  }

  private async readRecord(entry: SnapshotIndex): Promise<Result<SessionRecord, ExpectedError>> {
    const legacy = this.legacy.get(entry.key);
    if (legacy) {
      return ok(legacy);
    }

    const read = await capture(() =>
      readFile(join(this.paths.directory, "sessions", `${entry.key}.json`), "utf8"),
    );
    if (!read.ok) {
      return read;
    }

    const parsed = parseJson(read.value, "session snapshot");
    if (!parsed.ok) {
      return err(
        new StorageError("Invalid session snapshot; original file was not replaced.", undefined, {
          cause: parsed.error,
        }),
      );
    }
    if (
      !Value.Check(sessionRecordSchema, parsed.value) ||
      snapshotKey(parsed.value) !== entry.key
    ) {
      return err(new StorageError("Invalid or mismatched session snapshot."));
    }

    const lifecycle =
      entry.lifecycle === "closed" || parsed.value.lifecycle === "closed" ? "closed" : "open";

    return ok({
      ...parsed.value,
      lifecycle,
      managed: parsed.value.managed ?? entry.managed ?? false,
      closedAt: lifecycle === "open" ? null : (parsed.value.closedAt ?? entry.closedAt ?? null),
    });
  }

  /**
   * Loads the manifest, hiding deleted worktrees and refusing a deleted repository. It also
   * re-observes the cleanup ledger: the caller's resulting view is current as of this load.
   */
  load(repositoryId: string): Promise<Result<RuntimeManifest | null, ExpectedError>> {
    const task = this.tail.then(() =>
      this.locked(async () => {
        const ledger = await readLedger(this.paths);
        if (!ledger.ok) return ledger;
        this.observed = { generation: ledger.value.generation, revision: ledger.value.revision };
        this.observedFailure = undefined;

        return this.loadObserved(repositoryId, ledger.value);
      }, false),
    );
    this.tail = task;

    return task;
  }

  // Writers create the private state directory; readers never create it. A missing directory
  // has no ledger and no data, and a concurrent fence there cannot affect a read-only load.
  private async locked<T>(
    task: () => Promise<Result<T, ExpectedError>>,
    create = true,
  ): Promise<Result<T, ExpectedError>> {
    const prepared = await capture(async () => {
      if (create) {
        await privateDirectory(this.paths.directory);
        return true;
      }
      const found = await capture(() => lstat(this.paths.directory));
      if (found.ok) return true;
      if (found.error instanceof StorageError && found.error.systemCode === "ENOENT") return false;
      throw found.error;
    });
    if (!prepared.ok) return prepared;

    return prepared.value ? withStateLock(lockPath(this.paths), task) : task();
  }

  private async loadObserved(
    repositoryId: string,
    ledger: Ledger,
  ): Promise<Result<RuntimeManifest | null, ExpectedError>> {
    const guard = guardFor(ledger, this.observed, [...fencesOf(this.paths).values()]);
    if (guard.rejected !== undefined) {
      return err(new ScopeDeletedError(guard.rejected));
    }

    const loaded = await this.loadUnguarded(repositoryId, guard.hidden);
    this.hidden = guard.hidden;
    this.loadedRevision = ledger.revision;
    if (!loaded.ok || !loaded.value) return loaded;

    const sessions = new Set(
      [...this.entries.values()]
        .filter((entry) => guard.hidden.has(entry.worktreeId))
        .map((entry) => entry.id),
    );
    for (const receipt of ledger.receipts) {
      if (
        receipt.kind === "worktrees" &&
        receipt.worktrees.some((tree) => guard.hidden.has(tree.id))
      ) {
        for (const id of receipt.sessionIds) sessions.add(id);
      }
    }

    return ok({
      ...loaded.value,
      repositories: scrubRepositories(loaded.value.repositories, guard.hidden),
      preferences: scrubPreferences(loaded.value.preferences, guard.hidden, sessions),
      records: loaded.value.records.filter((record) => !guard.hidden.has(record.worktreeId!)),
    });
  }

  // `hidden` worktrees keep their index entries, but their bodies are never read: a deleted
  // scope's snapshot may already be gone, and must not block loading the rest of the repository.
  private async loadUnguarded(
    repositoryId: string,
    hidden: ReadonlySet<string>,
  ): Promise<Result<RuntimeManifest | null, ExpectedError>> {
    const read = await capture(() => readFile(this.paths.manifest, "utf8"));
    if (!read.ok) {
      if (!(read.error instanceof StorageError) || read.error.systemCode !== "ENOENT") {
        return read;
      }

      this.entries.clear();
      this.legacy.clear();
      this.metadata = undefined;
      this.initialized = true;
      this.repositoryId = repositoryId;

      return ok(null);
    }

    const parsed = parseJson(read.value, "runtime manifest");
    if (!parsed.ok) {
      return err(
        new StorageError("Invalid runtime manifest; original file was not replaced.", undefined, {
          cause: parsed.error,
        }),
      );
    }

    const value = parsed.value;
    const indexed = value !== null && typeof value === "object" && "storageVersion" in value;
    if (indexed) {
      if (!Value.Check(storedManifestSchema, value)) {
        return err(new StorageError("Invalid runtime manifest; original file was not replaced."));
      }
      if (value.repositoryId !== repositoryId) {
        return err(new StorageError("Runtime manifest belongs to another repository."));
      }

      const entries = new Map<string, SnapshotIndex>();
      for (const entry of value.records) {
        if (
          entry.key !==
            digest(JSON.stringify([entry.worktreeId, entry.conversationId ?? entry.id])) ||
          entries.has(entry.key)
        ) {
          return err(new StorageError("Invalid session snapshot index."));
        }

        entries.set(entry.key, {
          ...entry,
          closedAt: entry.lifecycle === "open" ? null : (entry.closedAt ?? Date.now()),
        });
      }

      this.entries = entries;
      this.legacy.clear();

      const records: SessionRecord[] = [];
      for (const entry of entries.values()) {
        if (entry.lifecycle === "open" && !hidden.has(entry.worktreeId)) {
          const record = await this.readRecord(entry);
          if (!record.ok) {
            return record;
          }
          // A close written before an interrupted index update must never reopen a conversation.
          if (record.value.lifecycle !== "closed") {
            records.push(record.value);
          }
        }
      }

      this.initialized = true;
      this.repositoryId = repositoryId;
      this.metadata = {
        version: value.version,
        repositoryId,
        repositories: value.repositories,
        preferences: value.preferences,
      };

      return ok({ ...this.metadata, records });
    }
    if (!Value.Check(manifestSchema, value) || value.repositoryId !== repositoryId) {
      return err(new StorageError("Invalid runtime manifest; original file was not replaced."));
    }

    this.entries.clear();
    this.legacy.clear();
    for (const record of value.records) {
      const normalized = this.normalize(record);
      const entry = this.describe(normalized);

      this.entries.set(entry.key, entry);
      this.legacy.set(entry.key, normalized);
    }

    this.initialized = true;
    this.repositoryId = repositoryId;

    const { records: _records, ...metadata } = value;
    this.metadata = metadata;

    return ok({
      ...metadata,
      records: value.records
        .filter((record) => record.lifecycle !== "closed")
        .map((record) => this.normalize(record)),
    });
  }

  private normalize(record: SessionRecord, previous?: SnapshotIndex): SessionRecord {
    const lifecycle = record.lifecycle ?? "open";

    return {
      ...record,
      lifecycle,
      managed: record.managed ?? previous?.managed ?? false,
      closedAt: lifecycle === "open" ? null : (record.closedAt ?? previous?.closedAt ?? Date.now()),
    };
  }

  private describe(record: SessionRecord, previous?: SnapshotIndex): SnapshotIndex {
    const { updatedAt: _updatedAt, ...data } = record;
    const revision = digest(JSON.stringify({ ...data, lifecycle: data.lifecycle ?? "open" }));
    const title = (
      record.state.sections?.find((section) => section.kind === "user")?.text ||
      record.name ||
      "Untitled session"
    )
      .replace(/\s+/g, " ")
      .slice(0, 120);

    return {
      key: snapshotKey(record),
      revision,
      id: record.id,
      name: record.name,
      worktreeId: record.worktreeId!,
      ...(record.state.conversationId ? { conversationId: record.state.conversationId } : {}),
      ...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
      ...(record.cwd ? { cwd: record.cwd } : {}),
      lifecycle: record.lifecycle ?? "open",
      managed: record.managed ?? false,
      closedAt: record.closedAt ?? null,
      updatedAt:
        previous?.revision === revision ? previous.updatedAt : (record.updatedAt ?? Date.now()),
      title,
      messageCount:
        record.state.sections?.filter((section) => section.kind !== "thinking").length ?? 0,
    };
  }

  save(manifest: RuntimeManifest): Promise<Result<void, ExpectedError>> {
    // Fences known at call time travel with this save, even if lifted before it executes.
    const captured = [...fencesOf(this.paths).values()];
    const repositoryFence = captured.find((fence) => fence.kind === "repository");
    if (repositoryFence) {
      return Promise.resolve(err(new ScopeDeletedError(repositoryFence.token)));
    }

    const task = this.tail.then(() =>
      this.locked(async () => {
        const guard = await this.currentGuard(captured, manifest.repositoryId);
        if (!guard.ok) return guard;

        return this.saveNext(manifest, guard.value);
      }),
    );
    // Expected failures are values: later writes may recover. Unknown exceptions stay rejected.
    this.tail = task;

    return task;
  }

  private async currentGuard(
    captured: readonly InProcessFence[],
    repositoryId: string,
  ): Promise<Result<WriteGuard, ExpectedError>> {
    if (this.observedFailure) return err(this.observedFailure);

    const ledger = await readLedger(this.paths);
    if (!ledger.ok) return ledger;

    const fences = new Map(captured.map((fence) => [fence.token, fence]));
    for (const fence of fencesOf(this.paths).values()) fences.set(fence.token, fence);
    const guard = guardFor(ledger.value, this.observed, [...fences.values()]);
    if (guard.rejected !== undefined) {
      return err(new ScopeDeletedError(guard.rejected));
    }
    if (!this.initialized) {
      // A lazy first load inside a save keeps the constructor-time observation.
      const loaded = await this.loadUnguarded(repositoryId, guard.hidden);
      if (!loaded.ok) return loaded;
    } else if (ledger.value.revision !== this.loadedRevision) {
      // Another store or a purge changed the index since this view was read.
      const reloaded = await this.loadUnguarded(this.repositoryId!, guard.hidden);
      if (!reloaded.ok) return reloaded;
    }
    this.loadedRevision = ledger.value.revision;
    this.hidden = guard.hidden;
    if (this.metadata && guard.hidden.size) {
      // Index-only publications (retention) must not rewrite deleted preferences or catalog rows.
      const sessions = new Set(
        [...this.entries.values()]
          .filter((entry) => guard.hidden.has(entry.worktreeId))
          .map((entry) => entry.id),
      );
      this.metadata = {
        ...this.metadata,
        repositories: scrubRepositories(this.metadata.repositories, guard.hidden),
        preferences: scrubPreferences(this.metadata.preferences, guard.hidden, sessions),
      };
    }

    return ok(guard);
  }

  /**
   * Accepts reopened worktree scopes after the caller scrubbed its in-memory state for them, so
   * a fresh generation at the same identity can persist again. A repository reopen changes the
   * generation and requires a new RuntimeStore instead.
   */
  adoptCleanup(): Promise<Result<void, ExpectedError>> {
    const task = this.tail.then(() =>
      this.locked(async () => {
        const ledger = await readLedger(this.paths);
        if (!ledger.ok) return ledger;
        if (ledger.value.generation !== this.observed.generation) {
          return err(
            new ScopeDeletedError(
              ledger.value.receipts.findLast((receipt) => receipt.kind === "repository")?.token ??
                "",
            ),
          );
        }

        this.observed = { generation: ledger.value.generation, revision: ledger.value.revision };
        this.observedFailure = undefined;
        // Force a reload of the purged index on the next operation.
        this.loadedRevision = undefined;

        return ok(undefined);
      }),
    );
    this.tail = task;

    return task;
  }

  private loadedRevision: number | undefined;

  private async saveNext(
    unguarded: RuntimeManifest,
    guard: WriteGuard,
  ): Promise<Result<void, ExpectedError>> {
    if (this.repositoryId !== unguarded.repositoryId) {
      return err(new StorageError("Cannot save a different repository into this runtime store."));
    }

    const hiddenSessions = new Set(
      unguarded.records
        .filter((record) => guard.hidden.has(record.worktreeId!))
        .map((record) => record.id),
    );
    for (const entry of this.entries.values()) {
      if (guard.hidden.has(entry.worktreeId)) hiddenSessions.add(entry.id);
    }
    const manifest: RuntimeManifest = {
      ...unguarded,
      repositories: scrubRepositories(unguarded.repositories, guard.hidden),
      preferences: scrubPreferences(unguarded.preferences, guard.hidden, hiddenSessions),
      records: unguarded.records.filter((record) => !guard.hidden.has(record.worktreeId!)),
    };

    const incoming = new Map(
      manifest.records
        .filter(
          (record) =>
            record.lifecycle !== "closed" ||
            !this.isExpired(record.worktreeId!, record.state.conversationId ?? record.id),
        )
        .map((record) => [
          snapshotKey(record),
          this.normalize(record, this.entries.get(snapshotKey(record))),
        ]),
    );
    // Old manifests may know only the tab ID. Adopt the SDK identity learned during restore,
    // rather than archiving a duplicate of that same conversation under the old tab key.
    const adopted = new Set(
      [...this.entries.values()]
        .filter(
          (entry) =>
            !entry.conversationId &&
            [...incoming.values()].some(
              (record) =>
                record.state.conversationId &&
                record.worktreeId === entry.worktreeId &&
                record.id === entry.id &&
                record.sessionFile === entry.sessionFile,
            ),
        )
        .map((entry) => entry.key),
    );
    // Missing open records become closed, not deleted; ordinary checkpoints never rewrite old closed bodies.
    for (const entry of this.entries.values()) {
      if (guard.hidden.has(entry.worktreeId)) {
        // A deleted scope's records stay untouched until its purge removes them.
        continue;
      }
      if (!incoming.has(entry.key) && !adopted.has(entry.key) && entry.lifecycle === "open") {
        const record = await this.readRecord(entry);
        if (!record.ok) {
          return record;
        }

        incoming.set(entry.key, {
          ...record.value,
          lifecycle: "closed",
          closedAt: record.value.closedAt ?? Date.now(),
          updatedAt: Date.now(),
        });
      }
    }
    for (const [key, record] of this.legacy) {
      if (guard.hidden.has(record.worktreeId!)) continue;
      if (!incoming.has(key) && !adopted.has(key)) {
        incoming.set(key, record);
      }
    }

    const next = new Map(this.entries);
    for (const key of adopted) {
      next.delete(key);
    }

    const saved = await capture(async () => {
      if (incoming.size) {
        await privateDirectory(join(this.paths.directory, "sessions"));
      }
      for (const [key, record] of incoming) {
        const entry = this.describe(record, this.entries.get(key));
        if (this.legacy.has(key) || entry.revision !== this.entries.get(key)?.revision) {
          await atomicWrite(
            join(this.paths.directory, "sessions", `${key}.json`),
            JSON.stringify({ ...record, lifecycle: entry.lifecycle, updatedAt: entry.updatedAt }),
          );
        }

        next.set(key, entry);
      }

      await atomicWrite(
        this.paths.manifest,
        JSON.stringify({ ...manifest, storageVersion: 2, records: [...next.values()] }),
      );
    });
    if (!saved.ok) {
      return saved;
    }

    this.entries = next;
    this.legacy.clear();

    const { records: _records, ...metadata } = manifest;
    this.metadata = metadata;

    // Newly closed empty/deleted conversations must not accumulate preview-only bodies.
    // Publish closed intent first so a cleanup failure can never reopen an old snapshot.
    const failures: ExpectedError[] = [];
    for (const key of incoming.keys()) {
      const entry = this.entries.get(key);
      if (!entry) {
        continue;
      }

      const pruned = await this.pruneOrphanedEntry(entry);
      if (!pruned.ok) {
        failures.push(pruned.error);
      }
    }

    return failures.length
      ? err(new CleanupError("Closed-session snapshot cleanup partially failed.", failures))
      : ok(undefined);
  }

  pruneExpired(
    days: number | null,
    reserve: (snapshot: SessionSnapshotInfo, canonicalFile?: string) => (() => void) | null,
    now = Date.now(),
  ): Promise<Result<number, ExpectedError>> {
    const captured = [...fencesOf(this.paths).values()];
    const task = this.tail.then(() =>
      this.locked(async () => {
        if (!this.initialized || !this.metadata) return ok(0);
        const guard = await this.currentGuard(captured, this.repositoryId!);
        if (!guard.ok) return guard;

        return this.pruneNext(days, reserve, now, guard.value.hidden);
      }),
    );
    this.tail = task;

    return task;
  }

  private async publishIndex(
    next: Map<string, SnapshotIndex>,
  ): Promise<Result<void, ExpectedError>> {
    if (!this.metadata) {
      return ok(undefined);
    }

    const saved = await capture(() =>
      atomicWrite(
        this.paths.manifest,
        JSON.stringify({ ...this.metadata, storageVersion: 2, records: [...next.values()] }),
      ),
    );
    if (saved.ok) {
      this.entries = next;
    }

    return saved;
  }

  private async pruneNext(
    days: number | null,
    reserve: (snapshot: SessionSnapshotInfo, canonicalFile?: string) => (() => void) | null,
    now: number,
    hidden: ReadonlySet<string>,
  ): Promise<Result<number, ExpectedError>> {
    if (!this.initialized || !this.metadata) {
      return ok(0);
    }

    this.retentionWarnings.length = 0;
    let removed = 0;
    const failures: ExpectedError[] = [];
    // Publishing a pruned index replaces the live map during this sweep.
    // Deleted scopes belong to their purge, not to retention.
    const entries = [...this.entries.values()].filter((entry) => !hidden.has(entry.worktreeId));
    for (const entry of entries) {
      const orphaned = await this.pruneOrphanedEntry(entry, reserve);
      if (!orphaned.ok) {
        failures.push(orphaned.error);
        continue;
      }
      if (orphaned.value) {
        removed += orphaned.value;
        continue;
      }
      if (
        !entry.cleanupPending &&
        (entry.expiredAt !== undefined || !sessionExpired(entry, days, now))
      ) {
        continue;
      }

      const result = await this.pruneEntry(entry, reserve, now);
      if (result.ok) {
        removed += result.value;
      } else {
        failures.push(result.error);
      }
    }

    return failures.length
      ? err(
          new CleanupError(
            "Session retention cleanup partially failed; unverified files were preserved.",
            failures,
          ),
        )
      : ok(removed);
  }

  private async pruneOrphanedEntry(
    entry: SnapshotIndex,
    reserve?: (snapshot: SessionSnapshotInfo, canonicalFile?: string) => (() => void) | null,
  ): Promise<Result<number, ExpectedError>> {
    if (entry.lifecycle !== "closed" || entry.cleanupPending || entry.expiredAt !== undefined) {
      return ok(0);
    }

    const sessionFile = entry.sessionFile;
    if (sessionFile) {
      const found = await capture(() => lstat(sessionFile));
      if (found.ok) {
        return ok(0);
      }
      // Only definite absence authorizes removal; permission and other I/O failures stay visible.
      if (!(found.error instanceof StorageError) || found.error.systemCode !== "ENOENT") {
        return found;
      }
    }

    const release = reserve?.(entry, entry.sessionFile);
    if (reserve && !release) {
      return ok(0);
    }
    try {
      // Missing originals are proof only when the adjacent plan belongs to this conversation.
      const planOwner = this.planOwner(entry);
      let plan: InspectedTaskPlan = { kind: "absent" };
      if (sessionFile) {
        const inspected = await this.inspectPlan(entry);
        if (!inspected.ok) return inspected;
        plan = inspected.value;
        const workflow = await this.inspectWorkflow(entry);
        if (!workflow.ok) return workflow;

        const again = await capture(() => lstat(sessionFile));
        if (again.ok) return ok(0);
        if (!(again.error instanceof StorageError) || again.error.systemCode !== "ENOENT") {
          return again;
        }
        if (planOwner) {
          const checked = await recheckTaskPlanForRetention(sessionFile, planOwner, plan);
          if (!checked.ok) return checked;
          const checkedWorkflow = await recheckWorkflowForRetention(
            sessionFile,
            planOwner,
            workflow.value,
          );
          if (!checkedWorkflow.ok) return checkedWorkflow;
          const removedWorkflow = await deleteWorkflowForRetention(
            sessionFile,
            planOwner,
            workflow.value,
          );
          if (!removedWorkflow.ok) return removedWorkflow;
          if (removedWorkflow.value === "retained")
            this.retentionWarnings.push(
              `Retained workflow ${workflowFilePath(sessionFile)}: a live continuation still references it.`,
            );
          const deleted = await deleteTaskPlanForRetention(sessionFile, planOwner, plan);
          if (!deleted.ok) return deleted;
        }
      }
      // Keep the closed index until unlink succeeds, so an interrupted cleanup remains retryable.
      const removed = await removeSnapshotFile(this.paths, entry.key);
      if (!removed.ok) {
        return removed;
      }

      const next = new Map(this.entries);
      next.delete(entry.key);

      const saved = await this.publishIndex(next);
      if (!saved.ok) {
        return saved;
      }

      this.legacy.delete(entry.key);

      return ok(1);
    } finally {
      release?.();
    }
  }

  private planOwner(entry: SnapshotIndex): PlanOwner | null {
    return entry.cwd ? { conversationId: entry.conversationId ?? entry.id, cwd: entry.cwd } : null;
  }

  private async inspectPlan(
    entry: SnapshotIndex,
  ): Promise<Result<InspectedTaskPlan, ExpectedError>> {
    if (!entry.sessionFile) return ok({ kind: "absent" });
    const owner = this.planOwner(entry);
    if (!owner) {
      const found = await capture(() => lstat(entry.sessionFile! + ".plan.json"));
      if (found.ok) return err(new StorageError("Cannot verify ownership of task plan sidecar."));
      return found.error instanceof StorageError && found.error.systemCode === "ENOENT"
        ? ok({ kind: "absent" })
        : found;
    }
    return inspectTaskPlanForRetention(entry.sessionFile, owner);
  }

  private async inspectWorkflow(
    entry: SnapshotIndex,
  ): Promise<Result<InspectedWorkflow, ExpectedError>> {
    if (!entry.sessionFile) return ok({ kind: "absent" });
    const owner = this.planOwner(entry);
    if (owner) return inspectWorkflowForRetention(entry.sessionFile, owner);
    for (const path of [
      workflowFilePath(entry.sessionFile),
      workflowLinkFilePath(entry.sessionFile),
      workflowBackupFilePath(entry.sessionFile),
    ]) {
      const found = await capture(() => lstat(path));
      if (found.ok) return err(new StorageError("Cannot verify ownership of workflow sidecar."));
      if (!(found.error instanceof StorageError && found.error.systemCode === "ENOENT"))
        return found;
    }
    return ok({ kind: "absent" });
  }

  private async pruneEntry(
    entry: SnapshotIndex,
    reserve: (snapshot: SessionSnapshotInfo, canonicalFile?: string) => (() => void) | null,
    now: number,
  ): Promise<Result<number, ExpectedError>> {
    if (entry.managed !== true || entry.lifecycle !== "closed" || entry.closedAt == null) {
      return ok(0);
    }
    if (!entry.cleanupPending) {
      const record = await this.readRecord(entry);
      if (!record.ok) {
        return record;
      }
      if (
        record.value.managed !== true ||
        record.value.closedAt !== entry.closedAt ||
        record.value.updatedAt !== entry.updatedAt
      ) {
        return ok(0);
      }
    }

    const inspected = await inspectRetainedFile(entry);
    if (!inspected.ok) {
      return inspected;
    }
    if (inspected.value.kind === "changed") {
      return ok(0);
    }
    const plan = await this.inspectPlan(entry);
    if (!plan.ok) return plan;
    const workflow = await this.inspectWorkflow(entry);
    if (!workflow.ok) return workflow;
    if (
      !entry.cleanupPending &&
      workflow.value.kind === "ready" &&
      (workflow.value.updatedAt > entry.updatedAt ||
        Math.floor(workflow.value.fingerprint.mtimeMs) > entry.updatedAt)
    )
      return ok(0);
    const expectedWorkflow = entry.cleanupWorkflow ?? { kind: "absent" as const };
    const workflowAlreadyRemoved =
      entry.cleanupPending &&
      inspected.value.kind === "absent" &&
      workflow.value.kind === "absent" &&
      expectedWorkflow.kind === "ready";
    if (
      entry.cleanupPending &&
      !workflowAlreadyRemoved &&
      !workflowRetentionMatches(expectedWorkflow, workflow.value)
    )
      return err(new StorageError("Workflow changed during interrupted retention cleanup."));
    if (
      !entry.cleanupPending &&
      plan.value.kind === "ready" &&
      (plan.value.updatedAt > entry.updatedAt ||
        Math.floor(plan.value.fingerprint.mtimeMs) > entry.updatedAt)
    ) {
      return ok(0);
    }
    // A prior interrupted sweep must not delete a sidecar created or changed since its marker.
    const expectedPlan = entry.cleanupPlan ?? { kind: "absent" as const };
    const planRemovedDuringCleanup =
      entry.cleanupPending &&
      inspected.value.kind === "absent" &&
      plan.value.kind === "absent" &&
      expectedPlan.kind === "ready";
    if (
      entry.cleanupPending &&
      !planRemovedDuringCleanup &&
      (plan.value.kind !== expectedPlan.kind ||
        (plan.value.kind === "ready" &&
          expectedPlan.kind === "ready" &&
          JSON.stringify(plan.value.fingerprint) !== JSON.stringify(expectedPlan.fingerprint)))
    ) {
      return err(new StorageError("Task plan changed during interrupted retention cleanup."));
    }

    const release = reserve(
      entry,
      inspected.value.kind === "ready" ? inspected.value.path : undefined,
    );
    if (!release) {
      return ok(0);
    }
    try {
      // A durable marker hides the record from JSONL fallback and lets an interrupted deletion finish.
      const pending = {
        ...entry,
        cleanupPending: true,
        cleanupPlan: entry.cleanupPlan ?? plan.value,
        cleanupWorkflow: entry.cleanupWorkflow ?? workflow.value,
      };
      if (!entry.cleanupPending) {
        const marked = new Map(this.entries);
        marked.set(entry.key, pending);

        const saved = await this.publishIndex(marked);
        if (!saved.ok) {
          return saved;
        }
      }

      if (entry.sessionFile) {
        const owner = this.planOwner(entry);
        if (!owner && plan.value.kind === "ready") {
          return err(new StorageError("Cannot verify ownership of task plan sidecar."));
        }
        if (owner) {
          const planCheck = await recheckTaskPlanForRetention(entry.sessionFile, owner, plan.value);
          const checked = planCheck.ok
            ? await recheckWorkflowForRetention(entry.sessionFile, owner, workflow.value)
            : planCheck;
          if (!checked.ok) {
            if (!entry.cleanupPending) {
              const restored = new Map(this.entries);
              restored.set(entry.key, entry);
              const saved = await this.publishIndex(restored);
              if (!saved.ok)
                return err(
                  new CleanupError("Could not clear an interrupted retention marker.", [
                    checked.error,
                    saved.error,
                  ]),
                );
            }
            return checked;
          }
        }
      }

      const deleted = await deleteRetainedFile(inspected.value);
      if (!deleted.ok) {
        if (deleted.error.code === "HISTORY_UNAVAILABLE" && !entry.cleanupPending) {
          // The fingerprint check proves deletion did not start. Restore visibility for a changed external file.
          const restored = new Map(this.entries);
          restored.set(entry.key, entry);

          const saved = await this.publishIndex(restored);
          if (!saved.ok) {
            return err(
              new CleanupError("Could not clear an interrupted retention marker.", [
                deleted.error,
                saved.error,
              ]),
            );
          }
        }

        return deleted;
      }

      if (entry.sessionFile) {
        const owner = this.planOwner(entry);
        if (owner) {
          const sidecar = await deleteTaskPlanForRetention(entry.sessionFile, owner, plan.value);
          if (!sidecar.ok) return sidecar;
          const removedWorkflow = await deleteWorkflowForRetention(
            entry.sessionFile,
            owner,
            workflow.value,
          );
          if (!removedWorkflow.ok) return removedWorkflow;
          if (removedWorkflow.value === "retained")
            this.retentionWarnings.push(
              `Retained workflow ${workflowFilePath(entry.sessionFile)}: a live continuation still references it.`,
            );
        }
      }

      const snapshot = await removeSnapshotFile(this.paths, entry.key);
      if (!snapshot.ok) {
        return snapshot;
      }

      // Keep only a small, redacted identity marker so stale checkpoints cannot resurrect expired data.
      const {
        sessionFile: _file,
        cwd: _cwd,
        cleanupPlan: _plan,
        cleanupWorkflow: _workflow,
        ...identity
      } = pending;
      const finished = new Map(this.entries);

      finished.set(entry.key, {
        ...identity,
        name: "",
        title: "",
        messageCount: 0,
        cleanupPending: false,
        expiredAt: now,
      });

      const saved = await this.publishIndex(finished);
      if (!saved.ok) {
        return saved;
      }

      return ok(1);
    } finally {
      release();
    }
  }
}

async function atomicWrite(path: string, text: string): Promise<void> {
  const temporary = path + "." + crypto.randomUUID() + ".tmp";
  await withCleanup(
    async () => {
      await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    },
    () => rm(temporary, { force: true }),
  );
}

export async function acquireRuntime(paths: RuntimePaths): Promise<(() => Promise<void>) | null> {
  await privateDirectory(join(paths.socket, ".."));

  const token = crypto.randomUUID();
  const temporary = paths.lock + "." + token;
  const owner = { pid: process.pid, token };

  await writeFile(temporary, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
  try {
    let claimed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await link(temporary, paths.lock);
        claimed = true;
        break;
      } catch (error) {
        if (!hasCode(error, "EEXIST")) {
          throw error;
        }

        let existing: unknown;
        try {
          existing = await readOwner(paths.lock);
        } catch (readError) {
          if (hasCode(readError, "ENOENT")) {
            continue;
          }

          throw readError;
        }
        if (!isOwner(existing)) {
          throw new StorageError("Invalid runtime ownership file; refusing to remove it.");
        }
        if (pidAlive(existing.pid)) {
          return null;
        }

        // Serialize stale-owner recovery so two launchers cannot unlink each other's new lock.
        const recovery = paths.lock + ".recovery";
        try {
          await link(temporary, recovery);
        } catch (recoveryError) {
          if (hasCode(recoveryError, "EEXIST")) {
            return null;
          }

          throw recoveryError;
        }
        try {
          let current: unknown;
          try {
            current = await readOwner(paths.lock);
          } catch (readError) {
            if (!hasCode(readError, "ENOENT")) {
              throw readError;
            }
          }
          if (isOwner(current) && pidAlive(current.pid)) {
            return null;
          }

          await rm(paths.lock, { force: true });
          try {
            await link(temporary, paths.lock);
          } catch (claimError) {
            if (hasCode(claimError, "EEXIST")) {
              return null;
            }

            throw claimError;
          }

          claimed = true;
          break;
        } finally {
          await rm(recovery, { force: true });
        }
      }
    }
    if (!claimed) {
      throw new StorageError("Runtime ownership changed repeatedly; try connecting again.");
    }

    await rm(paths.socket, { force: true });

    return async () => {
      let current: unknown;
      try {
        current = await readOwner(paths.lock);
      } catch (error) {
        if (hasCode(error, "ENOENT")) {
          return;
        }

        throw error;
      }
      if (isOwner(current) && current.token === token) {
        await rm(paths.socket, { force: true });
        await rm(paths.lock, { force: true });
      }
    };
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readOwner(path: string): Promise<unknown> {
  const parsed = parseJson(await readFile(path, "utf8"), "runtime ownership");
  if (!parsed.ok) {
    throw new StorageError("Invalid runtime ownership file; refusing to remove it.", undefined, {
      cause: parsed.error,
    });
  }

  return parsed.value;
}

export function runtimeOwned(paths: RuntimePaths): Promise<Result<boolean, ExpectedError>> {
  return capture(async () => {
    let owner: unknown;
    try {
      owner = await readOwner(paths.lock);
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return false;
      }

      throw error;
    }
    if (!isOwner(owner)) {
      throw new StorageError("Invalid runtime ownership file; refusing to replace its owner.");
    }

    return pidAlive(owner.pid);
  });
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if (hasCode(error, "ESRCH")) {
      return false;
    }

    throw error;
  }
}

function isOwner(value: unknown): value is { pid: number; token: string } {
  return (
    !!value &&
    typeof value === "object" &&
    "pid" in value &&
    Number.isInteger(value.pid) &&
    Number(value.pid) > 0 &&
    "token" in value &&
    typeof value.token === "string"
  );
}

function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}

// ---------------------------------------------------------------------------------------------
// Scoped purge of one repository's owned runtime state
// ---------------------------------------------------------------------------------------------

const ownedSdkDirectories = (paths: RuntimePaths) => [
  join(paths.directory, "sdk-sessions"),
  join(paths.directory, "offline-agent", "sessions"),
];
const temporaryName = /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
const sdkFileName = /^[^/\0]+\.jsonl$/;

function sameScope(a: LedgerReceipt, b: CleanupReceipt): boolean {
  const trees = (list: readonly { id: string; path: string }[]) =>
    JSON.stringify(
      list.map((tree) => `${tree.id}\0${resolve(tree.path)}`).sort((x, y) => x.localeCompare(y)),
    );

  return (
    a.repositoryId === b.repositoryId &&
    a.kind === b.kind &&
    (a.kind === "repository" || trees(a.worktrees) === trees(b.worktrees))
  );
}

function trimLedger(ledger: Ledger): Ledger {
  // Old reopened receipts only protect stores that predate them; keep the ledger bounded.
  const receipts = [...ledger.receipts];
  while (receipts.length >= 1024) {
    const index = receipts.findIndex((receipt) => receipt.state === "reopened");
    if (index < 0) break;
    receipts.splice(index, 1);
  }

  return { ...ledger, receipts };
}

async function underRuntimeLock<T>(
  paths: RuntimePaths,
  task: (ledger: Ledger) => Promise<Result<T, ExpectedError>>,
): Promise<Result<T, ExpectedError>> {
  const prepared = await capture(() => privateDirectory(paths.directory));
  if (!prepared.ok) return prepared;

  return withStateLock(lockPath(paths), async () => {
    const ledger = await readLedger(paths);

    return ledger.ok ? task(ledger.value) : ledger;
  });
}

function findReceipt(
  ledger: Ledger,
  repositoryId: string,
  token: string,
): Result<LedgerReceipt, ExpectedError> {
  const receipt = ledger.receipts.find((entry) => entry.token === token);
  if (!receipt || receipt.repositoryId !== repositoryId) {
    return err(new InputError("Unknown workspace cleanup receipt for this repository."));
  }

  return ok(receipt);
}

// Canonical and unpublished manifests carry the same ownership facts, including empty scopes.
function rememberManifestWorktrees(
  value: Pick<RuntimeManifest, "repositories" | "preferences">,
  repositoryId: string,
  remember: (id: string, path?: string) => void,
): void {
  for (const repository of value.repositories) {
    if (repository.id !== repositoryId) continue;
    for (const tree of repository.worktrees) remember(tree.id, tree.path);
  }
  const preferences = value.preferences;
  const ids = [
    preferences.selection.worktreeId,
    ...Object.keys(preferences.selection.sessions),
    ...Object.keys(preferences.workViews?.active ?? {}),
    ...Object.keys(preferences.gitViews ?? {}),
    ...(preferences.terminalViews?.active ?? []),
    ...Object.keys(preferences.terminalViews?.selected ?? {}),
  ];
  for (const id of ids) {
    if (id && isAbsolute(id)) remember(id, id);
  }
}

// Historical scope metadata is cleanup ownership, never a discovery candidate. Whole-repository
// cleanup must include worktrees that disappeared before the current tracker was installed.
async function cleanupInventory(
  paths: RuntimePaths,
  repositoryId: string,
  receipt: CleanupReceipt,
): Promise<{ worktrees: ScopeWorktree[]; sessionIds: string[] }> {
  const worktrees = new Map(receipt.worktrees.map((tree) => [tree.id, { ...tree }]));
  const sessionIds = new Set(receipt.sessionIds);
  const manifest = await readManifestFile(paths, repositoryId);
  // Still record the fence on unreadable state; purge reports the actual ownership residual.
  if (!manifest.ok || manifest.value.kind === "absent") {
    return { worktrees: [...worktrees.values()], sessionIds: [...sessionIds] };
  }

  const value = manifest.value.value;
  if (receipt.kind === "repository") {
    rememberManifestWorktrees(value, repositoryId, (id, path) => {
      if (path && !worktrees.has(id)) worktrees.set(id, { id, path });
    });
  }
  for (const record of value.records) {
    if (!record.worktreeId) continue;
    if (receipt.kind !== "repository" && !worktrees.has(record.worktreeId)) continue;
    sessionIds.add(record.id);
    if (receipt.kind === "repository" && !worktrees.has(record.worktreeId)) {
      const path = isAbsolute(record.worktreeId) ? record.worktreeId : record.cwd;
      if (path && isAbsolute(path))
        worktrees.set(record.worktreeId, { id: record.worktreeId, path });
    }
  }

  return { worktrees: [...worktrees.values()], sessionIds: [...sessionIds] };
}

/**
 * Records a durable deletion fence for one repository's runtime state. The in-process fence is
 * registered synchronously before the first await. Idempotent for the same token and scope.
 */
export function fenceRuntimeScope(
  paths: RuntimePaths,
  repositoryId: string,
  receipt: CleanupReceipt,
): Promise<Result<RuntimeCleanupStatus, ExpectedError>> {
  if (
    receipt.repositoryId !== repositoryId ||
    (receipt.kind === "worktrees" && receipt.worktrees.length === 0)
  ) {
    return Promise.resolve(err(new InputError("Cleanup receipt does not match this repository.")));
  }

  fenceRuntimeWrites(paths, {
    token: receipt.token,
    kind: receipt.kind,
    worktreeIds: receipt.worktrees.map((tree) => tree.id),
  });

  return underRuntimeLock(paths, async (ledger) => {
    const existing = ledger.receipts.find((entry) => entry.token === receipt.token);
    if (existing) {
      if (!sameScope(existing, receipt)) {
        return err(new InputError("Cleanup token is already used for a different scope."));
      }
      if (existing.state === "reopened") {
        // A reopened scope may be new data; an old token never fences it again.
        unfenceRuntimeWrites(paths, receipt.token);
      }

      return ok(statusOf(existing));
    }

    const inventory = await cleanupInventory(paths, repositoryId, receipt);
    const revision = ledger.revision + 1;
    const recorded: LedgerReceipt = {
      token: receipt.token,
      repositoryId,
      kind: receipt.kind,
      worktrees: inventory.worktrees.map((tree) => ({ id: tree.id, path: resolve(tree.path) })),
      sessionIds: inventory.sessionIds,
      masterRevision: receipt.revision,
      localRevision: revision,
      state: "fenced",
      candidates: [],
    };
    const written = await writeLedger(
      paths,
      trimLedger({ ...ledger, revision, receipts: [...ledger.receipts, recorded] }),
    );

    return written.ok ? ok(statusOf(recorded)) : written;
  });
}

/** Adds SDK files created or retired by stopped sessions to a fenced receipt's inventory. */
export function appendRuntimeCleanupCandidates(
  paths: RuntimePaths,
  repositoryId: string,
  token: string,
  candidates: readonly SessionDeletionCandidate[],
): Promise<Result<RuntimeCleanupStatus, ExpectedError>> {
  return underRuntimeLock(paths, async (ledger) => {
    const found = findReceipt(ledger, repositoryId, token);
    if (!found.ok) return found;

    const receipt = found.value;
    if (receipt.state !== "fenced") {
      return err(
        new InputError("Cleanup candidates can only be added before the purge completes."),
      );
    }

    const trees = new Set(receipt.worktrees.map((tree) => tree.id));
    const known = new Set(receipt.candidates.map((entry) => JSON.stringify(entry)));
    const added: LedgerReceipt["candidates"] = [];
    for (const candidate of candidates) {
      if (receipt.kind === "worktrees" && !trees.has(candidate.worktreeId)) {
        return err(new InputError("Cleanup candidate is outside the fenced worktrees."));
      }
      if (candidate.sessionFile !== undefined && !candidate.sessionFile.startsWith("/")) {
        return err(new InputError("Cleanup candidate session files must be absolute."));
      }

      const entry = {
        worktreeId: candidate.worktreeId,
        sessionId: candidate.sessionId,
        conversationId: candidate.conversationId,
        ...(candidate.sessionFile ? { sessionFile: resolve(candidate.sessionFile) } : {}),
      };
      const key = JSON.stringify(entry);
      if (!known.has(key)) {
        known.add(key);
        added.push(entry);
      }
    }
    if (!added.length) return ok(statusOf(receipt));

    const updated = { ...receipt, candidates: [...receipt.candidates, ...added] };
    const written = await writeLedger(paths, {
      ...ledger,
      receipts: ledger.receipts.map((entry) => (entry.token === token ? updated : entry)),
    });

    return written.ok ? ok(statusOf(updated)) : written;
  });
}

/** Lists receipts and re-registers in-process fences for unfinished or unreopened scopes. */
export async function inspectRuntimeCleanup(
  paths: RuntimePaths,
  repositoryId: string,
): Promise<Result<readonly RuntimeCleanupStatus[], ExpectedError>> {
  const ledger = await readLedger(paths);
  if (!ledger.ok) return ledger;

  const receipts = ledger.value.receipts.filter((entry) => entry.repositoryId === repositoryId);
  for (const receipt of receipts) {
    if (receipt.state !== "reopened") {
      fenceRuntimeWrites(paths, {
        token: receipt.token,
        kind: receipt.kind,
        worktreeIds: receipt.worktrees.map((tree) => tree.id),
      });
    }
  }

  return ok(receipts.map(statusOf));
}

/**
 * Allows a fresh generation to use a purged identity again. Repository scopes receive a new
 * private generation, so RuntimeStores created before the reopen never write again.
 */
export function reopenRuntimeScope(
  paths: RuntimePaths,
  repositoryId: string,
  token: string,
): Promise<Result<RuntimeCleanupStatus, ExpectedError>> {
  return underRuntimeLock(paths, async (ledger) => {
    const found = findReceipt(ledger, repositoryId, token);
    if (!found.ok) return found;
    if (found.value.state === "reopened") {
      unfenceRuntimeWrites(paths, token);

      return ok(statusOf(found.value));
    }
    if (found.value.state !== "purged") {
      return err(new InputError("A workspace scope can be reopened only after a complete purge."));
    }

    const revision = ledger.revision + 1;
    const reopened: LedgerReceipt = { ...found.value, state: "reopened", localRevision: revision };
    const written = await writeLedger(paths, {
      ...ledger,
      revision,
      generation: found.value.kind === "repository" ? randomUUID() : ledger.generation,
      receipts: ledger.receipts.map((entry) => (entry.token === token ? reopened : entry)),
    });
    if (!written.ok) return written;

    unfenceRuntimeWrites(paths, token);

    return ok(statusOf(reopened));
  });
}

type SdkHeader = { id: string; cwd: string };
type Fingerprint = { dev: number; ino: number; size: number; mtimeMs: number };
type InspectedOriginal =
  | { kind: "absent" }
  | { kind: "external"; header?: SdkHeader }
  | { kind: "owned"; header: SdkHeader; fingerprint: Fingerprint };

const sameIdentity = (a: Fingerprint, b: Fingerprint) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

// Returns the canonical path of a designated runtime-owned directory, or null when absent.
async function canonicalOwnedDirectory(
  paths: RuntimePaths,
  directory: string,
  label: string,
): Promise<Result<string | null, ExpectedError>> {
  const root = await capture(() => realpath(paths.directory));
  if (!root.ok) return root;
  const entry = await capture(() => lstat(directory));
  if (!entry.ok) {
    return entry.error instanceof StorageError && entry.error.systemCode === "ENOENT"
      ? ok(null)
      : entry;
  }
  if (
    !entry.value.isDirectory() ||
    entry.value.isSymbolicLink() ||
    (process.getuid && entry.value.uid !== process.getuid())
  ) {
    return err(new StorageError(`${label} was replaced; nothing in it was removed.`));
  }
  const found = await capture(() => realpath(directory));
  if (!found.ok) return found;
  // A canonical location is not ownership: a direct or ancestor symlink may lead outside
  // the runtime. Allow aliases of the state root, never aliases of owned descendants.
  if (found.value !== join(root.value, relative(paths.directory, directory))) {
    return err(new StorageError(`${label} has a symbolic location; nothing in it was removed.`));
  }

  return ok(found.value);
}

async function canonicalDirectories(
  paths: RuntimePaths,
): Promise<Result<Set<string>, ExpectedError>> {
  const result = new Set<string>();
  for (const directory of ownedSdkDirectories(paths)) {
    const found = await canonicalOwnedDirectory(paths, directory, "Owned SDK session directory");
    if (!found.ok) return found;
    if (found.value) result.add(found.value);
  }

  return ok(result);
}

const snapshotDirectory = (paths: RuntimePaths) => join(paths.directory, "sessions");
const canonicalSnapshotDirectory = (paths: RuntimePaths) =>
  canonicalOwnedDirectory(paths, snapshotDirectory(paths), "Session snapshot directory");

// Retention removes a published snapshot only through the verified snapshot directory.
async function removeSnapshotFile(
  paths: RuntimePaths,
  key: string,
): Promise<Result<void, ExpectedError>> {
  const directory = await canonicalSnapshotDirectory(paths);
  if (!directory.ok) return directory;

  return directory.value
    ? removeRetentionFile(join(directory.value, `${key}.json`))
    : ok(undefined);
}

// `<key>.json` is a published snapshot; `<key>.json.<uuid>.tmp` is an unpublished atomic write.
const snapshotFileName =
  /^([a-f0-9]{64})\.json(\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp)?$/;

type SnapshotFile = { path: string; fingerprint: Fingerprint };

// Reads a snapshot only as a private, single-link regular file of this user directly inside the
// canonical snapshot directory. Symlinked entries are never followed. Absent files yield null.
async function readOwnedSnapshot(
  path: string,
  directory: string,
): Promise<Result<{ text: string; file: SnapshotFile } | null, ExpectedError>> {
  const parent = await capture(() => realpath(dirname(path)));
  if (!parent.ok) return parent;
  if (parent.value !== directory) {
    return err(new StorageError("Session snapshot location changed; it was retained."));
  }

  const read = await capture(async () => {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

    return withCleanup(
      async () => {
        const stat = await file.stat();
        const fingerprint = {
          dev: stat.dev,
          ino: stat.ino,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        };
        const owned =
          stat.isFile() &&
          stat.nlink === 1 &&
          (stat.mode & 0o077) === 0 &&
          (!process.getuid || stat.uid === process.getuid());

        return owned ? { text: await file.readFile("utf8"), fingerprint } : null;
      },
      () => file.close(),
    );
  });
  if (!read.ok) {
    return read.error instanceof StorageError && read.error.systemCode === "ENOENT"
      ? ok(null)
      : read;
  }
  if (!read.value) {
    return err(
      new StorageError("Session snapshot is not a private regular file; it was retained."),
    );
  }

  return ok({ text: read.value.text, file: { path, fingerprint: read.value.fingerprint } });
}

function parseSnapshot(text: string, key: string): (SessionRecord & { worktreeId: string }) | null {
  const parsed = parseJson(text, "session snapshot");

  return parsed.ok &&
    Value.Check(sessionRecordSchema, parsed.value) &&
    snapshotKey(parsed.value) === key
    ? parsed.value
    : null;
}

async function readSdkHeader(
  path: string,
): Promise<Result<{ header: SdkHeader | null; fingerprint: Fingerprint }, ExpectedError>> {
  const read = await capture(async () => {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

    return withCleanup(
      async () => {
        const stat = await file.stat();
        const buffer = Buffer.alloc(65536);
        const bytes = await file.read(buffer, 0, buffer.length, 0);
        const line = buffer
          .subarray(0, bytes.bytesRead)
          .toString("utf8")
          .split(/\r?\n/)
          .find((text) => text.trim());
        const parsed = parseJson(line ?? "", "SDK session header");
        const value = parsed.ok ? parsed.value : null;
        const header =
          value &&
          typeof value === "object" &&
          "type" in value &&
          value.type === "session" &&
          "id" in value &&
          typeof value.id === "string" &&
          value.id.length > 0 &&
          "cwd" in value &&
          typeof value.cwd === "string" &&
          value.cwd.startsWith("/") &&
          !value.cwd.includes("\0")
            ? { id: value.id, cwd: resolve(value.cwd) }
            : null;

        return {
          header,
          fingerprint: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs },
        };
      },
      () => file.close(),
    );
  });

  return read;
}

// Location inside an owned SDK directory plus a valid private header is the ownership proof;
// a header or `managed` flag alone never authorizes deleting a file elsewhere.
async function inspectOriginal(
  path: string,
  owned: ReadonlySet<string>,
): Promise<Result<InspectedOriginal, ExpectedError>> {
  const found = await capture(() => lstat(path));
  if (!found.ok) {
    return found.error instanceof StorageError &&
      (found.error.systemCode === "ENOENT" || found.error.systemCode === "ENOTDIR")
      ? ok({ kind: "absent" })
      : found;
  }

  const parent = await capture(() => realpath(dirname(path)));
  if (!parent.ok) return parent;
  const inOwned = owned.has(parent.value) && sdkFileName.test(basename(path));
  if (!found.value.isFile() || found.value.isSymbolicLink()) {
    return inOwned
      ? err(new StorageError("Owned SDK session path is not a regular file."))
      : ok({ kind: "external" });
  }

  const read = await readSdkHeader(path);
  if (!read.ok) return read;
  if (!inOwned) {
    return ok({ kind: "external", ...(read.value.header ? { header: read.value.header } : {}) });
  }
  if (
    found.value.nlink !== 1 ||
    (process.getuid && found.value.uid !== process.getuid()) ||
    found.value.ino !== read.value.fingerprint.ino ||
    found.value.dev !== read.value.fingerprint.dev
  ) {
    return err(new StorageError("Owned SDK session file has unexpected links or ownership."));
  }
  if (!read.value.header) {
    return err(new StorageError("Owned SDK session file has no valid session header."));
  }

  return ok({ kind: "owned", header: read.value.header, fingerprint: read.value.fingerprint });
}

async function unlinkIfSame(
  path: string,
  expected: Fingerprint,
  owned: ReadonlySet<string>,
): Promise<Result<void, ExpectedError>> {
  const parent = await capture(() => realpath(dirname(path)));
  if (!parent.ok) return parent;
  if (!owned.has(parent.value)) {
    return err(
      new StorageError("Owned file location changed before deletion; the file was retained."),
    );
  }
  const found = await capture(() => lstat(path));
  if (!found.ok) {
    return found.error instanceof StorageError && found.error.systemCode === "ENOENT"
      ? ok(undefined)
      : found;
  }
  if (
    !found.value.isFile() ||
    !sameIdentity(expected, {
      dev: found.value.dev,
      ino: found.value.ino,
      size: found.value.size,
      mtimeMs: found.value.mtimeMs,
    })
  ) {
    return err(new StorageError("SDK session changed during workspace cleanup; it was retained."));
  }

  return removeRetentionFile(path);
}

type ManifestFile =
  | { kind: "absent" }
  | { kind: "indexed"; value: Static<typeof storedManifestSchema> }
  | { kind: "legacy"; value: Static<typeof manifestSchema> };

async function readManifestFile(
  paths: RuntimePaths,
  repositoryId: string,
): Promise<Result<ManifestFile, ExpectedError>> {
  const read = await capture(() => readFile(paths.manifest, "utf8"));
  if (!read.ok) {
    return read.error instanceof StorageError && read.error.systemCode === "ENOENT"
      ? ok({ kind: "absent" })
      : read;
  }

  return parseManifestText(read.value, repositoryId);
}

function parseManifestText(
  text: string,
  repositoryId: string,
): Result<ManifestFile, ExpectedError> {
  const parsed = parseJson(text, "runtime manifest");
  if (parsed.ok && Value.Check(storedManifestSchema, parsed.value)) {
    return parsed.value.repositoryId === repositoryId
      ? ok({ kind: "indexed", value: parsed.value })
      : err(new StorageError("Runtime manifest belongs to another repository."));
  }
  if (parsed.ok && Value.Check(manifestSchema, parsed.value)) {
    return parsed.value.repositoryId === repositoryId
      ? ok({ kind: "legacy", value: parsed.value })
      : err(new StorageError("Runtime manifest belongs to another repository."));
  }

  return err(new StorageError("Invalid runtime manifest; it was retained for inspection."));
}

type Conversation = {
  key: string;
  id: string;
  worktreeId: string;
  conversationId: string;
  cwd?: string;
  files: Set<string>;
  // Verified published snapshot and unpublished atomic-write copies of this conversation.
  snapshots: SnapshotFile[];
  failed: boolean;
};

/**
 * Removes the owned persisted state of a fenced scope. The caller confirms that every scoped
 * Agent, editor, terminal, plan and checkpoint writer has stopped. Partial failures keep the
 * receipt fenced and are reported as residuals; retrying with the same token is idempotent.
 */
export function purgeRuntimeScope(
  paths: RuntimePaths,
  repositoryId: string,
  token: string,
  confirmation: { writersStopped: true },
): Promise<Result<RuntimeCleanupReport, ExpectedError>> {
  if (confirmation.writersStopped !== true) {
    return Promise.resolve(err(new InputError("Purge requires stopped scoped writers.")));
  }

  return underRuntimeLock(paths, async (ledger) => {
    const found = findReceipt(ledger, repositoryId, token);
    if (!found.ok) return found;

    const receipt = found.value;
    if (receipt.state === "reopened") {
      return err(new InputError("This cleanup receipt was reopened; it can no longer purge."));
    }
    if (receipt.state === "purged") {
      return ok({
        ...statusOf(receipt),
        complete: true,
        removed: [],
        preserved: [],
        residuals: [],
      });
    }

    fenceRuntimeWrites(paths, {
      token,
      kind: receipt.kind,
      worktreeIds: receipt.worktrees.map((tree) => tree.id),
    });

    return purgeFenced(paths, repositoryId, ledger, receipt);
  });
}

async function purgeFenced(
  paths: RuntimePaths,
  repositoryId: string,
  ledger: Ledger,
  receipt: LedgerReceipt,
): Promise<Result<RuntimeCleanupReport, ExpectedError>> {
  const removed: string[] = [];
  const preserved: RuntimeCleanupItem[] = [];
  const residuals: RuntimeCleanupItem[] = [];
  const residual = (path: string, error: ExpectedError) =>
    residuals.push({ path, reason: error.message, code: error.code });
  const whole = receipt.kind === "repository";
  const trees = new Set(receipt.worktrees.map((tree) => tree.id));
  const scopePaths = new Set(receipt.worktrees.map((tree) => resolve(tree.path)));
  const treePaths = new Map(receipt.worktrees.map((tree) => [tree.id, resolve(tree.path)]));
  const targets = (worktreeId: string) => whole || trees.has(worktreeId);
  const sessionIds = new Set(receipt.sessionIds);

  const owned = await canonicalDirectories(paths);
  if (!owned.ok) return owned;
  // A replaced snapshot directory may lead anywhere; nothing is read or removed through it.
  const snapshots = await canonicalSnapshotDirectory(paths);
  if (!snapshots.ok) {
    residual(snapshotDirectory(paths), snapshots.error);

    return finish(paths, ledger, receipt, sessionIds, removed, preserved, residuals);
  }
  const snapshotRoot = snapshots.value;
  const manifest = await readManifestFile(paths, repositoryId);
  if (!manifest.ok) {
    residual(paths.manifest, manifest.error);

    return finish(paths, ledger, receipt, sessionIds, removed, preserved, residuals);
  }

  // Crash copies may be the only surviving references to an imported original or owned plan.
  // Inspect them before file cleanup, and keep their references until that cleanup succeeds.
  const manifestCopies = await inspectManifestCopies(paths, repositoryId, residual);

  // 1. Inventory target conversations from the index, snapshots, legacy records and candidates.
  const conversations = new Map<string, Conversation>();
  const add = (
    key: string,
    id: string,
    worktreeId: string,
    conversationId: string,
    cwd?: string,
  ) => {
    let entry = conversations.get(key);
    if (!entry) {
      entry = {
        key,
        id,
        worktreeId,
        conversationId,
        ...(cwd ? { cwd } : {}),
        files: new Set(),
        snapshots: [],
        failed: false,
      };
      conversations.set(key, entry);
    }
    sessionIds.add(id);

    return entry;
  };
  const collect = (entry: Conversation, record: SessionRecord) => {
    if (record.sessionFile) entry.files.add(resolve(record.sessionFile));
    for (const child of record.ownedSubagents ?? []) {
      if (child.sessionFile?.startsWith("/")) entry.files.add(resolve(child.sessionFile));
    }
  };
  // Index keys of every worktree; a published snapshot of a sibling is owned by its entry.
  const indexedKeys = new Set<string>();
  if (manifest.value.kind === "indexed") {
    for (const index of manifest.value.value.records) {
      indexedKeys.add(index.key);
      if (!targets(index.worktreeId)) continue;
      const entry = add(
        index.key,
        index.id,
        index.worktreeId,
        index.conversationId ?? index.id,
        index.cwd,
      );
      if (index.sessionFile) entry.files.add(resolve(index.sessionFile));
    }
  } else if (manifest.value.kind === "legacy") {
    for (const record of manifest.value.value.records) {
      const key = snapshotKey(record);
      indexedKeys.add(key);
      if (!targets(record.worktreeId)) continue;
      collect(
        add(
          key,
          record.id,
          record.worktreeId,
          record.state.conversationId ?? record.id,
          record.cwd,
        ),
        record,
      );
    }
  }
  for (const copy of manifestCopies) {
    if (copy.manifest.kind === "legacy") {
      for (const record of copy.manifest.value.records) {
        if (!targets(record.worktreeId)) continue;
        collect(
          add(
            snapshotKey(record),
            record.id,
            record.worktreeId,
            record.state.conversationId ?? record.id,
            record.cwd,
          ),
          record,
        );
      }
    } else {
      for (const record of copy.manifest.value.records) {
        if (!targets(record.worktreeId)) continue;
        const entry = add(
          record.key,
          record.id,
          record.worktreeId,
          record.conversationId ?? record.id,
          record.cwd,
        );
        if (record.sessionFile) entry.files.add(resolve(record.sessionFile));
      }
    }
  }
  // Unidentifiable copies of unindexed keys cannot name their worktree. Only a repository scope,
  // which owns the whole snapshot directory, may remove them.
  const unreadableCopies: SnapshotFile[] = [];
  if (snapshotRoot) {
    const listed = await capture(() => readdir(snapshotRoot));
    if (!listed.ok) {
      residual(snapshotRoot, listed.error);

      return finish(paths, ledger, receipt, sessionIds, removed, preserved, residuals);
    }
    // Published snapshots of indexed conversations, then unindexed snapshots and unpublished
    // copies left by a crash before the index or the rename was published.
    const names = new Set(listed.value);
    for (const conversation of conversations.values()) names.add(`${conversation.key}.json`);
    for (const name of names) {
      const match = snapshotFileName.exec(name);
      if (!match) continue;
      const key = match[1]!;
      const unpublished = match[2] !== undefined;
      const known = conversations.get(key);
      // The key digests the worktree identity, so an indexed sibling key and its unpublished
      // copies belong to that sibling and are never read here.
      if (!known && indexedKeys.has(key)) continue;

      const path = join(snapshotRoot, name);
      const read = await readOwnedSnapshot(path, snapshotRoot);
      if (!read.ok) {
        if (known) known.failed = true;
        residual(path, read.error);
        continue;
      }
      if (!read.value) continue;

      const record = parseSnapshot(read.value.text, key);
      if (!record) {
        if (known && unpublished) {
          // The private file name carries the target conversation key; a torn copy is its own.
          known.snapshots.push(read.value.file);
        } else if (known) {
          known.failed = true;
          residual(path, new StorageError("Invalid or mismatched session snapshot."));
        } else if (whole) {
          // A repository scope owns the entire verified snapshot directory.
          unreadableCopies.push(read.value.file);
        } else {
          residual(path, new StorageError("Cannot verify the owner of this session snapshot."));
        }
        continue;
      }
      if (!known && !targets(record.worktreeId)) continue;
      const treePath = treePaths.get(record.worktreeId);
      if (!known && !whole && record.cwd && resolve(record.cwd) !== treePath) {
        residual(path, new StorageError("Session snapshot worktree differs from its scope."));
        continue;
      }

      // An unindexed snapshot's SDK files must still name its receipt worktree's path.
      const entry =
        known ??
        add(
          key,
          record.id,
          record.worktreeId,
          record.state.conversationId ?? record.id,
          record.cwd ?? treePath,
        );
      collect(entry, record);
      entry.snapshots.push(read.value.file);
    }
  }
  const candidateFiles = new Set<string>();
  for (const candidate of receipt.candidates) {
    sessionIds.add(candidate.sessionId);
    if (candidate.sessionFile) candidateFiles.add(candidate.sessionFile);
  }

  if (whole) {
    // Snapshot-only and late-created scopes are known only after the complete inventory.
    const known = new Set(receipt.worktrees.map((tree) => tree.id));
    const remember = (id: string, cwd?: string) => {
      if (known.has(id)) return;
      const path = isAbsolute(id) ? id : cwd;
      if (path && isAbsolute(path)) {
        receipt.worktrees.push({ id, path });
        known.add(id);
      }
    };
    for (const copy of manifestCopies)
      rememberManifestWorktrees(copy.manifest.value, repositoryId, remember);
    for (const conversation of conversations.values())
      remember(conversation.worktreeId, conversation.cwd);
    for (const candidate of receipt.candidates) remember(candidate.worktreeId);
  }

  // 2. Owned SDK directories: include header-verified files of this scope not yet referenced.
  // Scanned files of other worktrees are not evidence for this scope and never block it.
  const scannedFiles = new Set<string>();
  for (const directory of owned.value) {
    const listed = await capture(() => readdir(directory));
    if (!listed.ok) {
      residual(directory, listed.error);
      continue;
    }
    for (const name of listed.value) {
      if (sdkFileName.test(name)) scannedFiles.add(join(directory, name));
    }
  }

  // 3. Remove sidecars, then owned originals. External originals are preserved.
  const fileOwner = new Map<string, Conversation | undefined>();
  for (const conversation of conversations.values()) {
    for (const file of conversation.files) fileOwner.set(file, conversation);
  }
  for (const file of [...candidateFiles, ...scannedFiles]) {
    if (!fileOwner.has(file)) fileOwner.set(file, undefined);
  }
  for (const [file, conversation] of fileOwner) {
    const inspected = await inspectOriginal(file, owned.value);
    if (!inspected.ok) {
      // A corrupt file outside this worktree scope's evidence is not ours to judge.
      if (conversation || whole || candidateFiles.has(file)) {
        if (conversation) conversation.failed = true;
        residual(file, inspected.error);
      }
      continue;
    }

    const original = inspected.value;
    const header = original.kind === "absent" ? undefined : original.header;
    if (!conversation) {
      // Unreferenced owned file: its header must name this scope.
      if (original.kind !== "owned" || (!whole && !scopePaths.has(original.header.cwd))) continue;
    } else if (header && conversation.cwd && header.cwd !== resolve(conversation.cwd)) {
      if (original.kind === "owned") {
        conversation.failed = true;
        residual(file, new StorageError("SDK session worktree differs from its indexed scope."));
      } else {
        preserved.push({ path: file, reason: "External SDK session belongs to another worktree." });
      }
      continue;
    }

    const planOwner = header
      ? { conversationId: header.id, cwd: header.cwd }
      : conversation?.cwd
        ? { conversationId: conversation.conversationId, cwd: resolve(conversation.cwd) }
        : undefined;
    const sidecar = planFilePath(file);
    if (planOwner) {
      const plan = await deleteTaskPlanForPurge(file, planOwner);
      if (!plan.ok) {
        const absentParent =
          plan.error instanceof StorageError && plan.error.systemCode === "ENOENT";
        if (!absentParent) {
          if (conversation) conversation.failed = true;
          residual(sidecar, plan.error);
          continue;
        }
      } else if (plan.value === "removed") {
        removed.push(sidecar);
      }
    } else {
      const exists = await capture(() => lstat(sidecar));
      if (exists.ok) {
        if (conversation) conversation.failed = true;
        residual(sidecar, new StorageError("Cannot verify ownership of task plan sidecar."));
        continue;
      }
    }

    if (planOwner) {
      const workflowInspection = await inspectWorkflowForRetention(file, planOwner);
      if (!workflowInspection.ok) {
        if (conversation) conversation.failed = true;
        residual(workflowFilePath(file), workflowInspection.error);
        continue;
      }
      const workflowPath =
        workflowInspection.value.kind === "ready" && workflowInspection.value.sidecar === "link"
          ? workflowLinkFilePath(file)
          : workflowInspection.value.kind === "ready" &&
              workflowInspection.value.sidecar === "backup"
            ? workflowBackupFilePath(file)
            : workflowFilePath(file);
      const workflow = await deleteWorkflowForPurge(file, planOwner);
      if (!workflow.ok) {
        if (conversation) conversation.failed = true;
        residual(workflowFilePath(file), workflow.error);
        continue;
      }
      if (workflow.value === "retained") {
        const retainedPaths = [workflowFilePath(file)];
        if (workflowInspection.value.kind === "ready" && workflowInspection.value.backupFingerprint)
          retainedPaths.push(workflowBackupFilePath(file));
        for (const path of retainedPaths)
          preserved.push({
            path,
            reason: "Workflow retained because a live continuation still references it.",
          });
      } else if (workflow.value === "removed") {
        removed.push(workflowPath);
        if (workflowInspection.value.kind === "ready" && workflowInspection.value.backupFingerprint)
          removed.push(workflowBackupFilePath(file));
      }
    } else {
      let unverified = false;
      for (const path of [
        workflowFilePath(file),
        workflowLinkFilePath(file),
        workflowBackupFilePath(file),
      ]) {
        const found = await capture(() => lstat(path));
        if (
          found.ok ||
          !(found.error instanceof StorageError && found.error.systemCode === "ENOENT")
        ) {
          residual(
            path,
            found.ok ? new StorageError("Cannot verify workflow owner.") : found.error,
          );
          unverified = true;
        }
      }
      if (unverified) {
        if (conversation) conversation.failed = true;
        continue;
      }
    }

    if (original.kind === "owned") {
      const deleted = await unlinkIfSame(file, original.fingerprint, owned.value);
      if (!deleted.ok) {
        if (conversation) conversation.failed = true;
        residual(file, deleted.error);
        continue;
      }
      removed.push(file);
    } else if (original.kind === "external") {
      preserved.push({ path: file, reason: "External SDK session original is never deleted." });
    }
  }

  // 4. Orphaned owned sidecars whose original is already gone.
  for (const directory of owned.value) {
    const listed = await capture(() => readdir(directory));
    if (!listed.ok) continue;
    for (const name of listed.value) {
      const suffix = [
        ".plan.json",
        ".workflow.json",
        ".workflow-link.json",
        ".workflow-v1-backup.json",
      ].find((suffix) => name.endsWith(".jsonl" + suffix));
      if (!suffix) continue;
      const original = join(directory, name.slice(0, -suffix.length));
      const sidecar = join(directory, name);
      if (preserved.some((item) => item.path === sidecar)) continue;
      // Removing an origin also removes its backup from this directory listing.
      const present = await capture(() => lstat(sidecar));
      if (!present.ok) {
        if (!(present.error instanceof StorageError && present.error.systemCode === "ENOENT"))
          residual(sidecar, present.error);
        continue;
      }
      const exists = await capture(() => lstat(original));
      if (exists.ok) {
        if (whole)
          residual(sidecar, new StorageError("Task plan sidecar of a retained SDK session."));
        continue;
      }
      const owner = await sidecarOwner(sidecar);
      if (!owner || (!whole && !scopePaths.has(resolve(owner.cwd)))) {
        if (whole)
          residual(sidecar, new StorageError("Cannot verify ownership of task plan sidecar."));
        continue;
      }
      const plan =
        suffix === ".plan.json"
          ? await deleteTaskPlanForPurge(original, owner)
          : await deleteWorkflowForPurge(original, owner);
      if (plan.ok && plan.value === "removed") removed.push(sidecar);
      else if (plan.ok && plan.value === "retained")
        preserved.push({
          path: sidecar,
          reason: "Workflow retained because a live continuation still references it.",
        });
      else if (!plan.ok) residual(sidecar, plan.error);
    }
  }

  // 5. Snapshots and index entries of conversations whose files are gone.
  const purgedKeys = new Set<string>();
  const snapshotOwner = new Set(snapshotRoot ? [snapshotRoot] : []);
  const removeSnapshot = async (file: SnapshotFile) => {
    const deleted = await unlinkIfSame(file.path, file.fingerprint, snapshotOwner);
    if (deleted.ok) removed.push(file.path);
    else residual(file.path, deleted.error);

    return deleted.ok;
  };
  for (const conversation of conversations.values()) {
    if (conversation.failed) continue;
    let complete = true;
    for (const file of conversation.snapshots) {
      if (!(await removeSnapshot(file))) complete = false;
    }
    if (complete) purgedKeys.add(conversation.key);
  }
  for (const file of unreadableCopies) await removeSnapshot(file);

  const rewritten = await rewriteManifest(
    paths,
    manifest.value,
    targets,
    purgedKeys,
    trees,
    sessionIds,
    whole,
  );
  if (!rewritten.ok) {
    residual(paths.manifest, rewritten.error);
  } else if (rewritten.value) {
    removed.push(paths.manifest);
  }
  if (!whole) {
    // Repository scopes remove every manifest copy with the rest of the directory.
    await scrubManifestCopies(manifestCopies, targets, trees, sessionIds, purgedKeys, residual);
  }

  if (whole && !residuals.length) {
    await removeRepositoryLeftovers(paths, removed, preserved, residuals);
  }

  return finish(paths, ledger, receipt, sessionIds, removed, preserved, residuals);
}

/**
 * Removes a worktree scope's data from unpublished `workspace.json.<uuid>.tmp` copies left by a
 * crash during an atomic write. Copies are never published; a copy without scope data stays as
 * it is, and an unidentifiable copy is reported because it may hold the scope's transcripts.
 */
type ManifestCopy = {
  file: SnapshotFile;
  directory: string;
  manifest: Exclude<ManifestFile, { kind: "absent" }>;
};

async function inspectManifestCopies(
  paths: RuntimePaths,
  repositoryId: string,
  residual: (path: string, error: ExpectedError) => void,
): Promise<ManifestCopy[]> {
  const copies: ManifestCopy[] = [];
  const root = await capture(() => realpath(paths.directory));
  if (!root.ok) {
    residual(paths.directory, root.error);
    return copies;
  }
  const listed = await capture(() => readdir(root.value));
  if (!listed.ok) {
    residual(root.value, listed.error);
    return copies;
  }

  const prefix = basename(paths.manifest) + ".";
  for (const name of listed.value) {
    if (!name.startsWith(prefix) || !temporaryName.test(name)) continue;
    const path = join(root.value, name);
    const read = await readOwnedSnapshot(path, root.value);
    if (!read.ok) {
      residual(path, read.error);
      continue;
    }
    if (!read.value) continue;

    const parsed = parseManifestText(read.value.text, repositoryId);
    if (!parsed.ok || parsed.value.kind === "absent") {
      residual(path, new StorageError("Cannot verify the owner of an unpublished manifest copy."));
      continue;
    }

    copies.push({ file: read.value.file, directory: root.value, manifest: parsed.value });
  }

  return copies;
}

async function scrubManifestCopies(
  copies: readonly ManifestCopy[],
  targets: (worktreeId: string) => boolean,
  trees: ReadonlySet<string>,
  sessionIds: Set<string>,
  purgedKeys: ReadonlySet<string>,
  residual: (path: string, error: ExpectedError) => void,
): Promise<void> {
  for (const entry of copies) {
    const copy = entry.manifest.value;
    for (const record of copy.records) {
      if (targets(record.worktreeId)) sessionIds.add(record.id);
    }
    const value = {
      ...copy,
      repositories: scrubRepositories(copy.repositories, trees),
      preferences: scrubPreferences(copy.preferences, trees, sessionIds),
      records:
        entry.manifest.kind === "indexed"
          ? entry.manifest.value.records.filter(
              (record) => !targets(record.worktreeId) || !purgedKeys.has(record.key),
            )
          : entry.manifest.value.records.filter(
              (record) => !targets(record.worktreeId) || !purgedKeys.has(snapshotKey(record)),
            ),
    };
    const text = JSON.stringify(value);
    if (text === JSON.stringify(copy)) continue;

    const replaced = await replaceOwnedCopy(entry.file, text, entry.directory);
    if (!replaced.ok) residual(entry.file.path, replaced.error);
  }
}

// Rewrites an unpublished copy in place after re-checking that it is still the inspected file.
async function replaceOwnedCopy(
  file: SnapshotFile,
  text: string,
  directory: string,
): Promise<Result<void, ExpectedError>> {
  const temporary = join(directory, `.${randomUUID()}.scrub`);

  return capture(() =>
    withCleanup(
      async () => {
        await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
        const parent = await realpath(dirname(file.path));
        const found = await lstat(file.path);
        if (
          parent !== directory ||
          !found.isFile() ||
          !sameIdentity(file.fingerprint, {
            dev: found.dev,
            ino: found.ino,
            size: found.size,
            mtimeMs: found.mtimeMs,
          })
        ) {
          throw new StorageError("Unpublished manifest copy changed during cleanup; it was kept.");
        }
        await rename(temporary, file.path);
      },
      () => rm(temporary, { force: true }),
    ),
  );
}

async function sidecarOwner(path: string): Promise<{ conversationId: string; cwd: string } | null> {
  const read = await capture(() => readFile(path, "utf8"));
  if (!read.ok) return null;
  const parsed = parseJson(read.value, "task plan sidecar");
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") return null;
  const owner =
    path.endsWith(".workflow.json") || path.endsWith(".workflow-v1-backup.json")
      ? (parsed.value as { origin?: unknown }).origin
      : (parsed.value as { owner?: unknown }).owner;
  if (
    !owner ||
    typeof owner !== "object" ||
    typeof (owner as { conversationId?: unknown }).conversationId !== "string" ||
    typeof (owner as { cwd?: unknown }).cwd !== "string"
  ) {
    return null;
  }

  // Full validation happens again inside deleteTaskPlanForPurge.
  return owner as { conversationId: string; cwd: string };
}

// Returns true when the manifest file itself was removed.
async function rewriteManifest(
  paths: RuntimePaths,
  manifest: ManifestFile,
  targets: (worktreeId: string) => boolean,
  purgedKeys: ReadonlySet<string>,
  trees: ReadonlySet<string>,
  sessionIds: ReadonlySet<string>,
  whole: boolean,
): Promise<Result<boolean, ExpectedError>> {
  if (manifest.kind === "absent") return ok(false);

  if (manifest.kind === "indexed") {
    const records = manifest.value.records.filter((entry) => !purgedKeys.has(entry.key));
    const remainingTargets = records.some((entry) => targets(entry.worktreeId));
    if (whole && !remainingTargets) {
      // Repository scope: nothing of this repository remains to index.
      const deleted = await removeRetentionFile(paths.manifest);

      return deleted.ok ? ok(true) : deleted;
    }
    const value = {
      ...manifest.value,
      repositories: scrubRepositories(manifest.value.repositories, trees),
      preferences: scrubPreferences(manifest.value.preferences, trees, sessionIds),
      records,
    };
    const written = await capture(() => atomicWrite(paths.manifest, JSON.stringify(value)));

    return written.ok ? ok(false) : written;
  }

  const records = manifest.value.records.filter((record) => !purgedKeys.has(snapshotKey(record)));
  if (whole && !records.some((record) => targets(record.worktreeId))) {
    const deleted = await removeRetentionFile(paths.manifest);

    return deleted.ok ? ok(true) : deleted;
  }
  const value = {
    ...manifest.value,
    repositories: scrubRepositories(manifest.value.repositories, trees),
    preferences: scrubPreferences(manifest.value.preferences, trees, sessionIds),
    records,
  };
  const written = await capture(() => atomicWrite(paths.manifest, JSON.stringify(value)));

  return written.ok ? ok(false) : written;
}

// Removes only known, Radian-owned names. Anything unrecognised is reported, never guessed.
async function removeRepositoryLeftovers(
  paths: RuntimePaths,
  removed: string[],
  preserved: RuntimeCleanupItem[],
  residuals: RuntimeCleanupItem[],
): Promise<void> {
  const unlinkKnown = async (path: string) => {
    const found = await capture(() => lstat(path));
    if (!found.ok) {
      if (!(found.error instanceof StorageError && found.error.systemCode === "ENOENT")) {
        residuals.push({ path, reason: found.error.message, code: found.error.code });
      }
      return;
    }
    if (!found.value.isFile() || found.value.isSymbolicLink()) {
      residuals.push({ path, reason: "Unexpected non-regular file in runtime state." });
      return;
    }
    const deleted = await removeRetentionFile(path);
    if (deleted.ok) removed.push(path);
    else residuals.push({ path, reason: deleted.error.message, code: deleted.error.code });
  };
  const emptyDirectory = async (path: string, known: (name: string) => boolean) => {
    // Validate the designated directory before traversal; a replaced one leads elsewhere.
    const canonical = await canonicalOwnedDirectory(paths, path, "Owned runtime directory");
    if (!canonical.ok) {
      residuals.push({ path, reason: canonical.error.message, code: canonical.error.code });
      return;
    }
    if (!canonical.value) return;
    const listed = await capture(() => readdir(canonical.value!));
    if (!listed.ok) {
      if (!(listed.error instanceof StorageError && listed.error.systemCode === "ENOENT")) {
        residuals.push({ path, reason: listed.error.message, code: listed.error.code });
      }
      return;
    }
    let left = 0;
    for (const name of listed.value) {
      if (preserved.some((item) => item.path === join(canonical.value!, name))) {
        left++;
        continue;
      }
      if (known(name)) {
        const file = join(canonical.value, name);
        if (name.endsWith(".workflow-v1-backup.json")) {
          const owner = await sidecarOwner(file);
          const deleted = owner
            ? await deleteWorkflowForPurge(file.slice(0, -".workflow-v1-backup.json".length), owner)
            : err(new StorageError("Cannot verify ownership of workflow backup."));
          if (!deleted.ok) {
            left++;
            residuals.push({ path: file, reason: deleted.error.message, code: deleted.error.code });
          } else if (deleted.value === "retained") {
            left++;
            preserved.push({ path: file, reason: "Workflow retained by a live continuation." });
          } else if (deleted.value === "removed") removed.push(file);
        } else await unlinkKnown(file);
      } else {
        left++;
        residuals.push({ path: join(path, name), reason: "Unrecognised file in owned directory." });
      }
    }
    if (!left) {
      const deleted = await capture(() => rmdir(path));
      if (deleted.ok) removed.push(path);
      else residuals.push({ path, reason: deleted.error.message, code: deleted.error.code });
    }
  };

  await emptyDirectory(snapshotDirectory(paths), (name) => snapshotFileName.test(name));
  for (const directory of ownedSdkDirectories(paths)) {
    await emptyDirectory(directory, (name) => name.endsWith(".jsonl.workflow-v1-backup.json"));
  }
  await unlinkKnown(paths.log);

  const listed = await capture(() => readdir(paths.directory));
  if (!listed.ok) {
    residuals.push({
      path: paths.directory,
      reason: listed.error.message,
      code: listed.error.code,
    });
    return;
  }
  for (const name of listed.value) {
    const keptTemporary = name.startsWith("cleanup.json.") && temporaryName.test(name);
    if (name === "cleanup.json" || name === "state.lock" || keptTemporary) {
      continue;
    }
    if (name.startsWith("workspace.json") && temporaryName.test(name)) {
      await unlinkKnown(join(paths.directory, name));
    } else if (name === "offline-agent") {
      // Scripted test-mode configuration; it contains no conversation data.
      preserved.push({
        path: join(paths.directory, name),
        reason: "Offline fixture configuration.",
      });
    } else if (name !== "sessions" && name !== "sdk-sessions") {
      residuals.push({ path: join(paths.directory, name), reason: "Unrecognised runtime state." });
    }
  }
}

async function finish(
  paths: RuntimePaths,
  ledger: Ledger,
  receipt: LedgerReceipt,
  sessionIds: ReadonlySet<string>,
  removed: string[],
  preserved: RuntimeCleanupItem[],
  residuals: RuntimeCleanupItem[],
): Promise<Result<RuntimeCleanupReport, ExpectedError>> {
  const complete = residuals.length === 0;
  // The revision changes whenever the index may have changed, so live stores reload it.
  const revision = ledger.revision + 1;
  const updated: LedgerReceipt = {
    ...receipt,
    sessionIds: [...sessionIds],
    state: complete ? "purged" : "fenced",
  };
  const written = await writeLedger(paths, {
    ...ledger,
    revision,
    receipts: ledger.receipts.map((entry) => (entry.token === receipt.token ? updated : entry)),
  });
  if (!written.ok) {
    // Files may already be gone; the fenced receipt still blocks writes and a retry finishes.
    return written;
  }

  return ok({ ...statusOf(updated), complete, removed, preserved, residuals });
}
