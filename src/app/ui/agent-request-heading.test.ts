import { expect, test } from "bun:test";
import { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { ExecutionState } from "../../agents/session-registry.ts";
import type { TranscriptSection } from "../../agents/transcript.ts";
import { InputError, type ExpectedError } from "../../errors.ts";
import { err, ok, type Result } from "../../result.ts";

const request = (id: string, text: string): TranscriptSection => ({ id, kind: "user", title: "You", text, status: "complete" });
const answer = (text: string): TranscriptSection => ({ id: "answer", kind: "assistant", title: "Agent", text, status: "streaming" });
async function mount(actions: Partial<WorkbenchActions> = {}) {
  const app = await createTestRenderer({ width: 120, height: 28, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace());
  const states: Record<string, ExecutionState> = {
    a1: { status: "working", output: "", error: null, sections: [request("first", "Implement workspace search"), answer(Array.from({ length: 100 }, (_, i) => `PROGRESS-${i}`).join("\n"))] },
    a2: { status: "complete", output: "", error: null, sections: [request("second", "Review the editor changes"), answer("Completed")] },
    b1: { status: "complete", output: "", error: null, sections: [request("feature", "Fix the feature worktree"), answer("Completed")] },
  };
  const sent: string[] = [];
  const view = new Workbench(app.renderer, selection, { onNewSession: () => {}, onCloseSession: () => {}, onPrompt: (_id, text) => { sent.push(text); return ok(undefined); },
    getSessionDetails: (id) => states[id] ?? null, initialDrafts: { a1: "unsent next command", a2: "second session draft", b1: "feature draft" }, ...actions });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  const get = (id: string) => { const node = app.renderer.root.findDescendantById(id); if (!node) throw new Error(`Missing ${id}`); return node; };
  const heading = () => { const node = get("agent-request"); return app.captureCharFrame().split("\n")[node.y]!.slice(node.x).trimEnd(); };
  const update = async () => { selection.replaceSnapshot(selection.snapshot); await render(); };
  await render();
  return { ...app, view, selection, states, sent, render, get, heading, update, async close() { view.dispose(); await app.dispose(); } };
}

test("상단 요청은 스크롤 밖에 고정되고 스트리밍 갱신에도 초안·포커스·대화 위치를 보존한다", async () => {
  const app = await mount();
  try {
    const header = app.get("agent-request"), scroll = app.get("session-transcript"), prompt = app.get("session-prompt");
    if (!(scroll instanceof ScrollBoxRenderable) || !(prompt instanceof InputRenderable)) throw new Error("Missing native controls.");
    const y = header.y, draft = prompt.value, cursor = prompt.cursorOffset;
    expect(app.heading()).toBe("Request Implement workspace search");
    expect(scroll.y).toBe(header.y + 1);

    // 사용자는 긴 대화를 읽는 동안에도 자신이 요청한 작업을 볼 수 있다.
    app.mockInput.pressKey("t", { ctrl: true }); scroll.scrollTo(20); await app.render();
    const focus = app.renderer.currentFocusedRenderable, top = scroll.scrollTop;
    const sections = app.states.a1!.sections!;
    app.states.a1 = { ...app.states.a1!, sections: [sections[0]!, answer(`${sections[1]!.text}\nNEW STREAM OUTPUT`)] };
    await app.update();

    expect(header.y).toBe(y); expect(header.height).toBe(1);
    expect(app.heading()).toBe("Request Implement workspace search");
    expect(scroll.scrollTop).toBe(top); expect(app.renderer.currentFocusedRenderable).toBe(focus);
    expect(prompt.value).toBe(draft); expect(prompt.cursorOffset).toBe(cursor);
    expect(app.view.promptDrafts.a1).toBe("unsent next command"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("세션과 워크트리를 오가면 각 대화의 마지막 요청을 복원하고 완료 후에도 남긴다", async () => {
  const app = await mount();
  try {
    // 저장된 대화에서 읽기 때문에 전송을 재생하거나 UI 전역 요청을 공유하지 않는다.
    app.selection.selectSession("demo:main", "a2"); await app.render();
    expect(app.heading()).toBe("Request Review the editor changes");
    app.selection.selectWorktree("demo:feature"); await app.render();
    expect(app.heading()).toBe("Request Fix the feature worktree");
    app.selection.selectSession("demo:main", "a1"); await app.render();

    app.states.a1 = { ...app.states.a1!, status: "complete" }; await app.update();
    expect(app.heading()).toBe("Request Implement workspace search");
    expect(app.view.promptDrafts).toMatchObject({ a1: "unsent next command", a2: "second session draft", b1: "feature draft" });
    expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("초안·거절·설정 명령 수락은 요청을 덮지 않고 실제 대화에 들어온 입력만 갱신한다", async () => {
  let response: Result<void, ExpectedError> = ok(undefined);
  const sent: string[] = [];
  const app = await mount({ onPrompt: (_id, text) => { sent.push(text); return response; } });
  try {
    const prompt = app.get("session-prompt"); if (!(prompt instanceof InputRenderable)) throw new Error("Missing prompt.");
    app.mockInput.pressKey("e", { ctrl: true }); prompt.value = "";
    await app.mockInput.typeText("/fast status"); app.mockInput.pressEnter(); await app.render();
    expect(app.heading()).toBe("Request Implement workspace search");

    // 수락되지 않은 입력은 편집기에 남고 처리 중 요청으로 표시하지 않는다.
    response = err(new InputError("Request rejected"));
    await app.mockInput.typeText("rejected input"); app.mockInput.pressEnter(); await app.render();
    expect(prompt.value).toBe("rejected input");
    expect(app.heading()).toBe("Request Implement workspace search");

    // steer의 전송 방식이나 대기열은 바꾸지 않고 반영된 사용자 섹션을 따라간다.
    app.states.a1 = { ...app.states.a1!, sections: [...app.states.a1!.sections!, request("delivered", "Run the tests first")] }; await app.update();
    expect(app.heading()).toBe("Request Run the tests first");
    expect(prompt.value).toBe("rejected input"); expect(sent).toEqual(["/fast status", "rejected input"]);
  } finally { await app.close(); }
});

test("요청 정보가 없는 세션은 공간을 차지하지 않고 작은 화면에서도 한 줄만 예약한다", async () => {
  const app = await mount();
  try {
    const header = app.get("agent-request"), scroll = app.get("session-transcript"), area = app.get("agent-transcript-area");
    const previousHeight = scroll.height;

    // 구버전 output이나 세션 이름을 사용자가 내린 요청으로 추측하지 않는다.
    app.states.a1 = { status: null, output: "Legacy output without request metadata", error: null }; await app.update();
    expect(header.visible).toBe(false); expect(scroll.y).toBe(area.y);
    expect(scroll.height).toBe(previousHeight + 1);

    app.states.a1 = { status: "complete", output: "", error: null, sections: [request("restored", "A long request that should stay on one line while the screen becomes narrow")] }; await app.update();
    app.resize(60, 12); await app.render();

    expect(header.visible).toBe(true); expect(header.height).toBe(1);
    expect(app.heading().endsWith("...")).toBe(true);
    expect(scroll.y).toBe(header.y + 1); expect(scroll.height).toBeGreaterThan(0);
    const composer = app.get("agent-composer");
    expect(composer.y + composer.height).toBeLessThanOrEqual(app.renderer.root.height - 1);
    expect(app.view.promptDrafts.a1).toBe("unsent next command"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});
