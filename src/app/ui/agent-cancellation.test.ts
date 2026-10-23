import { pressLeader } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { SessionTranscript } from "../../agents/transcript.ts";
import type { ExecutionState } from "../../agents/session-registry.ts";
import { fixtureMessage } from "../../testing/offline-runtime.ts";
import { ok } from "../../result.ts";

function cancelled(partial: boolean): ExecutionState {
  let now = 1000;
  const transcript = new SessionTranscript([], { wallTime: () => now, monotonicTime: () => now });
  const assistant = fixtureMessage("openai-responses", "fixture", "fixture");
  assistant.stopReason = "aborted"; assistant.errorMessage = "Request was aborted";
  assistant.content = partial ? [{ type: "text", text: "Partial response kept" }] : [];
  transcript.handle({ type: "agent_start" });
  transcript.handle({ type: "message_start", message: { role: "user", content: "/ne", timestamp: now } });
  transcript.handle({ type: "message_end", message: { role: "user", content: "/ne", timestamp: now } });
  transcript.handle({ type: "message_start", message: assistant }); transcript.handle({ type: "message_end", message: assistant });
  now += 1200; transcript.handle({ type: "agent_settled", aborted: true });
  return { conversationId: "cancelled-conversation", status: null, output: "", error: null, sections: transcript.sections };
}

async function mount(state: ExecutionState) {
  const app = await createTestRenderer({ width: 140, height: 30, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace()), copies: string[] = [];
  const states: Record<string, ExecutionState> = { a1: state, a2: { conversationId: "other", status: null, output: "", error: null, sections: [] } };
  const view = new Workbench(app.renderer, selection, { onNewSession: () => {}, onCloseSession: () => {},
    onPrompt: () => ok(undefined), onCopyTranscript: async (text) => { copies.push(text); return ok("Copied"); },
    initialDrafts: { a1: "Unsent draft" }, getSessionDetails: (id) => states[id] ?? null,
  });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  const get = (id: string) => app.renderer.root.findDescendantById(id)!;
  const transcript = () => { const node = get("session-transcript"); return app.captureCharFrame().split("\n").slice(node.y, node.y + node.height).join("\n"); };
  await render();
  return { ...app, view, selection, copies, states, get, render, transcript,
    update(state: ExecutionState) { states.a1 = state; selection.replaceSnapshot(selection.snapshot); },
    async close() { view.dispose(); await app.dispose(); } };
}

test.each([false, true])("Cancellation with partial %s responses shows duration only above input without error cards or transcript footers", async (partial) => {
  // Use the real SDK-event projection so the screenshot's empty aborted response is covered too.
  const app = await mount(cancelled(partial));
  try {
    const label = app.get("agent-run-status-text"), status = app.get("agent-run-status");
    const row = app.captureCharFrame().split("\n")[label.y]!.slice(label.x, label.x + label.width).trimEnd();

    expect(row).toBe("Cancelled (1s) “/ne”"); expect(label.x).toBe(status.x);
    expect(label.y).toBeLessThan(app.get("session-prompt").y);
    expect(app.captureCharFrame().match(/Cancelled \(1s\)/gu)).toHaveLength(1);
    expect(app.transcript()).not.toContain("Cancelled after");
    expect(app.captureCharFrame()).not.toContain("[Agent error]");
    expect(app.captureCharFrame()).not.toContain("Request was aborted");
    expect(app.captureCharFrame()).not.toContain("[Cancelled]");
    if (partial) expect(app.transcript()).toContain("Partial response kept");
    expect(app.view.promptDrafts.a1).toBe("Unsent draft");

    // A different conversation must not inherit this outcome; returning restores the original duration.
    app.selection.selectSession("demo:main", "a2"); await app.render();
    expect(app.captureCharFrame()).not.toContain("Cancelled");
    app.selection.selectSession("demo:main", "a1"); await app.render();
    expect(app.captureCharFrame()).toContain("Cancelled (1s)");
    expect(app.transcript()).not.toContain("Cancelled after");
    if (partial) {
      pressLeader(app, "["); app.mockInput.pressKey("END"); app.mockInput.pressKey("y"); await app.render();
      expect(app.copies).toEqual(["Partial response kept"]);
    }
  } finally { await app.close(); }
});

test("구버전 런타임의 취소 오류 카드도 숨기고 시간은 입력창 위에 유지한다", async () => {
  // Compatibility uses the structured cancellation status, never message-text classification.
  const state = cancelled(false), sections = state.sections!.map(section => section.status === "cancelled"
    ? { ...section, title: "Agent error", text: "Request was aborted", error: "Request was aborted" } : section);
  const app = await mount({ ...state, sections });
  try {
    expect(app.captureCharFrame()).toContain("Cancelled (1s)");
    expect(app.captureCharFrame()).not.toContain("Request was aborted"); expect(app.captureCharFrame()).not.toContain("[Agent error]");
  } finally { await app.close(); }
});

test("응답 없는 취소도 타이밍 저장 경고는 오류 카드 없이 보존한다", async () => {
  const state = cancelled(false), sections = state.sections!.map(section => section.completion
    ? { ...section, completion: { ...section.completion, warning: "[STORAGE_FAILED] Cancellation timing could not be saved." } } : section);
  const app = await mount({ ...state, sections });
  try {
    expect(app.captureCharFrame()).toContain("Cancelled (1s)"); expect(app.transcript()).toContain("Cancellation timing could not be saved.");
    expect(app.captureCharFrame()).not.toContain("[Cancelled]"); expect(app.captureCharFrame()).not.toContain("[Agent error]");
    expect(app.captureCharFrame()).not.toContain("Cancelled after");
  } finally { await app.close(); }
});

test("이전 취소 기록은 새 요청의 Working 상태나 새 완료 푸터와 섞이지 않는다", async () => {
  const state = cancelled(true), app = await mount(state);
  try {
    // A new delivered request starts a new status scope, not a continuation of the cancellation.
    app.update({ ...state, status: "working", runTiming: { startedAt: 10000, elapsedMs: 0 }, sections: [...state.sections!,
      { id: "next-request", kind: "user", title: "You", text: "Continue", status: "complete" },
      { id: "next-answer", kind: "assistant", title: "Agent", text: "New response", status: "streaming" },
    ] }); await app.render();

    expect(app.captureCharFrame()).toContain("Working (0s"); expect(app.captureCharFrame()).not.toContain("Cancelled");
    expect(app.transcript()).toContain("Partial response kept"); expect(app.transcript()).toContain("New response");
    expect(app.get("agent-run-loading").visible).toBe(true);
  } finally { await app.close(); }
});
