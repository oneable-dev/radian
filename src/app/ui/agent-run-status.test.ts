import { expect, test } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import { PromptInput } from "../../agents/ui/prompt-input.ts";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
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
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 120, height: 28, kittyKeyboard: true, clock });
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
  const status = () => { const node = get("agent-run-status-text"); return node.visible ? app.captureCharFrame().split("\n")[node.y]!.slice(node.x, node.x + node.width).trimEnd() : ""; };
  const update = async () => { selection.replaceSnapshot(selection.snapshot); await render(); };
  await render();
  return { ...app, clock, view, selection, states, sent, render, get, status, update, async close() { view.dispose(); await app.dispose(); } };
}

test("프롬프트 위에 실제 요청과 실행 스피너를 표시하고 상단 Request·모드·섹션 개수는 제거한다", async () => {
  const app = await mount();
  try {
    const row = app.get("agent-run-status"), scroll = app.get("session-transcript"), prompt = app.get("session-prompt");
    if (!(scroll instanceof ScrollBoxRenderable) || !(prompt instanceof PromptInput)) throw new Error("Missing native controls.");
    const y = row.y, draft = prompt.value, cursor = prompt.cursorOffset;
    expect(app.status()).toBe("Working (0s · esc to interrupt) “Implement…");
    expect(app.get("agent-run-loading").visible).toBe(true);
    expect(app.renderer.root.findDescendantById("agent-request")).toBeUndefined();
    expect(scroll.y).toBe(app.get("agent-transcript-area").y);
    const group = app.get("transcript-status-row");
    expect(group.height).toBe(1); expect(row.y).toBe(group.y);
    expect(group.y).toBe(scroll.viewport.y + scroll.viewport.height + 1);
    expect(app.get("agent-composer").y).toBe(row.y + row.height + 1);
    const initialFrame = app.captureCharFrame().split("\n");
    for (const gutter of [group.y - 1, group.y + group.height]) expect(initialFrame[gutter]!.slice(group.x, group.x + group.width).trim()).toBe("");
    expect(app.captureCharFrame()).not.toMatch(/(?:INPUT|TRANSCRIPT) · \d+\/\d+|Request Implement/);

    // Reading old output must not move the running-request anchor or overwrite the draft.
    app.mockInput.pressKey("t", { ctrl: true }); scroll.scrollTo(20); await app.render();
    const focus = app.renderer.currentFocusedRenderable, top = scroll.scrollTop;
    const sections = app.states.a1!.sections!;
    app.states.a1 = { ...app.states.a1!, sections: [sections[0]!, answer(`${sections[1]!.text}\nNEW STREAM OUTPUT`)] };
    await app.update();

    expect(row.y).toBe(y); expect(row.height).toBe(1); expect(app.status()).toBe("Working (0s · esc to interrupt) “Implement…");
    expect(scroll.scrollTop).toBe(top); expect(app.renderer.currentFocusedRenderable).toBe(focus);
    expect(prompt.value).toBe(draft); expect(prompt.cursorOffset).toBe(cursor); expect(app.sent).toEqual([]);
    const frame = app.captureCharFrame().split("\n");
    expect(frame[row.y]).not.toContain("Paused"); expect(frame[app.get("footer-bar").y]).toContain("Paused");
    app.mockInput.pressKey("END", { ctrl: true }); await app.render();
    expect(app.captureCharFrame().split("\n")[app.get("footer-bar").y]).not.toContain("Paused");
    expect(app.status()).toBe("Working (0s · esc to interrupt) “Implement…");
  } finally { await app.close(); }
});

test("세션·워크트리 전환은 요청과 실행 상태를 함께 복원하고 이전 스피너를 다른 세션에 남기지 않는다", async () => {
  const app = await mount();
  try {
    app.selection.selectSession("demo:main", "a2"); await app.render();
    expect(app.status()).toBe(""); expect(app.get("agent-run-loading").visible).toBe(false);
    expect(app.get("transcript-status-row").visible).toBe(false);
    app.selection.selectWorktree("demo:feature"); await app.render();
    expect(app.status()).toBe(""); expect(app.get("transcript-status-row").visible).toBe(false);
    app.selection.selectSession("demo:main", "a1"); await app.render();
    expect(app.get("agent-run-loading").visible).toBe(true);

    app.states.a1 = { ...app.states.a1!, status: "complete" }; await app.update();
    expect(app.status()).toBe("");
    app.clock.advance(500); await app.render(); expect(app.get("agent-run-loading").visible).toBe(false);
    expect(app.view.promptDrafts).toMatchObject({ a1: "unsent next command", a2: "second session draft", b1: "feature draft" }); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("정상 완료는 스피너 최소 시간이 끝나면 상태 행을 비우고 읽던 위치·입력 포커스를 보존한다", async () => {
  const app = await mount();
  try {
    // No owned child or paste indicator should keep an otherwise empty status row open.
    app.selection.replaceSnapshot(app.selection.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => ({ ...tree,
      sessions: tree.sessions.map((session) => ({ ...session, subagents: [] })),
    })) })));
    const scroll = app.get("session-transcript"); if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("Missing transcript");
    app.mockInput.pressKey("t", { ctrl: true }); scroll.scrollTo(20); await app.render();
    const top = scroll.scrollTop, prompt = app.get("session-prompt");
    app.mockInput.pressKey("e", { ctrl: true }); await app.render(); const promptY = prompt.y;
    app.clock.advance(100);
    app.states.a1 = { ...app.states.a1!, status: "complete" }; await app.update();
    expect(app.status()).toBe(""); expect(app.get("agent-run-loading").visible).toBe(true);

    app.clock.advance(400); await app.render();

    expect(app.get("agent-run-loading").visible).toBe(false); expect(app.get("transcript-status-row").visible).toBe(false);
    expect(scroll.scrollTop).toBe(top); expect(prompt.y).toBe(promptY); expect(app.renderer.currentFocusedRenderable).toBe(prompt);
    expect(app.view.promptDrafts.a1).toBe("unsent next command"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("초안·거절·설정 명령은 작업 요청을 바꾸지 않고 실제 대화에 추가된 요청만 갱신한다", async () => {
  let response: Result<void, ExpectedError> = ok(undefined);
  const sent: string[] = [];
  const app = await mount({ onPrompt: (_id, text) => { sent.push(text); return response; } });
  try {
    const prompt = app.get("session-prompt"); if (!(prompt instanceof PromptInput)) throw new Error("Missing prompt.");
    app.mockInput.pressKey("e", { ctrl: true }); prompt.value = "";
    await app.mockInput.typeText("/fast status"); app.mockInput.pressEnter(); await app.render();
    expect(app.status()).toBe("Working (0s · esc to interrupt) “Implement…");
    response = err(new InputError("Request rejected"));
    await app.mockInput.typeText("rejected input"); app.mockInput.pressEnter(); await app.render();
    expect(prompt.value).toBe("rejected input"); expect(app.status()).toBe("Working (0s · esc to interrupt) “Implement…");

    app.states.a1 = { ...app.states.a1!, sections: [...app.states.a1!.sections!, request("delivered", "Run the tests first")] }; await app.update();
    expect(app.status()).toBe("Working (0s · esc to interrupt) “Run the te…");
    expect(prompt.value).toBe("rejected input"); expect(sent).toEqual(["/fast status", "rejected input"]);
  } finally { await app.close(); }
});

test("요청 없는 실행은 내용을 추측하지 않고 긴 요청도 작은 화면의 상태 한 줄 안에 표시한다", async () => {
  const app = await mount();
  try {
    app.states.a1 = { status: "working", output: "Legacy output without request metadata", error: null }; await app.update();
    expect(app.status()).toBe("Working (0s · esc to interrupt)");
    app.states.a1 = { status: "working", output: "", error: null, sections: [request("restored", "A long request that should stay on one line while the screen becomes narrow")] }; await app.update();
    app.resize(60, 12); await app.render();
    expect(app.get("agent-run-status").height).toBe(1); expect(app.status().endsWith("…")).toBe(true);
    expect(app.get("session-transcript").height).toBeGreaterThan(0);
    expect(app.get("session-status").y + app.get("session-status").height).toBeLessThanOrEqual(app.get("app-footer").y);
    expect(app.view.promptDrafts.a1).toBe("unsent next command"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("clear 교체는 같은 탭과 다른 초안을 유지하고 이전 요청·스피너·읽기 상태를 제거한다", async () => {
  const app = await mount({ onPrompt: () => {
    app.states.a1 = { conversationId: "fresh", status: null, output: "", error: null, sections: [] };
    app.selection.replaceSnapshot(app.selection.snapshot); return ok(undefined);
  } });
  try {
    app.states.a1 = { ...app.states.a1!, conversationId: "previous" }; await app.update();
    const tab = app.get("session:demo:main:a1"), tabStrip = app.get("agent-session-list"), count = tabStrip.getChildren().length;
    const prompt = app.get("session-prompt"); if (!(prompt instanceof PromptInput)) throw new Error("Missing input");
    app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressKey("HOME"); await app.render();
    app.mockInput.pressKey("e", { ctrl: true }); prompt.value = "/clear"; app.mockInput.pressEnter(); await app.render();

    expect(app.selection.sessionId).toBe("a1"); expect(tabStrip.getChildren()).toHaveLength(count); expect(app.get("session:demo:main:a1")).toBe(tab);
    expect(app.status()).toBe(""); expect(app.get("agent-run-loading").visible).toBe(false); expect(app.captureCharFrame()).not.toContain("PROGRESS-99");
    expect(prompt.value).toBe(""); expect(app.renderer.currentFocusedRenderable).toBe(prompt);
    expect(app.view.workViewPreferences.agentViews?.a1).toMatchObject({ mode: "sections", selectedId: null, follow: true });
    expect(app.view.promptDrafts).toMatchObject({ a2: "second session draft", b1: "feature draft" });
  } finally { await app.close(); }
});

test("대화 교체 snapshot과 늦은 수락이 새 초안을 지우거나 작업 요청으로 오인하지 않는다", async () => {
  const accepted = Promise.withResolvers<Result<void, ExpectedError>>();
  const app = await mount({ onPrompt: () => accepted.promise });
  try {
    app.states.a1 = { ...app.states.a1!, conversationId: "previous" }; await app.update();
    const prompt = app.get("session-prompt"); if (!(prompt instanceof PromptInput)) throw new Error("Missing input");
    app.mockInput.pressKey("e", { ctrl: true }); prompt.value = "/clear"; app.mockInput.pressEnter(); await app.render();
    app.states.a1 = { conversationId: "fresh", status: null, output: "", error: null, sections: [] }; await app.update();
    prompt.value = "next conversation draft"; accepted.resolve(ok(undefined)); await app.render();

    expect(prompt.value).toBe("next conversation draft"); expect(app.view.promptDrafts.a1).toBe("next conversation draft");
    expect(app.selection.sessionId).toBe("a1"); expect(app.status()).toBe("");
  } finally { accepted.resolve(ok(undefined)); await app.close(); }
});
