import { expect, test } from "bun:test";
import { EditBufferRenderable, InputRenderable, MarkdownRenderable, parseKeypress, type Renderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { pressLeader, pressTranscriptRead } from "../../testing/transcript-keys.ts";
import { expectOk } from "../../testing/results.ts";
import { parseKeymap } from "../../keybindings/config.ts";
import { ok } from "../../result.ts";
import type { TranscriptSection } from "../../agents/transcript.ts";

function descendants(root: Renderable): Renderable[] { return root.getChildren().flatMap(child => [child, ...descendants(child)]); }
async function mount(text: string, actions: Partial<WorkbenchActions> = {}, kind: TranscriptSection["kind"] = "user") {
  const app = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace()), copied: string[] = [], sent: string[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession: () => {}, onCloseSession: () => {}, initialDrafts: { a1: "Unsent draft" },
    onPrompt: (_id, text) => { sent.push(text); return ok(undefined); },
    onCopyTranscript: async text => { copied.push(text); return ok("Copied to clipboard"); },
    getSessionDetails: () => ({ status: "complete", output: "", error: null, sections: [{ id: "body", kind, title: "Message", text, status: "complete" }] }), ...actions,
  });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  const body = () => {
    const reader = app.renderer.currentFocusedRenderable;
    if (!(reader instanceof EditBufferRenderable)) throw new Error(`No reader: ${reader?.id}`);
    return reader;
  };
  await render();
  return { ...app, view, selection, copied, sent, render, body,
    async read(position = 0) {
      pressTranscriptRead(app, actions.keymap); app.mockInput.pressKey("HOME"); app.mockInput.pressEnter(); await render();
      body().cursorOffset = body().editBuffer.measureText(body().plainText.slice(0, position)); await render();
    },
    cursor() { return body().getTextRange(0, body().cursorOffset).length; },
    async keys(keys: string) {
      for (const key of keys) {
        if (key === "\n") app.mockInput.pressEnter();
        else if (/^[A-Z]$/u.test(key)) app.mockInput.pressKey(key.toLowerCase(), { shift: true });
        else app.mockInput.pressKey(key);
      }
      await render();
    },
    search() { return app.renderer.root.findDescendantById("transcript-search") as InputRenderable; },
    state() { return view.workViewPreferences.agentViews?.[selection.sessionId ?? ""]; },
    async update(value: string) { text = value; selection.replaceSnapshot(demoWorkspace()); await render(); },
    async close() { view.dispose(); await app.dispose(); },
  };
}

test.each([
  { keys: "viw", position: 8, expected: "beta" },
  { keys: "vaw", position: 8, expected: "beta " },
  { keys: "viW", position: 3, expected: "one.two" },
  { keys: 'vi"', position: 14, expected: "hello world" },
  { keys: "vi(", position: 14, expected: "two" },
])("실제 키 [$keys] 커서 중간에서 객체 전체를 선택하고 원문을 수정하지 않는다", async ({ keys, position, expected }) => {
  // 대상 종류에 맞는 원문을 실제 네이티브 읽기 표면에 표시한다.
  const text = keys === "viW" ? "one.two next" : keys === 'vi"' ? 'before "hello world" after' : keys === "vi(" ? "outer (one (two) three) tail" : "alpha beta gamma";
  const app = await mount(text);
  try {
    await app.read(position);

    await app.keys(keys);

    expect(app.body().getSelectedText()).toBe(expected); expect(app.body().plainText).toBe(text);
    expect(app.copied).toEqual([]); expect(app.view.promptDrafts.a1).toBe("Unsent draft"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("yiw·yw·y$는 다른 범위를 복사하고 읽기 커서는 원래 위치에 유지한다", async () => {
  // operator-pending 단계의 y 자체는 클립보드를 변경하면 안 된다.
  const app = await mount("alpha beta gamma");
  try {
    await app.read(8); await app.keys("y"); expect(app.copied).toEqual([]); expect(app.captureCharFrame()).toContain("TEXT · y");

    await app.keys("iw"); await app.waitFor(() => app.copied.length === 1);
    await app.keys("yw"); await app.waitFor(() => app.copied.length === 2);
    await app.keys("y$"); await app.waitFor(() => app.copied.length === 3);

    expect(app.copied).toEqual(["beta", "ta ", "ta gamma"]); expect(app.cursor()).toBe(8);
    expect(app.state()?.mode).toBe("text"); expect(app.body().hasSelection()).toBe(false);
  } finally { await app.close(); }
});

test("yy와 y3w·2y2w는 횟수와 원래 개행을 보존한다", async () => {
  // 실제 CRLF가 있는 리터럴 메시지는 native 버퍼의 LF로 바뀌어 복사되면 안 된다.
  const text = "one two three four five\r\nsecond line", app = await mount(text);
  try {
    await app.read();

    await app.keys("yy"); await app.waitFor(() => app.copied.length === 1);
    await app.keys("y3w"); await app.waitFor(() => app.copied.length === 2);
    await app.keys("2y2w"); await app.waitFor(() => app.copied.length === 3);

    expect(app.copied).toEqual(["one two three four five\r\n", "one two three ", "one two three four "]);
    expect(app.cursor()).toBe(0); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("3w·5j·3gg의 횟수와 첫 숫자 뒤의 0을 실제 명령으로 해석한다", async () => {
  // 0은 단독이면 줄 시작이고 앞에 숫자가 있으면 횟수의 일부이다.
  const text = "one two three four five\n" + Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"), app = await mount(text);
  try {
    await app.read();

    await app.keys("3w"); expect(app.cursor()).toBe(14);
    await app.keys("0"); expect(app.cursor()).toBe(0);
    await app.keys("5j"); expect(app.body().logicalCursor.row).toBe(5);
    await app.keys("3gg"); expect(app.body().logicalCursor.row).toBe(2);
    await app.keys("10j");

    expect(app.body().logicalCursor.row).toBe(12); expect(app.copied).toEqual([]);
  } finally { await app.close(); }
});

test("f의 문자 인수는 w 같은 기존 모션 바인딩보다 우선하며 반복은 찾은 방향을 따른다", async () => {
  // fw의 w는 단어 이동 명령이 아니라 찾을 문자이다.
  const app = await mount("one two wow");
  try {
    await app.read();

    await app.keys("fw"); expect(app.cursor()).toBe(5);
    await app.keys(";"); expect(app.cursor()).toBe(8);
    await app.keys(","); expect(app.cursor()).toBe(5);
    await app.keys("yfw"); await app.waitFor(() => app.copied.length === 1);

    expect(app.copied).toEqual(["wo w"]); expect(app.cursor()).toBe(5);
  } finally { await app.close(); }
});

test("Esc·잘못된 키·다른 세션은 미완성 연산자를 취소하고 클립보드를 건드리지 않는다", async () => {
  // 미완성 yank는 취소 뒤의 일반 이동을 복사로 바꾸면 안 된다.
  const app = await mount("alpha beta gamma");
  try {
    await app.read(); await app.keys("y"); app.mockInput.pressEscape(); await app.render();
    expect(app.state()?.mode).toBe("text");

    await app.keys("w"); expect(app.cursor()).toBe(6);
    await app.keys("ydw"); expect(app.cursor()).toBe(11);
    await app.keys("y"); pressLeader(app, "2"); await app.render();
    await app.read(); await app.keys("w");

    expect(app.copied).toEqual([]); expect(app.body().plainText).toBe("alpha beta gamma");
  } finally { await app.close(); }
});

test("/ 검색 입력의 h/j/k/l과 숫자는 문자로 남고 Esc는 위치를 바꾸지 않고 취소한다", async () => {
  // 검색은 명령줄 입력이며 본문 이동이나 Agent 프롬프트 입력이 아니다.
  const app = await mount("alpha beta gamma");
  try {
    await app.read(6);

    await app.keys("/"); await app.mockInput.typeText("hjkl123"); await app.render();
    expect(app.search().value).toBe("hjkl123"); app.mockInput.pressEscape(); await app.render();

    expect(app.cursor()).toBe(6); expect(app.state()?.mode).toBe("text");
    expect(app.view.promptDrafts.a1).toBe("Unsent draft"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("검색 Enter와 n/N·?는 현재 섹션에서 양방향으로 순환한다", async () => {
  // 일치 위치로 이동하는 액션은 Enter에서만 받아들인다.
  const app = await mount("one two one two one");
  try {
    await app.read();

    await app.keys("/one\n"); expect(app.cursor()).toBe(8);
    await app.keys("n"); expect(app.cursor()).toBe(16);
    await app.keys("N"); expect(app.cursor()).toBe(8);
    await app.keys("?one\n"); expect(app.cursor()).toBe(0);
    await app.keys("n");

    expect(app.cursor()).toBe(16); expect(app.view.promptDrafts.a1).toBe("Unsent draft");
  } finally { await app.close(); }
});

test("*와 #는 부분 단어를 제외하고 y/검색은 이동 없이 범위만 복사한다", async () => {
  // 별표 검색은 alphaX를 alpha의 일치로 오해하면 안 된다.
  const app = await mount("alpha alphaX alpha beta");
  try {
    await app.read();

    await app.keys("*"); expect(app.cursor()).toBe(13);
    await app.keys("#"); expect(app.cursor()).toBe(0);
    await app.keys("y/beta\n"); await app.waitFor(() => app.copied.length === 1);

    expect(app.copied).toEqual(["alpha alphaX alpha "]); expect(app.cursor()).toBe(0);
  } finally { await app.close(); }
});

test("검색 Ctrl+C는 검색어만 지우고 빈 상태의 반복도 초안이나 실행을 중단하지 않는다", async () => {
  // 포커스가 바뀐 뒤까지 반복 입력을 소비하는 공유 라우터 경계를 사용한다.
  let interrupted = 0;
  const app = await mount("alpha beta", { onInterrupt: async () => { interrupted++; return ok(undefined); } });
  const raw = (sequence: string) => { const key = parseKeypress(sequence, { useKittyKeyboard: true }); if (!key) throw new Error("Invalid key"); app.renderer.keyInput.processParsedKey(key); };
  try {
    await app.read(); await app.keys("/"); await app.mockInput.typeText("beta");

    raw("\x1b[99;5u"); expect(app.search().value).toBe("");
    app.mockInput.pressEscape(); raw("\x1b[99;5:2u"); raw("\x1b[99;5:3u"); await app.render();

    expect(app.state()?.mode).toBe("text"); expect(app.view.promptDrafts.a1).toBe("Unsent draft"); expect(interrupted).toBe(0);
  } finally { await app.close(); }
});

test("vip·yap은 문단과 빈 줄 범위를 선택/복사하고 Markdown을 유지한다", async () => {
  // 문단 객체는 화면 자동 줄바꿈이 아닌 실제 빈 줄 경계를 따른다.
  const app = await mount("first line\nsecond\n\nthird", {}, "assistant");
  try {
    await app.read(3);

    await app.keys("vip"); expect(app.body().getSelectedText()).toBe("first line\nsecond\n");
    await app.keys("y"); await app.waitFor(() => app.copied.length === 1);
    await app.keys("yap"); await app.waitFor(() => app.copied.length === 2);

    expect(app.copied).toEqual(["first line\nsecond\n", "first line\nsecond\n\n"]);
    expect(descendants(app.renderer.root).some(node => node instanceof MarkdownRenderable && node.visible)).toBe(true);
  } finally { await app.close(); }
});

test("검색 취소는 원래 Visual 선택과 실제 표시 강조를 보존한다", async () => {
  // 검색 창으로 포커스를 옮기는 동안에도 이미 선택한 본문은 보호한다.
  const app = await mount("**alpha beta gamma**", {}, "assistant");
  try {
    await app.read(8); await app.keys("viw"); const before = app.cursor();

    await app.keys("/"); await app.mockInput.typeText("gamma"); await app.render();
    expect(app.renderer.getSelection()?.getSelectedText()).toBe("beta");
    app.mockInput.pressEscape(); await app.render();

    expect(app.cursor()).toBe(before); expect(app.body().getSelectedText()).toBe("beta"); expect(app.state()?.mode).toBe("visual");
  } finally { await app.close(); }
});

test("스트리밍 append 사이의 viw·yw는 유지하고 본문 교체는 미완성 연산자를 취소한다", async () => {
  // 단어 객체의 접두어를 매 출력 조각마다 취소하면 viw가 다시 v+w처럼 오동작한다.
  const app = await mount("alpha beta", {}, "assistant");
  try {
    await app.read(8); await app.keys("vi");

    await app.update("alpha beta gamma"); await app.keys("w");
    expect(app.body().getSelectedText()).toBe("beta");
    app.mockInput.pressEscape(); await app.render(); app.body().cursorOffset = app.body().editBuffer.measureText("alpha be");
    await app.keys("y"); await app.update("alpha beta gamma delta"); await app.keys("w");
    await app.waitFor(() => app.copied.length === 1);
    await app.keys("y"); await app.update("replacement text"); await app.keys("w");

    expect(app.copied).toEqual(["ta "]); expect(app.body().plainText).toBe("replacement text"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("붙여넣기는 미완성 yank를 취소하고 편집 키는 읽기 본문을 변경하지 않는다", async () => {
  // 붙여넣기 데이터와 편집 명령을 새 Vim 액션으로 해석하면 안 된다.
  const text = "alpha beta gamma", app = await mount(text);
  try {
    await app.read(); await app.keys("y");

    await app.mockInput.pasteBracketedText("iw\nwould edit"); await app.keys("w");
    await app.keys("iaIAoOdcxpru.");

    expect(app.copied).toEqual([]); expect(app.body().plainText).toBe(text); expect(app.sent).toEqual([]);
    app.mockInput.pressEscape(); app.mockInput.pressEscape(); await app.render();
    await app.mockInput.typeText("viwy"); await app.render();
    expect(app.view.promptDrafts.a1).toBe("Unsent draftviwy");
  } finally { await app.close(); }
});

test("문자 인수의 Shift·held repeat는 모션으로 재해석되지 않는다", async () => {
  // 실제 Kitty 프로토콜의 Shift+quote는 이중 따옴표 객체이며 w repeat는 추가 이동이 아니다.
  const app = await mount('before "hello world" after');
  const raw = (sequence: string) => { const key = parseKeypress(sequence, { useKittyKeyboard: true }); if (!key) throw new Error("Invalid key"); app.renderer.keyInput.processParsedKey(key); };
  try {
    await app.read(12); await app.keys("vi");

    app.mockInput.pressKey("'", { shift: true }); await app.render();
    expect(app.body().getSelectedText()).toBe("hello world");
    app.mockInput.pressEscape(); await app.render();
    app.body().cursorOffset = 0; await app.keys("f"); raw("\x1b[119u"); const cursor = app.cursor();
    raw("\x1b[119;1:2u"); raw("\x1b[119;1:3u"); await app.render();

    expect(app.cursor()).toBe(cursor); expect(app.body().plainText).toBe('before "hello world" after');
  } finally { await app.close(); }
});

test("사용자 재설정은 inner/yank/word 명령에 적용되고 객체 문자는 리터럴 인수로 유지한다", async () => {
  // 연산자와 객체 접두어는 명령이고 w는 그 뒤의 고정된 객체 이름이다.
  const keymap = expectOk(parseKeymap({ bindings: {
    "transcript.inner-object": [{ keys: "u", scope: "transcript-text" }, { keys: "u", scope: "transcript-visual" }],
    "transcript.copy": [{ keys: "c", scope: "transcript-text" }, { keys: "c", scope: "transcript-visual" }],
    "transcript.word-next": [{ keys: "q", scope: "transcript-text" }, { keys: "q", scope: "transcript-visual" }],
  } }));
  const app = await mount("alpha beta gamma", { keymap });
  try {
    await app.read(8);

    await app.keys("c"); expect(app.captureCharFrame()).toContain("TEXT · c");
    await app.keys("uw"); await app.waitFor(() => app.copied.length === 1);
    await app.keys("cq"); await app.waitFor(() => app.copied.length === 2);

    expect(app.copied).toEqual(["beta", "ta "]); expect(app.cursor()).toBe(8);
  } finally { await app.close(); }
});

test.each(["user", "assistant"] as const)("마우스로 선택한 %s 텍스트의 y는 복사하고 이후 이동은 새 yank 연산자로 전환한다", async kind => {
  // 네이티브 마우스 선택을 새 y 연산자로 오해하거나 다른 입력의 선택을 복사하지 않는다.
  const text = "alpha beta gamma", app = await mount(kind === "assistant" ? `**${text}**` : text, {}, kind);
  try {
    await app.read();
    const lines = app.captureCharFrame().split("\n"), y = lines.findIndex(line => line.includes("beta"));
    const x = Bun.stringWidth(lines[y]!.slice(0, lines[y]!.indexOf("beta")));

    await app.mockMouse.drag(x, y, x + 3, y); await app.render();
    await app.keys("y"); await app.waitFor(() => app.copied.length === 1);
    await app.keys("w"); await app.keys("y"); expect(app.copied).toEqual(["beta"]);
    await app.keys("y"); await app.waitFor(() => app.copied.length === 2);

    expect(app.copied).toEqual(["beta", text]); expect(app.body().plainText).toBe(text); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("문자 인수 취소의 held Ctrl+C는 나중에 포커스된 Agent 초안을 지우지 않는다", async () => {
  // 찾기 인수에서 시작한 취소와 입력창에서 새로 누른 지우기를 구분한다.
  const app = await mount("alpha beta");
  const raw = (sequence: string) => { const key = parseKeypress(sequence, { useKittyKeyboard: true }); if (!key) throw new Error("Invalid key"); app.renderer.keyInput.processParsedKey(key); };
  try {
    await app.read(); await app.keys("f");

    raw("\x1b[99;5u"); app.mockInput.pressEscape(); app.mockInput.pressEscape(); await app.render();
    raw("\x1b[99;5:2u"); raw("\x1b[99;5:3u"); await app.render();

    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt"); expect(app.view.promptDrafts.a1).toBe("Unsent draft");
    raw("\x1b[99;5u"); await app.render(); expect(app.view.promptDrafts.a1).toBeUndefined(); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("숫자 접두어를 다른 키로 재설정하면 뒤의 숫자는 리터럴 count 인수로 받는다", async () => {
  // count 명령 자체도 설정할 수 있어야 하며 기본 숫자 매핑을 강제로 가로채지 않는다.
  const keymap = expectOk(parseKeymap({ bindings: { "transcript.count": [{ keys: "q", scope: "transcript-text" }] } }));
  const app = await mount("one two three four five", { keymap });
  try {
    await app.read();

    await app.keys("q3w"); expect(app.cursor()).toBe(14);
    await app.keys("0yq2w"); await app.waitFor(() => app.copied.length === 1);

    expect(app.copied).toEqual(["one two "]); expect(app.cursor()).toBe(0);
  } finally { await app.close(); }
});

test("렌더링된 Markdown의 한글·결합문자·이모지는 viw·yiw에서 원문 기호 없이 처리한다", async () => {
  // 원문 오프셋이나 UTF-16 코드 유닛을 화면 셀 오프셋으로 오해하지 않는다.
  const app = await mount("**한글 é 👨‍👩‍👧‍👦**", {}, "assistant");
  try {
    await app.read(1); await app.keys("viw"); expect(app.body().getSelectedText()).toBe("한글");
    app.mockInput.pressEscape(); await app.render();
    const text = app.body().plainText, target = text.indexOf("👨"); app.body().cursorOffset = app.body().editBuffer.measureText(text.slice(0, target));

    await app.keys("yiw"); await app.waitFor(() => app.copied.length === 1);

    expect(app.copied).toEqual(["👨‍👩‍👧‍👦"]);
    expect(descendants(app.renderer.root).some(node => node instanceof MarkdownRenderable && node.visible)).toBe(true);
    expect(app.captureCharFrame()).not.toContain("**한글"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});
