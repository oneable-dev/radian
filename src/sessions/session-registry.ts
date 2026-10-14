import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AgentStatus, Repository, Subagent, Worktree } from "../workspace/model.ts";

export type ExecutionState = {
  readonly status: AgentStatus | null;
  readonly output: string;
  readonly error: string | null;
};

export type SessionExecutor = {
  readonly savedSessionId: string;
  readonly sessionFile: string | undefined;
  readonly state: ExecutionState;
  subscribe(listener: () => void): () => void;
  prompt(text: string): Promise<void>;
  close(): Promise<void>;
};

export type SessionContext = {
  readonly cwd: string;
  readonly sessionFile?: string;
  readonly role: "main" | "subagent";
  spawnSubagent(name: string, task: string, signal?: AbortSignal): Promise<string>;
};

export type SessionRecord = {
  readonly id: string;
  readonly name: string;
  readonly worktreeId: string;
  readonly sessionFile?: string;
  readonly state: ExecutionState;
  readonly subagents: readonly Subagent[];
};

export type SessionFactory = (context: SessionContext) => Promise<SessionExecutor>;

type Execution = {
  readonly id: string;
  readonly name: string;
  readonly role: "main" | "subagent";
  ready: Promise<SessionExecutor> | undefined;
  finishedStatus?: AgentStatus | null;
  fileKey?: string;
  executor?: SessionExecutor;
  unsubscribe?: () => void;
  cleanupTask?: Promise<void>;
  failure?: string;
};

type OpenExecution = Execution & {
  closeTask?: Promise<void>;
  readonly worktree: Worktree;
  readonly children: Map<string, Execution>;
  phase: "creating" | "open" | "closing";
  recoveredState?: ExecutionState;
};

// UI selection is deliberately absent: renderable/selection lifetimes never own executions.
export class SessionRegistry {
  private readonly entries = new Map<string, OpenExecution>();
  private readonly listeners = new Set<() => void>();
  private readonly fileOwners = new Map<string, string>();
  private shuttingDown = false;

  constructor(private readonly repositories: readonly Repository[], private readonly factory: SessionFactory) {}

  get snapshot(): readonly Repository[] {
    return this.repositories.map((repo) => ({
      ...repo, worktrees: repo.worktrees.map((worktree) => ({
        ...worktree, sessions: [...this.entries.values()]
          .filter((entry) => entry.phase === "open" && entry.worktree.id === worktree.id)
          .map((entry) => ({
            id: entry.id, name: entry.name, status: entry.recoveredState ? entry.recoveredState.status : entry.executor?.state.status ?? null,
            subagents: [...entry.children.values()].map((child) => ({
              id: child.id, name: child.name, status: child.failure ? "failure" : child.executor?.state.status ?? child.finishedStatus ?? null,
            })),
          })),
      })),
    }));
  }

  get closingCount(): number {
    return [...this.entries.values()].filter((entry) => entry.phase === "closing").length;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  details(id: string): ExecutionState | null {
    const entry = this.entries.get(id);
    return entry?.phase === "open" ? entry.recoveredState ?? entry.executor?.state ?? null : null;
  }

  sessionFile(id: string): string | undefined {
    return this.entries.get(id)?.executor?.sessionFile;
  }

  historyOwnership(canonicalFile: string): { openSessionId: string | null; unavailableReason: string | null } {
    const owner = this.fileOwners.get(canonicalFile);
    if (!owner) return { openSessionId: null, unavailableReason: null };
    const entry = this.entries.get(owner);
    if (entry?.phase === "open") return { openSessionId: entry.id, unavailableReason: null };
    const unavailableReason = !entry ? "Saved session belongs to an active subagent."
      : entry.phase === "creating" ? "Saved session is being opened. Try again shortly." : "Session is still closing. Try again after cleanup.";
    return { openSessionId: null, unavailableReason };
  }

  get records(): readonly SessionRecord[] {
    return [...this.entries.values()].filter((entry) => entry.phase === "open").map((entry) => ({
      id: entry.id, name: entry.name, worktreeId: entry.worktree.id,
      ...(entry.executor?.sessionFile ? { sessionFile: entry.executor.sessionFile } : {}),
      state: this.details(entry.id) ?? { status: null, output: "", error: null },
      subagents: [...entry.children.values()].map((child) => ({ id: child.id, name: child.name,
        status: child.failure ? "failure" : child.executor?.state.status ?? child.finishedStatus ?? null })),
    }));
  }

  async restore(record: SessionRecord): Promise<void> {
    const exists = record.sessionFile && await Bun.file(record.sessionFile).exists();
    if (!exists && record.state.output) throw new Error("Saved conversation file is missing; refusing to replace it with an empty session.");
    if (exists && record.sessionFile) {
      const lines = (await Bun.file(record.sessionFile).text()).split("\n").filter((line) => line.trim());
      const entries: unknown[] = lines.map((line) => JSON.parse(line));
      const header = entries[0];
      if (!header || typeof header !== "object" || !("type" in header) || header.type !== "session") {
        throw new Error("Saved conversation file has no valid session header; refusing to overwrite it.");
      }
    }
    await this.create(record.worktreeId, exists ? record.sessionFile : undefined, record);
    const entry = this.requireOpen(record.id);
    const restored = entry.executor!.state;
    entry.recoveredState = {
      output: restored.output.length >= record.state.output.length ? restored.output : record.state.output,
      status: record.state.status === "working" ? null : restored.status,
      error: record.state.status === "working" ? "Previous runtime ended during this run; submit a new prompt to continue." : restored.error,
    };
    for (const child of record.subagents) entry.children.set(child.id, { id: child.id, name: child.name, role: "subagent", ready: undefined,
      finishedStatus: child.status === "working" ? null : child.status });
    this.emit();
  }

  async create(worktreeId: string, sessionFile?: string, identity?: { readonly id: string; readonly name: string }): Promise<string> {
    this.assertActive();
    const worktree = this.repositories.flatMap((repo) => repo.worktrees).find((tree) => tree.id === worktreeId);
    if (!worktree) throw new Error(`Unknown worktree: ${worktreeId}`);
    // Canonical file identity prevents two writers, including while a close is still flushing.
    const requestedFile = sessionFile ? await realpath(sessionFile) : undefined;
    this.assertActive();
    if (requestedFile && this.fileOwners.has(requestedFile)) throw new Error("This saved session is already open or still closing.");
    const id = identity?.id ?? crypto.randomUUID();
    if (this.entries.has(id)) throw new Error("This open-session ID already exists.");
    if (requestedFile) this.fileOwners.set(requestedFile, id);
    const ready = Promise.resolve().then(() => this.factory({
      cwd: worktree.path, role: "main", ...(requestedFile ? { sessionFile: requestedFile } : {}),
      spawnSubagent: (name, task, signal) => this.spawnSubagent(id, name, task, signal),
    }));
    const entry: OpenExecution = {
      id, name: identity?.name ?? `Session ${id.slice(0, 8)}`, role: "main", worktree, ready, phase: "creating", children: new Map(),
      ...(requestedFile ? { fileKey: requestedFile } : {}),
    };
    this.entries.set(id, entry);
    try {
      entry.executor = await ready;
      const fileKey = await this.fileKey(entry.executor);
      if (entry.phase !== "creating") throw new Error("Session creation was cancelled by shutdown.");
      if (requestedFile && fileKey !== requestedFile) throw new Error("Executor did not reopen the requested saved session.");
      if (fileKey) {
        const owner = this.fileOwners.get(fileKey);
        if (owner && owner !== id) throw new Error("This saved session is already open or still closing.");
        entry.fileKey = fileKey;
        this.fileOwners.set(fileKey, id);
      }
      entry.unsubscribe = entry.executor.subscribe(() => { if (entry.phase === "open") this.emit(); });
      entry.phase = "open";
      this.emit();
      return id;
    } catch (error) {
      // Shutdown owns cleanup if it raced with creation; otherwise clean even partially initialized handles.
      if (entry.phase === "creating") {
        try { await this.close(id); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], "Creation and cleanup failed."); }
      }
      throw error;
    }
  }

  async prompt(id: string, text: string): Promise<void> {
    const entry = this.requireOpen(id);
    if (!text.trim()) throw new Error("A prompt must not be empty.");
    delete entry.recoveredState;
    await entry.executor!.prompt(text);
  }

  close(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve();
    if (entry.closeTask) return entry.closeTask;
    entry.phase = "closing";
    // Register the task before notifying observers so repeated/reentrant close is idempotent.
    const task = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        this.closeExecution(entry), ...[...entry.children.values()].map((child) => this.closeExecution(child)),
      ]);
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, `Could not finish closing ${entry.name}`);
      this.entries.delete(id);
      if (entry.fileKey && this.fileOwners.get(entry.fileKey) === id) this.fileOwners.delete(entry.fileKey);
      this.emit();
    });
    entry.closeTask = task;
    // Retain failed entries for retry/shutdown rather than losing live handles.
    void task.catch(() => { delete entry.closeTask; this.emit(); });
    this.emit();
    return task;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const results = await Promise.allSettled([...this.entries.keys()].map((id) => this.close(id)));
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Some session executions could not be shut down.");
  }

  private async spawnSubagent(ownerId: string, name: string, task: string, signal?: AbortSignal): Promise<string> {
    const owner = this.requireOpen(ownerId);
    signal?.throwIfAborted();
    const ready = Promise.resolve().then(() => this.factory({
      cwd: owner.worktree.path, role: "subagent",
      spawnSubagent: async () => { throw new Error("Nested delegation is not enabled."); },
    }));
    const child: Execution = { id: crypto.randomUUID(), name, role: "subagent", ready };
    owner.children.set(child.id, child);
    this.emit();
    let cancellationError: unknown;
    let spawnError: unknown;
    const cancel = (): void => {
      void this.closeExecution(child).catch((error: unknown) => { cancellationError = error; });
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const executor = await ready;
      child.executor = executor;
      const fileKey = await this.fileKey(executor);
      this.requireOpen(ownerId);
      signal?.throwIfAborted();
      if (fileKey) {
        if (this.fileOwners.has(fileKey)) throw new Error("The subagent saved session already has a writer.");
        child.fileKey = fileKey;
        this.fileOwners.set(fileKey, child.id);
      }
      child.unsubscribe = executor.subscribe(() => { if (owner.phase === "open") this.emit(); });
      this.emit();
      await executor.prompt(task);
      signal?.throwIfAborted();
      if (executor.state.status === "failure") throw new Error(executor.state.error ?? "Subagent failed.");
      return executor.state.output;
    } catch (error) {
      spawnError = error;
      if (!signal?.aborted && owner.phase === "open") {
        child.failure = error instanceof Error ? error.message : String(error);
        this.emit();
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
      try { await this.closeExecution(child); }
      catch (cleanupError) {
        child.failure = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        if (owner.phase === "open") this.emit();
        throw spawnError ? new AggregateError([spawnError, cleanupError], "Subagent execution and cleanup failed.") : cleanupError;
      }
      if (cancellationError) throw cancellationError;
    }
  }

  private closeExecution(execution: Execution): Promise<void> {
    if (execution.cleanupTask) return execution.cleanupTask;
    const ready = execution.ready;
    if (!ready) return Promise.resolve();
    const task = (async () => {
      let executor: SessionExecutor;
      try { executor = await ready; }
      catch { return; } // A failed factory cannot leave an owned executor behind.
      await executor.close();
      execution.unsubscribe?.();
      delete execution.unsubscribe;
      if (execution.role === "subagent") {
        if (execution.fileKey && this.fileOwners.get(execution.fileKey) === execution.id) this.fileOwners.delete(execution.fileKey);
        // Retain only display metadata, not a fulfilled Promise holding the entire SDK transcript.
        execution.finishedStatus = executor.state.status;
        execution.ready = undefined;
        delete execution.executor;
      }
    })();
    execution.cleanupTask = task;
    void task.catch(() => { delete execution.cleanupTask; });
    return task;
  }

  private async fileKey(executor: SessionExecutor): Promise<string | undefined> {
    const file = executor.sessionFile;
    return file ? join(await realpath(dirname(file)), basename(file)) : undefined;
  }

  private requireOpen(id: string): OpenExecution {
    this.assertActive();
    const entry = this.entries.get(id);
    if (!entry || entry.phase !== "open" || !entry.executor) throw new Error("Session is not open.");
    return entry;
  }

  private assertActive(): void {
    if (this.shuttingDown) throw new Error("Session registry is shutting down.");
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
