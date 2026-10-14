import type { Repository } from "./model.ts";

// Filtering is a display projection only; session titles and agent outcomes
// never become matching fields or determine runtime ownership.
export function filterWorkspaces(repositories: readonly Repository[], query: string): readonly Repository[] {
  if (query === "") return repositories;
  const term = query.toLowerCase();
  const matches = (value: string): boolean => value.toLowerCase().includes(term);
  return repositories.flatMap((repository) => {
    if (matches(repository.name)) return [repository];
    const worktrees = repository.worktrees.filter((tree) => matches(tree.name)
      || (tree.branch !== null && matches(tree.branch)));
    if (worktrees.length === 0) return [];
    return [{ ...repository, worktrees }];
  });
}
