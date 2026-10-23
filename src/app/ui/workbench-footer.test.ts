import { openWorkspaceSearch, pressLeader } from "../../testing/keys.ts";
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

test("Default screens use content through the footer without fixed legends or hint rows", async () => {
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

test.each([120, 60])("Width %i prompts retain newline, interrupt, and submit behavior without default hints", async width => {
  // Omit hints regardless of footer width even for runs supporting interruption.
  let interruptions = 0;
  const app = await mount(undefined, { onInterrupt: async () => { interruptions++; return ok(undefined); } });
  try {
    app.resize(width, 24); pressLeader(app, "a");
    await app.mockInput.typeText("first"); app.mockInput.pressEnter({ shift: true });
    await app.mockInput.typeText("second"); await app.renderOnce();

    // Hiding defaults preserves input semantics and active-work submission routing.
    for (const state of ["complete", "working"] as const) {
      app.setStatus(state); await app.renderOnce();
      expect(app.footerLine()).not.toMatch(/Run|Queue|New line|Interrupt|<C-[cnp]>/u);
      expect(app.footerLine()).toContain("<F1>");
      expect(app.view.promptDrafts.a1).toBe("first\nsecond");
    }
    app.mockInput.pressEscape(); await app.renderOnce();
    expect(interruptions).toBe(1); expect(app.view.promptDrafts.a1).toBe("first\nsecond");
    app.mockInput.pressEnter(); await app.waitFor(() => app.view.promptDrafts.a1 === undefined);

    // Interrupt retains drafts; only one Enter creates actual submission requests.
    expect(app.calls).toEqual(["prompt:first\nsecond"]);
  } finally { await app.close(); }
});

test("Trees and search retain focus navigation and literal typing without default hints", async () => {
  // Moving between lists and search must not resurrect hidden navigation hints.
  const app = await mount();
  try {
    openWorkspaceSearch(app); app.mockInput.pressTab(); await app.renderOnce();
    expect(app.footerLine()).not.toMatch(/<CR>|Navigate|½ page|Close|First\/last/u);
    expect(app.footerLine()).toContain("<F1> Help");

    openWorkspaceSearch(app); await app.renderOnce();
    await app.mockInput.typeText("nxq"); await app.renderOnce();

    expect(app.footerLine()).not.toMatch(/<CR>|<Esc>|<C-[np]>|Navigate/u);
    expect(app.footerLine()).not.toContain("New session");
    expect(app.calls).toEqual([]);
    app.mockInput.pressCtrlC(); app.mockInput.pressTab(); await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-tree");
    expect(app.footerLine()).toContain("<F1> Help");
  } finally { await app.close(); }
});

test("History hints only Preview/Refresh while preserving lookup and selection", async () => {
  // Late metadata must not restore default open/navigation hints.
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

test("Prompt availability and separate errors preserve hints, drafts, and selection", async () => {
  // Omit default draft clearing while retaining app-specific movement hints in every send state.
  const app = await mount();
  try {
    pressLeader(app, "a"); await app.renderOnce();
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

test("Compact hidden-panel layouts keep footer/notifications at bottom and clicks preserve selection", async () => {
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
    expect(app.footerLine()).toContain("<leader>[ Transcript");
  } finally { await app.close(); }
});

test("Prompts and status align to the work-area left without sidebar space", async () => {
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

test("Regular layout padding shrinks in compact screens and restores alongside drafts", async () => {
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
    pressLeader(app, "a"); await app.mockInput.typeText("keep this draft");
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

test("Short terminals keep Agent status/input clear of single-row footers", async () => {
  // Height changes retain the same composer treatment and keep usable input above the footer.
  const app = await mount();
  try {
    pressLeader(app, "a"); await app.mockInput.typeText("compact draft");

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

test("Blur and disposal leave neither stale shortcuts nor focus subscriptions", async () => {
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
