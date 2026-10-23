import { realpath } from "node:fs/promises";
import { loadSessionSettings } from "../app/settings.ts";
import { RetentionScheduler } from "./session-retention.ts";
import { Value } from "typebox/value";
import { completionCatalogQuerySchema, completionQuerySchema } from "./completion-protocol.ts";
import { join } from "node:path";
import { CancelledError, collectCleanup, InputError, ProtocolError, SessionError, parseJson, reportUnexpected, withCleanup, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { SessionRegistry, type SessionRecord } from "../agents/session-registry.ts";
import { sessionRecordKey } from "../agents/session-snapshot.ts";
import { expandPromptDraft } from "../agents/prompt-input.ts";
import { parseSessionControl, type SessionControl } from "../agents/session-controls.ts";
import { modelCatalogQuerySchema } from "../agents/model-selection.ts";
import { piSessionFactory } from "../agents/pi-session-adapter.ts";
import { SessionHistory } from "../agents/history.ts";
import { dashboardPeriods } from "../agents/dashboard.ts";
import { offlineRuntime } from "../testing/offline-runtime.ts";
import { discoverRepository } from "../workspace/discovery.ts";
import type { Repository } from "../workspace/model.ts";
import { RepositoryCatalog } from "../workspace/catalog.ts";
import { RepositoryWatcher } from "../workspace/repository-watcher.ts";
import { daemonPaths, privateDirectory, RuntimeStore, runtimePaths } from "./storage.ts";
import { AccountManager } from "../accounts/manager.ts";
import { accountRequestSchema } from "../accounts/model.ts";
import { EditorSessions } from "../editor/sessions.ts";
import { TerminalSessions } from "../terminal/sessions.ts";
import { snapshotEvents } from "./events.ts";
import { transcriptImageQuerySchema } from "../agents/transcript-images.ts";
import { emptyPreferences, errorStatus, historyPreviewQuerySchema, maxFrameBytes, parseCommand, protocolVersion, wireError,
  type RuntimeCommand, type RuntimeManifest, type RuntimePreferences, type RuntimeSnapshot } from "./protocol.ts";

// Repository execution is an in-process resource of the shared daemon, never another service.
export async function openRepositoryRuntime(repositoryId: string, offline: boolean, instance: string, stateRoot?: string, configPath?: string, sharedAccounts?: AccountManager): Promise<Result<WorkspaceRuntime, ExpectedError>> {
  const settings = await loadSessionSettings(configPath); if (!settings.ok) return settings;
  const discovered = await discoverRepository(repositoryId); if (!discovered.ok) return discovered;
  const repository = discovered.value, paths = runtimePaths(repository.id, offline, stateRoot), store = new RuntimeStore(paths);
  const loaded = await store.load(repository.id); if (!loaded.ok) return loaded;
  const manifest = loaded.value, catalog = new RepositoryCatalog(mergeRepositories(repository, manifest));
  const options = offline ? await offlineRuntime(join(paths.directory, "offline-agent")) : undefined;
  const openedAccounts = sharedAccounts ? ok(sharedAccounts) : await AccountManager.open(daemonPaths(offline, stateRoot).directory, { offline });
  if (!openedAccounts.ok) return openedAccounts;
  const accounts = openedAccounts.value;
  const modelRuntime = options?.modelRuntime;
  let runtime: WorkspaceRuntime | undefined;
  let ready = false;
  return withCleanup(async () => {
    const requestedSessionDir = options?.sessionDir ?? join(paths.directory, "sdk-sessions");
    await privateDirectory(requestedSessionDir);
    const sessionDir = await realpath(requestedSessionDir);
    const registry = new SessionRegistry(catalog, piSessionFactory({ ...options, sessionDir, ...(modelRuntime ? { modelRuntime } : {}), ...(!offline ? { accounts } : {}) }));
    runtime = new WorkspaceRuntime(instance, registry, catalog, repository, offline, store, manifest?.preferences ?? emptyPreferences,
      new SessionHistory(catalog, registry, sessionDir, store, !offline), paths.directory, settings.value.exists ? settings.value.path : configPath, accounts, !sharedAccounts);
    await runtime.restore(manifest?.records ?? [], manifest?.repositories ?? []);
    await runtime.watchRepository();
    runtime.startRetention();
    ready = true;
    return ok(runtime);
  }, async () => {
    if (ready) return;
    if (runtime) { const stopped = await runtime.stop(); if (!stopped.ok) throw stopped.error; }
    else if (!sharedAccounts) { const stopped = await accounts.stop(); if (!stopped.ok) throw stopped.error; }
  });
}

export class WorkspaceRuntime {
  onStop: () => void = () => {};
  stopped = false;
  private preferences: RuntimePreferences;
  private readonly subscribers = new Set<() => void>();
  private readonly editors: EditorSessions;
  private readonly terminals: TerminalSessions;
  private readonly failedRecovery = new Map<string, SessionRecord>();
  private readonly restoredSessionOrder = new Map<string, number>();
  private readonly unsubscribe: () => void;
  private notice = "";
  private persistenceError = "";
  private checkpointTimer: ReturnType<typeof setTimeout> | undefined;
  private initializing = true;
  private watcher: RepositoryWatcher | undefined;
  private discoveryWarning = "";
  private retentionWarning = "";
  private retention: RetentionScheduler | undefined;
  private retentionStatus: RuntimeSnapshot["sessionRetention"];
  private get repositoryId(): string { return this.repository.id; }

  constructor(readonly instance: string, private readonly registry: SessionRegistry, private readonly catalog: RepositoryCatalog, private repository: Repository,
    private readonly offline: boolean, private readonly store: RuntimeStore, preferences: RuntimePreferences, private readonly history: SessionHistory,
    supervisorDirectory: string, private readonly configPath?: string, private readonly accounts?: AccountManager, private readonly ownsAccounts = false) {
    this.preferences = preferences;
    this.editors = new EditorSessions(catalog, () => this.changed(), { clean: offline });
    this.terminals = new TerminalSessions(catalog, () => this.changed(), supervisorDirectory, offline, (task) => this.observe(task));
    this.unsubscribe = registry.subscribe(() => this.changed());
  }

  subscribe(listener: () => void): () => void { this.subscribers.add(listener); return () => this.subscribers.delete(listener); }
  setObserved(active: boolean): void { this.accounts?.setActive(active, this.instance); }

  startRetention(): void {
    let configuredFile = this.configPath, retentionDays: number | null = 30;
    this.retention = new RetentionScheduler(async () => {
      const settings = await loadSessionSettings(configuredFile); if (!settings.ok) return settings;
      // Once observed, a missing policy file is an error, not a surprise return to destructive defaults.
      if (settings.value.exists) configuredFile = settings.value.path;
      retentionDays = settings.value.retentionDays;
      return this.store.pruneExpired(retentionDays, (snapshot, file) => this.stopped ? null : this.registry.reserveSnapshotCleanup(snapshot, file));
    }, result => {
      this.history.invalidate();
      if (!result.ok && result.error.code !== "INVALID_INPUT") console.error(`[radian:${result.error.code}] Session retention cleanup failed`, result.error);
      const warning = result.ok ? "" : `Session cleanup [${result.error.code}]: ${result.error.message}`;
      const changed = warning !== this.retentionWarning || result.ok;
      if (result.ok) this.retentionStatus = { retentionDays, lastSweepAt: Date.now(), removed: result.value };
      this.retentionWarning = warning; if (changed) this.changed();
    }, error => { this.retentionWarning = reportUnexpected(error, "session retention"); this.changed(); });
    // Maintenance must not delay the HTTP handshake for a large accumulated history.
    void this.retention.start().catch(error => { this.retentionWarning = reportUnexpected(error, "session retention startup"); this.changed(); });
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

  async restore(records: readonly SessionRecord[], repositories: readonly Repository[] = []): Promise<void> {
    // Saved tab IDs determine position; conversation indexes only determine recovery membership.
    const savedOrder = new Map<string, number>();
    for (const repo of repositories) for (const tree of repo.worktrees) for (const session of tree.sessions) {
      const key = JSON.stringify([tree.id, session.id]);
      if (!savedOrder.has(key)) savedOrder.set(key, savedOrder.size);
    }
    const rank = (record: SessionRecord) => savedOrder.get(JSON.stringify([record.worktreeId, record.id])) ?? Number.MAX_SAFE_INTEGER;
    const open = records.filter(record => record.lifecycle !== "closed").toSorted((a, b) => rank(a) - rank(b));
    for (const record of open) {
      this.restoredSessionOrder.set(record.id, this.restoredSessionOrder.size);
      const restored = await this.registry.restore(record);
      if (!restored.ok) {
        const result = { id: crypto.randomUUID(), outcome: "error" as const, completedAt: Date.now(), ...(record.state.request ? { request: record.state.request } : {}) };
        const state = { ...record.state, result, attention: result, status: "failure" as const, error: `Could not restore: ${restored.error.message}` };
        delete state.telemetry;
        this.failedRecovery.set(record.id, { ...record, state,
          subagents: record.subagents.map((agent) => ({ ...agent, status: agent.status === "working" ? null : agent.status })) });
      }
    }
    this.initializing = false;
    this.reconcileCatalog();
    const saved = await this.checkpoint(); if (!saved.ok) throw saved.error;
  }

  private get repositories(): readonly Repository[] {
    const failed = [...this.failedRecovery.values()];
    return this.registry.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => ({
      ...tree, sessions: [...tree.sessions, ...failed.filter((record) => record.worktreeId === tree.id).map((record) => ({
        id: record.id, name: record.name, status: record.state.status, subagents: record.subagents,
        ...(record.state.request ? { request: record.state.request } : {}), ...(record.state.result ? { result: record.state.result } : {}),
        ...(record.state.attention ? { attention: record.state.attention } : {}),
      }))].sort((a, b) =>
        (this.restoredSessionOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (this.restoredSessionOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER)),
    })) }));
  }

  get snapshot(): RuntimeSnapshot {
    const repositories = this.repositories;
    const details = Object.fromEntries([...this.registry.records, ...this.failedRecovery.values()].map((record) => [record.id, record.state]));
    return { version: protocolVersion, pid: process.pid, instance: this.instance, capabilities: ["shared-daemon", "repository-runtime", "history", "history-preview", "typed-errors", "work-views", "terminal-tabs", "terminal-copy-mode", "instance-guard", "agent-transcript", "run-completion", "agent-telemetry", "provider-usage", "prompt-completion", "prompt-images", "transcript-images", "session-controls", "session-tab-commands", "session-exit", "agent-interrupt", "model-selection", "model-effort", "completion-catalog", "resource-reload", "session-attention", "agent-dashboard", "accounts"], repositoryId: this.repositoryId,
      ...(this.retentionStatus ? { sessionRetention: this.retentionStatus } : {}),
      mode: this.offline ? "offline" : "live", repositories, details, closingCount: this.registry.closingCount,
      preferences: this.preferences, notice: this.persistenceError || [this.accounts?.warning, this.discoveryWarning, this.retentionWarning, this.notice].filter(Boolean).join(" · "), editors: this.editors.infos,
      terminals: this.terminals.infos, terminalClosingCount: this.terminals.closingCount };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      const expectedInstance = request.headers.get("X-Radian-Instance");
      if (path === "/accounts" && request.method === "POST") {
        if (!this.accounts || expectedInstance !== this.instance) return this.rejected(new ProtocolError("Account management requires the current runtime instance."));
        const text = await request.text();
        if (Buffer.byteLength(text) > maxFrameBytes) return this.rejected(new InputError("Account request is too large."));
        const parsed = parseJson(text, "account request"); if (!parsed.ok) return this.rejected(parsed.error);
        if (!Value.Check(accountRequestSchema, parsed.value)) return this.rejected(new InputError("Malformed account request."));
        const command = parsed.value;
        if (!this.repository.worktrees.some(tree => tree.id === command.worktreeId)) return this.rejected(new InputError("Worktree does not belong to this repository."));
        const result = await this.accounts.handle(command, request.signal);
        return result.ok ? Response.json(result.value) : this.rejected(result.error);
      }
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
      if (path === "/images" && request.method === "GET") {
        if (expectedInstance !== this.instance) return this.rejected(new ProtocolError("Image preview requires the current runtime instance identity."));
        if (this.stopped) return this.rejected(new SessionError("RUNTIME_STOPPING", "Runtime is stopping."));
        const query = Object.fromEntries(new URL(request.url).searchParams);
        if (!Value.Check(transcriptImageQuerySchema, query)) return this.rejected(new InputError("Malformed image preview query."));
        const image = this.registry.imageData(query.sessionId, query.imageId);
        return image.ok ? new Response(image.value.bytes, { headers: { "Content-Type": image.value.mimeType,
          "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }) : this.rejected(image.error);
      }
      if (path === "/models" && request.method === "GET") {
        if (expectedInstance !== this.instance) return this.rejected(new ProtocolError("Model lookup requires the current runtime instance identity."));
        if (this.stopped) return this.rejected(new SessionError("RUNTIME_STOPPING", "Runtime is stopping."));
        const query = Object.fromEntries(new URL(request.url).searchParams);
        if (!Value.Check(modelCatalogQuerySchema, query)) return this.rejected(new InputError("Malformed model catalog query."));
        const result = await this.registry.models(query.sessionId, query.conversationId, request.signal);
        return result.ok ? Response.json(result.value) : this.rejected(result.error);
      }
      if (path === "/completion-catalog" && request.method === "GET") {
        if (expectedInstance !== this.instance) return this.rejected(new ProtocolError("Catalog requires the current runtime instance identity."));
        if (this.stopped) return this.rejected(new SessionError("RUNTIME_STOPPING", "Runtime is stopping."));
        const query = Object.fromEntries(new URL(request.url).searchParams);
        if (!Value.Check(completionCatalogQuerySchema, query)) return this.rejected(new InputError("Malformed completion catalog query."));
        const result = this.registry.catalog(query.sessionId, query.conversationId);
        return result.ok ? Response.json(result.value) : this.rejected(result.error);
      }
      if (path === "/completions" && request.method === "GET") {
        if (expectedInstance !== this.instance) return this.rejected(new ProtocolError("Completion requires the current runtime instance identity."));
        if (this.stopped) return this.rejected(new SessionError("RUNTIME_STOPPING", "Runtime is stopping."));
        const query = Object.fromEntries(new URL(request.url).searchParams);
        if (!Value.Check(completionQuerySchema, query)) return this.rejected(new InputError("Malformed completion query."));
        const result = await this.registry.complete(query.sessionId, query, request.signal);
        return result.ok ? Response.json(result.value) : this.rejected(result.error);
      }
      if (path === "/dashboard" && request.method === "GET") {
        if (expectedInstance !== this.instance) return this.rejected(new ProtocolError("Dashboard requires the current runtime instance identity."));
        if (this.stopped) return this.rejected(new SessionError("RUNTIME_STOPPING", "Runtime is stopping."));
        const params = new URL(request.url).searchParams, days = Number(params.get("days"));
        const period = dashboardPeriods.find(period => period === days);
        if (!period || [...params.keys()].some(key => key !== "days")) return this.rejected(new InputError("Dashboard period must be 1, 7 or 30 days."));
        const result = await this.history.dashboard(period, request.signal);
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
        const history = await this.history.list(worktreeId, request.signal);
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
      const transient = ["editor-input", "editor-resize", "editor-detach", "terminal-input", "terminal-resize", "terminal-scroll", "terminal-read", "terminal-detach"].includes(command.value.type);
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
      case "acknowledge": {
        const failed = this.failedRecovery.get(command.sessionId);
        if (failed) {
          if (failed.state.conversationId !== command.conversationId) return err(new SessionError("SESSION_CONFLICT", "Conversation changed. No result was acknowledged."));
          if (failed.state.attention?.id === command.resultId) {
            const { attention: _attention, ...state } = failed.state;
            this.failedRecovery.set(failed.id, { ...failed, state }); this.changed();
          }
          return ok(null);
        }
        const result = this.registry.acknowledge(command.sessionId, command.conversationId, command.resultId);
        return result.ok ? ok(null) : result;
      }
      case "interrupt": {
        const state = this.registry.details(command.sessionId);
        if (!state) return err(new SessionError("SESSION_NOT_OPEN", "Session is not open."));
        if (state.conversationId !== command.conversationId) return err(new SessionError("SESSION_CONFLICT", "This tab changed conversations. No interrupt was accepted."));
        const accepted = Promise.withResolvers<Result<void, ExpectedError>>();
        let admitted = false;
        const run = this.registry.interrupt(command.sessionId, () => { admitted = true; accepted.resolve(ok(undefined)); });
        void run.then((result) => {
          if (!admitted) accepted.resolve(result);
          else if (!result.ok) { this.notice = `[${result.error.code}] Interrupt did not finish: ${result.error.message}`; this.changed(); }
        }, (error: unknown) => {
          if (!admitted) accepted.reject(error);
          else { this.notice = reportUnexpected(error, "agent interruption"); this.changed(); }
        });
        const result = await accepted.promise;
        return result.ok ? ok(null) : result;
      }
      case "model-select": return this.registry.selectModel(command.sessionId, command.conversationId, command.model, command.effort);
      case "session-control": {
        // Old clients used wire "new" for in-place replacement. Never silently change that contract.
        const action = command.action === "new" ? "clear" : command.action;
        if (action !== "compact" && command.instructions?.trim()) return err(new InputError(`Usage: /${action === "new-tab" ? "new" : action} (no arguments).`));
        const control: SessionControl = action === "compact"
          ? { action, ...(command.instructions ? { instructions: command.instructions } : {}) } : { action };
        return this.sessionControl(command.sessionId, control, command.conversationId);
      }
      case "prompt": {
        const control = parseSessionControl(command.text); if (!control.ok) return control;
        if (control.value) {
          if (command.images?.length) return err(new InputError(`/${control.value.action === "new-tab" ? "new" : control.value.action} does not accept image attachments.`));
          return this.sessionControl(command.sessionId, control.value, command.conversationId);
        }
        if (this.failedRecovery.has(command.sessionId)) return err(new SessionError("SESSION_NOT_OPEN", "This session needs recovery before it can run."));
        const state = this.registry.details(command.sessionId);
        if (!state) return err(new SessionError("SESSION_NOT_OPEN", "Session is not open."));
        if (command.conversationId && command.conversationId !== state.conversationId) return err(new SessionError("SESSION_CONFLICT", "This tab changed conversations. Input was retained; review the new session before submitting again."));
        if (command.resourceRevision !== undefined && command.resourceRevision !== (state.resourceRevision ?? 0)) return err(new SessionError("SESSION_CONFLICT", "Session resources changed. Let suggestions refresh before retrying. No model prompt was sent."));
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
      case "terminal-read": {
        const result = await this.terminals.read(command.terminalId, command.lease);
        return result.ok ? ok(JSON.stringify(result.value)) : result;
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

  private async sessionControl(id: string, control: SessionControl, expectedConversation?: string): Promise<Result<string | null, ExpectedError>> {
    const failed = this.failedRecovery.get(id);
    if (failed && control.action !== "exit") return err(new SessionError("SESSION_NOT_OPEN", "This session needs recovery first."));
    const state = failed?.state ?? this.registry.details(id);
    if (!state) return err(new SessionError("SESSION_NOT_OPEN", "Session is not open."));
    if (control.action !== "compact" && !expectedConversation) return err(new SessionError("SESSION_CONFLICT", "Current conversation identity is required. No command was accepted."));
    if (expectedConversation && state.conversationId !== expectedConversation) return err(new SessionError("SESSION_CONFLICT", "This tab changed conversations. No command was accepted."));
    if (control.action === "exit") return this.command({ type: "close", sessionId: id });
    if (control.action === "new-tab") return this.registry.newTab(id);
    if (control.action === "reload") {
      const result = await this.registry.reload(id);
      return result.ok ? ok(null) : result;
    }
    const accepted = Promise.withResolvers<Result<void, ExpectedError>>();
    let admitted = false;
    const accept = () => { admitted = true; accepted.resolve(ok(undefined)); };
    const run = control.action === "clear" ? this.registry.clearSession(id, accept) : this.registry.compact(id, control.instructions, accept);
    void run.then((result) => {
      if (!admitted) accepted.resolve(result);
      else if (!result.ok && control.action === "clear") { this.notice = `[${result.error.code}] Session replacement did not finish: ${result.error.message}`; this.changed(); }
      if (result.ok && control.action === "clear") {
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
      this.subscribers.add(send); this.setObserved(true);
      return () => { this.subscribers.delete(send); this.setObserved(this.subscribers.size > 0); };
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
    const checkpoint = manifest ?? { version: protocolVersion, repositoryId: this.repositoryId,
      repositories: this.repositories, records: [...this.registry.checkpointRecords, ...this.failedRecovery.values()], preferences: this.preferences };
    const saved = await this.store.save(checkpoint);
    if (saved.ok) this.registry.acknowledgeCheckpoint(checkpoint.records);
    if (!saved.ok && !this.persistenceError) console.error(`[radian:${saved.error.code}] Checkpoint failed`, saved.error);
    this.persistenceError = saved.ok ? "" : `Runtime persistence failed: ${saved.error.message}`;
    if (!saved.ok) for (const subscriber of this.subscribers) subscriber();
    return saved;
  }

  async stop(): Promise<Result<void, ExpectedError>> {
    if (this.stopped) return ok(undefined);
    this.stopped = true; this.setObserved(false);
    await this.retention?.stop();
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    this.unsubscribe();
    // Stopping the service is NOT explicit session close. Freeze open intent before teardown emits removals.
    const manifest: RuntimeManifest = { version: protocolVersion, repositoryId: this.repositoryId,
      repositories: this.repositories, records: [...this.registry.checkpointRecords, ...this.failedRecovery.values()], preferences: this.preferences };
    const stopped = await collectCleanup([this.watcher ? this.watcher.stop().then(() => ok(undefined)) : Promise.resolve(ok(undefined)),
      this.checkpoint(manifest), this.registry.shutdown(), this.editors.stop(), this.terminals.stop(),
      this.ownsAccounts && this.accounts ? this.accounts.stop() : Promise.resolve(ok(undefined))], "Checkpoint or runtime shutdown failed.");
    const openIntent = new Set(manifest.records.filter(record => record.lifecycle !== "closed").map(sessionRecordKey));
    const finished = this.registry.checkpointRecords.filter(record => !openIntent.has(sessionRecordKey(record)));
    if (!finished.length) return stopped;
    // Persist children that settled during shutdown without turning the frozen open main tabs into closed tabs.
    const records = new Map([...manifest.records, ...finished].map(record => [sessionRecordKey(record), record]));
    return collectCleanup([Promise.resolve(stopped), this.checkpoint({ ...manifest, records: [...records.values()] })], "Final session checkpoint or runtime shutdown failed.");
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
