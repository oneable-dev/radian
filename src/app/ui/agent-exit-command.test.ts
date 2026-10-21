import { expect, test } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { filterCompletions } from "../../agents/completion.ts";
import { sessionControlCommands } from "../../agents/session-controls.ts";
import { PromptInput } from "../../agents/ui/prompt-input.ts";
import { SessionError, type ExpectedError } from "../../errors.ts";
import { err, ok, type Result } from "../../result.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { Workbench } from "./workbench.ts";

async function mount(closing: Promise<Result<void, ExpectedError>> = Promise.resolve(ok(undefined))) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true, clock });
  const selection = new WorkspaceSelection(demoWorkspace()), submitted: { id: string; text: string }[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession() {}, onCloseSession() {}, initialDrafts: { a2: "Second draft", b1: "Feature draft" },
    getSessionDetails: id => ({ conversationId: id, status: "working", output: "", error: null, sections: [
      { id: `${id}:answer`, kind: "assistant", title: "Agent", text: "```text\n" + "RETAINED_LINE\n".repeat(80) + "```", status: "complete" },
    ] }),
    onComplete: async (_id, query) => ok(filterCompletions(sessionControlCommands, query.query)),
    onPrompt: async (id, text) => {
      submitted.push({ id, text });
      const result = await closing;
      if (!result.ok) return result;
      selection.replaceSnapshot(selection.snapshot.map(repo => ({ ...repo, worktrees: repo.worktrees.map(tree => ({ ...tree,
        sessions: tree.sessions.filter(session => session.id !== id),
      })) })));
      return result;
    },
  });
  const render = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await app.renderOnce(); await app.renderOnce(); };
  await render();
  const input = app.renderer.root.findDescendantById("session-prompt"), scroll = app.renderer.root.findDescendantById("session-transcript");
  if (!(input instanceof PromptInput) || !(scroll instanceof ScrollBoxRenderable)) throw new Error("Missing prompt/transcript");
  input.focus(); await render();
  return { ...app, view, selection, input, scroll, submitted, render,
    async submit(text: string) { input.value = text; await render(); clock.advance(150); await render(); app.mockInput.pressEnter(); await render(); },
    async close() { view.dispose(); await app.dispose(); } };
}

test("exit 제출은 현재 탭을 닫고 다음 탭의 초안과 다른 워크트리를 유지한다", async () => {
  // 실행 중인 현재 대화와 별도 초안이 있는 다음 탭을 준비한다.
  const app = await mount();
  try {
    // 종료 명령은 버튼 대신 Agent 입력창으로 실행한다.
    await app.submit("/exit");

    // 닫힌 탭의 명령만 소비하고 살아 있는 탭의 입력과 포커스는 유지한다.
    expect(app.submitted).toEqual([{ id: "a1", text: "/exit" }]);
    expect(app.selection.worktree?.sessions.map(session => session.id)).toEqual(["a2", "a3"]);
    expect(app.selection.sessionId).toBe("a2"); expect(app.input.value).toBe("Second draft");
    expect(app.view.promptDrafts.a1).toBeUndefined(); expect(app.view.promptDrafts.b1).toBe("Feature draft");
    expect(app.renderer.currentFocusedRenderable).toBe(app.input); expect(app.view.root.isDestroyed).toBe(false);
  } finally { await app.close(); }
});

test("exit 자동완성은 마지막 탭도 닫되 앱과 다른 워크트리의 탭은 종료하지 않는다", async () => {
  // 선택한 워크트리에는 하나의 세션만 남아 있다.
  const app = await mount();
  try {
    app.selection.selectSession("demo:feature", "b1"); await app.render(); app.input.focus();

    // 축약 입력을 Enter로 실행하면 완성된 호스트 명령을 제출한다.
    await app.submit("/ex");

    // 마지막 탭 종료는 빈 화면으로 돌아갈 뿐 Radian 전체를 종료하지 않는다.
    expect(app.submitted).toEqual([{ id: "b1", text: "/exit" }]);
    expect(app.selection.sessionId).toBeNull(); expect(app.selection.worktree?.sessions).toEqual([]);
    expect(app.captureCharFrame()).toContain("No open sessions"); expect(app.view.root.isDestroyed).toBe(false);
    expect(app.selection.snapshot[0]?.worktrees[0]?.sessions.map(session => session.id)).toEqual(["a1", "a2", "a3"]);
    expect(app.view.promptDrafts.a2).toBe("Second draft");
  } finally { await app.close(); }
});

test("exit의 추가 인수는 탭을 닫지 않고 오류와 원문을 유지한다", async () => {
  // 잘못된 종료 명령이 일반 프롬프트로 전달되지 않도록 실제 입력 경로를 사용한다.
  const app = await mount();
  try {
    // 종료 명령에는 인수를 허용하지 않는다.
    await app.submit("/exit later");

    // 거부한 명령은 현재 탭의 입력창에 그대로 남는다.
    expect(app.submitted).toEqual([]); expect(app.selection.sessionId).toBe("a1");
    expect(app.input.value).toBe("/exit later"); expect(app.captureCharFrame()).toContain("INVALID_INPUT");
  } finally { await app.close(); }
});

test("exit의 이미지 첨부는 탭을 닫지 않고 명령과 첨부를 유지한다", async () => {
  // 종료 명령과 함께 이미지가 소비되거나 모델로 보내지면 안 된다.
  const app = await mount();
  try {
    app.input.value = "/exit "; app.input.attachFile("/tmp/exit-fixture.png");
    const draft = app.input.draft;

    // 첨부가 있는 종료 명령을 실제 입력 경로로 제출한다.
    app.mockInput.pressEnter(); await app.render();

    // 유효하지 않은 명령은 종료 요청 없이 원래 입력에 남는다.
    expect(app.submitted).toEqual([]); expect(app.selection.sessionId).toBe("a1");
    expect(app.input.draft).toEqual(draft); expect(app.captureCharFrame()).toContain("INVALID_INPUT");
  } finally { await app.close(); }
});

test("exit 거절은 탭과 명령·읽기 위치를 유지한다", async () => {
  // 호스트가 종료를 수락하기 전에 거절하는 상황을 재현한다.
  const app = await mount(Promise.resolve(err(new SessionError("SESSION_CONFLICT", "Conversation changed"))));
  try {
    app.scroll.scrollTo(10); await app.render();
    const top = app.scroll.scrollTop, navigation = structuredClone(app.view.workViewPreferences.agentViews?.a1);

    // 거절된 종료 명령은 현재 대화의 탐색 상태를 바꾸면 안 된다.
    await app.submit("/exit");

    // 원래 입력으로 재시도할 수 있고 대화나 탭은 이동하지 않는다.
    expect(app.selection.sessionId).toBe("a1"); expect(app.input.value).toBe("/exit");
    expect(app.scroll.scrollTop).toBe(top); expect(app.view.workViewPreferences.agentViews?.a1).toEqual(navigation);
    expect(app.captureCharFrame()).toContain("SESSION_CONFLICT");
  } finally { await app.close(); }
});

test("exit 대기 중 다른 탭으로 이동하면 늦은 종료가 그 탭의 선택과 초안을 바꾸지 않는다", async () => {
  // 종료 응답을 기다리는 동안 다른 탭에서 입력을 계속할 수 있다.
  const ready = Promise.withResolvers<Result<void, ExpectedError>>();
  const app = await mount(ready.promise);
  try {
    await app.submit("/exit");
    app.selection.selectSession("demo:main", "a2"); await app.render();
    app.input.value = "Edited while closing"; await app.render();

    // 원래 탭의 종료를 늦게 수락한다.
    ready.resolve(ok(undefined)); await app.render();

    // 종료의 영향은 요청을 보낸 탭에만 적용한다.
    expect(app.selection.sessionId).toBe("a2"); expect(app.input.value).toBe("Edited while closing");
    expect(app.view.promptDrafts.a1).toBeUndefined(); expect(app.view.promptDrafts.a2).toBe("Edited while closing");
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
  } finally { ready.resolve(ok(undefined)); await app.render(); await app.close(); }
});
