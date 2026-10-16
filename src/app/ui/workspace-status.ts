import { icons } from "../../icons.ts";
import type { WorkspaceRow } from "./workspace-rows.ts";

export const workspaceIcons = {
  repository: icons.repo,
  worktree: icons.folder,
  working: icons.loading,
  complete: icons.pass,
  failure: icons.error,
  unreported: icons.unknown,
} as const;

export function rowPresentation(row: WorkspaceRow): { icon: string; color: "text" } {
  return { icon: row.kind === "repository" ? icons.repo : icons.folder, color: "text" };
}
