import { expect, test } from "bun:test";
import { CodeRenderable, type Renderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { TranscriptSection } from "../../agents/transcript.ts";
import type { RunCompletion } from "../../agents/run-completion.ts";
import { uiTheme } from "../../ui/theme.ts";
import { ok } from "../../result.ts";

const finished = new Date(2026, 8, 19, 10, 55).getTime();
const completion: RunCompletion = { startedAt: finished - 90000, completedAt: finished, durationMs: 90000, outcome: "complete" };
const answer = (value?: RunCompletion): TranscriptSection => ({ id: "answer", kind: "assistant", title: "Agent", text: "**FINAL_ANSWER**", status: "complete", ...(value ? { completion: value } : {}) });
const descendants = (node: Renderable): Renderable[] => node.getChildren().flatMap((child) => [child, ...descendants(child)]);
async function mount(initial: TranscriptSection[]) {
  const app = await createTestRenderer({ width: 140, height: 40, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace()), copies: string[] = [], runs: string[] = [];
  let sections = initial;
  const view = new Workbench(app.renderer, selection, { onNewSession: () => {}, onCloseSession: () => {},
    onPrompt: (_id, text) => { runs.push(text); return ok(undefined); }, initialDrafts: { a1: "Keep this draft" },
    onCopyTranscript: async (text) => { copies.push(text); return ok("Copied to clipboard"); },
    getSessionDetails: () => ({ status: "complete", error: null, output: "", sections }),
  });
  const render = async () => {
    await app.renderOnce(); await app.renderOnce();
    await Promise.all(descendants(app.renderer.root).filter((node): node is CodeRenderable => node instanceof CodeRenderable).map((node) => node.highlightingDone));
    await app.renderOnce();
  };
  await render();
  return { ...app, view, copies, runs, render,
    async update(next: TranscriptSection[]) { sections = next; selection.replaceSnapshot(demoWorkspace()); await render(); },
    async close() { view.dispose(); await app.dispose(); },
  };
}

test("정착된 요청의 마지막 답변 바로 아래에만 시간·완료 시각을 중립 회색으로 표시한다", async () => {
  // 응답 종료 후에도 최종 settled 메타데이터 전에는 완료를 추측하지 않는다.
  const app = await mount([answer()]);
  try {
    expect(app.captureCharFrame()).not.toContain("Worked for");
    await app.update([answer(completion)]);
    // 별도의 선택 가능한 섹션이나 답변 원문을 만들지 않는 보조 행이다.
    const frame = app.captureCharFrame(), rows = frame.split("\n");
    expect(frame).toContain("Worked for 1m 30s • Sep 19 at 10:55 AM");
    const bodyY = rows.findIndex((line) => line.includes("FINAL_ANSWER")), footerY = rows.findIndex((line) => line.includes("Worked for"));
    expect(footerY).toBeGreaterThan(bodyY + 1);
    const span = app.captureSpans().lines[footerY]!.spans.find((span) => span.text.includes("Worked for"))!;
    const [r, g, b] = span.fg.toInts(); expect(r).toBe(g); expect(g).toBe(b);
    expect(span.bg.toInts()).toEqual(uiTheme(app.renderer).colors.panel.toInts());
    app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressKey("END"); app.mockInput.pressKey("y"); await app.render();
    expect(app.copies).toEqual(["**FINAL_ANSWER**"]); expect(app.view.promptDrafts.a1).toBe("Keep this draft"); expect(app.runs).toEqual([]);
  } finally { await app.close(); }
});

test.each([["error", "Failed after"], ["cancelled", "Cancelled after"], ["unfinished", "Stopped after"]] as const)("종료 결과를 완료 문구와 구분한다: %s", async (outcome, text) => {
  const app = await mount([answer({ ...completion, outcome })]);
  try {
    expect(app.captureCharFrame()).toContain(`${text} 1m 30s`); expect(app.captureCharFrame()).not.toContain("Worked for");
  } finally { await app.close(); }
});

test("다음 요청·스트리밍·resize에도 이전 완료 정보는 원래 답변에 한 번만 남는다", async () => {
  const app = await mount([answer(completion)]);
  try {
    await app.update([answer({ ...completion }), { id: "q2", kind: "user", title: "You", text: "Next request", status: "complete" },
      { id: "a2", kind: "assistant", title: "Agent", text: "NEW_STREAM", status: "streaming" }]);
    await app.render(); await app.render();
    const frame = app.captureCharFrame(), scroll = app.renderer.root.findDescendantById("session-transcript")!;
    const rows = frame.split("\n").slice(scroll.y, scroll.y + scroll.height);
    expect(rows.filter((line) => line.includes("Worked for"))).toHaveLength(1);
    expect(rows.findIndex((line) => line.includes("Worked for"))).toBeLessThan(rows.findIndex((line) => line.includes("Next request")));
    expect(frame).toContain("NEW_STREAM");
    app.resize(80, 26); await app.render(); expect(app.view.promptDrafts.a1).toBe("Keep this draft");
  } finally { await app.close(); }
});

test("완료 뒤 부가 저장 경고는 요청 실패나 새 본문으로 숨기지 않고 별도로 설명한다", async () => {
  const app = await mount([answer({ ...completion, warning: "[STORAGE_FAILED] Run finished, but saving its timing could not be confirmed." })]);
  try {
    expect(app.captureCharFrame()).toContain("Worked for 1m 30s"); expect(app.captureCharFrame()).toContain("STORAGE_FAILED");
    expect(app.captureCharFrame()).not.toContain("Failed after");
  } finally { await app.close(); }
});
