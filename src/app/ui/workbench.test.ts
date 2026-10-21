import { expect, test } from "bun:test";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { Repository } from "../../workspace/model.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { workspaceIcons } from "./workspace-status.ts";
import { icons, spinnerFrames } from "../../icons.ts";
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
    async openWorkspaces() { setup.mockInput.pressKey("f", { ctrl: true }); await setup.renderOnce(); },
    async openHistory() { setup.mockInput.pressKey(" ", { ctrl: true }); setup.mockInput.pressKey("h"); await setup.renderOnce(); },
    async clickText(text: string): Promise<void> {
      if (text.startsWith(icons.folder) || text === "radian-empty" || text.startsWith("Search")) {
        setup.mockInput.pressKey("f", { ctrl: true }); setup.mockInput.pressCtrlC(); await setup.renderOnce();
      } else if (setup.renderer.root.findDescendantById("workspace-picker")!.visible) { setup.mockInput.pressEscape(); await setup.renderOnce(); }
      const lines = setup.captureCharFrame().split("\n");
      const y = lines.findIndex((line) => line.includes(text));
      const x = lines[y]?.indexOf(text) ?? -1;
      if (x < 0 || y < 0) throw new Error(`Visible text not found: ${text}\n${setup.captureCharFrame()}`);
      await setup.mockMouse.click(x, y);
      await setup.renderOnce();
    },
    tabFrame(id: string): string {
      const tab = setup.renderer.root.findDescendantById(`session:${selection.worktree!.id}:${id}`)!;
      return setup.captureCharFrame().split("\n")[tab.y]!.slice(tab.x, tab.x + tab.width);
    },
    treeFrame(): string {
      const tree = setup.renderer.root.findDescendantById("workspace-tree");
      if (!tree) throw new Error("Missing workspace viewport");
      return setup.captureCharFrame().split("\n").slice(tree.y, tree.y + tree.height)
        .map((line) => line.slice(tree.x, tree.x + tree.width)).join("\n");
    },
    async searchFor(query: string): Promise<void> {
      setup.mockInput.pressKey("f", { ctrl: true });
      setup.mockInput.pressCtrlC();
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
    await app.clickText("a2");
    await app.clickText(`${icons.folder} radian-ui`);
    await app.clickText(`${icons.folder} radian`);

    // The central panel reflects restored A2, without replacing source metadata.
    expect(app.selection.sessionId).toBe("a2");
    expect(app.tabFrame("a2")).toContain("a2");
  } finally { await app.close(); }
});

test("닫기 키는 끝 항목의 이전 세션을 선택하고 마지막 항목에서는 빈 화면을 표시한다", async () => {
  // The close callback reports metadata removal, not a real agent shutdown.
  const app = await mount();
  try {
    // Select the last item and close each surviving selected item.
    app.renderer.root.findDescendantById("agent-session-list")!.focus();
    app.mockInput.pressKey("END");
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
    expect(app.captureCharFrame()).toContain("No AI sessions");
    expect(app.renderer.root.findDescendantById("agent-session-list")!.visible).toBe(true);
    expect(app.captureCharFrame().split("\n")[23]).toContain("Ctrl+Space → n New session");
  } finally { await app.close(); }
});

test("행의 닫기 액션은 부모 세션을 잘못 선택하지 않는다", async () => {
  // A2 is selected; the close control belongs to the preceding A1 row.
  const app = await mount();
  try {
    await app.clickText("a2");
    const close = app.renderer.root.findDescendantById("close-session:a1");
    if (!close) throw new Error("Missing session tab close control");

    // Activate A1's visible close control, rather than selecting A1's tab.
    await app.mockMouse.click(close.x, close.y);
    await app.renderOnce();

    // Event propagation leaves the existing A2 selection unchanged.
    expect(app.selection.sessionId).toBe("a2");
    expect(app.selection.worktree?.sessions.map((session) => session.id)).toEqual(["a2", "a3"]);
  } finally { await app.close(); }
});

test("빈 워크트리의 생성 명령은 요청만 보내며 선택이나 열린 목록을 조작하지 않는다", async () => {
  // No sessions exist in the empty worktree before the user requests creation.
  const app = await mount();
  try {
    await app.clickText("radian-empty");
    const before = app.selection.snapshot;

    // The action crosses the host callback boundary without implementing OA-5.
    app.renderer.root.findDescendantById("agent-session-list")!.focus();
    app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("n"); await app.renderOnce();

    // No runtime, automatic selection or placeholder session was manufactured.
    expect(app.requests).toEqual(["demo:empty"]);
    expect(app.selection.snapshot).toBe(before);
    expect(app.selection.sessionId).toBeNull();
    expect(app.captureCharFrame()).toContain("No AI sessions");
  } finally { await app.close(); }
});

test("History 팝업은 지원 없는 preview를 설명하고 선택을 유지한다", async () => {
  // Workspace A stays selected while the modal presents an unavailable history provider.
  const app = await mount();
  try {
    // Opening history overlays navigation without changing workspace state.
    await app.openHistory();

    // No history or resume operation is implied by the placeholder.
    expect(app.captureCharFrame()).toContain("Session history is unavailable in this preview.");
    expect(app.selection.sessionId).toBe("a1");
  } finally { await app.close(); }
});

test("세션 탭의 End는 화면 밖 세션을 표시하고 작은 터미널에서도 선택을 유지한다", async () => {
  // Long display-only data exceeds the viewport; no agent timers drive the UI.
  const fixture: Repository[] = [{ id: "long-repo", name: "long-repo", worktrees: [{
    id: "long-tree", path: "/demo/long", name: "long", branch: "main",
    sessions: Array.from({ length: 40 }, (_, index) => ({
      id: `long-${index}`, name: `Long session ${index}`, status: null, subagents: [],
    })),
  }] }];
  const app = await mount(fixture);
  try {
    // End is scoped to the horizontal session strip, not the left workspace tree.
    app.renderer.root.findDescendantById("agent-session-list")!.focus();
    app.mockInput.pressKey("END");
    await app.renderOnce(); await app.renderOnce();
    expect(app.selection.sessionId).toBe("long-39");
    expect(app.captureCharFrame()).toContain("long-39");
    expect(app.treeFrame()).not.toContain("long-39");
    app.resize(60, 12);
    await app.renderOnce(); await app.renderOnce();

    // Fixed-width tabs keep the selected ID and right-aligned close control inside the viewport.
    expect(app.tabFrame("long-39")).toBe(" long-39        × ");
    expect(app.captureCharFrame()).not.toContain("Inspector");
    expect(app.selection.sessionId).toBe("long-39");
  } finally { await app.close(); }
});

test("위쪽 화살표는 이전 워크트리를 가리키고 Enter를 눌러야 마지막 세션을 복원한다", async () => {
  const app = await mount();
  try {
    await app.clickText(`${icons.folder} radian-ui`);
    await app.openWorkspaces(); app.mockInput.pressTab();
    app.mockInput.pressArrow("up"); await app.renderOnce();
    expect(app.selection.worktree?.id).toBe("demo:feature");
    app.mockInput.pressEnter(); await app.renderOnce();

    expect(app.selection.worktree?.id).toBe("demo:main");
    expect(app.selection.sessionId).toBe("a1");
  } finally { await app.close(); }
});

test("종류 아이콘은 왼쪽에 두고 부모·자식의 합산 상태는 오른쪽 세션 탭에 표시한다", async () => {
  const app = await mount();
  try {
    await app.openWorkspaces();
    expect(app.treeFrame()).toContain(`${workspaceIcons.repository} radian [demo]`);
    expect(app.treeFrame()).toContain(`${workspaceIcons.worktree} radian`);
    expect(app.treeFrame()).toContain(`${icons.branch} main`);
    expect(app.treeFrame()).not.toContain("UI review");
    expect(spinnerFrames.some((frame) => app.tabFrame("a1").includes(frame))).toBe(true);
    await app.clickText("a2");
    expect(app.tabFrame("a2")).not.toContain(workspaceIcons.complete);
    app.renderer.root.findDescendantById("agent-session-list")!.focus(); app.mockInput.pressKey("END");
    await app.renderOnce(); await app.renderOnce();
    expect(app.tabFrame("a3")).toContain(workspaceIcons.failure);
    await app.clickText(`${icons.folder} radian-ui`);
    expect(app.tabFrame("b1")).toBe(" b1             × ");
  } finally { await app.close(); }
});

test("History 팝업 뒤에서 바뀐 실패 상태도 닫은 뒤 선택과 무관하게 반영한다", async () => {
  // B is selected while A1's working child is tracked in the display snapshot.
  const app = await mount();
  try {
    await app.clickText(`${icons.folder} radian-ui`);
    await app.openHistory();

    // A host snapshot reports failure while the tree is not being painted.
    app.selection.replaceSnapshot(app.selection.snapshot.map((repo) => ({
      ...repo, worktrees: repo.worktrees.map((tree) => ({
        ...tree, sessions: tree.sessions.map((session) => session.id !== "a1" ? session : {
          ...session, subagents: session.subagents.map((agent) => ({ ...agent, status: "failure" as const })),
        }),
      })),
    })));
    app.mockInput.pressEscape(); await app.renderOnce();

    // The aggregate changes without selecting A or changing repository/worktree types.
    expect(app.selection.sessionId).toBe("b1");
    await app.openWorkspaces();
    expect(app.treeFrame()).toContain(`${workspaceIcons.worktree} radian`);
    await app.clickText(`${icons.folder} radian`);
    expect(app.tabFrame("a1")).toContain(workspaceIcons.failure);
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

test("브랜치 검색은 워크트리 목록만 필터하고 오른쪽 세션과 입력 포커스를 유지한다", async () => {
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
    expect(app.treeFrame()).toContain(`${icons.branch} main`);
    expect(app.treeFrame()).not.toContain("Workspace layout");
    expect(app.treeFrame()).not.toContain("UI review");
    expect(app.captureCharFrame()).toContain("a2");
    expect(app.treeFrame()).not.toContain("Sidebar prototype");
    expect(app.treeFrame()).not.toContain("radian-empty");
    expect(app.renderer.currentFocusedRenderable).toBe(input);
    expect(app.selection.snapshot).toBe(before);
  } finally { await app.close(); }
});

test("q・n・x를 검색에 입력해도 종료나 세션 액션을 실행하지 않고 Ctrl+C로 결과를 복원한다", async () => {
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
    app.mockInput.pressCtrlC();
    await app.renderOnce();

    // Clearing restores the tree without creating, closing or selecting another session.
    expect(app.treeFrame()).toContain(`${icons.folder} radian-ui`);
    expect(app.treeFrame()).not.toContain("UI review");
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
    expect(app.treeFrame()).toContain(`${icons.branch} main`);
    app.mockInput.pressCtrlC();
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

    // Tab moves to candidates; Enter alone commits a workspace.
    app.mockInput.pressTab();
    app.mockInput.pressKey("END");
    app.mockInput.pressArrow("up");
    app.mockInput.pressArrow("up");
    await app.renderOnce();

    // Navigation does not commit selection, even when only one result remains.
    expect(app.selection.worktree?.id).toBe("demo:main");
    app.mockInput.pressEnter(); await app.renderOnce();
    expect(app.selection.worktree?.id).toBe("demo:feature");
    expect(app.selection.sessionId).toBe("b1");
    await app.openWorkspaces();
    expect(app.treeFrame()).toContain(`${icons.branch} feature/workspace`);
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
    app.renderer.root.findDescendantById("agent-session-list")!.focus();
    app.mockInput.pressKey("x");
    await app.renderOnce();

    // Canonical fallback and filtering remain separate; B's hidden session is untouched.
    expect(app.selection.sessionId).toBe("a2");
    expect(app.treeFrame()).not.toContain("Workspace layout");
    expect(app.captureCharFrame()).toContain("a2");
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
    expect(app.treeFrame()).toContain(`${icons.branch} feature/workspace`);
    expect(app.treeFrame()).not.toContain("Fresh child");
    expect(app.treeFrame()).not.toContain("Workspace layout");
    app.mockInput.pressCtrlC();
    await app.renderOnce();

    // Clearing renders current aggregate state without moving the selection or input focus.
    expect(app.tabFrame("a1")).toContain(workspaceIcons.failure);
    expect(app.treeFrame()).toContain(`${icons.branch} feature/workspace`);
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
    expect(app.treeFrame()).toContain(`${icons.branch} main`);
    expect(app.treeFrame()).toContain(`${icons.branch} feature/workspace`);

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
    await app.openWorkspaces(); expect(app.captureCharFrame()).toContain("No repositories");

    // Search and clear remain safe without any selectable tree row.
    await app.searchFor("missing");
    expect(app.captureCharFrame()).toContain("No matching workspaces");
    app.mockInput.pressCtrlC();
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
    expect(app.treeFrame()).toContain(`${icons.branch} main`);
    expect(app.renderer.root.findDescendantById("agent-session-tabs")?.visible).toBe(true);
    expect(app.captureCharFrame()).not.toContain("Inspector");
    expect(app.renderer.currentFocusedRenderable).toBe(input);
    expect(app.selection.sessionId).toBe("a1");
  } finally { await app.close(); }
});

test("레거시 Esc의 20ms 구분 시간이 지나면 팝업을 닫고 다시 연 입력의 첫 글자를 보존한다", async () => {
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
    await app.openWorkspaces(); app.mockInput.pressCtrlC();
    await app.mockInput.typeText("MAIN");
    await app.renderOnce();

    // The next query is not interpreted as an Alt-prefixed character sequence.
    expect(app.captureCharFrame()).toContain("MAIN");
    expect(app.treeFrame()).toContain(`${icons.branch} main`);
    expect(app.treeFrame()).not.toContain(`${icons.folder} radian-ui`);
  } finally { await app.close(); }
});
