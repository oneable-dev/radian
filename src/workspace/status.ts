import { icons } from "../icons.ts";
import type { AgentStatus, OpenSession, WorkspaceRow } from "./model.ts";

export const workspaceIcons = {
  repository: icons.repo,
  worktree: icons.folder,
  working: icons.loading,
  complete: icons.pass,
  failure: icons.error,
  unreported: icons.robot,
} as const;

type StatusColor = "text" | "muted" | "accent" | "success" | "error";
const statusColors = {
  working: "accent", complete: "success", failure: "error",
} satisfies Record<AgentStatus, StatusColor>;

export function sessionStatus(session: OpenSession): AgentStatus | null {
  const statuses = [session.status, ...session.subagents.map((agent) => agent.status)];
  if (statuses.includes("failure")) return "failure";
  if (statuses.includes("working")) return "working";
  if (statuses.every((status) => status === "complete")) return "complete";
  return null;
}

export function rowPresentation(row: WorkspaceRow): { icon: string; color: StatusColor } {
  switch (row.kind) {
    case "repository": return { icon: workspaceIcons.repository, color: "text" };
    case "worktree": return { icon: workspaceIcons.worktree, color: "text" };
    case "session": return statusPresentation(sessionStatus(row.session));
    case "subagent": return statusPresentation(row.subagent.status);
  }
}

function statusPresentation(status: AgentStatus | null): { icon: string; color: StatusColor } {
  if (status === null) return { icon: workspaceIcons.unreported, color: "muted" };
  return { icon: workspaceIcons[status], color: statusColors[status] };
}
