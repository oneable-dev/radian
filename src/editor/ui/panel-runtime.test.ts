import { expect, test } from "bun:test";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { createWorktreeFixture } from "../../testing/worktree-fixture.ts";
import { connectRuntime, fetchSnapshot } from "../../runtime/client.ts";
import { restoreWorkViews, saveWorkViews } from "../../runtime/work-view-preferences.ts";
import { WorkspaceSelection } from "../../app/workspace-selection.ts";
import { Workbench } from "../../app/ui/workbench.ts";
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
    app = await mount(); await app.click("Editor"); await app.visible("[No Name]");
    await app.mockInput.typeText("iunsaved-native-editor"); app.mockInput.pressEscape(); await app.visible("unsaved-native-editor");
    const pid = app.client.snapshot.editors![0]!.pid;
    const originalSurface = app.renderer.currentFocusedRenderable;
    // Every presented return frame must retain the unsaved buffer, not merely converge later.
    for (const away of ["Agents", "Git"]) {
      await app.click(away);
      const frames: string[] = [];
      const capture = () => {
        if (app!.renderer.root.findDescendantById("editor-view")!.visible) frames.push(app!.captureCharFrame());
      };
      app.renderer.on("frame", capture);
      try {
        await app.click("Editor"); await app.visible("unsaved-native-editor");
        await until(() => app!.renderer.currentFocusedRenderable === originalSurface);
        await app.click("Editor"); await app.renderOnce();
        expect(frames.length).toBeGreaterThan(0);
        expect(frames.every((frame) => frame.includes("unsaved-native-editor"))).toBe(true);
        expect(app.renderer.currentFocusedRenderable).toBe(originalSurface);
        expect(app.client.snapshot.editors![0]!.pid).toBe(pid);
      } finally { app.renderer.off("frame", capture); }
    }
    // The editor viewport excludes the text row and the footer's thin partial-block cap.
    expect(app.editorFrame?.rows).toBe(16);
    expect(app.editorFrame?.cols).toBe(76);
    expect(app.captureCharFrame().split("\n")[23]).toContain("Radian 0.0.0");
    app.resize(100, 28); await app.renderOnce();
    await until(() => app!.editorFrame?.rows === 20); await app.visible("unsaved-native-editor");
    expect(app.editorFrame?.rows).toBe(20);
    expect(app.editorFrame?.cols).toBe(56);
    await app.click("feature (feature/probe)"); await app.click("Editor"); await app.visible("[No Name]");
    await app.mockInput.typeText("iSECOND-WORKTREE-CACHE"); app.mockInput.pressEscape(); await app.visible("SECOND-WORKTREE-CACHE");
    expect(app.captureCharFrame()).not.toContain("unsaved-native-editor");
    await app.click("Git");
    const returns: string[] = [];
    const captureReturn = () => {
      if (app!.renderer.root.findDescendantById("editor-view")!.visible) returns.push(app!.captureCharFrame());
    };
    app.renderer.on("frame", captureReturn);
    try {
      await app.click("main (main)"); await app.visible("unsaved-native-editor");
      expect(returns.length).toBeGreaterThan(0);
      expect(returns.every((frame) => frame.includes("unsaved-native-editor") && !frame.includes("SECOND-WORKTREE-CACHE"))).toBe(true);
    } finally { app.renderer.off("frame", captureReturn); }

    // Destroy every native view and IPC client, then reconstruct from daemon-owned state.
    await app.close(); app = undefined;
    expect(pidAlive(pid)).toBe(true);
    app = await mount(); await app.visible("unsaved-native-editor");

    expect(app.client.snapshot.editors![0]!.pid).toBe(pid);
    expect(app.view.workViewPreferences.active[fixture.repository.worktrees.find((tree) => tree.path === fixture.main)!.id]).toBe("editor");
    await app.click("feature (feature/probe)"); await app.visible("Git preview");
    expect(app.captureCharFrame()).not.toContain("unsaved-native-editor");

    // Normal Neovim exit must not turn the focus-out notification into a stale-input error.
    await app.click("main (main)"); await app.click("Editor"); await app.visible("unsaved-native-editor");
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
