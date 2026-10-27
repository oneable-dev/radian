import { expect, test } from "bun:test";
import type { Repository } from "./model.ts";
import { filterWorkspaces } from "./filter-workspaces.ts";

function fixture(): Repository[] {
  return [
    {
      id: "repo-a",
      name: "Atlas",
      worktrees: [
        {
          id: "tree-a",
          path: "/tmp/checkout",
          name: "Checkout-One",
          branch: "feature/Search",
          sessions: [
            {
              id: "s1",
              name: "only-session-label",
              status: "complete",
              subagents: [{ id: "c1", name: "only-subagent-label", status: "working" }],
            },
          ],
        },
        { id: "tree-b", path: "/tmp/empty", name: "Empty", branch: null, sessions: [] },
      ],
    },
    {
      id: "repo-b",
      name: "Tools.Kit",
      worktrees: [{ id: "tree-c", path: "/tmp/glue", name: "Glue", branch: "main", sessions: [] }],
    },
  ];
}

for (const [query, expected] of [
  ["tLaS", ["tree-a", "tree-b"]],
  ["cKoUt", ["tree-a"]],
  ["TURE/seA", ["tree-a"]],
  ["GLU", ["tree-c"]],
  ["  ＳＥＡＲＣＨ feature  ", ["tree-a"]],
] satisfies [string, string[]][]) {
  test(`Query ${query} matches name and branch substrings case-insensitively`, () => {
    // Repository names, folder names and branch names have distinct values.
    const input = fixture();

    // Partial matching uses original metadata, not the formatted row labels.
    const result = filterWorkspaces(input, query);

    // Only matching worktrees or a matching repository's complete subtree survive.
    expect(result.flatMap((repo) => repo.worktrees.map((tree) => tree.id))).toEqual(expected);
  });
}

for (const query of [
  "only-session-label",
  "only-subagent-label",
  "/tmp/",
  "detached HEAD",
  "working",
  "missing",
]) {
  test(`Query ${query} excludes session names and nonsearchable display metadata`, () => {
    // Agent labels, paths and the detached display label are not search fields.
    const input = fixture();

    // No repository, folder or actual branch matches this query.
    const result = filterWorkspaces(input, query);

    // Descendant names and display status must not pull ancestors into the results.
    expect(result).toEqual([]);
  });
}

test.each(["ckot", "checkout search"])(
  "Query %s excludes candidates unless every word appears contiguously in the same field",
  (query) => {
    // Checkout-One and feature/Search belong to the same tree but are separate search fields.
    const input = fixture();

    const result = filterWorkspaces(input, query);

    // Neither scattered letters nor combining terms across fields may admit this worktree.
    expect(result).toEqual([]);
  },
);

test("Repository-name matches preserve all descendants including empty worktrees", () => {
  // Atlas owns a populated worktree and a detached empty worktree.
  const input = fixture();

  // Matching the repository keeps its entire existing subtree by identity.
  const result = filterWorkspaces(input, "atlas");

  // Filtering does not copy, remove or recreate the repository's descendants.
  expect(result).toHaveLength(1);
  expect(result[0]).toBe(input[0]);
  expect(result[0]?.worktrees).toHaveLength(2);
});

test("Worktree matches retain original parent repositories, sessions, and subagents", () => {
  // The session title intentionally does not match the worktree query.
  const input = fixture();
  const before = structuredClone(input);

  // One worktree matches while its sibling is excluded from this projection.
  const result = filterWorkspaces(input, "checkout");

  // Source metadata and full child arrays remain untouched and retain their identity.
  expect(result[0]?.id).toBe("repo-a");
  expect(result[0]?.worktrees).toHaveLength(1);
  expect(result[0]?.worktrees[0]).toBe(input[0]?.worktrees[0]);
  expect(result[0]?.worktrees[0]?.sessions).toBe(input[0]?.worktrees[0]?.sessions);
  expect(result[0]?.worktrees[0]?.sessions[0]?.subagents).toHaveLength(1);
  expect(input).toEqual(before);
});

test("Empty queries return original data and regex symbols match literally", () => {
  // Only Tools.Kit has a literal dot in its searchable metadata.
  const input = fixture();

  // Clearing restores the source; punctuation does not enable regex matching.
  const cleared = filterWorkspaces(input, "");
  const punctuation = filterWorkspaces(input, ".");

  // A dot must not act as a wildcard for all repository/worktree names.
  expect(cleared).toBe(input);
  expect(punctuation.map((repo) => repo.name)).toEqual(["Tools.Kit"]);
});
