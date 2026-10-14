import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { Value } from "typebox/value";
import type { Repository } from "../workspace/model.ts";
import type { HistoryItem } from "../sessions/history.ts";
import { CapabilityError, capture, ConnectionError, parseJson, ProtocolError, RemoteError, reportUnexpected, systemCode, withCleanup, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { emptyPreferences, historySchema, maxFrameBytes, parseSnapshot, replySchema, type RuntimeCommand, type RuntimePreferences, type RuntimeSnapshot, type WireError } from "./protocol.ts";
import { privateDirectory, runtimePaths, type RuntimePaths } from "./storage.ts";

export type ConnectOptions = { offline?: boolean; stateRoot?: string; entry?: string; start?: boolean };
export async function connectRuntime(repository: Repository, cwd: string, options: ConnectOptions = {}): Promise<Result<RuntimeClient | null, ExpectedError>> {
  const paths = runtimePaths(repository.id, options.offline ?? false, options.stateRoot);
  let fetched = await fetchSnapshot(paths);
  if (!fetched.ok) return fetched;
  if (!fetched.value && options.start === false) return ok(null);
  if (!fetched.value) {
    const launched = await capture(async () => {
      await privateDirectory(paths.directory);
      const log = await open(paths.log, "a", 0o600);
      await withCleanup(async () => {
        const entry = resolve(options.entry ?? process.argv[1] ?? "src/index.ts");
        const args = [entry, "--runtime-service", "--runtime-cwd", cwd];
        if (options.stateRoot) args.push("--state-dir", resolve(options.stateRoot));
        if (options.offline) args.push("--test-runtime");
        const child = spawn(process.execPath, args, { cwd, detached: true, stdio: ["ignore", log.fd, log.fd] });
        const started = Promise.withResolvers<void>();
        child.once("spawn", () => started.resolve()); child.once("error", (error) => started.reject(error));
        await started.promise; child.unref();
      }, () => log.close());
    });
    if (!launched.ok) return launched;
    const deadline = Date.now() + 15000;
    while (!fetched.value && Date.now() < deadline) {
      fetched = await fetchSnapshot(paths); if (!fetched.ok) return fetched;
      if (!fetched.value) await new Promise<void>((resolve) => setTimeout(resolve, 40));
    }
    if (!fetched.value) return err(new ConnectionError("CONNECTION_TIMEOUT", `Runtime failed to start. Inspect ${paths.log}`));
  }
  const snapshot = fetched.value;
  if (snapshot.repositoryId !== repository.id || snapshot.mode !== (options.offline ? "offline" : "live")) return err(new ProtocolError("Runtime identity does not match this workspace."));
  const client = new RuntimeClient(paths, snapshot);
  const attached = await client.attach();
  return attached.ok ? ok(client) : attached;
}

export class RuntimeClient {
  private state: RuntimeSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly hidden = new Set<string>();
  private readonly streamAbort = new AbortController();
  private streamTask: Promise<void> | undefined;
  private disconnected = false;
  private failure = "";
  private warning = "";
  constructor(readonly paths: RuntimePaths, snapshot: RuntimeSnapshot) { this.state = snapshot; }
  get snapshot(): RuntimeSnapshot {
    if (!this.hidden.size && !this.failure && !this.warning) return this.state;
    const details = Object.fromEntries(Object.entries(this.state.details).filter(([id]) => !this.hidden.has(id)).map(([id, state]) => [id,
      this.failure && state.status === "working" ? { ...state, status: null, error: this.failure } : state]));
    return { ...this.state, notice: this.failure || this.warning || this.state.notice, details,
      repositories: this.state.repositories.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => ({ ...tree,
        sessions: tree.sessions.filter((session) => !this.hidden.has(session.id)).map((session) => ({ ...session,
          status: this.failure && session.status === "working" ? null : session.status,
          subagents: session.subagents.map((agent) => ({ ...agent, status: this.failure && agent.status === "working" ? null : agent.status })),
        })),
      })) })),
    };
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async attach(): Promise<Result<void, ExpectedError>> {
    const response = await transport(this.paths, "/events", { signal: this.streamAbort.signal }); if (!response.ok) return response;
    if (!response.value.ok || !response.value.body) return err(new ProtocolError("Runtime event stream is unavailable."));
    this.streamTask = this.consume(response.value.body).then((result) => {
      if (!this.disconnected && !result.ok) { this.failure = result.error.message; this.emit(); }
    }).catch((error: unknown) => {
      if (this.disconnected) return;
      this.failure = reportUnexpected(error, "runtime stream"); this.emit();
    });
    return ok(undefined);
  }
  async create(worktreeId: string): Promise<Result<string, ExpectedError>> {
    const result = await this.command({ type: "create", worktreeId });
    if (!result.ok) return result;
    return result.value ? ok(result.value) : err(new ProtocolError("Runtime did not return a session ID."));
  }
  async listHistory(worktreeId: string): Promise<Result<readonly HistoryItem[], ExpectedError>> {
    const capability = this.requireHistory(); if (!capability.ok) return capability;
    const response = await transport(this.paths, `/history?worktreeId=${encodeURIComponent(worktreeId)}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return response;
    const body = await readJson(response.value); if (!body.ok) return body;
    if (!response.value.ok) {
      return Value.Check(replySchema, body.value) && !body.value.ok ? err(remoteError(body.value.error)) : err(new ProtocolError("Malformed history failure response."));
    }
    return Value.Check(historySchema, body.value) ? ok(body.value) : err(new ProtocolError("Malformed history response."));
  }
  async resume(worktreeId: string, savedId: string): Promise<Result<string, ExpectedError>> {
    const capability = this.requireHistory(); if (!capability.ok) return capability;
    const result = await this.command({ type: "resume", worktreeId, savedId }); if (!result.ok) return result;
    if (!result.value) return err(new ProtocolError("Runtime did not return a resumed session ID."));
    const opened = await this.waitForOpen(result.value); return opened.ok ? ok(result.value) : opened;
  }
  private waitForOpen(id: string): Promise<Result<void, ExpectedError>> {
    const present = () => this.snapshot.repositories.some((repo) => repo.worktrees.some((tree) => tree.sessions.some((session) => session.id === id)));
    if (present()) return Promise.resolve(ok(undefined));
    if (this.disconnected || this.failure) return Promise.resolve(err(this.connectionClosed()));
    return new Promise((resolve) => {
      const finish = (result: Result<void, ExpectedError>) => { clearTimeout(timer); unsubscribe(); this.streamAbort.signal.removeEventListener("abort", aborted); resolve(result); };
      const timer = setTimeout(() => finish(err(new ConnectionError("CONNECTION_TIMEOUT", "Resume was accepted, but its snapshot did not arrive. Reconnect before retrying."))), 15000);
      const aborted = () => finish(err(this.connectionClosed()));
      const unsubscribe = this.subscribe(() => { if (present()) finish(ok(undefined)); else if (this.failure) finish(err(this.connectionClosed())); });
      this.streamAbort.signal.addEventListener("abort", aborted, { once: true });
    });
  }
  private requireHistory(): Result<void, ExpectedError> {
    if (this.disconnected || this.failure) return err(this.connectionClosed());
    return this.state.capabilities?.includes("history") ? ok(undefined) : err(new CapabilityError("Running service predates history support. Finish its jobs, explicitly stop it, then restart radian."));
  }
  closeSession(sessionId: string): Promise<Result<void, ExpectedError>> {
    this.hidden.add(sessionId); this.emit();
    return this.command({ type: "close", sessionId }).then((result) => {
      if (!result.ok) { this.hidden.delete(sessionId); this.emit(); return result; }
      return ok(undefined);
    }).catch((error: unknown) => {
      this.hidden.delete(sessionId); this.emit();
      throw error;
    });
  }
  async prompt(sessionId: string, text: string): Promise<Result<void, ExpectedError>> { const result = await this.command({ type: "prompt", sessionId, text }); return result.ok ? ok(undefined) : result; }
  async savePreferences(preferences: RuntimePreferences): Promise<Result<void, ExpectedError>> { const result = await this.command({ type: "preferences", preferences }); return result.ok ? ok(undefined) : result; }
  async stopRuntime(): Promise<Result<void, ExpectedError>> { const result = await this.command({ type: "stop" }); return result.ok ? ok(undefined) : result; }
  async disconnect(): Promise<void> { this.disconnected = true; this.streamAbort.abort(); await this.streamTask; this.listeners.clear(); }

  private async command(command: RuntimeCommand): Promise<Result<string | null, ExpectedError>> {
    if (this.disconnected || this.failure) return err(this.connectionClosed());
    const response = await transport(this.paths, "/command", { method: "POST", body: JSON.stringify(command),
      headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return err(new ConnectionError(response.error.code, `${response.error.message} Action outcome is unknown; reconnect before retrying.`, { cause: response.error }));
    const body = await readJson(response.value); if (!body.ok) return body;
    if (!Value.Check(replySchema, body.value)) return err(new ProtocolError("Malformed runtime reply; action outcome is unknown."));
    if (!body.value.ok) return err(remoteError(body.value.error));
    this.warning = body.value.warnings?.map((warning) => `Action accepted; ${warning.message}`).join(" · ") ?? "";
    if (this.warning) this.emit();
    return ok(body.value.value);
  }
  private async consume(body: ReadableStream<Uint8Array>): Promise<Result<void, ExpectedError>> {
    const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    try {
      while (!this.disconnected) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try { chunk = await reader.read(); }
        catch (error) { if (this.disconnected) return ok(undefined); const known = connectionError(error); if (known) return err(known); throw error; }
        if (chunk.done) return err(this.connectionClosed());
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const frame = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (Buffer.byteLength(frame) > maxFrameBytes) return err(new ProtocolError("Runtime frame is too large."));
          const json = parseJson(frame, "runtime event"); if (!json.ok) return err(new ProtocolError(json.error.message, { cause: json.error }));
          const parsed = parseSnapshot(json.value); if (!parsed.ok) return parsed;
          if (parsed.value.instance !== this.state.instance) return err(new ProtocolError("Service instance changed."));
          this.state = parsed.value;
          const open = new Set(this.state.repositories.flatMap((repo) => repo.worktrees.flatMap((tree) => tree.sessions.map((session) => session.id))));
          for (const id of this.hidden) if (!open.has(id)) this.hidden.delete(id);
          this.emit();
        }
        if (Buffer.byteLength(buffer) > maxFrameBytes) return err(new ProtocolError("Runtime frame is too large."));
      }
      return ok(undefined);
    } finally {
      try { await reader.cancel(); }
      catch (error) { if (!connectionError(error) && !(this.disconnected && error instanceof Error && error.name === "AbortError")) reportUnexpected(error, "stream cleanup"); }
      reader.releaseLock();
    }
  }
  private connectionClosed(): ConnectionError { return new ConnectionError("CONNECTION_FAILED", "Runtime client is disconnected; reconnect to observe the action outcome."); }
  private emit(): void { for (const listener of this.listeners) listener(); }
}

export async function fetchSnapshot(paths: RuntimePaths): Promise<Result<RuntimeSnapshot | null, ExpectedError>> {
  const response = await transport(paths, "/snapshot", { signal: AbortSignal.timeout(500) });
  if (!response.ok) return response.error.code === "RUNTIME_ABSENT" ? ok(null) : response;
  if (!response.value.ok) return err(new ProtocolError(`Runtime snapshot failed: ${response.value.status}`));
  const body = await readJson(response.value); return body.ok ? parseSnapshot(body.value) : body;
}
async function transport(paths: RuntimePaths, path: string, options: RequestInit): Promise<Result<Response, ConnectionError>> {
  try { return ok(await fetch(`http://localhost${path}`, { ...options, unix: paths.socket })); }
  catch (error) { const known = connectionError(error); if (known) return err(known); throw error; }
}
function connectionError(error: unknown): ConnectionError | null {
  const code = systemCode(error);
  if (code === "ENOENT" || code === "ECONNREFUSED") return new ConnectionError("RUNTIME_ABSENT", "No runtime service is listening.", { cause: error });
  if ((error instanceof Error && error.name === "TimeoutError") || code === "ETIMEDOUT") return new ConnectionError("CONNECTION_TIMEOUT", "Runtime request timed out.", { cause: error });
  if (["EACCES", "EPERM", "ECONNRESET", "EPIPE", "EIO"].includes(code ?? "")) return new ConnectionError("CONNECTION_FAILED", `Runtime connection failed (${code}).`, { cause: error });
  return null;
}
async function readJson(response: Response): Promise<Result<unknown, ExpectedError>> {
  let text: string;
  try { text = await response.text(); }
  catch (error) { const known = connectionError(error); if (known) return err(known); throw error; }
  const json = parseJson(text, "runtime response"); return json.ok ? json : err(new ProtocolError(json.error.message, { cause: json.error }));
}
function remoteError(error: string | WireError): RemoteError {
  return typeof error === "string" ? new RemoteError("LEGACY_REMOTE_ERROR", error, "unknown") : new RemoteError(error.code, error.message, error.outcome);
}
export function defaultPreferences(): RuntimePreferences { return structuredClone(emptyPreferences); }
