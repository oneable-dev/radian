import { expect, test } from "bun:test";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { createWorktreeFixture } from "../../testing/worktree-fixture.ts";
import { connectRuntime, fetchSnapshot } from "../../runtime/client.ts";
import { restoreWorkViews, saveWorkViews } from "../../runtime/work-view-preferences.ts";
import { WorkspaceSelection } from "../../app/workspace-selection.ts";
import { Workbench } from "../../app/ui/workbench.ts";
import { icons } from "../../icons.ts";
import { expectOk } from "../../testing/results.ts";
import { pidAlive } from "../../runtime/storage.ts";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("UI/runtime observation timed out"); await Bun.sleep(15); }
}

test("실제 Neovim 입력과 리사이즈·워크트리 왕복·전체 TUI 재접속을 native 화면으로 검증한다", async () => {
  // Real Bun daemon/PTY, clean Neovim, native OpenTUI VT and isolated worktrees; no model requests.
  const fixture = await createWorktreeFixture();
  const options = { offline: true, stateRoot: join(fixture.directory, "state"), entry: join(import.meta.dir, "..", "..", "index.ts") };
  async function mount() {
    const client = expectOk(await connectRuntime(fixture.repository, fixture.main, options));
    if (!client) throw new Error("Missing runtime");
    const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
    const selection = new WorkspaceSelection(client.snapshot.repositories);
    const preferences = structuredClone(client.snapshot.preferences); selection.restore(preferences.selection);
    let pending = Promise.resolve();
    let diagnosticFrame: import("../../runtime/protocol.ts").EditorFrame | undefined;
    const persist = () => {
      preferences.selection = { worktreeId: selection.state.worktreeId, sessions: { ...selection.state.sessions } };
      const copy = structuredClone(preferences);
      pending = pending.then(async () => { expectOk(await client.savePreferences(copy)); });
    };
    const view = new Workbench(app.renderer, selection, {
      onNewSession: () => {}, onCloseSession: () => {},
      initialWorkViews: restoreWorkViews(preferences),
      onWorkViewsChange: (state) => { saveWorkViews(preferences, state); persist(); },
      editor: { info: (tree) => client.snapshot.editors?.find((item) => item.worktreeId === tree), open: (tree, size) => client.openEditor(tree, size),
        attach: (id, frame, failed) => client.attachEditor(id, (value) => { diagnosticFrame = value; frame(value); }, failed) },
    });
    const unsubscribe = client.subscribe(() => selection.replaceSnapshot(client.snapshot.repositories));
    const unselect = selection.subscribe(persist);
    await app.renderOnce();
    return { ...app, client, selection, view, get editorFrame() { return diagnosticFrame; },
      async showView(key: "a" | "e" | "g") {
        app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey(key); await app.renderOnce();
      },
      async click(text: string) {
        const lines = app.captureCharFrame().split("\n"), y = lines.findIndex((line) => line.includes(text)), x = lines[y]?.indexOf(text) ?? -1;
        if (x < 0) throw new Error(`Missing ${text}\n${app.captureCharFrame()}`);
        await app.mockMouse.click(x, y); await app.renderOnce();
      },
      async visible(text: string) {
        try { await until(async () => { await app.renderOnce(); return app.captureCharFrame().includes(text); }); }
        catch (error) { console.error(`Missing ${text}\n${app.captureCharFrame()}`, view.workViewPreferences, diagnosticFrame); throw error; }
      },
      async close() { unsubscribe(); unselect(); view.dispose(); await pending; await client.disconnect(); await app.dispose(); },
    };
  }
  let app: Awaited<ReturnType<typeof mount>> | undefined;
  try {
    app = await mount(); await app.showView("e"); await app.visible("[No Name]");
    await app.mockInput.typeText("iunsaved-native-editor"); app.mockInput.pressEscape(); await app.visible("unsaved-native-editor");
    const pid = app.client.snapshot.editors![0]!.pid;
    const originalSurface = app.renderer.currentFocusedRenderable;
    // Every presented return frame must retain the unsaved buffer, not merely converge later.
    for (const away of ["a", "g"] as const) {
      await app.showView(away);
      const frames: string[] = [];
      const capture = () => {
        if (app!.renderer.root.findDescendantById("editor-view")!.visible) frames.push(app!.captureCharFrame());
      };
      app.renderer.on("frame", capture);
      try {
        await app.showView("e"); await app.visible("unsaved-native-editor");
        await until(() => app!.renderer.currentFocusedRenderable === originalSurface);
        await app.showView("e"); await app.renderOnce();
        expect(frames.length).toBeGreaterThan(0);
        expect(frames.every((frame) => frame.includes("unsaved-native-editor"))).toBe(true);
        expect(app.renderer.currentFocusedRenderable).toBe(originalSurface);
        expect(app.client.snapshot.editors![0]!.pid).toBe(pid);
      } finally { app.renderer.off("frame", capture); }
    }
    // Sidebar changes and the new PTY image must be presented together, not converge later.
    const sidebar = app.renderer.root.findDescendantById("workspace-sidebar")!;
    const rulerColumn = () => app!.captureCharFrame().split("\n").find((line) => line.includes("[No Name]"))?.indexOf("All") ?? -1;
    const expectedRuler = rulerColumn(); expect(expectedRuler).toBeGreaterThan(0);
    const transitions: { marker: boolean; ruler: number; width: number; remote: number | undefined }[] = [];
    const captureSidebar = () => transitions.push({ marker: app!.captureCharFrame().includes("unsaved-native-editor"),
      ruler: rulerColumn(), width: originalSurface!.width, remote: app!.editorFrame?.cols });
    app.renderer.on("frame", captureSidebar);
    try {
      for (const visible of [false, true, false, true]) {
        app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("b");
        await until(async () => { await app!.renderOnce(); return sidebar.visible === visible; });
      }
      expect(transitions.length).toBeGreaterThan(0);
      expect(transitions.every((frame) => frame.marker && frame.ruler === expectedRuler && frame.width === frame.remote)).toBe(true);
      // Superseded resize responses may still arrive; none may replace the current visible VT.
      for (const [count, visible] of [[3, false], [2, false], [1, true]] as const) {
        for (let i = 0; i < count; i++) { app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("b"); }
        await until(async () => { await app!.renderOnce(); return sidebar.visible === visible; });
      }
      // A stopped application cannot redraw: emulator dimensions alone must not commit the toggle.
      process.kill(pid, "SIGSTOP");
      try {
        app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("b");
        for (let i = 0; i < 8; i++) { await app.renderOnce(); await Bun.sleep(10); }
        expect(sidebar.visible).toBe(true); expect(rulerColumn()).toBe(expectedRuler);
      } finally { process.kill(pid, "SIGCONT"); }
      await until(async () => { await app!.renderOnce(); return !sidebar.visible; });
      app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("b");
      await until(async () => { await app!.renderOnce(); return sidebar.visible; });
      expect(transitions.every((frame) => frame.marker && frame.ruler === expectedRuler)).toBe(true);
      expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-tree");
      await app.showView("e");
      expect(app.renderer.currentFocusedRenderable?.id).toBe(originalSurface?.id);
      expect(app.client.snapshot.editors![0]!.pid).toBe(pid);
    } finally { app.renderer.off("frame", captureSidebar); }
    // With the navigation strip removed, the editor starts at the work pane's top edge.
    const aligned = () => {
      const sidebar = app!.renderer.root.findDescendantById("workspace-sidebar")!;
      const panel = app!.renderer.root.findDescendantById("work-panel")!;
      expect(originalSurface!.y).toBe(panel.y);
      expect(originalSurface!.y + originalSurface!.height).toBe(sidebar.y + sidebar.height);
      expect(app!.editorFrame?.rows).toBe(originalSurface!.height);
    };
    expect(app.editorFrame?.rows).toBe(23);
    expect(app.editorFrame?.cols).toBe(80); aligned();
    expect(app.captureCharFrame()).not.toContain("Neovim ·");
    expect(app.captureCharFrame().split("\n")[23]).toContain("Radian 0.0.0");
    app.resize(100, 28); await app.renderOnce();
    await until(() => app!.editorFrame?.rows === 27); await app.visible("unsaved-native-editor");
    expect(app.editorFrame?.rows).toBe(27);
    expect(app.editorFrame?.cols).toBe(60); aligned();
    await app.click(`${icons.folder} feature`); await app.showView("e"); await app.visible("[No Name]");
    await app.mockInput.typeText("iSECOND-WORKTREE-CACHE"); app.mockInput.pressEscape(); await app.visible("SECOND-WORKTREE-CACHE");
    expect(app.captureCharFrame()).not.toContain("unsaved-native-editor");
    await app.showView("g");
    const returns: string[] = [];
    const captureReturn = () => {
      if (app!.renderer.root.findDescendantById("editor-view")!.visible) returns.push(app!.captureCharFrame());
    };
    app.renderer.on("frame", captureReturn);
    try {
      await app.click(`${icons.folder} main`); await app.visible("unsaved-native-editor");
      expect(returns.length).toBeGreaterThan(0);
      expect(returns.every((frame) => frame.includes("unsaved-native-editor") && !frame.includes("SECOND-WORKTREE-CACHE"))).toBe(true);
    } finally { app.renderer.off("frame", captureReturn); }

    // Destroy every native view and IPC client, then reconstruct from daemon-owned state.
    await app.close(); app = undefined;
    expect(pidAlive(pid)).toBe(true);
    app = await mount(); await app.visible("unsaved-native-editor");

    expect(app.client.snapshot.editors![0]!.pid).toBe(pid);
    expect(app.view.workViewPreferences.active[fixture.repository.worktrees.find((tree) => tree.path === fixture.main)!.id]).toBe("editor");
    await app.click(`${icons.folder} feature`); await app.visible("Git preview");
    expect(app.captureCharFrame()).not.toContain("unsaved-native-editor");

    // Normal Neovim exit must not turn the focus-out notification into a stale-input error.
    await app.click(`${icons.folder} main`); await app.showView("e"); await app.visible("unsaved-native-editor");
    await app.mockInput.typeText(":qa!"); app.mockInput.pressEnter(); await app.visible("Neovim exited (0)");
    await app.renderOnce(); expect(app.captureCharFrame()).not.toContain("Editor unavailable");
    await app.click("Open / reconnect editor");
    await until(async () => { await app!.renderOnce(); return app!.client.snapshot.editors![0]!.pid !== pid && app!.renderer.currentFocusedRenderable?.id === `editor-terminal:${app!.selection.worktree!.id}`; });
    await app.mockInput.typeText("ireopened-editor"); await app.visible("reopened-editor");
    expect(app.client.snapshot.editors![0]!.pid).not.toBe(pid);
  } finally {
    await app?.close();
    const admin = expectOk(await connectRuntime(fixture.repository, fixture.main, { ...options, start: false }));
    if (admin) {
      const pids = admin.snapshot.editors?.map((editor) => editor.pid) ?? [];
      expectOk(await admin.stopRuntime()); await admin.disconnect();
      await until(async () => !expectOk(await fetchSnapshot(admin.paths)) && pids.every((pid) => !pidAlive(pid)));
    }
    await fixture.cleanup();
  }
}, 25000);
