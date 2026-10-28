import type { AgentSessionEvent, EventBus } from "@earendil-works/pi-coding-agent";
import type { Subagent } from "./model.ts";
import { summarizeRequest, type RequestSummary } from "./request-summary.ts";

type Display = Pick<Subagent, "name" | "request">;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 4096;
const key = (id: string, child?: string) => JSON.stringify([id, child ?? null]);

// Observe exact launch identities, never infer agents or task text from display labels.
export class PiSubagentDisplay {
  private readonly entries = new Map<string, Display>();
  private readonly pending = new Map<string, { name: string; request: RequestSummary }>();
  private readonly unsubscribe: (() => void)[];

  constructor(
    events: EventBus | undefined,
    private readonly changed: () => void,
  ) {
    this.unsubscribe = events
      ? [
          events.on("subagent:async-started", (value) => {
            if (
              !record(value) ||
              value.mode !== "single" ||
              !identifier(value.id) ||
              !identifier(value.agent)
            ) {
              return;
            }

            const display = { name: value.agent };
            this.set(key(value.id), display);
            if (identifier(value.parentWorkflowRunId) && identifier(value.workflowKey)) {
              this.set(key(value.parentWorkflowRunId, value.workflowKey), display);
            }

            // Lifecycle prompt fields are redacted by Pi and are not a task-preview source.
            this.changed();
          }),
          events.on("subagent:child-status", (value) => {
            if (
              !record(value) ||
              value.type !== "subagent.child-status" ||
              value.version !== 1 ||
              !identifier(value.runId) ||
              !identifier(value.childId) ||
              !identifier(value.agent)
            ) {
              return;
            }

            this.set(key(value.runId, value.childId), { name: value.agent });
            this.changed();
          }),
        ]
      : [];
  }

  lookup = (id: string, parent?: string): Display | undefined =>
    (parent ? this.entries.get(key(parent, id)) : undefined) ?? this.entries.get(key(id));

  handleEvent(event: AgentSessionEvent): void {
    if (
      event.type === "tool_execution_start" &&
      event.toolName === "subagent" &&
      record(event.args) &&
      event.args.action === undefined &&
      identifier(event.args.agent) &&
      typeof event.args.task === "string"
    ) {
      if (this.pending.size < 256) {
        this.pending.set(event.toolCallId, {
          name: event.args.agent,
          request: summarizeRequest(event.args.task, 0),
        });
      }
    } else if (event.type === "tool_execution_end") {
      const display = this.pending.get(event.toolCallId);
      this.pending.delete(event.toolCallId);
      if (!display || event.isError || !record(event.result) || !record(event.result.details)) {
        return;
      }

      const details = event.result.details;
      if (details.mode !== "single" || !identifier(details.asyncId)) {
        return;
      }

      // Only an exact single-child launch receipt can bind the parent's authored task.
      this.set(key(details.asyncId), display);
      this.changed();
    }
  }

  private set(id: string, display: Display): void {
    const previous = this.entries.get(id);
    this.entries.delete(id);
    this.entries.set(id, { ...previous, ...display });
    if (this.entries.size > 256) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  reset(): void {
    this.entries.clear();
    this.pending.clear();
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribe) {
      unsubscribe();
    }

    this.reset();
  }
}
