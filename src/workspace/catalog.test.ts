import { expect, test } from "bun:test";
import { demoWorkspace } from "./demo.ts";
import { RepositoryCatalog } from "./catalog.ts";

test("워크트리 목록을 교체할 때 새 메타데이터와 사용 중인 삭제 워크트리를 함께 보존한다", () => {
  // An open resource still owns a removed worktree, while another removed worktree is idle.
  const original = demoWorkspace()[0]!;
  const active = original.worktrees[1]!, idle = original.worktrees[2]!;
  const catalog = new RepositoryCatalog([original]);
  const added = { ...idle, id: "new-tree", path: "/new-tree", name: "new-tree", branch: "feature/new", sessions: [] };
  const discovered = { ...original, worktrees: [{ ...original.worktrees[0]!, branch: "updated" }, added] };

  // Refreshing metadata never implicitly closes the resource that still needs the old path.
  catalog.replace([discovered], new Set([active.id]));

  expect(catalog.snapshot[0]!.worktrees.map((tree) => tree.id)).toEqual([original.worktrees[0]!.id, added.id, active.id]);
  expect(catalog.snapshot[0]!.worktrees[0]!.branch).toBe("updated");
  expect(catalog.snapshot[0]!.worktrees).not.toContain(idle);
  expect(original.worktrees[0]!.branch).toBe("main");
});

test("마지막 리소스를 닫으면 Git에서 제거된 워크트리도 목록에서 정리한다", () => {
  // The previously retained metadata must not outlive its final owner.
  const original = demoWorkspace()[0]!, active = original.worktrees[1]!;
  const discovered = { ...original, worktrees: [original.worktrees[0]!] };
  const catalog = new RepositoryCatalog([original]);
  catalog.replace([discovered], new Set([active.id]));

  catalog.replace([discovered], new Set());

  expect(catalog.snapshot[0]!.worktrees).toEqual(discovered.worktrees);
});
