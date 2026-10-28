import type { AgentStatus, OpenSession } from "./model.ts";

export function sessionStatus(session: OpenSession): AgentStatus | null {
  const statuses = [session.status, ...session.subagents.map((agent) => agent.status)];
  if (statuses.includes("failure")) {
    return "failure";
  }
  if (statuses.includes("working")) {
    return "working";
  }
  if (statuses.every((status) => status === "complete")) {
    return "complete";
  }

  return null;
}
