import { expect, test } from "bun:test";
import { BoxRenderable, ScrollBoxRenderable, parseKeypress, type TerminalColors } from "@opentui/core";
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
  const background = (x: number, y: number) => {
    let column = 0;
    const cell = app.captureSpans().lines[y]!.spans.find((span) => { column += span.width; return column > x; });
    if (!cell) throw new Error(`Missing rendered cell at ${x}, ${y}`);
    return cell.bg;
  };
  const expectMarker = (index?: number) => {
    const card = index === undefined ? undefined : cards()[index]!;
    const viewport = scroll.viewport, accent = uiTheme(app.renderer).styles["ui.focusBorder"].fg;
    for (let y = viewport.y; y < viewport.y + viewport.height; y++) {
      const marked = !!card && y >= card.y && y < card.y + card.height;
      expect(background(viewport.x - 1, y).equals(accent)).toBe(marked);
      // Only the gutter cell changes; neither the body nor the remaining outer inset is painted.
      expect(background(viewport.x, y).equals(accent)).toBe(false);
      if (viewport.x >= 2) expect(background(viewport.x - 2, y).equals(accent)).toBe(false);
    }
  };
  return { ...app, view, scroll, cards, background, expectMarker, render,
    async focus() { app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressKey("HOME"); await render(); },
    async update(next: readonly TranscriptSection[]) { current = next; selection.replaceSnapshot(demoWorkspace()); await render(); },
    async close() { view.dispose(); await app.dispose(); },
  };
}

test.each([120, 60])("너비 %i에서 포커스는 본문 위치·배경을 유지하고 왼쪽 바깥 여백 한 칸으로만 표시한다", async (width) => {
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

    app.mockInput.pressKey("e", { ctrl: true }); await app.render(); app.expectMarker();

    // Neither active nor inactive section selection may leave a background tint behind.
    expect(backgrounds()).toEqual(beforeBackgrounds);
    expect(geometry()).toEqual(before);
    expect(app.view.promptDrafts.a1).toBe("Keep my draft");
  } finally { await app.close(); }
});

test("입력 포커스·도움말·빈 Transcript에는 섹션 표시줄이 남지 않는다", async () => {
  // A selected section remains remembered when focus leaves the transcript.
  const app = await mount();
  try {
    await app.focus(); app.expectMarker(0);

    app.mockInput.pressKey("e", { ctrl: true }); await app.render();
    app.expectMarker();
    app.mockInput.pressKey("t", { ctrl: true }); await app.render(); app.expectMarker(0);
    app.mockInput.pressKey("F1"); await app.render(); app.expectMarker();
    app.mockInput.pressKey("F1"); await app.render(); app.expectMarker(0);
    await app.update([]);

    // Help and empty views are not sections, even while the scroll surface owns focus.
    app.expectMarker();
    expect(app.view.promptDrafts.a1).toBe("Keep my draft");
  } finally { await app.close(); }
});

test("도구 헤더를 클릭하고 펼치거나 본문 선택으로 들어가도 섹션 높이만큼 표시한다", async () => {
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

    // Text/visual modes retain the section marker in addition to their native cursor/selection.
    app.expectMarker(2);
    expect(app.captureCharFrame()).toContain("VISUAL");
    app.mockInput.pressEscape(); app.mockInput.pressEscape();
    app.mockInput.pressKey("o", { ctrl: true }); await app.render();
    expect(tool.height).toBe(foldedHeight); app.expectMarker(2);
  } finally { await app.close(); }
});

test("스크롤·resize·스트리밍 중 표시줄은 보이는 섹션과 Transcript 경계에만 그려진다", async () => {
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

test.each([120, 60])("너비 %i에서 Ctrl+D/U 반복은 선택과 표시줄을 함께 이동하고 화면 안에 유지한다", async (width) => {
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

test("포커스 표시줄은 테마의 ui.focusBorder 색상 변경을 즉시 따른다", async () => {
  // A style override must control the marker just like other focus borders.
  const app = await mount();
  const palette: TerminalColors = { palette: [], defaultForeground: "#202020", defaultBackground: "#FAFAF6",
    cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null,
    highlightForeground: null, highlightBackground: null };
  try {
    await app.focus();
    const before = app.background(app.scroll.viewport.x - 1, app.cards()[0]!.y);

    uiTheme(app.renderer).configure(palette, { styles: { "ui.focusBorder": { fg: "#F08020" } } });
    await app.render();

    // The same gutter updates without moving the selected section or requiring a focus cycle.
    app.expectMarker(0);
    const after = app.background(app.scroll.viewport.x - 1, app.cards()[0]!.y);
    expect(after.toInts().slice(0, 3)).toEqual([240, 128, 32]);
    expect(after.equals(before)).toBe(false);
  } finally { await app.close(); }
});
