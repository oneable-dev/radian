import type { Repository } from "./model.ts";

// Executions live in their owners; this catalog only shares current worktree metadata.
export class RepositoryCatalog {
  constructor(private repositories: readonly Repository[]) {}
  get snapshot(): readonly Repository[] {
    return this.repositories;
  }

  replace(discovered: readonly Repository[], retainedWorktreeIds: ReadonlySet<string>): void {
    this.repositories = discovered.map((repo) => {
      const known = new Set(repo.worktrees.map((tree) => tree.id));
      const retained =
        this.repositories
          .find((previous) => previous.id === repo.id)
          ?.worktrees.filter((tree) => !known.has(tree.id) && retainedWorktreeIds.has(tree.id)) ??
        [];
      return { ...repo, worktrees: [...repo.worktrees, ...retained] };
    });
  }
}

export type RepositorySource = readonly Repository[] | RepositoryCatalog;
export function repositorySnapshot(source: RepositorySource): readonly Repository[] {
  return source instanceof RepositoryCatalog ? source.snapshot : source;
}
