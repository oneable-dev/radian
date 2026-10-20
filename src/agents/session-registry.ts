import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Repository, Worktree } from "../workspace/model.ts";
import { repositorySnapshot, type RepositorySource } from "../workspace/catalog.ts";
import type { AgentStatus, Subagent } from "./model.ts";
import { AgentRunError, CancelledError, capture, CleanupError, collectCleanup, HistoryError, InputError, parseJson, SessionError, CapabilityError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { TranscriptSection } from "./transcript.ts";
import type { SessionTelemetry } from "./telemetry.ts";
import { filterCompletions, type CompletionItem, type CompletionQuery, type CompletionResult } from "./completion.ts";
import { completeFiles } from "./completion-files.ts";
import { sessionControlCommands } from "./session-controls.ts";
import type { RequestSummary } from "./request-summary.ts";
import type { TranscriptImageData } from "./transcript-images.ts";
import { modelCommand, parseModelCommand, type ModelCatalog, type ModelEffort, type ModelIdentity } from "./model-selection.ts";

export type ExecutionState = { readonly conversationId?: string; readonly status: AgentStatus | null; readonly activity?: "compacting"; readonly output: string; readonly error: string | null;
  readonly sections?: readonly TranscriptSection[]; readonly telemetry?: SessionTelemetry;
  readonly pendingMessages?: readonly RequestSummary[]; readonly runTiming?: { readonly startedAt: number; readonly elapsedMs: number } };
export type SessionExecutor = {
  readonly savedSessionId: string;
  readonly sessionFile: string | undefined;
  readonly state: ExecutionState;
  commands?(): readonly CompletionItem[];
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
  readonly sessionFile?: string;
  readonly previousSessionFile?: string;
  readonly startReason?: "new";
  readonly role: "main" | "subagent";
  spawnSubagent(name: string, task: string, signal?: AbortSignal): Promise<Result<string, ExpectedError>>;
};
export type SessionRecord = {
  readonly id: string; readonly name: string; readonly worktreeId: string; readonly sessionFile?: string;
  readonly state: ExecutionState; readonly subagents: readonly Subagent[];
};
// Creation is an exception-based SDK boundary. The registry converts only classified failures.
export type SessionFactory = (context: SessionContext) => Promise<SessionExecutor>;
type Execution = {
  readonly id: string; readonly name: string; readonly role: "main" | "subagent";
  ready: Promise<Result<SessionExecutor, ExpectedError>> | undefined;
  finishedStatus?: AgentStatus | null; fileKey?: string; executor?: SessionExecutor; unsubscribe?: () => void;
  cleanupTask?: Promise<Result<void, ExpectedError>>; failure?: string;
};
type OpenExecution = Execution & {
  closeTask?: Promise<Result<void, ExpectedError>>;
  readonly worktree: Worktree; readonly children: Map<string, Execution>; readonly generation: string;
  phase: "creating" | "open" | "closing"; recoveredState?: ExecutionState; replacing?: boolean;
};

export class SessionRegistry {
  private readonly entries = new Map<string, OpenExecution>();
  private readonly listeners = new Set<() => void>();
  private readonly fileOwners = new Map<string, string>();
  private shuttingDown = false;
  private readonly replacements = new Set<Promise<Result<void, ExpectedError>>>();
  constructor(private readonly repositories: RepositorySource, private readonly factory: SessionFactory) {}

  get retainedWorktreeIds(): ReadonlySet<string> { return new Set([...this.entries.values()].map((entry) => entry.worktree.id)); }

  get snapshot(): readonly Repository[] {
    return repositorySnapshot(this.repositories).map((repo) => ({ ...repo, worktrees: repo.worktrees.map((worktree) => ({ ...worktree,
      sessions: [...this.entries.values()].filter((entry) => entry.phase === "open" && entry.worktree.id === worktree.id).map((entry) => ({
        id: entry.id, name: entry.name, status: entry.replacing ? "working" : entry.recoveredState ? entry.recoveredState.status : entry.executor?.state.status ?? null,
        subagents: this.children(entry),
      })),
    })) }));
  }
  get closingCount(): number { return [...this.entries.values()].filter((entry) => entry.phase === "closing").length; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  details(id: string): ExecutionState | null {
    const entry = this.entries.get(id);
    if (entry?.phase !== "open") return null;
    const live = entry.executor?.state;
    // Recovery keeps transcript/status history, but account usage continues updating in the live SDK.
    const state = entry.recoveredState ? { ...entry.recoveredState, ...(live?.conversationId ? { conversationId: live.conversationId } : {}), ...(live?.telemetry ? { telemetry: live.telemetry } : {}) } : live;
    return state && entry.replacing ? { ...state, status: "working" } : state ?? null;
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
    const entry = this.entries.get(owner);
    if (entry?.replacing) return { openSessionId: null, unavailableReason: "Saved session is being replaced. Wait for cleanup to finish." };
    if (entry?.phase === "open") return { openSessionId: entry.id, unavailableReason: null };
    return { openSessionId: null, unavailableReason: !entry ? "Saved session belongs to an active subagent."
      : entry.phase === "creating" ? "Saved session is being opened. Try again shortly." : "Session is still closing. Try again after cleanup." };
  }
  get records(): readonly SessionRecord[] {
    return [...this.entries.values()].filter((entry) => entry.phase === "open").map((entry) => ({
      id: entry.id, name: entry.name, worktreeId: entry.worktree.id,
      ...(entry.executor?.sessionFile ? { sessionFile: entry.executor.sessionFile } : {}),
      state: this.details(entry.id) ?? { status: null, output: "", error: null }, subagents: this.children(entry),
    }));
  }
  private children(entry: OpenExecution): Subagent[] {
    return [...entry.children.values()].map((child) => ({ id: child.id, name: child.name,
      status: child.failure ? "failure" : child.executor?.state.status ?? child.finishedStatus ?? null }));
  }

  async restore(record: SessionRecord): Promise<Result<void, ExpectedError>> {
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
    entry.recoveredState = {
      output: restored.output.length >= record.state.output.length ? restored.output : record.state.output,
      ...(restored.sections ? { sections: restored.sections } : record.state.sections ? { sections: record.state.sections } : {}),
      // Restore SDK-derived telemetry, never a saved account quota or Fast setting.
      ...(restored.telemetry ? { telemetry: restored.telemetry } : {}),
      status: record.state.status === "working" ? null : restored.status,
      error: record.state.status === "working" ? "Previous runtime ended during this run; submit a new prompt to continue." : restored.error,
    };
    for (const child of record.subagents) entry.children.set(child.id, { id: child.id, name: child.name, role: "subagent", ready: undefined,
      finishedStatus: child.status === "working" ? null : child.status });
    this.emit(); return ok(undefined);
  }

  async create(worktreeId: string, sessionFile?: string, identity?: { readonly id: string; readonly name: string }): Promise<Result<string, ExpectedError>> {
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
    const ready = capture(() => this.factory({ cwd: worktree.path, role: "main", ...(requestedFile ? { sessionFile: requestedFile } : {}),
      spawnSubagent: (name, task, signal) => this.spawnSubagent(id, name, task, signal, generation) }));
    const entry: OpenExecution = { id, name: identity?.name ?? `Session ${id.slice(0, 8)}`, role: "main", worktree, ready, generation,
      phase: "creating", children: new Map(), ...(requestedFile ? { fileKey: requestedFile } : {}) };
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
    entry.unsubscribe = created.value.subscribe(() => { if (entry.phase === "open") this.emit(); });
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
    const commands = entry.executor?.commands;
    const controls = [...sessionControlCommands.filter((item) => item.value !== "compact" || entry.executor?.compact),
      ...(entry.executor?.models && entry.executor.selectModel ? [modelCommand] : [])];
    const extra = commands?.call(entry.executor) ?? [];
    return ok(filterCompletions([...controls, ...extra.filter((item) => !controls.some((control) => control.value === item.value))], query.query));
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
    const ready = capture(() => this.factory({ cwd: previous.worktree.path, role: "main", startReason: "new", ...(previousSessionFile ? { previousSessionFile } : {}),
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
        // Explicit /clear stops only the execution owned by this tab. Keep its file
        // fenced until all parent/child tool results have settled and persisted.
        const stopped = await collectCleanup([this.closeExecution(previous, "new"), ...[...previous.children.values()].map((child) => this.closeExecution(child, "new"))], "Could not finish the previous conversation.");
        if (!stopped.ok) {
          previous.recoveredState = { ...previous.executor!.state, status: "failure", error: "Session replacement could not confirm cleanup of the previous conversation. Inspect the cleanup error before retrying." };
          result = err(new AgentRunError(previous.recoveredState.error!, { cause: stopped.error }));
        } else if (this.shuttingDown || previous.phase !== "open") result = err(new CancelledError("Session replacement was cancelled by shutdown."));
        else {
          const replacement: OpenExecution = { id: previous.id, name: previous.name, role: "main", worktree: previous.worktree,
            phase: "open", children: new Map(), ready, executor: next, generation, ...(key.value ? { fileKey: key.value } : {}) };
          replacement.unsubscribe = next.subscribe(() => { if (replacement.phase === "open") this.emit(); });
          previous.unsubscribe?.(); delete previous.unsubscribe;
          if (previous.fileKey && this.fileOwners.get(previous.fileKey) === previous.id) this.fileOwners.delete(previous.fileKey);
          if (key.value) this.fileOwners.set(key.value, replacement.id);
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
    entry.phase = "closing";
    const task = Promise.resolve().then(async () => {
      const result = await collectCleanup([this.closeExecution(entry), ...[...entry.children.values()].map((child) => this.closeExecution(child))], `Could not finish closing ${entry.name}`);
      if (!result.ok) { delete entry.closeTask; this.emit(); return result; }
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
    const ready = capture(() => this.factory({ cwd: owner.worktree.path, role: "subagent",
      spawnSubagent: async () => err(new InputError("Nested delegation is not enabled.")) }));
    const child: Execution = { id: crypto.randomUUID(), name, role: "subagent", ready };
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
    const run = await executor.prompt(task); if (!run.ok) return run;
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
      const closed = await created.value.close(reason);
      if (!closed.ok) { delete execution.cleanupTask; return closed; }
      execution.unsubscribe?.(); delete execution.unsubscribe;
      if (execution.role === "subagent") {
        if (execution.fileKey && this.fileOwners.get(execution.fileKey) === execution.id) this.fileOwners.delete(execution.fileKey);
        execution.finishedStatus = created.value.state.status; execution.ready = undefined; delete execution.executor;
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
