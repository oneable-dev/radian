import type { OpenSession } from "../agents/model.ts";
import type { WorkspaceSnapshot } from "../runtime/workspace-client.ts";

type Source = {
  readonly scopeId: string;
  readonly repository: string;
  readonly name: string;
  readonly branch: string | null;
  readonly sessions: readonly OpenSession[];
};

// Project labels are display metadata, never a synthetic repository for CHAT.
export function sessionSources(
  snapshot: Pick<WorkspaceSnapshot, "repositories" | "chat">,
): Source[] {
  return [
    ...snapshot.repositories.flatMap((repository) =>
      repository.worktrees.map((worktree) => ({
        scopeId: worktree.id,
        repository: repository.name,
        name: worktree.name,
        branch: worktree.branch,
        sessions: worktree.sessions,
      })),
    ),
    ...(snapshot.chat
      ? [
          {
            scopeId: snapshot.chat.id,
            repository: "CHAT",
            name: "CHAT",
            branch: null,
            sessions: snapshot.chat.sessions,
          },
        ]
      : []),
  ];
}
