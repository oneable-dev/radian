import { expect, test } from "bun:test";
import { demoWorkspace } from "../workspace/demo.ts";
import { workspaceRows } from "./ui/workspace-rows.ts";
import { WorkspaceSelection } from "./workspace-selection.ts";

function remove(selection: WorkspaceSelection, worktreeId: string, sessionId: string): void {
  selection.replaceSnapshot(
    selection.snapshot.map((repo) => ({
      ...repo,
      worktrees: repo.worktrees.map((tree) =>
        tree.id === worktreeId
          ? {
              ...tree,
              sessions: tree.sessions.filter((session) => session.id !== sessionId),
            }
          : tree,
      ),
    })),
  );
}

test("Reselecting worktrees restores their last selected sessions", () => {
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

test("Initially displayed sessions restore after list reordering and worktree revisits", () => {
  // The first displayed selection is A1 even without an explicit session click.
  const selection = new WorkspaceSelection(demoWorkspace());
  selection.selectWorktree("demo:feature");

  // The host reorders surviving items without closing the remembered session.
  selection.replaceSnapshot(
    selection.snapshot.map((repo) => ({
      ...repo,
      worktrees: repo.worktrees.map((tree) => ({
        ...tree,
        sessions: [...tree.sessions].reverse(),
      })),
    })),
  );
  selection.selectWorktree("demo:main");

  // Last selection is an identity, not an index into the new order.
  expect(selection.sessionId).toBe("a1");
});

test.each([
  ["a2", "a3"],
  ["a3", "a2"],
  ["a1", "a2"],
])("Removing selected %s entries selects adjacent session %s", (closed, next) => {
  // The fixture's display order is A1, A2, A3.
  const selection = new WorkspaceSelection(demoWorkspace());
  selection.selectSession("demo:main", closed);

  // The host reports the removed item without executing a runtime operation.
  remove(selection, "demo:main", closed);

  // Following takes priority; the previous item is used at the end.
  expect(selection.sessionId).toBe(next);
});

test("Removing background worktrees' last selections restores valid replacements", () => {
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

test("Final removal and empty-worktree selection never automatically create sessions", () => {
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

test("Workspace lists retain session data while displaying only repository/worktree rows", () => {
  // Open sessions and owned children remain available to the Agents panel.
  const fixture = demoWorkspace();

  // Workspace navigation deliberately excludes both deeper levels.
  const rows = workspaceRows(fixture);

  const main = rows.find((row) => row.key === "worktree:demo:main");

  expect(main?.label).toBe("radian");
  expect(main?.kind === "worktree" ? main.worktree.branch : null).toBe("main");
  expect(rows.map((row) => row.depth)).toEqual([0, 1, 1, 1]);
  expect(rows).toHaveLength(4);
  expect(fixture[0]!.worktrees[0]!.sessions[0]!.subagents[0]!.name).toBe("UI review");
});

test("Unknown selection IDs preserve current selection", () => {
  // The first worktree has a valid selected session.
  const selection = new WorkspaceSelection(demoWorkspace());

  // Stale UI input refers to records absent from the snapshot.
  selection.selectWorktree("missing");
  selection.selectSession("demo:main", "missing");

  // Invalid input does not erase an existing valid selection.
  expect(selection.worktree?.id).toBe("demo:main");
  expect(selection.sessionId).toBe("a1");
});

test("Late-connected repositories restore saved sessions without switching current worktrees", () => {
  // Inactive repositories have no runtime connection and empty session rows.
  const full = demoWorkspace();
  const cold = full.map((repo) => ({
    ...repo,
    worktrees: repo.worktrees.map((tree) =>
      tree.id === "demo:main" ? { ...tree, sessions: [] } : tree,
    ),
  }));
  const selection = new WorkspaceSelection(cold);

  selection.selectWorktree("demo:feature");

  // Late connection retains current selection while remembering previously selected A2.
  selection.replaceSnapshot(full, { "demo:main": "a2" });
  expect(selection.worktree?.id).toBe("demo:feature");
  selection.selectWorktree("demo:main");

  // Opening another repository must not reset selection to first session A1.
  expect(selection.sessionId).toBe("a2");
});
