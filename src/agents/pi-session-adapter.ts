import {
  createAgentSession, DefaultResourceLoader, defineTool, getAgentDir, ModelRuntime, parseSkillBlock,
  SessionManager, SettingsManager, type AgentSession, type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { Type, type ImageContent } from "@earendil-works/pi-ai";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionState, SessionContext, SessionExecutor, SessionFactory } from "./session-registry.ts";
import { AgentRunError, CancelledError, CapabilityError, capture, InputError, knownError, reportUnexpected, SessionError, withCleanup, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { SessionTranscript } from "./transcript.ts";
import { runCompletionEntryType, type RunCompletion } from "./run-completion.ts";
import { PiSessionTelemetry } from "./pi-session-telemetry.ts";
import { CommandDiagnostics, sessionCommands } from "./session-commands.ts";
import { FastMode } from "./fast-mode.ts";
import type { UsageMonitor } from "../usage/monitor.ts";
import { loadPromptImages } from "./prompt-attachments.ts";
import { ManualCompaction } from "./manual-compaction.ts";
import { summarizeRequest } from "./request-summary.ts";

type QueuedUserMessage = Extract<ReturnType<AgentSession["agent"]["peekQueuedMessages"]>[number], { role: "user" }>;

export type PiSessionOptions = {
  agentDir?: string;
  sessionDir?: string;
  modelRuntime?: ModelRuntime;
  model?: NonNullable<AgentSession["model"]>;
  streamFn?: AgentSession["agent"]["streamFunction"];
  settings?: Partial<ReturnType<SettingsManager["getSettings"]>>;
  usageMonitor?: UsageMonitor;
  imageLoader?: (paths: readonly string[]) => Promise<Result<ImageContent[], ExpectedError>>;
};

export function piSessionFactory(options: PiSessionOptions = {}): SessionFactory {
  let runtime: Promise<ModelRuntime> | undefined;
  return async (context) => {
    if (!(await stat(context.cwd)).isDirectory()) throw new InputError("Session working directory is not a directory.");
    const agentDir = options.agentDir ?? getAgentDir();
    runtime ??= options.modelRuntime ? Promise.resolve(options.modelRuntime) : ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
    });
    const modelRuntime = await runtime;
    const settingsManager = options.streamFn ? SettingsManager.inMemory({
      retry: { enabled: false }, compaction: { enabled: false },
    }) : SettingsManager.create(context.cwd, agentDir);
    const fast = new FastMode();
    const compaction = new ManualCompaction();
    const resourceLoader = new DefaultResourceLoader({
      cwd: context.cwd, agentDir, settingsManager, noThemes: true, extensionFactories: [fast.extension, compaction.extension],
      ...(options.streamFn ? { noSkills: true, noContextFiles: true, noPromptTemplates: true } : {}),
    });
    await resourceLoader.reload();
    // Resource discovery reloads settings; apply host overrides only after that reload.
    settingsManager.applyOverrides({ ...options.settings, cacheWarming: "off" });
    const sessionManager = context.sessionFile
      ? SessionManager.open(context.sessionFile, options.sessionDir, context.cwd)
      : options.sessionDir ? SessionManager.create(context.cwd, options.sessionDir) : undefined;
    const { session } = await createAgentSession({
      cwd: context.cwd, agentDir, modelRuntime, settingsManager, resourceLoader,
      ...(context.startReason ? { sessionStartEvent: { type: "session_start", reason: context.startReason, ...(context.previousSessionFile ? { previousSessionFile: context.previousSessionFile } : {}) } as const } : {}),
      ...(sessionManager ? { sessionManager } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(context.role === "main" ? { customTools: [subagentTool(context)] } : {}),
    });
    let adopted = false;
    return withCleanup(async () => {
      await mkdir(session.sessionManager.getSessionDir(), { recursive: true });
      if (options.streamFn) session.agent.streamFunction = options.streamFn;
      const diagnostics = new CommandDiagnostics();
      const unsupportedSessionAction = async (): Promise<never> => { throw new CapabilityError("Pi session replacement/reload is not hosted here. Use Radian's session controls instead."); };
      await session.bindExtensions({ onError: diagnostics.report, commandContextActions: {
        waitForIdle: () => session.waitForIdle(), newSession: unsupportedSessionAction, fork: unsupportedSessionAction,
        switchSession: unsupportedSessionAction, navigateTree: unsupportedSessionAction, reload: unsupportedSessionAction,
      } });
      const executor = new PiSessionExecutor(session, options.usageMonitor, diagnostics, fast, options.imageLoader, compaction);
      adopted = true;
      return executor;
    }, async () => { if (!adopted) session.dispose(); });
  };
}

function subagentTool(context: SessionContext) {
  return defineTool({
    name: "radian_subagent", label: "Subagent",
    description: "Delegate a bounded task to an owned subagent in the same worktree. Wait for its result. The child cannot delegate further.",
    promptSnippet: "Delegate a task to a subagent in this worktree.",
    parameters: Type.Object({ name: Type.String({ minLength: 1 }), task: Type.String({ minLength: 1 }) }),
    execute: async (_id, { name, task }, signal) => {
      const result = await context.spawnSubagent(name, task, signal);
      // SDK tools require rejection for failures; never pass a Result error as successful tool content.
      if (!result.ok) throw result.error;
      return { content: [{ type: "text" as const, text: result.value }], details: {} };
    },
  });
}

export class PiSessionExecutor implements SessionExecutor {
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private status: ExecutionState["status"];
  private error: string | null = null;
  private partial = "";
  private readonly activeTools = new Map<string, string>();
  private readonly transcript: SessionTranscript;
  private readonly telemetry: PiSessionTelemetry;
  private readonly runs = new Set<Promise<Result<void, ExpectedError>>>();
  // Serialize only SDK admission, not model execution; messages live in Pi's queue.
  private admission: Promise<void> = Promise.resolve();
  private closeTask: Promise<Result<void, ExpectedError>> | undefined;
  private aborted = false;
  private runRevision = 0;
  private closing = false;
  private disposed = false;
  private controlling = false;
  private compacting = false;
  private inputRevision = 0;
  private interrupting = false;
  private interruptTask: Promise<Result<void, ExpectedError>> | undefined;
  // Own undelivered messages only while interrupting; the SDK owns the live queue.
  private interruptedMessages: QueuedUserMessage[] = [];
  private started: { wall: number; monotonic: number } | undefined;

  constructor(private readonly session: AgentSession, usage?: UsageMonitor, private readonly diagnostics = new CommandDiagnostics(), fast?: FastMode, private readonly imageLoader = loadPromptImages, private readonly compaction = new ManualCompaction()) {
    this.status = this.finalStatus(false);
    this.transcript = new SessionTranscript(session.sessionManager.getBranch());
    this.telemetry = new PiSessionTelemetry(session, () => this.emit(), usage, fast);
    this.unsubscribe = session.subscribe((event) => this.handleEvent(event));
  }

  commands() { return sessionCommands(this.session); }
  get busy(): boolean { return this.controlling || this.interrupting || !!this.interruptTask || this.interruptedMessages.length > 0 || this.runs.size > 0 || !this.session.isIdle || this.session.pendingMessageCount > 0; }
  get acceptsImages(): boolean { return this.session.model?.input.includes("image") ?? false; }
  get savedSessionId(): string { return this.session.sessionId; }
  get sessionFile(): string | undefined { return this.session.sessionFile; }
  get state(): ExecutionState {
    const messages = this.session.messages.slice(-12).flatMap((message) => {
      if (message.role === "user") {
        const text = typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
        return [`You: ${text}`];
      }
      if (message.role === "assistant") return [`Agent: ${message.content.filter((part) => part.type === "text").map((part) => part.text).join("")}`];
      if (message.role === "toolResult") return [`${message.toolName}: ${message.content.filter((part) => part.type === "text").map((part) => part.text).join("")}`];
      return [];
    });
    if (this.partial) messages.push(`Agent (streaming): ${this.partial}`);
    messages.push(...this.activeTools.values());
    return { conversationId: this.savedSessionId, status: this.status, output: messages.join("\n\n").slice(-12000), error: this.error,
      ...(this.status === "working" && this.compacting ? { activity: "compacting" as const } : {}),
      sections: this.transcript.sections, telemetry: this.telemetry.read(),
      pendingMessages: this.queuedMessages().map((message) => {
        const text = typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        const skill = parseSkillBlock(text);
        return summarizeRequest(skill ? skill.userMessage || `/skill:${skill.name}` : text,
          typeof message.content === "string" ? 0 : message.content.filter((part) => part.type === "image").length);
      }),
      ...(this.started ? { runTiming: { startedAt: this.started.wall, elapsedMs: Math.max(0, performance.now() - this.started.monotonic) } } : {}) };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  compact(instructions?: string, onAccepted?: () => void): Promise<Result<void, ExpectedError>> {
    if (this.closing || this.disposed) return Promise.resolve(err(new SessionError("SESSION_NOT_OPEN", "Session is closing.")));
    if (this.busy) return Promise.resolve(err(new SessionError("SESSION_BUSY", "Wait for this session's current work to finish before compacting. No work was interrupted.")));
    this.controlling = true;
    const before = { status: this.status, error: this.error };
    let accepted = false;
    const task = this.compaction.run(this.session, instructions, () => {
      accepted = true; this.status = "working"; this.error = null; this.emit(); onAccepted?.();
    }).then((result): Result<void, ExpectedError> => {
      if (result.ok) this.transcript.notice("Context compacted", result.value.summary);
      else if (accepted) this.transcript.notice(result.error instanceof CancelledError ? "Compaction cancelled" : "Compaction failed",
        `[${result.error.code}] ${result.error.message}`, result.error instanceof CancelledError ? "cancelled" : "error");
      this.status = before.status; this.error = before.error;
      this.telemetry.refreshUsage();
      return result.ok ? ok(undefined) : result;
    }).catch((error: unknown) => {
      this.status = "failure"; this.error = "Unexpected compaction failure. Inspect runtime.log.";
      if (accepted) this.transcript.notice("Compaction failed", this.error, "error");
      throw error;
    }).finally(() => { this.compacting = false; this.controlling = false; this.started = undefined; this.runs.delete(task); this.emit(); });
    this.runs.add(task); return task;
  }

  prompt(text: string, onAccepted?: () => void, imagePaths: readonly string[] = []): Promise<Result<void, ExpectedError>> {
    return this.promptInput(text, onAccepted, imagePaths);
  }

  private promptInput(text: string, onAccepted?: () => void, imagePaths: readonly string[] = [], replayImages?: ImageContent[]): Promise<Result<void, ExpectedError>> {
    if (this.interrupting) return Promise.resolve(err(new SessionError("SESSION_BUSY", "Interruption is in progress. Input was retained.")));
    if (this.controlling) return Promise.resolve(err(new SessionError("SESSION_BUSY", "Context compaction is in progress. Input was retained.")));
    if (this.closing || this.disposed) return Promise.resolve(err(new SessionError("SESSION_NOT_OPEN", "Session is closing.")));
    const revisionAtSubmission = this.inputRevision;
    const admitted = Promise.withResolvers<void>();
    const previous = this.admission;
    this.admission = admitted.promise;
    const task = previous.then(async (): Promise<Result<void, ExpectedError>> => {
      if (this.closing || this.disposed) return err(new SessionError("SESSION_NOT_OPEN", "Session is closing."));
      if (revisionAtSubmission !== this.inputRevision) return err(new CancelledError("Pending input was cancelled by interruption."));
      if (this.session.isCompacting && !this.session.isStreaming) return err(new SessionError("SESSION_BUSY", "Session is compacting; retry after it finishes."));
      // Preparation is part of admission: a later text request must not overtake
      // an earlier image request while its bytes are being read or normalized.
      const loaded = replayImages ? ok(replayImages) : imagePaths.length ? await this.imageLoader(imagePaths) : ok([]);
      if (!loaded.ok) return loaded;
      if (revisionAtSubmission !== this.inputRevision) return err(new CancelledError("Pending input was cancelled by interruption."));
      if (this.closing || this.disposed) return err(new SessionError("SESSION_NOT_OPEN", "Session closed while preparing image input."));
      if (this.session.isCompacting && !this.session.isStreaming) return err(new SessionError("SESSION_BUSY", "Session is compacting; retry after it finishes."));
      if ((imagePaths.length || replayImages?.length) && !this.acceptsImages) return err(new CapabilityError("The selected model no longer accepts image input. Input was retained."));
      const images = loaded.value;
      const before = { status: this.status, error: this.error, aborted: this.aborted };
      const revision = this.runRevision;
      const name = text.startsWith("/") ? text.slice(1).split(" ", 1)[0]! : "";
      const registered = name ? this.session.extensionRunner.getCommand(name) : undefined;
      if (images.length && registered) return err(new InputError(`/${name} does not accept image attachments. Send the images in an ordinary prompt instead.`));
      const command = registered ? this.diagnostics.begin(name) : undefined;
      let handled = false;
      if (this.session.isIdle) { this.status = "working"; this.error = null; this.aborted = false; }
      const result = await withCleanup(() => capture(() => this.session.prompt(text, {
        streamingBehavior: "steer",
        ...(replayImages ? { expandPromptTemplates: false } : {}),
        ...(images.length ? { images: [...images] } : {}),
        // Handled input may never start a model run; restore its previous display state.
        preflightResult: (disposition) => {
          handled = disposition === "handled";
          if (handled && this.session.isIdle && revision === this.runRevision) { this.status = before.status; this.error = before.error; this.aborted = before.aborted; }
          admitted.resolve(); if (!command?.failure) onAccepted?.();
        },
      })), async () => { if (command) this.diagnostics.end(command); });
      if (command?.failure) return err(new AgentRunError(`Command /${name} failed: ${command.failure.error}. It may have changed state; inspect before retrying.`, { cause: command.failure }));
      if (!result.ok) {
        if (!this.closing) { this.status = "failure"; this.error = result.error.message; }
        return result;
      }
      if (handled) return ok(undefined);
      if (this.aborted) return err(new CancelledError());
      if (this.state.status === "failure") return err(new AgentRunError(this.error ?? "Agent failed."));
      return ok(undefined);
    }).catch((error: unknown) => {
      this.status = "failure"; this.error = "Unexpected agent execution failure. Inspect runtime.log.";
      throw error;
    }).finally(() => { admitted.resolve(); this.runs.delete(task); this.emit(); });
    this.runs.add(task); this.emit(); return task;
  }

  private queuedMessages(): QueuedUserMessage[] {
    const agent = this.session.agent, steering = agent.steeringMode, followUp = agent.followUpMode;
    // SDK peek follows delivery mode and otherwise exposes only the first item.
    // This synchronous snapshot must include all messages and their image blocks,
    // without changing the user's actual delivery policy or persisted settings.
    try {
      agent.steeringMode = "all"; agent.followUpMode = "all";
      return [...this.interruptedMessages, ...agent.peekQueuedMessages().filter((message): message is QueuedUserMessage => message.role === "user")];
    } finally { agent.steeringMode = steering; agent.followUpMode = followUp; }
  }

  interrupt(onAccepted?: () => void): Promise<Result<void, ExpectedError>> {
    if (this.closing || this.disposed) return Promise.resolve(err(new SessionError("SESSION_NOT_OPEN", "Session is closing.")));
    if (this.interruptTask) { onAccepted?.(); return this.interruptTask; }
    this.interrupting = true; this.inputRevision++;
    const admission = this.admission, runs = [...this.runs];
    this.interruptedMessages = this.queuedMessages();
    this.session.clearQueue(); this.session.abortBash();
    const abort = this.session.abort();
    const task = (async (): Promise<Result<void, ExpectedError>> => {
      onAccepted?.();
      const stopped = await capture(async () => {
        // Abort first: an extension command may itself be waiting for SDK idle.
        await admission;
        // Preflight already in flight can have queued input after the first clear.
        this.interruptedMessages = this.queuedMessages(); this.session.clearQueue();
        await Promise.all([abort, this.session.abort()]);
        await Promise.all(runs);
      });
      if (!stopped.ok) return stopped;
      if (this.closing || this.disposed || !this.interruptedMessages.length) return ok(undefined);
      const messages = this.interruptedMessages;
      const text = messages.map((message) => typeof message.content === "string" ? message.content
        : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")).join("\n");
      const images = messages.flatMap((message) => typeof message.content === "string" ? [] : message.content.filter((part) => part.type === "image"));
      const accepted = Promise.withResolvers<Result<void, ExpectedError>>();
      let admitted = false;
      this.interrupting = false;
      const run = this.promptInput(text, () => {
        admitted = true; this.interruptedMessages = []; this.emit(); accepted.resolve(ok(undefined));
      }, [], images);
      void run.then((result) => { if (!admitted) accepted.resolve(result); }, (error: unknown) => {
        if (!admitted) accepted.reject(error);
        else reportUnexpected(error, "resumed agent execution");
      });
      return accepted.promise;
    })().finally(() => { this.interrupting = false; this.interruptTask = undefined; this.emit(); });
    this.interruptTask = task; this.emit(); return task;
  }

  async beforeNewSession(): Promise<Result<void, ExpectedError>> {
    if (this.disposed) return ok(undefined);
    const result = await this.session.extensionRunner.emit({ type: "session_before_switch", reason: "new" });
    return result?.cancel ? err(new CancelledError("Session replacement was cancelled by an extension.")) : ok(undefined);
  }

  close(reason: "quit" | "new" = "quit"): Promise<Result<void, ExpectedError>> {
    if (this.disposed) return Promise.resolve(ok(undefined));
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    const task = capture(async () => {
      this.session.clearQueue(); this.session.abortBash();
      // Commands may be waiting for this run to become idle; abort before waiting for their admission.
      await this.session.abort();
      await this.admission;
      await withCleanup(async () => {
        // Run failure/cancellation is not cleanup failure, but unexpected rejections still propagate.
        await Promise.all(this.runs);
        if (this.interruptTask) await this.interruptTask;
        await this.session.extensionRunner.emit({ type: "session_shutdown", reason });
      }, async () => {
        this.telemetry.dispose(); this.session.dispose(); this.unsubscribe(); this.listeners.clear(); this.disposed = true;
      });
    }).then((result) => { if (!result.ok) this.closeTask = undefined; return result; });
    this.closeTask = task; void task.catch(() => { this.closeTask = undefined; }); return task;
  }

  private handleEvent(event: AgentSessionEvent): void {
    const completion = this.transcript.handle(event);
    switch (event.type) {
      case "agent_start":
        this.started ??= { wall: Date.now(), monotonic: performance.now() };
        this.runRevision++; this.status = "working"; break;
      case "auto_retry_start": this.status = "working"; break;
      case "compaction_start":
        this.started ??= { wall: Date.now(), monotonic: performance.now() };
        this.compacting = true; this.status = "working"; break;
      case "compaction_end":
        // Manual control restores its settled status in compact() before clearing
        // this activity; otherwise an end-event snapshot flashes the old request.
        if (!this.controlling) this.compacting = false;
        break;
      case "message_update":
        if (event.message.role === "assistant") this.partial = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
        break;
      case "message_end": this.partial = ""; break;
      case "tool_execution_start": this.activeTools.set(event.toolCallId, `Running ${event.toolName}`); break;
      case "tool_execution_update": this.activeTools.set(event.toolCallId, `Running ${event.toolName}: ${toolText(event.partialResult)}`); break;
      case "tool_execution_end": this.activeTools.delete(event.toolCallId); break;
      case "agent_settled":
        this.started = undefined;
        this.runRevision++; this.aborted = event.aborted; this.status = this.finalStatus(event.aborted);
        this.telemetry.refreshUsage(); break;
      // agent_end may precede retry/compaction/follow-up; never mark it complete.
    }
    if (completion) {
      // Optional display persistence cannot turn an accepted, settled action into a rejected run.
      try {
        const saved = saveRunCompletion(this.session.sessionManager, completion);
        if (!saved.ok) this.transcript.warnCompletion(completion, `[${saved.error.code}] Run finished, but saving its timing could not be confirmed.`);
      } catch (error) { this.transcript.warnCompletion(completion, reportUnexpected(error, "run timing persistence")); }
    }
    this.emit();
  }

  private finalStatus(aborted: boolean): ExecutionState["status"] {
    const last = this.session.messages.findLast((message) => message.role === "assistant");
    if (!last || last.role !== "assistant" || aborted || last.stopReason === "aborted") return null;
    if (last.stopReason === "error") { this.error = last.errorMessage ?? "Agent failed."; return "failure"; }
    return last.stopReason === "stop" || last.stopReason === "length" ? "complete" : null;
  }

  private emit(): void { for (const listener of this.listeners) listener(); }
}

function saveRunCompletion(manager: SessionManager, completion: RunCompletion): Result<void, ExpectedError> {
  try { manager.appendCustomEntry(runCompletionEntryType, completion); return ok(undefined); }
  catch (error) { const expected = knownError(error); if (expected) return err(expected); throw error; }
}

function toolText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
  return result.content.flatMap((part: unknown) => part && typeof part === "object" && "type" in part
    && part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("");
}
