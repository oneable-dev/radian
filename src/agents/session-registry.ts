import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Repository, Worktree } from "../workspace/model.ts";
import { repositorySnapshot, type RepositorySource } from "../workspace/catalog.ts";
import type { AgentStatus, Subagent } from "./model.ts";
import { AgentRunError, CancelledError, capture, CleanupError, collectCleanup, HistoryError, InputError, parseJson, SessionError, CapabilityError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { TranscriptSection } from "./transcript.ts";
import type { SessionTelemetry } from "./telemetry.ts";
import { filterCatalog, type CompletionCatalog, type CompletionItem, type CompletionQuery, type CompletionResult } from "./completion.ts";
import { completeFiles } from "./completion-files.ts";
import { sessionControlCommands } from "./session-controls.ts";
import { summarizeRequest, type RequestSummary } from "./request-summary.ts";
import type { TranscriptImageData } from "./transcript-images.ts";
import { modelCommand, parseModelCommand, type ModelCatalog, type ModelEffort, type ModelIdentity } from "./model-selection.ts";
import { historyCommand, parseHistoryCommand } from "./history-command.ts";
import { dashboardCommand, parseDashboardCommand } from "./dashboard-command.ts";
import { accountsCommand, parseAccountsCommand } from "../accounts/model.ts";
import { needsAttention, type SessionResult } from "./session-attention.ts";
import { sessionRecordKey, type SessionLifecycle, type SessionSnapshotInfo } from "./session-snapshot.ts";
import type { ExtensionUiState, ExtensionUiResponse, SessionExtensionUi } from "./extension-ui.ts";

export type ExecutionState = { readonly conversationId?: string; readonly resourceRevision?: number; readonly status: AgentStatus | null; readonly activity?: "compacting"; readonly output: string; readonly error: string | null;
  readonly sections?: readonly TranscriptSection[]; readonly telemetry?: SessionTelemetry;
  readonly request?: RequestSummary; readonly result?: SessionResult; readonly attention?: SessionResult;
  readonly externalSubagents?: readonly Subagent[];
  readonly pendingMessages?: readonly RequestSummary[]; readonly runTiming?: { readonly startedAt: number; readonly elapsedMs: number } };
export type SessionExecutor = {
  readonly savedSessionId: string;
  readonly sessionFile: string | undefined;
  readonly state: ExecutionState;
  readonly extensionUi?: ExtensionUiState | undefined;
  answerExtensionUi?(response: ExtensionUiResponse): Result<void, ExpectedError>;
  setUiActive?(active: boolean): void;
  commands?(): readonly CompletionItem[];
  reload?(): Promise<Result<void, ExpectedError>>;
  models?(signal?: AbortSignal): Promise<Result<ModelCatalog, ExpectedError>>;
  selectModel?(model: ModelIdentity, effort?: ModelEffort): Promise<Result<string | null, ExpectedError>>;
  imageData?(id: string): Result<TranscriptImageData, ExpectedError>;
  readonly acceptsImages?: boolean;
  readonly busy?: boolean;
  compact?(instructions?: string, onAccepted?: () => void): Promise<Result<void, ExpectedError>>;
  interrupt?(onAccepted?: () => void): Promise<Result<void, ExpectedError>>;
  subscribe(listener: () => void): () => void;
  // Resolves on run completion; the optional callback marks SDK input acceptance.
  prompt(text: string, onAccepted?: () => void, imagePaths?: readonly string[]): Promise<Result<void, ExpectedError>>;
  beforeNewSession?(): Promise<Result<void, ExpectedError>>;
  close(reason?: "quit" | "new"): Promise<Result<void, ExpectedError>>;
};
export type SessionContext = {
  readonly cwd: string;
  readonly worktreeId?: string;
  readonly sessionFile?: string;
  readonly previousSessionFile?: string;
  readonly startReason?: "new";
  readonly role: "main" | "subagent";
  isUiActive?: () => boolean;
  spawnSubagent(name: string, task: string, signal?: AbortSignal): Promise<Result<string, ExpectedError>>;
};
export type SessionRecord = {
  readonly id: string; readonly name: string; readonly worktreeId: string; readonly sessionFile?: string;
  readonly state: ExecutionState; readonly subagents: readonly Subagent[];
  readonly lifecycle?: SessionLifecycle; readonly updatedAt?: number; readonly cwd?: string;
  readonly closedAt?: number | null; readonly managed?: boolean;
};
// Creation is an exception-based SDK boundary. The registry converts only classified failures.
export type SessionFactory = (context: SessionContext) => Promise<SessionExecutor>;
type Execution = {
  readonly id: string; readonly name: string; readonly role: "main" | "subagent";
  ready: Promise<Result<SessionExecutor, ExpectedError>> | undefined;
  finishedStatus?: AgentStatus | null; fileKey?: string; executor?: SessionExecutor; unsubscribe?: () => void;
  cleanupTask?: Promise<Result<void, ExpectedError>>; failure?: string;
  request?: RequestSummary; runTiming?: Subagent["runTiming"];
  readonly worktree?: Worktree; readonly managed?: boolean; closedAt?: number;
};
type OpenExecution = Execution & {
  closeTask?: Promise<Result<void, ExpectedError>>;
  readonly worktree: Worktree; readonly children: Map<string, Execution>; readonly generation: string;
  phase: "creating" | "open" | "closing"; recoveredState?: ExecutionState; replacing?: boolean;
  observedResultId?: string | undefined; attention?: SessionResult | undefined;
};

export class SessionRegistry {
  private readonly entries = new Map<string, OpenExecution>();
  private readonly listeners = new Set<() => void>();
  private readonly fileOwners = new Map<string, string>();
  private readonly retired = new Map<string, SessionRecord>();
  private shuttingDown = false;
  private uiActive = false;
  private readonly replacements = new Set<Promise<Result<void, ExpectedError>>>();
  constructor(private readonly repositories: RepositorySource, private readonly factory: SessionFactory) {}

  setUiActive(active: boolean): void {
    this.uiActive = active;
    for (const entry of this.entries.values()) entry.executor?.setUiActive?.(active);
  }
  get extensionUi(): SessionExtensionUi[] {
    return [...this.entries.values()].flatMap(entry => {
      const state = entry.phase === "open" ? entry.executor?.extensionUi : undefined;
      return state && (state.dialog || state.notifications.length || Object.keys(state.statuses).length)
        ? [{ sessionId: entry.id, conversationId: entry.executor!.savedSessionId, ...state }] : [];
    });
  }
  answerExtensionUi(id: string, conversationId: string, response: ExtensionUiResponse): Result<void, ExpectedError> {
    const selected = this.requireOpen(id); if (!selected.ok) return selected;
    const entry = selected.value;
    if (entry.replacing || entry.executor?.savedSessionId !== conversationId) return err(new SessionError("SESSION_CONFLICT", "This tab changed conversations. No extension answer was delivered."));
    return entry.executor?.answerExtensionUi?.(response) ?? err(new CapabilityError("This session does not host extension dialogs."));
  }

  get retainedWorktreeIds(): ReadonlySet<string> { return new Set([...this.entries.values()].map((entry) => entry.worktree.id)); }

  get snapshot(): readonly Repository[] {
    return repositorySnapshot(this.repositories).map((repo) => ({ ...repo, worktrees: repo.worktrees.map((worktree) => ({ ...worktree,
      sessions: [...this.entries.values()].filter((entry) => entry.phase === "open" && entry.worktree.id === worktree.id).map((entry) => {
        const state = this.details(entry.id);
        return { id: entry.id, name: entry.name, status: state?.status ?? null, subagents: this.children(entry),
          ...(state?.request ? { request: state.request } : {}), ...(state?.result ? { result: state.result } : {}),
          ...(entry.attention ? { attention: entry.attention } : {}) };
      }),
    })) }));
  }
  get closingCount(): number { return [...this.entries.values()].filter((entry) => entry.phase === "closing").length; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  details(id: string): ExecutionState | null {
    const entry = this.entries.get(id);
    if (entry?.phase !== "open") return null;
    const live = entry.executor?.state;
    // Recovery keeps transcript/status history, but account usage continues updating in the live SDK.
    const state = entry.recoveredState ? { ...entry.recoveredState, ...(live?.conversationId ? { conversationId: live.conversationId } : {}), ...(live?.resourceRevision !== undefined ? { resourceRevision: live.resourceRevision } : {}), ...(live?.telemetry ? { telemetry: live.telemetry } : {}) } : live;
    if (!state) return null;
    // Replacement guards input admission; it must not invent model activity for /clear.
    return entry.attention ? { ...state, attention: entry.attention } : state;
  }

  acknowledge(id: string, conversationId: string, resultId: string): Result<void, ExpectedError> {
    const selected = this.requireOpen(id); if (!selected.ok) return selected;
    const entry = selected.value;
    if (entry.replacing || entry.executor!.savedSessionId !== conversationId) return err(new SessionError("SESSION_CONFLICT", "Conversation changed. No result was acknowledged."));
    // A delayed acknowledgement must never clear a newer result. Repeated acknowledgements are safe.
    if (entry.attention?.id === resultId) { delete entry.attention; this.emit(); }
    return ok(undefined);
  }

  private executionChanged(entry: OpenExecution): void {
    if (entry.phase !== "open") return;
    const result = entry.executor?.state.result;
    if (result && result.id !== entry.observedResultId) {
      entry.observedResultId = result.id;
      if (needsAttention(result)) entry.attention = result;
    }
    this.emit();
  }
  sessionFile(id: string): string | undefined { return this.entries.get(id)?.executor?.sessionFile; }
  imageData(sessionId: string, imageId: string): Result<TranscriptImageData, ExpectedError> {
    const entry = this.requireOpen(sessionId); if (!entry.ok) return entry;
    if (entry.value.replacing) return err(new SessionError("SESSION_BUSY", "This tab is changing conversations."));
    const executor = entry.value.executor;
    return executor?.imageData ? executor.imageData(imageId) : err(new CapabilityError("This session does not provide image previews."));
  }
  historyOwnership(canonicalFile: string): { openSessionId: string | null; unavailableReason: string | null } {
    const owner = this.fileOwners.get(canonicalFile);
    if (!owner) return { openSessionId: null, unavailableReason: null };
    if (owner.startsWith("retention:")) return { openSessionId: null, unavailableReason: "Saved session cleanup is in progress." };
    const entry = this.entries.get(owner);
    if (entry?.replacing) return { openSessionId: null, unavailableReason: "Saved session is being replaced. Wait for cleanup to finish." };
    if (entry?.phase === "open") return { openSessionId: entry.id, unavailableReason: null };
    return { openSessionId: null, unavailableReason: !entry ? "Saved session belongs to an active subagent."
      : entry.phase === "creating" ? "Saved session is being opened. Try again shortly." : "Session is still closing. Try again after cleanup." };
  }
  reserveSnapshotCleanup(snapshot: SessionSnapshotInfo, canonicalFile?: string): (() => void) | null {
    if (this.shuttingDown) return null;
    const current = this.sessionSnapshot(snapshot.worktreeId, snapshot.conversationId ?? snapshot.id);
    if (current && (current.lifecycle !== "closed" || current.closedAt !== snapshot.closedAt)) return null;
    if (canonicalFile && this.fileOwners.has(canonicalFile)) return null;
    const token = `retention:${crypto.randomUUID()}`;
    if (canonicalFile) this.fileOwners.set(canonicalFile, token);
    return () => { if (canonicalFile && this.fileOwners.get(canonicalFile) === token) this.fileOwners.delete(canonicalFile); };
  }
  get records(): readonly SessionRecord[] {
    return [...this.entries.values()].filter((entry) => entry.phase === "open").map((entry) => ({
      id: entry.id, name: entry.name, worktreeId: entry.worktree.id,
      ...(entry.fileKey ? { sessionFile: entry.fileKey } : entry.executor?.sessionFile ? { sessionFile: entry.executor.sessionFile } : {}),
      state: { ...(this.details(entry.id) ?? { status: null, output: "", error: null }), conversationId: entry.executor!.savedSessionId },
      subagents: this.children(entry), lifecycle: "open", closedAt: null, managed: entry.managed ?? false, cwd: entry.worktree.path,
    }));
  }
  sessionSnapshot(worktreeId: string, conversationId: string): SessionRecord | undefined {
    return this.records.find(record => record.worktreeId === worktreeId && record.state.conversationId === conversationId)
      ?? [...this.retired.values()].find(record => record.worktreeId === worktreeId && record.state.conversationId === conversationId);
  }
  // Retain closed records only until the shared store confirms persistence.
  get checkpointRecords(): readonly SessionRecord[] { return [...this.retired.values(), ...this.records]; }
  acknowledgeCheckpoint(records: readonly SessionRecord[]): void {
    for (const record of records) if (this.retired.get(sessionRecordKey(record)) === record) this.retired.delete(sessionRecordKey(record));
  }
  private retire(entry: OpenExecution, before?: SessionRecord): SessionRecord | undefined {
    return entry.executor ? this.retireExecution(entry, entry.worktree, this.children(entry), entry.executor, before) : undefined;
  }
  private retireExecution(entry: Execution, worktree: Worktree, subagents: readonly Subagent[], executor: SessionExecutor, before?: SessionRecord): SessionRecord {
    const state = executor.state, sessionFile = entry.fileKey ?? executor.sessionFile;
    const telemetry = before?.state.telemetry ?? state.telemetry;
    const interrupted = state.status === "working";
    const record: SessionRecord = { id: entry.id, name: entry.name, worktreeId: worktree.id, cwd: worktree.path,
      ...(sessionFile ? { sessionFile } : {}), lifecycle: "closed", closedAt: entry.closedAt ?? before?.closedAt ?? Date.now(),
      managed: entry.managed ?? false, updatedAt: Date.now(),
      state: { ...state, conversationId: executor.savedSessionId, ...(telemetry ? { telemetry } : {}),
        ...(interrupted ? { status: null, pendingMessages: [], result: { id: crypto.randomUUID(), outcome: "unfinished", completedAt: Date.now() } } : {}) },
      subagents };
    this.retired.set(sessionRecordKey(record), record); return record;
  }
  private children(entry: OpenExecution): Subagent[] {
    const owned = [...entry.children.values()].map((child): Subagent => {
      const state = child.executor?.state, request = state?.request ?? child.request, runTiming = state?.runTiming ?? child.runTiming;
      return { id: child.id, name: child.name, status: child.failure ? "failure" : state?.status ?? child.finishedStatus ?? null,
        ...(request ? { request } : {}), ...(runTiming ? { runTiming } : {}) };
    });
    // Pi extension children are display observations, never handles owned by this registry.
    return [...owned, ...(entry.executor?.state.externalSubagents ?? [])];
  }

  async restore(record: SessionRecord): Promise<Result<void, ExpectedError>> {
    if (record.lifecycle === "closed") return ok(undefined);
    const existence = await capture(async () => record.sessionFile ? Bun.file(record.sessionFile).exists() : false);
    if (!existence.ok) return existence;
    if (!existence.value && record.state.output) return err(new HistoryError("HISTORY_UNAVAILABLE", "Saved conversation file is missing; refusing to replace it with an empty session."));
    if (existence.value && record.sessionFile) {
      const validated = await validateHistory(record.sessionFile);
      if (!validated.ok) return validated;
    }
    const created = await this.create(record.worktreeId, existence.value ? record.sessionFile : undefined, record);
    if (!created.ok) return created;
    const selected = this.requireOpen(record.id);
    if (!selected.ok) return selected;
    const entry = selected.value;
    const restored = entry.executor!.state;
    const interrupted: SessionResult | undefined = record.state.status === "working"
      ? { id: crypto.randomUUID(), outcome: "unfinished", completedAt: Date.now(), ...(record.state.request ? { request: record.state.request } : {}) } : undefined;
    entry.attention = interrupted ?? record.state.attention;
    entry.recoveredState = {
      ...(record.state.request ?? restored.request ? { request: record.state.request ?? restored.request } : {}),
      ...(interrupted ?? record.state.result ? { result: interrupted ?? record.state.result } : {}),
      output: restored.output.length >= record.state.output.length ? restored.output : record.state.output,
      ...(restored.sections ? { sections: restored.sections } : record.state.sections ? { sections: record.state.sections } : {}),
      // Restore SDK-derived telemetry, never a saved account quota or Fast setting.
      ...(restored.telemetry ? { telemetry: restored.telemetry } : {}),
      status: record.state.status === "working" ? null : restored.status,
      error: record.state.status === "working" ? "Previous runtime ended during this run; submit a new prompt to continue." : restored.error,
    };
    for (const child of record.subagents.filter(child => child.source !== "pi")) entry.children.set(child.id, { id: child.id, name: child.name, role: "subagent", ready: undefined,
      ...(child.request ? { request: child.request } : {}), ...(child.runTiming ? { runTiming: child.runTiming } : {}),
      finishedStatus: child.status === "working" ? null : child.status });
    this.emit(); return ok(undefined);
  }

  async create(worktreeId: string, sessionFile?: string, identity?: { readonly id: string; readonly name: string; readonly managed?: boolean }): Promise<Result<string, ExpectedError>> {
    if (this.shuttingDown) return err(this.stopping());
    const worktree = repositorySnapshot(this.repositories).flatMap((repo) => repo.worktrees).find((tree) => tree.id === worktreeId);
    if (!worktree) return err(new InputError(`Unknown worktree: ${worktreeId}`));
    const canonical = sessionFile ? await capture(() => realpath(sessionFile)) : ok(undefined);
    if (!canonical.ok) return canonical;
    if (this.shuttingDown) return err(this.stopping());
    const requestedFile = canonical.value;
    if (requestedFile && this.fileOwners.has(requestedFile)) return err(new SessionError("SESSION_CONFLICT", "This saved session is already open or still closing."));
    const id = identity?.id ?? crypto.randomUUID();
    if (this.entries.has(id)) return err(new SessionError("SESSION_CONFLICT", "This open-session ID already exists."));
    if (requestedFile) this.fileOwners.set(requestedFile, id);
    const generation = crypto.randomUUID();
    const ready = capture(() => this.factory({ cwd: worktree.path, worktreeId: worktree.id, role: "main", isUiActive: () => this.uiActive, ...(requestedFile ? { sessionFile: requestedFile } : {}),
      spawnSubagent: (name, task, signal) => this.spawnSubagent(id, name, task, signal, generation) }));
    const entry: OpenExecution = { id, name: identity?.name ?? `Session ${id.slice(0, 8)}`, role: "main", worktree, ready, generation,
      phase: "creating", children: new Map(), managed: identity?.managed ?? !requestedFile, ...(requestedFile ? { fileKey: requestedFile } : {}) };
    this.entries.set(id, entry);
    let result: Result<string, ExpectedError>;
    try { result = await this.initialize(entry, ready, requestedFile); }
    catch (error) {
      // Unexpected bugs still need cleanup; preserve both the original and any cleanup exception.
      if (entry.phase === "creating" && !entry.executor) {
        this.entries.delete(id);
        if (entry.fileKey && this.fileOwners.get(entry.fileKey) === id) this.fileOwners.delete(entry.fileKey);
      } else if (entry.phase === "creating") {
        try { const cleanup = await this.close(id); if (!cleanup.ok) throw cleanup.error; }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], "Creation and cleanup failed."); }
      }
      throw error;
    }
    if (!result.ok && entry.phase === "creating") {
      const cleanup = await this.close(id);
      if (!cleanup.ok) return err(new CleanupError("Creation and cleanup failed.", [result.error, cleanup.error]));
    }
    return result;
  }
  private async initialize(entry: OpenExecution, ready: NonNullable<Execution["ready"]>, requestedFile?: string): Promise<Result<string, ExpectedError>> {
    const created = await ready;
    if (!created.ok) return created;
    entry.executor = created.value;
    const key = await capture(() => this.fileKey(created.value));
    if (!key.ok) return key;
    if (entry.phase !== "creating") return err(new CancelledError("Session creation was cancelled by shutdown."));
    if (requestedFile && key.value !== requestedFile) throw new Error("Executor did not reopen the requested saved session.");
    if (key.value) {
      const owner = this.fileOwners.get(key.value);
      if (owner && owner !== entry.id) return err(new SessionError("SESSION_CONFLICT", "This saved session is already open or still closing."));
      entry.fileKey = key.value; this.fileOwners.set(key.value, entry.id);
    }
    // Opening History and upgrading old manifests establishes a baseline, not a new notification.
    entry.observedResultId = created.value.state.result?.id;
    entry.unsubscribe = created.value.subscribe(() => this.executionChanged(entry));
    entry.phase = "open"; this.emit(); return ok(entry.id);
  }
  async complete(id: string, query: CompletionQuery, signal?: AbortSignal): Promise<Result<CompletionResult, ExpectedError>> {
    if (signal?.aborted) return err(new CancelledError());
    const selected = this.requireOpen(id);
    if (!selected.ok) return selected;
    const entry = selected.value;
    if (query.kind === "file") {
      const result = await completeFiles(entry.worktree.path, query.query, signal);
      return entry.phase === "open" ? result : err(new SessionError("SESSION_NOT_OPEN", "Session closed during file discovery."));
    }
    const catalog = this.catalog(id, entry.executor!.savedSessionId);
    return catalog.ok ? ok(filterCatalog(catalog.value.items, query)) : catalog;
  }

  catalog(id: string, conversationId: string): Result<CompletionCatalog, ExpectedError> {
    const selected = this.requireOpen(id); if (!selected.ok) return selected;
    const entry = selected.value;
    if (entry.replacing || entry.executor?.savedSessionId !== conversationId) return err(new SessionError("SESSION_CONFLICT", "Conversation changed while loading completion resources."));
    const executor = entry.executor!;
    const controls = [...sessionControlCommands.filter(item => item.value === "compact" ? !!executor.compact : item.value === "reload" ? !!executor.reload : true),
      ...(executor.models && executor.selectModel ? [modelCommand] : []), historyCommand, dashboardCommand, accountsCommand];
    const extra = executor.commands?.() ?? [];
    return ok({ conversationId, revision: executor.state.resourceRevision ?? 0,
      items: [...controls, ...extra.filter(item => !controls.some(control => control.value === item.value))] });
  }

  reload(id: string): Promise<Result<void, ExpectedError>> {
    const selected = this.requireOpen(id); if (!selected.ok) return Promise.resolve(selected);
    const entry = selected.value;
    if (entry.replacing || [...entry.children.values()].some(child => child.executor?.busy || child.executor?.state.status === "working" || child.ready && !child.executor))
      return Promise.resolve(err(new SessionError("SESSION_BUSY", "Wait for this conversation and its owned work before reloading resources.")));
    return entry.executor?.reload ? entry.executor.reload() : Promise.resolve(err(new CapabilityError("This executor does not support resource reload.")));
  }

  async models(id: string, conversationId: string, signal?: AbortSignal): Promise<Result<ModelCatalog, ExpectedError>> {
    const selected = this.modelOwner(id, conversationId); if (!selected.ok) return selected;
    const executor = selected.value.executor;
    if (!executor?.models) return err(new CapabilityError("This executor does not support model selection."));
    const result = await executor.models(signal);
    const current = this.modelOwner(id, conversationId); if (!current.ok) return current;
    return signal?.aborted ? err(new CancelledError()) : result;
  }

  async selectModel(id: string, conversationId: string, model: ModelIdentity, effort?: ModelEffort): Promise<Result<string | null, ExpectedError>> {
    const selected = this.modelOwner(id, conversationId); if (!selected.ok) return selected;
    const executor = selected.value.executor;
    if (!executor?.selectModel) return err(new CapabilityError("This executor does not support model selection."));
    return executor.selectModel(model, effort);
  }

  private modelOwner(id: string, conversationId: string): Result<OpenExecution, ExpectedError> {
    const selected = this.requireOpen(id); if (!selected.ok) return selected;
    if (selected.value.replacing) return err(new SessionError("SESSION_BUSY", "This tab is changing conversations."));
    if (selected.value.executor?.savedSessionId !== conversationId) return err(new SessionError("SESSION_CONFLICT", "This tab changed conversations. Reopen /model before selecting a model."));
    return selected;
  }

  async prompt(id: string, text: string, onAccepted?: () => void, imagePaths: readonly string[] = []): Promise<Result<void, ExpectedError>> {
    const dashboard = parseDashboardCommand(text); if (!dashboard.ok) return dashboard;
    if (dashboard.value) return err(new CapabilityError("Use /dashboard in the Agent input to open usage statistics. No model prompt was sent."));
    const history = parseHistoryCommand(text); if (!history.ok) return history;
    if (history.value) return err(new CapabilityError("Use /history in the Agent input to open saved session history. No model prompt was sent."));
    const accounts = parseAccountsCommand(text); if (!accounts.ok) return accounts;
    if (accounts.value) return err(new CapabilityError("Use /accounts in the Agent input to manage accounts. No model prompt was sent."));
    const model = parseModelCommand(text); if (!model.ok) return model;
    if (model.value) return err(new CapabilityError("Use /model in the Agent input to open the model picker. No model prompt was sent."));
    const selected = this.requireOpen(id);
    if (!selected.ok) return selected;
    if (selected.value.replacing) return err(new SessionError("SESSION_BUSY", "This tab is changing sessions. Input was retained."));
    if (!text.trim()) return err(new InputError("A prompt must not be empty."));
    if (imagePaths.length && !selected.value.executor?.acceptsImages) return err(new CapabilityError("The selected model does not accept image input. Switch models or remove the image; input was retained."));
    const entry = selected.value;
    let accepted = false;
    const accept = () => {
      if (accepted) return;
      accepted = true;
      if (entry.recoveredState) { delete entry.recoveredState; this.emit(); }
      onAccepted?.();
    };
    const result = await entry.executor!.prompt(text, accept, imagePaths.map((path) => resolve(entry.worktree.path, path)));
    // Executors without an admission callback can prove acceptance only on success.
    if (result.ok && !accepted) accept();
    return result;
  }
  compact(id: string, instructions?: string, onAccepted?: () => void): Promise<Result<void, ExpectedError>> {
    const selected = this.requireOpen(id); if (!selected.ok) return Promise.resolve(selected);
    const entry = selected.value;
    if (entry.replacing) return Promise.resolve(err(new SessionError("SESSION_BUSY", "This tab is changing sessions.")));
    if ([...entry.children.values()].some((child) => child.executor?.busy || child.executor?.state.status === "working" || child.ready && !child.executor)) return Promise.resolve(err(new SessionError("SESSION_BUSY", "Wait for this session's owned work to finish before compacting.")));
    if (!entry.executor?.compact) return Promise.resolve(err(new CapabilityError("This executor does not support manual compaction.")));
    return entry.executor.compact(instructions, () => { delete entry.recoveredState; onAccepted?.(); });
  }

  interrupt(id: string, onAccepted?: () => void): Promise<Result<void, ExpectedError>> {
    const selected = this.requireOpen(id); if (!selected.ok) return Promise.resolve(selected);
    const entry = selected.value;
    if (entry.replacing) return Promise.resolve(err(new SessionError("SESSION_BUSY", "This tab is changing sessions. No interrupt was accepted.")));
    if (!entry.executor?.interrupt) return Promise.resolve(err(new CapabilityError("This executor does not support interruption.")));
    return entry.executor.interrupt(onAccepted);
  }

  newTab(id: string): Promise<Result<string, ExpectedError>> {
    const selected = this.requireOpen(id); if (!selected.ok) return Promise.resolve(selected);
    if (selected.value.replacing) return Promise.resolve(err(new SessionError("SESSION_BUSY", "This tab is changing conversations. No new tab was created.")));
    return this.create(selected.value.worktree.id);
  }

  clearSession(id: string, onAccepted?: () => void): Promise<Result<void, ExpectedError>> {
    const selected = this.requireOpen(id); if (!selected.ok) return Promise.resolve(selected);
    const previous = selected.value;
    if (previous.replacing) return Promise.resolve(err(new SessionError("SESSION_BUSY", "This tab is already changing sessions.")));
    previous.replacing = true; this.emit();
    const task = this.replaceSession(previous, onAccepted).finally(() => { previous.replacing = false; this.replacements.delete(task); this.emit(); });
    this.replacements.add(task); return task;
  }
  private async replaceSession(previous: OpenExecution, onAccepted?: () => void): Promise<Result<void, ExpectedError>> {
    // Prepare a distinct SDK conversation before interrupting the old one. A
    // failed factory must not discard a working tab or its on-disk history.
    const allowed = await previous.executor?.beforeNewSession?.();
    if (allowed && !allowed.ok) return allowed;
    if (this.shuttingDown || previous.phase !== "open") return err(new CancelledError("Session replacement was cancelled by shutdown."));
    const generation = crypto.randomUUID();
    const previousSessionFile = previous.executor?.sessionFile;
    const ready = capture(() => this.factory({ cwd: previous.worktree.path, worktreeId: previous.worktree.id, role: "main", isUiActive: () => this.uiActive, startReason: "new", ...(previousSessionFile ? { previousSessionFile } : {}),
      spawnSubagent: (name, task, signal) => this.spawnSubagent(previous.id, name, task, signal, generation) }));
    const created = await ready; if (!created.ok) return created;
    const next = created.value;
    let stopping = false, adopted = false;
    let result: Result<void, ExpectedError>;
    try {
      const key = await capture(() => this.fileKey(next));
      if (!key.ok) result = key;
      else if (next.savedSessionId === previous.executor?.savedSessionId || key.value && this.fileOwners.has(key.value)) result = err(new SessionError("SESSION_CONFLICT", "Replacement did not create a distinct conversation."));
      else if (this.shuttingDown || previous.phase !== "open") result = err(new CancelledError("Session replacement was cancelled by shutdown."));
      else {
        onAccepted?.(); stopping = true;
        previous.closedAt = Date.now();
        const archived = this.retire(previous);
        // Explicit /clear stops only the execution owned by this tab. Keep its file
        // fenced until all parent/child tool results have settled and persisted.
        const stopped = await collectCleanup([this.closeExecution(previous, "new"), ...[...previous.children.values()].map((child) => this.closeExecution(child, "new"))], "Could not finish the previous conversation.");
        if (!stopped.ok) {
          previous.recoveredState = { ...previous.executor!.state, status: "failure", error: "Session replacement could not confirm cleanup of the previous conversation. Inspect the cleanup error before retrying." };
          result = err(new AgentRunError(previous.recoveredState.error!, { cause: stopped.error }));
        } else if (this.shuttingDown || previous.phase !== "open") result = err(new CancelledError("Session replacement was cancelled by shutdown."));
        else {
          const replacement: OpenExecution = { id: previous.id, name: previous.name, role: "main", worktree: previous.worktree,
            phase: "open", children: new Map(), ready, executor: next, generation, managed: true, ...(key.value ? { fileKey: key.value } : {}) };
          replacement.observedResultId = next.state.result?.id;
          replacement.unsubscribe = next.subscribe(() => this.executionChanged(replacement));
          previous.unsubscribe?.(); delete previous.unsubscribe;
          if (previous.fileKey && this.fileOwners.get(previous.fileKey) === previous.id) this.fileOwners.delete(previous.fileKey);
          if (key.value) this.fileOwners.set(key.value, replacement.id);
          this.retire(previous, archived);
          this.entries.set(previous.id, replacement); adopted = true; this.emit(); return ok(undefined);
        }
      }
    } catch (error) {
      if (adopted) throw error;
      if (stopping) previous.recoveredState = { ...previous.executor!.state, status: "failure", error: "Unexpected session replacement failure. Inspect runtime.log before retrying." };
      try { const cleanup = await next.close(); if (!cleanup.ok) throw cleanup.error; }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Replacement and cleanup failed."); }
      throw error;
    }
    const cleanup = await next.close();
    return cleanup.ok ? result : err(new CleanupError("Replacement and cleanup failed.", [...(!result.ok ? [result.error] : []), cleanup.error]));
  }

  close(id: string): Promise<Result<void, ExpectedError>> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve(ok(undefined));
    if (entry.closeTask) return entry.closeTask;
    if (entry.phase !== "closing") entry.closedAt = Date.now();
    const archived = this.retire(entry);
    entry.phase = "closing";
    const task = Promise.resolve().then(async () => {
      const result = await collectCleanup([this.closeExecution(entry), ...[...entry.children.values()].map((child) => this.closeExecution(child))], `Could not finish closing ${entry.name}`);
      if (!result.ok) { delete entry.closeTask; this.emit(); return result; }
      this.retire(entry, archived);
      this.entries.delete(id);
      if (entry.fileKey && this.fileOwners.get(entry.fileKey) === id) this.fileOwners.delete(entry.fileKey);
      this.emit(); return ok(undefined);
    });
    entry.closeTask = task;
    // Reset retries for unexpected exceptions too, without consuming the caller's rejected task.
    void task.catch(() => { delete entry.closeTask; });
    this.emit(); return task;
  }
  async shutdown(): Promise<Result<void, ExpectedError>> {
    this.shuttingDown = true;
    return collectCleanup([...this.entries.keys()].map((id) => this.close(id)).concat([...this.replacements].map((task) => task.then(() => ok(undefined)))), "Some session executions could not be shut down.");
  }
  private async spawnSubagent(ownerId: string, name: string, task: string, signal?: AbortSignal, generation?: string): Promise<Result<string, ExpectedError>> {
    const selected = this.requireOpen(ownerId);
    if (!selected.ok) return selected;
    if (signal?.aborted) return err(new CancelledError());
    const owner = selected.value;
    if (generation && generation !== owner.generation) return err(new SessionError("SESSION_CONFLICT", "The originating conversation is no longer active in this tab."));
    if (owner.replacing) return err(new SessionError("SESSION_BUSY", "This conversation is being replaced."));
    const ready = capture(() => this.factory({ cwd: owner.worktree.path, worktreeId: owner.worktree.id, role: "subagent",
      spawnSubagent: async () => err(new InputError("Nested delegation is not enabled.")) }));
    const child: Execution = { id: crypto.randomUUID(), name, role: "subagent", ready, worktree: owner.worktree, managed: true,
      request: summarizeRequest(task, 0) };
    owner.children.set(child.id, child); this.emit();
    let cancelTask: Promise<Result<void, ExpectedError>> | undefined;
    const cancel = () => {
      cancelTask = this.closeExecution(child);
      // The event callback cannot await. Observe now; the same task is awaited below, not discarded.
      void cancelTask.catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    let result: Result<string, ExpectedError>;
    try { result = await this.runChild(owner, child, ready, task, signal); }
    catch (error) {
      try { const cleanup = await this.closeExecution(child); if (!cleanup.ok) throw cleanup.error; }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Subagent execution and cleanup failed."); }
      throw error;
    } finally { signal?.removeEventListener("abort", cancel); }
    if (!result.ok && !(result.error instanceof CancelledError) && owner.phase === "open") { child.failure = result.error.message; this.emit(); }
    const cleanup = await (cancelTask ?? this.closeExecution(child));
    if (!cleanup.ok) {
      child.failure = cleanup.error.message; if (owner.phase === "open") this.emit();
      return result.ok ? cleanup : err(new CleanupError("Subagent execution and cleanup failed.", [result.error, cleanup.error]));
    }
    return result;
  }
  private async runChild(owner: OpenExecution, child: Execution, ready: NonNullable<Execution["ready"]>, task: string, signal?: AbortSignal): Promise<Result<string, ExpectedError>> {
    const created = await ready;
    if (!created.ok) return created;
    const executor = created.value; child.executor = executor;
    const key = await capture(() => this.fileKey(executor)); if (!key.ok) return key;
    const selected = this.requireOpen(owner.id); if (!selected.ok) return selected;
    if (signal?.aborted) return err(new CancelledError());
    if (key.value) {
      if (this.fileOwners.has(key.value)) return err(new SessionError("SESSION_CONFLICT", "The subagent saved session already has a writer."));
      child.fileKey = key.value; this.fileOwners.set(key.value, child.id);
    }
    child.unsubscribe = executor.subscribe(() => { if (owner.phase === "open") this.emit(); }); this.emit();
    const startedAt = Date.now(), started = performance.now();
    child.runTiming = { startedAt, elapsedMs: 0 };
    let run: Result<void, ExpectedError>;
    try { run = await executor.prompt(task); }
    finally { child.runTiming = { startedAt, elapsedMs: Math.max(0, performance.now() - started) }; }
    if (!run.ok) return run;
    if (signal?.aborted) return err(new CancelledError());
    if (executor.state.status === "failure") return err(new AgentRunError(executor.state.error ?? "Subagent failed."));
    return ok(executor.state.output);
  }
  private closeExecution(execution: Execution, reason: "quit" | "new" = "quit"): Promise<Result<void, ExpectedError>> {
    if (execution.cleanupTask) return execution.cleanupTask;
    const ready = execution.ready; if (!ready) return Promise.resolve(ok(undefined));
    const task = (async (): Promise<Result<void, ExpectedError>> => {
      const created = await ready;
      if (!created.ok) return ok(undefined); // Factory failure is returned to create/runChild; no handle exists.
      const tree = execution.role === "subagent" ? execution.worktree : undefined;
      if (tree) execution.closedAt ??= Date.now();
      const archived = tree ? this.retireExecution(execution, tree, [], created.value) : undefined;
      const closed = await created.value.close(reason);
      if (!closed.ok) { delete execution.cleanupTask; return closed; }
      execution.unsubscribe?.(); delete execution.unsubscribe;
      if (execution.role === "subagent") {
        if (tree) this.retireExecution(execution, tree, [], created.value, archived);
        if (execution.fileKey && this.fileOwners.get(execution.fileKey) === execution.id) this.fileOwners.delete(execution.fileKey);
        execution.finishedStatus = created.value.state.status; execution.ready = undefined; delete execution.executor;
        this.emit();
      }
      return ok(undefined);
    })();
    execution.cleanupTask = task; void task.catch(() => { delete execution.cleanupTask; }); return task;
  }
  private async fileKey(executor: SessionExecutor): Promise<string | undefined> {
    const file = executor.sessionFile; return file ? join(await realpath(dirname(file)), basename(file)) : undefined;
  }
  private requireOpen(id: string): Result<OpenExecution, SessionError> {
    if (this.shuttingDown) return err(this.stopping());
    const entry = this.entries.get(id);
    return !entry || entry.phase !== "open" || !entry.executor ? err(new SessionError("SESSION_NOT_OPEN", "Session is not open.")) : ok(entry);
  }
  private stopping(): SessionError { return new SessionError("RUNTIME_STOPPING", "Session registry is shutting down."); }
  private emit(): void { for (const listener of this.listeners) listener(); }
}

export async function validateHistory(file: string): Promise<Result<void, ExpectedError>> {
  const read = await capture(() => Bun.file(file).text()); if (!read.ok) return read;
  const lines = read.value.split("\n").filter((line) => line.trim());
  if (!lines.length) return err(new HistoryError("HISTORY_CORRUPT", "Saved conversation file has no valid session header; refusing to overwrite it."));
  for (const [index, line] of lines.entries()) {
    const parsed = parseJson(line, "saved conversation");
    if (!parsed.ok) return err(new HistoryError("HISTORY_CORRUPT", parsed.error.message, { cause: parsed.error }));
    const value = parsed.value;
    if (index === 0 && (!value || typeof value !== "object" || !("type" in value) || value.type !== "session")) {
      return err(new HistoryError("HISTORY_CORRUPT", "Saved conversation file has no valid session header; refusing to overwrite it."));
    }
  }
  return ok(undefined);
}
