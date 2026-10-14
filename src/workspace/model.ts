export type Subagent = {
  readonly id: string;
  readonly name: string;
};

// Display snapshots have no ownership of Pi agents or saved session records.
export type OpenSession = {
  readonly id: string;
  readonly name: string;
  readonly subagents: readonly Subagent[];
};

export type Worktree = {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly branch: string | null;
  readonly sessions: readonly OpenSession[];
};

export type Repository = {
  readonly id: string;
  readonly name: string;
  readonly worktrees: readonly Worktree[];
};

export type WorkspaceRow = {
  readonly key: string;
  readonly depth: number;
  readonly label: string;
} & (
  | { readonly kind: "repository"; readonly repository: Repository }
  | { readonly kind: "worktree"; readonly worktree: Worktree }
  | { readonly kind: "session"; readonly worktree: Worktree; readonly session: OpenSession }
  | { readonly kind: "subagent"; readonly worktree: Worktree; readonly subagent: Subagent }
);

export function workspaceRows(repositories: readonly Repository[]): WorkspaceRow[] {
  const rows: WorkspaceRow[] = [];
  for (const repository of repositories) {
    rows.push({ key: `repository:${repository.id}`, kind: "repository", depth: 0, label: repository.name, repository });
    for (const worktree of repository.worktrees) {
      rows.push({
        key: `worktree:${worktree.id}`, kind: "worktree", depth: 1, worktree,
        label: `${worktree.name} (${worktree.branch ?? "detached HEAD"})`,
      });
      for (const session of worktree.sessions) {
        rows.push({ key: `session:${worktree.id}:${session.id}`, kind: "session", depth: 2, label: session.name, worktree, session });
        for (const subagent of session.subagents) {
          rows.push({ key: `subagent:${worktree.id}:${session.id}:${subagent.id}`, kind: "subagent", depth: 3, label: subagent.name, worktree, subagent });
        }
      }
    }
  }
  return rows;
}
