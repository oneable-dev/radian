import { openWorkspaceSearch, pressLeader } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { EditBufferRenderable, InputRenderable, ScrollBoxRenderable, TextRenderable, type Renderable } from "@opentui/core";
import type { TranscriptSection } from "../../agents/transcript.ts";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { ok } from "../../result.ts";
import type { ExecutionState } from "../../agents/session-registry.ts";
import { uiTheme } from "../../ui/theme.ts";
import { icons } from "../../icons.ts";

async function fixture(options: Partial<WorkbenchActions> = {}) {
  const clock = new ManualClock(), app = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true, clock });
  const result = { id: "result-b", outcome: "complete" as const, completedAt: 1000, request: { text: "Fix authentication", images: 0, files: 0 } };
  const repositories = demoWorkspace().map(repo => ({ ...repo, worktrees: repo.worktrees.map(tree => tree.id === "demo:feature"
    ? { ...tree, sessions: [{ id: "b1", name: "opaque", status: "complete" as const, subagents: [], request: result.request, result, attention: result }] } : tree) }));
  const selection = new WorkspaceSelection(repositories), acknowledged: string[] = [], submitted: string[] = [], lookups: string[] = [];
  const states: Record<string, ExecutionState> = {
    a1: { conversationId: "conv-a", status: "working", output: "ACTIVE BODY", error: null },
    b1: { conversationId: "conv-b", status: "complete", error: null, output: "", request: result.request, result, attention: result,
      sections: [{ id: "request", kind: "user", title: "You", text: "Fix authentication", status: "complete" },
        { id: "answer", kind: "assistant", title: "Agent", text: "PREVIEW_RESULT", status: "complete" }] },
  };
  const view = new Workbench(app.renderer, selection, { onNewSession() {}, onCloseSession() {}, initialDrafts: { a1: "KEEP_DRAFT" },
    onPrompt: (_id, text) => { submitted.push(text); return ok(undefined); }, getSessionDetails: id => { lookups.push(id); return states[id] ?? null; },
    onAcknowledge: async (id, _conversation, resultId) => {
      acknowledged.push(resultId);
      const state = states[id]; if (state?.attention?.id === resultId) { const { attention: _attention, ...next } = state; states[id] = next; }
      selection.replaceSnapshot(selection.snapshot.map(repo => ({ ...repo, worktrees: repo.worktrees.map(tree => ({ ...tree, sessions: tree.sessions.map(session => {
        if (session.id !== id || session.attention?.id !== resultId) return session;
        const { attention: _attention, ...next } = session; return next;
      }) })) })));
      return ok(undefined);
    }, ...options });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  const get = (id: string) => { const node = app.renderer.root.findDescendantById(id); if (!node) throw new Error(`Missing ${id}`); return node; };
  const leader = (key: string) => { app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey(key); };
  await render();
  return { ...app, clock, view, selection, states, acknowledged, submitted, lookups, get, render, leader,
    async close() { view.dispose(); await app.dispose(); } };
}

test("Workspace popups preserve work width and switch only on Enter after substring search", async () => {
  // Start with current sessions and drafts open without a permanent sidebar.
  const app = await fixture();
  try {
    const pane = app.get("work-panel"), width = pane.width, prompt = app.get("session-prompt");
    expect(width).toBe(120); expect(app.get("workspace-picker").visible).toBe(false);

    openWorkspaceSearch(app); await app.render();
    await app.mockInput.typeText("rdui"); await app.render();
    expect(app.captureCharFrame()).toContain("No matching workspaces");
    (app.get("workspace-search") as InputRenderable).value = "-ui"; await app.render();
    expect(app.selection.worktree?.id).toBe("demo:main"); expect(pane.width).toBe(width);
    expect(app.captureCharFrame()).toContain("radian-ui");
    app.mockInput.pressEnter(); await app.render();

    expect(app.selection.worktree?.id).toBe("demo:feature"); expect(app.get("workspace-picker").visible).toBe(false);
    expect(app.view.promptDrafts.a1).toBe("KEEP_DRAFT"); expect(app.submitted).toEqual([]); expect(prompt.isDestroyed).toBe(false);
  } finally { await app.close(); }
});

test("Workspace popup Esc/Tab preserve original focus, selection, and conversation positions", async () => {
  // Cancellation must not activate the browsed workspace candidate.
  const app = await fixture();
  try {
    const prompt = app.get("session-prompt"); prompt.focus();
    app.leader("b"); await app.render();
    app.mockInput.pressKey("n", { ctrl: true }); await app.render();
    for (let index = 0; index < 6; index++) { app.mockInput.pressTab(); await app.render(); expect(["workspace-search", "workspace-tree"]).toContain(app.renderer.currentFocusedRenderable?.id ?? ""); }
    await app.mockMouse.click(0, 0); await app.render();
    expect(app.get("workspace-picker").visible).toBe(true);
    app.mockInput.pressEscape(); await app.render();

    expect(app.selection.worktree?.id).toBe("demo:main"); expect(app.renderer.currentFocusedRenderable).toBe(prompt);
    expect(app.view.promptDrafts.a1).toBe("KEEP_DRAFT");
  } finally { await app.close(); }
});

test.each([
  ["search", "control"], ["workspace", "control"],
  ["search", "arrows"], ["workspace", "arrows"], ["workspace", "vim"],
] as const)("Workspace %s focus supports %s candidate-only navigation with Enter confirmation", async (focus, navigation) => {
  // Search and results browse identical candidates while preserving current sessions/drafts.
  const app = await fixture();
  try {
    app.leader("b"); await app.mockInput.typeText("radian");
    if (focus === "workspace") app.mockInput.pressTab();
    await app.render();
    const input = app.get("workspace-search") as InputRenderable;
    const move = (next: boolean) => {
      if (navigation === "control") app.mockInput.pressKey(next ? "n" : "p", { ctrl: true });
      else if (navigation === "arrows") app.mockInput.pressArrow(next ? "down" : "up");
      else app.mockInput.pressKey(next ? "j" : "k");
    };

    // Move down twice; a single round-trip cannot detect missing previous/next bindings.
    move(true); move(true); move(false); await app.render();

    expect(app.selection.worktree?.id).toBe("demo:main");
    expect(app.renderer.currentFocusedRenderable?.id).toBe(focus === "search" ? "workspace-search" : "workspace-tree");
    expect(input.value).toBe("radian"); expect(app.view.promptDrafts.a1).toBe("KEEP_DRAFT");
    app.mockInput.pressEnter(); await app.render();

    expect(app.selection.worktree?.id).toBe("demo:feature"); expect(app.get("workspace-picker").visible).toBe(false);
    expect(app.submitted).toEqual([]);
  } finally { await app.close(); }
});

test("Search focus changes preserve open-popup input and only reopening after selection resets it", async () => {
  // Distinguish restoring search focus from starting new search sessions.
  const app = await fixture();
  try {
    app.leader("b"); await app.mockInput.typeText("-ui"); await app.render();
    const input = app.get("workspace-search") as InputRenderable;
    app.mockInput.pressTab(); openWorkspaceSearch(app); await app.render();

    // Moving focus within open popups must not clear queries.
    expect(input.value).toBe("-ui"); expect(app.renderer.currentFocusedRenderable).toBe(input);
    app.mockInput.pressEnter(); await app.render();
    expect(app.selection.worktree?.id).toBe("demo:feature");
    expect(app.get("workspace-picker").visible).toBe(false);

    // Selection closure, like Esc closure, starts the next search empty.
    app.leader("b"); await app.render();
    expect(input.value).toBe(""); expect(app.captureCharFrame()).toContain("radian-ui");
    expect(app.view.promptDrafts.a1).toBe("KEEP_DRAFT"); expect(app.submitted).toEqual([]);
  } finally { await app.close(); }
});

test("Workspace hints omit default navigation in both search and results focus", async () => {
  // Ctrl+N/P and j/k keep working without repetitive footer hints.
  const app = await fixture();
  const footer = () => app.captureCharFrame().split("\n")[app.renderer.height - 1]!;
  try {
    app.leader("b"); await app.render();

    expect(footer()).not.toMatch(/Navigate|<C-[np]>/u);
    expect(footer()).not.toMatch(/[↑↓]/u);
    app.mockInput.pressTab(); await app.render();

    expect(footer()).not.toContain("k/j Navigate"); expect(footer()).not.toMatch(/[↑↓]/u);
    expect(footer()).toContain("Help");
  } finally { await app.close(); }
});

test("Monitor candidates show status and scope above muted quoted requests", async () => {
  // Two-line candidates mirror the composer status without repeating state labels or list chrome.
  const app = await fixture();
  try {
    app.resize(180, 30); app.leader("s"); await app.render();

    // One blank row separates search from candidates; each status stays beside its scope, not the request.
    const list = app.get("monitor-list"), search = app.get("monitor-search-field"), row = app.get("monitor:b1"), next = app.get("monitor:a1");
    const caption = app.get("monitor-caption:b1"), scope = app.get("monitor-scope:b1"), marker = app.get("monitor-status:b1");
    if (!(caption instanceof TextRenderable) || !(scope instanceof TextRenderable)) throw new Error("Missing session labels");
    expect(row.height).toBe(2); expect(next.height).toBe(2); expect(next.y).toBe(row.y + 2);
    expect(list.y).toBe(search.y + search.height + 1); expect(row.y).toBe(list.y);
    expect(scope.plainText).toBe(`${icons.folder} radian-ui · ${icons.branch} feature/workspace`); expect(scope.y).toBe(row.y);
    expect(marker.y).toBe(row.y); expect(scope.x).toBe(marker.x + marker.width + 1);
    expect(caption.plainText).toBe("“Fix authentication”"); expect(caption.y).toBe(row.y + 1); expect(caption.x).toBe(row.x);
    expect(marker.visible).toBe(true); expect(app.get("monitor-status:a1").visible).toBe(true);
    expect(app.get("monitor-message").visible).toBe(false);
    const listText = app.captureCharFrame().split("\n").slice(list.y, list.y + list.height).map(line => line.slice(list.x, list.x + list.width)).join("\n");
    expect(listText).not.toMatch(/Needs attention|Working|Completed|sessions ·|Preview does not|radian \[demo\]/u);
    const styles = uiTheme(app.renderer).styles;
    const scopeSpan = app.captureSpans().lines[scope.y]!.spans.find(span => span.text.includes("feature/workspace"));
    const requestSpan = app.captureSpans().lines[caption.y]!.spans.find(span => span.text.includes("“Fix authentication”"));
    expect(scopeSpan?.fg.toInts()).toEqual(styles["ui.label"].fg.toInts());
    expect(requestSpan?.fg.toInts()).toEqual(styles["ui.muted"].fg.toInts());
    expect(scopeSpan?.bg.toInts()).toEqual(styles["ui.selection"].bg!.toInts());
    expect(requestSpan?.bg.toInts()).toEqual(styles["ui.selection"].bg!.toInts());
    expect(app.acknowledged).toEqual([]); expect(app.submitted).toEqual([]);
  } finally { await app.close(); }
});

test("Long Unicode monitor captions retain both scope fields through resize without changing search or selection", async () => {
  // Render only viewport-sized captions while matching against the complete original request.
  const app = await fixture();
  const request = { text: `${"한글 👩‍💻 e\u0301\n ".repeat(40)}unicode-target`, images: 0, files: 0 };
  try {
    app.selection.replaceSnapshot(app.selection.snapshot.map(repo => ({ ...repo, worktrees: repo.worktrees.map(tree => tree.id === "demo:feature"
      ? { ...tree, name: "작업트리-이름이-매우-긴-경우", branch: "feature/유니코드-브랜치-이름", sessions: tree.sessions.map(session => ({ ...session, request })) } : tree) })));
    app.leader("s"); await app.mockInput.typeText("unicode-target"); app.mockInput.pressArrow("left"); await app.render();
    const search = app.get("monitor-search") as InputRenderable, caret = search.cursorOffset, row = app.get("monitor:b1");

    // Scope columns remain present even when the request and scope names all need truncation.
    for (const width of [140, 60, 180]) {
      app.resize(width, 30); await app.render();
      const caption = app.get("monitor-caption:b1"), scope = app.get("monitor-scope:b1");
      if (!(caption instanceof TextRenderable) || !(scope instanceof TextRenderable)) throw new Error("Missing session labels");
      const parts = scope.plainText.split(" · ");
      expect(parts).toHaveLength(2); expect(parts.every(part => part.length > 0)).toBe(true);
      expect(parts[0]).toStartWith(`${icons.folder} 작업`); expect(parts[1]).toStartWith(`${icons.branch} feat`);
      expect(Bun.stringWidth(scope.plainText)).toBeLessThanOrEqual(row.width - app.get("monitor-status:b1").width - 1);
      expect(caption.plainText).toStartWith("“한글"); expect(caption.plainText).toEndWith("…”");
      expect(Bun.stringWidth(caption.plainText)).toBeLessThanOrEqual(row.width);
      expect(caption.plainText + scope.plainText).not.toMatch(/[\r\n\uFFFD]/u); expect(row.height).toBe(2);
      expect(app.get("monitor:b1")).toBe(row); expect(search.value).toBe("unicode-target"); expect(search.cursorOffset).toBe(caret);
    }
    app.mockInput.pressEnter(); await app.render();
    expect(app.selection.sessionId).toBe("b1"); expect(app.acknowledged).toEqual(["result-b"]); expect(app.submitted).toEqual([]);
  } finally { await app.close(); }
});

test("Monitor row loading follows Fast and compaction state without losing caption space or selection", async () => {
  // The same background session changes modes without replacing its list candidate.
  const app = await fixture(), original = app.states.b1!;
  const update = async (fast: boolean, activity?: ExecutionState["activity"]) => {
    app.states.b1 = { ...original, status: "working", ...(activity ? { activity } : {}),
      telemetry: { provider: "fixture", model: "fixture-model", effort: "high", fast, context: null, weekly: null } };
    app.selection.replaceSnapshot(app.selection.snapshot.map(repo => ({ ...repo, worktrees: repo.worktrees.map(tree => ({ ...tree,
      sessions: tree.sessions.map(session => session.id === "b1" ? { ...session, status: "working" as const } : session),
    })) })));
    await app.render();
  };
  const glyphs = () => {
    const node = app.get("monitor-status:b1");
    return app.captureCharFrame().split("\n")[node.y]!.slice(node.x, node.x + node.width);
  };
  try {
    app.resize(180, 30); await update(true); app.leader("s"); await app.render();
    const row = app.get("monitor:b1"), marker = app.get("monitor-status:b1"), scope = app.get("monitor-scope:b1"), caption = app.get("monitor-caption:b1");
    if (!(caption instanceof TextRenderable) || !(scope instanceof TextRenderable)) throw new Error("Missing session labels");

    // Fast uses the session's three-cell arrows and active-arrow theme color, not the default spinner.
    expect(glyphs()).toBe("▶▷▷"); expect(marker.width).toBe(3);
    expect(scope.x).toBe(marker.x + 4); expect(scope.y).toBe(marker.y);
    expect(caption.x).toBe(row.x); expect(caption.y).toBe(marker.y + 1);
    const arrow = app.captureSpans().lines[marker.y]!.spans.find(span => span.text.includes("▶"));
    expect(arrow?.fg.toInts()).toEqual(uiTheme(app.renderer).styles["metadata.fastOn"].fg.toInts());
    app.clock.advance(80); await app.render(); expect(glyphs()).toBe("▷▶▷");

    // Compaction overrides Fast; mode changes preserve both the native row and available caption width.
    await update(true, "compacting");
    const runLoading = app.get("monitor-preview-agent-view").findDescendantById("agent-run-loading");
    if (!runLoading) throw new Error("Missing preview run activity");
    const sessionActivity = app.captureCharFrame().split("\n")[runLoading.y]!.slice(runLoading.x, runLoading.x + runLoading.width);
    expect(glyphs()).toBe(sessionActivity); expect(glyphs()).not.toMatch(/[▶▷]/u); expect(marker.width).toBe(runLoading.width);
    await update(false); expect(marker.width).toBe(1); expect(glyphs()).not.toMatch(/[▶▷]/u);
    expect(scope.x).toBe(marker.x + 2); expect(caption.x).toBe(row.x);
    expect(scope.plainText).toBe(`${icons.folder} radian-ui · ${icons.branch} feature/workspace`); expect(caption.plainText).toBe("“Fix authentication”");
    expect(Bun.stringWidth(scope.plainText)).toBeLessThanOrEqual(scope.width);
    expect(Bun.stringWidth(caption.plainText)).toBeLessThanOrEqual(caption.width);
    expect(app.get("monitor:b1")).toBe(row); expect(app.selection.sessionId).toBe("a1");
    expect(app.acknowledged).toEqual([]); expect(app.submitted).toEqual([]);
  } finally { await app.close(); }
});

test("Monitor previews and browsing never acknowledge; only sessions opened with Enter do", async () => {
  // Separate another workspace's unread results from the current conversation.
  const app = await fixture();
  try {
    app.leader("s"); await app.render();
    expect(app.get("session-monitor").visible).toBe(true); expect(app.captureCharFrame()).toContain("PREVIEW_RESULT");
    expect(app.captureCharFrame()).not.toContain("Needs attention"); expect(app.get("monitor-message").visible).toBe(false); expect(app.acknowledged).toEqual([]);
    expect(app.selection.sessionId).toBe("a1");
    app.mockInput.pressKey("n", { ctrl: true }); await app.render();
    app.mockInput.pressKey("p", { ctrl: true }); await app.render();
    expect(app.acknowledged).toEqual([]);

    app.mockInput.pressEnter(); await app.render();

    expect(app.selection.sessionId).toBe("b1"); expect(app.selection.worktree?.id).toBe("demo:feature");
    expect(app.get("session-monitor").visible).toBe(false); expect(app.acknowledged).toEqual(["result-b"]);
    expect(app.states.b1?.result?.outcome).toBe("complete"); expect(app.view.promptDrafts.a1).toBe("KEEP_DRAFT");
    expect(app.submitted).toEqual([]);
    app.leader("s"); await app.render(); expect(app.renderer.root.findDescendantById("monitor:b1")).toBeUndefined();
  } finally { await app.close(); }
});

test.each(["search", "list"] as const)("Opening sessions from monitor %s shows latest output and resumes draft input immediately", async focus => {
  // A saved older viewport must not prevent opening the latest result or restoring its draft.
  const app = await fixture({
    initialDrafts: { a1: "KEEP_DRAFT", b1: "NEXT_DRAFT" },
    initialWorkViews: { active: {}, agentScroll: { b1: 0 }, agentViews: {
      b1: { selectedId: "request", folded: {}, cursors: {}, mode: "sections", anchor: null, follow: false },
    } },
  });
  try {
    app.states.b1 = { ...app.states.b1!, sections: [
      { id: "request", kind: "user", title: "You", text: "OLDER_CONTENT\n".repeat(80), status: "complete" },
      { id: "answer", kind: "assistant", title: "Agent", text: "LATEST_RESULT", status: "complete" },
    ] };

    // Both search and list confirmation must hand keyboard ownership to the selected session's input.
    app.leader("s"); await app.mockInput.typeText("auth");
    if (focus === "list") app.mockInput.pressTab();
    await app.render();
    app.mockInput.pressEnter(); await app.render();

    // Showing the latest result still acknowledges it without requiring transcript focus.
    const scroll = app.get("session-transcript") as ScrollBoxRenderable;
    expect(app.selection.sessionId).toBe("b1");
    expect(app.get("session-monitor").visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
    expect(app.captureCharFrame()).toContain("LATEST_RESULT");
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.viewport.height);
    expect(scroll.scrollTop).toBe(Math.max(0, scroll.scrollHeight - scroll.viewport.height));
    expect(app.view.workViewPreferences.agentViews?.b1?.follow).toBe(true);
    expect(app.acknowledged).toEqual(["result-b"]);
    expect(app.submitted).toEqual([]);

    // Navigation letters remain literal input, and neither session loses its draft.
    await app.mockInput.typeText(" hjkl"); await app.render();

    expect(app.view.promptDrafts).toEqual({ a1: "KEEP_DRAFT", b1: "NEXT_DRAFT hjkl" });
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
    expect(app.submitted).toEqual([]);
  } finally { await app.close(); }
});

test("Monitor previews include the full session screen and retain complete sections without allowing session actions", async () => {
  // A background session has real telemetry, queued input, an unsent draft and more than six sections.
  const closed: string[] = [];
  const app = await fixture({ initialDrafts: { a1: "KEEP_DRAFT", b1: "PREVIEW_DRAFT" }, onCloseSession: (_tree, id) => { closed.push(id); } });
  const longPrompt = `FIRST_RETAINED_SECTION ${"x".repeat(9000)} RETAINED_TAIL`;
  const sections: TranscriptSection[] = [{ id: "long-request", kind: "user", title: "You", text: longPrompt, status: "complete" },
    ...Array.from({ length: 10 }, (_, index): TranscriptSection => ({ id: `answer-${index}`, kind: "assistant", title: "Agent", text: `Saved answer ${index}`, status: "complete" }))];
  const walk = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(walk)];
  try {
    app.states.b1 = { ...app.states.b1!, status: "working", sections, pendingMessages: [{ text: "Queued follow-up", images: 0, files: 0 }],
      telemetry: { provider: "fixture", model: "preview-model", effort: "high", fast: true, context: { usedTokens: 25000, maxTokens: 100000 }, weekly: null } };
    app.selection.replaceSnapshot(app.selection.snapshot.map(repo => ({ ...repo, worktrees: repo.worktrees.map(tree => ({ ...tree,
      sessions: tree.sessions.map(session => session.id === "b1" ? { ...session, status: "working" } : session),
    })) })));

    // The list owns browsing activity, while the right pane reuses the complete Agent view.
    app.leader("s"); await app.render();
    const preview = app.get("monitor-preview-agent-view"), composer = app.get("monitor-preview-agent-composer");
    expect(app.get("monitor-preview-agent-session-tabs").visible).toBe(true);
    expect(app.get("monitor-preview-session-status").visible).toBe(true);
    expect(app.get("monitor-status:b1").visible).toBe(true);
    expect(app.renderer.root.findDescendantById("monitor-loading")).toBeUndefined();
    const first = walk(preview).find((node): node is EditBufferRenderable => node instanceof EditBufferRenderable && node.plainText === longPrompt);
    expect(first).toBeDefined(); expect(first!.focusable).toBe(false);
    expect(app.captureCharFrame()).toContain("preview-model"); expect(app.captureCharFrame()).toContain("Queued follow-up");
    expect(app.captureCharFrame()).toContain("PREVIEW_DRAFT"); expect(app.captureCharFrame()).not.toContain("Preview truncated");

    // A displayed composer and close control are inert, not a second editing or session-selection surface.
    await app.mockMouse.click(composer.x + 1, composer.y + 1); await app.mockInput.typeText("zzzz");
    await app.mockInput.pasteBracketedText("must not enter a draft"); await app.render();
    const close = app.get("monitor-preview-close-session:b1"); await app.mockMouse.click(close.x, close.y); await app.render();
    expect(app.view.promptDrafts).toEqual({ a1: "KEEP_DRAFT", b1: "PREVIEW_DRAFT" });
    expect(app.selection.sessionId).toBe("a1"); expect(closed).toEqual([]); expect(app.acknowledged).toEqual([]); expect(app.submitted).toEqual([]);
  } finally { await app.close(); }
});

test("Monitor updates retain selection/list nodes and never query previews while closed", async () => {
  // Streaming changes selected conversation content, not candidate-list structure.
  const app = await fixture();
  try {
    app.leader("s"); await app.render(); const row = app.get("monitor:b1");
    app.states.b1 = { ...app.states.b1!, sections: [{ id: "answer", kind: "assistant", title: "Agent", text: "UPDATED_PREVIEW", status: "streaming" }] };
    app.selection.replaceSnapshot(structuredClone(app.selection.snapshot)); await app.render();

    expect(app.get("monitor:b1")).toBe(row); expect(app.captureCharFrame()).toContain("UPDATED_PREVIEW");
    app.mockInput.pressEscape(); await app.render();
    expect(app.get("session-monitor").visible).toBe(false); expect(app.acknowledged).toEqual([]);
    app.lookups.length = 0; app.selection.replaceSnapshot(app.selection.snapshot); await app.render();
    expect(app.lookups).not.toContain("b1");
  } finally { await app.close(); }
});

test("Compact monitors switch lists/previews like History while preserving search input", async () => {
  // Never force two columns into narrow terminals.
  const app = await fixture();
  try {
    app.resize(60, 14); app.leader("s"); await app.render();
    await app.mockInput.typeText("auth"); await app.render();
    expect(app.get("monitor-list").visible).toBe(true); expect(app.get("monitor-preview-pane").visible).toBe(false);

    app.mockInput.pressKey("o", { ctrl: true }); await app.render();

    expect(app.get("monitor-preview-pane").visible).toBe(true);
    // Very short previews keep normal session controls; a taller viewport reveals the transcript.
    expect(app.get("monitor-preview-session-status").height).toBe(3);
    app.resize(60, 22); await app.render(); expect(app.captureCharFrame()).toContain("PREVIEW_RESULT");
    expect((app.get("monitor-search") as InputRenderable).value).toBe("auth"); expect(app.acknowledged).toEqual([]);
  } finally { await app.close(); }
});

test("Stopped tabs prioritize one question mark over bells regardless of acknowledgement", async () => {
  // Stopped is an outcome independent of unread state.
  const app = await fixture();
  try {
    const stopped = { id: "stopped", outcome: "unfinished" as const, completedAt: 2000 };
    app.selection.replaceSnapshot(app.selection.snapshot.map(repo => ({ ...repo, worktrees: repo.worktrees.map(tree => ({ ...tree, sessions: tree.sessions.map(session => session.id === "a2"
      ? { ...session, status: null, result: stopped, attention: stopped } : session) })) })));
    await app.render();
    const tab = app.get("session:demo:main:a2"), region = () => app.captureCharFrame().split("\n")[tab.y]!.slice(tab.x, tab.x + tab.width);

    expect(region()).toBe("  2. ? a2       × ");
    expect(app.selection.worktree?.sessions.find(session => session.id === "a2")?.attention?.id).toBe("stopped");
    const colorAt = (column: number) => {
      let x = 0; return app.captureSpans().lines[tab.y]!.spans.find(span => { x += span.width; return x > column; })!.fg.toInts();
    };
    expect(colorAt(tab.x + 5)).toEqual(uiTheme(app.renderer).colors.error.toInts());
    app.selection.replaceSnapshot(app.selection.snapshot.map(repo => ({ ...repo, worktrees: repo.worktrees.map(tree => ({ ...tree, sessions: tree.sessions.map(session => {
      if (session.id !== "a2") return session;
      const { attention: _attention, ...next } = session; return next;
    }) })) })));
    await app.render();
    // Acknowledgement retains the interruption question mark and error color.
    expect(region()).toBe("  2. ? a2       × ");
    expect(colorAt(tab.x + 5)).toEqual(uiTheme(app.renderer).colors.error.toInts());
  } finally { await app.close(); }
});

test("Background and historical positions acknowledge only when results actually become visible", async () => {
  // Restored selection alone does not prove users read unread results.
  const app = await fixture();
  try {
    app.renderer.emit("blur"); app.selection.selectSession("demo:feature", "b1"); await app.render();
    expect(app.acknowledged).toEqual([]);
    app.states.b1 = { ...app.states.b1!, sections: [{ id: "answer", kind: "assistant", title: "Agent", text: Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n"), status: "complete" }] };
    app.selection.replaceSnapshot(app.selection.snapshot); await app.render();
    const scroll = app.get("session-transcript") as ScrollBoxRenderable; scroll.scrollTo(0); await app.render();
    app.renderer.emit("focus"); await app.render();
    expect(app.acknowledged).toEqual([]);

    pressLeader(app, "["); app.mockInput.pressKey("g"); app.mockInput.pressKey("e"); await app.render();

    expect(app.acknowledged).toEqual(["result-b"]);
  } finally { await app.close(); }
});

test("Large monitors report rendering limits and search still reaches later sessions", async () => {
  // Collect all summaries but limit native row creation like History.
  const app = await fixture();
  try {
    const sessions = Array.from({ length: 250 }, (_, index) => ({ id: `bulk-${index}`, name: index === 249 ? "Last special task" : `Bulk ${index}`, status: "working" as const, subagents: [] }));
    app.selection.replaceSnapshot(app.selection.snapshot.map(repo => ({ ...repo, worktrees: repo.worktrees.map(tree => tree.id === "demo:main" ? { ...tree, sessions: [...tree.sessions, ...sessions] } : tree) })));

    app.leader("s"); await app.render();
    // Left-column clipping requires checking displayed counts and complete hint content.
    expect(app.captureCharFrame()).toContain("Showing first 200 of 252 sessions");
    const message = app.get("monitor-message"); if (!(message instanceof TextRenderable)) throw new Error("Missing monitor summary");
    expect(message.plainText).toBe("Showing first 200 of 252 sessions; refine search");
    expect(app.renderer.root.findDescendantById("monitor:bulk-249")).toBeUndefined();
    await app.mockInput.typeText("special last"); await app.render();

    expect(app.get("monitor:bulk-249")).toBeDefined(); expect(app.captureCharFrame()).toContain("Last special task"); expect(app.acknowledged).toEqual([]);
    expect(message.visible).toBe(false);
  } finally { await app.close(); }
});

test("Cancelling repository-free popups restores Help instead of hidden search focus", async () => {
  // With no session or PTY to restore, keys must not remain in hidden inputs.
  const app = await createTestRenderer({ width: 60, height: 12, kittyKeyboard: true });
  const view = new Workbench(app.renderer, new WorkspaceSelection([]), { onNewSession() {}, onCloseSession() {} });
  try {
    await app.renderOnce(); openWorkspaceSearch(app); await app.renderOnce();
    app.mockInput.pressEscape(); await app.renderOnce();

    expect(app.renderer.root.findDescendantById("workspace-picker")!.visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("footer-help");
  } finally { view.dispose(); await app.dispose(); }
});
