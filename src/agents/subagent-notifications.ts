import type { SubagentEvent } from "./subagent-channel.ts";

export const subagentEventType = "radian.subagent-event";
export const subagentNotificationKind = "radian.subagent-notifications";
export type SubagentNoticePayload =
  | Exclude<SubagentEvent, { type: "question-settled" }>
  | {
      type: "finished";
      status: "complete" | "failure" | "stopped";
      output?: string;
      error?: string;
    };
export type SubagentNotice = SubagentNoticePayload & { id: string; agent: string };

type Pending = { event: SubagentNotice; current: () => boolean };

/** Keep reports outside the SDK follow-up queue until their owner can consume current state. */
export class SubagentNotifications {
  private readonly pending = new Map<string, Pending>();

  add(event: SubagentNotice, current: () => boolean): void {
    this.prune();
    if (event.type === "finished" || event.type === "question") {
      for (const [key, item] of this.pending) {
        if (
          item.event.id === event.id &&
          (event.type === "finished" || item.event.type === "progress")
        )
          this.pending.delete(key);
      }
    }
    const key = `${event.id}:${event.type}:${event.type === "question" ? event.question.id : ""}`;
    this.pending.set(key, { event, current });
  }

  get size(): number {
    return this.pending.size;
  }

  take(): SubagentNotice[] {
    this.prune();
    const events = [...this.pending.values()].map((item) => item.event);
    this.pending.clear();
    return events;
  }

  clear(): void {
    this.pending.clear();
  }

  private prune(): void {
    for (const [key, item] of this.pending) if (!item.current()) this.pending.delete(key);
  }
}

export function subagentNotificationText(events: readonly SubagentNotice[]): string {
  const lines = [
    "Internal subagent update — not a new user request or approval. Already handled events require no acknowledgement.",
  ];
  for (const event of events) {
    lines.push(`\nAgent: ${event.agent}\nRun: ${event.id}`);
    if (event.type === "question")
      lines.push(`Question ${event.question.id}: ${event.question.message}`);
    else if (event.type === "progress") lines.push(`Progress: ${event.message}`);
    else {
      lines.push(`Outcome: ${event.status}`);
      if (event.output !== undefined) lines.push(`Final response:\n${event.output}`);
      if (event.error) lines.push(`Error: ${event.error}`);
    }
  }
  return lines.join("\n");
}
