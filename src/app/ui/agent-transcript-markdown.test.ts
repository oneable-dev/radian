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

const document = "### 실제 구조\n\n**강조한 답변**과 `inline code`\n\n[README](https://example.invalid/docs)\n\n- 첫 번째 항목\n- 두 번째 항목\n\n```text\nCODE_LITERAL **keep stars**\n```\n\n| 항목 | 값 |\n| --- | --- |\n| Radian | ready |";

test("답변은 실제 OpenTUI Markdown으로 제목·강조·코드·링크·목록·표를 렌더링한다", async () => {
  // 사용자 스크린샷의 Markdown 문법을 실제 네이티브 렌더러에 전달한다.
  const app = await mount([prose(document)]);
  try {
    await app.settled();
    const frame = app.captureCharFrame();
    // 표의 셀 내용뿐 아니라 외곽선과 열·행 구분선이 실제 화면에 그려져야 한다.
    expect(frame).toMatch(/┌─+┬─+┐/u); expect(frame).toMatch(/├─+┼─+┤/u); expect(frame).toMatch(/└─+┴─+┘/u);
    // 표시 문법은 숨기되 코드 내부 문법과 표 셀은 내용 그대로 유지한다.
    expect(app.markdown()).toBeInstanceOf(MarkdownRenderable); expect(app.markdown().streaming).toBe(false);
    for (const text of ["실제 구조", "강조한 답변", "inline code", "README", "첫 번째 항목", "두 번째 항목", "CODE_LITERAL **keep stars**", "Radian", "ready"]) expect(frame).toContain(text);
    for (const syntax of ["### 실제 구조", "**강조한 답변**", "`inline code`", "```text", "[README](", "| --- | --- |", "| Radian |"]) expect(frame).not.toContain(syntax);
    const spans = app.captureSpans().lines.flatMap((line) => line.spans);
    expect(spans.find((span) => span.text.includes("강조한 답변"))!.attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
    expect(app.view.promptDrafts.a1).toBe("Keep this draft"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test.each(["**FIRST_FRAME_TEXT**", "```typescript\nconst FIRST_FRAME_TEXT = 1;\n```"])("완료된 답변은 로컬 하이라이터 준비 전에도 최초 프레임부터 내용을 표시한다: %s", async (source) => {
  // 문법 분석 준비 중에도 본문·코드 블록을 빈 영역으로 숨기지 않는다.
  const app = await mount([prose(source)]);
  try {
    expect(app.captureCharFrame()).toContain("FIRST_FRAME_TEXT");
    expect(app.captureCharFrame()).not.toContain("**FIRST_FRAME_TEXT**");
    await app.settled(); expect(app.captureCharFrame()).toContain("FIRST_FRAME_TEXT");
  } finally { await app.close(); }
});

test("Enter로 커서를 표시해도 Markdown 화면·높이를 유지하고 보이는 줄과 원문 전체를 구분해 복사한다", async () => {
  // 원문 문법은 숨겨 두되 전체 원문 복사 기능은 그대로 보존한다.
  const source = "## Heading\r\n\r\n**한글 👨‍👩‍👧‍👦**\r\nlast";
  const app = await mount([prose(source)]);
  try {
    await app.settled(); await app.focus();
    app.mockInput.pressKey("y"); await app.render(); expect(app.copies).toEqual([source]);
    const height = app.markdown().height;
    const markdownFrame = () => app.captureCharFrame().split("\n").slice(app.markdown().y, app.markdown().y + height).join("\n");
    const before = markdownFrame();
    expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).toContain("<CR> Text");

    // 읽기 모드 진입은 표시 버퍼 교체나 Markdown 문법 노출을 일으키지 않는다.
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

test.each([false, true])("Thinking Markdown은 색 문법과 관계없이 회색 이탤릭·기본 배경을 유지한다: %j", async (light) => {
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

test("미완성 Markdown 스트리밍을 같은 렌더러로 갱신하고 완료 시 표·코드 블록을 확정한다", async () => {
  const app = await mount([prose("### Streaming\n\n**hello", "assistant", true)]);
  try {
    const original = app.markdown(); expect(app.captureCharFrame()).toContain("hello");
    await app.update([prose("### Streaming\n\n**hello 한글**\n\n```text\nfirst", "assistant", true)]);
    await app.settled(); expect(app.markdown()).toBe(original); expect(original.streaming).toBe(true);
    // 마지막 셀이 아직 전송 중인 표도 테두리와 수신한 내용을 함께 보여 준다.
    const prefix = "### Streaming\n\n**hello 한글**\n\n```text\nfirst\nsecond\n```\n\n| Key | Value |\n|---|---|\n";
    await app.update([prose(prefix + "| final | comp", "assistant", true)]); await app.settled();
    expect(original.streaming).toBe(true); expect(app.captureCharFrame()).toContain("comp");
    expect(app.captureCharFrame()).toMatch(/┌─+┬─+┐/u);

    // 응답이 완료되어도 같은 렌더러의 표 테두리와 최종 셀 내용이 유지된다.
    await app.update([prose(prefix + "| final | complete |")]); await app.settled();
    const frame = app.captureCharFrame(); expect(original.streaming).toBe(false);
    expect(frame).toMatch(/┌─+┬─+┐/u); expect(frame).toMatch(/└─+┴─+┘/u);
    for (const text of ["hello 한글", "first", "second", "final", "complete"]) expect(frame).toContain(text);
    expect(frame).not.toContain("```text"); expect(frame).not.toContain("|---|---|");
  } finally { await app.close(); }
});

test("잘린 미리보기처럼 종료 문법이 없는 완료 메시지도 내용을 숨기지 않는다", async () => {
  // 저장 미리보기의 길이 제한으로 닫는 fence가 없을 수 있다.
  const app = await mount([prose("### Truncated\n\n**unfinished emphasis\n\n```typescript\nconst clipped = 1;")]);
  try {
    await app.settled();
    const frame = app.captureCharFrame();
    expect(frame).toContain("Truncated"); expect(frame).toContain("unfinished emphasis"); expect(frame).toContain("clipped");
    expect(app.markdown().streaming).toBe(false); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("Markdown 스트리밍 중 표시된 글자의 선택·resize·왕복은 Unicode 선택과 초안을 보존한다", async () => {
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

test("좁은 창에서도 Markdown 표는 가용 너비에 맞추고 원문 구분자를 노출하지 않는다", async () => {
  const app = await mount([prose("| Name | Value |\n|---|---|\n| 한글 항목 | 긴 설명을 단어 단위로 줄바꿈해서 표시합니다 |\n| second | ready |")]);
  try {
    app.resize(80, 26); await app.settled(); await app.focus();
    const scroll = app.renderer.root.findDescendantById("session-transcript")!;
    expect(app.markdown().width).toBeLessThanOrEqual(scroll.width);
    // 좁은 화면에서도 양쪽 테두리와 마지막 행이 잘리지 않는다.
    const frame = app.captureCharFrame(); expect(frame).toContain("Name"); expect(frame).toContain("Value");
    expect(frame).toMatch(/┌─+┬─+┐/u); expect(frame).toMatch(/└─+┴─+┘/u);
    for (const text of ["한글 항목", "second", "ready"]) expect(frame).toContain(text);
    // 한글은 음절 사이에서도 줄바꿈되므로 보이는 값 열을 연결해 전체 내용의 보존을 확인한다.
    const values = frame.split("\n").map((line) => line.split("│")).filter((cells) => cells.length >= 4)
      .map((cells) => cells.at(-2)).join("").replace(/\s+/gu, "");
    expect(values).toContain("긴설명을단어단위로줄바꿈해서표시합니다");
    expect(frame).not.toContain("|---|---|");
    expect(app.view.promptDrafts.a1).toBe("Keep this draft");
  } finally { await app.close(); }
});

test("하이라이터 처리 중 화면을 제거해도 늦은 완료가 파괴된 Markdown이나 스타일을 갱신하지 않는다", async () => {
  // 문법 준비가 비동기인 화면을 즉시 닫는 생명 주기 경계를 보호한다.
  const app = await mount([prose("### Closing\n\n**Still highlighting**\n\n```typescript\nconst closing = true;\n```")]);
  const pending = descendants(app.renderer.root).filter((node): node is CodeRenderable => node instanceof CodeRenderable).map((node) => node.highlightingDone);
  const markdown = app.markdown();
  await app.close(); await Promise.all(pending);
  // 실제 네이티브 버퍼를 제거한 뒤에도 예외나 상태 변경을 발생시키지 않는다.
  expect(markdown.isDestroyed).toBe(true); expect(app.sent).toEqual([]);
});

test("상태·문법·Markdown 스타일은 실제 코드·인라인 코드·제목·표에서 독립적으로 적용된다", async () => {
  // 같은 초록색 기본값을 쓰는 문자열과 성공 상태를 서로 다르게 재정의한다.
  const app = await mount([prose("## Semantic title\n\n```typescript\nconst literal = \"semantic_string\";\n```\n\n`semantic_inline`\n\n| Head | Tail |\n|---|---|\n| value | done |")]);
  try {
    uiTheme(app.renderer).configure(palette(false), { styles: {
      "status.success": { fg: "#FF00FF" }, "syntax.string": { fg: "#12AB34" },
      "markup.inlineCode": { fg: "#2299CC", italic: true }, "markup.heading": { fg: "#CC7722", underline: true },
      "markup.tableBorder": { fg: "#5566AA" },
    } });

    // 완성된 네이티브 문법 강조와 표를 실제 화면으로 확인한다.
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

test("카드 배경을 해제하면 재정의된 본문 배경을 상속한다", async () => {
  // 카드의 틴트를 제거할 때 터미널 기본색을 새 배경 위에 덧칠하면 안 된다.
  const app = await mount([{ ...prose("CARD_SURFACE"), kind: "user" }]);
  try {
    uiTheme(app.renderer).configure(palette(false), { styles: { "ui.text": { bg: "#112233" }, "transcript.user": { bg: null } } });
    await app.settled();

    const span = app.captureSpans().lines.flatMap(line => line.spans).find(span => span.text.includes("CARD_SURFACE"))!;
    expect(span.bg.toInts().slice(0, 3)).toEqual([17, 34, 51]);
    expect(app.view.promptDrafts.a1).toBe("Keep this draft"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("표 셀 위의 커서와 문자 선택은 표 테두리·스타일을 유지하고 보이는 한글을 복사한다", async () => {
  // 표는 원문 파이프 문법이 아닌 실제 네이티브 표 레이아웃으로 탐색한다.
  const opened: string[] = [];
  const app = await mount([prose("## Table\n\n| Name | Value |\n|---|---|\n| [표한글](https://example.invalid/table) | ready |")], {
    onOpenTranscriptUrl: async url => { opened.push(url); return ok(undefined); },
  });
  try {
    await app.settled(); await app.focus(); app.mockInput.pressEnter(); await app.render();
    const body = app.body(), offset = body.plainText.indexOf("표한글");
    expect(offset).toBeGreaterThanOrEqual(0);

    // 화면에 표시된 셀로 이동하고 인접한 두 글자를 선택한다.
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

test("강조된 긴 문장은 화면 행으로 이동하지만 줄 선택은 자동 줄바꿈을 복사하지 않는다", async () => {
  // 네이티브 표시 행과 논리 문장 줄은 서로 다른 좌표 체계이다.
  const line = "한글 é 👨‍👩‍👧‍👦 " + "wrapped words ".repeat(20).trimEnd();
  const app = await mount([prose(`**${line}**\nnext`)]);
  try {
    app.resize(60, 20); await app.settled(); await app.focus(); app.mockInput.pressEnter(); await app.render();
    const first = app.renderer.getCursorState();

    // Ctrl+N/P는 표시된 줄을 이동하고 V는 실제 논리 줄 전체를 선택한다.
    app.mockInput.pressKey("n", { ctrl: true }); await app.render();
    expect(app.renderer.getCursorState().y).toBe(first.y + 1); expect(app.body().logicalCursor.row).toBe(0);
    app.mockInput.pressKey("p", { ctrl: true }); app.mockInput.pressKey("v", { shift: true });
    app.resize(48, 20); await app.render(); app.mockInput.pressKey("y"); await app.render();

    expect(app.copies.at(-1)).toBe(line + "\n");
    expect(app.markdown().visible).toBe(true); expect(app.captureCharFrame()).not.toContain("**한글");
    expect(app.view.promptDrafts.a1).toBe("Keep this draft");
  } finally { await app.close(); }
});

test("짧은 표시 줄을 지나는 세로 이동은 원래 열을 기억하고 가로 이동은 목표 열을 갱신한다", async () => {
  // Markdown 기호가 아닌 표시된 열을 기준으로 Neovim식 세로 이동을 유지한다.
  const app = await mount([prose("**abcdefghij**\nx\nabcdefghij")]);
  try {
    await app.settled(); await app.focus(); app.mockInput.pressEnter(); await app.render();
    for (let index = 0; index < 8; index++) app.mockInput.pressKey("l");

    // 짧은 중간 줄에서 열이 잘려도 다음 긴 줄에서는 원래 열로 돌아간다.
    app.mockInput.pressKey("n", { ctrl: true }); app.mockInput.pressKey("n", { ctrl: true }); await app.render();

    expect(app.body().logicalCursor.row).toBe(2); expect(app.body().logicalCursor.col).toBe(8);
    app.mockInput.pressKey("h"); app.mockInput.pressKey("p", { ctrl: true }); app.mockInput.pressKey("p", { ctrl: true }); await app.render();
    expect(app.body().logicalCursor.row).toBe(0); expect(app.body().logicalCursor.col).toBe(7);
    expect(app.markdown().visible).toBe(true);
  } finally { await app.close(); }
});

test.each([{ key: "^", shift: false }, { key: "6", shift: true }])("$key 첫 비공백 이동은 한글·탭과 공백뿐인 줄에서도 Vim 위치를 따른다", async ({ key, shift }) => {
  // 코드 블록의 선행 공백은 Markdown 문법이 아니라 표시되는 원문 내용이다.
  const first = " \t  한글 value", blank = " \t  ";
  const app = await mount([prose(`\`\`\`text\n${first}\n${blank}\nnext\n\`\`\``)]);
  try {
    await app.settled(); await app.focus(); app.mockInput.pressEnter(); await app.render();
    const body = app.body(), leading = " \t  "; app.mockInput.pressKey("END");

    // 첫 비공백 이동은 0과 구분되고, 선택 중에는 원래 anchor를 유지한다.
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

test("Transcript의 i는 섹션·본문·선택에서 입력창으로 돌아가지 않고 프롬프트의 i는 문자로 입력한다", async () => {
  // 읽기 표면의 i를 입력창 복귀로 예약하지 않고 명시적인 전역 포커스 명령은 유지한다.
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

test("네이티브 Markdown의 코드 블록과 강조는 커서·선택 모드에서도 같은 스타일로 표시한다", async () => {
  // 코드 안의 별표는 리터럴이며 일반 본문의 별표만 문법으로 숨겨야 한다.
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

test("다시 연결한 화면에서도 렌더링된 글자 기준 커서와 선택을 복원한다", async () => {
  // 새 좌표 체계로 저장한 선택은 원문 문법의 오프셋으로 재해석하면 안 된다.
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
    // 새 UI에서 읽기 포커스를 복원해도 Markdown을 풀지 않는다.
    await next.settled(); pressTranscriptRead(next); await next.render();

    expect(next.body().getSelectedText()).toBe("한글"); expect(next.markdown().visible).toBe(true);
    expect(next.captureCharFrame()).not.toContain("**한글**"); expect(next.renderer.getCursorState().visible).toBe(true);
    next.mockInput.pressKey("y"); await next.render(); expect(next.copies.at(-1)).toBe("한글");
  } finally { await next.close(); }
});

test("이전 원문 모드의 선택 오프셋은 새 표시 텍스트에 잘못 적용하지 않는다", async () => {
  // 버전 표시가 없는 원문 선택은 숨겨진 Markdown 표식을 포함할 수 있다.
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

test("도구 명령·결과와 사용자 메시지는 Markdown으로 해석하지 않는다", async () => {
  const literal = "**LITERAL**\n### NOT_A_HEADING\n```text";
  const app = await mount([{ ...prose(literal), kind: "tool", title: "bash", command: "printf '**raw**'" }, { ...prose(literal), id: "user", kind: "user", title: "You" }]);
  try {
    await app.focus(); app.mockInput.pressKey("o", { ctrl: true }); await app.render();
    expect(descendants(app.renderer.root).some((node) => node instanceof MarkdownRenderable)).toBe(false);
    expect(app.captureCharFrame()).toContain("**LITERAL**"); expect(app.captureCharFrame()).toContain("### NOT_A_HEADING");
  } finally { await app.close(); }
});
