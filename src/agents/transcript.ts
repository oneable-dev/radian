import { parseSkillBlock, type AgentSession, type AgentSessionEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";

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
};
type Message = { id: string; message: AgentMessage; streaming: boolean };
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
function toolSection(id: string, callId: string, tool: Tool): TranscriptSection {
  const args = JSON.stringify(tool.arguments ?? {}, null, 2);
  const error = tool.error && !tool.text.includes(tool.error) ? `\n\nError:\n${tool.error}` : "";
  return { id, kind: "tool", title: tool.name, text: `Arguments:\n${args}\n\nResult:\n${tool.text}${error}`,
    summary: summary(JSON.stringify(tool.arguments ?? {})), status: tool.status, toolCallId: callId,
    ...(tool.error ? { error: summary(tool.error) } : {}) };
}

// Keep the displayed transcript separate from compacted model context. Live IDs remain
// stable from message_start through completion, including the SDK's pre-persistence events.
export class SessionTranscript {
  private readonly messages: Message[] = [];
  private readonly tools = new Map<string, Tool>();
  private current: Message | undefined;
  private cached: readonly TranscriptSection[] | undefined;

  constructor(entries: readonly SessionEntry[]) {
    for (const entry of entries) {
      if (entry.type === "message") this.messages.push({ id: entry.id, message: entry.message, streaming: false });
      else if (entry.type === "custom_message") this.messages.push({ id: entry.id, streaming: false, message: {
        role: "custom", customType: entry.customType, content: entry.content, display: entry.display, timestamp: Date.parse(entry.timestamp),
      } });
      else if (entry.type === "compaction" || entry.type === "branch_summary") this.messages.push({ id: entry.id, streaming: false, message: {
        role: "custom", customType: entry.type === "compaction" ? "Context compacted" : "Branch summary", content: entry.summary,
        display: true, timestamp: Date.parse(entry.timestamp),
      } });
    }
  }

  handle(event: AgentSessionEvent): void {
    switch (event.type) {
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
      case "agent_settled":
        for (const tool of this.tools.values()) if (tool.status === "running" || tool.status === "pending") tool.status = event.aborted ? "cancelled" : "unfinished";
        break;
      default: return;
    }
    this.cached = undefined;
  }

  get sections(): readonly TranscriptSection[] {
    if (this.cached) return this.cached;
    const tools = new Map(this.tools);
    for (const { message } of this.messages) if (message.role === "toolResult") {
      const previous = tools.get(message.toolCallId);
      const text = contentText(message.content);
      tools.set(message.toolCallId, { name: message.toolName, arguments: previous?.arguments, text,
        status: message.isError ? "error" : "complete", ...(message.isError ? { error: text || "Tool failed" } : {}) });
    }
    const sections: TranscriptSection[] = [];
    const seenTools = new Set<string>();
    for (const { id, message, streaming } of this.messages) {
      switch (message.role) {
        case "user": {
          const text = contentText(message.content), skill = parseSkillBlock(text);
          if (!skill) { sections.push({ id, kind: "user", title: "You", text, status: "complete" }); break; }
          const name = skill.name.replace(/\s+/g, " ").trim() || "Skill";
          // The SDK's explicit invocation metadata, not a SKILL.md filename, identifies
          // this compact item. Its instruction body stays in SDK history, not the UI.
          sections.push({ id: `${id}:skill`, kind: "notice", title: name, text: name, skillName: name, status: "complete" });
          if (skill.userMessage) sections.push({ id: `${id}:request`, kind: "user", title: "You", text: skill.userMessage, status: "complete" });
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
          summary: summary(message.command), status: message.cancelled ? "cancelled" : message.exitCode === 0 ? "complete" : "error" }); break;
        case "custom":
          if (message.display) sections.push({ id, kind: "notice", title: message.customType, text: contentText(message.content), status: "complete" });
          break;
        case "compactionSummary": case "branchSummary": sections.push({ id, kind: "notice", title: "Context summary", text: message.summary, status: "complete" }); break;
        case "system": break;
      }
    }
    this.cached = sections;
    return sections;
  }
}
