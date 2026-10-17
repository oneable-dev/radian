import type { Repository } from "../workspace/model.ts";
import { defaultPreferences } from "./client.ts";
import type { RuntimePreferences } from "./protocol.ts";

export function mergeWorkspacePreferences(all: readonly RuntimePreferences[], selectedWorktree: string | null): RuntimePreferences {
  const result = defaultPreferences();
  result.workViews = { active: {}, agentScroll: {} };
  result.gitViews = {}; result.agentViews = {}; result.terminalViews = { active: [], selected: {} };
  for (const preferences of all) {
    Object.assign(result.selection.sessions, preferences.selection.sessions);
    Object.assign(result.drafts, preferences.drafts);
    Object.assign(result.workViews.active, preferences.workViews?.active);
    Object.assign(result.workViews.agentScroll, preferences.workViews?.agentScroll);
    Object.assign(result.gitViews, preferences.gitViews);
    Object.assign(result.agentViews, preferences.agentViews);
    result.terminalViews.active.push(...preferences.terminalViews?.active ?? []);
    Object.assign(result.terminalViews.selected, preferences.terminalViews?.selected);
  }
  result.selection.worktreeId = selectedWorktree;
  return structuredClone(result);
}

// Each daemon retains only its own UI state. Never write a merged workspace into one repo's manifest.
export function repositoryPreferences(preferences: RuntimePreferences, repository: Repository, previous: RuntimePreferences, knownSessions: readonly string[] = []): RuntimePreferences {
  const worktrees = new Set(repository.worktrees.map((tree) => tree.id));
  const sessions = new Set([...knownSessions, ...repository.worktrees.flatMap((tree) => tree.sessions.map((session) => session.id)),
    ...Object.values(previous.selection.sessions), ...Object.keys(previous.drafts), ...Object.keys(previous.workViews?.agentScroll ?? {}), ...Object.keys(previous.agentViews ?? {})]);
  const select = <T>(record: Readonly<Record<string, T>>, ids: ReadonlySet<string>): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([id]) => ids.has(id)));
  return structuredClone({
    selection: { worktreeId: preferences.selection.worktreeId && worktrees.has(preferences.selection.worktreeId) ? preferences.selection.worktreeId : previous.selection.worktreeId,
      sessions: select(preferences.selection.sessions, worktrees) },
    drafts: select(preferences.drafts, sessions),
    ...(preferences.workViews ? { workViews: { active: select(preferences.workViews.active, worktrees), agentScroll: select(preferences.workViews.agentScroll, sessions) } } : {}),
    ...(preferences.gitViews ? { gitViews: select(preferences.gitViews, worktrees) } : {}),
    ...(preferences.agentViews ? { agentViews: select(preferences.agentViews, sessions) } : {}),
    ...(preferences.terminalViews ? { terminalViews: { active: preferences.terminalViews.active.filter((id) => worktrees.has(id)), selected: select(preferences.terminalViews.selected, worktrees) } } : {}),
  });
}
