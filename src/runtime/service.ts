import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { CancelledError, collectCleanup, InputError, SessionError, reportUnexpected, withCleanup, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { SessionRegistry, type SessionRecord } from "../sessions/session-registry.ts";
import { piSessionFactory } from "../sessions/pi-session-adapter.ts";
import { SessionHistory } from "../sessions/history.ts";
import { offlineRuntime } from "../testing/offline-runtime.ts";
import { discoverRepository } from "../workspace/git.ts";
import type { Repository } from "../workspace/model.ts";
import { acquireRuntime, privateDirectory, RuntimeStore, runtimePaths } from "./storage.ts";
import { EditorSessions } from "./editor-sessions.ts";
import { snapshotEvents } from "./events.ts";
import { emptyPreferences, errorStatus, maxFrameBytes, parseCommand, protocolVersion, wireError,
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
    const repositories = mergeRepositories(repository, manifest);
    const options = offline ? await offlineRuntime(join(paths.directory, "offline-agent")) : undefined;
    const registry = new SessionRegistry(repositories, piSessionFactory(options));
    runtime = new WorkspaceRuntime(registry, repository.id, offline, store, manifest?.preferences ?? emptyPreferences,
      new SessionHistory(repositories, registry, options?.sessionDir));
    await runtime.restore(manifest?.records ?? []);
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
  private readonly failedRecovery = new Map<string, SessionRecord>();
  private readonly unsubscribe: () => void;
  private notice = "";
  private persistenceError = "";
  private checkpointTimer: ReturnType<typeof setTimeout> | undefined;
  private initializing = true;

  constructor(private readonly registry: SessionRegistry, private readonly repositoryId: string,
    private readonly offline: boolean, private readonly store: RuntimeStore, preferences: RuntimePreferences, private readonly history: SessionHistory) {
    this.preferences = preferences;
    this.editors = new EditorSessions(registry.snapshot, () => this.changed(), { clean: offline });
    this.unsubscribe = registry.subscribe(() => this.changed());
  }

  async restore(records: readonly SessionRecord[]): Promise<void> {
    for (const record of records) {
      const restored = await this.registry.restore(record);
      if (!restored.ok) {
        const state = { ...record.state, status: "failure" as const, error: `Could not restore: ${restored.error.message}` };
        this.failedRecovery.set(record.id, { ...record, state,
          subagents: record.subagents.map((agent) => ({ ...agent, status: agent.status === "working" ? null : agent.status })) });
      }
    }
    this.initializing = false;
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
    return { version: protocolVersion, pid: process.pid, instance: this.instance, capabilities: ["history", "typed-errors", "work-views"], repositoryId: this.repositoryId,
      mode: this.offline ? "offline" : "live", repositories, details, closingCount: this.registry.closingCount,
      preferences: this.preferences, notice: this.persistenceError || this.notice, editors: this.editors.infos };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/snapshot" && request.method === "GET") return Response.json(this.snapshot);
      if (path === "/events" && request.method === "GET") return this.events();
      if (path === "/editor/events" && request.method === "GET") {
        const params = new URL(request.url).searchParams;
        const id = params.get("id"), lease = params.get("lease");
        if (!id || !lease || id.length > 4096 || lease.length > 4096) return this.rejected(new InputError("Missing editor attachment identity."));
        const attached = this.editors.attach(id, lease);
        return attached.ok ? attached.value : this.rejected(attached.error);
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
      const checkpoint = command.value.type === "editor-input" || command.value.type === "editor-resize" || command.value.type === "editor-detach" ? ok(undefined) : await this.checkpoint();
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
      case "prompt": {
        if (this.failedRecovery.has(command.sessionId)) return err(new SessionError("SESSION_NOT_OPEN", "This session needs recovery before it can run."));
        const state = this.registry.details(command.sessionId);
        if (!state) return err(new SessionError("SESSION_NOT_OPEN", "Session is not open."));
        if (state.status === "working") return err(new SessionError("SESSION_BUSY", "This session is already running."));
        if (!command.text.trim()) return err(new InputError("A prompt must not be empty."));
        this.observe(this.registry.prompt(command.sessionId, command.text));
        return ok(null);
      }
      case "preferences": {
        const workViews = command.preferences.workViews ?? this.preferences.workViews;
        this.preferences = { ...command.preferences, ...(workViews ? { workViews } : {}) };
        return ok(null);
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

  private events(): Response {
    return snapshotEvents(() => this.snapshot, (send) => {
      this.subscribers.add(send); return () => { this.subscribers.delete(send); };
    });
  }

  private changed(): void {
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
    return collectCleanup([this.checkpoint(manifest), this.registry.shutdown(), this.editors.stop()], "Checkpoint or runtime shutdown failed.");
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
