import { pressLeader, pressTranscriptRead } from "../../testing/transcript-keys.ts";
import { expect, test } from "bun:test";
import { CodeRenderable, EditBufferRenderable, MarkdownRenderable, TextAttributes, type Renderable, type TerminalColors } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { TranscriptSection } from "../../agents/transcript.ts";
import { uiTheme } from "../../ui/theme.ts";
import { ok } from "../../result.ts";
import type { WorkViewPreferences } from "../../runtime/protocol.ts";

const prose = (text: string, kind: "assistant" | "thinking" = "assistant", streaming = false): TranscriptSection => ({ id: "prose", kind, title: kind, text, status: streaming ? "streaming" : "complete" });
function descendants(root: Renderable): Renderable[] { return root.getChildren().flatMap((child) => [child, ...descendants(child)]); }
async function mount(sections: TranscriptSection[], actions: Partial<WorkbenchActions> = {}) {
  const app = await createTestRenderer({ width: 140, height: 60, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace()), copies: string[] = [], sent: string[] = [];
  let current = sections;
  const view = new Workbench(app.renderer, selection, { onNewSession: () => {}, onCloseSession: () => {},
    onPrompt: (_id, text) => { sent.push(text); return ok(undefined); }, initialDrafts: { a1: "Keep this draft" },
    onCopyTranscript: async (text) => { copies.push(text); return ok("Copied to clipboard"); },
    getSessionDetails: () => ({ status: "complete", output: "", error: null, sections: current }), ...actions,
  });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  const settled = async () => {
    await render();
    // Await real native highlighting/finalization, not a wall-clock rendering guess.
    for (let i = 0; i < 3; i++) {
      await Promise.all(descendants(app.renderer.root).filter((node): node is CodeRenderable => node instanceof CodeRenderable).map((node) => node.highlightingDone));
      await render();
    }
  };
  await render();
  return { ...app, view, copies, sent, render, settled,
    markdown() { return descendants(app.renderer.root).find((node): node is MarkdownRenderable => node instanceof MarkdownRenderable)!; },
    position(text: string) {
      const lines = app.captureCharFrame().split("\n"), y = lines.findIndex(line => line.includes(text));
      if (y < 0) throw new Error(`Missing ${text}`);
      return { x: Bun.stringWidth(lines[y]!.slice(0, lines[y]!.indexOf(text))), y };
    },
    body() { const node = app.renderer.currentFocusedRenderable; if (!(node instanceof EditBufferRenderable)) throw new Error("Missing source cursor"); return node; },
    async focus() { pressTranscriptRead(app, actions.keymap); app.mockInput.pressKey("HOME"); await render(); },
    async update(next: TranscriptSection[]) { current = next; selection.replaceSnapshot(demoWorkspace()); await render(); },
    async close() { view.dispose(); await app.dispose(); },
  };
}

const document = "### Actual structure\n\n**Emphasized answer** and `inline code`\n\n[README](https://example.invalid/docs)\n\n- First item\n- Second item\n\n```text\nCODE_LITERAL **keep stars**\n```\n\n| Item | Value |\n| --- | --- |\n| Radian | ready |";

test("Answers render headings, emphasis, code, links, lists, and tables through real OpenTUI Markdown", async () => {
  // Feed Markdown syntax from the user's screenshot into the real native renderer.
  const app = await mount([prose(document)]);
  try {
    await app.settled();
    const frame = app.captureCharFrame();
    // Draw table borders and row/column separators, not just cell contents.
    expect(frame).toMatch(/┌─+┬─+┐/u); expect(frame).toMatch(/├─+┼─+┤/u); expect(frame).toMatch(/└─+┴─+┘/u);
    // Hide display syntax while preserving literal code syntax and table cell content.
    expect(app.markdown()).toBeInstanceOf(MarkdownRenderable); expect(app.markdown().streaming).toBe(false);
    for (const text of ["Actual structure", "Emphasized answer", "inline code", "README", "First item", "Second item", "CODE_LITERAL **keep stars**", "Radian", "ready"]) expect(frame).toContain(text);
    for (const syntax of ["### Actual structure", "**Emphasized answer**", "`inline code`", "```text", "[README](", "| --- | --- |", "| Radian |"]) expect(frame).not.toContain(syntax);
    const spans = app.captureSpans().lines.flatMap((line) => line.spans);
    expect(spans.find((span) => span.text.includes("Emphasized answer"))!.attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
    expect(app.view.promptDrafts.a1).toBe("Keep this draft"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test.each(["**FIRST_FRAME_TEXT**", "```typescript\nconst FIRST_FRAME_TEXT = 1;\n```"])("Completed answers show content on the first frame before local highlighting is ready: %s", async (source) => {
  // Parser preparation must not leave body or code blocks blank.
  const app = await mount([prose(source)]);
  try {
    expect(app.captureCharFrame()).toContain("FIRST_FRAME_TEXT");
    expect(app.captureCharFrame()).not.toContain("**FIRST_FRAME_TEXT**");
    await app.settled(); expect(app.captureCharFrame()).toContain("FIRST_FRAME_TEXT");
  } finally { await app.close(); }
});

test("Enter preserves Markdown presentation and height while copying visible lines separately from full source", async () => {
  // Keep source syntax hidden without losing full-source copying.
  const source = "## Heading\r\n\r\n**한글 👨‍👩‍👧‍👦**\r\nlast";
  const app = await mount([prose(source)]);
  try {
    await app.settled(); await app.focus();
    app.mockInput.pressKey("y"); await app.render(); expect(app.copies).toEqual([source]);
    const height = app.markdown().height;
    const markdownFrame = () => app.captureCharFrame().split("\n").slice(app.markdown().y, app.markdown().y + height).join("\n");
    const before = markdownFrame();
    expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).toContain("<CR> Text");

    // Entering reading mode neither swaps buffers nor exposes Markdown syntax.
    app.mockInput.pressEnter(); await app.render();

    expect(app.body().plainText).toBe("Heading\n\n한글 👨‍👩‍👧‍👦\nlast");
    expect(app.markdown().visible).toBe(true); expect(app.markdown().height).toBe(height);
    expect(markdownFrame()).toBe(before);
    expect(app.renderer.getCursorState().visible).toBe(true);
    app.mockInput.pressKey("v", { shift: true }); app.mockInput.pressKey("y"); await app.render();
    expect(app.copies.at(-1)).toBe("Heading\n");
    app.mockInput.pressEscape(); await app.settled();
    expect(app.markdown().visible).toBe(true); expect(app.captureCharFrame()).not.toContain("## Heading");
    app.mockInput.pressKey("y", { shift: true }); await app.render(); expect(app.copies.at(-1)).toBe(source);
    expect(app.sent).toEqual([]); expect(app.view.promptDrafts.a1).toBe("Keep this draft");
  } finally { await app.close(); }
});

function palette(light: boolean): TerminalColors {
  return { palette: ["#000000", "#CC2222", "#228822", "#998800", "#2255AA", "#AA22AA", "#117799", "#DDDDDD"],
    defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
    cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null, highlightForeground: null, highlightBackground: null };
}

test.each([false, true])("Thinking Markdown retains gray italic text and default backgrounds regardless of syntax colors: %j", async (light) => {
  const app = await mount([prose("**Reviewing extension docs**\n\n`inline_thought`\n\n```typescript\nconst thought_code = 1;\n```\n\n| Thought | Value |\n|---|---|\n| result | pending |", "thinking")]);
  try {
    uiTheme(app.renderer).configure(palette(light), { muted: "#CC2288" }); await app.settled();
    const spans = app.captureSpans().lines.flatMap((line) => line.spans);
    for (const text of ["Reviewing extension docs", "inline_thought", "thought_code", "Thought", "pending"]) {
      const span = spans.find((span) => span.text.includes(text)); if (!span) throw new Error(`Missing ${text}\n${app.captureCharFrame()}`);
      const [r, g, b] = span.fg.toInts(); expect(r).toBe(g); expect(g).toBe(b);
      expect(span.attributes & TextAttributes.ITALIC).toBe(TextAttributes.ITALIC);
      expect(span.bg.toInts()).toEqual(uiTheme(app.renderer).colors.panel.toInts());
    }
    expect(app.captureCharFrame()).not.toContain("**Reviewing extension docs**"); expect(app.captureCharFrame()).not.toContain("[thinking]");
  } finally { await app.close(); }
});

test("Streaming partial Markdown updates the same renderer and finalizes tables and code blocks", async () => {
  const app = await mount([prose("### Streaming\n\n**hello", "assistant", true)]);
  try {
    const original = app.markdown(); expect(app.captureCharFrame()).toContain("hello");
    await app.update([prose("### Streaming\n\n**hello 한글**\n\n```text\nfirst", "assistant", true)]);
    await app.settled(); expect(app.markdown()).toBe(original); expect(original.streaming).toBe(true);
    // Partially received final table cells still show borders and available content.
    const prefix = "### Streaming\n\n**hello 한글**\n\n```text\nfirst\nsecond\n```\n\n| Key | Value |\n|---|---|\n";
    await app.update([prose(prefix + "| final | comp", "assistant", true)]); await app.settled();
    expect(original.streaming).toBe(true); expect(app.captureCharFrame()).toContain("comp");
    expect(app.captureCharFrame()).toMatch(/┌─+┬─+┐/u);

    // Completion preserves table borders and final cells in the same renderer.
    await app.update([prose(prefix + "| final | complete |")]); await app.settled();
    const frame = app.captureCharFrame(); expect(original.streaming).toBe(false);
    expect(frame).toMatch(/┌─+┬─+┐/u); expect(frame).toMatch(/└─+┴─+┘/u);
    for (const text of ["hello 한글", "first", "second", "final", "complete"]) expect(frame).toContain(text);
    expect(frame).not.toContain("```text"); expect(frame).not.toContain("|---|---|");
  } finally { await app.close(); }
});

test("Completed messages with missing closing syntax still show truncated-preview content", async () => {
  // Saved preview limits may remove closing fences.
  const app = await mount([prose("### Truncated\n\n**unfinished emphasis\n\n```typescript\nconst clipped = 1;")]);
  try {
    await app.settled();
    const frame = app.captureCharFrame();
    expect(frame).toContain("Truncated"); expect(frame).toContain("unfinished emphasis"); expect(frame).toContain("clipped");
    expect(app.markdown().streaming).toBe(false); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("Markdown streaming selection, resize, and round-trips preserve Unicode selection and drafts", async () => {
  const source = "**한글 👨‍👩‍👧‍👦**\nnext";
  const app = await mount([prose(source, "assistant", true)]);
  try {
    await app.focus(); app.mockInput.pressEnter();
    app.mockInput.pressKey("v"); app.mockInput.pressKey("l"); await app.render();
    expect(app.body().getSelectedText()).toBe("한글");
    await app.update([prose(source + " plus streamed", "assistant", true)]);
    app.resize(70, 16); await app.render(); app.mockInput.pressKey("y"); await app.render();
    expect(app.copies).toEqual(["한글"]); expect(app.view.promptDrafts.a1).toBe("Keep this draft");
    app.mockInput.pressEscape(); await app.settled(); expect(app.markdown().visible).toBe(true);
    app.mockInput.pressEnter(); await app.render(); expect(app.body().cursorOffset).toBe(2);
  } finally { await app.close(); }
});

test("Narrow Markdown tables fit available width without exposing source delimiters", async () => {
  const app = await mount([prose("| Name | Value |\n|---|---|\n| 한글 항목 | 긴 설명을 단어 단위로 줄바꿈해서 표시합니다 |\n| second | ready |")]);
  try {
    app.resize(80, 26); await app.settled(); await app.focus();
    const scroll = app.renderer.root.findDescendantById("session-transcript")!;
    expect(app.markdown().width).toBeLessThanOrEqual(scroll.width);
    // Both borders and the final row remain visible in compact screens.
    const frame = app.captureCharFrame(); expect(frame).toContain("Name"); expect(frame).toContain("Value");
    expect(frame).toMatch(/┌─+┬─+┐/u); expect(frame).toMatch(/└─+┴─+┘/u);
    for (const text of ["한글 항목", "second", "ready"]) expect(frame).toContain(text);
    // Korean wraps between syllables; join visible value columns to verify full content.
    const values = frame.split("\n").map((line) => line.split("│")).filter((cells) => cells.length >= 4)
      .map((cells) => cells.at(-2)).join("").replace(/\s+/gu, "");
    expect(values).toContain("긴설명을단어단위로줄바꿈해서표시합니다");
    expect(frame).not.toContain("|---|---|");
    expect(app.view.promptDrafts.a1).toBe("Keep this draft");
  } finally { await app.close(); }
});

test("Disposal during highlighting prevents late updates to destroyed Markdown or styles", async () => {
  // Protect immediate closure while syntax preparation is asynchronous.
  const app = await mount([prose("### Closing\n\n**Still highlighting**\n\n```typescript\nconst closing = true;\n```")]);
  const pending = descendants(app.renderer.root).filter((node): node is CodeRenderable => node instanceof CodeRenderable).map((node) => node.highlightingDone);
  const markdown = app.markdown();
  await app.close(); await Promise.all(pending);
  // Late completion after native buffer destruction causes neither exceptions nor state changes.
  expect(markdown.isDestroyed).toBe(true); expect(app.sent).toEqual([]);
});

test("Status, syntax, and Markdown styles apply independently to code, inline code, headings, and tables", async () => {
  // Override string and success colors independently despite their shared green defaults.
  const app = await mount([prose("## Semantic title\n\n```typescript\nconst literal = \"semantic_string\";\n```\n\n`semantic_inline`\n\n| Head | Tail |\n|---|---|\n| value | done |")]);
  try {
    uiTheme(app.renderer).configure(palette(false), { styles: {
      "status.success": { fg: "#FF00FF" }, "syntax.string": { fg: "#12AB34" },
      "markup.inlineCode": { fg: "#2299CC", italic: true }, "markup.heading": { fg: "#CC7722", underline: true },
      "markup.tableBorder": { fg: "#5566AA" },
    } });

    // Verify completed native highlighting and tables through actual screen output.
    await app.settled();
    const spans = app.captureSpans().lines.flatMap(line => line.spans);
    const span = (text: string) => {
      const value = spans.find(span => span.text.includes(text));
      if (!value) throw new Error(`Missing ${text}\n${app.captureCharFrame()}`);
      return value;
    };
    expect(span("semantic_string").fg.toInts().slice(0, 3)).toEqual([18, 171, 52]);
    expect(span("semantic_inline").fg.toInts().slice(0, 3)).toEqual([34, 153, 204]);
    expect(span("semantic_inline").attributes & TextAttributes.ITALIC).not.toBe(0);
    expect(span("Semantic title").fg.toInts().slice(0, 3)).toEqual([204, 119, 34]);
    expect(span("Semantic title").attributes & TextAttributes.UNDERLINE).not.toBe(0);
    expect(span("┬").fg.toInts().slice(0, 3)).toEqual([85, 102, 170]);
    expect(app.view.promptDrafts.a1).toBe("Keep this draft"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("Disabling card backgrounds inherits overridden body backgrounds", async () => {
  // Removing card tint must not paint terminal defaults over custom backgrounds.
  const app = await mount([{ ...prose("CARD_SURFACE"), kind: "user" }]);
  try {
    uiTheme(app.renderer).configure(palette(false), { styles: { "ui.text": { bg: "#112233" }, "transcript.user": { bg: null } } });
    await app.settled();

    const span = app.captureSpans().lines.flatMap(line => line.spans).find(span => span.text.includes("CARD_SURFACE"))!;
    expect(span.bg.toInts().slice(0, 3)).toEqual([17, 34, 51]);
    expect(app.view.promptDrafts.a1).toBe("Keep this draft"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("Table cursors and character selection preserve borders/styles and copy visible Korean", async () => {
  // Navigate actual native table layout, not source pipe syntax.
  const opened: string[] = [];
  const app = await mount([prose("## Table\n\n| Name | Value |\n|---|---|\n| [표한글](https://example.invalid/table) | ready |")], {
    onOpenTranscriptUrl: async url => { opened.push(url); return ok(undefined); },
  });
  try {
    await app.settled(); await app.focus(); app.mockInput.pressEnter(); await app.render();
    const body = app.body(), offset = body.plainText.indexOf("표한글");
    expect(offset).toBeGreaterThanOrEqual(0);

    // Move into displayed cells and select adjacent characters.
    body.cursorOffset = body.editBuffer.measureText(body.plainText.slice(0, offset)); await app.render();
    const target = app.position("표한글"), cursor = app.renderer.getCursorState();
    app.mockInput.pressKey("g"); app.mockInput.pressKey("x"); await app.waitFor(() => opened.length === 1);
    expect(opened).toEqual(["https://example.invalid/table"]);
    app.mockInput.pressKey("v"); app.mockInput.pressKey("l"); await app.render();

    expect(cursor.x).toBe(target.x + 1); expect(cursor.y).toBe(target.y + 1); expect(cursor.visible).toBe(true);
    expect(app.renderer.getSelection()?.getSelectedText()).toBe("표한");
    expect(app.captureCharFrame()).toMatch(/┌─+┬─+┐/u); expect(app.markdown().visible).toBe(true);
    app.resize(90, 28);
    await app.update([prose("## Table\n\n| Name | Value |\n|---|---|\n| [표한글](https://example.invalid/table) | ready |\n| added | streaming |")]);
    await app.settled();
    expect(body.getSelectedText()).toBe("표한"); expect(app.renderer.getSelection()?.getSelectedText()).toBe("표한");
    app.mockInput.pressKey("y"); await app.render(); expect(app.copies.at(-1)).toBe("표한");
    expect(app.captureCharFrame()).not.toContain("|---|---|"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("Long emphasized prose navigates display rows while line selection excludes soft wraps", async () => {
  // Native display rows and logical source lines use different coordinates.
  const line = "한글 é 👨‍👩‍👧‍👦 " + "wrapped words ".repeat(20).trimEnd();
  const app = await mount([prose(`**${line}**\nnext`)]);
  try {
    app.resize(60, 20); await app.settled(); await app.focus(); app.mockInput.pressEnter(); await app.render();
    const first = app.renderer.getCursorState();

    // Ctrl+N/P moves display rows; V selects complete logical lines.
    app.mockInput.pressKey("n", { ctrl: true }); await app.render();
    expect(app.renderer.getCursorState().y).toBe(first.y + 1); expect(app.body().logicalCursor.row).toBe(0);
    app.mockInput.pressKey("p", { ctrl: true }); app.mockInput.pressKey("v", { shift: true });
    app.resize(48, 20); await app.render(); app.mockInput.pressKey("y"); await app.render();

    expect(app.copies.at(-1)).toBe(line + "\n");
    expect(app.markdown().visible).toBe(true); expect(app.captureCharFrame()).not.toContain("**한글");
    expect(app.view.promptDrafts.a1).toBe("Keep this draft");
  } finally { await app.close(); }
});

test("Vertical motions retain preferred columns across short rows while horizontal motions update targets", async () => {
  // Preserve Neovim vertical motion using visible columns, not Markdown syntax offsets.
  const app = await mount([prose("**abcdefghij**\nx\nabcdefghij")]);
  try {
    await app.settled(); await app.focus(); app.mockInput.pressEnter(); await app.render();
    for (let index = 0; index < 8; index++) app.mockInput.pressKey("l");

    // Clamping on short rows must restore the original column on later long rows.
    app.mockInput.pressKey("n", { ctrl: true }); app.mockInput.pressKey("n", { ctrl: true }); await app.render();

    expect(app.body().logicalCursor.row).toBe(2); expect(app.body().logicalCursor.col).toBe(8);
    app.mockInput.pressKey("h"); app.mockInput.pressKey("p", { ctrl: true }); app.mockInput.pressKey("p", { ctrl: true }); await app.render();
    expect(app.body().logicalCursor.row).toBe(0); expect(app.body().logicalCursor.col).toBe(7);
    expect(app.markdown().visible).toBe(true);
  } finally { await app.close(); }
});

test.each([{ key: "^", shift: false }, { key: "6", shift: true }])("$key first-nonblank motions follow Vim for Korean, tabs, and whitespace-only lines", async ({ key, shift }) => {
  // Leading code-block whitespace is visible source content, not Markdown syntax.
  const first = " \t  한글 value", blank = " \t  ";
  const app = await mount([prose(`\`\`\`text\n${first}\n${blank}\nnext\n\`\`\``)]);
  try {
    await app.settled(); await app.focus(); app.mockInput.pressEnter(); await app.render();
    const body = app.body(), leading = " \t  "; app.mockInput.pressKey("END");

    // First-nonblank differs from 0 and preserves existing selection anchors.
    app.mockInput.pressKey(key, { shift }); await app.render();
    expect(body.logicalCursor.col).toBe(body.editBuffer.measureText(leading));
    expect(app.renderer.getCursorState().x).toBe(app.position("한글").x + 1);
    app.mockInput.pressKey("0"); app.mockInput.pressKey("v"); app.mockInput.pressKey(key, { shift }); await app.render();

    expect(body.getSelectedText()).toBe(leading + "한");
    app.mockInput.pressEscape(); app.mockInput.pressKey("j"); app.mockInput.pressKey(key, { shift }); await app.render();
    expect(body.logicalCursor.row).toBe(1); expect(body.logicalCursor.col).toBe(body.editBuffer.measureText(blank.slice(0, -1)));
    expect(app.markdown().visible).toBe(true); expect(app.view.promptDrafts.a1).toBe("Keep this draft");
  } finally { await app.close(); }
});

test("Transcript i never returns sections, bodies, or selections to input while prompt i stays literal", async () => {
  // Do not reserve reading-surface i for input return; retain explicit global focus commands.
  const app = await mount([prose("**문서**")]);
  try {
    await app.settled(); await app.focus(); const sections = app.renderer.currentFocusedRenderable;

    app.mockInput.pressKey("i"); await app.render(); expect(app.renderer.currentFocusedRenderable?.id).toBe(sections?.id);
    app.mockInput.pressEnter(); await app.render(); const body = app.body();
    app.mockInput.pressKey("i"); app.mockInput.pressKey("v"); app.mockInput.pressKey("i"); await app.render();

    expect(app.renderer.currentFocusedRenderable).toBe(body); expect(body.plainText).toBe("문서");
    expect(app.view.promptDrafts.a1).toBe("Keep this draft"); expect(app.sent).toEqual([]);
    pressLeader(app, "a"); app.mockInput.pressKey("i"); await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt"); expect(app.view.promptDrafts.a1).toBe("Keep this drafti");
  } finally { await app.close(); }
});

test("Native Markdown code and emphasis keep styles in cursor and selection modes", async () => {
  // Stars in code stay literal; only prose stars hide as syntax.
  const app = await mount([prose("## Styled\n\n**BOLD_VALUE**\n\n```text\nCODE **literal**\n```")]);
  try {
    await app.settled(); await app.focus(); const height = app.markdown().height;

    app.mockInput.pressEnter(); app.mockInput.pressKey("v"); await app.render();

    const spans = app.captureSpans().lines.flatMap(line => line.spans);
    expect(spans.find(span => span.text.includes("BOLD_VALUE"))!.attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
    expect(app.captureCharFrame()).toContain("CODE **literal**"); expect(app.captureCharFrame()).not.toContain("**BOLD_VALUE**");
    expect(app.captureCharFrame()).not.toContain("```text"); expect(app.markdown().height).toBe(height);
  } finally { await app.close(); }
});

test("Reconnected screens restore cursor and selection using rendered characters", async () => {
  // Never reinterpret new-coordinate selections as source-syntax offsets.
  const source = "## Saved\n\n**한글** after", app = await mount([prose(source)]);
  let preferences: WorkViewPreferences;
  try {
    await app.settled(); await app.focus(); app.mockInput.pressEnter(); await app.render();
    const body = app.body(); body.cursorOffset = body.editBuffer.measureText(body.plainText.slice(0, body.plainText.indexOf("한글")));
    app.mockInput.pressKey("v"); app.mockInput.pressKey("l"); await app.render();
    preferences = structuredClone(app.view.workViewPreferences);
  } finally { await app.close(); }
  const next = await mount([prose(source)], { initialWorkViews: preferences! });
  try {
    // Restoring reading focus in a new UI must not unwrap Markdown.
    await next.settled(); pressTranscriptRead(next); await next.render();

    expect(next.body().getSelectedText()).toBe("한글"); expect(next.markdown().visible).toBe(true);
    expect(next.captureCharFrame()).not.toContain("**한글**"); expect(next.renderer.getCursorState().visible).toBe(true);
    next.mockInput.pressKey("y"); await next.render(); expect(next.copies.at(-1)).toBe("한글");
  } finally { await next.close(); }
});

test("Legacy raw-source selection offsets never apply incorrectly to rendered text", async () => {
  // Unversioned source selections may include hidden Markdown markers.
  const app = await mount([prose("**한글** after")], { initialWorkViews: { active: {}, agentScroll: {}, agentViews: {
    a1: { selectedId: "prose", folded: {}, cursors: { prose: 4 }, mode: "visual", anchor: 2, follow: false },
  } } });
  try {
    await app.settled(); pressTranscriptRead(app); await app.render();

    expect(app.body().plainText).toBe("한글 after"); expect(app.body().cursorOffset).toBe(0);
    expect(app.body().hasSelection()).toBe(false); expect(app.captureCharFrame()).toContain("TEXT");
    expect(app.markdown().visible).toBe(true);
  } finally { await app.close(); }
});

test("Tool commands, results, and user messages never render as Markdown", async () => {
  const literal = "**LITERAL**\n### NOT_A_HEADING\n```text";
  const app = await mount([{ ...prose(literal), kind: "tool", title: "bash", command: "printf '**raw**'" }, { ...prose(literal), id: "user", kind: "user", title: "You" }]);
  try {
    await app.focus(); app.mockInput.pressKey("o", { ctrl: true }); await app.render();
    expect(descendants(app.renderer.root).some((node) => node instanceof MarkdownRenderable)).toBe(false);
    expect(app.captureCharFrame()).toContain("**LITERAL**"); expect(app.captureCharFrame()).toContain("### NOT_A_HEADING");
  } finally { await app.close(); }
});
