import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { manifestSchema, sessionRecordSchema, type RuntimeManifest } from "./protocol.ts";
import type { SessionRecord } from "../agents/session-registry.ts";
import { sessionRecordKey, type SessionSnapshotInfo, type SessionSnapshotSource } from "../agents/session-snapshot.ts";
import { capture, CleanupError, parseJson, StorageError, withCleanup, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { deleteRetainedFile, inspectRetainedFile, removeRetentionFile, sessionExpired } from "./session-retention.ts";

export type RuntimePaths = { directory: string; socket: string; lock: string; log: string; manifest: string };

export function runtimePaths(repositoryId: string, offline: boolean, stateRoot = process.env.RADIAN_STATE_DIR ?? join(homedir(), ".radian")): RuntimePaths {
  const key = createHash("sha256").update(`${resolve(stateRoot)}\0${repositoryId}\0${offline}`).digest("hex").slice(0, 32);
  const directory = join(resolve(stateRoot), "workspaces", key);
  // Keep the address below macOS's Unix socket path limit, even with long state-directory names.
  const endpoint = join("/tmp", `radian-${process.getuid?.() ?? "user"}`);
  return { directory, socket: join(endpoint, `${key}.sock`), lock: join(endpoint, `${key}.lock`),
    log: join(directory, "runtime.log"), manifest: join(directory, "workspace.json") };
}

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw new StorageError(`Runtime directory is not owned by this user: ${path}`);
  }
  await chmod(path, 0o700);
}

const snapshotIndexSchema = Type.Object({
  key: Type.String({ pattern: "^[a-f0-9]{64}$" }), revision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  id: sessionRecordSchema.properties.id, name: Type.String(), worktreeId: sessionRecordSchema.properties.worktreeId,
  conversationId: Type.Optional(sessionRecordSchema.properties.id), sessionFile: sessionRecordSchema.properties.sessionFile,
  cwd: sessionRecordSchema.properties.cwd, closedAt: sessionRecordSchema.properties.closedAt, managed: sessionRecordSchema.properties.managed,
  cleanupPending: Type.Optional(Type.Boolean()), expiredAt: sessionRecordSchema.properties.updatedAt, lifecycle: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
  updatedAt: Type.Integer({ minimum: 0, maximum: 8640000000000000 }), title: Type.String(), messageCount: Type.Integer({ minimum: 0 }),
});
const storedManifestSchema = Type.Object({ ...manifestSchema.properties, storageVersion: Type.Literal(2), records: Type.Array(snapshotIndexSchema) });
type SnapshotIndex = Static<typeof snapshotIndexSchema>;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const snapshotKey = (record: SessionRecord) => digest(sessionRecordKey(record));

// One shared session record per conversation. The workspace file holds only a small index;
// closed bodies stay on disk and are read lazily by History, never instantiated for recovery.
export class RuntimeStore implements SessionSnapshotSource {
  private tail: Promise<Result<unknown, ExpectedError>> = Promise.resolve(ok(undefined));
  private entries = new Map<string, SnapshotIndex>();
  private readonly legacy = new Map<string, SessionRecord>();
  private initialized = false;
  private repositoryId: string | undefined;
  private metadata: Omit<RuntimeManifest, "records"> | undefined;
  constructor(readonly paths: RuntimePaths) {}

  listSessions(worktreeId: string): readonly SessionSnapshotInfo[] {
    return [...this.entries.values()].filter(entry => entry.worktreeId === worktreeId && !entry.cleanupPending && entry.expiredAt === undefined);
  }
  async readSession(worktreeId: string, conversationId: string): Promise<Result<SessionRecord | null, ExpectedError>> {
    const entry = [...this.entries.values()].find(entry => entry.worktreeId === worktreeId && (entry.conversationId ?? entry.id) === conversationId);
    return entry && !entry.cleanupPending && entry.expiredAt === undefined ? this.readRecord(entry) : ok(null);
  }
  isExpired(worktreeId: string, conversationId: string): boolean {
    const entry = this.entries.get(digest(JSON.stringify([worktreeId, conversationId])));
    return !!entry && (!!entry.cleanupPending || entry.expiredAt !== undefined);
  }
  private async readRecord(entry: SnapshotIndex): Promise<Result<SessionRecord, ExpectedError>> {
    const legacy = this.legacy.get(entry.key); if (legacy) return ok(legacy);
    const read = await capture(() => readFile(join(this.paths.directory, "sessions", `${entry.key}.json`), "utf8"));
    if (!read.ok) return read;
    const parsed = parseJson(read.value, "session snapshot");
    if (!parsed.ok) return err(new StorageError("Invalid session snapshot; original file was not replaced.", undefined, { cause: parsed.error }));
    if (!Value.Check(sessionRecordSchema, parsed.value) || snapshotKey(parsed.value) !== entry.key) return err(new StorageError("Invalid or mismatched session snapshot."));
    const lifecycle = entry.lifecycle === "closed" || parsed.value.lifecycle === "closed" ? "closed" : "open";
    return ok({ ...parsed.value, lifecycle, managed: parsed.value.managed ?? entry.managed ?? false,
      closedAt: lifecycle === "open" ? null : parsed.value.closedAt ?? entry.closedAt ?? null });
  }

  async load(repositoryId: string): Promise<Result<RuntimeManifest | null, ExpectedError>> {
    const read = await capture(() => readFile(this.paths.manifest, "utf8"));
    if (!read.ok) {
      if (!(read.error instanceof StorageError) || read.error.systemCode !== "ENOENT") return read;
      this.entries.clear(); this.legacy.clear(); this.metadata = undefined; this.initialized = true; this.repositoryId = repositoryId; return ok(null);
    }
    const parsed = parseJson(read.value, "runtime manifest");
    if (!parsed.ok) return err(new StorageError("Invalid runtime manifest; original file was not replaced.", undefined, { cause: parsed.error }));
    const value = parsed.value;
    const indexed = value !== null && typeof value === "object" && "storageVersion" in value;
    if (indexed) {
      if (!Value.Check(storedManifestSchema, value)) return err(new StorageError("Invalid runtime manifest; original file was not replaced."));
      if (value.repositoryId !== repositoryId) return err(new StorageError("Runtime manifest belongs to another repository."));
      const entries = new Map<string, SnapshotIndex>();
      for (const entry of value.records) {
        if (entry.key !== digest(JSON.stringify([entry.worktreeId, entry.conversationId ?? entry.id])) || entries.has(entry.key)) return err(new StorageError("Invalid session snapshot index."));
        entries.set(entry.key, { ...entry, closedAt: entry.lifecycle === "open" ? null : entry.closedAt ?? Date.now() });
      }
      this.entries = entries; this.legacy.clear();
      const records: SessionRecord[] = [];
      for (const entry of entries.values()) if (entry.lifecycle === "open") {
        const record = await this.readRecord(entry); if (!record.ok) return record;
        // A close written before an interrupted index update must never reopen a conversation.
        if (record.value.lifecycle !== "closed") records.push(record.value);
      }
      this.initialized = true; this.repositoryId = repositoryId;
      this.metadata = { version: value.version, repositoryId, repositories: value.repositories, preferences: value.preferences };
      return ok({ ...this.metadata, records });
    }
    if (!Value.Check(manifestSchema, value) || value.repositoryId !== repositoryId) return err(new StorageError("Invalid runtime manifest; original file was not replaced."));
    this.entries.clear(); this.legacy.clear();
    for (const record of value.records) {
      const normalized = this.normalize(record);
      const entry = this.describe(normalized); this.entries.set(entry.key, entry); this.legacy.set(entry.key, normalized);
    }
    this.initialized = true; this.repositoryId = repositoryId;
    const { records: _records, ...metadata } = value; this.metadata = metadata;
    return ok({ ...metadata, records: value.records.filter(record => record.lifecycle !== "closed").map(record => this.normalize(record)) });
  }

  private normalize(record: SessionRecord, previous?: SnapshotIndex): SessionRecord {
    const lifecycle = record.lifecycle ?? "open";
    return { ...record, lifecycle, managed: record.managed ?? previous?.managed ?? false,
      closedAt: lifecycle === "open" ? null : record.closedAt ?? previous?.closedAt ?? Date.now() };
  }
  private describe(record: SessionRecord, previous?: SnapshotIndex): SnapshotIndex {
    const { updatedAt: _updatedAt, ...data } = record;
    const revision = digest(JSON.stringify({ ...data, lifecycle: data.lifecycle ?? "open" }));
    const title = (record.state.sections?.find(section => section.kind === "user")?.text || record.name || "Untitled session").replace(/\s+/g, " ").slice(0, 120);
    return { key: snapshotKey(record), revision, id: record.id, name: record.name, worktreeId: record.worktreeId,
      ...(record.state.conversationId ? { conversationId: record.state.conversationId } : {}), ...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
      ...(record.cwd ? { cwd: record.cwd } : {}), lifecycle: record.lifecycle ?? "open", managed: record.managed ?? false, closedAt: record.closedAt ?? null,
      updatedAt: previous?.revision === revision ? previous.updatedAt : record.updatedAt ?? Date.now(), title,
      messageCount: record.state.sections?.filter(section => section.kind !== "thinking").length ?? 0 };
  }

  save(manifest: RuntimeManifest): Promise<Result<void, ExpectedError>> {
    const task = this.tail.then(() => this.saveNext(manifest));
    // Expected failures are values: later writes may recover. Unknown exceptions stay rejected.
    this.tail = task; return task;
  }
  private async saveNext(manifest: RuntimeManifest): Promise<Result<void, ExpectedError>> {
    if (!this.initialized) { const loaded = await this.load(manifest.repositoryId); if (!loaded.ok) return loaded; }
    if (this.repositoryId !== manifest.repositoryId) return err(new StorageError("Cannot save a different repository into this runtime store."));
    const incoming = new Map(manifest.records.filter(record => record.lifecycle !== "closed" || !this.isExpired(record.worktreeId, record.state.conversationId ?? record.id))
      .map(record => [snapshotKey(record), this.normalize(record, this.entries.get(snapshotKey(record)))]));
    // Old manifests may know only the tab ID. Adopt the SDK identity learned during restore,
    // rather than archiving a duplicate of that same conversation under the old tab key.
    const adopted = new Set([...this.entries.values()].filter(entry => !entry.conversationId && [...incoming.values()].some(record =>
      record.state.conversationId && record.worktreeId === entry.worktreeId && record.id === entry.id && record.sessionFile === entry.sessionFile)).map(entry => entry.key));
    // Missing open records become closed, not deleted; ordinary checkpoints never rewrite old closed bodies.
    for (const entry of this.entries.values()) if (!incoming.has(entry.key) && !adopted.has(entry.key) && entry.lifecycle === "open") {
      const record = await this.readRecord(entry); if (!record.ok) return record;
      incoming.set(entry.key, { ...record.value, lifecycle: "closed", closedAt: record.value.closedAt ?? Date.now(), updatedAt: Date.now() });
    }
    for (const [key, record] of this.legacy) if (!incoming.has(key) && !adopted.has(key)) incoming.set(key, record);
    const next = new Map(this.entries);
    for (const key of adopted) next.delete(key);
    const saved = await capture(async () => {
      if (incoming.size) await privateDirectory(join(this.paths.directory, "sessions"));
      for (const [key, record] of incoming) {
        const entry = this.describe(record, this.entries.get(key));
        if (this.legacy.has(key) || entry.revision !== this.entries.get(key)?.revision) {
          await atomicWrite(join(this.paths.directory, "sessions", `${key}.json`), JSON.stringify({ ...record, lifecycle: entry.lifecycle, updatedAt: entry.updatedAt }));
        }
        next.set(key, entry);
      }
      await atomicWrite(this.paths.manifest, JSON.stringify({ ...manifest, storageVersion: 2, records: [...next.values()] }));
    });
    if (!saved.ok) return saved;
    this.entries = next; this.legacy.clear();
    const { records: _records, ...metadata } = manifest; this.metadata = metadata;
    return ok(undefined);
  }

  pruneExpired(days: number | null, reserve: (snapshot: SessionSnapshotInfo, canonicalFile?: string) => (() => void) | null, now = Date.now()): Promise<Result<number, ExpectedError>> {
    const task = this.tail.then(() => this.pruneNext(days, reserve, now)); this.tail = task; return task;
  }
  private async publishIndex(next: Map<string, SnapshotIndex>): Promise<Result<void, ExpectedError>> {
    if (!this.metadata) return ok(undefined);
    const saved = await capture(() => atomicWrite(this.paths.manifest, JSON.stringify({ ...this.metadata, storageVersion: 2, records: [...next.values()] })));
    if (saved.ok) this.entries = next;
    return saved;
  }
  private async pruneNext(days: number | null, reserve: (snapshot: SessionSnapshotInfo, canonicalFile?: string) => (() => void) | null, now: number): Promise<Result<number, ExpectedError>> {
    if (!this.initialized || !this.metadata) return ok(0);
    let removed = 0;
    const failures: ExpectedError[] = [];
    for (const entry of [...this.entries.values()]) {
      if (!entry.cleanupPending && (entry.expiredAt !== undefined || !sessionExpired(entry, days, now))) continue;
      const result = await this.pruneEntry(entry, reserve, now);
      if (result.ok) removed += result.value; else failures.push(result.error);
    }
    return failures.length ? err(new CleanupError("Session retention cleanup partially failed; unverified files were preserved.", failures)) : ok(removed);
  }
  private async pruneEntry(entry: SnapshotIndex, reserve: (snapshot: SessionSnapshotInfo, canonicalFile?: string) => (() => void) | null, now: number): Promise<Result<number, ExpectedError>> {
    if (entry.managed !== true || entry.lifecycle !== "closed" || entry.closedAt == null) return ok(0);
    if (!entry.cleanupPending) {
      const record = await this.readRecord(entry); if (!record.ok) return record;
      if (record.value.managed !== true || record.value.closedAt !== entry.closedAt || record.value.updatedAt !== entry.updatedAt) return ok(0);
    }
    const inspected = await inspectRetainedFile(entry); if (!inspected.ok) return inspected;
    if (inspected.value.kind === "changed") return ok(0);
    const release = reserve(entry, inspected.value.kind === "ready" ? inspected.value.path : undefined);
    if (!release) return ok(0);
    try {
      // A durable marker hides the record from JSONL fallback and lets an interrupted deletion finish.
      const pending = { ...entry, cleanupPending: true };
      if (!entry.cleanupPending) {
        const marked = new Map(this.entries); marked.set(entry.key, pending);
        const saved = await this.publishIndex(marked); if (!saved.ok) return saved;
      }
      const deleted = await deleteRetainedFile(inspected.value);
      if (!deleted.ok) {
        if (deleted.error.code === "HISTORY_UNAVAILABLE" && !entry.cleanupPending) {
          // The fingerprint check proves deletion did not start. Restore visibility for a changed external file.
          const restored = new Map(this.entries); restored.set(entry.key, entry);
          const saved = await this.publishIndex(restored);
          if (!saved.ok) return err(new CleanupError("Could not clear an interrupted retention marker.", [deleted.error, saved.error]));
        }
        return deleted;
      }
      const snapshot = await removeRetentionFile(join(this.paths.directory, "sessions", `${entry.key}.json`));
      if (!snapshot.ok) return snapshot;
      // Keep only a small, redacted identity marker so stale checkpoints cannot resurrect expired data.
      const { sessionFile: _file, cwd: _cwd, ...identity } = pending;
      const finished = new Map(this.entries);
      finished.set(entry.key, { ...identity, name: "", title: "", messageCount: 0, cleanupPending: false, expiredAt: now });
      const saved = await this.publishIndex(finished); if (!saved.ok) return saved;
      return ok(1);
    } finally { release(); }
  }
}

async function atomicWrite(path: string, text: string): Promise<void> {
  const temporary = path + "." + crypto.randomUUID() + ".tmp";
  await withCleanup(async () => {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  }, () => rm(temporary, { force: true }));
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
      try { await link(temporary, paths.lock); claimed = true; break; }
      catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        let existing: unknown;
        try { existing = await readOwner(paths.lock); }
        catch (readError) { if (hasCode(readError, "ENOENT")) continue; throw readError; }
        if (!isOwner(existing)) throw new StorageError("Invalid runtime ownership file; refusing to remove it.");
        if (pidAlive(existing.pid)) return null;
        // Serialize stale-owner recovery so two launchers cannot unlink each other's new lock.
        const recovery = paths.lock + ".recovery";
        try { await link(temporary, recovery); }
        catch (recoveryError) { if (hasCode(recoveryError, "EEXIST")) return null; throw recoveryError; }
        try {
          let current: unknown;
          try { current = await readOwner(paths.lock); }
          catch (readError) { if (!hasCode(readError, "ENOENT")) throw readError; }
          if (isOwner(current) && pidAlive(current.pid)) return null;
          await rm(paths.lock, { force: true });
          try { await link(temporary, paths.lock); }
          catch (claimError) { if (hasCode(claimError, "EEXIST")) return null; throw claimError; }
          claimed = true;
          break;
        } finally { await rm(recovery, { force: true }); }
      }
    }
    if (!claimed) throw new StorageError("Runtime ownership changed repeatedly; try connecting again.");
    await rm(paths.socket, { force: true });
    return async () => {
      let current: unknown;
      try { current = await readOwner(paths.lock); }
      catch (error) { if (hasCode(error, "ENOENT")) return; throw error; }
      if (isOwner(current) && current.token === token) {
        await rm(paths.socket, { force: true });
        await rm(paths.lock, { force: true });
      }
    };
  } finally { await rm(temporary, { force: true }); }
}

async function readOwner(path: string): Promise<unknown> {
  const parsed = parseJson(await readFile(path, "utf8"), "runtime ownership");
  if (!parsed.ok) throw new StorageError("Invalid runtime ownership file; refusing to remove it.", undefined, { cause: parsed.error });
  return parsed.value;
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (hasCode(error, "ESRCH")) return false; throw error; }
}
function isOwner(value: unknown): value is { pid: number; token: string } {
  return !!value && typeof value === "object" && "pid" in value && Number.isInteger(value.pid) && Number(value.pid) > 0
    && "token" in value && typeof value.token === "string";
}
function hasCode(error: unknown, code: string): boolean { return !!error && typeof error === "object" && "code" in error && error.code === code; }
