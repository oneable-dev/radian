import type { Repository } from "../workspace/model.ts";
import { defaultPreferences } from "./client.ts";
import type { RuntimePreferences } from "./protocol.ts";

export function mergeWorkspacePreferences(
  all: readonly RuntimePreferences[],
  selectedWorktree: string | null,
): RuntimePreferences {
  const result = defaultPreferences();
  result.workViews = { active: {}, agentScroll: {} };
  result.gitViews = {};
  result.agentViews = {};
  result.terminalViews = { active: [], selected: {} };
  for (const preferences of all) {
    Object.assign(result.selection.sessions, preferences.selection.sessions);
    Object.assign(result.drafts, preferences.drafts);
    if (preferences.inputDrafts) {
      Object.assign((result.inputDrafts ??= {}), preferences.inputDrafts);
    }

    Object.assign(result.workViews.active, preferences.workViews?.active);
    Object.assign(result.workViews.agentScroll, preferences.workViews?.agentScroll);
    Object.assign(result.gitViews, preferences.gitViews);
    Object.assign(result.agentViews, preferences.agentViews);
    result.terminalViews.active.push(...(preferences.terminalViews?.active ?? []));
    Object.assign(result.terminalViews.selected, preferences.terminalViews?.selected);
  }

  result.selection.worktreeId = selectedWorktree;

  return structuredClone(result);
}

// Each daemon retains only its own UI state. Never write a merged workspace into one repo's manifest.
export function repositoryPreferences(
  preferences: RuntimePreferences,
  repository: Repository,
  previous: RuntimePreferences,
  knownSessions: readonly string[] = [],
): RuntimePreferences {
  const worktrees = new Set(repository.worktrees.map((tree) => tree.id));
  const sessions = new Set([
    ...knownSessions,
    ...repository.worktrees.flatMap((tree) => tree.sessions.map((session) => session.id)),
    ...Object.values(previous.selection.sessions),
    ...Object.keys(previous.drafts),
    ...Object.keys(previous.inputDrafts ?? {}),
    ...Object.keys(previous.workViews?.agentScroll ?? {}),
    ...Object.keys(previous.agentViews ?? {}),
  ]);
  const select = <T>(
    record: Readonly<Record<string, T>>,
    ids: ReadonlySet<string>,
  ): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([id]) => ids.has(id)));
  // Worktrees that vanished from the catalog keep their saved metadata: discovery or an
  // unavailable repository must not turn into a persisted loss of selection or view state.
  const vanished = <T>(record: Readonly<Record<string, T>> | undefined): Record<string, T> =>
    Object.fromEntries(Object.entries(record ?? {}).filter(([id]) => !worktrees.has(id)));
  const byWorktree = <T>(
    incoming: Readonly<Record<string, T>>,
    saved: Readonly<Record<string, T>> | undefined,
  ): Record<string, T> => ({ ...vanished(saved), ...select(incoming, worktrees) });

  return structuredClone({
    selection: {
      worktreeId:
        preferences.selection.worktreeId && worktrees.has(preferences.selection.worktreeId)
          ? preferences.selection.worktreeId
          : previous.selection.worktreeId,
      sessions: byWorktree(preferences.selection.sessions, previous.selection.sessions),
    },
    drafts: select(preferences.drafts, sessions),
    ...(preferences.inputDrafts ? { inputDrafts: select(preferences.inputDrafts, sessions) } : {}),
    ...(preferences.workViews
      ? {
          workViews: {
            active: byWorktree(preferences.workViews.active, previous.workViews?.active),
            agentScroll: select(preferences.workViews.agentScroll, sessions),
          },
        }
      : {}),
    ...(preferences.gitViews
      ? { gitViews: byWorktree(preferences.gitViews, previous.gitViews) }
      : {}),
    ...(preferences.agentViews ? { agentViews: select(preferences.agentViews, sessions) } : {}),
    ...(preferences.terminalViews
      ? {
          terminalViews: {
            active: [
              ...(previous.terminalViews?.active ?? []).filter((id) => !worktrees.has(id)),
              ...preferences.terminalViews.active.filter((id) => worktrees.has(id)),
            ],
            selected: byWorktree(
              preferences.terminalViews.selected,
              previous.terminalViews?.selected,
            ),
          },
        }
      : {}),
  });
}

export type PreferenceScrubScope = {
  readonly worktreeIds: ReadonlySet<string>;
  readonly sessionIds: ReadonlySet<string>;
};

/**
 * Returns a copy without any UI state owned by deleted worktrees or sessions.
 *
 * Unlike `repositoryPreferences`, which keeps vanished worktrees because absence is not proof of
 * deletion, this is applied only for confirmed cleanup receipts. A session selected by a deleted
 * worktree is treated as deleted as well, so its draft cannot survive under the session key.
 */
export function scrubPreferences(
  preferences: RuntimePreferences,
  scope: PreferenceScrubScope,
): RuntimePreferences {
  const result = structuredClone(preferences);
  const sessions = new Set(scope.sessionIds);
  for (const [worktreeId, sessionId] of Object.entries(result.selection.sessions)) {
    if (scope.worktreeIds.has(worktreeId)) sessions.add(sessionId);
  }

  const keepWorktrees = <T>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([id]) => !scope.worktreeIds.has(id)));
  const keepSessions = <T>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([id]) => !sessions.has(id)));

  if (result.selection.worktreeId !== null && scope.worktreeIds.has(result.selection.worktreeId)) {
    result.selection.worktreeId = null;
  }
  result.selection.sessions = Object.fromEntries(
    Object.entries(result.selection.sessions).filter(
      ([worktreeId, sessionId]) => !scope.worktreeIds.has(worktreeId) && !sessions.has(sessionId),
    ),
  );
  result.drafts = keepSessions(result.drafts);
  if (result.inputDrafts) result.inputDrafts = keepSessions(result.inputDrafts);
  if (result.workViews) {
    result.workViews = {
      active: keepWorktrees(result.workViews.active),
      agentScroll: keepSessions(result.workViews.agentScroll),
    };
  }
  if (result.gitViews) result.gitViews = keepWorktrees(result.gitViews);
  if (result.agentViews) result.agentViews = keepSessions(result.agentViews);
  if (result.terminalViews) {
    result.terminalViews = {
      active: result.terminalViews.active.filter((id) => !scope.worktreeIds.has(id)),
      selected: keepWorktrees(result.terminalViews.selected),
    };
  }

  return result;
}
