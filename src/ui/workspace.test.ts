import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { demoWorkspace } from "../workspace/demo.ts";
import type { Repository } from "../workspace/model.ts";
import { WorkspaceSelection } from "../workspace/selection.ts";
import { WorkspaceView } from "./workspace.ts";

async function mount(repositories: readonly Repository[] = demoWorkspace()) {
  const setup = await createTestRenderer({ width: 120, height: 24 });
  const selection = new WorkspaceSelection(repositories);
  const requests: string[] = [];
  const view = new WorkspaceView(setup.renderer, selection, {
    onNewSession: (id) => { requests.push(id); },
    onCloseSession: (treeId, sessionId) => selection.replaceSnapshot(selection.snapshot.map((repo) => ({
      ...repo, worktrees: repo.worktrees.map((tree) => tree.id === treeId ? {
        ...tree, sessions: tree.sessions.filter((session) => session.id !== sessionId),
      } : tree),
    }))),
  });
  await setup.renderOnce();
  return {
    ...setup, selection, requests, view,
    async clickText(text: string): Promise<void> {
      const lines = setup.captureCharFrame().split("\n");
      const y = lines.findIndex((line) => line.includes(text));
      const x = lines[y]?.indexOf(text) ?? -1;
      if (x < 0 || y < 0) throw new Error(`Visible text not found: ${text}\n${setup.captureCharFrame()}`);
      await setup.mockMouse.click(x, y);
      await setup.renderOnce();
    },
    async close(): Promise<void> { view.dispose(); await setup.dispose(); },
  };
}

test("마우스로 세션과 워크트리를 선택하면 마지막 선택과 중앙 화면을 복원한다", async () => {
  // The renderer uses actual terminal mouse parsing and a display-only fixture.
  const app = await mount();
  try {
    // Select A2, leave for B, and return to the main worktree.
    await app.clickText("Session navigation");
    await app.clickText("radian-ui (feature/workspace)");
    await app.clickText("radian (main)");

    // The central panel reflects restored A2, without replacing source metadata.
    expect(app.selection.sessionId).toBe("a2");
    expect(app.captureCharFrame().split("\n").map((line) => line.slice(35, 99)).join("\n")).toContain("Session navigation");
  } finally { await app.close(); }
});

test("닫기 키는 끝 항목의 이전 세션을 선택하고 마지막 항목에서는 빈 화면을 표시한다", async () => {
  // The close callback reports metadata removal, not a real agent shutdown.
  const app = await mount();
  try {
    // Select the last item and close each surviving selected item.
    await app.clickText("Empty states");
    app.mockInput.pressKey("x");
    await app.renderOnce();
    expect(app.selection.sessionId).toBe("a2");
    app.mockInput.pressKey("x");
    await app.renderOnce();
    app.mockInput.pressKey("x");
    await app.renderOnce();

    // The same central empty state offers an explicit action, not an automatic session.
    expect(app.selection.sessionId).toBeNull();
    expect(app.selection.worktree?.sessions).toHaveLength(0);
    expect(app.captureCharFrame()).toContain("No open sessions");
    expect(app.captureCharFrame()).toContain("+ New session");
  } finally { await app.close(); }
});

test("행의 닫기 액션은 부모 세션을 잘못 선택하지 않는다", async () => {
  // A2 is selected; the close control belongs to the preceding A1 row.
  const app = await mount();
  try {
    await app.clickText("Session navigation");
    const row = app.renderer.root.findDescendantById("session:demo:main:a1");
    if (!row) throw new Error("Missing displayed session row");

    // Activate A1's visible close control, rather than selecting A1's row.
    await app.mockMouse.click(row.x + row.width - 2, row.y);
    await app.renderOnce();

    // Event propagation leaves the existing A2 selection unchanged.
    expect(app.selection.sessionId).toBe("a2");
    expect(app.selection.worktree?.sessions.map((session) => session.id)).toEqual(["a2", "a3"]);
  } finally { await app.close(); }
});

test("빈 워크트리의 생성 버튼은 요청만 보내며 선택이나 열린 목록을 조작하지 않는다", async () => {
  // No sessions exist in the empty worktree before the user requests creation.
  const app = await mount();
  try {
    await app.clickText("radian-empty");
    const before = app.selection.snapshot;

    // The action crosses the host callback boundary without implementing OA-5.
    await app.clickText("+ New session");

    // No runtime, automatic selection or placeholder session was manufactured.
    expect(app.requests).toEqual(["demo:empty"]);
    expect(app.selection.snapshot).toBe(before);
    expect(app.selection.sessionId).toBeNull();
    expect(app.captureCharFrame()).toContain("No open sessions");
  } finally { await app.close(); }
});

test("History 탭은 후속 UI임을 표시하고 선택을 유지한다", async () => {
  // Workspace A has a selected session before changing the sidebar tab.
  const app = await mount();
  try {
    // Switching the tab hides the tree without changing workspace state.
    await app.clickText("History");

    // No history or resume operation is implied by the placeholder.
    expect(app.captureCharFrame()).toContain("Session history UI is deferred.");
    expect(app.selection.sessionId).toBe("a1");
  } finally { await app.close(); }
});

test("키보드로 화면 밖 세션을 선택하면 트리를 스크롤하며 작은 터미널에서도 동작한다", async () => {
  // Long display-only data exceeds the viewport; no agent timers drive the UI.
  const fixture: Repository[] = [{ id: "long-repo", name: "long-repo", worktrees: [{
    id: "long-tree", path: "/demo/long", name: "long", branch: "main",
    sessions: Array.from({ length: 40 }, (_, index) => ({
      id: `long-${index}`, name: `Long session ${index}`, subagents: [],
    })),
  }] }];
  const app = await mount(fixture);
  try {
    // End selects the final navigable item and scrolls it into the viewport.
    app.mockInput.pressKey("END");
    await app.renderOnce();
    expect(app.selection.sessionId).toBe("long-39");
    expect(app.captureCharFrame().split("\n").map((line) => line.slice(0, 34)).join("\n")).toContain("Long session 39");
    app.resize(60, 12);
    await app.renderOnce();

    // The optional inspector yields space while tree and central selection remain usable.
    expect(app.captureCharFrame()).not.toContain("Inspector");
    expect(app.selection.sessionId).toBe("long-39");
  } finally { await app.close(); }
});

test("위쪽 화살표로 세션과 워크트리 행을 지나 이전 워크트리로 돌아갈 수 있다", async () => {
  // B has one session; selecting its parent restores that session.
  const app = await mount();
  try {
    await app.clickText("Sidebar prototype");

    // The navigation cursor must not get trapped by the restored child selection.
    app.mockInput.pressArrow("up");
    app.mockInput.pressArrow("up");
    await app.renderOnce();

    // Moving beyond B's parent reaches A's last displayed session.
    expect(app.selection.worktree?.id).toBe("demo:main");
    expect(app.selection.sessionId).toBe("a3");
  } finally { await app.close(); }
});

test("Tab과 Shift+Tab은 표시된 입력 대상 사이에서 포커스를 이동한다", async () => {
  // The tree is the initial focus target in the workspace sidebar.
  const app = await mount();
  try {
    const first = app.renderer.currentFocusedRenderable;

    // Focus cycling is explicit because Core has no automatic Tab traversal.
    app.mockInput.pressTab();
    const next = app.renderer.currentFocusedRenderable;
    app.mockInput.pressTab({ shift: true });

    // Keyboard-only navigation returns to the initial target without losing selection.
    expect(next).not.toBe(first);
    expect(app.renderer.currentFocusedRenderable).toBe(first);
    expect(app.selection.sessionId).toBe("a1");
  } finally { await app.close(); }
});
