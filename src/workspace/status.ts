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

const statusColors = {
  working: "#7DD3FC", complete: "#86EFAC", failure: "#FB7185",
} satisfies Record<AgentStatus, string>;

export function sessionStatus(session: OpenSession): AgentStatus | null {
  const statuses = [session.status, ...session.subagents.map((agent) => agent.status)];
  if (statuses.includes("failure")) return "failure";
  if (statuses.includes("working")) return "working";
  if (statuses.every((status) => status === "complete")) return "complete";
  return null;
}

export function rowPresentation(row: WorkspaceRow): { icon: string; color: string } {
  switch (row.kind) {
    case "repository": return { icon: workspaceIcons.repository, color: "#CBD5E1" };
    case "worktree": return { icon: workspaceIcons.worktree, color: "#CBD5E1" };
    case "session": return statusPresentation(sessionStatus(row.session));
    case "subagent": return statusPresentation(row.subagent.status);
  }
}

function statusPresentation(status: AgentStatus | null): { icon: string; color: string } {
  if (status === null) return { icon: workspaceIcons.unreported, color: "#94A3B8" };
  return { icon: workspaceIcons[status], color: statusColors[status] };
}
