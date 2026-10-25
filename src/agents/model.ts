import type { RequestSummary } from "./request-summary.ts";
import type { SessionResult } from "./session-attention.ts";

// Runtime adapters normalize outcomes before presenting them. Null is unreported
// or aborted, not a new idle/waiting state and never implicit successful completion.
export type AgentStatus = "working" | "complete" | "failure";

export type Subagent = {
  readonly id: string;
  readonly name: string;
  readonly status: AgentStatus | null;
  readonly request?: RequestSummary;
  readonly runTiming?: { readonly startedAt: number; readonly elapsedMs: number };
  readonly source?: "pi";
  readonly phase?: "queued" | "paused" | "stopped" | "rejected" | "partial";
};

// Display snapshots have no ownership of Pi agents or saved session records.
export type OpenSession = {
  readonly id: string;
  readonly name: string;
  readonly status: AgentStatus | null;
  readonly subagents: readonly Subagent[];
  readonly request?: RequestSummary;
  readonly result?: SessionResult;
  readonly attention?: SessionResult;
};
