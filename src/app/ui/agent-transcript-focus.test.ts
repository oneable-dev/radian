import { pressLeader } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { BoxRenderable, EditBufferRenderable, ScrollBoxRenderable, parseKeypress, type TerminalColors } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { TranscriptSection } from "../../agents/transcript.ts";
import { uiTheme } from "../../ui/theme.ts";
import { ok } from "../../result.ts";

const sections: TranscriptSection[] = [
  { id: "user", kind: "user", title: "You", text: "USER_BODY", status: "complete" },
  { id: "thinking", kind: "thinking", title: "Thinking", text: "THINKING_BODY", status: "complete" },
  { id: "tool", kind: "tool", title: "read", text: "TOOL_LINE_1\nTOOL_LINE_2\nTOOL_LINE_3", status: "complete" },
  { id: "notice", kind: "notice", title: "Notice", text: "NOTICE_BODY", status: "complete" },
  { id: "skill", kind: "notice", title: "Skill", text: "review-code", skillName: "review-code", status: "complete" },
  { id: "assistant", kind: "assistant", title: "Agent", text: "**ASSISTANT_BODY**", status: "complete" },
];

async function mount(initial: readonly TranscriptSection[] = sections, width = 120) {
  const app = await createTestRenderer({ width, height: 40, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace());
  let current = initial;
  const view = new Workbench(app.renderer, selection, {
    onNewSession() {}, onCloseSession() {}, onPrompt: () => ok(undefined), initialDrafts: { a1: "Keep my draft" },
    getSessionDetails: () => ({ status: "complete", output: "", error: null, sections: current }),
  });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  await render();
  const scroll = app.renderer.root.findDescendantById("session-transcript");
  if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("Missing transcript viewport");
  const cards = () => scroll.content.getChildren().filter((child): child is BoxRenderable => child instanceof BoxRenderable);
  const cell = (x: number, y: number) => {
    let column = 0;
    const span = app.captureSpans().lines[y]!.spans.find((span) => { column += span.width; return column > x; });
    if (!span) throw new Error(`Missing rendered cell at ${x}, ${y}`);
    return span;
  };
  const background = (x: number, y: number) => cell(x, y).bg;
  const foreground = (x: number, y: number) => cell(x, y).fg;
  const expectMarker = (index?: number) => {
    const card = index === undefined ? undefined : cards()[index]!;
    const viewport = scroll.viewport, accent = uiTheme(app.renderer).styles["ui.focusBorder"].fg;
    const frame = app.captureCharFrame().split("\n"), left = viewport.x - 1, right = viewport.x + viewport.width;
    const visible = !!card && card.y < viewport.y + viewport.height && card.y + card.height > viewport.y;
    for (let y = viewport.y; y < viewport.y + viewport.height; y++) {
      const marked = visible && y >= card.y - 1 && y <= card.y + card.height;
      for (const x of [left, right]) {
        expect(foreground(x, y).equals(accent)).toBe(marked);
        // Focus is a line, not a solid background bar or a tint on the section body.
        expect(background(x, y).equals(accent)).toBe(false);
        if (marked && y >= card.y && y < card.y + card.height) expect(frame[y]![x]).toBe("│");
      }
      expect(background(viewport.x, y).equals(accent)).toBe(false);
      if (viewport.x >= 2) expect(background(viewport.x - 2, y).equals(accent)).toBe(false);
    }
    if (visible) {
      const bottomButton = app.renderer.root.findDescendantById("transcript-bottom-button");
      for (const [y, start, end] of [[card.y - 1, "┌", "┐"], [card.y + card.height, "└", "┘"]] as const) {
        if (y < viewport.y || y > viewport.y + viewport.height || y === viewport.y + viewport.height && bottomButton?.visible) continue;
        expect(frame[y]!.slice(left, right + 1)).toBe(start + "─".repeat(viewport.width) + end);
        expect(foreground(viewport.x, y).equals(accent)).toBe(true);
      }
    }
  };
  return { ...app, view, scroll, cards, background, foreground, expectMarker, render,
    async focus() { pressLeader(app, "["); app.mockInput.pressKey("HOME"); await render(); },
    async update(next: readonly TranscriptSection[]) { current = next; selection.replaceSnapshot(demoWorkspace()); await render(); },
    async close() { view.dispose(); await app.dispose(); },
  };
}

test.each([120, 60])("At width %i, focus outlines the section without changing body geometry or backgrounds", async (width) => {
  // Plain prose and tinted cards must keep their own backgrounds, even for selected headers and skills.
  const app = await mount(sections, width);
  try {
    const geometry = () => app.cards().map((card) => [card.x, card.y, card.width, card.height]);
    const backgrounds = () => app.cards().map((card) => Array.from({ length: card.height }, (_, y) => app.background(card.x + 1, card.y + y).toInts()));
    const before = geometry(), beforeBackgrounds = backgrounds();
    app.expectMarker();

    // Both standard navigation styles, plus Vim keys, move the same section indicator.
    await app.focus(); app.expectMarker(0); expect(backgrounds()).toEqual(beforeBackgrounds);
    const nextKeys = ["ctrl+n", "ARROW_DOWN", "j", "ctrl+n", "ARROW_DOWN"];
    for (const [index, key] of nextKeys.entries()) {
      if (key === "ctrl+n") app.mockInput.pressKey("n", { ctrl: true });
      else app.mockInput.pressKey(key);
      await app.render(); app.expectMarker(index + 1);
      expect(backgrounds()).toEqual(beforeBackgrounds);
    }
    app.mockInput.pressKey("p", { ctrl: true }); await app.render(); app.expectMarker(4);
    app.mockInput.pressArrow("up"); await app.render(); app.expectMarker(3);
    app.mockInput.pressKey("k"); await app.render(); app.expectMarker(2);

    pressLeader(app, "a"); await app.render(); app.expectMarker();

    // Neither active nor inactive section selection may leave a background tint behind.
    expect(backgrounds()).toEqual(beforeBackgrounds);
    expect(geometry()).toEqual(before);
    expect(app.view.promptDrafts.a1).toBe("Keep my draft");
  } finally { await app.close(); }
});

test.each([sections[0]!, sections[1]!, sections[2]!, sections[5]!])("Esc hides the $kind reading cursor in Sections and Enter restores its position", async (section) => {
  // Plain bodies, formatted prose, and folded headers must share the same cursor lifecycle.
  const app = await mount([section]);
  try {
    await app.focus();
    app.mockInput.pressEnter(); app.mockInput.pressKey("l"); await app.render();
    const reader = app.renderer.currentFocusedRenderable;
    if (!(reader instanceof EditBufferRenderable)) throw new Error("Missing reading cursor");
    const offset = reader.cursorOffset;
    expect(offset).toBeGreaterThan(0); expect(app.renderer.getCursorState().visible).toBe(true);

    // Esc cancels Visual first, then leaves Text without leaving the selected section.
    app.mockInput.pressKey("v"); await app.render();
    app.mockInput.pressEscape(); await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(reader);
    expect(reader.hasSelection()).toBe(false); expect(app.renderer.getCursorState().visible).toBe(true);
    app.mockInput.pressEscape(); await app.render();

    // Sections keeps its outline, but no text cursor, including after a resize.
    expect(app.renderer.currentFocusedRenderable).toBe(app.scroll);
    expect(app.view.workViewPreferences.agentViews?.a1?.mode).toBe("sections");
    expect(app.renderer.getCursorState().visible).toBe(false); app.expectMarker(0);
    app.resize(100, 36); await app.render();
    expect(app.renderer.getCursorState().visible).toBe(false);

    // Enter resumes reading at the remembered character without touching the prompt draft.
    app.mockInput.pressEnter(); await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(reader); expect(reader.cursorOffset).toBe(offset);
    expect(app.renderer.getCursorState().visible).toBe(true); app.expectMarker(0);
    expect(app.view.promptDrafts.a1).toBe("Keep my draft");
  } finally { await app.close(); }
});

test("Help and non-text views release the formatted reading cursor while inputs retain their own", async () => {
  // Formatted prose draws its cursor separately from the native editor.
  const app = await mount([sections[5]!]);
  try {
    await app.focus(); app.mockInput.pressEnter(); await app.render();
    expect(app.renderer.getCursorState().visible).toBe(true);

    // Help has no cursor, and closing it restores the original reading surface.
    app.mockInput.pressKey("F1"); await app.render();
    expect(app.renderer.getCursorState().visible).toBe(false);
    app.mockInput.pressEscape(); await app.render();
    expect(app.renderer.getCursorState().visible).toBe(true);

    // Search and prompt inputs must own their cursors rather than inherit a hidden reading cursor.
    app.mockInput.pressKey("/"); await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("transcript-search");
    expect(app.renderer.getCursorState().visible).toBe(true);
    app.mockInput.pressEscape(); await app.render();
    pressLeader(app, "a"); await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
    expect(app.renderer.getCursorState().visible).toBe(true);

    // An empty editor must not keep a stale cursor at the former prose position.
    pressLeader(app, "["); await app.render();
    expect(app.renderer.getCursorState().visible).toBe(true);
    pressLeader(app, "e"); await app.render();
    expect(app.view.workViewPreferences.active["demo:main"]).toBe("editor");
    expect(app.renderer.getCursorState().visible).toBe(false); app.expectMarker();
    expect(app.view.promptDrafts.a1).toBe("Keep my draft");
  } finally { await app.close(); }
});

test("Input focus, help, and empty transcripts leave no section focus border", async () => {
  // A selected section remains remembered when focus leaves the transcript.
  const app = await mount();
  try {
    await app.focus(); app.expectMarker(0);

    pressLeader(app, "a"); await app.render();
    app.expectMarker();
    pressLeader(app, "["); await app.render(); app.expectMarker(0);
    app.mockInput.pressKey("F1"); await app.render(); app.expectMarker();
    app.mockInput.pressKey("F1"); await app.render(); app.expectMarker(0);
    await app.update([]);

    // Help and empty views are not sections, even while the scroll surface owns focus.
    app.expectMarker();
    expect(app.view.promptDrafts.a1).toBe("Keep my draft");
  } finally { await app.close(); }
});

test("Clicking and expanding tool headers or selecting bodies outlines the full section", async () => {
  // A folded tool starts with only its heading and padding visible.
  const app = await mount();
  try {
    const tool = app.cards()[2]!;
    const heading = tool.getChildren().find((child) => child.visible)!;

    await app.mockMouse.click(heading.x, heading.y); await app.render();
    app.expectMarker(2);
    const foldedHeight = tool.height;
    app.mockInput.pressKey("o", { ctrl: true }); await app.render();
    expect(tool.height).toBeGreaterThan(foldedHeight); app.expectMarker(2);
    app.mockInput.pressEnter(); app.mockInput.pressKey("v"); await app.render();

    // Text/visual modes retain the section outline in addition to their native cursor/selection.
    app.expectMarker(2);
    expect(app.captureCharFrame()).toContain("VISUAL");
    app.mockInput.pressEscape(); app.mockInput.pressEscape();
    app.mockInput.pressKey("o", { ctrl: true }); await app.render();
    expect(tool.height).toBe(foldedHeight); app.expectMarker(2);
  } finally { await app.close(); }
});

test("Scroll, resize, and streaming clip section borders without covering adjacent content", async () => {
  // A section taller than the viewport exposes both top and bottom clipping boundaries.
  const long: TranscriptSection = { ...sections[5]!, text: Array.from({ length: 80 }, (_, i) => `LONG_LINE_${i}`).join("\n"), status: "streaming" };
  const app = await mount([long, sections[0]!]);
  try {
    await app.focus(); app.expectMarker(0);

    app.scroll.scrollBy(Math.floor(app.scroll.viewport.height / 2)); await app.render();
    expect(app.cards()[0]!.y).toBeLessThan(app.scroll.viewport.y); app.expectMarker(0);
    app.resize(60, 18); await app.render(); app.expectMarker(0);
    await app.update([{ ...long, text: long.text + "\nSTREAMED_LINE" }, sections[0]!]);
    app.expectMarker(0);
    app.scroll.scrollTo(Infinity); await app.render(); app.expectMarker(0);

    // A partial section stops before the following section, composer, and session tabs.
    const viewport = app.scroll.viewport, accent = uiTheme(app.renderer).styles["ui.focusBorder"].fg;
    expect(app.background(viewport.x - 1, viewport.y - 1).equals(accent)).toBe(false);
    expect(app.background(viewport.x - 1, viewport.y + viewport.height).equals(accent)).toBe(false);
    app.mockInput.pressKey("n", { ctrl: true }); await app.render(); app.expectMarker(1);
    app.scroll.scrollTo(0); await app.render(); app.expectMarker();
  } finally { await app.close(); }
});

test.each([120, 60])("At width %i, section borders share boundary rows without covering Back to bottom", async (width) => {
  // The selected section can end exactly at the viewport edge while more history remains below it.
  const long: TranscriptSection = { ...sections[5]!, text: Array.from({ length: 80 }, (_, i) => `LONG_LINE_${i}`).join("\n") };
  const app = await mount([long, sections[0]!], width);
  try {
    await app.focus();
    const card = app.cards()[0]!, viewport = app.scroll.viewport;
    app.scroll.scrollTo(app.scroll.scrollTop + card.y + card.height - viewport.y - viewport.height);
    await app.render();

    // The return command keeps its existing row instead of being overwritten by the bottom edge.
    expect(card.y + card.height).toBe(viewport.y + viewport.height);
    const button = app.renderer.root.findDescendantById("transcript-bottom-button")!;
    expect(button.visible).toBe(true); app.expectMarker(0);
    expect(app.captureCharFrame().split("\n")[button.y]!.slice(button.x, button.x + button.width)).toContain("Back to bottom");

    // Following the final section frees the same row for its border, which disappears on input focus.
    app.mockInput.pressKey("END"); await app.render();
    expect(button.visible).toBe(false); app.expectMarker(1);
    expect(app.cards()[1]!.y + app.cards()[1]!.height).toBe(viewport.y + viewport.height);
    pressLeader(app, "a"); await app.render(); app.expectMarker();
    expect(app.captureCharFrame().split("\n")[viewport.y + viewport.height]!.slice(viewport.x - 1, viewport.x + viewport.width + 1).trim()).toBe("");
    expect(app.view.promptDrafts.a1).toBe("Keep my draft");
  } finally { await app.close(); }
});

test.each([120, 60])("At width %i, repeated Ctrl+D/U moves selection and borders together while keeping them visible", async (width) => {
  // Repeated jumps must follow the selected section, even after scrolling is needed to reveal it.
  const app = await mount(Array.from({ length: 60 }, (_, index) => ({ ...sections[5]!, id: `section-${index}`, text: `BODY_${index}` })), width);
  const raw = (sequence: string) => {
    const key = parseKeypress(sequence, { useKittyKeyboard: true });
    if (!key) throw new Error("Invalid Kitty key");
    app.renderer.keyInput.processParsedKey(key);
  };
  const expectSelected = (index: number) => {
    expect(app.view.workViewPreferences.agentViews?.a1?.selectedId).toBe(`section-${index}`);
    const card = app.cards()[index]!, viewport = app.scroll.viewport;
    expect(card.y).toBeGreaterThanOrEqual(viewport.y);
    expect(card.y + card.height).toBeLessThanOrEqual(viewport.y + viewport.height);
    app.expectMarker(index);
  };
  try {
    await app.focus();
    const step = Math.max(1, Math.floor(app.scroll.viewport.height / 4));

    app.mockInput.pressKey("d", { ctrl: true }); await app.render(); expectSelected(step);
    raw("\x1b[100;5:2u"); await app.render(); expectSelected(2 * step);
    raw("\x1b[100;5:2u"); await app.render(); expectSelected(3 * step);
    raw("\x1b[100;5:3u");
    app.mockInput.pressKey("u", { ctrl: true }); await app.render(); expectSelected(2 * step);
    raw("\x1b[117;5:2u"); await app.render(); expectSelected(step);
    raw("\x1b[117;5:2u"); await app.render(); expectSelected(0);
    raw("\x1b[117;5:3u");

    // Held navigation never enters text editing or changes the prompt draft.
    expect(app.renderer.currentFocusedRenderable).toBe(app.scroll);
    expect(app.view.promptDrafts.a1).toBe("Keep my draft");
  } finally { await app.close(); }
});

test("Section borders immediately follow theme ui.focusBorder changes", async () => {
  // A style override must control every edge of the section outline.
  const app = await mount();
  const palette: TerminalColors = { palette: [], defaultForeground: "#202020", defaultBackground: "#FAFAF6",
    cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null,
    highlightForeground: null, highlightBackground: null };
  try {
    await app.focus();
    const before = app.foreground(app.scroll.viewport.x - 1, app.cards()[0]!.y);

    uiTheme(app.renderer).configure(palette, { styles: { "ui.focusBorder": { fg: "#F08020" } } });
    await app.render();

    // The same gutter updates without moving the selected section or requiring a focus cycle.
    app.expectMarker(0);
    const after = app.foreground(app.scroll.viewport.x - 1, app.cards()[0]!.y);
    expect(after.toInts().slice(0, 3)).toEqual([240, 128, 32]);
    expect(after.equals(before)).toBe(false);
  } finally { await app.close(); }
});
