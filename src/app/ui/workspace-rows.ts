import type { Repository, Worktree } from "../../workspace/model.ts";

export type WorkspaceRow = {
  readonly key: string;
  readonly depth: number;
  readonly label: string;
} & (
  | { readonly kind: "repository"; readonly repository: Repository }
  | { readonly kind: "worktree"; readonly worktree: Worktree }
);

export function workspaceRows(repositories: readonly Repository[]): WorkspaceRow[] {
  return repositories.flatMap((repository) => [
    { key: `repository:${repository.id}`, kind: "repository" as const, depth: 0, label: repository.name, repository },
    ...repository.worktrees.map((worktree) => ({
      key: `worktree:${worktree.id}`, kind: "worktree" as const, depth: 1, worktree,
      label: worktree.name,
    })),
  ]);
}
