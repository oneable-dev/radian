import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { Value } from "typebox/value";
import type { Repository } from "../workspace/model.ts";
import type { HistoryItem } from "../sessions/history.ts";
import { emptyPreferences, errorMessage, historySchema, maxFrameBytes, parseSnapshot, replySchema,
  type RuntimeCommand, type RuntimePreferences, type RuntimeSnapshot } from "./protocol.ts";
import { privateDirectory, runtimePaths, type RuntimePaths } from "./storage.ts";

export type ConnectOptions = { offline?: boolean; stateRoot?: string; entry?: string; start?: boolean };

export async function connectRuntime(repository: Repository, cwd: string, options: ConnectOptions = {}): Promise<RuntimeClient | null> {
  const paths = runtimePaths(repository.id, options.offline ?? false, options.stateRoot);
  let snapshot = await fetchSnapshot(paths);
  if (!snapshot && options.start === false) return null;
  if (!snapshot) {
    await privateDirectory(paths.directory);
    const log = await open(paths.log, "a", 0o600);
    try {
      const entry = resolve(options.entry ?? process.argv[1] ?? "src/index.ts");
      const args = [entry, "--runtime-service", "--runtime-cwd", cwd];
      if (options.stateRoot) args.push("--state-dir", resolve(options.stateRoot));
      if (options.offline) args.push("--test-runtime");
      const child = spawn(process.execPath, args, { cwd, detached: true, stdio: ["ignore", log.fd, log.fd] });
      const launched = Promise.withResolvers<void>();
      child.once("spawn", () => launched.resolve()); child.once("error", (error) => launched.reject(error));
      await launched.promise; child.unref();
    } finally { await log.close(); }
    const deadline = Date.now() + 15000;
    while (!snapshot && Date.now() < deadline) {
      snapshot = await fetchSnapshot(paths);
      if (!snapshot) await new Promise<void>((resolve) => setTimeout(resolve, 40));
    }
    if (!snapshot) throw new Error(`Runtime failed to start. Inspect ${paths.log}`);
  }
  if (snapshot.repositoryId !== repository.id || snapshot.mode !== (options.offline ? "offline" : "live")) {
    throw new Error("Runtime identity does not match this workspace.");
  }
  const client = new RuntimeClient(paths, snapshot);
  await client.attach();
  return client;
}

export class RuntimeClient {
  private state: RuntimeSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly hidden = new Set<string>();
  private readonly streamAbort = new AbortController();
  private streamTask: Promise<void> | undefined;
  private disconnected = false;
  private failure = "";

  constructor(readonly paths: RuntimePaths, snapshot: RuntimeSnapshot) { this.state = snapshot; }

  get snapshot(): RuntimeSnapshot {
    if (!this.hidden.size && !this.failure) return this.state;
    const details = Object.fromEntries(Object.entries(this.state.details).filter(([id]) => !this.hidden.has(id)).map(([id, state]) => [id,
      this.failure && state.status === "working" ? { ...state, status: null, error: this.failure } : state]));
    return { ...this.state, notice: this.failure || this.state.notice, details,
      repositories: this.state.repositories.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => ({
        ...tree, sessions: tree.sessions.filter((session) => !this.hidden.has(session.id)).map((session) => ({ ...session,
          status: this.failure && session.status === "working" ? null : session.status,
          subagents: session.subagents.map((agent) => ({ ...agent, status: this.failure && agent.status === "working" ? null : agent.status })),
        })),
      })) })),
    };
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async attach(): Promise<void> {
    const response = await fetch("http://localhost/events", { unix: this.paths.socket, signal: this.streamAbort.signal });
    if (!response.ok || !response.body) throw new Error("Runtime event stream is unavailable.");
    this.streamTask = this.consume(response.body).catch((error: unknown) => {
      if (this.disconnected) return;
      this.failure = `Runtime disconnected: ${errorMessage(error)} · restart radian to reconnect`;
      this.emit();
    });
  }

  async create(worktreeId: string): Promise<string> {
    const id = await this.command({ type: "create", worktreeId });
    if (!id) throw new Error("Runtime did not return a session ID.");
    return id;
  }
  async listHistory(worktreeId: string): Promise<readonly HistoryItem[]> {
    this.requireHistory();
    const response = await fetch(`http://localhost/history?worktreeId=${encodeURIComponent(worktreeId)}`, {
      unix: this.paths.socket, signal: AbortSignal.timeout(15000),
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      if (Value.Check(replySchema, value) && !value.ok) throw new Error(value.error);
      throw new Error("History request failed.");
    }
    if (!Value.Check(historySchema, value)) throw new Error("Malformed history response.");
    return value;
  }
  async resume(worktreeId: string, savedId: string): Promise<string> {
    this.requireHistory();
    const id = await this.command({ type: "resume", worktreeId, savedId });
    if (!id) throw new Error("Runtime did not return a resumed session ID.");
    await this.waitForOpen(id);
    return id;
  }
  private waitForOpen(id: string): Promise<void> {
    const present = () => this.snapshot.repositories.some((repo) => repo.worktrees.some((tree) => tree.sessions.some((session) => session.id === id)));
    if (present()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error("Resumed session did not reach the workspace snapshot.")); }, 15000);
      const unsubscribe = this.subscribe(() => {
        if (!present() && !this.failure) return;
        clearTimeout(timer); unsubscribe();
        if (this.failure) reject(new Error(this.failure)); else resolve();
      });
    });
  }
  private requireHistory(): void {
    if (!this.state.capabilities?.includes("history")) {
      throw new Error("Running service predates history support. Finish its jobs, explicitly stop it, then restart radian.");
    }
  }

  closeSession(sessionId: string): Promise<void> {
    this.hidden.add(sessionId); this.emit();
    return this.command({ type: "close", sessionId }).then(() => {}).catch((error: unknown) => {
      this.hidden.delete(sessionId); this.emit(); throw error;
    });
  }
  async prompt(sessionId: string, text: string): Promise<void> { await this.command({ type: "prompt", sessionId, text }); }
  async savePreferences(preferences: RuntimePreferences): Promise<void> { await this.command({ type: "preferences", preferences }); }
  async stopRuntime(): Promise<void> { await this.command({ type: "stop" }); }

  async disconnect(): Promise<void> {
    this.disconnected = true;
    this.streamAbort.abort();
    await this.streamTask;
    this.listeners.clear();
  }

  private async command(command: RuntimeCommand): Promise<string | null> {
    if (this.disconnected || this.failure) throw new Error("Runtime client is disconnected.");
    const response = await fetch("http://localhost/command", { unix: this.paths.socket, method: "POST",
      body: JSON.stringify(command), headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15000) });
    const value: unknown = await response.json();
    if (!Value.Check(replySchema, value)) throw new Error("Malformed runtime reply.");
    if (!value.ok) throw new Error(value.error);
    return value.value;
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    try {
      while (!this.disconnected) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Service closed its event stream.");
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const frame = buffer.slice(0, newline);
          if (Buffer.byteLength(frame) > maxFrameBytes) throw new Error("Runtime frame is too large.");
          const snapshot = parseSnapshot(JSON.parse(frame));
          buffer = buffer.slice(newline + 1);
          if (snapshot.instance !== this.state.instance) throw new Error("Service instance changed.");
          this.state = snapshot;
          const open = new Set(snapshot.repositories.flatMap((repo) => repo.worktrees.flatMap((tree) => tree.sessions.map((session) => session.id))));
          for (const id of this.hidden) if (!open.has(id)) this.hidden.delete(id);
          this.emit();
        }
        if (Buffer.byteLength(buffer) > maxFrameBytes) throw new Error("Runtime frame is too large.");
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  private emit(): void { for (const listener of this.listeners) listener(); }
}

export async function fetchSnapshot(paths: RuntimePaths): Promise<RuntimeSnapshot | null> {
  let response: Response;
  try { response = await fetch("http://localhost/snapshot", { unix: paths.socket, signal: AbortSignal.timeout(500) }); }
  catch { return null; } // Only connection failures trigger service bootstrap, never malformed/protocol replies.
  if (!response.ok) throw new Error(`Runtime snapshot failed: ${response.status}`);
  return parseSnapshot(await response.json());
}

export function defaultPreferences(): RuntimePreferences { return structuredClone(emptyPreferences); }
