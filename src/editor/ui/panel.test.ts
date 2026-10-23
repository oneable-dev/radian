import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { EditorPanel, type EditorActions } from "./panel.ts";
import { EditorError } from "../../errors.ts";
import { ok } from "../../result.ts";
import type { EditorFrame } from "../../runtime/protocol.ts";
import type { Worktree } from "../../workspace/model.ts";

const tree: Worktree = { id: "tree", path: "/fixture", name: "fixture", branch: "main", sessions: [] };
async function mount() {
  const app = await createTestRenderer({ width: 60, height: 16, kittyKeyboard: true });
  const inputs: string[] = [], notices: string[] = [];
  const openSizes: { cols: number; rows: number }[] = [], sizes: { cols: number; rows: number }[] = [];
  const failures: ((error: unknown) => void)[] = [];
  const receivers: ((frame: EditorFrame) => void)[] = [];
  let attaches = 0, opens = 0, detaches = 0;
  const actions: EditorActions = {
    info: () => ({ id: "editor", worktreeId: tree.id, pid: 123, exited: false, exitCode: null }),
    open: async (_id, size) => { opens++; openSizes.push(size); return ok("editor"); },
    attach: async (id, receive, failed) => {
      attaches++; failures.push(failed); receivers.push(receive); let revision = 0;
      const frame = (cols: number, rows: number): EditorFrame => ({ id, worktreeId: tree.id, pid: 123, exited: false, exitCode: null,
        cols, rows, revision: revision++, ansi: `\x1bcBUFFER-${id}` });
      receive(frame(80, 24));
      return ok({ input: (bytes) => inputs.push(new TextDecoder().decode(bytes)), resize: (cols, rows) => { sizes.push({ cols, rows }); receive(frame(cols, rows)); },
        disconnect: async () => { detaches++; } });
    },
  };
  const panel = new EditorPanel(app.renderer, actions, (label, activate) => {
    const button = new BoxRenderable(app.renderer, { height: 1, focusable: true, onMouseDown: activate });
    button.add(new TextRenderable(app.renderer, { content: label })); return button;
  }, (message) => notices.push(message), () => {});
  app.renderer.root.add(panel.root);
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  panel.show(tree, true); await render(); await render();
  return { ...app, actions, panel, inputs, notices, failures, receivers, render, openSizes, sizes,
    get attaches() { return attaches; }, get opens() { return opens; }, get detaches() { return detaches; },
    async close() { panel.dispose(); await app.dispose(); },
  };
}

test("Editor fills panels without margins across resize and forwards identical PTY sizes", async () => {
  // Keep the native VT real and observe only the operating-system size boundary.
  const app = await mount();
  try {
    const surface = app.panel.input;
    for (const [width, height] of [[120, 24], [60, 12], [79, 18], [80, 17], [120, 24]] as const) {
      app.resize(width, height); await app.render();

      // No Radian-owned gutter may consume a cell on any edge of the editor.
      expect(app.panel.input).toBe(surface);
      expect(surface!.x).toBe(0); expect(surface!.y).toBe(0);
      expect(surface!.width).toBe(width); expect(surface!.height).toBe(height);
      expect(app.sizes.at(-1)).toEqual({ cols: width, rows: height });
      expect(app.captureCharFrame().split("\n")[0]).toStartWith("BUFFER-editor");
    }
    expect(app.attaches).toBe(1); expect(app.opens).toBe(0);
  } finally { await app.close(); }
});

test.each([[60, 12], [120, 24]])("Explicit Editor opening requests full %dx%d panel dimensions", async (width, height) => {
  const app = await mount();
  try {
    // Starting a missing editor must use the same full-size geometry as reattachment.
    app.panel.hide(); app.actions.info = () => undefined;
    app.resize(width, height); await app.render();
    app.panel.show(tree, true); await app.render(); await app.render();

    expect(app.openSizes).toEqual([{ cols: width, rows: height }]);
    expect(app.panel.input?.width).toBe(width); expect(app.panel.input?.height).toBe(height);
  } finally { await app.close(); }
});

test("Cached Editor screens restore immediately but input waits for new lease acceptance", async () => {
  // The fake OS boundary holds reattachment while the native VT and key input remain real.
  const app = await mount();
  const pending = Promise.withResolvers<Awaited<ReturnType<EditorActions["attach"]>>>();
  const started = Promise.withResolvers<void>();
  const attach = app.actions.attach;
  let resume: (() => Promise<void>) | undefined;
  try {
    const original = app.panel.input!;
    expect(app.captureCharFrame()).toContain("BUFFER-editor");
    app.actions.attach = async (id, receive, failed) => {
      resume = async () => { pending.resolve(await attach(id, receive, failed)); };
      started.resolve(); return pending.promise;
    };
    app.panel.hide(); app.panel.show(tree, true); await started.promise; await app.render();

    // A painted cache is read-only until its replacement attachment is acknowledged.
    expect(app.captureCharFrame()).toContain("BUFFER-editor");
    expect(app.panel.input).toBeUndefined();
    original.focus(); await app.mockInput.typeText("blocked-input");
    expect(app.inputs.join("")).not.toContain("blocked-input");
    const ready = resume!; resume = undefined; await ready(); await app.render();
    expect(app.panel.input).toBe(original);
    await app.mockInput.typeText("accepted-input");
    expect(app.inputs.join("")).toContain("accepted-input");
    expect(app.opens).toBe(0);
    expect(app.detaches).toBe(1);
  } finally {
    if (resume) await resume();
    await app.close();
  }
});

test("Explicit reconnection reuses caches and stale failures never close new connections", async () => {
  // A failed connection must not satisfy the already-connected fast path.
  const app = await mount();
  try {
    const original = app.panel.input;
    app.failures[0]!(new EditorError("EDITOR_UNAVAILABLE", "Attachment lost.")); await app.render();
    expect(app.panel.input).toBeUndefined();
    expect(app.captureCharFrame()).toContain("Editor unavailable");

    app.panel.show(tree, true); await app.render(); await app.render();
    expect(app.attaches).toBe(2);
    expect(app.panel.input).toBe(original);
    expect(app.opens).toBe(0);
    app.failures[0]!(new EditorError("EDITOR_UNAVAILABLE", "Late old failure.")); await app.render();
    expect(app.panel.input).toBe(original);
    expect(app.notices).toHaveLength(1);
    app.panel.show(tree, true); await app.render();
    expect(app.attaches).toBe(2);
  } finally { await app.close(); }
});

test("Failure immediately after first reconnect frames prevents adoption despite resolved acceptance", async () => {
  // An attachment can notify failure before returning its nominally successful admission result.
  const app = await mount();
  const attach = app.actions.attach;
  try {
    app.panel.hide(); await app.render();
    app.actions.attach = async (id, receive, failed) => {
      const result = await attach(id, receive, failed);
      failed(new EditorError("EDITOR_UNAVAILABLE", "Stream ended during admission."));
      return result;
    };
    app.panel.show(tree, true); await app.render(); await app.render();

    expect(app.panel.input).toBeUndefined();
    expect(app.captureCharFrame()).toContain("Editor unavailable");
    expect(app.detaches).toBe(2);
    expect(app.notices).toHaveLength(1);
  } finally { await app.close(); }
});

test("Exit frames arriving before snapshots still make explicit opening request fresh Editors", async () => {
  // The terminal stream can report exit before the global snapshot catches up.
  const app = await mount();
  const open = app.actions.open;
  try {
    const old = app.panel.input!;
    app.receivers[0]!({ id: "editor", worktreeId: tree.id, pid: 123, cols: old.width, rows: old.height,
      exited: true, exitCode: 0, revision: 100, ansi: "\x1bcExited" });
    await app.render();
    app.actions.open = async (id, size) => { await open(id, size); return ok("replacement"); };
    app.panel.show(tree, true); await app.render(); await app.render(); await app.render();

    expect(app.opens).toBe(1);
    expect(app.attaches).toBe(2);
    expect(old.isDestroyed).toBe(true);
    expect(app.captureCharFrame()).toContain("BUFFER-replacement");
    expect(app.panel.input).toBeDefined();
  } finally { await app.close(); }
});
