import { expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { ExecutionState } from "../../agents/session-registry.ts";
import { summarizeRequest } from "../../agents/request-summary.ts";
import { PromptInput } from "../../agents/ui/prompt-input.ts";
import { ok } from "../../result.ts";

async function mount(width = 150) {
  const clock = new ManualClock(), app = await createTestRenderer({ width, height: 30, kittyKeyboard: true, exitOnCtrlC: false, clock });
  const selection = new WorkspaceSelection(demoWorkspace()), interrupted: string[] = [], sent: string[] = [];
  let state: ExecutionState = { conversationId: "conversation", status: "working", output: "", error: null,
    runTiming: { startedAt: 1000, elapsedMs: 12000 },
    sections: [{ id: "request", kind: "user", title: "You", text: "Current request", status: "complete" }],
    pendingMessages: [summarizeRequest("Add tests", 0), summarizeRequest("Do not edit README", 0)] };
  const view = new Workbench(app.renderer, selection, { onNewSession: () => {}, onCloseSession: () => {},
    onPrompt: (_id, text) => { sent.push(text); return ok(undefined); },
    onInterrupt: async (id) => { interrupted.push(id); return ok(undefined); }, getSessionDetails: () => state,
    onComplete: async () => ok({ items: [{ kind: "command", value: "compact", description: "Compact context" }], truncated: false }),
  });
  const get = (id: string) => app.renderer.root.findDescendantById(id)!;
  const prompt = get("session-prompt") as PromptInput;
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  await render(); prompt.focus(); await render();
  return { ...app, clock, view, selection, interrupted, sent, prompt, get, render,
    update(next: ExecutionState) { state = next; selection.replaceSnapshot(selection.snapshot); },
    async close() { view.dispose(); await app.dispose(); } };
}

test("작업 상태 아래에 대기 안내·단축키를 한 줄로 묶고 들여쓴 메시지와 입력창을 구분한다", async () => {
  // 런타임이 제공한 대기 목록과 전송하지 않은 초안을 같은 화면에서 구분한다.
  const app = await mount(190);
  try {
    await app.mockInput.typeText("Unsent draft"); await app.render();

    // 안내는 한 줄이고, 각 메시지는 그 바로 아래에 연결되며 입력창 앞에는 빈 줄이 남는다.
    const frame = app.captureCharFrame(), lines = frame.split("\n");
    const pending = app.get("agent-pending-messages"), status = app.get("agent-run-status"), composer = app.get("agent-composer");
    const row = (y: number) => lines[y]!.slice(pending.x, pending.x + pending.width).trimEnd();
    expect(frame).toContain("Working (12s · esc to interrupt) “Current request”");
    expect(row(pending.y)).toBe("• Messages will be sent after the current response and tools finish (press esc to interrupt and send immediately)");
    expect(row(pending.y + 1)).toBe("  ↳ Add tests"); expect(row(pending.y + 2)).toBe("  ↳ Do not edit README");
    expect(row(pending.y + 3)).toBe(""); expect(frame).not.toContain("Queued");
    expect(pending.y).toBe(status.y + status.height + 1);
    expect(composer.y).toBe(pending.y + 4);
    const hints = app.captureSpans().lines.flatMap((line) => line.spans).filter((span) => span.text === "esc");
    expect(hints).toHaveLength(2); for (const span of hints) expect(span.attributes & TextAttributes.BOLD).not.toBe(0);
    expect(app.sent).toEqual([]);

    // Esc는 선택한 실행만 중단하고 초안이나 런타임 소유의 대기 목록을 임의로 비우지 않는다.
    app.mockInput.pressEscape(); await app.render();
    expect(app.interrupted).toEqual(["a1"]); expect(app.prompt.value).toBe("Unsent draft"); expect(app.sent).toEqual([]);
    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
  } finally { await app.close(); }
});

test("Ctrl+C는 첨부 초안만 비우고 실행과 대기 입력에는 영향을 주지 않는다", async () => {
  // An attached file is part of the draft and must not survive as hidden metadata.
  const app = await mount();
  try {
    await app.mockInput.typeText("draft "); app.prompt.attachFile("./package.json"); await app.render();

    app.mockInput.pressCtrlC(); await app.render();

    expect(app.prompt.value).toBe(""); expect(app.prompt.draft.tokens).toEqual([]);
    expect(app.view.promptDrafts.a1).toBeUndefined(); expect(app.view.promptInputDrafts.a1).toBeUndefined();
    expect(app.captureCharFrame()).toContain("Add tests"); expect(app.interrupted).toEqual([]); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("자동완성의 첫 esc는 목록만 닫고 다음 esc가 실행을 중단한다", async () => {
  // Completion dismissal has priority over agent interruption.
  const app = await mount();
  try {
    await app.mockInput.typeText("/"); await app.render();
    expect(app.get("prompt-completions").visible).toBe(true);

    app.mockInput.pressEscape(); await app.render();
    expect(app.interrupted).toEqual([]); expect(app.prompt.value).toBe("/");
    app.mockInput.pressEscape(); await app.render();

    expect(app.interrupted).toEqual(["a1"]); expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    expect(app.prompt.value).toBe("/");
  } finally { await app.close(); }
});

test("작은 화면의 긴 대기 목록도 입력창과 하단 상태·푸터를 침범하지 않는다", async () => {
  const app = await mount();
  try {
    // Queue display is bounded, while every pending item remains runtime-owned.
    app.update({ status: "working", output: "", error: null, pendingMessages: Array.from({ length: 20 }, (_, index) => summarizeRequest(`Pending ${index}`, 0)) });
    app.resize(70, 11); await app.render();

    const composer = app.get("agent-composer"), pending = app.get("agent-pending-messages"), telemetry = app.get("session-status"), footer = app.get("app-footer");
    if (pending.visible) expect(pending.y + pending.height).toBeLessThanOrEqual(composer.y);
    expect(composer.y + composer.height).toBeLessThanOrEqual(telemetry.y);
    expect(telemetry.y + telemetry.height).toBeLessThanOrEqual(footer.y);
    expect(app.prompt.height).toBeGreaterThan(0); expect(app.interrupted).toEqual([]);

    app.resize(150, 30); await app.render();
    expect(app.captureCharFrame()).toContain("• Messages will be sent after the current response and tools finish (press esc to interrupt and send immediately)");
    expect(app.captureCharFrame()).toContain("↳ Pending 0");
  } finally { await app.close(); }
});

test("실행 없는 esc는 사이드바로 이동하지 않고 대기 표시는 전달 후 사라진다", async () => {
  const app = await mount();
  try {
    // A runtime update proves delivery; merely pressing a key must not clear the queue locally.
    app.update({ status: "complete", output: "Done", error: null, pendingMessages: [] }); await app.render();
    expect(app.get("agent-pending-messages").visible).toBe(false);

    app.mockInput.pressEscape(); await app.render();

    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt); expect(app.interrupted).toEqual([]);
  } finally { await app.close(); }
});
