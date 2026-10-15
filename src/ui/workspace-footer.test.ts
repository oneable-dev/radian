import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { WorkspaceView } from "./workspace.ts";
import { WorkspaceSelection } from "../workspace/selection.ts";
import { demoWorkspace } from "../workspace/demo.ts";
import type { HistoryItem } from "../sessions/history.ts";
import type { ExecutionState } from "../sessions/session-registry.ts";
import { ok } from "../result.ts";

const saved = (id: string, unavailableReason: string | null = null): HistoryItem => ({ id, title: id, worktreeId: "demo:main",
  modified: "2026-10-15T00:00:00.000Z", messageCount: 1, openSessionId: null, unavailableReason });

async function mount(list: () => Promise<readonly HistoryItem[]> = async () => []) {
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace());
  let status: ExecutionState["status"] = "complete";
  const calls: string[] = [];
  const view = new WorkspaceView(app.renderer, selection, {
    onNewSession: () => { calls.push("create"); }, onCloseSession: () => { calls.push("close"); },
    onPrompt: (_id, text) => { calls.push(`prompt:${text}`); },
    getSessionDetails: () => ({ status, output: "Transcript", error: null }),
    onListHistory: async () => ok(await list()),
    onResumeSession: async (_tree, id) => { calls.push(`resume:${id}`); return ok("a1"); },
  });
  await app.renderOnce();
  return { ...app, selection, calls, view,
    footerLine: () => app.captureCharFrame().split("\n")[app.renderer.height - 1]!,
    setStatus(next: ExecutionState["status"]) { status = next; selection.replaceSnapshot(selection.snapshot); },
    async click(text: string) {
      const lines = app.captureCharFrame().split("\n"); const y = lines.findIndex((line) => line.includes(text));
      const x = lines[y]?.indexOf(text) ?? -1;
      if (x < 0) throw new Error(`Missing ${text}\n${app.captureCharFrame()}`);
      await app.mockMouse.click(x, y); await app.renderOnce();
    },
    async visible(text: string) {
      const deadline = Date.now() + 3000;
      while (!app.captureCharFrame().includes(text)) {
        if (Date.now() > deadline) throw new Error(`Missing ${text}\n${app.captureCharFrame()}`);
        await app.renderOnce();
      }
    },
    async close() { view.dispose(); await app.dispose(); },
  };
}

test("트리에서 검색창으로 포커스를 옮기면 해당 영역의 단축키만 바뀌고 실제 입력은 유지한다", async () => {
  // Context comes from actual renderer focus, including existing global focus shortcuts.
  const app = await mount();
  try {
    expect(app.footerLine()).toContain("n New session");
    expect(app.footerLine()).toContain("x Close session");
    expect(app.footerLine()).not.toContain("Ctrl+");

    app.mockInput.pressKey("f", { ctrl: true }); await app.renderOnce();
    await app.mockInput.typeText("nxq"); await app.renderOnce();

    expect(app.footerLine()).toContain("Enter Results");
    expect(app.footerLine()).toContain("Esc Clear");
    expect(app.footerLine()).not.toContain("New session");
    expect(app.calls).toEqual([]);
    app.mockInput.pressEscape(); app.mockInput.pressEnter(); await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-tree");
    expect(app.footerLine()).toContain("n New session");
  } finally { await app.close(); }
});

test("History 버튼·조회 중 목록·사용 가능한 기록에 따라 표시되는 키가 달라진다", async () => {
  // Metadata arrives after focus reaches the list; this is not a new model/session action.
  const pending = Promise.withResolvers<readonly HistoryItem[]>();
  const app = await mount(() => pending.promise);
  try {
    await app.click("Workspace History"); app.mockInput.pressTab(); app.mockInput.pressEnter(); await app.renderOnce();
    expect(app.footerLine()).toContain("Enter/Space Open History");
    app.mockInput.pressTab(); await app.renderOnce();
    expect(app.footerLine()).toContain("Enter/Space Refresh history");
    app.mockInput.pressTab(); await app.renderOnce();
    expect(app.footerLine()).toContain("r Refresh");
    expect(app.footerLine()).not.toContain("Enter Open");

    pending.resolve([saved("Available saved"), saved("Busy saved", "Still closing")]); await app.visible("Available saved");

    expect(app.footerLine()).toContain("Enter Open");
    expect(app.footerLine()).toContain("↑/↓ Select");
    expect(app.footerLine()).not.toContain("New session");
    app.mockInput.pressArrow("down"); await app.renderOnce();
    expect(app.footerLine()).not.toContain("Enter Open");
    app.mockInput.pressEnter(); await app.renderOnce();
    expect(app.calls).toEqual([]);
    expect(app.captureCharFrame()).toContain("Still closing");
  } finally { await app.close(); }
});

test("프롬프트의 실행 가능 여부와 별도 오류 알림은 단축키 안내·초안·선택을 보존한다", async () => {
  // A busy execution retains its draft instead of accepting another prompt.
  const app = await mount();
  try {
    app.mockInput.pressKey("e", { ctrl: true }); await app.renderOnce();
    expect(app.footerLine()).toContain("Esc Workspace");
    expect(app.footerLine()).not.toContain("Enter Run");
    await app.mockInput.typeText("hello"); await app.renderOnce();
    expect(app.footerLine()).toContain("Enter Run");

    app.setStatus("working"); await app.renderOnce(); app.mockInput.pressEnter(); await app.renderOnce();

    expect(app.calls).toEqual([]);
    expect(app.footerLine()).toContain("Esc Workspace");
    expect(app.footerLine()).not.toContain("Enter Run");
    expect(app.captureCharFrame().split("\n")[22]).toContain("already running");
    expect(app.view.promptDrafts.a1).toBe("hello");
    expect(app.selection.sessionId).toBe("a1");
    app.setStatus("complete"); await app.renderOnce(); app.mockInput.pressEnter(); await app.renderOnce();
    expect(app.calls).toEqual(["prompt:hello"]);
    expect(app.footerLine()).not.toContain("Enter Run");
  } finally { await app.close(); }
});

test("패널이 숨겨지는 좁은 화면에서도 푸터와 알림은 하단에 남고 클릭은 선택을 바꾸지 않는다", async () => {
  // Responsive layout may hide the inspector, but the common footer remains outside every panel.
  const app = await mount();
  try {
    const focus = app.renderer.currentFocusedRenderable;
    app.view.setNotice("Runtime reconnecting"); app.resize(60, 12); await app.renderOnce();

    await app.mockMouse.click(2, 11); await app.renderOnce();

    expect(app.footerLine()).toContain("radian 0.0.0");
    expect(app.captureCharFrame().split("\n")[10]).toContain("Runtime reconnecting");
    expect(app.captureCharFrame()).not.toContain("Inspector");
    expect(app.renderer.currentFocusedRenderable).toBe(focus);
    expect(app.selection.sessionId).toBe("a1");
    expect(app.calls).toEqual([]);
    app.resize(120, 24); await app.renderOnce();
    expect(app.footerLine()).toContain("x Close session");
  } finally { await app.close(); }
});

test("포커스를 해제하거나 화면을 제거하면 오래된 단축키와 포커스 구독을 남기지 않는다", async () => {
  // Footer integration must not keep listeners alive after the view has been disposed.
  const app = await mount();
  try {
    app.renderer.currentFocusedRenderable?.blur(); await app.renderOnce();
    expect(app.footerLine().trim()).toBe("radian 0.0.0");
    const listeners = app.renderer.listenerCount("focused_renderable");

    app.view.dispose();

    expect(app.renderer.listenerCount("focused_renderable")).toBe(listeners - 1);
    app.view.setNotice("Late update"); await app.renderOnce();
    expect(app.captureCharFrame()).not.toContain("Late update");
  } finally { await app.close(); }
});
