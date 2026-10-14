import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { demoWorkspace } from "../workspace/demo.ts";
import { WorkspaceSelection } from "../workspace/selection.ts";
import type { HistoryItem } from "../sessions/history.ts";
import { WorkspaceView } from "./workspace.ts";

const saved = (id: string, title: string, tree = "demo:main"): HistoryItem => ({
  id, title, worktreeId: tree, modified: "2026-10-14T12:34:00.000Z", messageCount: 4, openSessionId: null, unavailableReason: null,
});
async function mount(list: (id: string) => Promise<readonly HistoryItem[]>, resume: (id: string, savedId: string) => Promise<string> = async () => "a2") {
  const setup = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace());
  const resumed: string[] = [];
  const view = new WorkspaceView(setup.renderer, selection, {
    onNewSession: () => {}, onCloseSession: () => {}, onListHistory: list,
    onResumeSession: async (tree, id) => { resumed.push(`${tree}/${id}`); return resume(tree, id); },
  });
  await setup.renderOnce();
  return { ...setup, selection, resumed, view,
    async click(text: string) {
      const lines = setup.captureCharFrame().split("\n"); const y = lines.findIndex((line) => line.includes(text));
      const x = lines[y]?.indexOf(text) ?? -1;
      if (x < 0 || y < 0) throw new Error(`Missing text ${text}\n${setup.captureCharFrame()}`);
      await setup.mockMouse.click(x, y); await setup.renderOnce();
    },
    async visible(text: string) {
      const deadline = Date.now() + 3000;
      while (!setup.captureCharFrame().includes(text)) {
        if (Date.now() > deadline) throw new Error(`Missing rendered state: ${text}\n${setup.captureCharFrame()}`);
        await setup.renderOnce();
      }
    },
    async disposeApp() { view.dispose(); await setup.dispose(); },
  };
}

test("History를 열면 저장 제목·활동 시간·메시지 수를 표시하지만 아직 resume하지 않는다", async () => {
  // Listing is a separate read-only operation from selecting a saved conversation.
  const app = await mount(async () => [saved("saved-a", "Saved layout review")]);
  try {
    // Open the tab without touching the selected live session.
    await app.click("History"); await app.visible("Saved layout review");

    // The active worktree scope and SDK metadata are visible; selection and execution stay unchanged.
    expect(app.captureCharFrame()).toContain("History · radian");
    expect(app.captureCharFrame()).toContain("2026-10-14 12:34");
    expect(app.captureCharFrame()).toContain("4 messages");
    expect(app.selection.sessionId).toBe("a1");
    expect(app.resumed).toEqual([]);
  } finally { await app.disposeApp(); }
});

test("저장 항목을 클릭하면 해당 기존 세션을 열고 워크스페이스 탭과 중앙 선택으로 이동한다", async () => {
  // The host returns an existing multiplexed item after opening the selected saved ID.
  const app = await mount(async () => [saved("saved-a", "Saved layout review")]);
  try {
    await app.click("History"); await app.visible("Saved layout review");

    // Mouse activation, not history listing, makes the explicit resume request.
    await app.click("Saved layout review"); await app.visible("Session navigation");

    // The host ID is selected and the normal workspace hierarchy is shown again.
    expect(app.resumed).toEqual(["demo:main/saved-a"]);
    expect(app.selection.sessionId).toBe("a2");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-tree");
    expect(app.captureCharFrame()).not.toContain("Saved layout review");
  } finally { await app.disposeApp(); }
});

test("History 키보드 탐색은 Enter 전에는 live 선택을 바꾸지 않고 선택 항목만 resume한다", async () => {
  // The list cursor is independent of canonical workspace selection.
  const app = await mount(async () => [saved("first", "First saved"), saved("second", "Second saved")]);
  try {
    await app.click("History"); await app.visible("Second saved");
    app.mockInput.pressTab(); app.mockInput.pressTab();

    // Focus enters refresh/list targets; Down moves only the history cursor.
    expect(app.renderer.currentFocusedRenderable?.id).toBe("history-list");
    app.mockInput.pressArrow("down");
    expect(app.selection.sessionId).toBe("a1");
    app.mockInput.pressEnter(); await app.visible("Session navigation");

    // Enter opens the second saved ID, not the selected live session or the first history row.
    expect(app.resumed).toEqual(["demo:main/second"]);
    expect(app.selection.sessionId).toBe("a2");
  } finally { await app.disposeApp(); }
});

test("새 워크트리로 바뀐 뒤 늦게 온 이전 history 응답은 현재 목록을 덮어쓰지 않는다", async () => {
  // The old worktree's listing remains pending while the new worktree returns immediately.
  const old = Promise.withResolvers<readonly HistoryItem[]>();
  const app = await mount((id) => id === "demo:main" ? old.promise : Promise.resolve([saved("feature", "Feature saved", id)]));
  try {
    await app.click("History");

    // A host selection change updates the history scope without accepting the stale response.
    app.selection.selectWorktree("demo:feature"); await app.visible("Feature saved");
    old.resolve([saved("stale", "Stale main saved")]); await app.renderOnce();

    // The sidebar follows the latest worktree and no implicit resume occurs.
    expect(app.captureCharFrame()).toContain("Feature saved");
    expect(app.captureCharFrame()).not.toContain("Stale main saved");
    expect(app.resumed).toEqual([]);
  } finally { await app.disposeApp(); }
});

test("empty와 조회 오류를 구분하고 Refresh로 재조회해도 새 세션을 만들지 않는다", async () => {
  // First load fails; refreshing succeeds with an empty history.
  let calls = 0;
  const app = await mount(async () => { if (++calls === 1) throw new Error("listing unavailable"); return []; });
  try {
    await app.click("History"); await app.visible("History error:");

    // Explicit refresh retries metadata discovery, not session creation or model execution.
    await app.click("Refresh history"); await app.visible("No saved sessions");

    // The failure was not hidden as empty, and the current selection remains intact.
    expect(calls).toBe(2);
    expect(app.resumed).toEqual([]);
    expect(app.selection.sessionId).toBe("a1");
  } finally { await app.disposeApp(); }
});

test("busy 기록과 resume 실패는 history에서 설명하고 열린 선택을 조작하지 않는다", async () => {
  // A live writer blocks one saved context; another resume operation reports a host error.
  const app = await mount(async () => [
    { ...saved("busy", "Busy saved"), unavailableReason: "Session is still closing." }, saved("broken", "Broken saved"),
  ], async () => { throw new Error("Cannot resume saved session"); });
  try {
    await app.click("History"); await app.visible("Busy saved");

    // Busy activation does not cross the resume boundary; another error stays on the history tab.
    await app.click("Busy saved"); expect(app.resumed).toEqual([]);
    await app.click("Broken saved"); await app.visible("Resume error:");

    // No placeholder session or false success replaces the selected live item.
    expect(app.selection.sessionId).toBe("a1");
    expect(app.resumed).toEqual(["demo:main/broken"]);
  } finally { await app.disposeApp(); }
});

test("history 조회 도중 화면이 제거돼도 늦은 응답은 파괴된 renderable에 쓰지 않는다", async () => {
  // Detached UI teardown must not leave async render writes or a resume operation behind.
  const pending = Promise.withResolvers<readonly HistoryItem[]>();
  const app = await mount(() => pending.promise);
  try {
    await app.click("History");

    // Complete the outstanding request after disposing the UI component.
    app.view.dispose(); pending.resolve([saved("late", "Late saved")]); await app.renderOnce();

    // The removed view stays absent and no execution is opened on behalf of the late result.
    expect(app.captureCharFrame()).not.toContain("Late saved");
    expect(app.resumed).toEqual([]);
  } finally { await app.disposeApp(); }
});
