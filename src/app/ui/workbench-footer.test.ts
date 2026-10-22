import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { HistoryItem } from "../../agents/history.ts";
import type { ExecutionState } from "../../agents/session-registry.ts";
import { ok } from "../../result.ts";

const saved = (id: string, unavailableReason: string | null = null): HistoryItem => ({ id, title: id, worktreeId: "demo:main",
  modified: "2026-10-15T00:00:00.000Z", messageCount: 1, openSessionId: null, unavailableReason });

async function mount(list: () => Promise<readonly HistoryItem[]> = async () => [], actions: Partial<WorkbenchActions> = {}) {
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
    ...actions,
  });
  await app.renderOnce();
  return { ...app, selection, calls, view, initialFocusListeners,
    footerLine: () => app.captureCharFrame().split("\n")[app.renderer.height - 1]!,
    setStatus(next: ExecutionState["status"]) { status = next; selection.replaceSnapshot(selection.snapshot); },
    async openHistory() { app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("h"); await app.renderOnce(); },
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
    const footer = app.renderer.root.findDescendantById("app-footer")!;
    const panel = app.renderer.root.findDescendantById("work-panel")!;

    // The normal footer reserves only its text row, returning the former decoration row to work.
    expect(footer.height).toBe(1);
    expect(footer.y).toBe(23);
    expect(app.captureCharFrame()).not.toContain("▂");
    expect(app.renderer.root.findDescendantById("footer-notice")?.visible).toBe(false);
    expect(panel.y + panel.height).toBe(footer.y);
    expect(app.captureCharFrame()).not.toContain("Status not supplied");
    expect(app.captureCharFrame()).not.toContain("UI preview only");
    expect(app.footerLine()).toContain("Radian 0.0.0");
    expect(app.calls).toEqual([]);
  } finally { await app.close(); }
});

test.each([120, 60])("너비 %i의 프롬프트는 기본 조작 안내 없이도 줄바꿈·중단·전송을 유지한다", async width => {
  // 실제 중단 기능이 제공되는 실행에서도 푸터 폭과 무관하게 안내를 생략한다.
  let interruptions = 0;
  const app = await mount(undefined, { onInterrupt: async () => { interruptions++; return ok(undefined); } });
  try {
    app.resize(width, 24); app.mockInput.pressKey("e", { ctrl: true });
    await app.mockInput.typeText("first"); app.mockInput.pressEnter({ shift: true });
    await app.mockInput.typeText("second"); await app.renderOnce();

    // 기본 조작을 숨겨도 원래 입력 의미와 작업 중 전송 경로는 유지한다.
    for (const state of ["complete", "working"] as const) {
      app.setStatus(state); await app.renderOnce();
      expect(app.footerLine()).not.toMatch(/Run|Queue|New line|Interrupt|<C-[cnp]>/u);
      expect(app.footerLine()).toContain("<F1>");
      expect(app.view.promptDrafts.a1).toBe("first\nsecond");
    }
    app.mockInput.pressEscape(); await app.renderOnce();
    expect(interruptions).toBe(1); expect(app.view.promptDrafts.a1).toBe("first\nsecond");
    app.mockInput.pressEnter(); await app.waitFor(() => app.view.promptDrafts.a1 === undefined);

    // 중단은 초안을 보존하고 Enter 한 번만 실제 전송 요청을 만든다.
    expect(app.calls).toEqual(["prompt:first\nsecond"]);
  } finally { await app.close(); }
});

test("트리와 검색창은 기본 조작 안내를 생략해도 포커스 이동과 문자 입력을 유지한다", async () => {
  // 목록과 검색 사이를 오가도 숨긴 탐색 안내가 다시 나타나서는 안 된다.
  const app = await mount();
  try {
    app.mockInput.pressKey("f", { ctrl: true }); app.mockInput.pressTab(); await app.renderOnce();
    expect(app.footerLine()).not.toMatch(/<CR>|Navigate|½ page|Close|First\/last/u);
    expect(app.footerLine()).toContain("<F1> Help");

    app.mockInput.pressKey("f", { ctrl: true }); await app.renderOnce();
    await app.mockInput.typeText("nxq"); await app.renderOnce();

    expect(app.footerLine()).not.toMatch(/<CR>|<Esc>|<C-[np]>|Navigate/u);
    expect(app.footerLine()).not.toContain("New session");
    expect(app.calls).toEqual([]);
    app.mockInput.pressCtrlC(); app.mockInput.pressTab(); await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-tree");
    expect(app.footerLine()).toContain("<F1> Help");
  } finally { await app.close(); }
});

test("History는 기본 탐색 대신 Preview와 Refresh만 안내하고 조회와 선택은 유지한다", async () => {
  // 메타데이터가 늦게 도착해도 기본 열기·탐색 안내를 되살리지 않는다.
  const pending = Promise.withResolvers<readonly HistoryItem[]>();
  const app = await mount(() => pending.promise);
  try {
    await app.openHistory();
    expect(app.footerLine()).toContain("<C-r> Refresh");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("history-search");
    expect(app.footerLine()).not.toContain("<CR> Open");

    pending.resolve([saved("Available saved"), saved("Busy saved", "Still closing")]); await app.visible("Available saved");

    expect(app.footerLine()).toContain("<C-o> Preview");
    app.mockInput.pressTab(); await app.renderOnce();
    expect(app.footerLine()).not.toMatch(/<CR>|Previous|Next|½ page|<Esc>/u);
    expect(app.footerLine()).not.toContain("New session");
    app.mockInput.pressArrow("down"); await app.renderOnce();
    expect(app.footerLine()).not.toContain("<CR> Open");
    app.mockInput.pressEnter(); await app.renderOnce();
    expect(app.calls).toEqual([]);
    expect(app.captureCharFrame()).toContain("Still closing");
  } finally { await app.close(); }
});

test("프롬프트의 실행 가능 여부와 별도 오류 알림은 단축키 안내·초안·선택을 보존한다", async () => {
  // 전송 상태가 달라도 기본 초안 지우기는 생략하고 앱 고유 이동만 안내한다.
  const app = await mount();
  try {
    app.mockInput.pressKey("e", { ctrl: true }); await app.renderOnce();
    expect(app.footerLine()).toContain("<leader>b Workspace");
    expect(app.footerLine()).not.toContain("<CR> Run");
    await app.mockInput.typeText("hello"); await app.renderOnce();
    expect(app.footerLine()).not.toContain("<C-c> Clear");
    expect(app.footerLine()).not.toContain("<CR> Run");

    app.setStatus("working"); await app.renderOnce();
    expect(app.footerLine()).not.toMatch(/Run|Queue|New line|Interrupt/u);
    app.mockInput.pressEnter();
    await app.waitFor(() => app.view.promptDrafts.a1 === undefined); await app.renderOnce();

    expect(app.calls).toEqual(["prompt:hello"]);
    expect(app.footerLine()).toContain("<leader>b Workspace");
    expect(app.view.promptDrafts.a1).toBeUndefined();
    expect(app.selection.sessionId).toBe("a1");
    expect(app.footerLine()).not.toContain("<CR> Run");
  } finally { await app.close(); }
});

test("패널이 숨겨지는 좁은 화면에서도 푸터와 알림은 하단에 남고 클릭은 선택을 바꾸지 않는다", async () => {
  // Responsive layout may hide the inspector, but the common footer remains outside every panel.
  const app = await mount();
  try {
    const focus = app.renderer.currentFocusedRenderable;
    app.view.setNotice("Runtime reconnecting"); app.resize(60, 12); await app.renderOnce();

    await app.mockMouse.click(2, 11); await app.renderOnce();

    expect(app.footerLine()).toContain("Radian · Agents");
    expect(app.footerLine()).not.toContain("0.0.0");
    expect(app.captureCharFrame().split("\n")[10]).toContain("Runtime reconnecting");
    expect(app.captureCharFrame()).not.toContain("Inspector");
    expect(app.renderer.currentFocusedRenderable).toBe(focus);
    expect(app.selection.sessionId).toBe("a1");
    expect(app.calls).toEqual([]);
    app.resize(120, 24); await app.renderOnce();
    expect(app.footerLine()).toContain("<C-t> Transcript");
  } finally { await app.close(); }
});

test("프롬프트와 상태는 사이드바 공간 없이 전체 작업 영역의 왼쪽부터 배치한다", async () => {
  // Popup navigation must not reserve a divider cell or shrink Agent content.
  const app = await mount();
  try {
    for (const [width, height, inset] of [[120, 24, 2], [60, 12, 1], [79, 18, 1], [80, 17, 2], [120, 24, 2]] as const) {
      app.resize(width, height); await app.renderOnce();
      const composer = app.renderer.root.findDescendantById("agent-composer")!, prompt = app.renderer.root.findDescendantById("session-prompt")!;
      const panel = app.renderer.root.findDescendantById("work-panel")!, status = app.renderer.root.findDescendantById("session-status")!;

      expect(panel.x).toBe(0); expect(panel.width).toBe(width); expect(composer.x).toBe(panel.x); expect(prompt.x).toBe(composer.x + inset);
      expect(composer.y + composer.height).toBe(status.y); expect(status.y + status.height).toBe(panel.y + panel.height);
      expect(app.renderer.root.findDescendantById("workspace-picker")!.visible).toBe(false); expect(app.calls).toEqual([]);
    }
  } finally { await app.close(); }
});

test("일반 화면의 넉넉한 여백은 좁은 화면에서 줄어들고 복원 시 초안과 함께 돌아온다", async () => {
  // Content and branding share a two-cell inset, without moving the gradient away from the edge.
  const app = await mount();
  const transcript = app.renderer.root.findDescendantById("session-transcript")!;
  const composer = app.renderer.root.findDescendantById("agent-composer")!;
  const prompt = app.renderer.root.findDescendantById("session-prompt")!;
  try {
    expect(app.renderer.root.findDescendantById("workspace-picker")!.visible).toBe(false);
    expect(transcript.x).toBe(2);
    expect(composer.x).toBe(0);
    expect(prompt.x - composer.x).toBe(2);
    expect(app.footerLine().indexOf("Radian")).toBe(2);

    // Shrinking the real renderer reduces insets rather than clipping the active input.
    app.mockInput.pressKey("e", { ctrl: true }); await app.mockInput.typeText("keep this draft");
    app.resize(60, 12); await app.renderOnce();

    expect(transcript.x).toBe(1);
    expect(composer.x).toBe(0);
    expect(prompt.x - composer.x).toBe(1);
    expect(app.footerLine().indexOf("Radian")).toBe(1);
    expect(app.renderer.currentFocusedRenderable).toBe(prompt);

    // The normal spacing returns without rebuilding the Agent or replacing its draft.
    app.resize(120, 24); await app.renderOnce();

    expect(transcript.x).toBe(2);
    expect(composer.x).toBe(0);
    expect(prompt.x - composer.x).toBe(2);
    expect(app.footerLine().indexOf("Radian")).toBe(2);
    expect(app.view.promptDrafts.a1).toBe("keep this draft");
    expect(app.calls).toEqual([]);
  } finally { await app.close(); }
});

test("낮은 터미널에서도 Agent 상태와 입력창은 한 줄 푸터를 침범하지 않는다", async () => {
  // Height changes retain the same composer treatment and keep usable input above the footer.
  const app = await mount();
  try {
    app.mockInput.pressKey("e", { ctrl: true }); await app.mockInput.typeText("compact draft");

    // Resizing while typing must preserve the active draft and fit every control above the footer.
    app.resize(60, 12); await app.renderOnce();
    const composer = app.renderer.root.findDescendantById("agent-composer")!;
    const prompt = app.renderer.root.findDescendantById("session-prompt")!;
    const footer = app.renderer.root.findDescendantById("footer-bar")!;

    expect(composer.height).toBe(3);
    const status = app.renderer.root.findDescendantById("session-status")!;
    expect(composer.y + composer.height).toBe(status.y);
    expect(status.height).toBe(3); expect(status.y + status.height).toBeLessThanOrEqual(footer.y);
    const row = status.getChildren()[0]!;
    expect(app.captureCharFrame().split("\n")[row.y]).toContain("context");
    expect(app.captureCharFrame().split("\n")[row.y]).toContain("usage");
    expect(prompt.y + prompt.height).toBeLessThanOrEqual(footer.y);
    expect(app.captureCharFrame().split("\n")[prompt.y]).toContain("compact draft");
    expect(app.captureCharFrame()).not.toContain("Status not supplied");
    expect(app.footerLine().trimStart()).toStartWith("Radian · Agents");
    expect(app.selection.sessionId).toBe("a1");
    expect(app.renderer.currentFocusedRenderable).toBe(prompt);

    // Increasing the height keeps the same input treatment without losing its state.
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
    expect(app.footerLine()).toContain("Radian 0.0.0");
    expect(app.footerLine()).toContain("Help"); expect(app.footerLine()).not.toContain("Open worktree");
    app.view.dispose();

    expect(app.renderer.listenerCount("focused_renderable")).toBe(app.initialFocusListeners);
    app.view.setNotice("Late update"); await app.renderOnce();
    expect(app.captureCharFrame()).not.toContain("Late update");
  } finally { await app.close(); }
});
