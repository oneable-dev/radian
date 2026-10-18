import { expect, test } from "bun:test";
import { CodeRenderable, EditBufferRenderable, MarkdownRenderable, TextAttributes, type Renderable, type TerminalColors } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { TranscriptSection } from "../../agents/transcript.ts";
import { uiTheme } from "../../ui/theme.ts";
import { ok } from "../../result.ts";

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
    body() { const node = app.renderer.currentFocusedRenderable; if (!(node instanceof EditBufferRenderable)) throw new Error("Missing source cursor"); return node; },
    async focus() { app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressKey("HOME"); await render(); },
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

test("Enter는 원문 커서·줄 선택으로 전환하고 Esc는 Markdown 표시로 복귀한다", async () => {
  // 보이는 문법을 제거한 위치를 원문 커서 위치로 오해하지 않도록 원문 읽기를 분리한다.
  const source = "## Heading\r\n\r\n**한글 👨‍👩‍👧‍👦**\r\nlast";
  const app = await mount([prose(source)]);
  try {
    await app.settled(); await app.focus();
    app.mockInput.pressKey("y"); await app.render(); expect(app.copies).toEqual([source]);
    expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).toContain("Enter Source");
    app.mockInput.pressEnter(); await app.render();
    expect(app.body().plainText).toBe(source.replaceAll("\r\n", "\n"));
    expect(app.markdown().visible).toBe(false); expect(app.captureCharFrame()).toContain("Markdown source");
    app.mockInput.pressKey("v", { shift: true }); app.mockInput.pressKey("y"); await app.render();
    // 원문 줄 복사는 CRLF와 Markdown 표식을 보존하고 전송을 발생시키지 않는다.
    expect(app.copies.at(-1)).toBe("## Heading\r\n");
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
    await app.update([prose("### Streaming\n\n**hello 한글**\n\n```text\nfirst\nsecond\n```\n\n| Key | Value |\n|---|---|\n| final | complete |")]);
    await app.settled();
    const frame = app.captureCharFrame(); expect(original.streaming).toBe(false);
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

test("Markdown 스트리밍 중 원문 선택·resize·왕복은 Unicode 선택과 초안을 보존한다", async () => {
  const source = "**한글 👨‍👩‍👧‍👦**\nnext";
  const app = await mount([prose(source, "assistant", true)]);
  try {
    await app.focus(); app.mockInput.pressEnter(); app.mockInput.pressKey("l"); app.mockInput.pressKey("l");
    app.mockInput.pressKey("v"); app.mockInput.pressKey("l"); await app.render();
    expect(app.body().getSelectedText()).toBe("한글");
    await app.update([prose(source + " plus streamed", "assistant", true)]);
    app.resize(70, 16); await app.render(); app.mockInput.pressKey("y"); await app.render();
    expect(app.copies).toEqual(["한글"]); expect(app.view.promptDrafts.a1).toBe("Keep this draft");
    app.mockInput.pressEscape(); await app.settled(); expect(app.markdown().visible).toBe(true);
    app.mockInput.pressEnter(); await app.render(); expect(app.body().cursorOffset).toBe(4);
  } finally { await app.close(); }
});

test("좁은 창에서도 Markdown 표는 가용 너비에 맞추고 원문 구분자를 노출하지 않는다", async () => {
  const app = await mount([prose("| Name | Value |\n|---|---|\n| 한글 항목 | 긴 설명을 단어 단위로 줄바꿈해서 표시합니다 |\n| second | ready |")]);
  try {
    app.resize(80, 26); await app.settled(); await app.focus();
    const scroll = app.renderer.root.findDescendantById("session-transcript")!;
    expect(app.markdown().width).toBeLessThanOrEqual(scroll.width);
    const frame = app.captureCharFrame(); expect(frame).toContain("Name"); expect(frame).toContain("Value");
    expect(frame).toContain("한글 항목"); expect(frame).not.toContain("|---|---|");
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

test("도구 명령·결과와 사용자 메시지는 Markdown으로 해석하지 않는다", async () => {
  const literal = "**LITERAL**\n### NOT_A_HEADING\n```text";
  const app = await mount([{ ...prose(literal), kind: "tool", title: "bash", command: "printf '**raw**'" }, { ...prose(literal), id: "user", kind: "user", title: "You" }]);
  try {
    await app.focus(); app.mockInput.pressKey("o", { ctrl: true }); await app.render();
    expect(descendants(app.renderer.root).some((node) => node instanceof MarkdownRenderable)).toBe(false);
    expect(app.captureCharFrame()).toContain("**LITERAL**"); expect(app.captureCharFrame()).toContain("### NOT_A_HEADING");
  } finally { await app.close(); }
});
