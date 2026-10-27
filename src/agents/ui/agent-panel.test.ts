import { expect, test } from "bun:test";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { AgentPanel, type AgentActions } from "./agent-panel.ts";
import type { Worktree } from "../../workspace/model.ts";
import { ok, type Result } from "../../result.ts";
import type { ExpectedError } from "../../errors.ts";

const tree: Worktree = { id: "tree", path: "/fixture", name: "fixture", branch: "main", sessions: [
  { id: "a", name: "Session A", status: null, subagents: [] },
  { id: "b", name: "Session B", status: null, subagents: [] },
] };
const openIds = new Set(["a", "b"]);
async function mount(actions: Partial<AgentActions> = {}, scroll: Record<string, number> = {}, options: ConstructorParameters<typeof AgentPanel>[8] = {}) {
  const app = await createTestRenderer({ width: 80, height: 18, kittyKeyboard: true });
  const notices: string[] = [], saved: Record<string, number> = {};
  const panel = new AgentPanel(app.renderer, {
    onNewSession: () => {}, onPrompt: () => ok(undefined),
    getSessionDetails: (id) => ({ status: null, output: `Output ${id}`, error: null }), ...actions,
  }, (label, activate) => {
    const button = new BoxRenderable(app.renderer, { height: 1, flexShrink: 0, focusable: true, onMouseDown: activate });
    button.add(new TextRenderable(app.renderer, { content: label })); return button;
  }, (notice) => notices.push(notice), () => {}, () => panel.prompt.blur(), scroll, (id, value) => { saved[id] = value; }, options);
  app.renderer.root.add(panel.root);
  panel.update(tree, "a", openIds, true);
  await app.renderOnce(); await app.renderOnce();
  return { ...app, panel, notices, saved, async close() { panel.dispose(); await app.dispose(); } };
}

test("Standalone Agent panels emit only explicit creation commands when empty", async () => {
  // Entering an empty panel must not create sessions, even without Workbench.
  const created: string[] = [];
  const app = await mount({ onNewSession: (id) => created.push(id) });
  try {
    app.panel.update({ ...tree, sessions: [] }, null, new Set(), true);
    await app.renderOnce();
    expect(created).toEqual([]); expect(app.captureCharFrame()).toContain("No AI sessions");

    // The host routes the same explicit session command used by the keyboard-only strip.
    app.panel.sessionCommand("session.new");

    expect(created).toEqual(["tree"]);
  } finally { await app.close(); }
});

test("Read-only Agent panels block send, interrupt, and creation despite provided callbacks", async () => {
  // Preview mode blocks writes even if host callbacks are passed accidentally.
  const actions: string[] = [];
  const app = await mount({ initialDrafts: { a: "Saved draft" },
    onPrompt: () => { actions.push("prompt"); return ok(undefined); },
    onInterrupt: async () => { actions.push("interrupt"); return ok(undefined); },
    onNewSession: () => actions.push("create"), onSelectSession: () => actions.push("select"), onCloseSession: () => actions.push("close"),
    getSessionDetails: () => ({ status: "working", output: "Saved output", error: null }),
  }, {}, { readOnly: true });
  try {
    // Public command boundaries enforce the same policy when UI routing is bypassed.
    await app.panel.submitPrompt(); await app.panel.interrupt(); app.panel.sessionCommand("session.new");
    app.panel.sessionCommand("session.next"); app.panel.sessionCommand("session.close");
    app.panel.movePromptHistory(-1); app.panel.movePromptHistory(1);
    const close = app.renderer.root.findDescendantById("close-session:a")!;
    await app.mockMouse.click(close.x, close.y); await app.renderOnce();

    // No write callbacks run; drafts and status lines remain displayed.
    expect(actions).toEqual([]); expect(app.panel.canSubmit).toBe(false); expect(app.panel.canInterrupt).toBe(false);
    expect(app.panel.prompt.value).toBe("Saved draft"); expect(app.captureCharFrame()).toContain("to interrupt");
    expect(app.panel.prompt.focusable).toBe(false); expect(app.panel.promptHistoryAvailable).toBe(false);
    expect(app.panel.transcriptAvailable("transcript.fold")).toBe(false);
    expect(app.panel.transcriptAvailable("transcript.open-link")).toBe(false);
    expect(app.panel.sessionId).toBe("a");
  } finally { await app.close(); }
});

test("Late Agent submission acceptance never clears another session's draft", async () => {
  // Switch to B while A is awaiting acceptance.
  const pending = Promise.withResolvers<Result<void, ExpectedError>>();
  const sent: { id: string; text: string }[] = [];
  const app = await mount({ onPrompt: (id, text) => { sent.push({ id, text }); return pending.promise; } });
  try {
    app.panel.prompt.focus(); await app.mockInput.typeText("first");
    const submission = app.panel.submitPrompt(); await app.panel.submitPrompt();
    app.panel.update(tree, "b", openIds, true);
    await app.mockInput.typeText("second");

    // A's acceptance clears only captured A input and preserves current input.
    pending.resolve(ok(undefined)); await submission; await app.renderOnce();

    expect(sent).toEqual([{ id: "a", text: "first" }]);
    expect(app.panel.promptDrafts).toEqual({ b: "second" });
    expect(app.captureCharFrame()).toContain("second");
    expect(app.notices).toEqual([]);
  } finally { pending.resolve(ok(undefined)); await app.close(); }
});

test("Standalone Agent panels restore long-session positions from the first visible frame", async () => {
  // A's short layout must not clamp B's saved position.
  const app = await mount({ getSessionDetails: (id) => ({ status: null, error: null,
    output: id === "a" ? "SHORT" : Array.from({ length: 100 }, (_, index) => `LONG-${String(index).padStart(3, "0")}`).join("\n") }) }, { b: 53 });
  const frames: (string | null)[] = [];
  const capture = () => frames.push(app.captureCharFrame().match(/LONG-\d{3}/)?.[0] ?? null);
  try {
    app.renderer.on("frame", capture);
    app.panel.update(tree, "b", openIds, true);
    await app.renderOnce(); await app.renderOnce();

    // Check every visible transition frame, not only the final screen.
    expect(frames.length).toBeGreaterThan(0);
    expect(new Set(frames)).toEqual(new Set(["LONG-053"]));
    app.panel.transcriptScroll.scrollTo(57);
    expect(app.saved.b).toBe(57);
  } finally { app.renderer.off("frame", capture); await app.close(); }
});
