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
    async prompt(text: string) { app.mockInput.pressKey("e", { ctrl: true }); await app.mockInput.typeText(text); app.mockInput.pressEnter(); await settled(); },
    async update(next: readonly TranscriptSection[], id = selection.sessionId ?? "a1") { data[id] = next; selection.replaceSnapshot(snapshot()); await settled(); },
    async close() { view.dispose(); await app.dispose(); },
  };
}
const bottom = (scroll: ScrollBoxRenderable) => Math.max(0, scroll.scrollHeight - scroll.viewport.height);

test("긴 AI 대화는 세로 스크롤바 없이 전체 너비를 쓰고 휠·키보드 탐색을 유지한다", async () => {
  // 실제로 넘치는 대화에서 바를 숨겨도 별도의 빈 열이 남아서는 안 된다.
  const app = await mount();
  const verify = () => {
    expect(app.scroll.scrollHeight).toBeGreaterThan(app.scroll.viewport.height);
    expect(app.scroll.verticalScrollBar.visible).toBe(false);
    expect(app.scroll.viewport.width).toBe(app.scroll.width);
  };
  try {
    verify();
    app.mockInput.pressKey("e", { ctrl: true }); await app.mockInput.typeText("Unsent scrollbar draft"); await app.settled();

    // 오른쪽 끝도 본문이므로 휠을 받을 수 있고 새 결과는 읽던 위치를 밀지 않는다.
    await app.mockMouse.scroll(app.scroll.viewport.x + app.scroll.viewport.width - 1, app.scroll.y + 3, "up"); await app.settled();
    const position = app.scroll.scrollTop;
    expect(position).toBeLessThan(bottom(app.scroll)); expect(app.state()?.follow).toBe(false);
    await app.update([...history, section("new", "SCROLLBAR_FREE_TAIL")]);
    expect(app.scroll.scrollTop).toBe(position); expect(app.state()?.follow).toBe(false);
    app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressKey("END", { ctrl: true }); await app.settled();
    expect(app.state()?.follow).toBe(true); expect(app.scroll.scrollTop).toBe(bottom(app.scroll));
    expect(app.captureCharFrame()).toContain("SCROLLBAR_FREE_TAIL");

    // 리사이즈·테마 변경·화면 왕복이 네이티브 바를 다시 활성화하면 안 된다.
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

test.each([false, true])("밝기 %j에서도 하단 복귀 버튼은 기존 여백에만 표시하고 본문·상태 행·입력창을 가리지 않는다", async (light) => {
  // 긴 대화를 따라가는 화면에서 버튼이 나타나도 본문·입력창의 크기는 바뀌지 않아야 한다.
  const app = await mount();
  try {
    uiTheme(app.renderer).configure({ palette: [], defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
      cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null, highlightForeground: null, highlightBackground: null });
    app.mockInput.pressKey("e", { ctrl: true }); await app.mockInput.typeText("Unsent draft"); await app.settled();
    const composer = app.renderer.root.findDescendantById("agent-composer")!;
    const prompt = app.renderer.root.findDescendantById("session-prompt")!;
    const status = app.renderer.root.findDescendantById("transcript-status-row")!;
    const geometry = [app.scroll.height, app.scroll.viewport.height, app.scroll.scrollHeight, status.y, composer.y, prompt.y];
    expect(app.captureCharFrame()).not.toContain("Back to bottom");

    // 위로 스크롤하면 클릭 가능한 표시가 나타나며, 오른쪽 클릭은 이동 명령이 아니다.
    await app.mockMouse.scroll(app.scroll.x + 3, app.scroll.y + 3, "up"); await app.settled();
    expect(app.captureCharFrame()).toContain("↓ Back to bottom · Shift+g");
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
    expect(frame[button.y + 1]).toContain("Subagents");
    expect([app.scroll.height, viewport.height, app.scroll.scrollHeight, status.y, composer.y, prompt.y]).toEqual(geometry);
    const position = app.scroll.scrollTop;
    await app.mockMouse.click(button.x, button.y, 2); await app.settled();
    expect(app.scroll.scrollTop).toBe(position); expect(app.state()?.follow).toBe(false);

    // 왼쪽 패딩도 클릭할 수 있고, 요청 전송이나 입력 포커스 변경 없이 맨 아래로 복귀한다.
    await app.mockMouse.click(button.x, button.y); await app.settled();
    expect(app.scroll.scrollTop).toBe(bottom(app.scroll)); expect(app.state()?.follow).toBe(true);
    expect(app.captureCharFrame()).not.toContain("Back to bottom");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
    expect(app.view.promptDrafts.a1).toBe("Unsent draft"); expect(app.sent).toEqual([]);
    await app.update([...history, section("tail", "BUTTON_RESUMED_TAIL")]);
    expect(app.captureCharFrame()).toContain("BUTTON_RESUMED_TAIL"); expect(app.scroll.scrollTop).toBe(bottom(app.scroll));
  } finally { await app.close(); }
});

test("하단 복귀 버튼은 재지정한 바인딩을 표시하고 같은 키로 따라가기를 재개한다", async () => {
  // 기본 키 대신 섹션 모드 전용 단축키가 설정된 과거 대화를 연다.
  const keymap = expectOk(parseKeymap({ bindings: { "transcript.latest": [{ keys: "alt+z", scope: "transcript" }] } }));
  const app = await mount({ paused: true, keymap });
  try {
    await app.update([...history, section("tail", "LATE_OUTPUT\n".repeat(70))]);
    app.mockInput.pressKey("t", { ctrl: true }); await app.settled();
    expect(app.captureCharFrame()).toContain("↓ Back to bottom · Alt+z");
    app.mockInput.pressKey("g", { shift: true }); await app.settled();
    expect(app.state()?.selectedId).toBe("history");
    expect(app.state()?.follow).toBe(false); expect(app.scroll.scrollTop).toBeLessThan(bottom(app.scroll));

    // 표시한 단축키와 실제 이동 명령이 일치하며 바닥에서는 버튼이 사라진다.
    app.mockInput.pressKey("z", { meta: true }); await app.settled();
    expect(app.state()?.follow).toBe(true); expect(app.scroll.scrollTop).toBe(bottom(app.scroll));
    expect(app.captureCharFrame()).not.toContain("Back to bottom");
  } finally { await app.close(); }
});

test("하단 이동 키를 비활성화해도 버튼은 잘못된 키 안내 없이 클릭으로 동작한다", async () => {
  // 키맵의 빈 배열은 기본 바인딩을 없애지만 마우스 복귀 동작까지 막지는 않는다.
  const keymap = expectOk(parseKeymap({ bindings: { "transcript.latest": [] } }));
  const app = await mount({ paused: true, keymap });
  try {
    expect(app.captureCharFrame()).toContain("↓ Back to bottom");
    expect(app.captureCharFrame()).not.toContain("Back to bottom ·");
    const button = app.renderer.root.findDescendantById("transcript-bottom-button");
    if (!button) throw new Error("Missing back-to-bottom button");

    // 단축키가 없어도 오른쪽 패딩까지 클릭 대상으로 유지한다.
    await app.mockMouse.click(button.x + button.width - 1, button.y); await app.settled();
    expect(app.state()?.follow).toBe(true); expect(app.scroll.scrollTop).toBe(bottom(app.scroll));
    expect(app.captureCharFrame()).not.toContain("Back to bottom");
  } finally { await app.close(); }
});

test("도움말·다른 화면·빈 대화·짧은 대화에서는 하단 복귀 버튼을 표시하지 않는다", async () => {
  // 과거 대화에는 표시하되, 같은 viewport를 사용하는 도움말에는 표시하지 않아야 한다.
  const app = await mount({ paused: true });
  try {
    expect(app.captureCharFrame()).toContain("Back to bottom");
    app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressKey("F1"); await app.settled();
    expect(app.captureCharFrame()).not.toContain("Back to bottom");
    app.mockInput.pressKey("F1"); await app.settled();
    expect(app.captureCharFrame()).toContain("Back to bottom");

    // 다른 작업 화면으로 왕복해도 버튼은 활성 대화와 그 스크롤 위치에만 속한다.
    app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("e"); await app.settled();
    expect(app.captureCharFrame()).not.toContain("Back to bottom");
    app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("a"); await app.settled();
    expect(app.captureCharFrame()).toContain("Back to bottom");

    // 스크롤 범위가 없으면 자동 추적 상태와 관계없이 버튼이나 빈 고정 행을 남기지 않는다.
    await app.update([]); expect(app.captureCharFrame()).not.toContain("Back to bottom");
    await app.update([section("short", "SHORT_REPLY")]);
    expect(app.captureCharFrame()).toContain("SHORT_REPLY"); expect(app.captureCharFrame()).not.toContain("Back to bottom");
  } finally { await app.close(); }
});

test("원문을 읽을 때 커서는 복귀 버튼에 가려지지 않고 클릭은 선택을 해제해 최신 출력으로 이동한다", async () => {
  // 첫 섹션 아래에도 내용이 있어 원문의 마지막 화면 행을 읽어도 아직 맨 아래가 아니다.
  const app = await mount();
  try {
    await app.update([...history, section("later", "LATER_SECTION\n".repeat(30))]);
    app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressKey("HOME"); app.mockInput.pressEnter(); await app.settled();
    const body = app.renderer.currentFocusedRenderable;
    if (!(body instanceof EditBufferRenderable)) throw new Error("Missing source reader");

    // 화면 하단까지 내려가도 원문 커서가 플로팅 영역 아래로 숨지 않는다.
    for (let i = 0; i < app.scroll.viewport.height; i++) app.mockInput.pressKey("j");
    await app.settled();
    const button = app.renderer.root.findDescendantById("transcript-bottom-button")!;
    expect(app.captureCharFrame()).toContain("Back to bottom");
    expect(body.y + body.visualCursor.visualRow).toBeLessThan(button.y);
    app.mockInput.pressKey("v"); await app.settled(); expect(app.state()?.mode).toBe("visual");

    // 명시적인 복귀 클릭은 보호 중인 선택을 끝내고 섹션 모드와 자동 따라가기를 복원한다.
    await app.mockMouse.click(button.x + 1, button.y); await app.settled();
    expect(app.state()?.mode).toBe("sections"); expect(app.state()?.follow).toBe(true);
    expect(app.scroll.scrollTop).toBe(bottom(app.scroll));
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-transcript");
    expect(app.captureCharFrame()).not.toContain("Back to bottom");
  } finally { await app.close(); }
});

test("좁은 창에서도 기존 여백에 버튼을 중앙 정렬하고 여백이 없는 높이에서는 숨긴다", async () => {
  // 멈춘 대화의 플로팅 UI는 리사이즈 후에도 스크롤 콘텐츠의 일부가 되어서는 안 된다.
  const app = await mount({ paused: true });
  try {
    app.resize(60, 18); await app.settled();
    const button = app.renderer.root.findDescendantById("transcript-bottom-button")!;
    const viewport = app.scroll.viewport;
    expect(app.captureCharFrame()).toContain("Back to bottom");
    expect(Math.abs(button.x + button.width / 2 - viewport.x - viewport.width / 2)).toBeLessThanOrEqual(0.5);
    expect(button.y).toBe(viewport.y + viewport.height);
    expect(button.width).toBeLessThanOrEqual(viewport.width);

    // 기존 빈 행이 없는 화면에서는 본문이나 입력창을 덮지 않고 버튼만 숨긴다.
    app.resize(60, 8); await app.settled(); expect(app.captureCharFrame()).not.toContain("Back to bottom");
    app.resize(120, 26); await app.settled(); expect(app.captureCharFrame()).toContain("Back to bottom");
    expect(app.state()?.follow).toBe(false);
  } finally { await app.close(); }
});

test("실행 상태 행이 없으면 입력창의 기존 위쪽 여백에만 복귀 버튼을 표시한다", async () => {
  // 완료된 세션에는 실행·서브에이전트 상태 행이 없어도 입력창 자체의 빈 윗줄이 남아 있다.
  const app = await mount({ paused: true, completed: true });
  try {
    const status = app.renderer.root.findDescendantById("transcript-status-row")!;
    const composer = app.renderer.root.findDescendantById("agent-composer")!;
    const prompt = app.renderer.root.findDescendantById("session-prompt")!;
    const button = app.renderer.root.findDescendantById("transcript-bottom-button")!;
    const geometry = [app.scroll.viewport.height, app.scroll.scrollHeight, composer.y, prompt.y];
    expect(status.visible).toBe(false); expect(app.captureCharFrame()).toContain("Back to bottom");

    // 스크롤 영역 밖의 기존 빈 행만 사용하고 입력 본문을 한 줄 더 아래로 밀지 않는다.
    expect(button.y).toBeLessThanOrEqual(composer.y);
    expect(button.y).toBe(app.scroll.viewport.y + app.scroll.viewport.height);
    expect(button.y + button.height).toBeLessThanOrEqual(prompt.y);
    app.mockInput.pressKey("e", { ctrl: true }); await app.mockInput.typeText("Kept draft"); await app.settled();
    await app.mockMouse.click(button.x, button.y); await app.settled();
    expect(app.state()?.follow).toBe(true); expect(app.captureCharFrame()).not.toContain("Back to bottom");
    expect([app.scroll.viewport.height, app.scroll.scrollHeight, composer.y, prompt.y]).toEqual(geometry);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt"); expect(app.view.promptDrafts.a1).toBe("Kept draft");
  } finally { await app.close(); }
});

test("맨 아래에서는 대화 영역에 포커스를 옮겨도 자동 추적을 유지한다", async () => {
  const app = await mount();
  try {
    app.mockInput.pressKey("t", { ctrl: true }); await app.settled();
    expect(app.state()?.follow).toBe(true); expect(app.scroll.scrollTop).toBe(bottom(app.scroll));
    await app.update([...history, section("new", "FOCUSED_BOTTOM_TAIL")]);
    expect(app.scroll.scrollTop).toBe(bottom(app.scroll)); expect(app.captureCharFrame()).toContain("FOCUSED_BOTTOM_TAIL");
  } finally { await app.close(); }
});

test("휠로 위로 읽다가 다시 맨 아래로 내리면 별도 키 없이 자동 추적을 재개한다", async () => {
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

test("숨은 스크롤 모델의 위치가 맨 아래에 도달해도 자동 추적을 재개한다", async () => {
  const app = await mount();
  try {
    app.scroll.verticalScrollBar.scrollPosition = 0; await app.settled(); expect(app.state()?.follow).toBe(false);
    app.scroll.verticalScrollBar.scrollPosition = bottom(app.scroll); await app.settled();
    expect(app.state()?.follow).toBe(true);
    await app.update([...history, section("new", "BAR_RESUMED_TAIL")]);
    expect(app.scroll.scrollTop).toBe(bottom(app.scroll)); expect(app.captureCharFrame()).toContain("BAR_RESUMED_TAIL");
  } finally { await app.close(); }
});

test.each(["shift+g", "ctrl+end", "g e"] as const)("섹션 모드 %s는 긴 마지막 섹션의 실제 끝으로 이동하고 자동 추적을 재개한다", async (key) => {
  // Selecting the final section alone cannot reveal its end when it exceeds the viewport.
  const app = await mount({ paused: true });
  try {
    app.mockInput.pressKey("t", { ctrl: true }); await app.settled();

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

test("맨 아래 원문 선택 중에는 추적을 멈추고 선택을 해제하면 커서·섹션을 유지하며 재개한다", async () => {
  const app = await mount();
  try {
    app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressEnter();
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

test("선택 중 새 내용이 쌓이면 선택 해제만으로 점프하지 않고 다시 하단에 도달해야 재개한다", async () => {
  const app = await mount();
  try {
    app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressEnter(); app.mockInput.pressKey("END", { ctrl: true }); await app.settled();
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

test("렌더링된 Markdown의 마우스 선택도 보호하고 선택을 지우면 하단 기준으로 재개한다", async () => {
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

test("일시정지한 과거 대화에서 새 프롬프트를 보내면 포커스를 빼앗지 않고 최신 요청부터 따라간다", async () => {
  const app = await mount({ paused: true });
  try {
    expect(app.state()?.follow).toBe(false);
    await app.prompt("NEW_REQUEST_TAIL");
    expect(app.sent).toEqual(["a1:NEW_REQUEST_TAIL"]); expect(app.state()?.follow).toBe(true);
    expect(app.scroll.scrollTop).toBe(bottom(app.scroll)); expect(app.captureCharFrame()).toContain("NEW_REQUEST_TAIL");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
  } finally { await app.close(); }
});

test("Markdown 응답·펼친 도구 결과·완료 행이 늘어날 때마다 최신 출력이 화면 아래에 남는다", async () => {
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

test("자동 따라가기 중 resize나 Markdown 비동기 레이아웃 변화는 수동 탐색으로 오해하지 않는다", async () => {
  const app = await mount();
  try {
    app.resize(80, 18); await app.settled();
    expect(app.state()?.follow).toBe(true); expect(app.scroll.scrollTop).toBe(bottom(app.scroll));
    await app.update([...history, section("table", "| Key | Value |\n|---|---|\n" + "| 한글 | 긴 결과가 여러 줄로 표시됩니다 |\n".repeat(20) + "\nTABLE_TAIL")]);
    expect(app.state()?.follow).toBe(true); expect(app.scroll.scrollTop).toBe(bottom(app.scroll)); expect(app.captureCharFrame()).toContain("TABLE_TAIL");
  } finally { await app.close(); }
});

test("사용자가 휠로 과거를 읽으면 스트리밍은 그 위치를 보존하고 새 전송도 따라가기를 재개한다", async () => {
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

test("본문 오른쪽 끝에서 휠로 과거를 읽으면 대기 중인 자동 이동보다 사용자 위치를 우선한다", async () => {
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

test("Markdown 없는 도구 화면도 resize와 화면 왕복 후 추가 이벤트 없이 최신 결과를 표시한다", async () => {
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

test("프롬프트 초안만 작성하는 동안에는 과거 읽기 위치와 선택 모드를 바꾸지 않는다", async () => {
  const app = await mount({ paused: true });
  try {
    const position = app.scroll.scrollTop;
    app.mockInput.pressKey("e", { ctrl: true }); await app.mockInput.typeText("Unsent draft"); await app.settled();
    expect(app.sent).toEqual([]); expect(app.state()?.follow).toBe(false); expect(app.scroll.scrollTop).toBe(position);
    expect(app.view.promptDrafts.a1).toBe("Unsent draft");
  } finally { await app.close(); }
});

test("다른 세션으로 이동한 뒤 이전 전송이 수락돼도 현재 세션의 스크롤과 포커스를 바꾸지 않는다", async () => {
  const gate = Promise.withResolvers<Result<void, ExpectedError>>();
  const app = await mount({ onPrompt: () => gate.promise });
  try {
    await app.prompt("Request in A");
    app.selection.selectSession("demo:feature", "b1"); await app.settled();
    app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressKey("HOME"); await app.settled();
    const position = app.scroll.scrollTop;
    gate.resolve(ok(undefined)); await app.settled();
    expect(app.selection.sessionId).toBe("b1"); expect(app.state()?.follow).toBe(false); expect(app.scroll.scrollTop).toBe(position);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-transcript");
  } finally { gate.resolve(ok(undefined)); await app.close(); }
});

test("전송 후 다시 과거를 읽기 시작했다면 늦은 수락이나 출력이 따라가기를 재개하지 않는다", async () => {
  const gate = Promise.withResolvers<Result<void, ExpectedError>>();
  const app = await mount({ paused: true, onPrompt: () => gate.promise });
  try {
    await app.prompt("Pending request"); expect(app.state()?.follow).toBe(true);
    app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressKey("HOME"); await app.settled();
    const position = app.scroll.scrollTop;
    gate.resolve(ok(undefined)); await app.update([...history, section("late", "LATE_RESPONSE\n".repeat(40))]);
    expect(app.state()?.follow).toBe(false); expect(app.scroll.scrollTop).toBe(position);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-transcript");
  } finally { gate.resolve(ok(undefined)); await app.close(); }
});
