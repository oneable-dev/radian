import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { err, ok } from "../../result.ts";
import { EditorError } from "../../errors.ts";
import type { EditorActions } from "../../editor/ui/panel.ts";
import type { EditorFrame, WorkViewPreferences } from "../../runtime/protocol.ts";

async function mount(actions: Partial<WorkbenchActions> = {}) {
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace());
  const requests: string[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession: () => requests.push("create"), onCloseSession: () => requests.push("close"), onPrompt: () => { requests.push("prompt"); return ok(undefined); },
    getSessionDetails: () => ({ status: "complete", output: Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"), error: null }), ...actions,
  });
  await app.renderOnce(); await app.renderOnce();
  return { ...app, selection, view, requests,
    async click(text: string) {
      const lines = app.captureCharFrame().split("\n"), y = lines.findIndex((line) => line.includes(text));
      const x = lines[y]?.indexOf(text) ?? -1;
      if (x < 0) throw new Error(`Missing ${text}\n${app.captureCharFrame()}`);
      await app.mockMouse.click(x, y); await app.renderOnce(); await app.renderOnce();
    },
    async visible(text: string) {
      const deadline = Date.now() + 3000;
      while (!app.captureCharFrame().includes(text)) {
        if (Date.now() > deadline) throw new Error(`Missing ${text}\n${app.captureCharFrame()}`);
        await app.renderOnce(); await Bun.sleep(1);
      }
    },
    async close() { view.dispose(); await app.dispose(); },
  };
}
function editorFixture() {
  const inputs: string[] = [], opens: string[] = [], detaches: string[] = [];
  const actions: EditorActions = {
    info: (id) => ({ id, worktreeId: id, pid: 123, exited: false, exitCode: null }),
    open: async (id) => { opens.push(id); return ok(id); },
    attach: async (id, receive) => {
      let revision = 0;
      const frame = (cols: number, rows: number): EditorFrame => ({ id, worktreeId: id, pid: 123, exited: false, exitCode: null,
        cols, rows, revision: revision++, ansi: `\x1bc\x1b[1;1HEditor buffer ${id}` });
      receive(frame(80, 24));
      return ok({ input: (bytes) => inputs.push(new TextDecoder().decode(bytes)),
        resize: (cols, rows) => receive(frame(cols, rows)), disconnect: async () => { detaches.push(id); } });
    },
  };
  return { actions, inputs, opens, detaches };
}

test("좌우 두 패널과 푸터를 표시하고 워크트리별 Editor·Git 화면을 복원한다", async () => {
  // Demo mode provides navigation without launching any native editor or Git command.
  const app = await mount();
  try {
    expect(app.captureCharFrame()).toContain("Agent  Editor  Git");
    expect(app.captureCharFrame()).not.toContain("Inspector");
    await app.click("Editor"); await app.click("radian-ui (feature"); await app.click("Git");

    await app.click("radian (main)");
    expect(app.captureCharFrame()).toContain("Editor preview");
    await app.click("radian-ui (feature");
    expect(app.captureCharFrame()).toContain("Git preview");
    expect(app.view.workViewPreferences.active).toEqual({ "demo:main": "editor", "demo:feature": "git" });
    expect(app.requests).toEqual([]);
    app.resize(60, 12); await app.renderOnce();
    expect(app.captureCharFrame().split("\n")[11]).toContain("Radian 0.0.0");
  } finally { await app.close(); }
});

test("같은 세션 재선택과 다른 워크트리의 세션 직접 선택은 모두 Agent로 전환한다", async () => {
  const app = await mount();
  try {
    await app.click("Editor");
    // Selecting the already-selected session is still an explicit Agent activation.
    await app.click("Workspace layout");
    expect(app.view.workViewPreferences.active["demo:main"]).toBe("agent");
    expect(app.captureCharFrame()).toContain("Prompt · Enter to run");
    await app.click("radian-ui (feature"); await app.click("Git"); await app.click("radian (main)"); await app.click("Editor");

    await app.click("Sidebar prototype");

    expect(app.selection.sessionId).toBe("b1");
    expect(app.view.workViewPreferences.active["demo:feature"]).toBe("agent");
    expect(app.captureCharFrame()).toContain("Prompt · Enter to run");
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("검색과 백그라운드 snapshot은 Git 화면을 강제로 Agent로 바꾸지 않는다", async () => {
  const app = await mount();
  try {
    await app.click("Git");
    app.mockInput.pressKey("f", { ctrl: true }); await app.mockInput.typeText("feature/workspace");
    app.selection.replaceSnapshot(demoWorkspace()); await app.renderOnce();

    expect(app.captureCharFrame()).toContain("Git preview");
    expect(app.selection.worktree?.id).toBe("demo:main");
    expect(app.view.workViewPreferences.active["demo:main"]).toBe("git");
  } finally { await app.close(); }
});

test("명시적으로 스크롤한 Agent 위치와 초안은 탭 왕복과 UI 재생성 뒤 복원된다", async () => {
  let retained: WorkViewPreferences | undefined;
  const app = await mount({ onWorkViewsChange: (state) => { retained = state; }, initialDrafts: { a1: "unfinished draft" } });
  let firstLine = "";
  try {
    for (let i = 0; i < 3; i++) await app.mockMouse.scroll(60, 10, "up");
    await app.renderOnce();
    firstLine = app.captureCharFrame().match(/line \d+/)?.[0] ?? "";
    expect(firstLine).not.toBe("");
    await app.click("Git"); await app.click("Agent");
    expect(app.captureCharFrame().match(/line \d+/)?.[0]).toBe(firstLine);
    expect(app.captureCharFrame()).toContain("unfinished draft");
  } finally { await app.close(); }
  // A fresh view receives only serialized preferences, not the previous renderables.
  const next = await mount({ ...(retained ? { initialWorkViews: retained } : {}), initialDrafts: { a1: "unfinished draft" } });
  try {
    expect(next.captureCharFrame().match(/line \d+/)?.[0]).toBe(firstLine);
    expect(next.captureCharFrame()).toContain("unfinished draft");
  } finally { await next.close(); }
});

test("Editor에 포커스가 있으면 Neovim 키를 전달하고 Ctrl+]로 앱 탐색에 복귀한다", async () => {
  // Only the process boundary is replaced; native OpenTUI VT/key handling remains real.
  const editor = editorFixture(), app = await mount({ editor: editor.actions });
  try {
    await app.click("Editor"); await app.visible("Editor buffer");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("editor-terminal");
    app.mockInput.pressTab(); app.mockInput.pressKey("f", { ctrl: true }); app.mockInput.pressKey("e", { ctrl: true });
    app.mockInput.pressEscape(); await app.renderOnce();
    expect(editor.inputs.join("")).toContain("\t"); expect(editor.inputs.join("")).toContain("\x06"); expect(editor.inputs.join("")).toContain("\x05");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("editor-terminal");
    expect(app.captureCharFrame().split("\n")[23]).toContain("Ctrl+] Sidebar");

    app.mockInput.pressKey("]", { ctrl: true }); await app.renderOnce();

    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-tree");
    expect(editor.inputs.join("")).not.toContain("\x1d");
    expect(editor.opens).toEqual(["demo:main"]);
  } finally { await app.close(); }
});

test("느린 Editor 열기 응답은 새로 선택한 Git 화면이나 포커스를 덮어쓰지 않는다", async () => {
  const ready = Promise.withResolvers<ReturnType<typeof ok<string>>>();
  const editor = editorFixture(); editor.actions.open = () => ready.promise;
  const app = await mount({ editor: editor.actions });
  try {
    await app.click("Editor"); await app.click("radian-ui (feature"); await app.click("Git");
    const focus = app.renderer.currentFocusedRenderable;

    ready.resolve(ok("demo:main")); await Bun.sleep(0); await app.renderOnce();

    expect(app.captureCharFrame()).toContain("Git preview");
    expect(app.renderer.currentFocusedRenderable).toBe(focus);
    expect(app.view.workViewPreferences.active["demo:feature"]).toBe("git");
    expect(app.captureCharFrame()).not.toContain("Editor buffer");
  } finally { ready.resolve(ok("demo:main")); await app.close(); }
});

test("복원할 Editor 프로세스가 없으면 자동 실행하지 않고 명시적 실패를 알린다", async () => {
  const editor = editorFixture();
  editor.actions.info = () => undefined;
  editor.actions.open = async (id) => { editor.opens.push(id); return err(new EditorError("EDITOR_UNAVAILABLE", "Neovim is missing.")); };
  const app = await mount({ editor: editor.actions, initialWorkViews: { active: { "demo:main": "editor" }, agentScroll: {} } });
  try {
    // A saved tab after a cold service restart is not permission to silently create a replacement editor.
    await app.visible("Editor is not running"); expect(editor.opens).toEqual([]);
    await app.click("Open / reconnect editor"); await app.visible("Neovim is missing.");

    expect(editor.opens).toEqual(["demo:main"]);
    expect(app.captureCharFrame()).toContain("Open / reconnect editor");
    expect(app.captureCharFrame()).not.toContain("Editor buffer");
    expect(app.view.workViewPreferences.active["demo:main"]).toBe("editor");
  } finally { await app.close(); }
});

test("History를 보고 있는 Editor에서도 탈출 키가 표시 중인 사이드바로 이동한다", async () => {
  const editor = editorFixture(), app = await mount({ editor: editor.actions });
  try {
    await app.click("History"); await app.click("Editor"); await app.visible("Editor buffer");

    app.mockInput.pressKey("]", { ctrl: true }); await app.renderOnce();

    expect(app.renderer.currentFocusedRenderable?.id).toBe("history-list");
    expect(app.captureCharFrame()).toContain("Editor buffer");
  } finally { await app.close(); }
});

test("활성 Editor의 renderer가 먼저 종료돼도 늦은 프레임과 detach를 안전하게 처리한다", async () => {
  const editor = editorFixture();
  let late: ((frame: EditorFrame) => void) | undefined;
  const attach = editor.actions.attach;
  editor.actions.attach = async (id, frame, failed) => { late = frame; return attach(id, frame, failed); };
  const app = await mount({ editor: editor.actions });
  try {
    await app.click("Editor"); await app.visible("Editor buffer");
    app.renderer.destroy(); await app.renderer.closed;

    late?.({ id: "demo:main", worktreeId: "demo:main", pid: 123, cols: 84, rows: 19, revision: 100, ansi: "late", exited: false, exitCode: null });
    app.view.dispose(); await Bun.sleep(0);

    expect(editor.detaches).toEqual(["demo:main"]);
    expect(app.view.workViewPreferences.active["demo:main"]).toBe("editor");
  } finally { await app.close(); }
});
