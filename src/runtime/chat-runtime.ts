import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import { loadSessionSettings } from "../app/settings.ts";
import type { AccountManager } from "../accounts/manager.ts";
import { piSessionFactory, type PiSessionOptions } from "../agents/pi-session-adapter.ts";
import { offlineRuntime } from "../testing/offline-runtime.ts";
import {
  SessionRegistry,
  validateHistory,
  type SessionRecord,
} from "../agents/session-registry.ts";
import { previewSessionSnapshot, readHistoryPreview } from "../agents/history-preview.ts";
import { CHAT_SCOPE_ID } from "../agents/session-scope.ts";
import { sessionRecordKey } from "../agents/session-snapshot.ts";
import {
  CancelledError,
  capture,
  collectCleanup,
  HistoryError,
  InputError,
  parseJson,
  SessionError,
  StorageError,
  reportUnexpected,
  withCleanup,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { RepositoryCatalog } from "../workspace/catalog.ts";
import { ChatStore, type ChatDefaults } from "./chat-store.ts";
import { RetentionScheduler } from "./session-retention.ts";
import { privateDirectory } from "./storage.ts";
import type {
  ChatCollection,
  ChatHistoryItem,
  ChatHistoryPreview,
  RuntimeCommand,
} from "./protocol.ts";

export class ChatRuntime {
  readonly registry: SessionRegistry;
  readonly store: ChatStore;
  private readonly subscribers = new Set<() => void>();
  private readonly failed = new Map<string, SessionRecord>();
  private checkpointTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<Result<void, ExpectedError>> = Promise.resolve(ok(undefined));
  private initializing = true;
  private stopped = false;
  private defaults: ChatDefaults | undefined;
  private revision = 0;
  private historyMembership = "";
  private warning = "";
  private readonly unsubscribe: () => void;
  private retention: RetentionScheduler | undefined;

  private constructor(
    daemonDirectory: string,
    private readonly accounts: AccountManager,
    options: PiSessionOptions,
  ) {
    this.store = new ChatStore(daemonDirectory);
    // No repository is registered or synthesized for CHAT. The registry's CHAT scope
    // supplies homedir to the SDK and shares one executor per conversation across clients.
    this.registry = new SessionRegistry(
      new RepositoryCatalog([]),
      piSessionFactory({
        ...options,
        sessionDir: this.store.sessionDir,
        ...(options.streamFn ? {} : { accounts }),
        chatDefaults: () => this.defaults,
      }),
      "chat",
    );
    this.unsubscribe = this.registry.subscribe(() => this.changed());
  }

  static async open(
    directory: string,
    accounts: AccountManager,
    offline: boolean,
  ): Promise<Result<ChatRuntime, ExpectedError>> {
    const canonicalDirectory = await capture(() => realpath(directory));
    if (!canonicalDirectory.ok) return canonicalDirectory;
    const options = offline
      ? await offlineRuntime(`${canonicalDirectory.value}/chat/offline-agent`)
      : {};
    const runtime = new ChatRuntime(canonicalDirectory.value, accounts, options);
    const prepared = await capture(() => privateDirectory(runtime.store.sessionDir));
    if (!prepared.ok) return prepared;
    const loaded = await runtime.store.load();
    if (!loaded.ok) return loaded;
    runtime.defaults = loaded.value.defaults;
    for (const record of loaded.value.records) {
      const restored = await runtime.registry.restore(record);
      if (!restored.ok) {
        runtime.failed.set(record.id, {
          ...record,
          state: {
            ...record.state,
            status: "failure",
            error: `Could not restore: ${restored.error.message}`,
          },
        });
      }
    }
    runtime.initializing = false;
    return ok(runtime);
  }

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  get snapshot(): ChatCollection {
    const records = [...this.registry.records, ...this.failed.values()];
    return {
      id: CHAT_SCOPE_ID,
      path: homedir(),
      name: "CHAT",
      sessions: [
        ...this.registry.chatSessions,
        ...[...this.failed.values()].map((record) => ({
          id: record.id,
          name: record.name,
          status: record.state.status,
          subagents: record.subagents,
          ...(record.state.request ? { request: record.state.request } : {}),
          ...(record.state.result ? { result: record.state.result } : {}),
          ...(record.state.attention ? { attention: record.state.attention } : {}),
        })),
      ],
      details: Object.fromEntries(records.map((record) => [record.id, record.state])),
      historyRevision: this.revision,
      accountsRevision: this.accounts.revision,
      closingCount: this.registry.closingCount,
    };
  }

  startRetention(configPath?: string): void {
    if (this.retention) return;
    this.retention = new RetentionScheduler(
      async () => {
        const settings = await loadSessionSettings(configPath);
        if (!settings.ok) return settings;
        return this.store.prune(settings.value.retentionDays, (entry, file) =>
          this.stopped
            ? null
            : this.registry.reserveSnapshotCleanup({ ...entry, scope: { kind: "chat" } }, file),
        );
      },
      (result) => {
        if (!result.ok) this.warning = `CHAT retention failed: ${result.error.message}`;
        if (result.ok && result.value > 0) this.changed();
      },
      (error) => {
        this.warning = reportUnexpected(error, "CHAT retention");
      },
    );
    void this.retention.start().catch((error) => {
      this.warning = reportUnexpected(error, "CHAT retention startup");
    });
  }

  get notice(): string {
    return this.warning;
  }
  get extensionUi() {
    return this.registry.extensionUi;
  }

  private changed(): void {
    const membership = JSON.stringify(
      this.snapshot.sessions.map((session) => [
        session.id,
        session.name,
        session.request?.text,
        session.status === "working",
        session.result?.id,
      ]),
    );
    if (membership !== this.historyMembership) {
      this.historyMembership = membership;
      this.revision++;
    }
    for (const subscriber of this.subscribers) subscriber();
    if (this.initializing || this.stopped || this.checkpointTimer) return;
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = undefined;
      void this.checkpoint()
        .then((result) => {
          if (!result.ok) this.warning = `CHAT persistence failed: ${result.error.message}`;
        })
        .catch((error) => {
          this.warning = reportUnexpected(error, "CHAT checkpoint");
        });
    }, 100);
  }

  private checkpoint(
    records = [...this.registry.checkpointRecords, ...this.failed.values()],
  ): Promise<Result<void, ExpectedError>> {
    const task = this.saving.then(() => this.store.save(records, this.defaults));
    this.saving = task;
    void task.then((result) => {
      if (result.ok) {
        this.registry.acknowledgeCheckpoint(records);
        this.warning = "";
      }
    });
    return task;
  }

  async create(): Promise<Result<string, ExpectedError>> {
    return this.registry.createChat();
  }

  private async discovered(
    signal?: AbortSignal,
  ): Promise<Result<readonly ChatHistoryItem[], ExpectedError>> {
    if (signal?.aborted) return err(new CancelledError());
    // The directory is Radian-owned. Its index, not SDK transcript discovery, is the
    // summary authority; archived bodies are opened only for the selected conversation.
    const byId = new Map<string, ChatHistoryItem>();
    for (const index of this.store.listSessions()) {
      const owner = index.sessionFile
        ? this.registry.historyOwnership(index.sessionFile)
        : { openSessionId: null, unavailableReason: null };
      byId.set(index.conversationId, {
        id: index.conversationId,
        title: index.title,
        modified: index.modified,
        messageCount: index.messageCount,
        revision: `${index.updatedAt}:${index.lifecycle}`,
        ...owner,
      });
    }
    for (const record of [...this.registry.checkpointRecords, ...this.failed.values()]) {
      const id = record.state.conversationId ?? record.id;
      if (record.role === "subagent" || this.store.isExpired(id)) continue;
      const owner = record.sessionFile
        ? this.registry.historyOwnership(record.sessionFile)
        : { openSessionId: null, unavailableReason: null };
      byId.set(id, {
        id,
        title:
          record.state.sections
            ?.find((section) => section.kind === "user")
            ?.text.replace(/\s+/g, " ")
            .slice(0, 120) ?? record.name,
        modified: new Date(record.updatedAt ?? Date.now()).toISOString(),
        messageCount: record.state.sections?.length ?? 0,
        ...(record.updatedAt !== undefined
          ? { revision: `${record.updatedAt}:${record.lifecycle}` }
          : {}),
        openSessionId: record.lifecycle === "open" ? record.id : owner.openSessionId,
        unavailableReason: owner.unavailableReason,
      });
    }
    return ok([...byId.values()].sort((a, b) => b.modified.localeCompare(a.modified)));
  }

  listHistory(signal?: AbortSignal): Promise<Result<readonly ChatHistoryItem[], ExpectedError>> {
    return this.discovered(signal);
  }

  private async historyFile(savedId: string): Promise<Result<string, ExpectedError>> {
    if (this.store.isExpired(savedId)) {
      return err(new HistoryError("HISTORY_UNAVAILABLE", "CHAT conversation has expired."));
    }
    const found =
      this.registry.checkpointRecords.find(
        (record) =>
          record.role !== "subagent" && (record.state.conversationId ?? record.id) === savedId,
      ) ?? this.store.listSessions().find((entry) => entry.conversationId === savedId);
    if (!found?.sessionFile || found.cwd !== homedir())
      return err(new HistoryError("HISTORY_UNAVAILABLE", "CHAT conversation is not available."));
    const canonical = await capture(() => realpath(found.sessionFile!));
    if (!canonical.ok) return canonical;
    const subpath = relative(this.store.sessionDir, canonical.value);
    if (!subpath || subpath.startsWith("..") || isAbsolute(subpath)) {
      return err(
        new HistoryError(
          "HISTORY_UNAVAILABLE",
          "CHAT saved session is outside its owned directory.",
        ),
      );
    }
    const owner = this.registry.historyOwnership(canonical.value);
    if (owner.unavailableReason)
      return err(new SessionError("SESSION_CONFLICT", owner.unavailableReason));
    // Validate only the chosen SDK header, even when its cached Radian preview is current.
    const inspected = await capture(async () => {
      const file = await open(canonical.value, "r");
      return withCleanup(
        async () => {
          const buffer = Buffer.alloc(65536);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          const header = parseJson(
            buffer
              .subarray(0, bytesRead)
              .toString("utf8")
              .split("\n")
              .find((line) => line.trim()) ?? "",
            "CHAT session header",
          );
          if (!header.ok) return header;
          const value = header.value;
          if (
            !value ||
            typeof value !== "object" ||
            !("type" in value) ||
            value.type !== "session" ||
            !("id" in value) ||
            value.id !== savedId ||
            !("cwd" in value) ||
            value.cwd !== homedir()
          ) {
            return err(
              new HistoryError(
                "HISTORY_UNAVAILABLE",
                "CHAT saved session identity or working directory changed.",
              ),
            );
          }
          return ok(canonical.value);
        },
        () => file.close(),
      );
    });
    return inspected.ok ? inspected.value : inspected;
  }

  async previewHistory(
    savedId: string,
    signal?: AbortSignal,
  ): Promise<Result<ChatHistoryPreview, ExpectedError>> {
    if (signal?.aborted) return err(new CancelledError());
    if (this.store.isExpired(savedId)) {
      return err(new HistoryError("HISTORY_UNAVAILABLE", "CHAT conversation has expired."));
    }
    const live = this.registry.checkpointRecords.find(
      (record) =>
        record.role !== "subagent" && (record.state.conversationId ?? record.id) === savedId,
    );
    const stored = live ? ok(live) : await this.store.readSession(savedId);
    if (!stored.ok) return stored;
    const record = stored.value;
    if (record) {
      const original = record.sessionFile
        ? await capture(() => stat(record.sessionFile!))
        : undefined;
      if (
        original &&
        !original.ok &&
        !(original.error instanceof StorageError && original.error.systemCode === "ENOENT")
      )
        return original;
      if (original?.ok) {
        const verified = await this.historyFile(savedId);
        if (!verified.ok) return verified;
      }
      if (
        !original?.ok ||
        record.updatedAt === undefined ||
        Math.floor(Math.max(original.value.mtimeMs, original.value.ctimeMs)) <= record.updatedAt
      ) {
        const { worktreeId: _scope, ...preview } = previewSessionSnapshot(record, savedId);
        return ok(preview);
      }
    }
    const file = await this.historyFile(savedId);
    if (!file.ok) return file;
    const read = await readHistoryPreview(file.value, CHAT_SCOPE_ID, savedId, signal, {
      cwd: homedir(),
      requireCwd: true,
    });
    if (!read.ok) return read;
    const { worktreeId: _scope, ...preview } = read.value;
    return ok(preview);
  }

  async resume(savedId: string): Promise<Result<string, ExpectedError>> {
    const listed = await this.discovered();
    if (!listed.ok) return listed;
    const item = listed.value.find((entry) => entry.id === savedId);
    if (!item)
      return err(new HistoryError("HISTORY_UNAVAILABLE", "CHAT conversation is not available."));
    if (item.openSessionId) return ok(item.openSessionId);
    if (item.unavailableReason)
      return err(new SessionError("SESSION_CONFLICT", item.unavailableReason));
    const file = await this.historyFile(savedId);
    if (!file.ok) return file;
    const valid = await validateHistory(file.value);
    if (!valid.ok) return valid;
    return this.registry.createChat(file.value, {
      name: item.title,
      id: crypto.randomUUID(),
      managed: true,
    });
  }

  async selectModel(
    sessionId: string,
    conversationId: string,
    model: { provider: string; id: string },
    effort?: string,
  ) {
    const selected = await this.registry.selectModel(
      sessionId,
      conversationId,
      model,
      effort as Parameters<SessionRegistry["selectModel"]>[3],
    );
    if (!selected.ok) return selected;
    this.defaults = { provider: model.provider, model: model.id, ...(effort ? { effort } : {}) };
    this.changed();
    if (this.checkpointTimer) {
      clearTimeout(this.checkpointTimer);
      this.checkpointTimer = undefined;
    }
    const saved = await this.checkpoint();
    return saved.ok
      ? selected
      : ok(
          `[${saved.error.code}] CHAT model applied, but its default selection could not be saved. Keep this daemon running and reconnect before retrying.`,
        );
  }

  async command(command: RuntimeCommand): Promise<Result<string | null, ExpectedError>> {
    const id = "sessionId" in command ? command.sessionId : undefined;
    switch (command.type) {
      case "chat-create":
        return this.create();
      case "chat-resume":
        return this.resume(command.savedId);
      case "close": {
        const result = await this.close(command.sessionId);
        return result.ok ? ok(null) : result;
      }
      case "extension-ui-response": {
        const result = this.registry.answerExtensionUi(
          command.sessionId,
          command.conversationId,
          command.response,
        );
        return result.ok ? ok(null) : result;
      }
      case "acknowledge": {
        const result = this.registry.acknowledge(
          command.sessionId,
          command.conversationId,
          command.resultId,
        );
        return result.ok ? ok(null) : result;
      }
      case "model-select":
        return this.selectModel(
          command.sessionId,
          command.conversationId,
          command.model,
          command.effort,
        );
      case "interrupt": {
        const state = this.registry.details(command.sessionId);
        if (state?.conversationId !== command.conversationId)
          return err(
            new SessionError("SESSION_CONFLICT", "Conversation changed; no interrupt was sent."),
          );
        const accepted = Promise.withResolvers<Result<void, ExpectedError>>();
        let admitted = false;
        const run = this.registry.interrupt(command.sessionId, () => {
          admitted = true;
          accepted.resolve(ok(undefined));
        });
        void run.then(
          (result) => {
            if (!admitted) accepted.resolve(result);
          },
          (error) => accepted.reject(error),
        );
        const result = await accepted.promise;
        return result.ok ? ok(null) : result;
      }
      case "session-control":
        return this.control(
          command.sessionId,
          command.conversationId,
          command.action,
          command.instructions,
        );
      case "prompt": {
        const state = this.registry.details(command.sessionId);
        if (!state)
          return err(new SessionError("SESSION_NOT_OPEN", "CHAT conversation is not open."));
        if (command.conversationId && state.conversationId !== command.conversationId)
          return err(
            new SessionError("SESSION_CONFLICT", "Conversation changed; input was retained."),
          );
        if (
          command.resourceRevision !== undefined &&
          command.resourceRevision !== (state.resourceRevision ?? 0)
        )
          return err(
            new SessionError("SESSION_CONFLICT", "Resources changed; input was retained."),
          );
        const { parseSessionControl } = await import("../agents/session-controls.ts");
        const control = parseSessionControl(command.text);
        if (!control.ok) return control;
        if (control.value) {
          if (command.images?.length)
            return err(new InputError("Session commands do not accept attachments."));
          return this.control(
            command.sessionId,
            command.conversationId,
            control.value.action,
            control.value.action === "compact" ? control.value.instructions : undefined,
          );
        }
        const accepted = Promise.withResolvers<Result<void, ExpectedError>>();
        let admitted = false;
        const run = this.registry.prompt(
          command.sessionId,
          command.text,
          () => {
            admitted = true;
            accepted.resolve(ok(undefined));
          },
          command.images,
        );
        void run.then(
          (result) => {
            if (!admitted) accepted.resolve(result);
          },
          (error) => accepted.reject(error),
        );
        const result = await accepted.promise;
        return result.ok ? ok(null) : result;
      }
      default:
        return err(
          new InputError(
            id
              ? "Session belongs to AGENT or command is not available in CHAT."
              : "Unsupported CHAT command.",
          ),
        );
    }
  }

  private async control(
    id: string,
    conversationId: string | undefined,
    action: "new" | "new-tab" | "clear" | "exit" | "compact" | "reload",
    instructions?: string,
  ): Promise<Result<string | null, ExpectedError>> {
    const state = this.registry.details(id);
    if (!state || state.conversationId !== conversationId)
      return err(
        new SessionError("SESSION_CONFLICT", "Conversation changed; no command was accepted."),
      );
    if (action !== "compact" && instructions?.trim())
      return err(new InputError("This command does not accept instructions."));
    switch (action) {
      case "new-tab":
        return this.registry.newTab(id);
      case "exit": {
        const closed = await this.close(id);
        return closed.ok ? ok(null) : closed;
      }
      case "reload": {
        const result = await this.registry.reload(id);
        return result.ok ? ok(null) : result;
      }
      default: {
        const accepted = Promise.withResolvers<Result<void, ExpectedError>>();
        let admitted = false;
        const run =
          action === "compact"
            ? this.registry.compact(id, instructions, () => {
                admitted = true;
                accepted.resolve(ok(undefined));
              })
            : this.registry.clearSession(id, () => {
                admitted = true;
                accepted.resolve(ok(undefined));
              });
        void run.then(
          (result) => {
            if (!admitted) accepted.resolve(result);
          },
          (error) => accepted.reject(error),
        );
        const result = await accepted.promise;
        return result.ok ? ok(null) : result;
      }
    }
  }

  async close(sessionId: string): Promise<Result<void, ExpectedError>> {
    if (this.failed.delete(sessionId)) {
      this.changed();
      return ok(undefined);
    }
    return this.registry.close(sessionId);
  }

  async stop(): Promise<Result<void, ExpectedError>> {
    if (this.stopped) return ok(undefined);
    this.stopped = true;
    this.registry.setUiActive(false);
    await this.retention?.stop();
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    this.unsubscribe();
    // Keep the parent's open intent before teardown removes live executions.
    const frozen = [...this.registry.checkpointRecords, ...this.failed.values()];
    const stopped = await collectCleanup(
      [this.checkpoint(frozen), this.registry.shutdown()],
      "CHAT checkpoint or shutdown failed.",
    );
    const openIntent = new Set(
      frozen.filter((record) => record.lifecycle !== "closed").map(sessionRecordKey),
    );
    const finished = this.registry.checkpointRecords.filter(
      (record) => !openIntent.has(sessionRecordKey(record)),
    );
    if (!finished.length) return stopped;

    // Children may settle only during shutdown. Save their cleanup metadata
    // without replacing frozen open parents with teardown's closed records.
    const records = new Map(
      [...frozen, ...finished].map((record) => [sessionRecordKey(record), record]),
    );
    return collectCleanup(
      [Promise.resolve(stopped), this.checkpoint([...records.values()])],
      "Final CHAT checkpoint or shutdown failed.",
    );
  }
}
