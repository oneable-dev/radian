import { openWorkspaceSearch } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { icons } from "../../icons.ts";
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
    leader(key: string) { app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey(key); },
    async showView(key: "a" | "e" | "g" | "t") {
      app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey(key);
      await app.renderOnce(); await app.renderOnce();
    },
    async click(text: string) {
      if (text.startsWith(icons.folder) && !app.renderer.root.findDescendantById("workspace-sidebar")!.visible) {
        app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("b");
        await app.renderOnce(); await app.renderOnce();
      }
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

test("Letter shortcuts switch views without upper tabs and retain current names in footer left", async () => {
  // The work pane has no navigation chrome; the footer identifies its displayed view.
  const app = await mount();
  try {
    expect(app.renderer.root.findDescendantById("work-view-tabs")).toBeUndefined();
    const panel = app.renderer.root.findDescendantById("work-panel")!;
    for (const [key, label, id] of [["a", "Agents", "agent"], ["e", "Editor", "editor"], ["g", "Git", "git"], ["t", "Terminal", "terminal"]] as const) {
      // View shortcuts select the work pane without creating sessions or sending prompts.
      await app.showView(key);
      app.renderer.root.findDescendantById("footer-help")!.focus(); await app.renderOnce();

      const footer = app.captureCharFrame().split("\n")[23]!;
      expect(footer.trimStart()).toStartWith(key === "a" ? "AGENT" : label.toUpperCase());
      expect(app.renderer.root.findDescendantById(`${id}-view`)!.y).toBe(panel.y);
      expect(app.view.workViewPreferences.active["demo:main"]).toBe(id);
      expect(app.selection.sessionId).toBe("a1");
    }
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("Editor fills all four work-panel corners at every size, leaving only the footer", async () => {
  const editor = editorFixture(), app = await mount({ editor: editor.actions });
  try {
    await app.showView("e"); await app.visible("Editor buffer");
    const surface = app.renderer.root.findDescendantById("editor-terminal:demo:main")!;
    for (const [width, height] of [[120, 24], [60, 12], [79, 18], [80, 17], [120, 24]] as const) {
      // The editor keeps its existing connection while all application-owned gutters stay absent.
      app.resize(width, height); await app.renderOnce(); await app.renderOnce();
      const pane = app.renderer.root.findDescendantById("work-panel")!;
      const footer = app.renderer.root.findDescendantById("app-footer")!;

      expect(surface.x).toBe(pane.x); expect(surface.y).toBe(pane.y);
      expect(surface.x + surface.width).toBe(pane.x + pane.width);
      expect(surface.y + surface.height).toBe(footer.y);
      expect(app.renderer.root.findDescendantById(surface.id)).toBe(surface);
      expect(app.renderer.currentFocusedRenderable).toBe(surface);
    }
    expect(editor.detaches).toEqual([]); expect(editor.opens).toEqual([]);
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("Numbers select current Agent session order while preserving drafts and worktree scope", async () => {
  // Session numbers follow the visible worktree's tab order, not the focused widget.
  const app = await mount({ initialDrafts: { a1: "first draft", a2: "second draft" } });
  try {
    await app.showView("a");
    app.leader("2"); await app.renderOnce();
    expect(app.selection.sessionId).toBe("a2");
    expect(app.captureCharFrame()).toContain("second draft");
    expect(app.view.promptDrafts.a1).toBe("first draft");

    // Moving focus and choosing a missing slot must not create or submit anything.
    app.renderer.root.findDescendantById("footer-help")!.focus();
    app.leader("1"); await app.renderOnce();
    expect(app.selection.sessionId).toBe("a1");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
    app.leader("9"); await app.renderOnce();
    expect(app.selection.sessionId).toBe("a1");
    expect(app.view.promptDrafts.a2).toBe("second draft");

    app.selection.selectWorktree("demo:feature"); await app.renderOnce();
    app.leader("2"); await app.renderOnce();
    expect(app.selection.sessionId).toBe("b1");
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("Editor/Git number and creation keys neither switch screens/sessions nor reach PTYs", async () => {
  // A configured but unavailable app command is consumed rather than replayed as native edits.
  const editor = editorFixture(), app = await mount({ editor: editor.actions });
  try {
    await app.showView("e"); await app.visible("Editor buffer");
    app.leader("2"); app.leader("c"); await app.renderOnce();
    expect(app.view.workViewPreferences.active["demo:main"]).toBe("editor");
    expect(editor.inputs).toEqual([]);
    expect(app.selection.sessionId).toBe("a1");

    await app.showView("g");
    app.leader("1"); app.leader("c"); await app.renderOnce();
    expect(app.view.workViewPreferences.active["demo:main"]).toBe("git");
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("Common creation explicitly creates current-worktree sessions even in empty Agents", async () => {
  const created: string[] = [], app = await mount({ onNewSession: (id) => { created.push(id); } });
  try {
    // Merely changing views never creates a session; only the explicit new-tab command does.
    app.selection.selectWorktree("demo:empty"); await app.showView("a");
    expect(created).toEqual([]);
    app.leader("c"); await app.renderOnce();
    expect(created).toEqual(["demo:empty"]);
    expect(app.selection.worktree?.sessions).toEqual([]);
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("Work views and footers restore per-worktree Editor/Git screens", async () => {
  // Demo mode provides navigation without launching any native editor or Git command.
  const app = await mount();
  try {
    expect(app.captureCharFrame()).not.toContain("Agents  Editor  Git");
    expect(app.captureCharFrame()).not.toContain("Inspector");
    await app.showView("e"); await app.click(`${icons.folder} radian-ui`); await app.showView("g");

    await app.click(`${icons.folder} radian`);
    expect(app.captureCharFrame()).toContain("Editor preview");
    await app.click(`${icons.folder} radian-ui`);
    expect(app.captureCharFrame()).toContain("Git preview");
    expect(app.view.workViewPreferences.active).toEqual({ "demo:main": "editor", "demo:feature": "git" });
    expect(app.requests).toEqual([]);
    app.resize(60, 12); await app.renderOnce();
    expect(app.captureCharFrame().split("\n")[11]).toContain("GIT");
  } finally { await app.close(); }
});

test("Session tabs select only within Agents while other worktrees retain their last work tab", async () => {
  const app = await mount({ initialDrafts: { a1: "main draft", b1: "feature draft" } });
  try {
    // Session switching is local to Agents, rather than an incidental tree action.
    await app.showView("e"); await app.showView("a"); await app.click("a1");
    expect(app.captureCharFrame()).toContain("main draft");
    await app.showView("e"); await app.click(`${icons.folder} radian-ui`); await app.showView("a");
    await app.click("b1");

    expect(app.selection.sessionId).toBe("b1");
    expect(app.view.workViewPreferences.active["demo:feature"]).toBe("agent");
    expect(app.view.workViewPreferences.active["demo:main"]).toBe("editor");
    expect(app.captureCharFrame()).toContain("feature draft");
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("Search and background snapshots never force Git screens into Agent", async () => {
  const app = await mount();
  try {
    await app.showView("g");
    openWorkspaceSearch(app); await app.mockInput.typeText("feature/workspace");
    app.selection.replaceSnapshot(demoWorkspace()); await app.renderOnce();
    app.mockInput.pressEscape(); await app.renderOnce();

    expect(app.captureCharFrame()).toContain("Git preview");
    expect(app.selection.worktree?.id).toBe("demo:main");
    expect(app.view.workViewPreferences.active["demo:main"]).toBe("git");
  } finally { await app.close(); }
});

test("Explicit Agent scroll and drafts restore after tab round-trips and UI recreation", async () => {
  let retained: WorkViewPreferences | undefined;
  const app = await mount({ onWorkViewsChange: (state) => { retained = state; }, initialDrafts: { a1: "unfinished draft" } });
  let firstLine = "";
  try {
    for (let i = 0; i < 3; i++) await app.mockMouse.scroll(60, 10, "up");
    await app.renderOnce();
    firstLine = app.captureCharFrame().match(/line \d+/)?.[0] ?? "";
    expect(firstLine).not.toBe("");
    await app.showView("g"); await app.showView("a");
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

test("Focused Editor forwards Neovim keys and leader+b opens workspace navigation", async () => {
  // Only the process boundary is replaced; native OpenTUI VT/key handling remains real.
  const editor = editorFixture(), app = await mount({ editor: editor.actions });
  try {
    await app.showView("e"); await app.visible("Editor buffer");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("editor-terminal:demo:main");
    app.mockInput.pressTab(); app.mockInput.pressKey("f", { ctrl: true }); app.mockInput.pressKey("e", { ctrl: true });
    app.mockInput.pressEscape(); await app.renderOnce();
    expect(editor.inputs.join("")).toContain("\t"); expect(editor.inputs.join("")).toContain("\x06"); expect(editor.inputs.join("")).toContain("\x05");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("editor-terminal:demo:main");
    expect(app.captureCharFrame().split("\n")[23]).toContain("<leader>b Workspaces");

    app.leader("b"); await app.renderOnce();

    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-search");
    expect(editor.inputs.join("")).not.toContain("\x00");
    expect(editor.opens).toEqual([]); // Existing editor metadata requires attachment, not another open.
  } finally { await app.close(); }
});

test("Slow Editor open responses never overwrite newly selected Git screens or focus", async () => {
  const ready = Promise.withResolvers<ReturnType<typeof ok<string>>>();
  const editor = editorFixture(); editor.actions.info = () => undefined; editor.actions.open = () => ready.promise;
  const app = await mount({ editor: editor.actions });
  try {
    await app.showView("e"); await app.click(`${icons.folder} radian-ui`); await app.showView("g");
    const focus = app.renderer.currentFocusedRenderable;

    ready.resolve(ok("demo:main")); await Bun.sleep(0); await app.renderOnce();

    expect(app.captureCharFrame()).toContain("Git preview");
    expect(app.renderer.currentFocusedRenderable).toBe(focus);
    expect(app.view.workViewPreferences.active["demo:feature"]).toBe("git");
    expect(app.captureCharFrame()).not.toContain("Editor buffer");
  } finally { ready.resolve(ok("demo:main")); await app.close(); }
});

test("Missing restored Editor processes report explicit failure without automatic launch", async () => {
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

test("History above Editor returns to the same input/connection on Esc without forwarding PTY keys", async () => {
  const editor = editorFixture(), app = await mount({ editor: editor.actions });
  try {
    await app.showView("e"); await app.visible("Editor buffer");
    const input = app.renderer.currentFocusedRenderable;
    app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("h"); await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("history-search");
    await app.mockInput.typeText("hjkl"); app.mockInput.pressEscape(); await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable).toBe(input);
    expect(app.captureCharFrame()).toContain("Editor buffer"); expect(editor.opens).toEqual([]);
    expect(editor.detaches).toEqual([]); expect(editor.inputs).toEqual([]);
    expect(app.view.workViewPreferences.active["demo:main"]).toBe("editor");
  } finally { await app.close(); }
});

test("Renderer-first Editor shutdown safely handles late frames and detach", async () => {
  const editor = editorFixture();
  let late: ((frame: EditorFrame) => void) | undefined;
  const attach = editor.actions.attach;
  editor.actions.attach = async (id, frame, failed) => { late = frame; return attach(id, frame, failed); };
  const app = await mount({ editor: editor.actions });
  try {
    await app.showView("e"); await app.visible("Editor buffer");
    app.renderer.destroy(); await app.renderer.closed;

    late?.({ id: "demo:main", worktreeId: "demo:main", pid: 123, cols: 84, rows: 19, revision: 100, ansi: "late", exited: false, exitCode: null });
    app.view.dispose(); await Bun.sleep(0);

    expect(editor.detaches).toEqual(["demo:main"]);
    expect(app.view.workViewPreferences.active["demo:main"]).toBe("editor");
  } finally { await app.close(); }
});
