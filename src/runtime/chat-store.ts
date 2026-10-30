import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { SessionRecord } from "../agents/session-registry.ts";
import { sessionRecordKey } from "../agents/session-snapshot.ts";
import {
  inspectTaskPlanForRetention,
  recheckTaskPlanForRetention,
  deleteTaskPlanForRetention,
} from "../agents/task-plan-store.ts";
import {
  capture,
  CleanupError,
  parseJson,
  StorageError,
  withCleanup,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { chatSessionRecordSchema } from "./protocol.ts";
import { deleteRetainedFile, inspectRetainedFile, sessionExpired } from "./session-retention.ts";
import { privateDirectory } from "./storage.ts";

const id = Type.String({ minLength: 1 });
const defaultsSchema = Type.Object({ provider: id, model: id, effort: Type.Optional(id) });
const indexSchema = Type.Object({
  key: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  id,
  conversationId: id,
  role: Type.Optional(Type.Literal("subagent")),
  name: Type.String(),
  title: Type.String(),
  messageCount: Type.Integer({ minimum: 0 }),
  modified: Type.String(),
  sessionFile: Type.Optional(id),
  cwd: Type.Optional(id),
  lifecycle: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
  managed: Type.Boolean(),
  updatedAt: Type.Integer({ minimum: 0 }),
  closedAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  cleanupPending: Type.Optional(Type.Boolean()),
});
const indexManifestSchema = Type.Object({
  version: Type.Literal(2),
  defaults: Type.Optional(defaultsSchema),
  records: Type.Array(indexSchema),
  tombstones: Type.Array(Type.String({ pattern: "^[a-f0-9]{64}$" })),
});
const legacyManifestSchema = Type.Object({
  version: Type.Literal(1),
  defaults: Type.Optional(defaultsSchema),
  records: Type.Array(chatSessionRecordSchema),
});

export type ChatDefaults = { provider: string; model: string; effort?: string };
export type ChatManifest = { defaults?: ChatDefaults; records: SessionRecord[] };
export type ChatIndex = Static<typeof indexSchema>;

const digest = (record: SessionRecord) =>
  createHash("sha256").update(sessionRecordKey(record)).digest("hex");

// CHAT owns its own indexed snapshots. Closed transcripts are never loaded on startup or
// rewritten at each streaming checkpoint; the index is enough for History summaries.
export class ChatStore {
  private entries = new Map<string, ChatIndex>();
  private legacy = new Map<string, SessionRecord>();
  private tombstones = new Set<string>();
  private defaults: ChatDefaults | undefined;
  private writing: Promise<Result<unknown, ExpectedError>> = Promise.resolve(ok(undefined));
  readonly directory: string;
  readonly sessionDir: string;
  private readonly path: string;

  constructor(daemonDirectory: string) {
    this.directory = join(daemonDirectory, "chat");
    this.sessionDir = join(this.directory, "sdk-sessions");
    this.path = join(this.directory, "conversations.json");
  }

  get manifest(): ChatManifest {
    return {
      ...(this.defaults ? { defaults: this.defaults } : {}),
      records: [...this.legacy.values()],
    };
  }

  listSessions(): readonly ChatIndex[] {
    return [...this.entries.values()].filter(
      (entry) => !entry.cleanupPending && entry.role !== "subagent",
    );
  }

  isExpired(conversationId: string): boolean {
    const key = createHash("sha256")
      .update(JSON.stringify(["chat", conversationId]))
      .digest("hex");
    return this.tombstones.has(key) || this.entries.get(key)?.cleanupPending === true;
  }

  private snapshotPath(key: string): string {
    return join(this.directory, "sessions", `${key}.json`);
  }

  private describe(record: SessionRecord, previous?: ChatIndex): ChatIndex {
    const id = record.state.conversationId ?? record.id;
    const changedAt = Date.now();
    return {
      key: digest(record),
      id: record.id,
      conversationId: id,
      ...(record.role ? { role: record.role } : {}),
      name: record.name,
      title: (
        record.state.sections?.find((section) => section.kind === "user")?.text || record.name
      )
        .replace(/\s+/g, " ")
        .slice(0, 120),
      messageCount:
        record.state.sections?.filter((section) => section.kind !== "thinking").length ?? 0,
      modified: new Date(record.updatedAt ?? changedAt).toISOString(),
      ...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
      ...(record.cwd ? { cwd: record.cwd } : {}),
      lifecycle: record.lifecycle ?? "open",
      managed: record.managed ?? previous?.managed ?? false,
      updatedAt: record.updatedAt ?? changedAt,
      closedAt: record.lifecycle === "closed" ? (record.closedAt ?? changedAt) : null,
    };
  }

  async readSession(conversationId: string): Promise<Result<SessionRecord | null, ExpectedError>> {
    const entry = [...this.entries.values()].find((item) => item.conversationId === conversationId);
    if (!entry || entry.cleanupPending || entry.role === "subagent") return ok(null);
    return this.readRecord(entry);
  }

  private async readRecord(entry: ChatIndex): Promise<Result<SessionRecord, ExpectedError>> {
    const legacy = this.legacy.get(entry.key);
    if (legacy) return ok(legacy);
    const file = await capture(() => readFile(this.snapshotPath(entry.key), "utf8"));
    if (!file.ok) return file;
    const parsed = parseJson(file.value, "CHAT snapshot");
    if (
      !parsed.ok ||
      !Value.Check(chatSessionRecordSchema, parsed.value) ||
      digest(parsed.value) !== entry.key
    ) {
      return err(new StorageError("Invalid CHAT snapshot; original file was not replaced."));
    }
    return ok({
      ...parsed.value,
      lifecycle: entry.lifecycle,
      closedAt: entry.closedAt,
      managed: entry.managed,
    });
  }

  async load(): Promise<Result<ChatManifest, ExpectedError>> {
    const loaded = await capture(() => readFile(this.path, "utf8"));
    if (!loaded.ok) {
      if (loaded.error instanceof StorageError && loaded.error.systemCode === "ENOENT")
        return ok(this.manifest);
      return loaded;
    }
    const parsed = parseJson(loaded.value, "CHAT conversations");
    if (!parsed.ok)
      return err(new StorageError("Invalid CHAT storage; original file was not replaced."));
    if (Value.Check(legacyManifestSchema, parsed.value)) {
      this.defaults = parsed.value.defaults;
      for (const record of parsed.value.records) {
        if (record.cwd && record.cwd !== homedir())
          return err(new StorageError("Invalid CHAT working directory."));
        const entry = this.describe(record);
        if (this.entries.has(entry.key))
          return err(new StorageError("Duplicate CHAT conversation."));
        this.entries.set(entry.key, entry);
        this.legacy.set(entry.key, record);
      }
    } else if (Value.Check(indexManifestSchema, parsed.value)) {
      this.defaults = parsed.value.defaults;
      this.tombstones = new Set(parsed.value.tombstones);
      for (const entry of parsed.value.records) {
        if (entry.cwd && entry.cwd !== homedir())
          return err(new StorageError("Invalid CHAT working directory."));
        if (this.entries.has(entry.key) || this.tombstones.has(entry.key))
          return err(new StorageError("Duplicate or expired CHAT identity."));
        this.entries.set(entry.key, entry);
      }
    } else {
      return err(new StorageError("Invalid CHAT storage; original file was not replaced."));
    }
    if (this.legacy.size) {
      const migrated = await this.save([...this.legacy.values()], this.defaults);
      if (!migrated.ok) return migrated;
    }
    const records: SessionRecord[] = [];
    for (const entry of this.entries.values()) {
      if (entry.lifecycle !== "open" || entry.role === "subagent") continue;
      const body = await this.readRecord(entry);
      if (!body.ok) return body;
      if (body.value.lifecycle !== "closed") records.push(body.value);
    }
    return ok({ ...(this.defaults ? { defaults: this.defaults } : {}), records });
  }

  private async atomicWrite(path: string, text: string): Promise<Result<void, ExpectedError>> {
    return capture(async () => {
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      await withCleanup(
        async () => {
          await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
          await rename(temporary, path);
        },
        () => rm(temporary, { force: true }),
      );
    });
  }

  private publish(
    entries: Map<string, ChatIndex>,
    tombstones = this.tombstones,
    defaults = this.defaults,
  ): Promise<Result<void, ExpectedError>> {
    return this.atomicWrite(
      this.path,
      JSON.stringify({
        version: 2,
        ...(defaults ? { defaults } : {}),
        records: [...entries.values()],
        tombstones: [...tombstones],
      }),
    );
  }

  save(
    records: readonly SessionRecord[],
    defaults = this.defaults,
  ): Promise<Result<void, ExpectedError>> {
    const task = this.writing.then(async () => {
      const next = new Map(this.entries);
      const bodies = new Map<string, SessionRecord>();
      for (const record of records) {
        if (record.scope?.kind !== "chat")
          return err(new StorageError("Only CHAT sessions can be saved in CHAT storage."));
        const key = digest(record);
        if (this.tombstones.has(key)) continue;
        bodies.set(key, record);
        next.set(key, this.describe(record, this.entries.get(key)));
      }
      for (const [key, entry] of this.entries) {
        if (entry.lifecycle !== "open" || bodies.has(key)) continue;
        const prior = await this.readRecord(entry);
        if (!prior.ok) return prior;
        const closed = {
          ...prior.value,
          lifecycle: "closed" as const,
          closedAt: Date.now(),
          updatedAt: Date.now(),
        };
        bodies.set(key, closed);
        next.set(key, this.describe(closed, entry));
      }
      if (bodies.size || this.legacy.size) {
        const prepared = await capture(() => privateDirectory(join(this.directory, "sessions")));
        if (!prepared.ok) return prepared;
      }
      for (const [key, body] of [...this.legacy, ...bodies]) {
        if (this.tombstones.has(key)) continue;
        const existing = this.entries.get(key);
        const index = next.get(key)!;
        if (
          this.legacy.has(key) ||
          !existing ||
          existing.lifecycle !== index.lifecycle ||
          existing.messageCount !== index.messageCount ||
          existing.title !== index.title ||
          existing.modified !== index.modified
        ) {
          const saved = await this.atomicWrite(this.snapshotPath(key), JSON.stringify(body));
          if (!saved.ok) return saved;
        }
      }
      const written = await this.publish(next, this.tombstones, defaults);
      if (written.ok) {
        this.entries = next;
        this.legacy.clear();
        this.defaults = defaults;
      }
      return written;
    });
    this.writing = task;
    return task;
  }

  prune(
    days: number | null,
    reserve: (entry: ChatIndex, canonicalFile?: string) => (() => void) | null = () => () => {},
  ): Promise<Result<number, ExpectedError>> {
    const task = this.writing.then(async () => {
      const expired = [...this.entries.values()].filter(
        (entry) => entry.cleanupPending || sessionExpired(entry, days, Date.now()),
      );
      let removed = 0;
      const failures: ExpectedError[] = [];
      for (const entry of expired) {
        const subpath = entry.sessionFile
          ? relative(this.sessionDir, entry.sessionFile)
          : undefined;
        if (entry.sessionFile && (!subpath || subpath.startsWith("..") || isAbsolute(subpath))) {
          failures.push(
            new StorageError("Retention refused a CHAT SDK file outside its owned directory."),
          );
          continue;
        }
        const inspected = await inspectRetainedFile({
          ...entry,
          conversationId: entry.conversationId,
          scope: { kind: "chat" },
        });
        if (!inspected.ok) {
          failures.push(inspected.error);
          continue;
        }
        if (inspected.value.kind === "changed") {
          if (entry.cleanupPending) {
            failures.push(
              new StorageError(
                "A CHAT session changed during interrupted retention; manual recovery is required.",
              ),
            );
          }
          continue;
        }
        const owner = { conversationId: entry.conversationId, cwd: homedir() };
        const plan = entry.sessionFile
          ? await inspectTaskPlanForRetention(entry.sessionFile, owner)
          : ok({ kind: "absent" as const });
        if (!plan.ok) {
          failures.push(plan.error);
          continue;
        }
        if (
          plan.value.kind === "ready" &&
          plan.value.updatedAt > entry.updatedAt &&
          !entry.cleanupPending
        )
          continue;
        const release = reserve(
          entry,
          inspected.value.kind === "ready" ? inspected.value.path : undefined,
        );
        if (!release) continue;
        try {
          if (!entry.cleanupPending) {
            const marked = new Map(this.entries);
            marked.set(entry.key, { ...entry, cleanupPending: true });
            const published = await this.publish(marked);
            if (!published.ok) {
              failures.push(published.error);
              continue;
            }
            this.entries = marked;
          }
          if (entry.sessionFile) {
            const checked = await recheckTaskPlanForRetention(entry.sessionFile, owner, plan.value);
            if (!checked.ok) {
              if (!entry.cleanupPending) {
                const restored = new Map(this.entries);
                restored.set(entry.key, entry);
                const reset = await this.publish(restored);
                if (reset.ok) this.entries = restored;
                else failures.push(reset.error);
              }
              failures.push(checked.error);
              continue;
            }
          }
          const deleted = await deleteRetainedFile(inspected.value);
          if (!deleted.ok) {
            if (!entry.cleanupPending && deleted.error.code === "HISTORY_UNAVAILABLE") {
              const restored = new Map(this.entries);
              restored.set(entry.key, entry);
              const reset = await this.publish(restored);
              if (reset.ok) this.entries = restored;
              else failures.push(reset.error);
            }
            failures.push(deleted.error);
            continue;
          }
          if (entry.sessionFile) {
            const sidecar = await deleteTaskPlanForRetention(entry.sessionFile, owner, plan.value);
            if (!sidecar.ok) {
              failures.push(sidecar.error);
              continue;
            }
          }
          const body = await capture(() => rm(this.snapshotPath(entry.key), { force: true }));
          if (!body.ok) {
            failures.push(body.error);
            continue;
          }
          const next = new Map(this.entries);
          next.delete(entry.key);
          const tombstones = new Set(this.tombstones);
          tombstones.add(entry.key);
          const saved = await this.publish(next, tombstones);
          if (!saved.ok) {
            failures.push(saved.error);
            continue;
          }
          this.entries = next;
          this.tombstones = tombstones;
          this.legacy.delete(entry.key);
          removed++;
        } finally {
          release();
        }
      }
      return failures.length
        ? err(
            new CleanupError(
              "CHAT retention could not verify all expired conversations.",
              failures,
            ),
          )
        : ok(removed);
    });
    this.writing = task;
    return task;
  }
}
