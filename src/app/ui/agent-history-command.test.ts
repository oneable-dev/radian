import { expect, test } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { filterCompletions } from "../../agents/completion.ts";
import { historyCommand } from "../../agents/history-command.ts";
import { PromptInput } from "../../agents/ui/prompt-input.ts";
import { ok } from "../../result.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { Workbench } from "./workbench.ts";

async function mount(completion = false) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true, clock });
  const selection = new WorkspaceSelection(demoWorkspace()), sent: string[] = [], lookups: string[] = [], interrupted: string[] = [];
  const state = { conversationId: "original", status: "working" as const, output: "", error: null, sections: [
    { id: "answer", kind: "assistant" as const, title: "Agent", text: "```text\n" + "RETAINED_LINE\n".repeat(80) + "```", status: "complete" as const },
  ] };
  const view = new Workbench(app.renderer, selection, { onNewSession() {}, onCloseSession() {},
    onPrompt: (_id, text) => { sent.push(text); return ok(undefined); }, getSessionDetails: () => state,
    onListHistory: async id => { lookups.push(id); return ok([]); },
    onInterrupt: async id => { interrupted.push(id); return ok(undefined); },
    ...(completion ? { onComplete: async (_id: string, query: { query: string }) => ok(filterCompletions([historyCommand], query.query)) } : {}),
  });
  const render = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await app.renderOnce(); await app.renderOnce(); };
  await render();
  const input = app.renderer.root.findDescendantById("session-prompt"), scroll = app.renderer.root.findDescendantById("session-transcript");
  if (!(input instanceof PromptInput) || !(scroll instanceof ScrollBoxRenderable)) throw new Error("Missing prompt/transcript");
  const popup = app.renderer.root.findDescendantById("session-history")!;
  input.focus(); await render();
  return { ...app, view, selection, input, scroll, popup, sent, lookups, interrupted, clock, render,
    async submit(text: string) { input.value = text; await render(); clock.advance(150); await render(); app.mockInput.pressEnter(); await render(); },
    async close() { view.dispose(); await app.dispose(); } };
}

test("history 명령은 실행 중인 대화와 읽기 위치를 유지하며 팝업만 열고 Esc로 입력창에 복귀한다", async () => {
  // 실행 중인 대화의 이전 출력을 읽고 있어도 히스토리 열기는 스크롤을 끝으로 옮기면 안 된다.
  const app = await mount();
  try {
    app.scroll.scrollTo(10); await app.render();
    const top = app.scroll.scrollTop, navigation = structuredClone(app.view.workViewPreferences.agentViews?.a1);

    // 단축키 대신 명령을 제출하고 팝업을 닫는다.
    await app.submit("/history");
    expect(app.popup.visible).toBe(true); expect(app.renderer.currentFocusedRenderable?.id).toBe("history-search");
    app.mockInput.pressEscape(); await app.render();

    // 명령만 소비하며 현재 탭·실행·읽기 위치와 입력 포커스는 유지한다.
    expect(app.lookups).toEqual(["demo:main"]); expect(app.sent).toEqual([]); expect(app.interrupted).toEqual([]);
    expect(app.selection.sessionId).toBe("a1"); expect(app.input.value).toBe(""); expect(app.view.promptDrafts.a1).toBeUndefined();
    expect(app.popup.visible).toBe(false); expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    expect(app.scroll.scrollTop).toBe(top); expect(app.view.workViewPreferences.agentViews?.a1).toEqual(navigation);
  } finally { await app.close(); }
});

test("history 자동완성을 Enter로 실행하면 현재 워크트리의 히스토리를 연다", async () => {
  // 다른 워크트리로 이동한 뒤 축약 입력의 자동완성을 실행한다.
  const app = await mount(true);
  try {
    app.selection.selectSession("demo:feature", "b1"); await app.render(); app.input.focus();

    // 자동완성 후보 실행도 일반 모델 입력으로 전달되면 안 된다.
    await app.submit("/his");

    // 원래 워크트리가 아니라 선택한 워크트리 범위에서 팝업을 연다.
    expect(app.popup.visible).toBe(true); expect(app.lookups).toEqual(["demo:feature"]);
    expect(app.sent).toEqual([]); expect(app.input.value).toBe(""); expect(app.selection.sessionId).toBe("b1");
  } finally { await app.close(); }
});

test("history의 인수는 팝업이나 모델로 전달하지 않고 오류와 원문을 유지한다", async () => {
  // 지원하지 않는 인수를 조용히 버리지 않도록 실제 제출 경로를 사용한다.
  const app = await mount();
  try {
    await app.submit("/history recent");

    // 거절한 명령은 초안에 남고 어떤 대화나 조회도 시작하지 않는다.
    expect(app.popup.visible).toBe(false); expect(app.lookups).toEqual([]); expect(app.sent).toEqual([]);
    expect(app.input.value).toBe("/history recent"); expect(app.captureCharFrame()).toContain("INVALID_INPUT");
  } finally { await app.close(); }
});

test("history의 이미지 첨부는 팝업을 열지 않고 첨부와 명령을 보존한다", async () => {
  // 이미지는 모델에 보내지 않는 명령과 함께 소비되거나 유실되면 안 된다.
  const app = await mount();
  try {
    app.input.value = "/history "; app.input.attachFile("/tmp/history-fixture.png");
    const draft = app.input.draft;

    // 첨부가 포함된 히스토리 명령을 제출한다.
    app.mockInput.pressEnter(); await app.render();

    // 유효하지 않은 입력은 모델 전송 없이 원래 첨부까지 유지한다.
    expect(app.popup.visible).toBe(false); expect(app.lookups).toEqual([]); expect(app.sent).toEqual([]);
    expect(app.input.draft).toEqual(draft); expect(app.captureCharFrame()).toContain("INVALID_INPUT");
  } finally { await app.close(); }
});
