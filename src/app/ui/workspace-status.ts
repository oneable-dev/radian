import { icons } from "../../icons.ts";
import type { AgentStatus } from "../../agents/model.ts";
import { sessionStatus } from "../../agents/status.ts";
import type { WorkspaceRow } from "./workspace-rows.ts";

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
