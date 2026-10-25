import { pressLeader } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { CodeRenderable, EditBufferRenderable, ScrollBoxRenderable, type Renderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { TranscriptSection } from "../../agents/transcript.ts";
import type { ExpectedError } from "../../errors.ts";
import { ok, type Result } from "../../result.ts";
import { parseKeymap, type Keymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";
import { uiTheme } from "../../ui/theme.ts";

const section = (id: string, text: string, kind: TranscriptSection["kind"] = "assistant"): TranscriptSection => ({ id, kind, title: kind, text, status: "complete" });
const history = [section("history", Array.from({ length: 70 }, (_, i) => `OLD-LINE-${i}`).join("\n"))];
function children(node: Renderable): Renderable[] { return node.getChildren().flatMap((child) => [child, ...children(child)]); }
async function mount(options: { paused?: boolean; completed?: boolean; keymap?: Keymap; onPrompt?: (id: string, text: string) => Result<void, ExpectedError> | Promise<Result<void, ExpectedError>> } = {}) {
  const app = await createTestRenderer({ width: 120, height: 26, kittyKeyboard: true });
  const snapshot = () => demoWorkspace().map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => ({ ...tree,
    sessions: tree.sessions.map((session) => options.completed ? { ...session, subagents: [] } : session),
  })) }));
  const selection = new WorkspaceSelection(snapshot()), sent: string[] = [];
  const data: Record<string, readonly TranscriptSection[]> = { a1: options.completed ? [{ ...history[0]!, completion: {
    startedAt: 0, completedAt: 1000, durationMs: 1000, outcome: "complete",
  } }] : history, b1: [section("other", "OTHER_SESSION\n".repeat(60))] };
  const view = new Workbench(app.renderer, selection, { onNewSession: () => {}, onCloseSession: () => {}, ...(options.keymap ? { keymap: options.keymap } : {}),
    initialWorkViews: { active: {}, agentScroll: options.paused ? { a1: 0 } : {}, agentViews: { a1: { selectedId: "history", folded: { tool: false }, cursors: {}, mode: "sections", anchor: null, follow: !options.paused } } },
    onPrompt: (id, text) => {
      sent.push(`${id}:${text}`);
      if (options.onPrompt) return options.onPrompt(id, text);
      data[id] = [...data[id] ?? [], section(`prompt-${sent.length}`, text, "user")]; selection.replaceSnapshot(snapshot());
      return ok(undefined);
    }, getSessionDetails: (id) => ({ status: options.completed ? "complete" : "working", error: null, output: "", sections: data[id] ?? [] }),
  });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  const settled = async () => { await render(); for (let i = 0; i < 3; i++) { await Promise.all(children(app.renderer.root).filter((node): node is CodeRenderable => node instanceof CodeRenderable).map((node) => node.highlightingDone)); await render(); } };
  await settled();
  const scroll = app.renderer.root.findDescendantById("session-transcript"); if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("Missing transcript");
  return { ...app, view, selection, scroll, sent, render, settled,
    state(id = selection.sessionId ?? "a1") { return view.workViewPreferences.agentViews?.[id]; },
    async prompt(text: string) { pressLeader(app, "a"); await app.mockInput.typeText(text); app.mockInput.pressEnter(); await settled(); },
    async update(next: readonly TranscriptSection[], id = selection.sessionId ?? "a1") { data[id] = next; selection.replaceSnapshot(snapshot()); await settled(); },
    async close() { view.dispose(); await app.dispose(); },
  };
}
const bottom = (scroll: ScrollBoxRenderable) => Math.max(0, scroll.scrollHeight - scroll.viewport.height);

test("Long AI conversations use full width without vertical scrollbars while retaining wheel and keyboard navigation", async () => {
  // Overflowing conversations must not retain an empty scrollbar column.
  const app = await mount();
  const verify = () => {
    expect(app.scroll.scrollHeight).toBeGreaterThan(app.scroll.viewport.height);
    expect(app.scroll.verticalScrollBar.visible).toBe(false);
    expect(app.scroll.viewport.width).toBe(app.scroll.width);
  };
  try {
    verify();
    pressLeader(app, "a"); await app.mockInput.typeText("Unsent scrollbar draft"); await app.settled();

    // The rightmost body column accepts wheel input and new results preserve reading positions.
    await app.mockMouse.scroll(app.scroll.viewport.x + app.scroll.viewport.width - 1, app.scroll.y + 3, "up"); await app.settled();
    const position = app.scroll.scrollTop;
    expect(position).toBeLessThan(bottom(app.scroll)); expect(app.state()?.follow).toBe(false);
    await app.update([...history, section("new", "SCROLLBAR_FREE_TAIL")]);
    expect(app.scroll.scrollTop).toBe(position); expect(app.state()?.follow).toBe(false);
    pressLeader(app, "["); app.mockInput.pressKey("END", { ctrl: true }); await app.settled();
    expect(app.state()?.follow).toBe(true); expect(app.scroll.scrollTop).toBe(bottom(app.scroll));
    expect(app.captureCharFrame()).toContain("SCROLLBAR_FREE_TAIL");

    // Resize, themes, and screen round-trips must not reenable native bars.
    app.resize(80, 18); await app.settled(); verify();
    uiTheme(app.renderer).configure({ palette: [], defaultForeground: "#202020", defaultBackground: "#FAFAF6",
      cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null,
      highlightForeground: null, highlightBackground: null });
    await app.settled(); verify();
    app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("e"); await app.settled();
    app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("a"); await app.settled(); verify();
    expect(app.view.promptDrafts.a1).toBe("Unsent scrollbar draft"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test.each([false, true])("At brightness %j, return-to-bottom controls use existing gaps without covering body, status, or input", async (light) => {
  // Showing controls must not resize body or input in following conversations.
  const app = await mount();
  try {
    uiTheme(app.renderer).configure({ palette: [], defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
      cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null, highlightForeground: null, highlightBackground: null });
    pressLeader(app, "a"); await app.mockInput.typeText("Unsent draft"); await app.settled();
    const composer = app.renderer.root.findDescendantById("agent-composer")!;
    const prompt = app.renderer.root.findDescendantById("session-prompt")!;
    const status = app.renderer.root.findDescendantById("transcript-status-row")!;
    const geometry = [app.scroll.height, app.scroll.viewport.height, app.scroll.scrollHeight, status.y, composer.y, prompt.y];
    expect(app.captureCharFrame()).not.toContain("Back to bottom");

    // Scrolling up reveals clickable controls; right-click is not navigation.
    await app.mockMouse.scroll(app.scroll.x + 3, app.scroll.y + 3, "up"); await app.settled();
    expect(app.captureCharFrame()).toContain("↓ Back to bottom · G");
    const button = app.renderer.root.findDescendantById("transcript-bottom-button");
    if (!button) throw new Error("Missing back-to-bottom button");
    const viewport = app.scroll.viewport;
    expect(Math.abs(button.x + button.width / 2 - viewport.x - viewport.width / 2)).toBeLessThanOrEqual(0.5);
    expect(button.y).toBe(viewport.y + viewport.height);
    expect(button.y + 1).toBe(app.renderer.root.findDescendantById("agent-run-status")!.y);
    expect(button.height).toBe(1);
    let end = 0;
    const cell = app.captureSpans().lines[button.y]!.spans.find((span) => { end += span.width; return end > button.x + 1; })!;
    expect(cell.bg.toInts()).toEqual(uiTheme(app.renderer).colors.selected.toInts());
    expect(cell.fg.toInts()).toEqual(uiTheme(app.renderer).colors.accent.toInts());
    const frame = app.captureCharFrame().split("\n");
    expect(frame[viewport.y + viewport.height - 1]).toMatch(/OLD-LINE-\d+/);
    expect(frame[button.y + 2]).toContain("UI review · Working");
    expect([app.scroll.height, viewport.height, app.scroll.scrollHeight, status.y, composer.y, prompt.y]).toEqual(geometry);
    const position = app.scroll.scrollTop;
    await app.mockMouse.click(button.x, button.y, 2); await app.settled();
    expect(app.scroll.scrollTop).toBe(position); expect(app.state()?.follow).toBe(false);

    // Left padding is clickable and returns to bottom without prompting or changing input focus.
    await app.mockMouse.click(button.x, button.y); await app.settled();
    expect(app.scroll.scrollTop).toBe(bottom(app.scroll)); expect(app.state()?.follow).toBe(true);
    expect(app.captureCharFrame()).not.toContain("Back to bottom");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
    expect(app.view.promptDrafts.a1).toBe("Unsent draft"); expect(app.sent).toEqual([]);
    await app.update([...history, section("tail", "BUTTON_RESUMED_TAIL")]);
    expect(app.captureCharFrame()).toContain("BUTTON_RESUMED_TAIL"); expect(app.scroll.scrollTop).toBe(bottom(app.scroll));
  } finally { await app.close(); }
});

test("Return-to-bottom controls display remapped bindings and resume following with the same keys", async () => {
  // Open history with custom section-mode navigation rather than default bindings.
  const keymap = expectOk(parseKeymap({ bindings: { "transcript.latest": [{ keys: "alt+z", scope: "transcript" }] } }));
  const app = await mount({ paused: true, keymap });
  try {
    await app.update([...history, section("tail", "LATE_OUTPUT\n".repeat(70))]);
    pressLeader(app, "["); await app.settled();
    expect(app.captureCharFrame()).toContain("↓ Back to bottom · <M-z>");
    app.mockInput.pressKey("g", { shift: true }); await app.settled();
    expect(app.state()?.selectedId).toBe("history");
    expect(app.state()?.follow).toBe(false); expect(app.scroll.scrollTop).toBeLessThan(bottom(app.scroll));

    // Displayed shortcuts match actual commands and controls disappear at bottom.
    app.mockInput.pressKey("z", { meta: true }); await app.settled();
    expect(app.state()?.follow).toBe(true); expect(app.scroll.scrollTop).toBe(bottom(app.scroll));
    expect(app.captureCharFrame()).not.toContain("Back to bottom");
  } finally { await app.close(); }
});

test("Disabling bottom-navigation keys retains clickable controls without misleading key hints", async () => {
  // Empty binding arrays remove shortcuts without disabling mouse return.
  const keymap = expectOk(parseKeymap({ bindings: { "transcript.latest": [] } }));
  const app = await mount({ paused: true, keymap });
  try {
    expect(app.captureCharFrame()).toContain("↓ Back to bottom");
    expect(app.captureCharFrame()).not.toContain("Back to bottom ·");
    const button = app.renderer.root.findDescendantById("transcript-bottom-button");
    if (!button) throw new Error("Missing back-to-bottom button");

    // Right padding remains clickable without shortcuts.
    await app.mockMouse.click(button.x + button.width - 1, button.y); await app.settled();
    expect(app.state()?.follow).toBe(true); expect(app.scroll.scrollTop).toBe(bottom(app.scroll));
    expect(app.captureCharFrame()).not.toContain("Back to bottom");
  } finally { await app.close(); }
});

test("Help, other screens, empty conversations, and short conversations hide return-to-bottom controls", async () => {
  // Show controls for historical conversations, not help sharing the viewport.
  const app = await mount({ paused: true });
  try {
    expect(app.captureCharFrame()).toContain("Back to bottom");
    pressLeader(app, "["); app.mockInput.pressKey("F1"); await app.settled();
    expect(app.captureCharFrame()).not.toContain("Back to bottom");
    app.mockInput.pressKey("F1"); await app.settled();
    expect(app.captureCharFrame()).toContain("Back to bottom");

    // Screen round-trips keep controls scoped to the active conversation and scroll position.
    app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("e"); await app.settled();
    expect(app.captureCharFrame()).not.toContain("Back to bottom");
    app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("a"); await app.settled();
    expect(app.captureCharFrame()).toContain("Back to bottom");

    // No scroll range leaves neither controls nor fixed empty rows regardless of follow state.
    await app.update([]); expect(app.captureCharFrame()).not.toContain("Back to bottom");
    await app.update([section("short", "SHORT_REPLY")]);
    expect(app.captureCharFrame()).toContain("SHORT_REPLY"); expect(app.captureCharFrame()).not.toContain("Back to bottom");
  } finally { await app.close(); }
});

test("Reading cursors stay clear of return controls and clicking clears selection to follow latest output", async () => {
  // Additional sections mean the final source-screen row is not the conversation bottom.
  const app = await mount();
  try {
    await app.update([...history, section("later", "LATER_SECTION\n".repeat(30))]);
    pressLeader(app, "["); app.mockInput.pressKey("HOME"); app.mockInput.pressEnter(); await app.settled();
    const body = app.renderer.currentFocusedRenderable;
    if (!(body instanceof EditBufferRenderable)) throw new Error("Missing source reader");

    // Source cursors never hide beneath floating controls near viewport bottoms.
    for (let i = 0; i < app.scroll.viewport.height; i++) app.mockInput.pressKey("j");
    await app.settled();
    const button = app.renderer.root.findDescendantById("transcript-bottom-button")!;
    expect(app.captureCharFrame()).toContain("Back to bottom");
    expect(body.y + body.visualCursor.visualRow).toBeLessThan(button.y);
    app.mockInput.pressKey("v"); await app.settled(); expect(app.state()?.mode).toBe("visual");

    // Explicit return clicks end protected selection and restore section mode and following.
    await app.mockMouse.click(button.x + 1, button.y); await app.settled();
    expect(app.state()?.mode).toBe("sections"); expect(app.state()?.follow).toBe(true);
    expect(app.scroll.scrollTop).toBe(bottom(app.scroll));
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-transcript");
    expect(app.captureCharFrame()).not.toContain("Back to bottom");
  } finally { await app.close(); }
});

test("Narrow layouts center controls in existing gaps and hide them when height leaves no gap", async () => {
  // Floating controls in paused conversations must not become scroll content after resize.
  const app = await mount({ paused: true });
  try {
    app.resize(60, 18); await app.settled();
    const button = app.renderer.root.findDescendantById("transcript-bottom-button")!;
    const viewport = app.scroll.viewport;
    expect(app.captureCharFrame()).toContain("Back to bottom");
    expect(Math.abs(button.x + button.width / 2 - viewport.x - viewport.width / 2)).toBeLessThanOrEqual(0.5);
    expect(button.y).toBe(viewport.y + viewport.height);
    expect(button.width).toBeLessThanOrEqual(viewport.width);

    // Without existing blank rows, hide controls instead of covering body or input.
    app.resize(60, 8); await app.settled(); expect(app.captureCharFrame()).not.toContain("Back to bottom");
    app.resize(120, 26); await app.settled(); expect(app.captureCharFrame()).toContain("Back to bottom");
    expect(app.state()?.follow).toBe(false);
  } finally { await app.close(); }
});

test("Absent run-status rows place return controls only in existing gaps above input", async () => {
  // Completed sessions retain the input's blank top row without run or subagent status.
  const app = await mount({ paused: true, completed: true });
  try {
    const status = app.renderer.root.findDescendantById("transcript-status-row")!;
    const composer = app.renderer.root.findDescendantById("agent-composer")!;
    const prompt = app.renderer.root.findDescendantById("session-prompt")!;
    const button = app.renderer.root.findDescendantById("transcript-bottom-button")!;
    const geometry = [app.scroll.viewport.height, app.scroll.scrollHeight, composer.y, prompt.y];
    expect(status.visible).toBe(false); expect(app.captureCharFrame()).toContain("Back to bottom");

    // Use existing rows outside scrolling content without pushing input down.
    expect(button.y).toBeLessThanOrEqual(composer.y);
    expect(button.y).toBe(app.scroll.viewport.y + app.scroll.viewport.height);
    expect(button.y + button.height).toBeLessThanOrEqual(prompt.y);
    pressLeader(app, "a"); await app.mockInput.typeText("Kept draft"); await app.settled();
    await app.mockMouse.click(button.x, button.y); await app.settled();
    expect(app.state()?.follow).toBe(true); expect(app.captureCharFrame()).not.toContain("Back to bottom");
    expect([app.scroll.viewport.height, app.scroll.scrollHeight, composer.y, prompt.y]).toEqual(geometry);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt"); expect(app.view.promptDrafts.a1).toBe("Kept draft");
  } finally { await app.close(); }
});

test("Moving transcript focus at bottom preserves automatic following", async () => {
  const app = await mount();
  try {
    pressLeader(app, "["); await app.settled();
    expect(app.state()?.follow).toBe(true); expect(app.scroll.scrollTop).toBe(bottom(app.scroll));
    await app.update([...history, section("new", "FOCUSED_BOTTOM_TAIL")]);
    expect(app.scroll.scrollTop).toBe(bottom(app.scroll)); expect(app.captureCharFrame()).toContain("FOCUSED_BOTTOM_TAIL");
  } finally { await app.close(); }
});

test("Wheel-scrolling back to bottom resumes following without extra keys", async () => {
  const app = await mount();
  try {
    await app.mockMouse.scroll(app.scroll.x + 3, app.scroll.y + 3, "up"); await app.settled();
    expect(app.state()?.follow).toBe(false);
    await app.mockMouse.scroll(app.scroll.x + 3, app.scroll.y + 3, "down"); await app.settled();
    expect(app.scroll.scrollTop).toBe(bottom(app.scroll)); expect(app.state()?.follow).toBe(true);
    await app.update([...history, section("new", "WHEEL_RESUMED_TAIL")]);
    expect(app.captureCharFrame()).toContain("WHEEL_RESUMED_TAIL"); expect(app.scroll.scrollTop).toBe(bottom(app.scroll));
  } finally { await app.close(); }
});

test("Reaching bottom through hidden scroll models resumes following", async () => {
  const app = await mount();
  try {
    app.scroll.verticalScrollBar.scrollPosition = 0; await app.settled(); expect(app.state()?.follow).toBe(false);
    app.scroll.verticalScrollBar.scrollPosition = bottom(app.scroll); await app.settled();
    expect(app.state()?.follow).toBe(true);
    await app.update([...history, section("new", "BAR_RESUMED_TAIL")]);
    expect(app.scroll.scrollTop).toBe(bottom(app.scroll)); expect(app.captureCharFrame()).toContain("BAR_RESUMED_TAIL");
  } finally { await app.close(); }
});

test.each(["shift+g", "ctrl+end", "g e"] as const)("Section-mode %s reaches the actual end of long final sections and resumes following", async (key) => {
  // Selecting the final section alone cannot reveal its end when it exceeds the viewport.
  const app = await mount({ paused: true });
  try {
    pressLeader(app, "["); await app.settled();

    if (key === "shift+g") app.mockInput.pressKey("g", { shift: true });
    else if (key === "ctrl+end") app.mockInput.pressKey("END", { ctrl: true });
    else { app.mockInput.pressKey("g"); app.mockInput.pressKey("e"); }
    await app.settled();

    // The actual final line is visible, and future output continues following without another key.
    expect(app.scroll.scrollTop).toBe(bottom(app.scroll)); expect(app.state()?.follow).toBe(true);
    expect(app.captureCharFrame()).toContain("OLD-LINE-69");
    await app.update([...history, section("tail", "RESUMED_LATEST_OUTPUT")]);
    expect(app.scroll.scrollTop).toBe(bottom(app.scroll)); expect(app.state()?.follow).toBe(true);
    expect(app.state()?.selectedId).toBe("tail"); expect(app.captureCharFrame()).toContain("RESUMED_LATEST_OUTPUT");
  } finally { await app.close(); }
});

test("Source selection at bottom pauses following and clearing resumes with cursor and section intact", async () => {
  const app = await mount();
  try {
    pressLeader(app, "["); app.mockInput.pressEnter();
    app.mockInput.pressKey("END", { ctrl: true }); await app.settled();
    // Source Ctrl+End is the section end; scroll the remaining section spacing to the viewport bottom.
    app.scroll.scrollTo(bottom(app.scroll)); await app.settled();
    expect(app.scroll.scrollTop).toBe(bottom(app.scroll)); expect(app.state()?.follow).toBe(true);
    const body = app.renderer.currentFocusedRenderable;
    if (!(body instanceof EditBufferRenderable)) throw new Error("Missing source reader");
    const cursor = body.cursorOffset;
    app.mockInput.pressKey("v"); await app.settled(); expect(app.state()?.follow).toBe(false);
    app.mockInput.pressKey("v"); await app.settled(); expect(app.state()?.follow).toBe(true);
    expect(body.cursorOffset).toBe(cursor); expect(app.state()?.selectedId).toBe("history"); expect(app.state()?.mode).toBe("text");
    await app.update([...history, section("tail", "SOURCE_CURSOR_PRESERVED")]);
    expect(app.scroll.scrollTop).toBe(bottom(app.scroll)); expect(app.state()?.selectedId).toBe("history"); expect(body.cursorOffset).toBe(cursor);
  } finally { await app.close(); }
});

test("New content during selection requires reaching bottom again rather than jumping on clear", async () => {
  const app = await mount();
  try {
    pressLeader(app, "["); app.mockInput.pressEnter(); app.mockInput.pressKey("END", { ctrl: true }); await app.settled();
    app.scroll.scrollTo(bottom(app.scroll)); await app.settled(); expect(app.state()?.follow).toBe(true);
    app.mockInput.pressKey("v", { shift: true }); await app.settled();
    const position = app.scroll.scrollTop;
    await app.update([...history, section("tail", "WAITING_OUTPUT\n".repeat(30))]);
    expect(app.state()?.follow).toBe(false); expect(app.scroll.scrollTop).toBe(position);
    app.mockInput.pressEscape(); await app.settled(); expect(app.state()?.follow).toBe(false);
    app.scroll.scrollTo(bottom(app.scroll)); await app.settled(); expect(app.state()?.follow).toBe(true);
    expect(app.state()?.selectedId).toBe("history"); expect(app.state()?.mode).toBe("text");
  } finally { await app.close(); }
});

test("Rendered Markdown mouse selections are protected and clearing resumes according to bottom position", async () => {
  const app = await mount();
  try {
    const rows = app.captureCharFrame().split("\n"), y = rows.findIndex((line) => line.includes("OLD-LINE-69"));
    const x = rows[y]!.indexOf("OLD-LINE-69");
    await app.mockMouse.drag(x, y, x + 4, y); await app.settled();
    expect(app.renderer.getSelection()?.getSelectedText()).toContain("OLD");
    expect(app.state()?.follow).toBe(false); expect(app.scroll.scrollTop).toBe(bottom(app.scroll));
    app.renderer.clearSelection(); await app.settled();
    expect(app.state()?.follow).toBe(true);
    await app.update([...history, section("new", "MOUSE_SELECTION_RELEASED_TAIL")]);
    expect(app.scroll.scrollTop).toBe(bottom(app.scroll)); expect(app.captureCharFrame()).toContain("MOUSE_SELECTION_RELEASED_TAIL");
  } finally { await app.close(); }
});

test("New prompts in paused history follow latest requests without stealing focus", async () => {
  const app = await mount({ paused: true });
  try {
    expect(app.state()?.follow).toBe(false);
    await app.prompt("NEW_REQUEST_TAIL");
    expect(app.sent).toEqual(["a1:NEW_REQUEST_TAIL"]); expect(app.state()?.follow).toBe(true);
    expect(app.scroll.scrollTop).toBe(bottom(app.scroll)); expect(app.captureCharFrame()).toContain("NEW_REQUEST_TAIL");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
  } finally { await app.close(); }
});

test("Growing Markdown, expanded tools, and completion rows keep latest output at viewport bottom", async () => {
  const app = await mount();
  try {
    expect(app.state()?.follow).toBe(true); expect(app.scroll.scrollTop).toBe(bottom(app.scroll));
    const growing = section("stream", "### Response\n\n" + "Streamed line\n".repeat(45) + "MARKDOWN_TAIL");
    await app.update([...history, growing]);
    expect(app.state()?.follow).toBe(true); expect(app.scroll.scrollTop).toBe(bottom(app.scroll)); expect(app.captureCharFrame()).toContain("MARKDOWN_TAIL");
    const tool = { ...section("tool", "Arguments:\n{}\n\nResult:\n" + "Tool progress\n".repeat(50) + "TOOL_RESULT_TAIL", "tool"), title: "read", status: "running" as const };
    await app.update([...history, growing, tool]);
    expect(app.scroll.scrollTop).toBe(bottom(app.scroll)); expect(app.captureCharFrame()).toContain("TOOL_RESULT_TAIL");
    await app.update([...history, growing, { ...tool, status: "complete", completion: { startedAt: 1000000, completedAt: 1090000, durationMs: 90000, outcome: "complete" } }]);
    expect(app.state()?.follow).toBe(true); expect(app.scroll.scrollTop).toBe(bottom(app.scroll)); expect(app.captureCharFrame()).toContain("Worked for 1m 30s");
  } finally { await app.close(); }
});

test("Resize and asynchronous Markdown layout during following never count as manual navigation", async () => {
  const app = await mount();
  try {
    app.resize(80, 18); await app.settled();
    expect(app.state()?.follow).toBe(true); expect(app.scroll.scrollTop).toBe(bottom(app.scroll));
    await app.update([...history, section("table", "| Key | Value |\n|---|---|\n" + "| 한글 | 긴 결과가 여러 줄로 표시됩니다 |\n".repeat(20) + "\nTABLE_TAIL")]);
    expect(app.state()?.follow).toBe(true); expect(app.scroll.scrollTop).toBe(bottom(app.scroll)); expect(app.captureCharFrame()).toContain("TABLE_TAIL");
  } finally { await app.close(); }
});

test("Wheel-reading history preserves position during streaming and new submissions resume following", async () => {
  const app = await mount();
  try {
    await app.mockMouse.scroll(app.scroll.x + 3, app.scroll.y + 3, "up"); await app.settled();
    expect(app.state()?.follow).toBe(false);
    const position = app.scroll.scrollTop;
    await app.update([...history, section("background", "BACKGROUND_TAIL\n".repeat(30))]);
    expect(app.state()?.follow).toBe(false); expect(app.scroll.scrollTop).toBe(position);
    await app.prompt("RESUME_FROM_INPUT");
    expect(app.state()?.follow).toBe(true); expect(app.scroll.scrollTop).toBe(bottom(app.scroll));
  } finally { await app.close(); }
});

test("Right-edge wheel reading takes precedence over pending automatic scrolls", async () => {
  const app = await mount();
  try {
    const viewport = app.scroll.viewport;
    await app.mockMouse.scroll(viewport.x + viewport.width - 1, viewport.y + Math.floor(viewport.height / 3), "up"); await app.settled();
    expect(app.state()?.follow).toBe(false); expect(app.scroll.scrollTop).toBeLessThan(bottom(app.scroll));
    const position = app.scroll.scrollTop;
    await app.update([...history, section("late", "LATE_TOOL_RESULTS\n".repeat(30))]);
    expect(app.scroll.scrollTop).toBe(position); expect(app.state()?.follow).toBe(false);
  } finally { await app.close(); }
});

test("Non-Markdown tool views restore latest results after resize and screen round-trips without extra events", async () => {
  const app = await mount();
  try {
    const tool = section("tool", "Arguments:\n{}\n\nResult:\n" + "Tool line\n".repeat(100) + "RETURN_TOOL_TAIL", "tool");
    await app.update([tool]); app.resize(100, 22); await app.settled();
    expect(app.state()?.follow).toBe(true); expect(app.scroll.scrollTop).toBe(bottom(app.scroll));
    app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("e"); await app.settled();
    await app.update([{ ...tool, text: tool.text + "\nMore background results\n".repeat(30) + "HIDDEN_VIEW_TAIL" }]);
    app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("a"); await app.settled();
    expect(app.state()?.follow).toBe(true); expect(app.scroll.scrollTop).toBe(bottom(app.scroll));
    expect(app.captureCharFrame()).toContain("HIDDEN_VIEW_TAIL");
  } finally { await app.close(); }
});

test("Editing prompt drafts alone preserves historical reading positions and selection modes", async () => {
  const app = await mount({ paused: true });
  try {
    const position = app.scroll.scrollTop;
    pressLeader(app, "a"); await app.mockInput.typeText("Unsent draft"); await app.settled();
    expect(app.sent).toEqual([]); expect(app.state()?.follow).toBe(false); expect(app.scroll.scrollTop).toBe(position);
    expect(app.view.promptDrafts.a1).toBe("Unsent draft");
  } finally { await app.close(); }
});

test("Late submission acceptance after session switching preserves current scroll and focus", async () => {
  const gate = Promise.withResolvers<Result<void, ExpectedError>>();
  const app = await mount({ onPrompt: () => gate.promise });
  try {
    await app.prompt("Request in A");
    app.selection.selectSession("demo:feature", "b1"); await app.settled();
    pressLeader(app, "["); app.mockInput.pressKey("HOME"); await app.settled();
    const position = app.scroll.scrollTop;
    gate.resolve(ok(undefined)); await app.settled();
    expect(app.selection.sessionId).toBe("b1"); expect(app.state()?.follow).toBe(false); expect(app.scroll.scrollTop).toBe(position);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-transcript");
  } finally { gate.resolve(ok(undefined)); await app.close(); }
});

test("Late acceptance and output never resume following after users restart historical reading", async () => {
  const gate = Promise.withResolvers<Result<void, ExpectedError>>();
  const app = await mount({ paused: true, onPrompt: () => gate.promise });
  try {
    await app.prompt("Pending request"); expect(app.state()?.follow).toBe(true);
    pressLeader(app, "["); app.mockInput.pressKey("HOME"); await app.settled();
    const position = app.scroll.scrollTop;
    gate.resolve(ok(undefined)); await app.update([...history, section("late", "LATE_RESPONSE\n".repeat(40))]);
    expect(app.state()?.follow).toBe(false); expect(app.scroll.scrollTop).toBe(position);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-transcript");
  } finally { gate.resolve(ok(undefined)); await app.close(); }
});
