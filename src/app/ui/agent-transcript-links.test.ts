import { expect, test } from "bun:test";
import { CodeRenderable, EditBufferRenderable, parseKeypress, type Renderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { parseKeymap } from "../../keybindings/config.ts";
import { pressLeader, pressTranscriptRead } from "../../testing/transcript-keys.ts";
import { expectOk } from "../../testing/results.ts";
import { BrowserError } from "../../errors.ts";
import { err, ok } from "../../result.ts";
import type { TranscriptSection } from "../../agents/transcript.ts";

function descendants(root: Renderable): Renderable[] { return root.getChildren().flatMap(child => [child, ...descendants(child)]); }
async function mount(text: string, actions: Partial<WorkbenchActions> = {}, kind: TranscriptSection["kind"] = "assistant") {
  const app = await createTestRenderer({ width: 110, height: 30, kittyKeyboard: true });
  const opened: string[] = [], sent: string[] = [];
  const view = new Workbench(app.renderer, new WorkspaceSelection(demoWorkspace()), {
    onNewSession: () => {}, onCloseSession: () => {}, initialDrafts: { a1: "Keep this draft" },
    onPrompt: (_id, text) => { sent.push(text); return ok(undefined); },
    onOpenTranscriptUrl: async url => { opened.push(url); return ok(undefined); },
    getSessionDetails: () => ({ status: "complete", output: "", error: null, sections: [{ id: "answer", kind, title: "Agent", text, status: "complete" }] }),
    ...actions,
  });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  await render();
  return { ...app, view, opened, sent, render,
    async settled() {
      for (let i = 0; i < 3; i++) {
        await Promise.all(descendants(app.renderer.root).filter((node): node is CodeRenderable => node instanceof CodeRenderable).map(node => node.highlightingDone));
        await render();
      }
    },
    async source(at: string) {
      pressTranscriptRead(app, actions.keymap); app.mockInput.pressKey("HOME"); app.mockInput.pressEnter(); await render();
      const body = app.renderer.currentFocusedRenderable;
      if (!(body instanceof EditBufferRenderable)) throw new Error("Missing source cursor");
      const offset = body.plainText.indexOf(at);
      if (offset < 0) throw new Error(`Missing source text ${at}`);
      body.cursorOffset = body.editBuffer.measureText(body.plainText.slice(0, offset));
      return body;
    },
    position(label: string) {
      const lines = app.captureCharFrame().split("\n"), y = lines.findIndex(line => line.includes(label));
      if (y < 0) throw new Error(`Missing ${label}`);
      return { x: Bun.stringWidth(lines[y]!.slice(0, lines[y]!.indexOf(label))), y };
    },
    async gx() { app.mockInput.pressKey("g"); app.mockInput.pressKey("x"); await render(); },
    async close() { view.dispose(); await app.dispose(); },
  };
}

test("Unicode 앞부분이 있는 Markdown 링크의 라벨에서 gx를 누르면 원문과 초안을 보존하고 주소를 연다", async () => {
  // 표시 라벨과 실제 URL이 다르고 앞부분의 셀 너비와 JS 문자열 길이도 다르다.
  const app = await mount("한글 👨‍👩‍👧‍👦 é [문서 보기](https://example.invalid/docs?q=one&next=two)");
  try {
    const body = await app.source("문서 보기"), cursor = body.cursorOffset;

    // 읽기 커서 아래의 링크만 외부 브라우저로 전달한다.
    await app.gx(); await app.waitFor(() => app.opened.length === 1);

    // 링크를 여는 동작은 커서 이동이나 프롬프트 전송이 아니다.
    expect(app.opened).toEqual(["https://example.invalid/docs?q=one&next=two"]);
    expect(body.cursorOffset).toBe(cursor); expect(app.renderer.currentFocusedRenderable).toBe(body);
    expect(app.view.promptDrafts.a1).toBe("Keep this draft"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("일반 URL의 gx와 Visual 선택은 브라우저를 열어도 선택 내용을 바꾸지 않는다", async () => {
  // 코드 출력과 같은 리터럴 본문에서도 localhost 주소를 열 수 있어야 한다.
  const app = await mount("Visit http://localhost:3000/path_(part).", {}, "user");
  try {
    const body = await app.source("http://"); app.mockInput.pressKey("v"); app.mockInput.pressKey("l");
    const selection = body.getSelectedText();

    await app.gx(); await app.waitFor(() => app.opened.length === 1);

    // 문장의 마침표는 주소에 포함하지 않고 기존 선택은 유지한다.
    expect(app.opened).toEqual(["http://localhost:3000/path_(part)"]);
    expect(body.getSelectedText()).toBe(selection);
  } finally { await app.close(); }
});

test("렌더링된 Markdown 링크를 클릭하면 실제 대상 주소를 한 번만 연다", async () => {
  // 기본 테스트 터미널은 OSC 8을 지원하지 않아도 앱이 클릭을 처리해야 한다.
  const app = await mount("[Open documentation](https://example.invalid/docs)");
  try {
    await app.settled(); const { x, y } = app.position("Open documentation");

    await app.mockMouse.click(x + 2, y); await app.waitFor(() => app.opened.length === 1);

    expect(app.opened).toEqual(["https://example.invalid/docs"]);
    expect(app.view.promptDrafts.a1).toBe("Keep this draft"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("링크를 드래그해 선택하거나 오른쪽 클릭하면 브라우저를 열지 않는다", async () => {
  // 마우스로 복사할 텍스트를 선택하는 동작과 링크 활성화를 구분한다.
  const app = await mount("[Selectable documentation](https://example.invalid/docs)");
  try {
    await app.settled(); const { x, y } = app.position("Selectable documentation");

    await app.mockMouse.drag(x + 1, y, x + 8, y); await app.render();
    await app.mockMouse.click(x + 2, y, 2); await app.render();

    expect(app.opened).toEqual([]); expect(app.renderer.getSelection()?.getSelectedText()).toContain("elect");
  } finally { await app.close(); }
});

test("일반 본문의 URL 클릭은 줄바꿈과 한글 앞부분이 있어도 해당 주소를 연다", async () => {
  // Markdown 렌더러를 거치지 않는 본문도 마우스와 키보드에서 같은 링크를 연다.
  const app = await mount("안내\n한글 http://localhost:3000/preview", {}, "user");
  try {
    const { x, y } = app.position("http://localhost:3000/preview");

    await app.mockMouse.click(x + 3, y); await app.waitFor(() => app.opened.length === 1);

    expect(app.opened).toEqual(["http://localhost:3000/preview"]);
  } finally { await app.close(); }
});

test.each(["javascript:alert(1)", "file:///tmp/private", "data:text/html,unsafe", "command:run"])("Markdown 대상 %s는 브라우저에 전달하지 않는다", async url => {
  // AI가 제공한 링크라도 웹 주소 외의 실행 스킴은 허용하지 않는다.
  const app = await mount(`[Unsafe target](${url})`);
  try {
    await app.source("Unsafe target");

    await app.gx(); await app.waitForFrame(frame => frame.includes("Only HTTP(S)"));

    expect(app.opened).toEqual([]); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("브라우저 실행 실패는 알림으로 표시하고 자동으로 다시 열지 않는다", async () => {
  // GUI가 없는 환경의 실패를 성공이나 취소로 오해하지 않는다.
  let attempts = 0;
  const app = await mount("https://example.invalid", { onOpenTranscriptUrl: async () => { attempts++; return err(new BrowserError("No browser handler")); } });
  try {
    await app.source("https://");

    await app.gx(); await app.waitForFrame(frame => frame.includes("No browser handler"));

    expect(attempts).toBe(1); expect(app.view.promptDrafts.a1).toBe("Keep this draft");
  } finally { await app.close(); }
});

test("링크 열기 키를 o로 재지정해도 입력창의 gx는 문자로 남고 도움말은 설정을 따른다", async () => {
  // 기본 gx를 대체하는 사용자 설정은 본문에만 적용된다.
  const keymap = expectOk(parseKeymap({ bindings: { "transcript.open-link": [{ keys: "o", scope: "transcript-text" }] } }));
  const app = await mount("https://example.invalid", { keymap });
  try {
    pressLeader(app, "a"); await app.mockInput.typeText("gx");
    const body = await app.source("https://");

    await app.gx(); expect(app.opened).toEqual([]);
    app.mockInput.pressKey("o"); await app.waitFor(() => app.opened.length === 1);
    app.mockInput.pressKey("F1"); await app.render();

    // 비활성 기본 키를 힌트에 남기지 않고 입력도 전송하지 않는다.
    expect(app.captureCharFrame()).toContain("o open HTTP(S) link");
    expect(app.view.promptDrafts.a1).toContain("gx"); expect(body.plainText).toBe("https://example.invalid"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("줄바꿈된 일반 URL의 이어지는 행을 클릭해도 주소 전체를 연다", async () => {
  // 긴 주소는 화면에서 여러 행에 나뉘어도 하나의 원문 URL이다.
  const url = "http://localhost:3000/" + "segment/".repeat(12) + "wrapped-target";
  const app = await mount("한글 " + url, {}, "user");
  try {
    app.resize(55, 30); await app.render(); const { x, y } = app.position("wrapped-target");

    // 첫 행이 아닌 실제 클릭 위치의 읽기 커서를 사용한다.
    await app.mockMouse.click(x + 2, y); await app.waitFor(() => app.opened.length === 1);

    expect(app.opened).toEqual([url]);
  } finally { await app.close(); }
});

test("링크가 아닌 문자나 URL 뒤의 빈 여백을 클릭하면 다른 주소를 열지 않는다", async () => {
  // 같은 본문에 주소가 있더라도 빈 여백의 네이티브 커서 보정을 활성화로 해석하지 않는다.
  const app = await mount("Before http://localhost:3000", {}, "user");
  try {
    await app.source("Before"); const { x, y } = app.position("http://localhost:3000");

    await app.gx(); await app.waitForFrame(frame => frame.includes("No HTTP(S) link"));
    await app.mockMouse.click(x + "http://localhost:3000".length + 3, y); await app.render();

    expect(app.opened).toEqual([]); expect(app.view.promptDrafts.a1).toBe("Keep this draft");
  } finally { await app.close(); }
});

test("보조키를 누른 링크 클릭은 앱이 브라우저 실행으로 가로채지 않는다", async () => {
  // 터미널 자체의 수정키 클릭과 앱 소유의 일반 클릭을 구분한다.
  const app = await mount("[Modified documentation](https://example.invalid/docs)");
  try {
    await app.settled(); const { x, y } = app.position("Modified documentation");

    for (const modifiers of [{ ctrl: true }, { shift: true }, { alt: true }]) {
      await app.mockMouse.click(x + 2, y, 0, { modifiers });
    }
    await app.render();

    expect(app.opened).toEqual([]);
  } finally { await app.close(); }
});

test("o로 재지정한 링크 열기 키를 길게 눌러도 한 번만 열고 포커스 이동 후 반복 입력을 소비한다", async () => {
  // 사용자가 단일 키로 재설정해도 여러 탭이 반복 생성되면 안 된다.
  const keymap = expectOk(parseKeymap({ bindings: { "transcript.open-link": [{ keys: "o", scope: "transcript-text" }] } }));
  const app = await mount("https://example.invalid", { keymap });
  const raw = (sequence: string) => {
    const key = parseKeypress(sequence, { useKittyKeyboard: true });
    if (!key) throw new Error("Invalid Kitty key");
    app.renderer.keyInput.processParsedKey(key);
  };
  try {
    await app.source("https://");

    // 키를 놓기 전의 repeat는 본문과 입력창 양쪽에서 모두 같은 액션으로 소비한다.
    raw("\x1b[111u"); raw("\x1b[111;1:2u");
    pressLeader(app, "a"); raw("\x1b[111;1:2u");
    await app.waitFor(() => app.opened.length === 1);

    expect(app.opened).toEqual(["https://example.invalid"]); expect(app.view.promptDrafts.a1).toBe("Keep this draft");
    raw("\x1b[111;1:3u"); app.mockInput.pressKey("o");
    expect(app.view.promptDrafts.a1).toBe("Keep this drafto");
  } finally { await app.close(); }
});

test("화면 밖의 긴 Markdown 본문에서도 현재 링크의 실제 대상을 보존한다", async () => {
  // 링크 메타데이터의 보관은 현재 터미널 화면이나 임시 래스터 한 장에 의존하지 않는다.
  const text = "| Link |\n|---|\n| [First target](https://example.invalid/first) |\n\n" + Array.from({ length: 300 }, (_, index) => `row ${index}`).join("\n")
    + "\n\n[Final target](http://localhost:3000/final)";
  const app = await mount(text);
  try {
    await app.settled(); await app.source("Final target");

    // 앞쪽 링크나 현재 화면의 같은 좌표가 아닌 커서의 대상만 연다.
    await app.gx(); await app.waitFor(() => app.opened.length === 1);

    expect(app.opened).toEqual(["http://localhost:3000/final"]); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("링크 열기 키를 비활성화하면 gx를 실행하지 않고 기본 키 힌트도 남기지 않는다", async () => {
  // 명시적인 빈 바인딩은 기본값으로 조용히 복구하면 안 된다.
  const keymap = expectOk(parseKeymap({ bindings: { "transcript.open-link": [] } }));
  const app = await mount("https://example.invalid", { keymap });
  try {
    await app.source("https://");

    await app.gx(); app.mockInput.pressKey("F1"); await app.render();

    expect(app.opened).toEqual([]); expect(app.captureCharFrame()).not.toContain("gx open HTTP(S) link");
  } finally { await app.close(); }
});
