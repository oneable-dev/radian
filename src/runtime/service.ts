import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "typebox/value";
import { SessionRegistry, type SessionRecord } from "../sessions/session-registry.ts";
import { piSessionFactory } from "../sessions/pi-session-adapter.ts";
import { SessionHistory } from "../sessions/history.ts";
import { offlineRuntime } from "../testing/offline-runtime.ts";
import { discoverRepository } from "../workspace/git.ts";
import type { Repository } from "../workspace/model.ts";
import { acquireRuntime, privateDirectory, RuntimeStore, runtimePaths } from "./storage.ts";
import { commandSchema, emptyPreferences, errorMessage, maxFrameBytes, protocolVersion,
  type RuntimeCommand, type RuntimeManifest, type RuntimePreferences, type RuntimeSnapshot } from "./protocol.ts";

export async function runRuntime(cwd: string, offline: boolean, stateRoot?: string): Promise<void> {
  const repository = await discoverRepository(cwd);
  const paths = runtimePaths(repository.id, offline, stateRoot);
  await privateDirectory(paths.directory);
  const release = await acquireRuntime(paths);
  if (!release) return; // Another launch owns initialization or the active service.
  let server: Bun.Server<undefined> | undefined;
  let runtime: WorkspaceRuntime | undefined;
  try {
    const store = new RuntimeStore(paths);
    const manifest = await store.load(repository.id);
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
    try { await stopped.promise; await runtime.stop(); }
    finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
  } finally {
    await server?.stop(true);
    if (runtime && !runtime.stopped) await runtime.stop();
    await release();
  }
}

class WorkspaceRuntime {
  readonly instance = crypto.randomUUID();
  onStop: () => void = () => {};
  stopped = false;
  private preferences: RuntimePreferences;
  private readonly subscribers = new Set<(snapshot: RuntimeSnapshot) => void>();
  private readonly failedRecovery = new Map<string, SessionRecord>();
  private readonly unsubscribe: () => void;
  private notice = "";
  private persistenceError = "";
  private checkpointTimer: ReturnType<typeof setTimeout> | undefined;
  private initializing = true;

  constructor(private readonly registry: SessionRegistry, private readonly repositoryId: string,
    private readonly offline: boolean, private readonly store: RuntimeStore, preferences: RuntimePreferences, private readonly history: SessionHistory) {
    this.preferences = preferences;
    this.unsubscribe = registry.subscribe(() => this.changed());
  }

  async restore(records: readonly SessionRecord[]): Promise<void> {
    for (const record of records) {
      try { await this.registry.restore(record); }
      catch (error) {
        const state = { ...record.state, status: "failure" as const, error: `Could not restore: ${errorMessage(error)}` };
        this.failedRecovery.set(record.id, { ...record, state,
          subagents: record.subagents.map((agent) => ({ ...agent, status: agent.status === "working" ? null : agent.status })) });
      }
    }
    this.initializing = false;
    await this.checkpoint();
  }

  get snapshot(): RuntimeSnapshot {
    const failed = [...this.failedRecovery.values()];
    const repositories = this.registry.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => ({
      ...tree, sessions: [...tree.sessions, ...failed.filter((record) => record.worktreeId === tree.id).map((record) => ({
        id: record.id, name: record.name, status: record.state.status, subagents: record.subagents,
      }))],
    })) }));
    const details = Object.fromEntries([...this.registry.records, ...failed].map((record) => [record.id, record.state]));
    return { version: protocolVersion, pid: process.pid, instance: this.instance, capabilities: ["history"], repositoryId: this.repositoryId,
      mode: this.offline ? "offline" : "live", repositories, details, closingCount: this.registry.closingCount,
      preferences: this.preferences, notice: this.persistenceError || this.notice };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/snapshot" && request.method === "GET") return Response.json(this.snapshot);
      if (path === "/events" && request.method === "GET") return this.events();
      if (path === "/history" && request.method === "GET") {
        const worktreeId = new URL(request.url).searchParams.get("worktreeId");
        if (!worktreeId) throw new Error("Missing worktree for history.");
        return Response.json(await this.history.list(worktreeId));
      }
      if (path !== "/command" || request.method !== "POST") return new Response("Not found", { status: 404 });
      if (Number(request.headers.get("content-length")) > maxFrameBytes) throw new Error("Command is too large.");
      const text = await request.text();
      if (Buffer.byteLength(text) > maxFrameBytes) throw new Error("Command is too large.");
      const command: unknown = JSON.parse(text);
      if (!Value.Check(commandSchema, command)) throw new Error("Malformed runtime command.");
      if (this.stopped) throw new Error("Runtime is stopping.");
      const value = await this.command(command);
      return Response.json({ ok: true, value });
    } catch (error) { return Response.json({ ok: false, error: errorMessage(error) }, { status: 400 }); }
  }

  private async command(command: RuntimeCommand): Promise<string | null> {
    switch (command.type) {
      case "create": {
        const id = await this.registry.create(command.worktreeId);
        await this.checkpoint(); return id;
      }
      case "resume": {
        const id = await this.history.resume(command.worktreeId, command.savedId);
        await this.checkpoint(); return id;
      }
      case "close": {
        if (this.failedRecovery.delete(command.sessionId)) this.changed();
        else void this.registry.close(command.sessionId).catch((error: unknown) => this.report(error));
        await this.checkpoint(); return null;
      }
      case "prompt": {
        if (this.failedRecovery.has(command.sessionId)) throw new Error("This session needs recovery before it can run.");
        const state = this.registry.details(command.sessionId);
        if (!state) throw new Error("Session is not open.");
        if (state.status === "working") throw new Error("This session is already running.");
        if (!command.text.trim()) throw new Error("A prompt must not be empty.");
        // The response acknowledges submission, not completion. The daemon owns this task.
        void this.registry.prompt(command.sessionId, command.text).catch((error: unknown) => this.report(error));
        await this.checkpoint();
        return null;
      }
      case "preferences": this.preferences = command.preferences; await this.checkpoint(); return null;
      case "stop": setTimeout(() => this.onStop(), 20); return null;
    }
  }

  private events(): Response {
    let pending: Uint8Array | undefined;
    let send: ((snapshot: RuntimeSnapshot) => void) | undefined;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        send = (snapshot) => {
          const data = encoder.encode(JSON.stringify(snapshot) + "\n");
          if ((controller.desiredSize ?? 0) > 0) controller.enqueue(data);
          else pending = data; // Slow readers receive the latest snapshot, not an unbounded token queue.
        };
        this.subscribers.add(send); send(this.snapshot);
      },
      pull: (controller) => { if (pending) { controller.enqueue(pending); pending = undefined; } },
      cancel: () => { if (send) this.subscribers.delete(send); },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
  }

  private changed(): void {
    for (const subscriber of this.subscribers) subscriber(this.snapshot);
    if (this.initializing || this.stopped || this.checkpointTimer) return;
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = undefined;
      void this.checkpoint().catch((error: unknown) => {
        this.persistenceError = `Runtime persistence failed: ${errorMessage(error)}`;
        for (const subscriber of this.subscribers) subscriber(this.snapshot);
      });
    }, 100);
  }

  private report(error: unknown): void { this.notice = errorMessage(error); this.changed(); }
  private async checkpoint(manifest?: RuntimeManifest): Promise<void> {
    await this.store.save(manifest ?? { version: protocolVersion, repositoryId: this.repositoryId,
      repositories: this.registry.snapshot, records: [...this.registry.records, ...this.failedRecovery.values()], preferences: this.preferences });
    this.persistenceError = "";
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    this.unsubscribe();
    // Stopping the service is NOT explicit session close. Freeze open intent before teardown emits removals.
    const manifest: RuntimeManifest = { version: protocolVersion, repositoryId: this.repositoryId,
      repositories: this.registry.snapshot, records: [...this.registry.records, ...this.failedRecovery.values()], preferences: this.preferences };
    try { await this.checkpoint(manifest); }
    finally { await this.registry.shutdown(); }
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
