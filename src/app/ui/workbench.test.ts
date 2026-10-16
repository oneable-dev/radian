import { expect, test } from "bun:test";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { Repository } from "../../workspace/model.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { workspaceIcons } from "./workspace-status.ts";
import { Workbench } from "./workbench.ts";

async function mount(repositories: readonly Repository[] = demoWorkspace(), options: { kittyKeyboard?: boolean; clock?: ManualClock } = {}) {
  // CSI-u makes Escape unambiguous; a separate legacy-clock test covers its timeout.
  const setup = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true, ...options });
  const selection = new WorkspaceSelection(repositories);
  const requests: string[] = [];
  const view = new Workbench(setup.renderer, selection, {
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
    treeFrame(): string {
      const tree = setup.renderer.root.findDescendantById("workspace-tree");
      if (!tree) throw new Error("Missing workspace viewport");
      return setup.captureCharFrame().split("\n").slice(tree.y, tree.y + tree.height)
        .map((line) => line.slice(tree.x, tree.x + tree.width)).join("\n");
    },
    async searchFor(query: string): Promise<void> {
      setup.mockInput.pressKey("f", { ctrl: true });
      setup.mockInput.pressEscape();
      await setup.renderOnce();
      await setup.mockInput.typeText(query);
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
      id: `long-${index}`, name: `Long session ${index}`, status: null, subagents: [],
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

test("세션 집계와 subagent의 상태 아이콘을 종류 아이콘과 별도로 표시한다", async () => {
  // Main A1 is complete but its subagent is working; A2 completed and A3 failed.
  const app = await mount();
  try {
    // Paint normalized fixture data, not SDK events or live runs.
    const frame = app.captureCharFrame();

    // Repository/worktree icons remain type-specific; each agent row has its own outcome.
    expect(frame).toContain(`${workspaceIcons.repository} radian [demo]`);
    expect(frame).toContain(`${workspaceIcons.worktree} radian (main)`);
    expect(frame).toContain(`${workspaceIcons.working} Workspace layout`);
    expect(frame).toContain(`${workspaceIcons.working} UI review`);
    expect(frame).toContain(`${workspaceIcons.complete} Session navigation`);
    expect(frame).toContain(`${workspaceIcons.failure} Empty states`);
    expect(frame).toContain(`${workspaceIcons.unreported} Sidebar prototype`);
  } finally { await app.close(); }
});

test("트리가 숨겨진 동안 주입한 실패 상태도 다시 표시할 때 선택과 무관하게 반영한다", async () => {
  // B is selected while A1's working child is tracked in the display snapshot.
  const app = await mount();
  try {
    await app.clickText("Sidebar prototype");
    await app.clickText("History");

    // A host snapshot reports failure while the tree is not being painted.
    app.selection.replaceSnapshot(app.selection.snapshot.map((repo) => ({
      ...repo, worktrees: repo.worktrees.map((tree) => ({
        ...tree, sessions: tree.sessions.map((session) => session.id !== "a1" ? session : {
          ...session, subagents: session.subagents.map((agent) => ({ ...agent, status: "failure" as const })),
        }),
      })),
    })));
    await app.clickText("Workspace History");

    // The aggregate changes without selecting A or changing repository/worktree types.
    expect(app.selection.sessionId).toBe("b1");
    expect(app.captureCharFrame()).toContain(`${workspaceIcons.failure} Workspace layout`);
    expect(app.captureCharFrame()).toContain(`${workspaceIcons.worktree} radian (main)`);
    await app.clickText("radian (main)");
    expect(app.captureCharFrame()).toContain(`${workspaceIcons.failure} Workspace layout`);
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

test("검색창에 브랜치를 입력하면 제출 없이 하위 세션과 subagent를 즉시 표시한다", async () => {
  // The search starts empty and has no connection to an agent runtime.
  const app = await mount();
  try {
    const before = app.selection.snapshot;
    await app.clickText("Search repo/worktree/branch");
    const input = app.renderer.currentFocusedRenderable;

    // Mixed-case typing filters on INPUT, without Enter or blur.
    await app.mockInput.typeText("mAIN");
    await app.renderOnce();

    // Matching the branch keeps every child and the same focused input instance.
    expect(app.treeFrame()).toContain("Workspace layout");
    expect(app.treeFrame()).toContain("Session navigation");
    expect(app.treeFrame()).toContain("UI review");
    expect(app.treeFrame()).not.toContain("Sidebar prototype");
    expect(app.treeFrame()).not.toContain("radian-empty");
    expect(app.renderer.currentFocusedRenderable).toBe(input);
    expect(app.selection.snapshot).toBe(before);
  } finally { await app.close(); }
});

test("q・n・x를 검색에 입력해도 종료나 세션 액션을 실행하지 않고 Esc로 결과를 복원한다", async () => {
  // The original selection should remain on screen even if the query hides its row.
  const app = await mount();
  try {
    const before = app.selection.snapshot;

    // These characters are text while the field is focused, not global commands.
    await app.searchFor("querynx");
    const input = app.renderer.currentFocusedRenderable;
    expect(app.captureCharFrame()).toContain("No matching workspaces");
    expect(app.selection.sessionId).toBe("a1");
    expect(app.selection.snapshot).toBe(before);
    expect(app.requests).toEqual([]);
    app.mockInput.pressEscape();
    await app.renderOnce();

    // Clearing restores the tree without creating, closing or selecting another session.
    expect(app.treeFrame()).toContain("Sidebar prototype");
    expect(app.treeFrame()).toContain("UI review");
    expect(app.captureCharFrame()).not.toContain("No matching workspaces");
    expect(app.renderer.currentFocusedRenderable).toBe(input);
    expect(app.selection.sessionId).toBe("a1");
  } finally { await app.close(); }
});

test("검색어 삭제와 붙여넣기도 결과를 갱신하고 입력 포커스를 유지한다", async () => {
  // Adding a trailing character makes the main branch query miss.
  const app = await mount();
  try {
    await app.searchFor("mainx");
    const input = app.renderer.currentFocusedRenderable;
    expect(app.captureCharFrame()).toContain("No matching workspaces");

    // Backspace restores the branch match; pasted text is another live input change.
    app.mockInput.pressBackspace();
    await app.renderOnce();
    expect(app.treeFrame()).toContain("Workspace layout");
    app.mockInput.pressEscape();
    await app.renderOnce();
    await app.mockInput.pasteBracketedText("FEATURE/EMPTY");
    await app.renderOnce();

    // The empty worktree appears as a search result without becoming the selected workspace.
    expect(app.treeFrame()).toContain("radian-empty");
    expect(app.treeFrame()).not.toContain("Workspace layout");
    expect(app.renderer.currentFocusedRenderable).toBe(input);
    expect(app.selection.sessionId).toBe("a1");
  } finally { await app.close(); }
});

test("부분 일치 검색 후 키보드 탐색은 숨겨진 행 대신 표시된 결과만 선택한다", async () => {
  // The selected main session is hidden by a partial folder-name query.
  const app = await mount();
  try {
    await app.searchFor("IAN-UI");
    expect(app.selection.sessionId).toBe("a1");

    // Explicit navigation, not filtering itself, selects a result.
    app.mockInput.pressEnter();
    app.mockInput.pressKey("END");
    app.mockInput.pressArrow("up");
    app.mockInput.pressArrow("up");
    await app.renderOnce();

    // Traversing above the visible parent cannot reach the hidden main worktree.
    expect(app.selection.worktree?.id).toBe("demo:feature");
    expect(app.selection.sessionId).toBe("b1");
    expect(app.treeFrame()).toContain("Sidebar prototype");
    expect(app.treeFrame()).not.toContain("Workspace layout");
  } finally { await app.close(); }
});

test("필터가 적용된 트리에서 닫아도 원본 목록의 다음 세션을 선택한다", async () => {
  // The branch query keeps A1, A2 and A3 while another worktree remains hidden.
  const app = await mount();
  try {
    await app.searchFor("MAIN");

    // Only the explicit close command asks the demo host to remove display metadata.
    app.mockInput.pressEnter();
    app.mockInput.pressKey("x");
    await app.renderOnce();

    // Canonical fallback and filtering remain separate; B's hidden session is untouched.
    expect(app.selection.sessionId).toBe("a2");
    expect(app.treeFrame()).not.toContain("Workspace layout");
    expect(app.treeFrame()).toContain("Session navigation");
    expect(app.selection.snapshot.flatMap((repo) => repo.worktrees).find((tree) => tree.id === "demo:feature")?.sessions).toHaveLength(1);
  } finally { await app.close(); }
});

test("검색 중 주입한 snapshot은 현재 검색어로 갱신되고 숨겨진 상태는 해제 후 최신 값으로 표시한다", async () => {
  // A stays selected while the UI shows only B's matching worktree.
  const app = await mount();
  try {
    await app.searchFor("IAN-UI");
    const input = app.renderer.currentFocusedRenderable;

    // The host reports new visible metadata and a hidden child's failure; no SDK is involved.
    app.selection.replaceSnapshot(app.selection.snapshot.map((repo) => ({
      ...repo, worktrees: repo.worktrees.map((tree) => ({
        ...tree, sessions: tree.sessions.map((session) => {
          if (session.id === "a1") return {
            ...session, subagents: session.subagents.map((agent) => ({ ...agent, status: "failure" as const })),
          };
          if (session.id === "b1") return {
            ...session, subagents: [{ id: "fresh", name: "Fresh child", status: "working" as const }],
          };
          return session;
        }),
      })),
    })));
    await app.renderOnce();
    expect(app.treeFrame()).toContain("Fresh child");
    expect(app.treeFrame()).not.toContain("Workspace layout");
    app.mockInput.pressEscape();
    await app.renderOnce();

    // Clearing renders current aggregate state without moving the selection or input focus.
    expect(app.treeFrame()).toContain(`${workspaceIcons.failure} Workspace layout`);
    expect(app.treeFrame()).toContain("Fresh child");
    expect(app.renderer.currentFocusedRenderable).toBe(input);
    expect(app.selection.sessionId).toBe("a1");
  } finally { await app.close(); }
});

test("레포명 검색은 모든 워크트리를 유지하고 Tab 복귀 후에도 검색어를 계속 편집한다", async () => {
  // A partial repository-name query matches the complete demo subtree.
  const app = await mount();
  try {
    await app.searchFor("DIAN [DE");
    const input = app.renderer.currentFocusedRenderable;
    expect(app.treeFrame()).toContain("radian-empty");
    expect(app.treeFrame()).toContain("UI review");
    expect(app.treeFrame()).toContain("Sidebar prototype");

    // Moving focus away and back must not recreate or reset the search field.
    app.mockInput.pressTab();
    app.mockInput.pressTab({ shift: true });
    await app.mockInput.typeText("X");
    await app.renderOnce();

    // Appending at the retained cursor changes the query, rather than replacing it.
    expect(app.captureCharFrame()).toContain("DIAN [DEX");
    expect(app.captureCharFrame()).toContain("No matching workspaces");
    expect(app.renderer.currentFocusedRenderable).toBe(input);
  } finally { await app.close(); }
});

test("레포가 없는 화면에서도 검색 및 초기화는 세션을 생성하지 않는다", async () => {
  // An empty source distinguishes missing repositories from a no-match projection.
  const app = await mount([]);
  try {
    expect(app.captureCharFrame()).toContain("No repositories");

    // Search and clear remain safe without any selectable tree row.
    await app.searchFor("missing");
    expect(app.captureCharFrame()).toContain("No matching workspaces");
    app.mockInput.pressEscape();
    await app.renderOnce();

    // The empty workspace is unchanged and no new-session request was emitted.
    expect(app.captureCharFrame()).toContain("No repositories");
    expect(app.selection.worktree).toBeNull();
    expect(app.selection.snapshot).toEqual([]);
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("작은 터미널로 크기를 바꿔도 검색어와 포커스를 유지하며 결과를 계속 편집한다", async () => {
  // The focused field contains a short branch query that fits both viewport widths.
  const app = await mount();
  try {
    await app.searchFor("MAIN");
    const input = app.renderer.currentFocusedRenderable;

    // Resize changes layout, not input identity or canonical selection.
    app.resize(60, 12);
    await app.renderOnce();
    app.mockInput.pressBackspace();
    await app.renderOnce();

    // The edited query still matches main and the optional inspector gives way to the UI.
    expect(app.captureCharFrame()).toContain("MAI");
    expect(app.treeFrame()).toContain("radian (main)");
    expect(app.captureCharFrame()).toContain("Workspace layout");
    expect(app.captureCharFrame()).not.toContain("Inspector");
    expect(app.renderer.currentFocusedRenderable).toBe(input);
    expect(app.selection.sessionId).toBe("a1");
  } finally { await app.close(); }
});

test("레거시 Esc의 20ms 구분 시간이 지나면 검색어가 지워지고 다음 입력의 첫 글자를 보존한다", async () => {
  // A bare Escape is ambiguous with Alt-key input until Core's parser timeout.
  const clock = new ManualClock();
  const app = await mount(demoWorkspace(), { kittyKeyboard: false, clock });
  try {
    app.mockInput.pressKey("f", { ctrl: true });
    await app.mockInput.typeText("missing");
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("No matching workspaces");

    // Advance the actual parser clock instead of sleeping or changing product behavior.
    app.mockInput.pressEscape();
    clock.advance(20);
    await app.renderOnce();
    expect(app.captureCharFrame()).not.toContain("No matching workspaces");
    await app.mockInput.typeText("MAIN");
    await app.renderOnce();

    // The next query is not interpreted as an Alt-prefixed character sequence.
    expect(app.captureCharFrame()).toContain("MAIN");
    expect(app.treeFrame()).toContain("Workspace layout");
    expect(app.treeFrame()).not.toContain("Sidebar prototype");
  } finally { await app.close(); }
});
