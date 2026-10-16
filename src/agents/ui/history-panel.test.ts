import { expect, spyOn, test } from "bun:test";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { demoWorkspace } from "../../workspace/demo.ts";
import { WorkspaceSelection } from "../../app/workspace-selection.ts";
import type { HistoryItem } from "../history.ts";
import { Workbench } from "../../app/ui/workbench.ts";
import { capture, ConnectionError, HistoryError } from "../../errors.ts";
import { parseKeymap, type Keymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";

const saved = (id: string, title: string, tree = "demo:main"): HistoryItem => ({
  id, title, worktreeId: tree, modified: "2026-10-14T12:34:00.000Z", messageCount: 4, openSessionId: null, unavailableReason: null,
});
async function mount(list: (id: string) => Promise<readonly HistoryItem[]>, resume: (id: string, savedId: string) => Promise<string> = async () => "a2", clock?: ManualClock, keymap?: Keymap) {
  const setup = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true, ...(clock ? { clock } : {}) });
  const selection = new WorkspaceSelection(demoWorkspace());
  const resumed: string[] = [];
  const view = new Workbench(setup.renderer, selection, {
    ...(keymap ? { keymap } : {}),
    onNewSession: () => {}, onCloseSession: () => {}, onListHistory: (id) => capture(() => list(id)),
    onResumeSession: async (tree, id) => { resumed.push(`${tree}/${id}`); return capture(() => resume(tree, id)); },
  });
  await setup.renderOnce();
  return { ...setup, selection, resumed, view,
    historyFrame() {
      const node = setup.renderer.root.findDescendantById("session-history")!;
      return setup.captureCharFrame().split("\n").slice(node.y, node.y + node.height)
        .map((line) => line.slice(node.x, node.x + node.width)).join("\n");
    },
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

test("History 조회가 즉시 끝나도 목록은 바로 표시하고 스피너는 500ms 동안 유지한다", async () => {
  // Minimum spinner visibility must not add artificial latency to the actual history result.
  const clock = new ManualClock();
  const app = await mount(async () => [saved("fast", "Fast history")], undefined, clock);
  try {
    await app.click("History"); await app.visible("Fast history");

    // Fast results are already usable while the visual indicator finishes its minimum interval.
    expect(app.captureCharFrame()).toMatch(/History · radian\s+⠋/);
    clock.advance(499); await app.renderOnce();
    expect(app.captureCharFrame()).toMatch(/History · radian\s+[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    clock.advance(1); await app.renderOnce();

    // Other panes may legitimately animate their own running Agent status.
    expect(app.historyFrame()).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(app.captureCharFrame()).toContain("Fast history");
    expect(app.resumed).toEqual([]);
  } finally { await app.disposeApp(); }
});

test("조회 중 스피너는 History 제목 오른쪽에서 움직이고 완료되면 사라진다", async () => {
  // A pending read keeps loading visible without starting an agent or changing selection.
  const clock = new ManualClock();
  const pending = Promise.withResolvers<readonly HistoryItem[]>();
  const app = await mount(() => pending.promise, undefined, clock);
  try {
    await app.click("History");
    const heading = () => app.captureCharFrame().split("\n").find((line) => line.includes("History · radian"));

    // Loading occupies the heading's right side, not the list's message row, at both terminal widths.
    expect(heading()).toMatch(/History · radian\s+⠋/);
    expect(app.captureCharFrame()).not.toContain("Loading saved sessions");
    clock.advance(80); await app.renderOnce();
    expect(heading()).toMatch(/History · radian\s+⠙/);
    app.resize(60, 12); await app.renderOnce();
    expect(heading()).toMatch(/History · radian\s+⠙/);
    pending.resolve([]); await app.visible("No saved sessions");

    // Results arrive immediately; only the indicator waits for the remainder of its 500 ms minimum.
    expect(heading()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    clock.advance(420); await app.renderOnce();
    expect(heading()).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(app.selection.sessionId).toBe("a1");
    expect(app.resumed).toEqual([]);
  } finally { await app.disposeApp(); }
});

test("이전 조회 응답은 새 조회의 스피너를 끄지 않고 현재 오류 응답은 스피너를 종료한다", async () => {
  // Refresh can supersede an outstanding read; only the current generation owns loading state.
  const clock = new ManualClock();
  const first = Promise.withResolvers<readonly HistoryItem[]>();
  const second = Promise.withResolvers<readonly HistoryItem[]>();
  let calls = 0;
  const app = await mount(() => ++calls === 1 ? first.promise : second.promise, undefined, clock);
  try {
    await app.click("History"); await app.click("Refresh history");

    // A stale success must leave the current loading indicator running until its own response arrives.
    first.resolve([]); await app.renderOnce(); clock.advance(80); await app.renderOnce();
    expect(app.captureCharFrame()).toMatch(/History · radian\s+⠙/);
    second.reject(new HistoryError("HISTORY_UNAVAILABLE", "Lookup failed")); await app.visible("History error:");

    // Errors are not delayed, but the same minimum visibility applies to the loading indicator.
    expect(app.historyFrame()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    clock.advance(420); await app.renderOnce();
    expect(app.historyFrame()).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(app.captureCharFrame()).toContain("Lookup failed");
    expect(calls).toBe(2);
  } finally { await app.disposeApp(); }
});

test("커스텀 History 새로고침 키와 푸터를 유지하면서 새 조회의 스피너를 표시한다", async () => {
  const clock = new ManualClock();
  const pending = Promise.withResolvers<readonly HistoryItem[]>(); let calls = 0;
  const keymap = expectOk(parseKeymap({ bindings: { "history.refresh": [{ keys: "q", scope: "history" }] } }));
  const app = await mount(() => { calls++; return pending.promise; }, undefined, clock, keymap);
  try {
    await app.click("History"); app.mockInput.pressTab(); app.mockInput.pressTab(); await app.renderOnce();
    expect(app.captureCharFrame().split("\n")[23]).toContain("q Refresh");
    app.mockInput.pressKey("q"); app.mockInput.pressKey("r"); await app.renderOnce();
    expect(calls).toBe(2); expect(app.captureCharFrame()).toMatch(/History · radian\s+⠋/);
    pending.resolve([saved("latest", "Latest custom history")]); await app.visible("Latest custom history");
    clock.advance(500); await app.renderOnce();
    expect(app.historyFrame()).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  } finally { pending.resolve([]); await app.disposeApp(); }
});

test("History를 숨기거나 화면을 제거하면 진행 중인 스피너 타이머도 종료한다", async () => {
  // A slow request may outlive the panel, but its animation must not outlive the visible UI.
  const clock = new ManualClock();
  const pending = Promise.withResolvers<readonly HistoryItem[]>();
  const app = await mount(() => pending.promise, undefined, clock);
  const scheduled = spyOn(clock, "setInterval");
  const cleared = spyOn(clock, "clearInterval");
  const animationTimer = () => {
    const index = scheduled.mock.calls.findLastIndex(([, delay]) => delay === 80);
    const result = scheduled.mock.results[index];
    if (!result || result.type !== "return") throw new Error("Loading animation did not acquire a timer.");
    return result.value;
  };
  try {
    await app.click("History");
    const first = animationTimer();

    // Observe timer cancellation at the clock boundary, independent of renderer/input timeout counts.
    await app.click("Workspace");
    expect(cleared).toHaveBeenCalledWith(first);
    await app.click("History");
    const second = animationTimer();
    app.view.dispose();

    expect(second).not.toBe(first);
    expect(cleared).toHaveBeenCalledWith(second);
    pending.resolve([]); clock.advance(80); await app.renderOnce();
    expect(app.captureCharFrame()).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  } finally { await app.disposeApp(); scheduled.mockRestore(); cleared.mockRestore(); }
});

test("저장 항목을 클릭하면 해당 기존 세션을 열고 워크스페이스 탭과 중앙 선택으로 이동한다", async () => {
  // The host returns an existing multiplexed item after opening the selected saved ID.
  const app = await mount(async () => [saved("saved-a", "Saved layout review")]);
  try {
    await app.click("History"); await app.visible("Saved layout review");

    // Mouse activation, not history listing, makes the explicit resume request.
    await app.click("Saved layout review"); await app.waitFor(() => app.selection.sessionId === "a2");

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
    app.mockInput.pressEnter(); await app.waitFor(() => app.selection.sessionId === "a2");

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
  const app = await mount(async () => { if (++calls === 1) throw new HistoryError("HISTORY_UNAVAILABLE", "listing unavailable"); return []; });
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

test("연결 복구 알림은 보이는 History 오류를 새 목록으로 바꾸되 세션을 재실행하지 않는다", async () => {
  // History was requested while disconnected; the selected live item must remain untouched.
  let online = false;
  let calls = 0;
  const app = await mount(async () => {
    calls++;
    if (!online) throw new ConnectionError("CONNECTION_FAILED", "Disconnected");
    return [saved("saved-a", "Restored history")];
  });
  try {
    await app.click("Git"); await app.click("History"); await app.visible("History error:");

    // The host resets its connection notice and refreshes metadata after a fresh event snapshot.
    online = true; app.view.setNotice("Runtime connected"); app.view.refreshHistory(); await app.visible("Restored history");

    expect(app.captureCharFrame()).not.toContain("History error:");
    expect(app.captureCharFrame()).toContain("Git preview");
    expect(app.selection.sessionId).toBe("a1");
    expect(app.resumed).toEqual([]);
    expect(calls).toBe(2);
    await app.click("Workspace"); app.view.refreshHistory(); await app.renderOnce();
    expect(calls).toBe(2);
  } finally { await app.disposeApp(); }
});

test("busy 기록과 resume 실패는 history에서 설명하고 열린 선택을 조작하지 않는다", async () => {
  // A live writer blocks one saved context; another resume operation reports a host error.
  const app = await mount(async () => [
    { ...saved("busy", "Busy saved"), unavailableReason: "Session is still closing." }, saved("broken", "Broken saved"),
  ], async () => { throw new HistoryError("HISTORY_UNAVAILABLE", "Cannot resume saved session"); });
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
