import { expect, test } from "bun:test";
import { demoWorkspace } from "../workspace/demo.ts";
import { workspaceRows } from "./ui/workspace-rows.ts";
import { WorkspaceSelection } from "./workspace-selection.ts";

function remove(selection: WorkspaceSelection, worktreeId: string, sessionId: string): void {
  selection.replaceSnapshot(selection.snapshot.map((repo) => ({
    ...repo, worktrees: repo.worktrees.map((tree) => tree.id === worktreeId ? {
      ...tree, sessions: tree.sessions.filter((session) => session.id !== sessionId),
    } : tree),
  })));
}

test("워크트리 재선택 시 마지막으로 선택한 세션을 복원한다", () => {
  // Two worktrees contain different session lists.
  const selection = new WorkspaceSelection(demoWorkspace());
  const original = selection.snapshot;

  // Visiting another worktree changes only the display selection.
  selection.selectSession("demo:main", "a2");
  selection.selectWorktree("demo:feature");
  selection.selectWorktree("demo:main");

  // The original snapshot is neither replaced nor altered by navigation.
  expect(selection.sessionId).toBe("a2");
  expect(selection.snapshot).toBe(original);
});

test("처음 표시한 세션도 목록 순서가 바뀐 뒤 워크트리 재방문 시 복원한다", () => {
  // The first displayed selection is A1 even without an explicit session click.
  const selection = new WorkspaceSelection(demoWorkspace());
  selection.selectWorktree("demo:feature");

  // The host reorders surviving items without closing the remembered session.
  selection.replaceSnapshot(selection.snapshot.map((repo) => ({
    ...repo, worktrees: repo.worktrees.map((tree) => ({ ...tree, sessions: [...tree.sessions].reverse() })),
  })));
  selection.selectWorktree("demo:main");

  // Last selection is an identity, not an index into the new order.
  expect(selection.sessionId).toBe("a1");
});

test.each([
  ["a2", "a3"], ["a3", "a2"], ["a1", "a2"],
])("선택한 %s 항목 제거 시 인접 세션 %s를 선택한다", (closed, next) => {
  // The fixture's display order is A1, A2, A3.
  const selection = new WorkspaceSelection(demoWorkspace());
  selection.selectSession("demo:main", closed);

  // The host reports the removed item without executing a runtime operation.
  remove(selection, "demo:main", closed);

  // Following takes priority; the previous item is used at the end.
  expect(selection.sessionId).toBe(next);
});

test("비선택 워크트리의 마지막 선택 항목 제거도 복원 시 유효한 항목으로 대체한다", () => {
  // A remembers A2 while B is on screen.
  const selection = new WorkspaceSelection(demoWorkspace());
  selection.selectSession("demo:main", "a2");
  selection.selectWorktree("demo:feature");

  // The host's updated snapshot removes A2 while A is not visible.
  remove(selection, "demo:main", "a2");
  selection.selectWorktree("demo:main");

  // Returning uses the following surviving session, not a stale ID.
  expect(selection.sessionId).toBe("a3");
});

test("마지막 항목 제거와 빈 워크트리 선택 모두 세션을 자동 생성하지 않는다", () => {
  // Worktree B contains exactly one fixture session.
  const selection = new WorkspaceSelection(demoWorkspace());
  selection.selectWorktree("demo:feature");

  // Removing the final item leaves the same shape as an initially empty worktree.
  remove(selection, "demo:feature", "b1");
  const closedSession = selection.sessionId;
  selection.selectWorktree("demo:empty");

  // Neither operation manufactures a replacement session.
  expect(closedSession).toBeNull();
  expect(selection.sessionId).toBeNull();
  expect(selection.worktree?.sessions).toHaveLength(0);
});

test("Workspace 목록은 세션 데이터를 유지하면서 레포와 워크트리 행만 표시한다", () => {
  // Open sessions and owned children remain available to the Agents panel.
  const fixture = demoWorkspace();

  // Workspace navigation deliberately excludes both deeper levels.
  const rows = workspaceRows(fixture);

  expect(rows.find((row) => row.key === "worktree:demo:main")?.label).toBe("radian (main)");
  expect(rows.map((row) => row.depth)).toEqual([0, 1, 1, 1]);
  expect(rows).toHaveLength(4);
  expect(fixture[0]!.worktrees[0]!.sessions[0]!.subagents[0]!.name).toBe("UI review");
});

test("없는 선택 ID는 현재 선택을 변경하지 않는다", () => {
  // The first worktree has a valid selected session.
  const selection = new WorkspaceSelection(demoWorkspace());

  // Stale UI input refers to records absent from the snapshot.
  selection.selectWorktree("missing");
  selection.selectSession("demo:main", "missing");

  // Invalid input does not erase an existing valid selection.
  expect(selection.worktree?.id).toBe("demo:main");
  expect(selection.sessionId).toBe("a1");
});
