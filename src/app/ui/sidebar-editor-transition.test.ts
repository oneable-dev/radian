import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { ok } from "../../result.ts";
import type { EditorFrame } from "../../runtime/protocol.ts";
import { ConnectionError, type ExpectedError } from "../../errors.ts";

async function fixture() {
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
  const sizes: { cols: number; rows: number }[] = [], input: string[] = [];
  let receive: (frame: EditorFrame) => void = () => {}, failure: (error: ExpectedError) => void = () => {}, attaches = 0, revision = 0;
  const frame = (cols: number, rows: number): EditorFrame => ({ id: "editor", worktreeId: "demo:main", pid: 123, exited: false, exitCode: null, cols, rows, revision: revision++, ansi: "\x1bc\x1b[1;1HNATIVE_BUFFER" });
  const view = new Workbench(app.renderer, new WorkspaceSelection(demoWorkspace()), { onNewSession() {}, onCloseSession() {}, editor: {
    info: id => id === "demo:main" ? { id: "editor", worktreeId: id, pid: 123, exited: false, exitCode: null } : undefined,
    open: async () => ok("editor"), attach: async (_id, onFrame, failed) => {
      attaches++; receive = onFrame; failure = failed; receive(frame(116, 23));
      return ok({ input: bytes => input.push(new TextDecoder().decode(bytes)), resize: (cols, rows) => { sizes.push({ cols, rows }); receive(frame(cols, rows)); }, disconnect: async () => {} });
    },
  } });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  const leader = (key: string) => { app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey(key); };
  leader("e"); await render();
  const get = (id: string) => app.renderer.root.findDescendantById(id)!;
  return { ...app, view, sizes, input, render, leader, get, attaches: () => attaches,
    receive: () => receive(frame(sizes.at(-1)?.cols ?? 116, sizes.at(-1)?.rows ?? 23)), fail: () => failure(new ConnectionError("CONNECTION_FAILED", "Connection lost")),
    async close() { view.dispose(); await app.dispose(); } };
}

test("Workspace overlays above Editor preserve PTY size, instance, and connection", async () => {
  // Overlays need no legacy sidebar resize preparation/commit protocol.
  const app = await fixture();
  try {
    const surface = app.renderer.currentFocusedRenderable!, geometry = [surface.x, surface.y, surface.width, surface.height], sizes = app.sizes.length;

    app.leader("b"); await app.render(); expect(app.get("workspace-picker").visible).toBe(true);
    expect([surface.x, surface.y, surface.width, surface.height]).toEqual(geometry); expect(app.sizes).toHaveLength(sizes);
    app.mockInput.pressEscape(); await app.render();

    expect(app.renderer.currentFocusedRenderable).toBe(surface); expect(app.attaches()).toBe(1); expect(app.input).toEqual([]);
    expect(app.captureCharFrame()).toContain("NATIVE_BUFFER");
  } finally { await app.close(); }
});

test("Popup search and late Editor frames preserve each other's focus and input ownership", async () => {
  // Native output applies only to the same surface behind the popup.
  const app = await fixture();
  try {
    app.leader("b"); await app.render(); await app.mockInput.typeText("feature");
    app.receive(); await app.render();

    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-search"); expect(app.captureCharFrame()).toContain("feature"); expect(app.input).toEqual([]);
    app.mockInput.pressEscape(); await app.render(); expect(app.renderer.currentFocusedRenderable?.id).toStartWith("editor-terminal:");
  } finally { await app.close(); }
});

test("Editor connection failures during popups retain search focus and offer recovery after closing", async () => {
  // Popup cancellation must not refocus a nonexistent PTY after failure.
  const app = await fixture();
  try {
    app.leader("b"); await app.render(); app.fail(); await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-search");

    app.mockInput.pressEscape(); await app.render();

    expect(app.get("workspace-picker").visible).toBe(false); expect(app.captureCharFrame()).toContain("Open / reconnect editor"); expect(app.input).toEqual([]);
  } finally { await app.close(); }
});
