import {
  createAgentSession, DefaultResourceLoader, defineTool, getAgentDir, ModelRuntime,
  SessionManager, SettingsManager, type AgentSession, type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionState, SessionContext, SessionExecutor, SessionFactory } from "./session-registry.ts";

export type PiSessionOptions = {
  agentDir?: string;
  sessionDir?: string;
  modelRuntime?: ModelRuntime;
  model?: NonNullable<AgentSession["model"]>;
  streamFn?: AgentSession["agent"]["streamFunction"];
  settings?: Partial<ReturnType<SettingsManager["getSettings"]>>;
};

export function piSessionFactory(options: PiSessionOptions = {}): SessionFactory {
  let runtime: Promise<ModelRuntime> | undefined;
  return async (context) => {
    if (!(await stat(context.cwd)).isDirectory()) throw new Error("Session working directory is not a directory.");
    const agentDir = options.agentDir ?? getAgentDir();
    runtime ??= options.modelRuntime ? Promise.resolve(options.modelRuntime) : ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
    });
    const modelRuntime = await runtime;
    const settingsManager = options.streamFn ? SettingsManager.inMemory({
      retry: { enabled: false }, compaction: { enabled: false },
    }) : SettingsManager.create(context.cwd, agentDir);
    // Pi's terminal-specific extensions and their untracked child launchers are not hosted here.
    const resourceLoader = new DefaultResourceLoader({
      cwd: context.cwd, agentDir, settingsManager, noExtensions: true, noThemes: true,
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
    try {
      await mkdir(session.sessionManager.getSessionDir(), { recursive: true });
      if (options.streamFn) session.agent.streamFunction = options.streamFn;
      await session.bindExtensions({});
      return new PiSessionExecutor(session);
    } catch (error) {
      session.dispose();
      throw error;
    }
  };
}

function subagentTool(context: SessionContext) {
  return defineTool({
    name: "radian_subagent", label: "Subagent",
    description: "Delegate a bounded task to an owned subagent in the same worktree. Wait for its result. The child cannot delegate further.",
    promptSnippet: "Delegate a task to a subagent in this worktree.",
    parameters: Type.Object({ name: Type.String({ minLength: 1 }), task: Type.String({ minLength: 1 }) }),
    execute: async (_id, { name, task }, signal) => ({
      content: [{ type: "text" as const, text: await context.spawnSubagent(name, task, signal) }], details: {},
    }),
  });
}

export class PiSessionExecutor implements SessionExecutor {
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private status: ExecutionState["status"];
  private error: string | null = null;
  private partial = "";
  private readonly activeTools = new Map<string, string>();
  private running: Promise<void> | undefined;
  private closeTask: Promise<void> | undefined;
  private closing = false;
  private disposed = false;

  constructor(private readonly session: AgentSession) {
    this.status = this.finalStatus(false);
    this.unsubscribe = session.subscribe((event) => this.handleEvent(event));
  }

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
    return { status: this.status, output: messages.join("\n\n").slice(-12000), error: this.error };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prompt(text: string): Promise<void> {
    if (this.closing || this.disposed) return Promise.reject(new Error("Session is closing."));
    if (this.running || !this.session.isIdle) return Promise.reject(new Error("This session is already running. Wait for it to finish."));
    this.status = "working";
    this.error = null;
    const task = this.session.prompt(text).catch((error: unknown) => {
      if (!this.closing) { this.status = "failure"; this.error = error instanceof Error ? error.message : String(error); }
      throw error;
    }).finally(() => { this.running = undefined; this.emit(); });
    this.running = task;
    this.emit();
    return task;
  }

  close(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    const task = Promise.resolve().then(async () => {
      this.session.clearQueue();
      this.session.abortBash();
      await this.session.abort();
      if (this.running) await Promise.allSettled([this.running]);
      await this.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      this.session.dispose();
      this.unsubscribe();
      this.listeners.clear();
      this.disposed = true;
    });
    this.closeTask = task;
    void task.catch(() => { this.closeTask = undefined; });
    return task;
  }

  private handleEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start": case "auto_retry_start": case "compaction_start":
        this.status = "working";
        break;
      case "message_update":
        if (event.message.role === "assistant") this.partial = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
        break;
      case "message_end": this.partial = ""; break;
      case "tool_execution_start": this.activeTools.set(event.toolCallId, `Running ${event.toolName}`); break;
      case "tool_execution_update": this.activeTools.set(event.toolCallId, `Running ${event.toolName}: ${toolText(event.partialResult)}`); break;
      case "tool_execution_end": this.activeTools.delete(event.toolCallId); break;
      case "agent_settled": this.status = this.finalStatus(event.aborted); break;
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
