import { parseSkillBlock, type AgentSession, type AgentSessionEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { parseRunCompletion, runCompletionEntryType, systemRunClock, type RunClock, type RunCompletion } from "./run-completion.ts";
import { summarizeRequest, type RequestSummary } from "./request-summary.ts";
import type { ImageContent } from "@earendil-works/pi-ai";
import { imageNamesEntryType, TranscriptImages, type TranscriptImage } from "./transcript-images.ts";

type AgentMessage = AgentSession["messages"][number];

export type TranscriptKind = "user" | "assistant" | "thinking" | "tool" | "notice";
export type TranscriptStatus = "complete" | "streaming" | "pending" | "running" | "error" | "cancelled" | "unfinished";
export type TranscriptSection = {
  readonly id: string;
  readonly kind: TranscriptKind;
  readonly title: string;
  readonly text: string;
  readonly status: TranscriptStatus;
  readonly summary?: string;
  readonly error?: string;
  readonly toolCallId?: string;
  readonly skillName?: string;
  readonly command?: string;
  readonly timeoutSeconds?: number;
  readonly completion?: RunCompletion;
  readonly request?: RequestSummary;
  readonly image?: TranscriptImage;
};
type Message = { id: string; message: AgentMessage; streaming: boolean; noticeStatus?: TranscriptStatus };
type Tool = { name: string; arguments: unknown; text: string; status: TranscriptStatus; error?: string };

function contentText(content: string | readonly { type: string; text?: string; mimeType?: string }[]): string {
  return typeof content === "string" ? content : content.map((part) => part.type === "text" ? part.text ?? ""
    : part.type === "image" ? `[Image: ${part.mimeType ?? "attachment"}]` : "").join("");
}
export function toolResultText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
  return result.content.flatMap((part: unknown) => {
    if (!part || typeof part !== "object" || !("type" in part)) return [];
    if (part.type === "text" && "text" in part && typeof part.text === "string") return [part.text];
    if (part.type === "image") return ["[Image attachment]"];
    return [];
  }).join("");
}
function summary(text: string): string { return text.replace(/\s+/g, " ").slice(0, 160); }
function invocation(text: string): string {
  return text.length <= 4096 ? text : text.slice(0, 4095).replace(/[\uD800-\uDBFF]$/, "") + "…";
}
function toolSection(id: string, callId: string, tool: Tool): TranscriptSection {
  const args = JSON.stringify(tool.arguments ?? {}, null, 2);
  const input = tool.arguments && typeof tool.arguments === "object" && !Array.isArray(tool.arguments) ? tool.arguments : undefined;
  const command = tool.name === "bash" && input && "command" in input && typeof input.command === "string" ? input.command : undefined;
  const path = ["read", "write", "edit"].includes(tool.name) && input && "path" in input && typeof input.path === "string" ? input.path : undefined;
  const offset = input && "offset" in input && typeof input.offset === "number" && Number.isInteger(input.offset) && input.offset > 0 ? input.offset : undefined;
  // Only the built-in Bash contract defines timeout in seconds. Do not guess extension units or a default.
  const timeout = tool.name === "bash" && input && "timeout" in input && typeof input.timeout === "number" && Number.isFinite(input.timeout) && input.timeout > 0 ? input.timeout : undefined;
  const error = tool.error && !tool.text.includes(tool.error) ? `\n\nError:\n${tool.error}` : "";
  return { id, kind: "tool", title: tool.name, text: `Arguments:\n${args}\n\nResult:\n${tool.text}${error}`,
    summary: path !== undefined ? invocation(tool.name === "read" ? `${path}:${offset ?? 1}` : path) : summary(JSON.stringify(tool.arguments ?? {})),
    status: tool.status, toolCallId: callId, ...(command !== undefined ? { command: invocation(command) } : {}), ...(timeout !== undefined ? { timeoutSeconds: timeout } : {}),
    ...(tool.error ? { error: summary(tool.error) } : {}) };
}

// Keep the displayed transcript separate from compacted model context. Live IDs remain
// stable from message_start through completion, including the SDK's pre-persistence events.
export class SessionTranscript {
  private readonly messages: Message[] = [];
  private readonly tools = new Map<string, Tool>();
  private current: Message | undefined;
  private cached: readonly TranscriptSection[] | undefined;
  private readonly completions = new Map<string, RunCompletion>();
  private readonly images = new TranscriptImages();
  private run: { startedAt: number; monotonic: number; messageIndex: number; sectionCount: number } | undefined;

  constructor(entries: readonly SessionEntry[], private readonly clock: RunClock = systemRunClock) {
    for (const entry of entries) {
      if (entry.type === "message") this.messages.push({ id: entry.id, message: entry.message, streaming: false });
      else if (entry.type === "custom" && entry.customType === runCompletionEntryType) {
        const parsed = parseRunCompletion(entry.data), previous = this.messages.at(-1);
        if (parsed.ok) { if (previous) this.completions.set(previous.id, parsed.value); }
        else this.messages.push({ id: entry.id, streaming: false, message: { role: "custom", customType: "Run timing unavailable",
          content: `[${parsed.error.code}] ${parsed.error.message}`, display: true, timestamp: Date.parse(entry.timestamp) } });
      }
      else if (entry.type === "custom" && entry.customType === imageNamesEntryType) {
        const restored = this.images.restore(entry.data);
        if (!restored.ok) this.notice("Image metadata unavailable", `[${restored.error.code}] ${restored.error.message}`);
      }
      else if (entry.type === "custom_message") this.messages.push({ id: entry.id, streaming: false, message: {
        role: "custom", customType: entry.customType, content: entry.content, display: entry.display, timestamp: Date.parse(entry.timestamp),
      } });
      else if (entry.type === "compaction" || entry.type === "branch_summary") this.messages.push({ id: entry.id, streaming: false, message: {
        role: "custom", customType: entry.type === "compaction" ? "Context compacted" : "Branch summary", content: entry.summary,
        display: true, timestamp: Date.parse(entry.timestamp),
      } });
    }
  }

  handle(event: AgentSessionEvent): RunCompletion | undefined {
    let completion: RunCompletion | undefined;
    switch (event.type) {
      case "agent_start":
        // Retries and queued follow-ups can start another low-level loop before the same settlement.
        this.run ??= { startedAt: this.clock.wallTime(), monotonic: this.clock.monotonicTime(), messageIndex: this.messages.length, sectionCount: this.sections.length };
        break;
      case "message_start": {
        this.current = { id: `live:${crypto.randomUUID()}`, message: event.message, streaming: true };
        this.messages.push(this.current); break;
      }
      case "message_update":
        if (this.current) this.current.message = event.message;
        break;
      case "message_end":
        if (this.current) { this.current.message = event.message; this.current.streaming = false; this.current = undefined; }
        else this.messages.push({ id: `live:${crypto.randomUUID()}`, message: event.message, streaming: false });
        if (event.message.role === "assistant") for (const part of event.message.content) {
          if (part.type !== "toolCall" || this.tools.has(part.id)) continue;
          const reason = event.message.stopReason;
          this.tools.set(part.id, { name: part.name, arguments: part.arguments, text: "",
            status: reason === "aborted" ? "cancelled" : reason === "error" ? "error" : "pending",
            ...(event.message.errorMessage ? { error: event.message.errorMessage } : {}) });
        }
        break;
      case "tool_execution_start":
        this.tools.set(event.toolCallId, { name: event.toolName, arguments: event.args, text: "", status: "running" }); break;
      case "tool_execution_update":
        this.tools.set(event.toolCallId, { name: event.toolName, arguments: event.args, text: toolResultText(event.partialResult), status: "running" }); break;
      case "tool_execution_end": {
        const previous = this.tools.get(event.toolCallId);
        const text = toolResultText(event.result);
        this.tools.set(event.toolCallId, { name: event.toolName, arguments: previous?.arguments ?? {}, text,
          status: event.isError ? "error" : "complete", ...(event.isError ? { error: text || "Tool failed" } : {}) }); break;
      }
      case "agent_settled": {
        for (const tool of this.tools.values()) if (tool.status === "running" || tool.status === "pending") tool.status = event.aborted ? "cancelled" : "unfinished";
        const run = this.run; this.run = undefined; this.cached = undefined;
        if (run && this.sections.length > run.sectionCount) {
          const last = this.messages.slice(run.messageIndex).findLast(({ message }) => message.role === "assistant")?.message;
          const reason = last?.role === "assistant" ? last.stopReason : undefined;
          completion = { startedAt: run.startedAt, completedAt: this.clock.wallTime(), durationMs: Math.max(0, Math.round(this.clock.monotonicTime() - run.monotonic)),
            outcome: event.aborted || reason === "aborted" ? "cancelled" : reason === "error" ? "error" : reason === "stop" || reason === "length" ? "complete" : "unfinished" };
          this.completions.set(this.messages.at(-1)!.id, completion);
        }
        break;
      }
      default: return;
    }
    this.cached = undefined;
    return completion;
  }

  notice(title: string, text: string, status: TranscriptStatus = "complete"): void {
    this.messages.push({ id: `notice:${crypto.randomUUID()}`, streaming: false, noticeStatus: status,
      message: { role: "custom", customType: title, content: text, display: true, timestamp: this.clock.wallTime() } });
    this.cached = undefined;
  }

  warnCompletion(completion: RunCompletion, warning: string): void {
    for (const [id, value] of this.completions) if (value === completion) this.completions.set(id, { ...value, warning: warning.slice(0, 512) });
    this.cached = undefined;
  }

  rememberImages(images: readonly ImageContent[], paths: readonly string[]) {
    this.cached = undefined;
    return this.images.remember(images, paths);
  }
  imageData(id: string) { void this.sections; return this.images.read(id); }

  get sections(): readonly TranscriptSection[] {
    if (this.cached) return this.cached;
    this.images.clearReferences();
    const tools = new Map(this.tools);
    for (const { message } of this.messages) if (message.role === "toolResult") {
      const previous = tools.get(message.toolCallId);
      const text = contentText(message.content);
      tools.set(message.toolCallId, { name: message.toolName, arguments: previous?.arguments, text,
        status: message.isError ? "error" : "complete", ...(message.isError ? { error: text || "Tool failed" } : {}) });
    }
    const sections: TranscriptSection[] = [];
    const seenTools = new Set<string>();
    for (const { id, message, streaming, noticeStatus } of this.messages) {
      switch (message.role) {
        case "user": {
          const images = typeof message.content === "string" ? [] : message.content.filter((part) => part.type === "image");
          const prose = typeof message.content === "string" ? message.content : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
          const clean = (text: string) => images.length ? text.replace(/[ \t]*\[Image #\d+\][ \t]*/gu, " ").trim() : text;
          const text = clean(prose), skill = parseSkillBlock(text), start = sections.length;
          if (!skill) {
            if (text || !images.length) sections.push({ id, kind: "user", title: "You", text, status: "complete", request: summarizeRequest(prose, images.length) });
          } else {
            const name = skill.name.replace(/\s+/g, " ").trim() || "Skill";
            const requestProse = skill.userMessage || `/skill:${name}`;
            // Instructions stay in SDK history; only invocation metadata and the user's request are visible.
            sections.push({ id: `${id}:skill`, kind: "notice", title: name, text: name, skillName: name, status: "complete",
              ...(!skill.userMessage ? { request: summarizeRequest(`/skill:${name}`, images.length) } : {}) });
            if (skill.userMessage) sections.push({ id: `${id}:request`, kind: "user", title: "You", text: skill.userMessage, status: "complete", request: summarizeRequest(requestProse, images.length) });
          }
          for (const [index, block] of images.entries()) {
            if (typeof block.data !== "string" || typeof block.mimeType !== "string" || !block.mimeType.length || block.mimeType.length > 128) {
              sections.push({ id: `${id}:image:${index}`, kind: "notice", title: "Image unavailable", text: "[HISTORY_CORRUPT] Stored image metadata is invalid.", status: "error" });
              continue;
            }
            const image = this.images.describe(block, index);
            sections.push({ id: `${id}:image:${index}`, kind: "notice", title: "read", text: image.name, summary: image.name, image, status: "complete",
              ...(sections.length === start ? { request: summarizeRequest(prose, images.length) } : {}) });
          }
          break;
        }
        case "assistant": {
          const status = streaming ? "streaming" : message.stopReason === "aborted" ? "cancelled" : message.stopReason === "error" ? "error" : "complete";
          for (const [index, part] of message.content.entries()) {
            const blockId = `${id}:${index}`;
            if (part.type === "text" || part.type === "thinking") {
              const text = part.type === "text" ? part.text : part.redacted ? "[Thinking redacted]" : part.thinking;
              if (text) sections.push({ id: blockId, kind: part.type === "text" ? "assistant" : "thinking",
                title: part.type === "text" ? "Agent" : "Thinking",
                text: message.errorMessage && !text.includes(message.errorMessage) ? `${text}\n\nError:\n${message.errorMessage}` : text, status,
                ...(message.errorMessage ? { error: summary(message.errorMessage) } : {}) });
            } else if (part.type === "toolCall") {
              const tool = tools.get(part.id);
              sections.push(toolSection(blockId, part.id, { name: part.name, arguments: part.arguments, text: tool?.text ?? "",
                status: tool?.status ?? (streaming ? "pending" : status === "cancelled" || status === "error" ? status : "unfinished"),
                ...(tool?.error ? { error: tool.error } : {}) }));
              seenTools.add(part.id);
            }
          }
          if (!message.content.length && message.errorMessage) sections.push({ id, kind: "notice", title: "Agent error",
            text: message.errorMessage, error: summary(message.errorMessage), status });
          break;
        }
        case "toolResult":
          if (!seenTools.has(message.toolCallId)) {
            sections.push(toolSection(id, message.toolCallId, tools.get(message.toolCallId)!)); seenTools.add(message.toolCallId);
          }
          break;
        case "bashExecution": sections.push({ id, kind: "tool", title: "Shell", text: `$ ${message.command}\n\n${message.output}`,
          summary: summary(message.command), command: invocation(message.command), status: message.cancelled ? "cancelled" : message.exitCode === 0 ? "complete" : "error" }); break;
        case "custom":
          if (message.display) sections.push({ id, kind: "notice", title: message.customType, text: contentText(message.content), status: noticeStatus ?? "complete" });
          break;
        case "compactionSummary": case "branchSummary": sections.push({ id, kind: "notice", title: "Context summary", text: message.summary, status: "complete" }); break;
        case "system": break;
      }
      const completion = this.completions.get(id), last = sections.at(-1);
      if (completion && last) sections[sections.length - 1] = { ...last, completion };
    }
    this.cached = sections;
    return sections;
  }
}
