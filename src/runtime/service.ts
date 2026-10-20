import { chmod } from "node:fs/promises";
import { Value } from "typebox/value";
import { completionQuerySchema } from "./completion-protocol.ts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { UsageMonitor } from "../usage/monitor.ts";
import { openAiUsageResolver } from "../usage/providers/openai.ts";
import { join } from "node:path";
import { CancelledError, collectCleanup, InputError, ProtocolError, SessionError, reportUnexpected, withCleanup, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { SessionRegistry, type SessionRecord } from "../agents/session-registry.ts";
import { expandPromptDraft } from "../agents/prompt-input.ts";
import { parseSessionControl, type SessionControl } from "../agents/session-controls.ts";
import { piSessionFactory } from "../agents/pi-session-adapter.ts";
import { SessionHistory } from "../agents/history.ts";
import { offlineRuntime } from "../testing/offline-runtime.ts";
import { discoverRepository } from "../workspace/discovery.ts";
import type { Repository } from "../workspace/model.ts";
import { RepositoryCatalog } from "../workspace/catalog.ts";
import { RepositoryWatcher } from "../workspace/repository-watcher.ts";
import { acquireRuntime, privateDirectory, RuntimeStore, runtimePaths } from "./storage.ts";
import { EditorSessions } from "../editor/sessions.ts";
import { TerminalSessions } from "../terminal/sessions.ts";
import { snapshotEvents } from "./events.ts";
import { emptyPreferences, errorStatus, historyPreviewQuerySchema, maxFrameBytes, parseCommand, protocolVersion, wireError,
  type RuntimeCommand, type RuntimeManifest, type RuntimePreferences, type RuntimeSnapshot } from "./protocol.ts";

export async function runRuntime(cwd: string, offline: boolean, stateRoot?: string): Promise<void> {
  const discovered = await discoverRepository(cwd); if (!discovered.ok) throw discovered.error;
  const repository = discovered.value;
  const paths = runtimePaths(repository.id, offline, stateRoot);
  await privateDirectory(paths.directory);
  const release = await acquireRuntime(paths);
  if (!release) return; // Another launch owns initialization or the active service.
  let server: Bun.Server<undefined> | undefined;
  let runtime: WorkspaceRuntime | undefined;
  await withCleanup(async () => {
    const store = new RuntimeStore(paths);
    const loaded = await store.load(repository.id);
    if (!loaded.ok) throw loaded.error; // CLI startup boundary, not a domain API.
    const manifest = loaded.value;
    const catalog = new RepositoryCatalog(mergeRepositories(repository, manifest));
    const options = offline ? await offlineRuntime(join(paths.directory, "offline-agent")) : undefined;
    const modelRuntime = options?.modelRuntime ?? await ModelRuntime.create();
    const usage = offline ? undefined : new UsageMonitor(openAiUsageResolver(modelRuntime));
    const registry = new SessionRegistry(catalog, piSessionFactory({ ...options, modelRuntime, ...(usage ? { usageMonitor: usage } : {}) }));
    runtime = new WorkspaceRuntime(registry, catalog, repository, offline, store, manifest?.preferences ?? emptyPreferences,
      new SessionHistory(catalog, registry, options?.sessionDir), paths.directory, usage);
    await runtime.restore(manifest?.records ?? []);
    await runtime.watchRepository();
    server = Bun.serve({ unix: paths.socket,
      fetch: (request) => runtime!.fetch(request),
    });
    await chmod(paths.socket, 0o600);
    const stopped = Promise.withResolvers<void>();
    const stop = (): void => stopped.resolve();
    process.on("SIGTERM", stop); process.on("SIGINT", stop);
    runtime.onStop = stop;
    try { await stopped.promise; const result = await runtime.stop(); if (!result.ok) throw result.error; }
    finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
  }, async () => {
    await withCleanup(async () => {
      await withCleanup(async () => { await server?.stop(true); }, async () => {
        if (runtime && !runtime.stopped) { const result = await runtime.stop(); if (!result.ok) throw result.error; }
      });
    }, release);
  });
}

class WorkspaceRuntime {
  readonly instance = crypto.randomUUID();
  onStop: () => void = () => {};
  stopped = false;
  private preferences: RuntimePreferences;
  private readonly subscribers = new Set<() => void>();
  private readonly editors: EditorSessions;
  private readonly terminals: TerminalSessions;
  private readonly failedRecovery = new Map<string, SessionRecord>();
  private readonly unsubscribe: () => void;
  private notice = "";
  private persistenceError = "";
  private checkpointTimer: ReturnType<typeof setTimeout> | undefined;
  private initializing = true;
  private watcher: RepositoryWatcher | undefined;
  private discoveryWarning = "";
  private get repositoryId(): string { return this.repository.id; }

  constructor(private readonly registry: SessionRegistry, private readonly catalog: RepositoryCatalog, private repository: Repository,
    private readonly offline: boolean, private readonly store: RuntimeStore, preferences: RuntimePreferences, private readonly history: SessionHistory,
    supervisorDirectory: string, private readonly usage?: UsageMonitor) {
    this.preferences = preferences;
    this.editors = new EditorSessions(catalog, () => this.changed(), { clean: offline });
    this.terminals = new TerminalSessions(catalog, () => this.changed(), supervisorDirectory, offline, (task) => this.observe(task));
    this.unsubscribe = registry.subscribe(() => this.changed());
  }

  async watchRepository(): Promise<void> {
    this.watcher = new RepositoryWatcher(this.repository, (result) => {
      if (this.stopped) return;
      if (result.ok) { this.repository = result.value; this.discoveryWarning = ""; }
      else this.discoveryWarning = `Worktree discovery failed [${result.error.code}]: ${result.error.message}. Previous entries were retained.`;
      this.changed();
    }, (error) => {
      this.discoveryWarning = reportUnexpected(error, "worktree discovery"); this.changed();
    });
    const started = await this.watcher.start();
    if (!started.ok) {
      this.discoveryWarning = `Worktree watching failed [${started.error.code}]: ${started.error.message}`;
      this.changed();
    }
  }

  private reconcileCatalog(): void {
    const retained = new Set([...this.registry.retainedWorktreeIds, ...this.editors.retainedWorktreeIds,
      ...this.terminals.retainedWorktreeIds, ...[...this.failedRecovery.values()].map((record) => record.worktreeId)]);
    this.catalog.replace([this.repository], retained);
  }

  async restore(records: readonly SessionRecord[]): Promise<void> {
    for (const record of records) {
      const restored = await this.registry.restore(record);
      if (!restored.ok) {
        const state = { ...record.state, status: "failure" as const, error: `Could not restore: ${restored.error.message}` };
        delete state.telemetry;
        this.failedRecovery.set(record.id, { ...record, state,
          subagents: record.subagents.map((agent) => ({ ...agent, status: agent.status === "working" ? null : agent.status })) });
      }
    }
    this.initializing = false;
    this.reconcileCatalog();
    const saved = await this.checkpoint(); if (!saved.ok) throw saved.error;
  }

  get snapshot(): RuntimeSnapshot {
    const failed = [...this.failedRecovery.values()];
    const repositories = this.registry.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => ({
      ...tree, sessions: [...tree.sessions, ...failed.filter((record) => record.worktreeId === tree.id).map((record) => ({
        id: record.id, name: record.name, status: record.state.status, subagents: record.subagents,
      }))],
    })) }));
    const details = Object.fromEntries([...this.registry.records, ...failed].map((record) => [record.id, record.state]));
    return { version: protocolVersion, pid: process.pid, instance: this.instance, capabilities: ["history", "history-preview", "typed-errors", "work-views", "terminal-tabs", "instance-guard", "agent-transcript", "run-completion", "agent-telemetry", "provider-usage", "prompt-completion", "prompt-images", "session-controls"], repositoryId: this.repositoryId,
      mode: this.offline ? "offline" : "live", repositories, details, closingCount: this.registry.closingCount,
      preferences: this.preferences, notice: this.persistenceError || [this.discoveryWarning, this.notice].filter(Boolean).join(" · "), editors: this.editors.infos,
      terminals: this.terminals.infos, terminalClosingCount: this.terminals.closingCount };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      const expectedInstance = request.headers.get("X-Radian-Instance");
      if (expectedInstance && expectedInstance !== this.instance) return this.rejected(new ProtocolError("Runtime instance changed; refresh the connection before retrying. No action was accepted."));
      if (path === "/snapshot" && request.method === "GET") return Response.json(this.snapshot);
      if (path === "/events" && request.method === "GET") return this.events();
      if ((path === "/editor/events" || path === "/terminal/events") && request.method === "GET") {
        const params = new URL(request.url).searchParams;
        const id = params.get("id"), lease = params.get("lease");
        if (!id || !lease || id.length > 4096 || lease.length > 4096) return this.rejected(new InputError("Missing editor attachment identity."));
        const attached = path === "/editor/events" ? this.editors.attach(id, lease) : this.terminals.attach(id, lease);
        return attached.ok ? attached.value : this.rejected(attached.error);
      }
      if (path === "/completions" && request.method === "GET") {
        if (expectedInstance !== this.instance) return this.rejected(new ProtocolError("Completion requires the current runtime instance identity."));
        if (this.stopped) return this.rejected(new SessionError("RUNTIME_STOPPING", "Runtime is stopping."));
        const query = Object.fromEntries(new URL(request.url).searchParams);
        if (!Value.Check(completionQuerySchema, query)) return this.rejected(new InputError("Malformed completion query."));
        const result = await this.registry.complete(query.sessionId, query, request.signal);
        return result.ok ? Response.json(result.value) : this.rejected(result.error);
      }
      if (path === "/history/preview" && request.method === "GET") {
        if (expectedInstance !== this.instance) return this.rejected(new ProtocolError("History preview requires the current runtime instance identity."));
        if (this.stopped) return this.rejected(new SessionError("RUNTIME_STOPPING", "Runtime is stopping."));
        const query = Object.fromEntries(new URL(request.url).searchParams);
        if (!Value.Check(historyPreviewQuerySchema, query)) return this.rejected(new InputError("Malformed history preview query."));
        const preview = await this.history.preview(query.worktreeId, query.savedId, request.signal);
        return preview.ok ? Response.json(preview.value) : this.rejected(preview.error);
      }
      if (path === "/history" && request.method === "GET") {
        const worktreeId = new URL(request.url).searchParams.get("worktreeId");
        if (!worktreeId) return this.rejected(new InputError("Missing worktree for history."));
        const history = await this.history.list(worktreeId);
        return history.ok ? Response.json(history.value) : this.rejected(history.error);
      }
      if (path !== "/command" || request.method !== "POST") return new Response("Not found", { status: 404 });
      if (Number(request.headers.get("content-length")) > maxFrameBytes) return this.rejected(new InputError("Command is too large."));
      const text = await request.text();
      if (Buffer.byteLength(text) > maxFrameBytes) return this.rejected(new InputError("Command is too large."));
      const command = parseCommand(text); if (!command.ok) return this.rejected(command.error);
      if (this.stopped) return this.rejected(new SessionError("RUNTIME_STOPPING", "Runtime is stopping."));
      const result = await this.command(command.value);
      if (!result.ok) return this.rejected(result.error);
      // Commands above have already been accepted. A checkpoint failure is NOT a rejected action.
      // Keystrokes/resize affect the live editor only, never the manifest or a replay log.
      const transient = ["editor-input", "editor-resize", "editor-detach", "terminal-input", "terminal-resize", "terminal-scroll", "terminal-detach"].includes(command.value.type);
      const checkpoint = transient ? ok(undefined) : await this.checkpoint();
      return Response.json({ ok: true, value: result.value, ...(!checkpoint.ok ? { warnings: [wireError(checkpoint.error)] } : {}) });
    } catch (error) {
      reportUnexpected(error, "runtime request");
      return Response.json({ ok: false, error: { code: "REMOTE_INTERNAL_ERROR", message: "Unexpected runtime error. Inspect runtime.log; action outcome may be unknown.", outcome: "unknown" } }, { status: 500 });
    }
  }

  private rejected(error: ExpectedError): Response {
    const status = errorStatus(error);
    if (status >= 500) console.error(`[radian:${error.code}] Runtime operation failed`, error);
    return Response.json({ ok: false, error: wireError(error) }, { status });
  }

  private async command(command: RuntimeCommand): Promise<Result<string | null, ExpectedError>> {
    switch (command.type) {
      case "create": {
        return this.registry.create(command.worktreeId);
      }
      case "resume": {
        return this.history.resume(command.worktreeId, command.savedId);
      }
      case "close": {
        if (this.failedRecovery.delete(command.sessionId)) this.changed();
        else this.observe(this.registry.close(command.sessionId));
        return ok(null);
      }
      case "session-control": {
        if (command.action === "new" && command.instructions?.trim()) return err(new InputError("Usage: /new (no arguments)."));
        return this.sessionControl(command.sessionId, command, command.conversationId);
      }
      case "prompt": {
        const control = parseSessionControl(command.text); if (!control.ok) return control;
        if (control.value) {
          if (command.images?.length) return err(new InputError(`/${control.value.action} does not accept image attachments.`));
          return this.sessionControl(command.sessionId, control.value, command.conversationId);
        }
        if (this.failedRecovery.has(command.sessionId)) return err(new SessionError("SESSION_NOT_OPEN", "This session needs recovery before it can run."));
        const state = this.registry.details(command.sessionId);
        if (!state) return err(new SessionError("SESSION_NOT_OPEN", "Session is not open."));
        if (command.conversationId && command.conversationId !== state.conversationId) return err(new SessionError("SESSION_CONFLICT", "This tab changed conversations. Input was retained; review the new session before submitting again."));
        if (!command.text.trim()) return err(new InputError("A prompt must not be empty."));
        const accepted = Promise.withResolvers<Result<void, ExpectedError>>();
        let admitted = false;
        const run = this.registry.prompt(command.sessionId, command.text, () => { admitted = true; accepted.resolve(ok(undefined)); }, command.images);
        // Rejection before admission belongs to the caller. Accepted model/tool
        // failures already belong to the session transcript, not the global footer.
        void run.then((result) => { if (!admitted) accepted.resolve(result); }, (error: unknown) => {
          if (!admitted) accepted.reject(error);
          else { this.notice = reportUnexpected(error, "agent execution"); this.changed(); }
        });
        const result = await accepted.promise;
        return result.ok ? ok(null) : result;
      }
      case "preferences": {
        const workViews = command.preferences.workViews ?? this.preferences.workViews;
        const terminalViews = command.preferences.terminalViews ?? this.preferences.terminalViews;
        const gitViews = command.preferences.gitViews ?? this.preferences.gitViews;
        const agentViews = command.preferences.agentViews ?? this.preferences.agentViews;
        // Old clients cannot edit rich metadata. Retain it only while their legacy
        // text still describes the same draft; never resurrect a replaced attachment.
        const inputDrafts = command.preferences.inputDrafts ?? (this.preferences.inputDrafts ? Object.fromEntries(Object.entries(this.preferences.inputDrafts)
          .filter(([id, draft]) => command.preferences.drafts[id] === expandPromptDraft(draft, false).text)) : undefined);
        const drafts = { ...command.preferences.drafts };
        for (const [id, draft] of Object.entries(inputDrafts ?? {})) drafts[id] = expandPromptDraft(draft, false).text;
        this.preferences = { ...command.preferences, drafts, ...(inputDrafts ? { inputDrafts } : {}), ...(workViews ? { workViews } : {}), ...(terminalViews ? { terminalViews } : {}), ...(gitViews ? { gitViews } : {}), ...(agentViews ? { agentViews } : {}) };
        return ok(null);
      }
      case "terminal-create": return this.terminals.create(command.worktreeId, command);
      case "terminal-close": this.observe(this.terminals.close(command.terminalId)); return ok(null);
      case "terminal-detach": this.terminals.detach(command.terminalId, command.lease); return ok(null);
      case "terminal-input": {
        const result = this.terminals.input(command.terminalId, command.lease, Buffer.from(command.data, "base64"));
        return result.ok ? ok(null) : result;
      }
      case "terminal-resize": {
        const result = await this.terminals.resize(command.terminalId, command.lease, command.cols, command.rows);
        return result.ok ? ok(null) : result;
      }
      case "terminal-scroll": {
        const result = await this.terminals.scroll(command.terminalId, command.lease, command.lines);
        return result.ok ? ok(null) : result;
      }
      case "editor-open": return this.editors.open(command.worktreeId, { cols: command.cols ?? 80, rows: command.rows ?? 24 });
      case "editor-detach": this.editors.detach(command.editorId, command.lease); return ok(null);
      case "editor-input": {
        const result = this.editors.input(command.editorId, command.lease, Buffer.from(command.data, "base64"));
        return result.ok ? ok(null) : result;
      }
      case "editor-resize": {
        const result = await this.editors.resize(command.editorId, command.lease, command.cols, command.rows);
        return result.ok ? ok(null) : result;
      }
      case "stop": setTimeout(() => this.onStop(), 20); return ok(null);
    }
  }

  private async sessionControl(id: string, control: SessionControl, expectedConversation?: string): Promise<Result<null, ExpectedError>> {
    if (this.failedRecovery.has(id)) return err(new SessionError("SESSION_NOT_OPEN", "This session needs recovery first."));
    const state = this.registry.details(id);
    if (!state) return err(new SessionError("SESSION_NOT_OPEN", "Session is not open."));
    if (expectedConversation && state.conversationId !== expectedConversation) return err(new SessionError("SESSION_CONFLICT", "This tab changed conversations. No command was accepted."));
    const accepted = Promise.withResolvers<Result<void, ExpectedError>>();
    let admitted = false;
    const accept = () => { admitted = true; accepted.resolve(ok(undefined)); };
    const run = control.action === "new" ? this.registry.newSession(id, accept) : this.registry.compact(id, control.instructions, accept);
    void run.then((result) => {
      if (!admitted) accepted.resolve(result);
      else if (!result.ok && control.action === "new") { this.notice = `[${result.error.code}] Session replacement did not finish: ${result.error.message}`; this.changed(); }
      if (result.ok && control.action === "new") {
        // A tab is stable, but source cursors/folds/scroll belong to its old conversation.
        if (this.preferences.agentViews) delete this.preferences.agentViews[id];
        if (this.preferences.workViews) delete this.preferences.workViews.agentScroll[id];
        this.changed();
      }
    }, (error: unknown) => {
      if (!admitted) accepted.reject(error);
      else { this.notice = reportUnexpected(error, "session control"); this.changed(); }
    });
    const result = await accepted.promise;
    return result.ok ? ok(null) : result;
  }

  private events(): Response {
    return snapshotEvents(() => this.snapshot, (send) => {
      this.subscribers.add(send); this.usage?.setActive(true);
      return () => { this.subscribers.delete(send); this.usage?.setActive(this.subscribers.size > 0); };
    });
  }

  private changed(): void {
    if (!this.initializing && !this.stopped) this.reconcileCatalog();
    for (const subscriber of this.subscribers) subscriber();
    if (this.initializing || this.stopped || this.checkpointTimer) return;
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = undefined;
      void this.checkpoint().catch((error: unknown) => {
        this.persistenceError = reportUnexpected(error, "checkpoint");
        for (const subscriber of this.subscribers) subscriber();
      });
    }, 100);
  }

  private observe(task: Promise<Result<void, ExpectedError>>): void {
    void task.then((result) => {
      if (!result.ok && !(result.error instanceof CancelledError)) {
        if (errorStatus(result.error) >= 500) console.error(`[radian:${result.error.code}] Background operation failed`, result.error);
        this.notice = result.error.message; this.changed();
      }
    }).catch((error: unknown) => { this.notice = reportUnexpected(error, "background operation"); this.changed(); });
  }
  private async checkpoint(manifest?: RuntimeManifest): Promise<Result<void, ExpectedError>> {
    const saved = await this.store.save(manifest ?? { version: protocolVersion, repositoryId: this.repositoryId,
      repositories: this.registry.snapshot, records: [...this.registry.records, ...this.failedRecovery.values()], preferences: this.preferences });
    if (!saved.ok && !this.persistenceError) console.error(`[radian:${saved.error.code}] Checkpoint failed`, saved.error);
    this.persistenceError = saved.ok ? "" : `Runtime persistence failed: ${saved.error.message}`;
    if (!saved.ok) for (const subscriber of this.subscribers) subscriber();
    return saved;
  }

  async stop(): Promise<Result<void, ExpectedError>> {
    if (this.stopped) return ok(undefined);
    this.stopped = true;
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    this.unsubscribe();
    // Stopping the service is NOT explicit session close. Freeze open intent before teardown emits removals.
    const manifest: RuntimeManifest = { version: protocolVersion, repositoryId: this.repositoryId,
      repositories: this.registry.snapshot, records: [...this.registry.records, ...this.failedRecovery.values()], preferences: this.preferences };
    return collectCleanup([this.watcher ? this.watcher.stop().then(() => ok(undefined)) : Promise.resolve(ok(undefined)),
      this.checkpoint(manifest), this.registry.shutdown(), this.editors.stop(), this.terminals.stop(),
      this.usage ? this.usage.stop().then(() => ok(undefined)) : Promise.resolve(ok(undefined))], "Checkpoint or runtime shutdown failed.");
  }
}

function mergeRepositories(current: Repository, manifest: RuntimeManifest | null): Repository[] {
  const worktrees = [...current.worktrees];
  const needed = new Set(manifest?.records.map((record) => record.worktreeId));
  for (const tree of manifest?.repositories.flatMap((repo) => repo.worktrees) ?? []) {
    if (needed.has(tree.id) && !worktrees.some((known) => known.id === tree.id)) worktrees.push({ ...tree, sessions: [] });
  }
  return [{ ...current, worktrees }];
}
