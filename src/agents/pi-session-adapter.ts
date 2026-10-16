import {
  createAgentSession, DefaultResourceLoader, defineTool, getAgentDir, ModelRuntime,
  SessionManager, SettingsManager, type AgentSession, type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionState, SessionContext, SessionExecutor, SessionFactory } from "./session-registry.ts";
import { AgentRunError, CancelledError, CapabilityError, capture, InputError, SessionError, withCleanup, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { SessionTranscript } from "./transcript.ts";
import { PiSessionTelemetry } from "./pi-session-telemetry.ts";
import { CommandDiagnostics, sessionCommands } from "./session-commands.ts";
import { FastMode } from "./fast-mode.ts";
import type { UsageMonitor } from "../usage/monitor.ts";

export type PiSessionOptions = {
  agentDir?: string;
  sessionDir?: string;
  modelRuntime?: ModelRuntime;
  model?: NonNullable<AgentSession["model"]>;
  streamFn?: AgentSession["agent"]["streamFunction"];
  settings?: Partial<ReturnType<SettingsManager["getSettings"]>>;
  usageMonitor?: UsageMonitor;
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
    const resourceLoader = new DefaultResourceLoader({
      cwd: context.cwd, agentDir, settingsManager, noThemes: true, extensionFactories: [fast.extension],
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
      const executor = new PiSessionExecutor(session, options.usageMonitor, diagnostics, fast);
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

  constructor(private readonly session: AgentSession, usage?: UsageMonitor, private readonly diagnostics = new CommandDiagnostics(), fast?: FastMode) {
    this.status = this.finalStatus(false);
    this.transcript = new SessionTranscript(session.sessionManager.getBranch());
    this.telemetry = new PiSessionTelemetry(session, () => this.emit(), usage, fast);
    this.unsubscribe = session.subscribe((event) => this.handleEvent(event));
  }

  commands() { return sessionCommands(this.session); }
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
    return { status: this.status, output: messages.join("\n\n").slice(-12000), error: this.error,
      sections: this.transcript.sections, telemetry: this.telemetry.read() };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prompt(text: string, onAccepted?: () => void): Promise<Result<void, ExpectedError>> {
    if (this.closing || this.disposed) return Promise.resolve(err(new SessionError("SESSION_NOT_OPEN", "Session is closing.")));
    const admitted = Promise.withResolvers<void>();
    const previous = this.admission;
    this.admission = admitted.promise;
    const task = previous.then(async (): Promise<Result<void, ExpectedError>> => {
      if (this.closing || this.disposed) return err(new SessionError("SESSION_NOT_OPEN", "Session is closing."));
      if (this.session.isCompacting && !this.session.isStreaming) return err(new SessionError("SESSION_BUSY", "Session is compacting; retry after it finishes."));
      const before = { status: this.status, error: this.error, aborted: this.aborted };
      const revision = this.runRevision;
      const name = text.startsWith("/") ? text.slice(1).split(" ", 1)[0]! : "";
      const command = name && this.session.extensionRunner.getCommand(name) ? this.diagnostics.begin(name) : undefined;
      let handled = false;
      if (this.session.isIdle) { this.status = "working"; this.error = null; this.aborted = false; }
      const result = await withCleanup(() => capture(() => this.session.prompt(text, {
        streamingBehavior: "steer",
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

  close(): Promise<Result<void, ExpectedError>> {
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
        await this.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      }, async () => {
        this.telemetry.dispose(); this.session.dispose(); this.unsubscribe(); this.listeners.clear(); this.disposed = true;
      });
    }).then((result) => { if (!result.ok) this.closeTask = undefined; return result; });
    this.closeTask = task; void task.catch(() => { this.closeTask = undefined; }); return task;
  }

  private handleEvent(event: AgentSessionEvent): void {
    this.transcript.handle(event);
    switch (event.type) {
      case "agent_start": this.runRevision++; this.status = "working"; break;
      case "auto_retry_start": case "compaction_start":
        this.status = "working";
        break;
      case "message_update":
        if (event.message.role === "assistant") this.partial = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
        break;
      case "message_end": this.partial = ""; break;
      case "tool_execution_start": this.activeTools.set(event.toolCallId, `Running ${event.toolName}`); break;
      case "tool_execution_update": this.activeTools.set(event.toolCallId, `Running ${event.toolName}: ${toolText(event.partialResult)}`); break;
      case "tool_execution_end": this.activeTools.delete(event.toolCallId); break;
      case "agent_settled":
        this.runRevision++; this.aborted = event.aborted; this.status = this.finalStatus(event.aborted);
        this.telemetry.refreshUsage(); break;
      // agent_end may precede retry/compaction/follow-up; never mark it complete.
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

function toolText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
  return result.content.flatMap((part: unknown) => part && typeof part === "object" && "type" in part
    && part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("");
}
