import { expect, test } from "bun:test";
import { EditBufferRenderable, ScrollBoxRenderable, TextAttributes, type TerminalColors } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { defaultKeymap, parseKeymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";
import { uiTheme } from "../../ui/theme.ts";
import { ok } from "../../result.ts";
import type { TranscriptSection } from "../../agents/transcript.ts";
import type { WorkViewPreferences } from "../../runtime/protocol.ts";

const section = (text: string): TranscriptSection => ({ id: "message", kind: "assistant", title: "Agent", text, status: "complete" });
async function mount(initial: TranscriptSection[], actions: Partial<WorkbenchActions> = {}) {
  const app = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true, exitOnCtrlC: false });
  const selection = new WorkspaceSelection(demoWorkspace());
  const copies: string[] = [], prompts: string[] = [];
  let current = initial;
  const view = new Workbench(app.renderer, selection, {
    onNewSession: () => {}, onCloseSession: () => {}, initialDrafts: { a1: "unsent draft" },
    onPrompt: (_id, text) => { prompts.push(text); return ok(undefined); },
    onCopyTranscript: async (text) => { copies.push(text); return ok("Copied to clipboard"); },
    getSessionDetails: () => ({ status: "complete", output: "", error: null, sections: current }), ...actions,
  });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  await render();
  const scroll = app.renderer.root.findDescendantById("session-transcript");
  if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("Missing transcript viewport");
  return { ...app, view, copies, prompts, scroll, render,
    async enter() { app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressKey("HOME"); app.mockInput.pressEnter(); await render(); },
    body() { const body = app.renderer.currentFocusedRenderable; if (!(body instanceof EditBufferRenderable)) throw new Error("Missing focused text"); return body; },
    state() { return view.workViewPreferences.agentViews?.a1; },
    async copy() { app.mockInput.pressKey("y"); await render(); },
    async copyLine() { app.mockInput.pressKey("y"); app.mockInput.pressKey("y"); await render(); },
    async update(next: TranscriptSection[]) { current = next; selection.replaceSnapshot(demoWorkspace()); await render(); },
    async close() { view.dispose(); await app.dispose(); },
  };
}

test("V는 현재 논리 줄 전체를 선택하고 아래로 확장한 원문과 실제 개행만 복사한다", async () => {
  // Starting inside a word must still select from the first column, unlike character selection.
  const app = await mount([section("alpha beta\n한글 👨‍👩‍👧‍👦\nlast")]);
  try {
    await app.enter(); app.mockInput.pressKey("w"); app.mockInput.pressKey("v", { shift: true }); await app.render();
    expect(app.captureCharFrame()).toContain("VISUAL LINE");
    expect(app.body().getSelectedText()).toBe("alpha beta\n");

    app.mockInput.pressKey("j"); await app.copy();

    expect(app.copies).toEqual(["alpha beta\n한글 👨‍👩‍👧‍👦\n"]);
    expect(app.state()?.mode).toBe("text"); expect(app.state()?.linewise).toBeUndefined();
    expect(app.prompts).toEqual([]); expect(app.view.promptDrafts.a1).toBe("unsent draft");
  } finally { await app.close(); }
});

test.each(["first\n\nlast", "first\n\nlast\n"])("줄 선택은 위로 확장해도 빈 줄과 EOF 개행을 정확히 보존한다: %j", async (text) => {
  const app = await mount([section(text)]);
  try {
    await app.enter(); app.mockInput.pressKey("g", { shift: true });
    if (text.endsWith("\n")) app.mockInput.pressKey("k");
    app.mockInput.pressKey("v", { shift: true }); app.mockInput.pressKey("k"); await app.copy();

    expect(app.copies).toEqual([text.endsWith("\n") ? "\nlast\n" : "\nlast"]);
  } finally { await app.close(); }
});

test("긴 줄의 자동 줄바꿈과 resize는 Visual Line의 논리 줄 선택 범위를 바꾸지 않는다", async () => {
  const line = "한글 é 👨‍👩‍👧‍👦 " + "wrapped word ".repeat(20);
  const app = await mount([section(`${line}\nnext\nlast`)]);
  try {
    await app.enter(); app.mockInput.pressKey("v", { shift: true });
    app.resize(60, 12); await app.render();
    expect(app.body().getSelectedText()).toBe(line + "\n");
    app.mockInput.pressKey("j"); await app.copy();

    expect(app.copies).toEqual([line + "\nnext\n"]);
    expect(app.captureCharFrame().split("\n")[11]).toContain("Radian");
  } finally { await app.close(); }
});

test("v와 V 전환은 기존 anchor를 유지하고 V를 다시 누르면 읽기 모드로 돌아간다", async () => {
  const app = await mount([section("alpha beta\nnext")]);
  try {
    await app.enter(); app.mockInput.pressKey("w"); app.mockInput.pressKey("v"); app.mockInput.pressKey("l");
    const anchor = app.state()?.anchor;
    expect(app.body().getSelectedText()).toBe("be");

    app.mockInput.pressKey("v", { shift: true });
    expect(app.state()?.anchor).toBe(anchor); expect(app.body().getSelectedText()).toBe("alpha beta\n");
    app.mockInput.pressKey("v"); expect(app.body().getSelectedText()).toBe("be");
    app.mockInput.pressKey("v", { shift: true }); app.mockInput.pressKey("v", { shift: true }); await app.render();

    expect(app.state()?.mode).toBe("text"); expect(app.state()?.linewise).toBeUndefined();
    expect(app.body().hasSelection()).toBe(false);
  } finally { await app.close(); }
});

test("스트리밍으로 늘어난 줄 선택은 새 UI 복원 후에도 linewise 종류와 범위를 유지한다", async () => {
  let preferences: WorkViewPreferences | undefined;
  const app = await mount([section("first\nsecond")], { onWorkViewsChange: (state) => { preferences = state; } });
  try {
    await app.enter(); app.mockInput.pressKey("v", { shift: true }); app.mockInput.pressKey("j");
    await app.update([section("first\nsecond plus stream")]);
    expect(app.body().getSelectedText()).toBe("first\nsecond plus stream");
    expect(app.state()?.linewise).toBe(true);
  } finally { await app.close(); }
  const next = await mount([section("first\nsecond plus stream")], { initialWorkViews: preferences! });
  try {
    next.mockInput.pressKey("t", { ctrl: true }); await next.render();
    expect(next.captureCharFrame()).toContain("VISUAL LINE");
    await next.copy();

    expect(next.copies).toEqual(["first\nsecond plus stream"]);
  } finally { await next.close(); }
});

test("늦은 복사 응답은 문자 선택에서 줄 선택으로 바꾼 새 선택을 해제하지 않는다", async () => {
  const pending = Promise.withResolvers<ReturnType<typeof ok<string>>>();
  const app = await mount([section("first\nsecond")], { onCopyTranscript: () => pending.promise });
  try {
    await app.enter(); app.mockInput.pressKey("v"); app.mockInput.pressKey("y"); await Promise.resolve();
    app.mockInput.pressKey("v", { shift: true });

    pending.resolve(ok("Copied to clipboard")); await app.render();

    expect(app.state()?.linewise).toBe(true); expect(app.body().getSelectedText()).toBe("first\n");
  } finally { pending.resolve(ok("Copied to clipboard")); await app.close(); }
});

test("Ctrl+D/U는 본문과 선택에서 반 viewport만 이동하고 anchor는 유지한다", async () => {
  const lines = Array.from({ length: 80 }, (_, index) => `line-${index}`);
  const app = await mount([section(lines.join("\n"))]);
  try {
    await app.enter(); const half = Math.floor(app.scroll.viewport.height / 2);
    app.mockInput.pressKey("d", { ctrl: true });
    expect(app.body().logicalCursor.row).toBe(half);
    app.mockInput.pressKey("u", { ctrl: true }); expect(app.body().logicalCursor.row).toBe(0);

    app.mockInput.pressKey("v", { shift: true }); app.mockInput.pressKey("d", { ctrl: true }); await app.copy();

    expect(app.copies).toEqual([lines.slice(0, half + 1).join("\n") + "\n"]);
    expect(app.prompts).toEqual([]);
  } finally { await app.close(); }
});

test.each([120, 60])("너비 %i에서 Ctrl+D/U는 현재 선택에서 반 화면 거리의 섹션으로 이동한다", async (width) => {
  // One-line sections have a two-row stride including their gap, not a one-row item count.
  const app = await mount(Array.from({ length: 30 }, (_, index) => ({ ...section(`body ${index}`), id: `section-${index}` })));
  try {
    app.resize(width, 30); await app.render();
    app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressKey("HOME"); await app.render();
    const top = app.scroll.scrollTop, step = Math.max(1, Math.floor(app.scroll.viewport.height / 4));

    app.mockInput.pressKey("d", { ctrl: true }); await app.render();
    expect(app.state()?.selectedId).toBe(`section-${step}`);
    // A jump already inside the viewport must not scroll merely to reach a fixed scroll offset.
    expect(app.scroll.scrollTop).toBe(top);
    app.mockInput.pressKey("d", { ctrl: true }); await app.render();
    expect(app.state()?.selectedId).toBe(`section-${2 * step}`);
    app.mockInput.pressKey("u", { ctrl: true }); await app.render();
    expect(app.state()?.selectedId).toBe(`section-${step}`);
    app.mockInput.pressKey("u", { ctrl: true }); await app.render();

    // Ordinary section movement and native prompt/PTY input ownership remain unchanged.
    expect(app.state()?.selectedId).toBe("section-0");
    app.mockInput.pressKey("j"); await app.render(); expect(app.state()?.selectedId).toBe("section-1");
    app.mockInput.pressEnter(); app.mockInput.pressEscape(); app.mockInput.pressKey("k"); await app.render();
    expect(app.state()?.selectedId).toBe("section-0");
    app.mockInput.pressKey("n", { ctrl: true }); await app.render(); expect(app.state()?.selectedId).toBe("section-1");
    app.mockInput.pressKey("p", { ctrl: true }); await app.render(); expect(app.state()?.selectedId).toBe("section-0");
    expect(app.prompts).toEqual([]); expect(app.view.promptDrafts.a1).toBe("unsent draft");
    const keymap = defaultKeymap();
    expect(keymap.bound("ctrl+d", "prompt")).toBe(false); expect(keymap.bound("ctrl+u", "terminal")).toBe(false);
    expect(keymap.bound("ctrl+n", "transcript")).toBe(true); expect(keymap.bound("ctrl+p", "transcript")).toBe(true);
  } finally { await app.close(); }
});

test("반 페이지 섹션 점프는 접힌 카드와 펼친 본문의 실제 높이를 반영한다", async () => {
  // A folded tool fits before the target, but its expanded body is taller than half a viewport.
  const app = await mount([
    { ...section("START"), id: "start" },
    { ...section("TOOL_LINE\n".repeat(40)), id: "tool", kind: "tool", title: "read" },
    { ...section("TARGET_LINE\n".repeat(40)), id: "target" },
  ]);
  try {
    app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressKey("HOME"); await app.render();

    app.mockInput.pressKey("d", { ctrl: true }); await app.render();
    expect(app.state()?.selectedId).toBe("target");
    app.mockInput.pressKey("u", { ctrl: true }); await app.render();
    expect(app.state()?.selectedId).toBe("start");
    app.mockInput.pressKey("j"); app.mockInput.pressKey("o", { ctrl: true }); await app.render();
    app.mockInput.pressKey("HOME"); app.mockInput.pressKey("d", { ctrl: true }); await app.render();

    // The next oversized section is still reachable, without skipping it or stalling on the current one.
    expect(app.state()?.selectedId).toBe("tool");
    app.mockInput.pressKey("d", { ctrl: true }); await app.render();
    expect(app.state()?.selectedId).toBe("target");
    app.mockInput.pressKey("u", { ctrl: true }); await app.render();
    expect(app.state()?.selectedId).toBe("tool");
  } finally { await app.close(); }
});

test("반 페이지 섹션 점프는 처음·끝에서 멈추고 단일·빈 대화에서도 안전하다", async () => {
  // Both sections exceed a viewport, so every jump must still advance by at least one section.
  const first = { ...section("FIRST_LINE\n".repeat(80)), id: "first" };
  const app = await mount([first, { ...section("LAST_LINE\n".repeat(80)), id: "last" }]);
  try {
    app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressKey("HOME"); await app.render();

    app.mockInput.pressKey("u", { ctrl: true }); await app.render(); expect(app.state()?.selectedId).toBe("first");
    app.mockInput.pressKey("d", { ctrl: true }); await app.render(); expect(app.state()?.selectedId).toBe("last");
    app.mockInput.pressKey("d", { ctrl: true }); await app.render(); expect(app.state()?.selectedId).toBe("last");
    app.mockInput.pressKey("u", { ctrl: true }); await app.render(); expect(app.state()?.selectedId).toBe("first");
    await app.update([first]);
    app.mockInput.pressKey("d", { ctrl: true }); app.mockInput.pressKey("u", { ctrl: true }); await app.render();
    expect(app.state()?.selectedId).toBe("first");
    await app.update([]);
    app.mockInput.pressKey("d", { ctrl: true }); app.mockInput.pressKey("u", { ctrl: true }); await app.render();

    // Navigation cannot invent a selection or submit the retained draft at a boundary.
    expect(app.state()?.selectedId).toBeNull();
    expect(app.prompts).toEqual([]); expect(app.view.promptDrafts.a1).toBe("unsent draft");
  } finally { await app.close(); }
});

test("반 페이지 섹션 점프와 도움말은 사용자 키 재할당을 따른다", async () => {
  // Remapped shortcuts must change navigation and hints together, not retain hidden default actions.
  const keymap = expectOk(parseKeymap({ bindings: {
    "transcript.half-page-down": [{ keys: "alt+d", scope: "transcript" }],
    "transcript.half-page-up": [{ keys: "alt+u", scope: "transcript" }],
  } }));
  const app = await mount(Array.from({ length: 30 }, (_, index) => ({ ...section(`body ${index}`), id: `section-${index}` })), { keymap });
  try {
    app.resize(180, 60); await app.render();
    app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressKey("HOME"); await app.render();
    const step = Math.max(1, Math.floor(app.scroll.viewport.height / 4));

    app.mockInput.pressKey("d", { ctrl: true }); await app.render(); expect(app.state()?.selectedId).toBe("section-0");
    app.mockInput.pressKey("d", { meta: true }); await app.render(); expect(app.state()?.selectedId).toBe(`section-${step}`);
    app.mockInput.pressKey("u", { meta: true }); await app.render(); expect(app.state()?.selectedId).toBe("section-0");
    app.mockInput.pressKey("F1"); await app.render();

    // Help describes section jumps with the effective bindings, while help itself remains scrollable.
    expect(app.captureCharFrame()).toContain("<M-d>/<M-u> half-page section jump");
    app.resize(60, 18); await app.render(); app.mockInput.pressKey("HOME"); await app.render();
    const top = app.scroll.scrollTop;
    app.mockInput.pressKey("d", { meta: true }); await app.render();
    expect(app.scroll.scrollTop).toBeGreaterThan(top);
    expect(app.state()?.selectedId).toBe("section-0");
  } finally { await app.close(); }
});

function palette(light: boolean): TerminalColors {
  return { palette: ["#000000", "#CC2222", "#228822", "#998800", "#2255AA", "#AA22AA", "#117799", "#DDDDDD"],
    defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
    cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null,
    highlightForeground: null, highlightBackground: null };
}

test("Thinking은 저장된 접힘 설정이 있어도 본문을 표시하고 모든 접기 명령에서 제외한다", async () => {
  // 구버전에서 저장한 접힘 때문에 생각 본문이 다시 사라지면 안 된다.
  const app = await mount([
    { ...section("THINK_ALWAYS_VISIBLE"), kind: "thinking", title: "Thinking" },
    { ...section("TOOL_HIDDEN"), id: "tool", kind: "tool", title: "read" },
  ], { initialWorkViews: { active: {}, agentScroll: {}, agentViews: { a1: {
    selectedId: "message", folded: { message: true }, cursors: {}, mode: "sections", anchor: null, follow: false,
  } } } });
  try {
    await app.enter(); app.mockInput.pressEscape();
    app.mockInput.pressKey("o", { ctrl: true }); app.mockInput.pressKey("z"); app.mockInput.pressKey("a");
    app.mockInput.pressKey("z"); app.mockInput.pressKey("m"); await app.render();
    // 도구 접기는 유지하지만 Thinking에는 레이블·안내·접힘 설정을 남기지 않는다.
    const frame = app.captureCharFrame();
    expect(frame).toContain("THINK_ALWAYS_VISIBLE"); expect(frame).not.toContain("[thinking]");
    expect(frame.split("\n")[app.renderer.height - 1]).not.toContain(" Fold");
    expect(app.state()?.folded.message).toBeUndefined(); expect(app.state()?.folded.tool).toBe(true);
    expect(frame).not.toContain("TOOL_HIDDEN");
    app.mockInput.pressEnter(); expect(app.body().plainText).toBe("THINK_ALWAYS_VISIBLE");
    await app.copyLine(); expect(app.copies).toEqual(["THINK_ALWAYS_VISIBLE"]);
  } finally { await app.close(); }
});

test("구버전 Thinking 헤더 선택은 해제하되 별도로 저장한 본문 커서는 복원한다", async () => {
  // 사라진 헤더의 선택 좌표를 Thinking 본문에 잘못 적용해서는 안 된다.
  const app = await mount([{ ...section("THINK_RESTORED_BODY"), kind: "thinking", title: "Thinking" }], {
    initialWorkViews: { active: {}, agentScroll: {}, agentViews: { a1: {
      selectedId: "message", folded: { message: true }, cursors: { message: 4 }, headingCursors: { message: 2 },
      mode: "visual", anchor: 0, linewise: true, follow: false,
    } } },
  });
  try {
    app.mockInput.pressKey("t", { ctrl: true }); await app.render();
    // 읽던 본문 위치는 보존하고 이전 헤더의 시각 선택만 정리한다.
    expect(app.body().plainText).toBe("THINK_RESTORED_BODY"); expect(app.body().cursorOffset).toBe(4);
    expect(app.state()?.mode).toBe("text"); expect(app.state()?.anchor).toBeNull();
    expect(app.state()?.linewise).toBeUndefined(); expect(app.body().hasSelection()).toBe(false);
    expect(app.state()?.folded.message).toBeUndefined();
  } finally { await app.close(); }
});

test.each([false, true])("Thinking 본문은 대화와 같은 배경·정렬에 이탤릭과 중립 회색만 적용한다: %j", async (light) => {
  // 색이 약간 섞인 터미널 배경과 muted override에서도 Thinking 자체는 무채색이어야 한다.
  const app = await mount([{ ...section("THINK_VISIBLE"), kind: "thinking", title: "Thinking" }, { ...section("ANSWER_VISIBLE"), id: "answer" }]);
  try {
    uiTheme(app.renderer).configure(palette(light), { muted: "#CC2288" }); await app.render();
    const lines = app.captureSpans().lines, spans = lines.flatMap((line) => line.spans);
    const thinking = spans.find((span) => span.text.includes("THINK_VISIBLE"));
    const answer = spans.find((span) => span.text.includes("ANSWER_VISIBLE"));
    if (!thinking || !answer) throw new Error(`Missing prose\n${app.captureCharFrame()}`);
    // 헤더를 펼칠 필요 없이 본문이 보이고, 선택 표시와 무관하게 회색 이탤릭을 유지한다.
    const [r, g, b] = thinking.fg.toInts(); expect(r).toBe(g); expect(g).toBe(b);
    expect(thinking.fg.equals(answer.fg)).toBe(false);
    expect(thinking.attributes & TextAttributes.ITALIC).toBe(TextAttributes.ITALIC);
    expect(answer.attributes & TextAttributes.ITALIC).toBe(0);
    expect(thinking.bg.toInts()).toEqual(uiTheme(app.renderer).colors.panel.toInts());
    const rows = app.captureCharFrame().split("\n");
    for (const text of ["THINK_VISIBLE", "ANSWER_VISIBLE"]) expect(rows.find((line) => line.includes(text))!.indexOf(text)).toBe(app.scroll.content.x);
    expect(app.captureCharFrame()).not.toContain("[thinking]"); expect(app.captureCharFrame()).not.toContain("to expand");
  } finally { await app.close(); }
});

test("Thinking 스트리밍·선택·resize 중에도 본문은 보이고 접기 키는 선택을 해제하지 않는다", async () => {
  // 이미 표시 중인 Thinking을 선택한 상태에서 토큰이 늘어나는 경우를 보호한다.
  const app = await mount([{ ...section("THINK_STREAM"), kind: "thinking", title: "Thinking", status: "streaming" }]);
  try {
    await app.enter(); app.mockInput.pressKey("v"); app.mockInput.pressKey("l");
    app.mockInput.pressKey("o", { ctrl: true });
    await app.update([{ ...section("THINK_STREAM plus more"), kind: "thinking", title: "Thinking", status: "streaming" }]);
    app.resize(60, 12); await app.render();
    // 생각 본문은 숨기거나 태그로 교체하지 않으며 원문 선택·초안도 보존한다.
    expect(app.state()?.mode).toBe("visual"); expect(app.body().getSelectedText()).toBe("TH");
    expect(app.captureCharFrame()).toContain("THINK_STREAM plus more");
    expect(app.captureCharFrame()).not.toContain("[thinking]");
    await app.copy(); expect(app.copies).toEqual(["TH"]); expect(app.prompts).toEqual([]);
    expect(app.view.promptDrafts.a1).toBe("unsent draft");
  } finally { await app.close(); }
});

test("모든 섹션에서 화살표·역할·상태 제목을 빼고 도구와 스킬은 인라인으로 표시한다", async () => {
  // 역할 제목 대신 실제 내용과 실행 대상을 읽을 수 있는 섹션들을 준비한다.
  const app = await mount([
    { ...section("USER_CONTENT"), id: "user", kind: "user", title: "You" },
    { ...section("THINK_CONTENT"), id: "thinking", kind: "thinking", title: "Thinking" },
    { ...section("TOOL_CONTENT"), id: "tool", kind: "tool", title: "read", summary: "/tmp/example.ts:7" },
    { id: "skill", kind: "notice", title: "commit-changes", skillName: "commit-changes", text: "commit-changes", status: "complete" },
    { ...section("ANSWER_CONTENT"), id: "answer" },
  ]);
  try {
    app.resize(140, 60);
    app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressKey("HOME"); await app.render();
    // 제목 전용 행 없이 접힌 도구에는 실행 대상과 실제 키맵 안내가 함께 보인다.
    const frame = app.captureCharFrame().split("\n").slice(app.scroll.y, app.scroll.y + app.scroll.height).join("\n");
    expect(frame).toContain("USER_CONTENT"); expect(frame).toContain("ANSWER_CONTENT");
    expect(frame).toContain("[read] /tmp/example.ts:7 (<C-o> to expand)");
    expect(frame).toContain("[skill] commit-changes");
    expect(frame).not.toMatch(/[▾▸›]|You ·|Agent ·|Thinking ·| · complete/);
    expect(frame).not.toContain("TOOL_CONTENT"); expect(frame).toContain("THINK_CONTENT");
  } finally { await app.close(); }
});

test("bash 명령 끝에는 경과 시간이 아닌 지정한 timeout을 표시한다", async () => {
  // 여러 줄 명령과 timeout을 가진 도구도 별도의 역할·상태 제목을 만들지 않는다.
  const app = await mount([{ ...section("Arguments:\n{}\n\nResult:\nCOMMAND_RESULT"), kind: "tool", title: "bash", command: "printf '한글'\nprintf done", timeoutSeconds: 120 }]);
  try {
    app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressKey("HOME");
    app.mockInput.pressKey("o", { ctrl: true }); await app.render();
    // 펼친 명령의 마지막 줄에 설정된 제한을 붙이며 출력과 원문 복사도 보존한다.
    const frame = app.captureCharFrame();
    expect(frame).toContain("$ printf '한글'"); expect(frame).toContain("printf done (timeout 120s)");
    expect(frame).not.toContain("bash · complete"); expect(frame).toContain("COMMAND_RESULT");
    await app.copy(); expect(app.copies).toEqual(["Arguments:\n{}\n\nResult:\nCOMMAND_RESULT"]);
  } finally { await app.close(); }
});

test("도구의 timeout만 바뀌어도 인라인 요약을 갱신하고 안내·제한은 muted 색으로 구분한다", async () => {
  // 다중 바이트 경로 뒤의 보조 정보도 표시 셀 단위로 색상을 적용해야 한다.
  const data: TranscriptSection = { ...section("RAW_DETAILS"), kind: "tool", title: "bash", command: "printf '한글 👨‍👩‍👧‍👦'", timeoutSeconds: 120 };
  const app = await mount([data]);
  try {
    uiTheme(app.renderer).configure(palette(false));
    await app.update([{ ...data, timeoutSeconds: 30 }]);
    // 본문이나 상태가 그대로여도 제한 변경을 누락하지 않는다.
    const frame = app.captureCharFrame();
    expect(frame).toContain("(timeout 30s) (<C-o> to expand)"); expect(frame).not.toContain("timeout 120s");
    const spans = app.captureSpans().lines.flatMap((line) => line.spans);
    const hint = spans.find((item) => item.text.includes("timeout 30s"));
    expect(hint?.fg.toInts()).toEqual(uiTheme(app.renderer).colors.muted.toInts());
    expect(frame).not.toContain("RAW_DETAILS");
  } finally { await app.close(); }
});

test("Agent와 Thinking은 제목·배경·들여쓰기 없이 표시하고 나머지 블록은 테마에 맞춰 구분한다", async () => {
  const app = await mount([
    { ...section("USER_BODY"), id: "user", kind: "user", title: "You" },
    { ...section("THINK_BODY"), id: "thinking", kind: "thinking", title: "Thinking" },
    { ...section("TOOL_BODY"), id: "tool", kind: "tool", title: "read" },
    { ...section("AGENT_BODY"), id: "agent" },
  ]);
  const span = (text: string) => {
    const scroll = app.renderer.root.findDescendantById("session-transcript")!;
    const found = app.captureSpans().lines.slice(scroll.y, scroll.y + scroll.height).flatMap((line) => line.spans).find((item) => item.text.includes(text));
    if (!found) throw new Error(`Missing colored text ${text}\n${app.captureCharFrame()}`);
    return found;
  };
  const cell = (x: number, y: number) => {
    let column = 0;
    const found = app.captureSpans().lines[y]!.spans.find((item) => { column += item.width; return column > x; });
    if (!found) throw new Error("Missing rendered cell");
    return found;
  };
  try {
    // A tall viewport exposes all section surfaces and the empty rows between cards.
    app.resize(140, 60); uiTheme(app.renderer).configure(palette(false));
    app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressKey("HOME"); app.mockInput.pressKey("z"); app.mockInput.pressKey("r"); await app.render();
    const texts = ["USER_BODY", "THINK_BODY", "TOOL_BODY", "AGENT_BODY"];
    const dark = texts.map((text) => span(text).bg.toInts().join(","));
    expect(new Set(dark).size).toBe(3);
    expect(span("THINK_BODY").bg.toInts()).toEqual(uiTheme(app.renderer).colors.panel.toInts());
    expect(span("AGENT_BODY").bg.toInts()).toEqual(uiTheme(app.renderer).colors.panel.toInts());
    const scroll = app.renderer.root.findDescendantById("session-transcript")!;
    const rows = app.captureCharFrame().split("\n"), bodyY = rows.findIndex((line, index) => index >= scroll.y && index < scroll.y + scroll.height && line.includes("USER_BODY"));
    const bodyX = rows[bodyY]!.indexOf("USER_BODY");
    expect(cell(bodyX - 1, bodyY).bg.equals(span("USER_BODY").bg)).toBe(true);
    // Plain prose/reasoning start at the viewport edge; user blocks retain one padding cell.
    for (const text of ["THINK_BODY", "AGENT_BODY"]) {
      const line = rows.find((line, index) => index >= scroll.y && index < scroll.y + scroll.height && line.includes(text))!;
      expect(line.indexOf(text)).toBe(app.scroll.content.x);
    }
    expect(bodyX).toBe(app.scroll.content.x + 1);
    expect(cell(bodyX, bodyY + 2).bg.toInts()).toEqual(uiTheme(app.renderer).colors.panel.toInts());
    expect(cell(bodyX, bodyY + 3).bg.toInts()).toEqual(uiTheme(app.renderer).colors.panel.toInts());

    app.renderer.emit("palette", palette(true)); await app.render();
    const light = texts.map((text) => span(text).bg.toInts().join(","));
    expect(new Set(light).size).toBe(3); expect(light).not.toEqual(dark);
    expect(span("THINK_BODY").bg.toInts()).toEqual(uiTheme(app.renderer).colors.panel.toInts());
    expect(span("AGENT_BODY").bg.toInts()).toEqual(uiTheme(app.renderer).colors.panel.toInts());
    app.mockInput.pressKey("END"); await app.render();
    expect(span("AGENT_BODY").bg.toInts()).toEqual(uiTheme(app.renderer).colors.panel.toInts());
    app.mockInput.pressKey("k"); app.mockInput.pressKey("k"); await app.render();
    expect(span("THINK_BODY").bg.toInts()).toEqual(uiTheme(app.renderer).colors.panel.toInts());
    app.mockInput.pressKey("HOME");
    app.resize(60, 12); await app.render();
    app.mockInput.pressEnter(); app.mockInput.pressKey("v", { shift: true }); await app.copy();

    expect(app.copies).toEqual(["USER_BODY"]);
    expect(app.captureCharFrame().split("\n")[11]).toContain("Radian");
    expect(app.view.promptDrafts.a1).toBe("unsent draft");
  } finally { await app.close(); }
});

test("스킬은 이름만 한 줄로 표시하고 개별·전체 접기에서 제외하지만 이름 복사는 유지한다", async () => {
  const name = "write-good-code";
  const app = await mount([
    { id: "skill", kind: "notice", title: name, text: name, skillName: name, status: "complete" },
    { ...section("OTHER_BODY"), id: "other" },
  ]);
  try {
    await app.enter(); app.mockInput.pressEscape();
    app.mockInput.pressKey("o", { ctrl: true });
    app.mockInput.pressKey("z"); app.mockInput.pressKey("a");
    app.mockInput.pressKey("z"); app.mockInput.pressKey("m"); await app.render();

    const frame = app.captureCharFrame(), scroll = app.renderer.root.findDescendantById("session-transcript")!;
    const transcriptRows = frame.split("\n").slice(scroll.y, scroll.y + scroll.height);
    expect(transcriptRows.filter((line) => line.includes(name))).toHaveLength(1);
    expect(frame).not.toContain(`${name} · complete`); expect(frame).not.toContain("OTHER_BODY");
    expect(app.state()?.folded.skill).toBeUndefined(); expect(app.state()?.folded.other).toBe(true);
    await app.copy(); expect(app.copies).toEqual([name]);

    app.mockInput.pressEnter(); app.mockInput.pressKey("v", { shift: true }); await app.copy();

    expect(app.copies).toEqual([name, name]);
    expect(app.state()?.folded.skill).toBeUndefined(); expect(app.prompts).toEqual([]);
  } finally { await app.close(); }
});

test.each(["one\r\ntwo", "one\r\ntwo\r\n"])("줄 선택은 CRLF 원문도 개행을 바꾸지 않고 복사한다: %j", async (text) => {
  const app = await mount([section(text)]);
  try {
    await app.enter(); app.mockInput.pressKey("v", { shift: true }); app.mockInput.pressKey("j"); await app.copy();

    expect(app.copies).toEqual([text]);
  } finally { await app.close(); }
});

test("줄 선택 중 팔레트가 바뀌어도 선택 범위와 원문을 보존한다", async () => {
  const app = await mount([section("one two\nnext\ntail")]);
  try {
    uiTheme(app.renderer).configure(palette(false));
    await app.enter(); app.mockInput.pressKey("v", { shift: true }); app.mockInput.pressKey("j"); await app.render();
    expect(app.body().getSelectedText()).toBe("one two\nnext\n");

    app.renderer.emit("palette", palette(true)); await app.render(); await app.copy();

    expect(app.copies).toEqual(["one two\nnext\n"]);
    expect(app.view.promptDrafts.a1).toBe("unsent draft");
  } finally { await app.close(); }
});

test.each([false, true])("문자 선택도 혼합된 LF·CRLF 원문을 정방향·역방향에서 보존한다: %j", async (reverse) => {
  const text = "first\r\nsecond\nlast\r\nfinal";
  const app = await mount([section(text)]);
  try {
    await app.enter();
    if (reverse) app.mockInput.pressKey("g", { shift: true });
    app.mockInput.pressKey("v");
    if (reverse) { app.mockInput.pressKey("g"); app.mockInput.pressKey("g"); }
    else app.mockInput.pressKey("g", { shift: true });
    await app.copy();

    expect(app.copies).toEqual([text]);
  } finally { await app.close(); }
});

test("접힌 섹션 Enter는 요약 커서를 표시하고 Ctrl+O만 접힘 상태를 전환한다", async () => {
  const text = "FOLDED_DETAIL\nsecond line";
  const app = await mount([{ ...section(text), kind: "tool", title: "read" }]);
  try {
    // Enter must focus the visible heading, not reveal or navigate the hidden body.
    app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressKey("HOME"); await app.render();
    expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).toContain("<CR> Text");
    app.mockInput.pressEnter(); await app.render();
    expect(app.state()?.mode).toBe("text"); expect(app.captureCharFrame()).not.toContain("FOLDED_DETAIL");
    const heading = app.body(), cursor = app.renderer.getCursorState();
    expect(heading.plainText).toBe("[read] (<C-o> to expand)");
    expect(cursor.visible).toBe(true);
    // Terminal cursor coordinates are one-based; renderable bounds are zero-based.
    expect(cursor.x).toBe(heading.x + heading.visualCursor.visualCol + 1);
    expect(cursor.y).toBe(heading.y + heading.visualCursor.visualRow + 1);
    app.mockInput.pressKey("v"); app.mockInput.pressKey("l"); await app.copy();
    expect(app.copies).toEqual(["[r"]);

    app.mockInput.pressKey("o", { ctrl: true }); await app.render();
    expect(app.state()?.folded.message).toBe(false); expect(app.captureCharFrame()).toContain("FOLDED_DETAIL");
    app.mockInput.pressEnter(); await app.render(); expect(app.state()?.mode).toBe("text");
    app.mockInput.pressEnter(); await app.render(); expect(app.state()?.folded.message).toBe(false);
    app.mockInput.pressKey("o", { ctrl: true }); await app.render();

    expect(app.state()?.mode).toBe("sections"); expect(app.state()?.folded.message).toBe(true);
    expect(app.captureCharFrame()).not.toContain("FOLDED_DETAIL"); expect(app.prompts).toEqual([]);
  } finally { await app.close(); }
});

test.each([false, true])("Ctrl+O는 문자·줄 선택 중에도 안전하게 접고 섹션 탐색으로 복귀한다: %j", async (linewise) => {
  const app = await mount([section("SELECTED_DETAIL\nnext")]);
  try {
    await app.enter(); app.mockInput.pressKey("v", { shift: linewise });

    app.mockInput.pressKey("o", { ctrl: true }); await app.render();

    expect(app.state()?.mode).toBe("sections"); expect(app.state()?.folded.message).toBe(true);
    expect(app.state()?.anchor).toBeNull(); expect(app.state()?.linewise).toBeUndefined();
    expect(app.captureCharFrame()).not.toContain("SELECTED_DETAIL");
    expect(app.view.promptDrafts.a1).toBe("unsent draft"); expect(app.prompts).toEqual([]);
  } finally { await app.close(); }
});

test("접기 재할당은 안내에도 반영되고 Ctrl+O는 입력 첨부 확인과 PTY 소유권을 구분한다", async () => {
  const keymap = expectOk(parseKeymap({ bindings: { "transcript.fold": [{ keys: "alt+x", scope: "transcript" }] } }));
  const app = await mount([{ ...section("CUSTOM_FOLD_DETAIL"), kind: "tool", title: "read" }], { keymap });
  try {
    app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressKey("HOME");
    app.mockInput.pressKey("o", { ctrl: true }); app.mockInput.pressEnter(); await app.render();
    expect(app.captureCharFrame()).not.toContain("CUSTOM_FOLD_DETAIL");
    expect(app.state()?.mode).toBe("text");
    expect(app.body().plainText).toBe("[read] (<M-x> to expand)");
    app.mockInput.pressEscape(); await app.render();
    expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).toContain("<M-x>");

    app.mockInput.pressKey("x", { meta: true }); await app.render();

    expect(app.captureCharFrame()).toContain("CUSTOM_FOLD_DETAIL");
    const defaults = defaultKeymap();
    for (const context of ["transcript", "transcript-text", "transcript-visual"] as const) expect(defaults.hint("transcript.fold", context)).toBe("<C-o>");
    expect(defaults.hint("agent.inspect", "prompt")).toBe("<C-o>");
    for (const context of ["editor", "terminal"] as const) expect(defaults.bound("ctrl+o", context)).toBe(false);
    expect(app.prompts).toEqual([]);
  } finally { await app.close(); }
});

test("접힌 요약과 펼친 본문의 커서는 독립적으로 유지되고 새 UI에서도 요약 커서를 복원한다", async () => {
  const text = "HIDDEN_BODY\nmore details";
  const data: TranscriptSection[] = [{ ...section(text), kind: "tool", title: "read" }];
  let preferences: WorkViewPreferences | undefined;
  const app = await mount(data, { onWorkViewsChange: (state) => { preferences = state; } });
  try {
    await app.enter(); app.mockInput.pressKey("l"); app.mockInput.pressKey("l");
    expect(app.state()?.headingCursors?.message).toBe(2);
    app.mockInput.pressKey("o", { ctrl: true }); app.mockInput.pressEnter();
    for (let i = 0; i < 4; i++) app.mockInput.pressKey("l");
    expect(app.state()?.cursors.message).toBe(4);

    app.mockInput.pressKey("o", { ctrl: true }); app.mockInput.pressEnter(); await app.render();

    expect(app.body().plainText).toBe("[read] (<C-o> to expand)"); expect(app.body().cursorOffset).toBe(2);
    expect(app.state()?.cursors.message).toBe(4); expect(app.captureCharFrame()).not.toContain("HIDDEN_BODY");
    await app.copyLine(); expect(app.copies).toEqual(["[read] (<C-o> to expand)"]);
    app.mockInput.pressKey("y", { shift: true }); await app.render(); expect(app.copies.at(-1)).toBe(text);
  } finally { await app.close(); }
  const next = await mount(data, { initialWorkViews: preferences! });
  try {
    next.mockInput.pressKey("t", { ctrl: true }); await next.render();

    expect(next.body().plainText).toBe("[read] (<C-o> to expand)"); expect(next.body().cursorOffset).toBe(2);
    expect(next.renderer.getCursorState().visible).toBe(true); expect(next.captureCharFrame()).not.toContain("HIDDEN_BODY");
    next.mockInput.pressKey("o", { ctrl: true }); next.mockInput.pressEnter(); await next.render();
    expect(next.body().plainText).toBe(text); expect(next.body().cursorOffset).toBe(4);
  } finally { await next.close(); }
});

test("접힌 오류 요약도 커서와 줄 선택으로 복사할 수 있지만 숨은 본문은 표시하지 않는다", async () => {
  const text = "HIDDEN_STACK_TRACE\nraw tool output";
  const app = await mount([{ ...section(text), kind: "tool", title: "read", status: "error", error: "Permission denied" }]);
  try {
    await app.enter();
    expect(app.body().plainText).toBe("[read] (<C-o> to expand)\n\nPermission denied");
    expect(app.captureCharFrame()).not.toContain("HIDDEN_STACK_TRACE");

    app.mockInput.pressKey("v", { shift: true }); app.mockInput.pressKey("j"); app.mockInput.pressKey("j"); await app.copy();

    expect(app.copies).toEqual(["[read] (<C-o> to expand)\n\nPermission denied"]);
    expect(app.captureCharFrame()).not.toContain("HIDDEN_STACK_TRACE");
    app.mockInput.pressKey("y", { shift: true }); await app.render(); expect(app.copies.at(-1)).toBe(text);
    expect(app.prompts).toEqual([]);
  } finally { await app.close(); }
});

test("접힌 헤더의 선택은 도구 진행·resize·도움말 왕복에서도 보존된다", async () => {
  const app = await mount([{ ...section("HIDDEN_PROGRESS"), kind: "tool", title: "read", status: "running", summary: "a path" }]);
  try {
    await app.enter(); app.mockInput.pressKey("v"); app.mockInput.pressKey("l");

    await app.update([{ ...section("HIDDEN_PROGRESS plus output"), kind: "tool", title: "read", status: "complete", summary: "a path" }]);
    app.resize(60, 12); app.renderer.emit("palette", palette(true)); await app.render();
    app.mockInput.pressKey("F1"); await app.render(); app.mockInput.pressEscape(); await app.render();

    expect(app.state()?.mode).toBe("visual"); expect(app.body().getSelectedText()).toBe("[r");
    expect(app.renderer.getCursorState().visible).toBe(true);
    expect(app.captureCharFrame()).not.toContain("HIDDEN_PROGRESS");
    await app.copy(); expect(app.copies).toEqual(["[r"]);
    expect(app.state()?.cursors.message).toBeUndefined(); expect(app.state()?.headingCursors?.message).toBe(1);
  } finally { await app.close(); }
});

test("화살표 없이 인라인 요약을 클릭해 선택한 섹션도 Enter로 커서에 진입한다", async () => {
  const app = await mount([section("first"), { ...section("HIDDEN_CLICK_BODY"), id: "folded", kind: "tool", title: "read" }]);
  try {
    app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressKey("HOME"); await app.render();
    const lines = app.captureCharFrame().split("\n"), y = lines.findIndex((line) => line.includes("[read] (<C-o> to expand)"));
    const x = lines[y]!.indexOf("[read]");

    await app.mockMouse.click(x, y); await app.render(); app.mockInput.pressEnter(); await app.render();

    expect(app.state()?.selectedId).toBe("folded"); expect(app.body().plainText).toBe("[read] (<C-o> to expand)");
    expect(app.renderer.getCursorState().visible).toBe(true); expect(app.captureCharFrame()).not.toContain("HIDDEN_CLICK_BODY");
  } finally { await app.close(); }
});
