import type { Repository } from "./model.ts";
import { fuzzyMatch } from "../ui/fuzzy-match.ts";

// Filtering is a display projection only; session titles and agent outcomes
// never become matching fields or determine runtime ownership.
export function filterWorkspaces(repositories: readonly Repository[], query: string): readonly Repository[] {
  if (query === "") return repositories;
  const matches = (value: string): boolean => fuzzyMatch(value, query);
  return repositories.flatMap((repository) => {
    if (matches(repository.name)) return [repository];
    const worktrees = repository.worktrees.filter((tree) => matches(tree.name)
      || (tree.branch !== null && matches(tree.branch)));
    if (worktrees.length === 0) return [];
    return [{ ...repository, worktrees }];
  });
}
