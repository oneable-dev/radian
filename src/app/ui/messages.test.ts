import { expect, test } from "bun:test";
import { BoxRenderable, TextRenderable, parseKeypress } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { pressLeader } from "../../testing/keys.ts";
import { ok } from "../../result.ts";
import { parseKeymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";
import { PromptInput } from "../../agents/ui/prompt-input.ts";
import { SearchInput } from "../../ui/search-input.ts";
import { uiTheme } from "../../ui/theme.ts";

async function mount(actions: Partial<WorkbenchActions> = {}) {
  const clock = new ManualClock(), app = await createTestRenderer({ width: 120, height: 28, kittyKeyboard: true, clock });
  const selection = new WorkspaceSelection(demoWorkspace()), copies: string[] = [], sent: string[] = [];
  const view = new Workbench(app.renderer, selection, { onNewSession() {}, onCloseSession() {},
    onPrompt: (_id, text) => { sent.push(text); return ok(undefined); }, getSessionDetails: () => ({ status: null, output: "Transcript", error: null }),
    initialDrafts: { a1: "retained draft" }, onCopyTranscript: async text => { copies.push(text); return ok("Copied message"); }, ...actions });
  const render = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await app.renderOnce(); await app.renderOnce(); };
  const get = (id: string) => { const node = app.renderer.root.findDescendantById(id); if (!node) throw new Error(`Missing ${id}`); return node; };
  await render(); get("session-prompt").focus(); await render();
  return { ...app, clock, view, selection, copies, sent, render, get,
    open() { pressLeader(app, "!"); },
    async close() { view.dispose(); await app.dispose(); } };
}

function selected(app: Awaited<ReturnType<typeof mount>>): string {
  const list = app.get("messages-list");
  // Candidate boxes use the shared selection background even while the search owns focus.
  const visit = (node: ReturnType<typeof app.get>): string | undefined => {
    if (node instanceof BoxRenderable && node.id.startsWith("messages-row:") && node.backgroundColor?.equals(uiTheme(app.renderer).styles["ui.selection"].bg!))
      return (node.getChildren()[0] as TextRenderable).plainText;
    for (const child of node.getChildren()) { const found = visit(child); if (found) return found; }
    return undefined;
  };
  return visit(list) ?? "";
}

test.each([undefined, "info"] as const)("Informational notices with level %s never appear in toasts or Messages", async level => {
  // Routine navigation feedback must not cover work or accumulate in message history.
  const app = await mount();
  try {
    const prompt = app.get("session-prompt") as PromptInput, caret = prompt.cursorOffset;

    // Both unclassified notices and explicitly informational notices are discarded.
    app.view.notify("No matching text", level ? { level } : undefined); await app.render();

    // Discarding information must not create a toast, move focus, or change the draft.
    expect(app.get("session-notifications").visible).toBe(false);
    expect(app.captureCharFrame()).not.toContain("No matching text");
    expect(app.renderer.currentFocusedRenderable).toBe(prompt); expect(prompt.cursorOffset).toBe(caret);
    expect(prompt.value).toBe("retained draft");
    app.open(); await app.render(); expect(app.captureCharFrame()).toContain("No messages yet");
    expect(app.captureCharFrame()).not.toContain("No matching text");
  } finally { await app.close(); }
});

test.each([
  ["success", "Completed"], ["warning", "Warning"], ["error", "Failed"],
] as const)("%s notices still display a toast and remain in Messages", async (level, label) => {
  // Quiet informational feedback must not suppress accepted actions, warnings, or failures.
  const app = await mount();
  try {
    const prompt = app.get("session-prompt");

    // A classified action result should surface immediately without stealing keyboard focus.
    app.view.notify("Action feedback", { level, source: "Test action" }); await app.render();

    // The transient notification and retained record describe the same action.
    expect(app.get("session-notifications").visible).toBe(true);
    expect(app.captureCharFrame()).toContain(label); expect(app.captureCharFrame()).toContain("Action feedback");
    expect(app.renderer.currentFocusedRenderable).toBe(prompt);
    app.open(); await app.render(); expect(selected(app)).toContain("Action feedback");
  } finally { await app.close(); }
});

test.each(["info", "warning", "error"] as const)("Extension %s notices follow the same presentation policy", async level => {
  // The SDK may send Info, but only actionable extension feedback belongs in the application's records.
  const app = await mount({ getSessionDetails: () => ({ status: null, output: "Transcript", error: null, conversationId: "conversation" }),
    getExtensionUi: () => [{ sessionId: "a1", conversationId: "conversation", statuses: {},
      notifications: [{ id: "extension-notice", level, message: "Extension feedback" }] }] });
  try {
    // Inspect the connected extension's automatically delivered notification.
    await app.render();

    // Extension Info is discarded, while warnings and failures remain visible and inspectable.
    expect(app.get("session-notifications").visible).toBe(level !== "info");
    app.open(); await app.render();
    if (level === "info") {
      expect(app.captureCharFrame()).toContain("No messages yet"); expect(app.captureCharFrame()).not.toContain("Extension feedback");
    } else expect(selected(app)).toContain("Extension feedback");
  } finally { await app.close(); }
});

test("Expired failure notifications remain searchable with full details and restore draft/caret on close", async () => {
  // Toast lifetime must not determine whether the full failure can still be inspected.
  const app = await mount(), original = "Connection failed\n" + "Detailed cause. ".repeat(300) + "\nFINAL RECOVERY INSTRUCTION";
  try {
    const prompt = app.get("session-prompt") as PromptInput;
    app.mockInput.pressArrow("left"); const caret = prompt.cursorOffset;
    app.view.notify(original, { level: "error", source: "Editor" }); await app.render();
    expect(app.get("app-footer").height).toBe(1); expect(app.renderer.currentFocusedRenderable).toBe(prompt);
    app.clock.advance(8000); await app.render(); expect(app.get("session-notifications").visible).toBe(false);

    app.open(); await app.render(); expect(selected(app)).toContain("Connection failed");
    app.mockInput.pressEnter(); await app.render(); app.mockInput.pressKey("y"); await app.render();

    expect(app.copies).toEqual([original]); expect(app.get("text-dialog").visible).toBe(true);
    app.mockInput.pressKey("END"); await app.render(); expect(app.captureCharFrame()).toContain("FINAL RECOVERY INSTRUCTION");
    app.mockInput.pressEscape(); await app.render(); expect(app.get("messages").visible).toBe(true);
    app.mockInput.pressEscape(); await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(prompt); expect(prompt.cursorOffset).toBe(caret); expect(prompt.value).toBe("retained draft"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test.each([120, 60])("Width %i message navigation preserves literal search text across focus and half-page jumps", async width => {
  // Every candidate matches the query so navigation can be checked without query-dependent ambiguity.
  const app = await mount();
  try {
    for (let index = 0; index < 30; index++) app.view.notify(`needle-${String(index).padStart(2, "0")}`, { level: "warning" });
    app.clock.advance(100000); app.resize(width, 24); app.open(); await app.render();
    const search = app.get("messages-search") as SearchInput;
    await app.mockInput.typeText("needle"); app.mockInput.pressKey("n", { ctrl: true }); await app.render();
    expect(selected(app)).toContain("needle-28"); expect(search.focused).toBe(true);
    app.mockInput.pressKey("p", { ctrl: true }); app.mockInput.pressArrow("down"); await app.render(); expect(selected(app)).toContain("needle-28");
    const caret = search.cursorOffset;

    app.mockInput.pressKey("d", { ctrl: true }); await app.render();
    const after = selected(app); expect(after).not.toContain("needle-28"); expect(app.renderer.currentFocusedRenderable?.id).toBe("messages-list");
    app.mockInput.pressKey("d", { ctrl: true }); await app.render(); expect(selected(app)).not.toBe(after);
    app.mockInput.pressKey("j"); app.mockInput.pressKey("k"); app.mockInput.pressKey("p", { ctrl: true }); await app.render();

    expect(search.value).toBe("needle"); expect(search.cursorOffset).toBe(caret);
    app.mockInput.pressKey("/"); await app.render(); await app.mockInput.typeText("hjkl"); await app.render();
    expect(search.value).toBe("needlehjkl"); app.mockInput.pressCtrlC(); await app.render(); expect(search.value).toBe("");
    app.mockInput.pressCtrlC(); await app.render(); expect(app.get("messages").visible).toBe(true); expect(app.view.promptDrafts.a1).toBe("retained draft");
  } finally { await app.close(); }
});

test("Message history opens empty and honors user overrides without consuming ordinary exclamation input", async () => {
  // The existing named command is configurable; no colon command line owns application text.
  const keymap = expectOk(parseKeymap({ leader: "ctrl+b", bindings: { "notice.details": ["<leader> m"] } }));
  const app = await mount({ keymap });
  try {
    const prompt = app.get("session-prompt") as PromptInput;
    await app.mockInput.typeText("!"); expect(prompt.value).toBe("retained draft!");
    app.mockInput.pressKey("b", { ctrl: true }); app.mockInput.pressKey("m"); await app.render();

    expect(app.captureCharFrame()).toContain("No messages yet"); expect(app.get("messages").visible).toBe(true);
    app.mockInput.pressEscape(); await app.render(); expect(app.renderer.currentFocusedRenderable).toBe(prompt);
    expect(prompt.value).toBe("retained draft!"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("Runtime snapshots deduplicate notices but separate repeated actions remain in history", async () => {
  // Repaints cannot flood history, while identical failures from two actions must not disappear.
  const app = await mount();
  try {
    app.view.setNotice("Runtime reconnecting", { level: "warning" }); app.view.setNotice("Runtime reconnecting", { level: "warning" });
    app.view.notify("Action failed", { level: "error" }); app.view.notify("Action failed", { level: "error" });
    app.clock.advance(8000); app.open(); await app.render();

    expect(selected(app)).toContain("Action failed");
    app.mockInput.pressKey("y", { ctrl: true }); await app.render(); expect(app.copies).toEqual(["Action failed"]);
    expect(app.get("messages-list").visible).toBe(true); expect(app.get("messages").visible).toBe(true);
    app.mockInput.pressKey("n", { ctrl: true }); app.mockInput.pressKey("n", { ctrl: true }); await app.render(); expect(selected(app)).toContain("Runtime reconnecting");
  } finally { await app.close(); }
});

test("Session failures remain readable after session closure without acknowledging results", async () => {
  // A toast's original session can disappear while its retained diagnostic must stay available.
  const acknowledged: string[] = [];
  const app = await mount({ getSessionDetails: () => ({ status: "failure", output: "", error: "Original failure detail", conversationId: "conversation" }),
    onAcknowledge: async id => { acknowledged.push(id); return ok(undefined); } });
  try {
    app.view.notifySession({ id: "result", sessionId: "a1", worktreeId: "demo:main", conversationId: "conversation", repository: "radian", worktree: "radian", branch: "main",
      result: { id: "result", outcome: "error", completedAt: 1000, request: { text: "Failed task", images: 0, files: 0 } } });
    app.selection.replaceSnapshot(app.selection.snapshot.map(repo => ({ ...repo, worktrees: repo.worktrees.map(tree => ({ ...tree, sessions: tree.sessions.filter(session => session.id !== "a1") })) })));
    app.open(); app.mockInput.pressEnter(); await app.render();

    expect(app.captureCharFrame()).toContain("Original failure detail"); expect(app.get("session-notifications").visible).toBe(false);
    expect(acknowledged).toEqual([]); expect(app.selection.sessionId).not.toBe("a1");
  } finally { await app.close(); }
});

test("Held Enter/Esc never resubmits or interrupts work after message focus transitions", async () => {
  // One-shot actions must consume repeats even after details and history have closed.
  let interruptions = 0;
  const app = await mount({ getSessionDetails: () => ({ status: "working", output: "Working", error: null }),
    onInterrupt: async () => { interruptions++; return ok(undefined); } });
  const raw = (event: string) => { const key = parseKeypress(event, { useKittyKeyboard: true }); if (!key) throw new Error("Invalid Kitty key"); app.renderer.keyInput.processParsedKey(key); };
  try {
    app.view.notify("Diagnostic", { level: "error" }); app.open(); await app.render();
    raw("\x1b[13;1u"); raw("\x1b[13;1:2u"); await app.render(); expect(app.get("text-dialog").visible).toBe(true);
    raw("\x1b[27;1u"); raw("\x1b[27;1:2u"); await app.render(); expect(app.get("messages").visible).toBe(true);
    raw("\x1b[27;1:3u"); raw("\x1b[27;1u"); raw("\x1b[27;1:2u"); await app.render();

    expect(app.get("messages").visible).toBe(false); expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
    expect(interruptions).toBe(0); expect(app.sent).toEqual([]); expect(app.view.promptDrafts.a1).toBe("retained draft");
  } finally { await app.close(); }
});

test("Long previews stay bounded through resize while copying retains the complete original", async () => {
  // Native list buffers need only a viewport-wide preview, not thousands of source characters.
  const app = await mount(), original = "한글 👩🏽‍💻 diagnostic ".repeat(1000);
  try {
    app.view.notify(original, { level: "error" }); app.open(); await app.render();
    for (const width of [120, 60, 120]) {
      app.resize(width, 24); await app.render();
      const preview = selected(app);
      expect(preview).toContain("…");
      for (const line of preview.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(app.get("messages-panel").width - 2);
    }
    app.mockInput.pressKey("y", { ctrl: true }); await app.render();

    expect(app.copies).toEqual([original]); expect(app.get("session-notifications").visible).toBe(false);
    const listeners = app.renderer.listenerCount("focused_renderable"); app.get("messages").destroyRecursively();
    expect(app.renderer.listenerCount("focused_renderable")).toBe(listeners - 1);
    app.view.notify("Late diagnostic", { level: "error" }); await app.render();
  } finally { await app.close(); }
});
