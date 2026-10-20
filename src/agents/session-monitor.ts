import type { OpenSession } from "./model.ts";
import type { Repository } from "../workspace/model.ts";
import { fuzzyMatch } from "../ui/fuzzy-match.ts";

export type MonitoredSession = {
  readonly session: OpenSession;
  readonly worktreeId: string;
  readonly repository: string;
  readonly worktree: string;
  readonly branch: string | null;
  readonly title: string;
  readonly working: boolean;
};

// Project only summaries already supplied by repository runtimes. Never walk transcripts here.
export function monitoredSessions(repositories: readonly Repository[], query = ""): MonitoredSession[] {
  const unread: MonitoredSession[] = [], running: MonitoredSession[] = [];
  for (const repository of repositories) for (const tree of repository.worktrees) for (const session of tree.sessions) {
    const working = session.status === "working" || session.subagents.some(child => child.status === "working");
    if (!working && !session.attention) continue;
    const title = session.request?.text || session.attention?.request?.text || session.name;
    if (query && !fuzzyMatch(`${title} ${repository.name} ${tree.name} ${tree.branch ?? ""}`, query)) continue;
    (session.attention ? unread : running).push({ session, worktreeId: tree.id, repository: repository.name, worktree: tree.name, branch: tree.branch, title, working });
  }
  // Stable within each group so streaming/progress updates cannot reorder candidates under the cursor.
  return [...unread, ...running];
}
