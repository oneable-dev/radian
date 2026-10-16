import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { HistoryItem } from "../../agents/history.ts";
import type { ExecutionState } from "../../agents/session-registry.ts";
import { ok } from "../../result.ts";

const saved = (id: string, unavailableReason: string | null = null): HistoryItem => ({ id, title: id, worktreeId: "demo:main",
  modified: "2026-10-15T00:00:00.000Z", messageCount: 1, openSessionId: null, unavailableReason });

async function mount(list: () => Promise<readonly HistoryItem[]> = async () => []) {
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
  const initialFocusListeners = app.renderer.listenerCount("focused_renderable");
  const selection = new WorkspaceSelection(demoWorkspace());
  let status: ExecutionState["status"] = "complete";
  const calls: string[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession: () => { calls.push("create"); }, onCloseSession: () => { calls.push("close"); },
    onPrompt: (_id, text) => { calls.push(`prompt:${text}`); return ok(undefined); },
    getSessionDetails: () => ({ status, output: "Transcript", error: null }),
    onListHistory: async () => ok(await list()),
    onResumeSession: async (_tree, id) => { calls.push(`resume:${id}`); return ok("a1"); },
  });
  await app.renderOnce();
  return { ...app, selection, calls, view, initialFocusListeners,
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

test("기본 화면은 고정 범례나 안내 행 없이 푸터 바로 위까지 본문을 사용한다", async () => {
  // The normal screen should spend its vertical space on work, not permanent help text.
  const app = await mount();
  try {
    const footer = app.renderer.root.findDescendantById("footer-bar")!;
    const panel = app.renderer.root.findDescendantById("work-panel")!;

    // Rendering an idle screen requires only the identity and contextual shortcut row.
    expect(app.renderer.root.findDescendantById("app-footer")?.height).toBe(1);
    expect(app.renderer.root.findDescendantById("footer-notice")?.visible).toBe(false);
    expect(panel.y + panel.height).toBe(footer.y);
    expect(app.captureCharFrame()).not.toContain("Status not supplied");
    expect(app.captureCharFrame()).not.toContain("UI preview only");
    expect(app.footerLine()).toContain("Radian 0.0.0");
    expect(app.calls).toEqual([]);
  } finally { await app.close(); }
});

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
    await app.click("Workspace"); app.mockInput.pressTab(); app.mockInput.pressEnter(); await app.renderOnce();
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
  // Busy input uses the same submission path, with a Queue hint instead of Run.
  const app = await mount();
  try {
    app.mockInput.pressKey("e", { ctrl: true }); await app.renderOnce();
    expect(app.footerLine()).toContain("Esc Workspace");
    expect(app.footerLine()).not.toContain("Enter Run");
    await app.mockInput.typeText("hello"); await app.renderOnce();
    expect(app.footerLine()).toContain("Enter Run");

    app.setStatus("working"); await app.renderOnce();
    expect(app.footerLine()).toContain("Enter Queue");
    app.mockInput.pressEnter(); await app.renderOnce();

    expect(app.calls).toEqual(["prompt:hello"]);
    expect(app.footerLine()).toContain("Esc Workspace");
    expect(app.view.promptDrafts.a1).toBeUndefined();
    expect(app.selection.sessionId).toBe("a1");
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

    expect(app.footerLine()).toContain("Radian 0.0.0");
    expect(app.captureCharFrame().split("\n")[10]).toContain("Runtime reconnecting");
    expect(app.captureCharFrame()).not.toContain("Inspector");
    expect(app.renderer.currentFocusedRenderable).toBe(focus);
    expect(app.selection.sessionId).toBe("a1");
    expect(app.calls).toEqual([]);
    app.resize(120, 24); await app.renderOnce();
    expect(app.footerLine()).toContain("x Close session");
  } finally { await app.close(); }
});

test("일반 화면의 넉넉한 여백은 좁은 화면에서 줄어들고 복원 시 초안과 함께 돌아온다", async () => {
  // Content and branding share a two-cell inset, without moving the gradient away from the edge.
  const app = await mount();
  const sidebar = app.renderer.root.findDescendantById("workspace-sidebar")!;
  const search = app.renderer.root.findDescendantById("workspace-search")!;
  const transcript = app.renderer.root.findDescendantById("session-transcript")!;
  const composer = app.renderer.root.findDescendantById("agent-composer")!;
  const prompt = app.renderer.root.findDescendantById("session-prompt")!;
  try {
    expect(search.x - sidebar.x).toBe(2);
    expect(transcript.x - sidebar.x - sidebar.width).toBe(2);
    expect(prompt.x - composer.x).toBe(5);
    expect(app.footerLine().indexOf("Radian")).toBe(2);

    // Shrinking the real renderer reduces insets rather than clipping the active input.
    app.mockInput.pressKey("e", { ctrl: true }); await app.mockInput.typeText("keep this draft");
    app.resize(60, 12); await app.renderOnce();

    expect(search.x - sidebar.x).toBe(1);
    expect(transcript.x - sidebar.x - sidebar.width).toBe(1);
    expect(prompt.x - composer.x).toBe(4);
    expect(app.footerLine().indexOf("Radian")).toBe(1);
    expect(app.renderer.currentFocusedRenderable).toBe(prompt);

    // The normal spacing returns without rebuilding the Agent or replacing its draft.
    app.resize(120, 24); await app.renderOnce();

    expect(search.x - sidebar.x).toBe(2);
    expect(transcript.x - sidebar.x - sidebar.width).toBe(2);
    expect(prompt.x - composer.x).toBe(5);
    expect(app.footerLine().indexOf("Radian")).toBe(2);
    expect(app.view.promptDrafts.a1).toBe("keep this draft");
    expect(app.calls).toEqual([]);
  } finally { await app.close(); }
});

test("낮은 터미널에서도 Agent 상태와 입력창은 한 줄 푸터를 침범하지 않는다", async () => {
  // A short screen must surrender decorative spacing before hiding usable input or footer rows.
  const app = await mount();
  try {
    app.mockInput.pressKey("e", { ctrl: true }); await app.mockInput.typeText("compact draft");

    // Resizing while typing must preserve the active draft and fit every control above the footer.
    app.resize(60, 12); await app.renderOnce();
    const composer = app.renderer.root.findDescendantById("agent-composer")!;
    const prompt = app.renderer.root.findDescendantById("session-prompt")!;
    const footer = app.renderer.root.findDescendantById("footer-bar")!;

    expect(composer.height).toBe(1);
    const status = app.renderer.root.findDescendantById("session-status")!;
    expect(status.y + status.height).toBe(composer.y);
    expect(status.y + status.height).toBeLessThanOrEqual(footer.y);
    expect(app.captureCharFrame().split("\n")[status.y]).toContain("context");
    expect(app.captureCharFrame().split("\n")[status.y]).toContain("weekly");
    expect(prompt.y + prompt.height).toBeLessThanOrEqual(footer.y);
    expect(app.captureCharFrame().split("\n")[prompt.y]).toContain("compact draft");
    expect(app.captureCharFrame()).not.toContain("Status not supplied");
    expect(app.footerLine().trimStart()).toStartWith("Radian 0.0.0");
    expect(app.selection.sessionId).toBe("a1");
    expect(app.renderer.currentFocusedRenderable).toBe(prompt);

    // Returning to a normal screen restores the padded input without losing its state.
    app.resize(120, 24); await app.renderOnce();
    expect(composer.height).toBe(3);
    expect(app.view.promptDrafts.a1).toBe("compact draft");
    expect(app.calls).toEqual([]);
  } finally { await app.close(); }
});

test("포커스를 해제하거나 화면을 제거하면 오래된 단축키와 포커스 구독을 남기지 않는다", async () => {
  // Footer integration must not keep listeners alive after the view has been disposed.
  const app = await mount();
  try {
    app.renderer.currentFocusedRenderable?.blur(); await app.renderOnce();
    expect(app.footerLine().trim()).toBe("Radian 0.0.0");
    app.view.dispose();

    expect(app.renderer.listenerCount("focused_renderable")).toBe(app.initialFocusListeners);
    app.view.setNotice("Late update"); await app.renderOnce();
    expect(app.captureCharFrame()).not.toContain("Late update");
  } finally { await app.close(); }
});
