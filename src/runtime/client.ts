import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { Value } from "typebox/value";
import type { Repository } from "../workspace/model.ts";
import type { HistoryItem } from "../agents/history.ts";
import type { HistoryPreview } from "../agents/history-preview.ts";
import { CapabilityError, CancelledError, capture, ConnectionError, InputError, parseJson, ProtocolError, reportUnexpected, systemCode, withCleanup, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { emptyPreferences, historySchema, historyPreviewSchema, historyPreviewQuerySchema, maxFrameBytes, maxSnapshotBytes, parseSnapshot, replySchema, type RuntimeCommand, type RuntimePreferences, type RuntimeSnapshot, type EditorFrame } from "./protocol.ts";
import { privateDirectory, runtimePaths, type RuntimePaths } from "./storage.ts";
import { connectionError, readBytes, readJson, remoteError, transport } from "./transport.ts";
import { PtyConnection } from "./pty/client.ts";
import { completionCatalogQuerySchema, completionCatalogSchema, completionQuerySchema, completionResultSchema } from "./completion-protocol.ts";
import type { CompletionCatalog, CompletionQuery, CompletionResult } from "../agents/completion.ts";
import { NdjsonDecoder } from "./frames.ts";
import { parseSessionControl } from "../agents/session-controls.ts";
import { modelCatalogQuerySchema, modelCatalogSchema, modelEffortSchema, modelIdentitySchema, parseModelCommand, type ModelCatalog, type ModelEffort, type ModelIdentity } from "../agents/model-selection.ts";

import { maximumPreviewImageBytes, transcriptImageQuerySchema } from "../agents/transcript-images.ts";

const reconnectDelays = [250, 500, 1000, 2000] as const;
const streamHandshakeMs = 2000;
const stableConnectionMs = 10000;

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
  private readonly hiddenTerminals = new Set<string>();
  private readonly streamAbort = new AbortController();
  private streamTask: Promise<void> | undefined;
  private attachment: Promise<Result<void, ExpectedError>> | undefined;
  private disconnected = false;
  private detaching = false;
  private ptyDetachment: Promise<void> | undefined;
  private disconnection: Promise<void> | undefined;
  private connectionEpoch = 0;
  private readonly connections = new Set<PtyConnection>();
  private failure = "";
  private warning = "";
  constructor(readonly paths: RuntimePaths, snapshot: RuntimeSnapshot) { this.state = snapshot; }
  get connected(): boolean { return !this.detaching && !this.failure; }
  get snapshot(): RuntimeSnapshot {
    if (!this.hidden.size && !this.hiddenTerminals.size && !this.failure && !this.warning) return this.state;
    const details = Object.fromEntries(Object.entries(this.state.details).filter(([id]) => !this.hidden.has(id)).map(([id, state]) => [id,
      this.failure && state.status === "working" ? { ...state, status: null, error: this.failure } : state]));
    return { ...this.state, notice: this.failure || this.warning || this.state.notice, details,
      ...(this.state.terminals ? { terminals: this.state.terminals.filter((terminal) => !this.hiddenTerminals.has(terminal.id)) } : {}),
      repositories: this.state.repositories.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => ({ ...tree,
        sessions: tree.sessions.filter((session) => !this.hidden.has(session.id)).map((session) => ({ ...session,
          status: this.failure && session.status === "working" ? null : session.status,
          subagents: session.subagents.map((agent) => ({ ...agent, status: this.failure && agent.status === "working" ? null : agent.status })),
        })),
      })) })),
    };
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  attach(): Promise<Result<void, ExpectedError>> {
    if (this.detaching) return Promise.resolve(err(this.connectionClosed()));
    if (this.attachment) return this.attachment;
    const ready = Promise.withResolvers<Result<void, ExpectedError>>();
    let established = false;
    this.attachment = ready.promise;
    this.streamTask = this.watch(() => { established = true; ready.resolve(ok(undefined)); }).then((result) => {
      if (!this.detaching && !result.ok) {
        this.failure = `${result.error.message} Reconnection stopped; use the configured detach command and reopen radian. No commands were replayed.`;
        this.emit();
      }
      ready.resolve(this.detaching ? err(this.connectionClosed()) : result);
    }).catch((error: unknown) => {
      if (!established) { this.failure = "Runtime attachment failed."; ready.reject(error); return; }
      this.failure = reportUnexpected(error, "runtime stream");
      this.invalidatePtys();
      if (!this.detaching) this.emit();
    });
    return this.attachment;
  }

  private async watch(onReady: () => void): Promise<Result<void, ExpectedError>> {
    let retries = 0;
    while (!this.detaching) {
      let connectedAt: number | undefined;
      const result = await this.listen(() => { connectedAt ??= Date.now(); onReady(); });
      if (this.detaching) return ok(undefined);
      if (result.ok) return result;
      this.failure = result.error.message;
      this.invalidatePtys();
      // Permission/protocol errors and programming defects are not transient disconnections.
      if (!(result.error instanceof ConnectionError) || ["EACCES", "EPERM"].includes(systemCode(result.error.cause) ?? "")) return result;
      if (connectedAt !== undefined && Date.now() - connectedAt >= stableConnectionMs) retries = 0;
      const delay = reconnectDelays[retries++];
      if (delay === undefined) return result;
      this.failure = `${result.error.message} Reconnecting (${retries}/${reconnectDelays.length})...`;
      this.emit();
      await this.waitToReconnect(delay);
    }
    return ok(undefined);
  }

  private async listen(onReady: () => void): Promise<Result<void, ExpectedError>> {
    const handshake = new AbortController();
    const signal = AbortSignal.any([this.streamAbort.signal, handshake.signal]);
    const timer = setTimeout(() => handshake.abort(new DOMException("Runtime stream handshake timed out.", "TimeoutError")), streamHandshakeMs);
    try {
      const response = await transport(this.paths, "/events", { signal }); if (!response.ok) return response;
      if (!response.value.ok || !response.value.body) {
        await response.value.body?.cancel();
        return err(new ProtocolError("Runtime event stream is unavailable."));
      }
      return await this.consume(response.value.body, () => { clearTimeout(timer); onReady(); });
    } catch (error) {
      if (this.detaching && error instanceof Error && error.name === "AbortError") return ok(undefined);
      if (handshake.signal.aborted && (error === handshake.signal.reason || error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) {
        return err(new ConnectionError("CONNECTION_TIMEOUT", "Runtime stream handshake timed out.", { cause: error }));
      }
      throw error;
    } finally { clearTimeout(timer); }
  }

  private waitToReconnect(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); this.streamAbort.signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, milliseconds);
      this.streamAbort.signal.addEventListener("abort", finish, { once: true });
      if (this.detaching) finish();
    });
  }
  async create(worktreeId: string): Promise<Result<string, ExpectedError>> {
    const result = await this.command({ type: "create", worktreeId });
    if (!result.ok) return result;
    return result.value ? ok(result.value) : err(new ProtocolError("Runtime did not return a session ID."));
  }
  async models(sessionId: string, conversationId: string, signal?: AbortSignal): Promise<Result<ModelCatalog, ExpectedError>> {
    if (this.detaching || this.failure) return err(this.connectionClosed());
    if (!this.state.capabilities?.includes("model-selection")) return err(new CapabilityError("Running service predates model selection. Finish work and explicitly restart it when ready; no service was restarted."));
    if (!this.state.capabilities?.includes("model-effort")) return err(new CapabilityError("Running service predates model effort selection. Finish work and explicitly restart it when ready; no service was restarted."));
    if (signal?.aborted) return err(new CancelledError());
    if (!Value.Check(modelCatalogQuerySchema, { sessionId, conversationId })) return err(new InputError("Invalid model selection conversation identity."));
    const instance = this.state.instance, epoch = this.connectionEpoch;
    const abort = AbortSignal.any([this.streamAbort.signal, AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
    const request = await capture(() => transport(this.paths, `/models?${new URLSearchParams({ sessionId, conversationId })}`, { headers: { "X-Radian-Instance": instance }, signal: abort }));
    if (!request.ok) return request;
    if (!request.value.ok) return request.value;
    const response = request.value.value;
    const decoded = await capture(() => readJson(response)); if (!decoded.ok) return decoded;
    if (!decoded.value.ok) return decoded.value;
    if (signal?.aborted || epoch !== this.connectionEpoch || instance !== this.state.instance || this.state.details[sessionId]?.conversationId !== conversationId) return err(new CancelledError("Model list belongs to an outdated conversation or connection."));
    const body = decoded.value.value;
    if (!response.ok) return Value.Check(replySchema, body) && !body.ok ? err(remoteError(body.error)) : err(new ProtocolError("Malformed model lookup failure response."));
    return Value.Check(modelCatalogSchema, body) && body.conversationId === conversationId ? ok(body) : err(new ProtocolError("Malformed or mismatched model catalog."));
  }

  async selectModel(sessionId: string, conversationId: string, model: ModelIdentity, effort?: ModelEffort): Promise<Result<string | null, ExpectedError>> {
    if (!this.state.capabilities?.includes("model-selection")) return err(new CapabilityError("Running service predates model selection. Finish work and explicitly restart it when ready. No model was changed."));
    if (!Value.Check(modelIdentitySchema, model)) return err(new InputError("Invalid model identity."));
    if (effort !== undefined && !Value.Check(modelEffortSchema, effort)) return err(new InputError("Invalid model effort."));
    if (effort !== undefined && !this.state.capabilities?.includes("model-effort")) return err(new CapabilityError("Running service predates model effort selection. No settings were changed. Finish work and explicitly restart it when ready."));
    return this.command({ type: "model-select", sessionId, conversationId, model, ...(effort !== undefined ? { effort } : {}) }, { instance: this.state.instance, epoch: this.connectionEpoch });
  }

  async catalog(sessionId: string, signal?: AbortSignal): Promise<Result<CompletionCatalog, ExpectedError>> {
    if (this.detaching || this.failure) return err(this.connectionClosed());
    if (!this.state.capabilities?.includes("completion-catalog")) return err(new CapabilityError("Running service predates cached command/skill catalogs. Finish work and explicitly restart it when ready. No service was restarted."));
    const conversationId = this.state.details[sessionId]?.conversationId;
    if (!conversationId || !Value.Check(completionCatalogQuerySchema, { sessionId, conversationId })) return err(new ProtocolError("Current conversation identity is unavailable."));
    if (signal?.aborted) return err(new CancelledError());
    const instance = this.state.instance, epoch = this.connectionEpoch;
    const abort = AbortSignal.any([this.streamAbort.signal, AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
    const requested = await capture(() => transport(this.paths, `/completion-catalog?${new URLSearchParams({ sessionId, conversationId })}`, { headers: { "X-Radian-Instance": instance }, signal: abort }));
    if (!requested.ok) return requested;
    if (!requested.value.ok) return requested.value;
    const response = requested.value.value;
    const decoded = await capture(() => readJson(response)); if (!decoded.ok) return decoded;
    if (!decoded.value.ok) return decoded.value;
    if (signal?.aborted || epoch !== this.connectionEpoch || instance !== this.state.instance || this.state.details[sessionId]?.conversationId !== conversationId) return err(new CancelledError("Catalog belongs to an outdated conversation or connection."));
    const body = decoded.value.value;
    if (!response.ok) return Value.Check(replySchema, body) && !body.ok ? err(remoteError(body.error)) : err(new ProtocolError("Malformed catalog lookup failure."));
    return Value.Check(completionCatalogSchema, body) && body.conversationId === conversationId ? ok(body) : err(new ProtocolError("Malformed or mismatched completion catalog."));
  }

  async complete(sessionId: string, query: CompletionQuery, signal?: AbortSignal): Promise<Result<CompletionResult, ExpectedError>> {
    if (this.detaching || this.failure) return err(this.connectionClosed());
    if (!this.state.capabilities?.includes("prompt-completion")) return err(new CapabilityError("Running service predates prompt completion. Save work and restart it explicitly when ready; no service was restarted."));
    if (signal?.aborted) return err(new CancelledError());
    if (!Value.Check(completionQuerySchema, { sessionId, kind: query.kind, query: query.query })) return err(new InputError("Invalid completion query; names and queries are limited to 4,096 characters."));
    const instance = this.state.instance, epoch = this.connectionEpoch;
    const abort = AbortSignal.any([this.streamAbort.signal, AbortSignal.timeout(8000), ...(signal ? [signal] : [])]);
    const params = new URLSearchParams({ sessionId, kind: query.kind, query: query.query });
    const attempted = await capture(() => transport(this.paths, `/completions?${params}`, { headers: { "X-Radian-Instance": instance }, signal: abort }));
    if (!attempted.ok) return attempted;
    const response = attempted.value; if (!response.ok) return response;
    const decoded = await capture(() => readJson(response.value)); if (!decoded.ok) return decoded;
    const body = decoded.value; if (!body.ok) return body;
    if (epoch !== this.connectionEpoch || instance !== this.state.instance || signal?.aborted) return err(new CancelledError("Completion belongs to an outdated connection."));
    if (!response.value.ok) return Value.Check(replySchema, body.value) && !body.value.ok ? err(remoteError(body.value.error)) : err(new ProtocolError("Malformed completion failure response."));
    return Value.Check(completionResultSchema, body.value) ? ok(body.value) : err(new ProtocolError("Malformed completion response."));
  }
  async image(sessionId: string, imageId: string, signal?: AbortSignal): Promise<Result<Uint8Array, ExpectedError>> {
    if (this.detaching || this.failure) return err(this.connectionClosed());
    if (!this.state.capabilities?.includes("transcript-images")) return err(new CapabilityError("Running service predates image previews. Finish work and restart it explicitly when ready; no service was restarted."));
    if (signal?.aborted) return err(new CancelledError());
    if (!Value.Check(transcriptImageQuerySchema, { sessionId, imageId })) return err(new InputError("Invalid image preview identity."));
    const instance = this.state.instance, epoch = this.connectionEpoch, conversation = this.state.details[sessionId]?.conversationId;
    const abort = AbortSignal.any([this.streamAbort.signal, AbortSignal.timeout(8000), ...(signal ? [signal] : [])]);
    const requested = await capture(() => transport(this.paths, `/images?${new URLSearchParams({ sessionId, imageId })}`, { headers: { "X-Radian-Instance": instance }, signal: abort }));
    if (!requested.ok) return requested;
    const response = requested.value; if (!response.ok) return response;
    const reply = response.value;
    if (!reply.ok) {
      const decoded = await capture(() => readJson(reply)); if (!decoded.ok) return decoded;
      if (!decoded.value.ok) return decoded.value;
      const body = decoded.value.value;
      return Value.Check(replySchema, body) && !body.ok ? err(remoteError(body.error)) : err(new ProtocolError("Malformed image preview failure response."));
    }
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(reply.headers.get("Content-Type")?.split(";", 1)[0] ?? "")) {
      await reply.body?.cancel(); return err(new ProtocolError("Image preview response has an unsupported content type."));
    }
    const decoded = await capture(() => readBytes(reply, { maximumBytes: maximumPreviewImageBytes, label: "Image preview" }));
    if (!decoded.ok) return decoded;
    if (signal?.aborted || epoch !== this.connectionEpoch || instance !== this.state.instance || conversation !== this.state.details[sessionId]?.conversationId) return err(new CancelledError("Image preview belongs to an outdated conversation."));
    return decoded.value;
  }
  async listHistory(worktreeId: string, signal?: AbortSignal): Promise<Result<readonly HistoryItem[], ExpectedError>> {
    const capability = this.requireHistory(); if (!capability.ok) return capability;
    if (signal?.aborted) return err(new CancelledError());
    const epoch = this.connectionEpoch, instance = this.state.instance;
    const abort = AbortSignal.any([this.streamAbort.signal, AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
    const attempted = await capture(() => transport(this.paths, `/history?worktreeId=${encodeURIComponent(worktreeId)}`, { headers: { "X-Radian-Instance": instance }, signal: abort }));
    if (!attempted.ok) return attempted;
    const response = attempted.value; if (!response.ok) return response;
    const decoded = await capture(() => readJson(response.value)); if (!decoded.ok) return decoded;
    const body = decoded.value; if (!body.ok) return body;
    if (signal?.aborted || epoch !== this.connectionEpoch || instance !== this.state.instance) return err(new CancelledError("History belongs to an outdated connection."));
    if (!response.value.ok) {
      return Value.Check(replySchema, body.value) && !body.value.ok ? err(remoteError(body.value.error)) : err(new ProtocolError("Malformed history failure response."));
    }
    return Value.Check(historySchema, body.value) && body.value.every((item) => item.worktreeId === worktreeId) ? ok(body.value) : err(new ProtocolError("Malformed or mismatched history response."));
  }
  async previewHistory(worktreeId: string, savedId: string, signal?: AbortSignal): Promise<Result<HistoryPreview, ExpectedError>> {
    if (this.detaching || this.failure) return err(this.connectionClosed());
    if (!this.state.capabilities?.includes("history-preview")) return err(new CapabilityError("Running service predates history preview. Save work and restart it explicitly when ready; no service was restarted. Search and Open remain available."));
    if (signal?.aborted) return err(new CancelledError());
    if (!Value.Check(historyPreviewQuerySchema, { worktreeId, savedId })) return err(new InputError("Invalid history preview identity."));
    const instance = this.state.instance, epoch = this.connectionEpoch;
    const abort = AbortSignal.any([this.streamAbort.signal, AbortSignal.timeout(8000), ...(signal ? [signal] : [])]);
    const response = await capture(() => transport(this.paths, `/history/preview?${new URLSearchParams({ worktreeId, savedId })}`, { headers: { "X-Radian-Instance": instance }, signal: abort }));
    if (!response.ok) return response;
    if (!response.value.ok) return response.value;
    const reply = response.value.value;
    const decoded = await capture(() => readJson(reply)); if (!decoded.ok) return decoded;
    if (!decoded.value.ok) return decoded.value;
    if (epoch !== this.connectionEpoch || instance !== this.state.instance || signal?.aborted) return err(new CancelledError("History preview belongs to an outdated connection."));
    const body = decoded.value.value;
    if (!reply.ok) return Value.Check(replySchema, body) && !body.ok ? err(remoteError(body.error)) : err(new ProtocolError("Malformed history preview failure response."));
    return Value.Check(historyPreviewSchema, body) && body.id === savedId && body.worktreeId === worktreeId ? ok(body) : err(new ProtocolError("Malformed or mismatched history preview response."));
  }
  async resume(worktreeId: string, savedId: string): Promise<Result<string, ExpectedError>> {
    const capability = this.requireHistory(); if (!capability.ok) return capability;
    const result = await this.command({ type: "resume", worktreeId, savedId }); if (!result.ok) return result;
    if (!result.value) return err(new ProtocolError("Runtime did not return a resumed session ID."));
    const opened = await this.waitForOpen(result.value); return opened.ok ? ok(result.value) : opened;
  }
  private waitForOpen(id: string): Promise<Result<void, ExpectedError>> {
    const present = () => this.snapshot.repositories.some((repo) => repo.worktrees.some((tree) => tree.sessions.some((session) => session.id === id)));
    return this.waitForState(present, "Resume");
  }
  private waitForState(present: () => boolean, action: string): Promise<Result<void, ExpectedError>> {
    if (present()) return Promise.resolve(ok(undefined));
    if (this.detaching || this.failure) return Promise.resolve(err(this.connectionClosed()));
    return new Promise((resolve) => {
      const finish = (result: Result<void, ExpectedError>) => { clearTimeout(timer); unsubscribe(); this.streamAbort.signal.removeEventListener("abort", aborted); resolve(result); };
      const timer = setTimeout(() => finish(err(new ConnectionError("CONNECTION_TIMEOUT", `${action} was accepted, but its snapshot did not arrive. Reconnect before retrying.`))), 15000);
      const aborted = () => finish(err(this.connectionClosed()));
      const unsubscribe = this.subscribe(() => { if (present()) finish(ok(undefined)); else if (this.failure) finish(err(this.connectionClosed())); });
      this.streamAbort.signal.addEventListener("abort", aborted, { once: true });
    });
  }
  private requireHistory(): Result<void, ExpectedError> {
    if (this.detaching || this.failure) return err(this.connectionClosed());
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
  async interrupt(sessionId: string): Promise<Result<void, ExpectedError>> {
    if (!this.state.capabilities?.includes("agent-interrupt")) return err(new CapabilityError("Running service predates agent interruption. Finish work and explicitly restart it when ready. No interrupt was sent."));
    const conversationId = this.state.details[sessionId]?.conversationId;
    if (!conversationId) return err(new ProtocolError("Current conversation identity is unavailable. No interrupt was sent."));
    const result = await this.command({ type: "interrupt", sessionId, conversationId });
    return result.ok ? ok(undefined) : result;
  }
  async newTab(sessionId: string): Promise<Result<string, ExpectedError>> {
    if (!this.state.capabilities?.includes("session-tab-commands")) return err(new CapabilityError("Running service predates /new tab creation and /clear. Finish work and restart it explicitly when ready. No command was sent."));
    const conversationId = this.state.details[sessionId]?.conversationId;
    if (!conversationId) return err(new ProtocolError("Current conversation identity is unavailable. No new-tab command was sent."));
    const binding = { instance: this.state.instance, epoch: this.connectionEpoch };
    const result = await this.command({ type: "session-control", sessionId, conversationId, action: "new-tab" }, binding);
    if (!result.ok) return result;
    if (!result.value) return err(new ProtocolError("New-tab creation was accepted without a session ID. Inspect open tabs before retrying."));
    const id = result.value;
    const present = await this.waitForState(() => this.state.instance === binding.instance && this.connectionEpoch === binding.epoch
      && this.snapshot.repositories.some((repo) => repo.worktrees.some((tree) => tree.sessions.some((session) => session.id === id))), "New-tab creation");
    return present.ok ? ok(id) : present;
  }
  async prompt(sessionId: string, text: string, images: readonly string[] = []): Promise<Result<void, ExpectedError>> {
    const model = parseModelCommand(text); if (!model.ok) return model;
    if (model.value) return err(new CapabilityError("Use /model in the Agent input to open the model picker. No prompt was sent."));
    const control = parseSessionControl(text); if (!control.ok) return control;
    const conversationId = this.state.details[sessionId]?.conversationId;
    if (control.value) {
      if (images.length) return err(new InputError(`/${control.value.action === "new-tab" ? "new" : control.value.action} does not accept image attachments. Input was retained.`));
      if (control.value.action === "new-tab") { const result = await this.newTab(sessionId); return result.ok ? ok(undefined) : result; }
      const capability = control.value.action === "reload" ? "resource-reload" : control.value.action === "clear" ? "session-tab-commands" : "session-controls";
      if (!this.state.capabilities?.includes(capability)) return err(new CapabilityError("Running service predates this session command. Finish work and restart it explicitly when ready. No prompt was sent."));
      if (!conversationId) return err(new ProtocolError("Current conversation identity is unavailable. Reconnect before retrying. No command was sent."));
      const revision = this.state.details[sessionId]?.resourceRevision ?? 0;
      const binding = { instance: this.state.instance, epoch: this.connectionEpoch };
      const result = await this.command({ type: "session-control", sessionId, conversationId, ...control.value }, binding);
      if (!result.ok) return result;
      if (control.value.action === "reload") return this.waitForState(() => this.state.instance === binding.instance && this.connectionEpoch === binding.epoch
        && this.state.details[sessionId]?.conversationId === conversationId
        && (this.state.details[sessionId]?.resourceRevision ?? 0) > revision, "Resource reload");
      return ok(undefined);
    }
    if (text.startsWith("$") && !this.state.capabilities?.includes("completion-catalog")) return err(new CapabilityError("Running service predates $skill invocations. Finish work and explicitly restart it when ready. No model prompt was sent."));
    if (images.length && !this.state.capabilities?.includes("prompt-images")) return err(new CapabilityError("Running service predates image input. Input was retained; finish work and restart the service explicitly when ready. No prompt was sent."));
    // The old wire schema capped text at 1,000,000 UTF-16 units. Do not submit a
    // new large draft to a service that cannot accept it, or restart live work.
    if (text.length > 1000000 && !this.state.capabilities?.includes("prompt-images")) return err(new CapabilityError("Running service predates large input. Input was retained; restart the service explicitly after finishing work. No prompt was sent."));
    if (/^\/fast(?:\s|$)/.test(text)) {
      // An older SDK treats unknown slash commands as model input. Never turn a settings command into a paid prompt.
      const unsupported = () => err(new CapabilityError("Running service has no /fast control. Finish jobs and restart it explicitly. No prompt was sent."));
      if (!this.state.capabilities?.includes("prompt-completion")) return unsupported();
      const commands = await this.complete(sessionId, { kind: "command", query: "fast" });
      if (!commands.ok) return commands;
      if (!commands.value.items.some((command) => command.kind === "command" && command.value === "fast")) return unsupported();
    }
    const result = await this.command({ type: "prompt", sessionId, text, ...(images.length ? { images: [...images] } : {}),
      ...(this.state.capabilities?.includes("session-controls") && conversationId ? { conversationId } : {}),
      ...(this.state.capabilities?.includes("completion-catalog") && /^[/$]/u.test(text) ? { resourceRevision: this.state.details[sessionId]?.resourceRevision ?? 0 } : {}) });
    return result.ok ? ok(undefined) : result;
  }
  async savePreferences(preferences: RuntimePreferences): Promise<Result<void, ExpectedError>> { const result = await this.command({ type: "preferences", preferences }); return result.ok ? ok(undefined) : result; }
  async stopRuntime(): Promise<Result<void, ExpectedError>> { const result = await this.command({ type: "stop" }); return result.ok ? ok(undefined) : result; }
  async openEditor(worktreeId: string, size?: { cols: number; rows: number }): Promise<Result<string, ExpectedError>> {
    const capability = this.requireWorkViews(); if (!capability.ok) return capability;
    const result = await this.command({ type: "editor-open", worktreeId, ...size });
    if (!result.ok) return result;
    return result.value ? ok(result.value) : err(new ProtocolError("Runtime did not return an editor ID."));
  }
  async attachEditor(id: string, onFrame: (frame: EditorFrame) => void, onFailure: (error: unknown) => void): Promise<Result<PtyConnection, ExpectedError>> {
    const capability = this.requireWorkViews(); if (!capability.ok) return capability;
    const binding = this.ptyBinding();
    const editor = new PtyConnection(this.paths, id, "/editor/events", (request) => {
      switch (request.type) {
        case "input": return binding.send({ type: "editor-input", editorId: id, lease: request.lease, data: request.data });
        case "resize": return binding.send({ type: "editor-resize", editorId: id, lease: request.lease, cols: request.cols, rows: request.rows });
        case "detach": return binding.send({ type: "editor-detach", editorId: id, lease: request.lease });
        case "scroll": return Promise.resolve(err(new CapabilityError("Editor does not provide shell scrollback.")));
      }
    }, onFrame, onFailure, binding.instance);
    return this.attachPty(editor);
  }
  get supportsTerminals(): boolean { return this.state.capabilities?.includes("terminal-tabs") ?? false; }
  private requireTerminals(): Result<void, ExpectedError> {
    if (this.detaching || this.failure) return err(this.connectionClosed());
    return this.supportsTerminals ? ok(undefined) : err(new CapabilityError("Running service predates terminal tabs. Save work and explicitly restart the service when ready; no service was restarted."));
  }
  async createTerminal(worktreeId: string, size: { cols: number; rows: number }): Promise<Result<string, ExpectedError>> {
    const supported = this.requireTerminals(); if (!supported.ok) return supported;
    const result = await this.command({ type: "terminal-create", worktreeId, ...size });
    if (!result.ok) return result;
    const id = result.value;
    if (!id) return err(new ProtocolError("Runtime did not return a terminal ID."));
    const present = await this.waitForState(() => this.snapshot.terminals?.some((terminal) => terminal.id === id) ?? false, "Terminal creation");
    return present.ok ? ok(id) : present;
  }
  async attachTerminal(id: string, onFrame: (frame: EditorFrame) => void, onFailure: (error: unknown) => void): Promise<Result<PtyConnection, ExpectedError>> {
    const supported = this.requireTerminals(); if (!supported.ok) return supported;
    const binding = this.ptyBinding();
    return this.attachPty(new PtyConnection(this.paths, id, "/terminal/events", (request) => {
      switch (request.type) {
        case "input": return binding.send({ type: "terminal-input", terminalId: id, lease: request.lease, data: request.data });
        case "resize": return binding.send({ type: "terminal-resize", terminalId: id, lease: request.lease, cols: request.cols, rows: request.rows });
        case "scroll": return binding.send({ type: "terminal-scroll", terminalId: id, lease: request.lease, lines: request.lines });
        case "detach": return binding.send({ type: "terminal-detach", terminalId: id, lease: request.lease });
      }
    }, onFrame, onFailure, binding.instance));
  }
  async closeTerminal(id: string): Promise<Result<void, ExpectedError>> {
    const supported = this.requireTerminals(); if (!supported.ok) return supported;
    this.hiddenTerminals.add(id); this.emit();
    try {
      const result = await this.command({ type: "terminal-close", terminalId: id });
      if (!result.ok) { this.hiddenTerminals.delete(id); this.emit(); return result; }
      return ok(undefined);
    } catch (error) { this.hiddenTerminals.delete(id); this.emit(); throw error; }
  }
  private async attachPty(editor: PtyConnection): Promise<Result<PtyConnection, ExpectedError>> {
    this.connections.add(editor);
    editor.closed.finally(() => this.connections.delete(editor));
    let attached: Result<void, ExpectedError>;
    try { attached = await editor.attach(); }
    catch (error) { await editor.disconnect(); throw error; }
    if (!attached.ok) { await editor.disconnect(); return attached; }
    if (this.detaching) { await editor.disconnect(); return err(this.connectionClosed()); }
    return ok(editor);
  }
  private requireWorkViews(): Result<void, ExpectedError> {
    if (this.detaching || this.failure) return err(this.connectionClosed());
    return this.state.capabilities?.includes("work-views") ? ok(undefined)
      : err(new CapabilityError("Running service predates work views. Finish its jobs, explicitly stop it, then restart radian. No service was restarted."));
  }
  private ptyBinding() {
    const instance = this.state.instance, epoch = this.connectionEpoch;
    return { instance, send: (command: RuntimeCommand) => this.command(command, { instance, epoch }) };
  }
  private invalidatePtys(): void {
    this.connectionEpoch++;
    const error = new ConnectionError("CONNECTION_FAILED", "Runtime subscription interrupted. Reconnect this editor/terminal explicitly; no input was replayed.");
    for (const connection of [...this.connections]) connection.invalidate(error);
  }
  // Cancel recovery immediately while the UI finishes its final preference writes.
  // Already-queued healthy PTY input is drained once; no new input is accepted.
  beginDetach(): void {
    if (this.detaching) return;
    this.detaching = true; this.streamAbort.abort();
    this.ptyDetachment = Promise.allSettled([...this.connections].map((connection) => connection.disconnect())).then((results) => {
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "PTY client detach failed.");
    });
    void this.ptyDetachment.catch(() => {}); // disconnect() below owns the eventual cleanup result.
  }
  disconnect(): Promise<void> {
    this.beginDetach();
    this.disconnection ??= this.finishDisconnect();
    return this.disconnection;
  }
  private async finishDisconnect(): Promise<void> {
    try { await this.ptyDetachment; }
    finally { this.disconnected = true; await this.streamTask; this.listeners.clear(); }
  }

  private async command(command: RuntimeCommand, binding?: { instance: string; epoch: number }): Promise<Result<string | null, ExpectedError>> {
    if (this.disconnected || this.failure || this.detaching && !binding && command.type !== "preferences") return err(this.connectionClosed());
    if (binding && (binding.instance !== this.state.instance || binding.epoch !== this.connectionEpoch)) return err(this.connectionClosed());
    const instance = binding?.instance ?? this.state.instance;
    const payload = JSON.stringify(command);
    if (Buffer.byteLength(payload) > maxFrameBytes) return err(new InputError("Runtime payload exceeds the 8 MiB safety limit. Nothing was sent; input was retained."));
    const response = await transport(this.paths, "/command", { method: "POST", body: payload,
      headers: { "Content-Type": "application/json", "X-Radian-Instance": instance }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return err(new ConnectionError(response.error.code, `${response.error.message} Action outcome is unknown; reconnect before retrying.`, { cause: response.error }));
    const body = await readJson(response.value); if (!body.ok) return body;
    if (!Value.Check(replySchema, body.value)) return err(new ProtocolError("Malformed runtime reply; action outcome is unknown."));
    if (!body.value.ok) return err(remoteError(body.value.error));
    // A late acknowledgement still reports the accepted action, but cannot overwrite
    // notices belonging to a replacement service or recovered connection.
    if (instance === this.state.instance && (!binding || binding.epoch === this.connectionEpoch)) {
      this.warning = body.value.warnings?.map((warning) => `Action accepted; ${warning.message}`).join(" · ") ?? "";
      if (this.warning) this.emit();
    }
    return ok(body.value.value);
  }
  private async consume(body: ReadableStream<Uint8Array>, onReady: () => void): Promise<Result<void, ExpectedError>> {
    const reader = body.getReader(); const frames = new NdjsonDecoder(maxSnapshotBytes, "Runtime snapshot");
    let firstFrame = true;
    try {
      while (!this.detaching) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try { chunk = await reader.read(); }
        catch (error) { if (this.detaching) return ok(undefined); const known = connectionError(error); if (known) return err(known); throw error; }
        if (this.detaching) return ok(undefined);
        if (chunk.done) return err(this.connectionClosed());
        for (const frame of frames.push(chunk.value)) {
          if (!frame.ok) return frame;
          const json = parseJson(frame.value, "runtime event"); if (!json.ok) return err(new ProtocolError(json.error.message, { cause: json.error }));
          const parsed = parseSnapshot(json.value); if (!parsed.ok) return parsed;
          if (parsed.value.repositoryId !== this.state.repositoryId || parsed.value.mode !== this.state.mode) return err(new ProtocolError("Runtime identity does not match this workspace."));
          if (parsed.value.instance !== this.state.instance) {
            if (!firstFrame) return err(new ProtocolError("Service instance changed within the event stream."));
            this.invalidatePtys();
            this.hidden.clear(); this.hiddenTerminals.clear();
            this.warning = "Runtime restarted; state restored. Interrupted actions were not replayed.";
          }
          this.state = parsed.value;
          this.failure = "";
          const open = new Set(this.state.repositories.flatMap((repo) => repo.worktrees.flatMap((tree) => tree.sessions.map((session) => session.id))));
          for (const id of this.hidden) if (!open.has(id)) this.hidden.delete(id);
          for (const id of this.hiddenTerminals) if (!this.state.terminals?.some((terminal) => terminal.id === id)) this.hiddenTerminals.delete(id);
          if (firstFrame) { firstFrame = false; onReady(); }
          this.emit();
        }
      }
      return ok(undefined);
    } finally {
      try { await reader.cancel(); }
      catch (error) { if (!connectionError(error) && !(this.detaching && error instanceof Error && error.name === "AbortError")) reportUnexpected(error, "stream cleanup"); }
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
  const body = await readJson(response.value, { maximumBytes: maxSnapshotBytes, label: "Runtime snapshot" }); return body.ok ? parseSnapshot(body.value) : body;
}
export function defaultPreferences(): RuntimePreferences { return structuredClone(emptyPreferences); }
