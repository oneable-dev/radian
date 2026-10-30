import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TranscriptStatus } from "./transcript.ts";
import { subagentEventType, subagentNotificationKind } from "./subagent-notifications.ts";

type Message = AgentSession["messages"][number];
type Tool = {
  name: string;
  arguments: unknown;
  text: string;
  status: TranscriptStatus;
  error?: string;
  details?: unknown;
};
type Presentation = { summary: string; text: string; status: TranscriptStatus; error?: string };
type Run = {
  agent: string;
  task?: string;
  status?: string;
  result?: string;
  error?: string;
  questions: Map<string, { message: string; active: boolean; reply?: string }>;
  guidance: string[];
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const short = (text: string, limit = 160) =>
  Array.from(text.replace(/\s+/gu, " ")).slice(0, limit).join("");

/** A durable delegation record, projected from exact launch receipts and saved tool metadata. */
export class SubagentTranscript {
  private readonly calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  private readonly runs = new Map<string, Run>();
  private readonly launches = new Map<string, string>();

  constructor(messages: readonly Message[], tools: ReadonlyMap<string, Tool>) {
    for (const message of messages)
      if (message.role === "assistant") {
        for (const part of message.content)
          if (part.type === "toolCall" && object(part.arguments))
            this.calls.set(part.id, { name: part.name, args: part.arguments });
      }
    const results = new Set<string>();
    for (const message of messages) {
      if (message.role === "toolResult") {
        results.add(message.toolCallId);
        this.result(message.toolCallId, message.details, message.isError === true);
      } else if (message.role === "custom" && message.customType === subagentEventType)
        this.events(message.details);
    }
    // Public tool_execution_end can precede the corresponding saved toolResult message.
    for (const [id, tool] of tools)
      if (!results.has(id) && tool.status === "complete") this.result(id, tool.details, false);
  }

  private run(id: string, agent = "Subagent"): Run {
    let run = this.runs.get(id);
    if (!run) {
      run = { agent, questions: new Map(), guidance: [] };
      this.runs.set(id, run);
    }
    return run;
  }

  private snapshot(value: unknown): void {
    if (!object(value) || typeof value.id !== "string" || typeof value.agent !== "string") return;
    const run = this.run(value.id, value.agent);
    run.agent = value.agent;
    if (typeof value.task === "string" && run.task === undefined) run.task = value.task;
    const terminal = ["complete", "failure", "stopped"].includes(run.status ?? "");
    if (
      typeof value.status === "string" &&
      (!terminal || !["working", "waiting"].includes(value.status))
    )
      run.status = value.status;
    // Old receipts used output for mixed logs. Only the new split contract is final text.
    if (typeof value.recentOutput === "string" && typeof value.output === "string" && value.output)
      run.result = value.output;
    if (typeof value.error === "string") run.error = value.error;
    const pending = new Set<string>();
    if (Array.isArray(value.questions))
      for (const question of value.questions) {
        if (
          !object(question) ||
          typeof question.id !== "string" ||
          typeof question.message !== "string"
        )
          continue;
        pending.add(question.id);
        const previous = run.questions.get(question.id);
        run.questions.set(question.id, {
          ...previous,
          message: question.message,
          active: !terminal && previous?.reply === undefined,
        });
      }
    if (Array.isArray(value.questions))
      for (const [id, question] of run.questions) if (!pending.has(id)) question.active = false;
  }

  private result(id: string, details: unknown, failed: boolean): void {
    const call = this.calls.get(id);
    if (!call || call.name !== "radian-subagent" || failed) return;
    const { args } = call;
    if (args.action === "spawn") {
      if (object(details) && typeof details.id === "string") {
        this.launches.set(id, details.id);
        this.snapshot(details);
        const run = this.run(details.id, typeof args.agent === "string" ? args.agent : undefined);
        if (typeof args.task === "string") run.task = args.task;
      }
    } else if (args.action === "status" || args.action === "wait") {
      if (Array.isArray(details)) for (const value of details) this.snapshot(value);
    } else if (typeof args.id === "string") {
      const run = this.run(args.id);
      if (
        args.action === "reply" &&
        object(details) &&
        details.delivered === true &&
        typeof args.questionId === "string" &&
        typeof args.message === "string"
      ) {
        const question = run.questions.get(args.questionId) ?? {
          message: "Question text unavailable",
          active: false,
        };
        question.reply = args.message;
        question.active = false;
        run.questions.set(args.questionId, question);
        if (run.status === "waiting" && ![...run.questions.values()].some((item) => item.active))
          run.status = "working";
      } else if (args.action === "steer" && typeof args.message === "string")
        run.guidance.push(args.message);
      else if (args.action === "stop") this.snapshot(details);
    }
  }

  private events(details: unknown): void {
    if (
      !object(details) ||
      details.kind !== subagentNotificationKind ||
      details.version !== 1 ||
      !Array.isArray(details.events)
    )
      return;
    for (const event of details.events) {
      if (!object(event) || typeof event.id !== "string" || typeof event.agent !== "string")
        continue;
      const run = this.run(event.id, event.agent);
      run.agent = event.agent;
      if (event.type === "finished") {
        if (typeof event.status === "string") run.status = event.status;
        if (typeof event.output === "string") run.result = event.output;
        if (typeof event.error === "string") run.error = event.error;
        for (const question of run.questions.values()) question.active = false;
      } else if (
        event.type === "question" &&
        object(event.question) &&
        typeof event.question.id === "string" &&
        typeof event.question.message === "string"
      ) {
        const previous = run.questions.get(event.question.id);
        const active =
          previous?.reply === undefined &&
          !["complete", "failure", "stopped"].includes(run.status ?? "");
        run.questions.set(event.question.id, {
          ...previous,
          message: event.question.message,
          active,
        });
        if (active) run.status = "waiting";
      }
    }
  }

  present(id: string, tool: Tool): Presentation | "hidden" | undefined {
    const call = this.calls.get(id);
    const args = call?.args ?? (object(tool.arguments) ? tool.arguments : undefined);
    const action = typeof args?.action === "string" ? args.action : "Operation";
    if (tool.name === "radian-supervisor" && args) {
      const label = args.action === "ask" ? "Question" : "Progress";
      const lines = [`${label}: ${typeof args.message === "string" ? args.message : ""}`];
      if (args.action === "ask" && object(tool.details) && typeof tool.details.message === "string")
        lines.push(`Parent response: ${tool.details.message}`);
      if (tool.error) lines.push(`Error: ${tool.error}`);
      return {
        summary: label,
        text: lines.join("\n\n"),
        status: tool.status,
        ...(tool.error ? { error: short(tool.error) } : {}),
      };
    }
    if (tool.name !== "radian-subagent" || !args) return undefined;
    if (tool.status === "error" || tool.status === "cancelled" || tool.status === "unfinished")
      return {
        summary: typeof args.agent === "string" ? `${args.agent} · Failed` : action,
        text: [typeof args.task === "string" ? `Task: ${args.task}` : "", tool.error ?? tool.text]
          .filter(Boolean)
          .join("\n\n"),
        status: tool.status,
        ...(tool.error ? { error: short(tool.error) } : {}),
      };
    if (["list", "status", "wait"].includes(action)) return "hidden";
    if (args.action !== "spawn") {
      if (typeof args.id === "string" && [...this.launches.values()].includes(args.id))
        return "hidden";
      return {
        summary: action,
        text: typeof args.message === "string" ? args.message : "Subagent operation accepted.",
        status: tool.status,
      };
    }
    const runId = this.launches.get(id);
    const run = runId ? this.runs.get(runId) : undefined;
    const agent = run?.agent ?? (typeof args.agent === "string" ? args.agent : "Subagent");
    const phase =
      run?.status === "working"
        ? "Delegated"
        : run?.status
          ? run.status[0]!.toUpperCase() + run.status.slice(1)
          : tool.status === "complete"
            ? "Accepted"
            : "Starting";
    const lines = [
      `Task: ${typeof args.task === "string" ? args.task : (run?.task ?? "")}`,
      `State: ${phase}`,
    ];
    for (const question of run?.questions.values() ?? []) {
      lines.push(`Question: ${question.message}`);
      lines.push(
        question.reply !== undefined
          ? `Parent response: ${question.reply}`
          : question.active
            ? "Awaiting parent response."
            : "Question is no longer pending.",
      );
    }
    for (const guidance of run?.guidance ?? []) lines.push(`Guidance: ${guidance}`);
    if (run?.result !== undefined) lines.push(`Result:\n${run.result}`);
    if (run?.error) lines.push(`Error: ${run.error}`);
    return {
      summary: `${agent} · ${short(typeof args.task === "string" ? args.task : (run?.task ?? ""), 80)} · ${phase}`,
      text: lines.join("\n\n"),
      status:
        run?.status === "failure"
          ? "error"
          : run?.status === "stopped"
            ? "unfinished"
            : tool.status,
      ...(run?.error ? { error: short(run.error) } : {}),
    };
  }
}
