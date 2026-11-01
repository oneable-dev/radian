import { expect, test } from "bun:test";
import { demoWorkspace } from "./demo.ts";
import { RepositoryCatalog } from "./catalog.ts";

test("Replacing worktree catalogs preserves fresh metadata and deleted worktrees still in use", () => {
  // An open resource still owns a removed worktree, while another removed worktree is idle.
  const original = demoWorkspace()[0]!;
  const active = original.worktrees[1]!;
  const idle = original.worktrees[2]!;
  const catalog = new RepositoryCatalog([original]);
  const added = {
    ...idle,
    id: "new-tree",
    path: "/new-tree",
    name: "new-tree",
    branch: "feature/new",
    sessions: [],
  };
  const discovered = {
    ...original,
    worktrees: [{ ...original.worktrees[0]!, branch: "updated" }, added],
  };

  // Refreshing metadata never implicitly closes the resource that still needs the old path.
  catalog.replace([discovered], new Set([active.id]));

  expect(catalog.snapshot[0]!.worktrees.map((tree) => tree.id)).toEqual([
    original.worktrees[0]!.id,
    added.id,
    active.id,
  ]);
  expect(catalog.snapshot[0]!.worktrees[0]!.branch).toBe("updated");
  expect(catalog.snapshot[0]!.worktrees).not.toContain(idle);
  expect(original.worktrees[0]!.branch).toBe("main");
});

test("Closing final resources removes Git-deleted worktrees from catalogs", () => {
  // The previously retained metadata must not outlive its final owner.
  const original = demoWorkspace()[0]!;
  const active = original.worktrees[1]!;
  const discovered = { ...original, worktrees: [original.worktrees[0]!] };
  const catalog = new RepositoryCatalog([original]);

  catalog.replace([discovered], new Set([active.id]));

  catalog.replace([discovered], new Set());

  expect(catalog.snapshot[0]!.worktrees).toEqual(discovered.worktrees);
});

test("Repositories removed entirely keep only worktrees still owned by open resources", () => {
  // One deleted repository still has an open resource; another deleted repository is idle.
  const [first, second] = demoWorkspace();
  const owned = first!.worktrees[1]!;
  const catalog = new RepositoryCatalog([first!, second!]);

  catalog.replace([], new Set([owned.id]));

  // The open resource keeps its metadata; nothing else from the vanished repositories survives.
  expect(catalog.snapshot).toEqual([{ ...first!, worktrees: [owned] }]);

  catalog.replace([], new Set());

  expect(catalog.snapshot).toEqual([]);
});

test("Reappearing repositories take fresh discovery metadata instead of retained entries", () => {
  const original = demoWorkspace()[0]!;
  const owned = original.worktrees[1]!;
  const catalog = new RepositoryCatalog([original]);
  catalog.replace([], new Set([owned.id]));

  const reappeared = { ...original, worktrees: [{ ...owned, branch: "restored" }] };
  catalog.replace([reappeared], new Set([owned.id]));

  // The rediscovered worktree is listed once, with its current branch.
  expect(catalog.snapshot).toEqual([reappeared]);
});

test("Confirmed deleted worktrees leave the catalog even while their resources still stop", () => {
  // Deletion is explicit; a same-path checkout must not be admitted before its cleanup ends.
  const original = demoWorkspace()[0]!;
  const deleted = original.worktrees[1]!;
  const sibling = original.worktrees[2]!;
  const catalog = new RepositoryCatalog([original]);

  catalog.replace([original], new Set([deleted.id, sibling.id]), new Set([deleted.id]));

  expect(catalog.snapshot[0]!.worktrees.map((tree) => tree.id)).toEqual(
    original.worktrees.filter((tree) => tree.id !== deleted.id).map((tree) => tree.id),
  );
});
