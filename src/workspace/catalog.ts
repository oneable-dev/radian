import type { Repository } from "./model.ts";

// Executions live in their owners; this catalog only shares current worktree metadata.
export class RepositoryCatalog {
  constructor(private repositories: readonly Repository[]) {}

  get snapshot(): readonly Repository[] {
    return this.repositories;
  }

  // Discovery alone decides membership. Worktrees missing from it remain only while an open
  // resource still owns them, including when their entire repository has disappeared.
  // `deletedWorktreeIds` are confirmed deletions: they are dropped even while their resources
  // are still stopping, and a same-path directory is not admitted until the cleanup finished.
  replace(
    discovered: readonly Repository[],
    retainedWorktreeIds: ReadonlySet<string>,
    deletedWorktreeIds: ReadonlySet<string> = new Set(),
  ): void {
    const fresh = worktreeIds(discovered);
    const retainedFrom = (previous: Repository | undefined) =>
      previous?.worktrees.filter(
        (tree) =>
          !fresh.has(tree.id) &&
          retainedWorktreeIds.has(tree.id) &&
          !deletedWorktreeIds.has(tree.id),
      ) ?? [];
    const current = discovered.map((repo) => {
      const previous = this.repositories.find((candidate) => candidate.id === repo.id);
      const worktrees = repo.worktrees.filter((tree) => !deletedWorktreeIds.has(tree.id));

      return { ...repo, worktrees: [...worktrees, ...retainedFrom(previous)] };
    });
    const vanished = this.repositories.flatMap((previous) => {
      if (discovered.some((repo) => repo.id === previous.id)) {
        return [];
      }

      const worktrees = retainedFrom(previous);

      return worktrees.length ? [{ ...previous, worktrees }] : [];
    });

    this.repositories = [...current, ...vanished];
  }
}

function worktreeIds(repositories: readonly Repository[]): ReadonlySet<string> {
  return new Set(repositories.flatMap((repo) => repo.worktrees.map((tree) => tree.id)));
}

export type RepositorySource = readonly Repository[] | RepositoryCatalog;

export function repositorySnapshot(source: RepositorySource): readonly Repository[] {
  return source instanceof RepositoryCatalog ? source.snapshot : source;
}
