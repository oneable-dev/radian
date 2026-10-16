import type { RuntimePreferences, WorkViewPreferences } from "./protocol.ts";

export function restoreWorkViews(preferences: RuntimePreferences): WorkViewPreferences {
  const views: WorkViewPreferences = structuredClone(preferences.workViews ?? { active: {}, agentScroll: {} });
  for (const worktreeId of preferences.terminalViews?.active ?? []) views.active[worktreeId] = "terminal";
  views.terminalSelection = { ...preferences.terminalViews?.selected };
  if (preferences.gitViews) views.gitViews = structuredClone(preferences.gitViews);
  if (preferences.agentViews) views.agentViews = structuredClone(preferences.agentViews);
  return views;
}
export function saveWorkViews(preferences: RuntimePreferences, views: WorkViewPreferences): void {
  const active: NonNullable<RuntimePreferences["workViews"]>["active"] = {};
  const terminals: string[] = [];
  for (const [worktreeId, view] of Object.entries(views.active)) {
    if (view === "terminal") {
      terminals.push(worktreeId); active[worktreeId] = preferences.workViews?.active[worktreeId] ?? "agent";
    } else active[worktreeId] = view;
  }
  preferences.workViews = { active, agentScroll: { ...views.agentScroll } };
  preferences.terminalViews = { active: terminals, selected: { ...views.terminalSelection } };
  if (views.gitViews) preferences.gitViews = structuredClone(views.gitViews);
  if (views.agentViews) preferences.agentViews = structuredClone(views.agentViews);
}
