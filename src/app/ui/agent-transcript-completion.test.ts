import { expect, test } from "bun:test";
import { CodeRenderable, TextRenderable, type Renderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { TranscriptSection } from "../../agents/transcript.ts";
import type { RunCompletion } from "../../agents/run-completion.ts";
import { uiTheme } from "../../ui/theme.ts";
import { summarizeRequest } from "../../agents/request-summary.ts";
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

test.each([["error", "Failed after 1m 30s"], ["cancelled", "Cancelled (1m 30s)"], ["unfinished", "Stopped after 1m 30s"]] as const)("종료 결과를 완료 문구와 구분한다: %s", async (outcome, text) => {
  const app = await mount([answer({ ...completion, outcome })]);
  try {
    expect(app.captureCharFrame()).toContain(text); expect(app.captureCharFrame()).not.toContain("Worked for");
    if (outcome === "cancelled") {
      const scroll = app.renderer.root.findDescendantById("session-transcript")!;
      expect(app.captureCharFrame().split("\n").slice(scroll.y, scroll.y + scroll.height).join("\n")).not.toContain("Cancelled");
    }
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

test("완료 줄의 요청은 해당 답변에만 연결되고 이후 요청이나 초안으로 바뀌지 않는다", async () => {
  const first: TranscriptSection = { id: "q1", kind: "user", title: "You", text: "Review tab icons", status: "complete" };
  const second: TranscriptSection = { ...first, id: "q2", text: "Adjust tab padding" };
  const app = await mount([first, answer(completion)]);
  try {
    const footers = () => descendants(app.renderer.root).filter((node): node is TextRenderable => node instanceof TextRenderable && node.plainText.startsWith("Worked for")).map((node) => node.plainText);
    // Completion captions quote only the request, matching the running-request banner.
    expect(footers()[0]).toBe("Worked for 1m 30s • Sep 19 at 10:55 AM\n“Review tab icons”");
    const rows = app.captureCharFrame().split("\n"), y = rows.findIndex((line) => line.includes("Worked for"));
    expect(rows[y]).not.toContain("Review tab icons"); expect(rows[y + 1]).toContain("“Review tab icons”");
    await app.update([first, answer(completion), second, { ...answer(), id: "answer-2", text: "NEXT_ANSWER", status: "streaming" }]);
    expect(footers()).toHaveLength(1); expect(footers()[0]).toContain("Review tab icons"); expect(footers()[0]).not.toContain(second.text);
    await app.update([first, answer(completion), second, { ...answer(completion), id: "answer-2", text: "NEXT_ANSWER" }]);
    expect(footers()).toHaveLength(2); expect(footers()[0]).toContain(first.text); expect(footers()[1]).toContain(second.text);
    expect(app.view.promptDrafts.a1).toBe("Keep this draft"); expect(app.runs).toEqual([]);
  } finally { await app.close(); }
});

test("새 사용자 요청 없이 시작된 다음 실행은 이전 완료 요청을 재사용하지 않는다", async () => {
  const request: TranscriptSection = { id: "original", kind: "user", title: "You", text: "Original task", status: "complete" };
  const app = await mount([request, answer(completion), { ...answer(completion), id: "background", text: "BACKGROUND_RESULT" }]);
  try {
    const footers = descendants(app.renderer.root).filter((node): node is TextRenderable => node instanceof TextRenderable && node.plainText.startsWith("Worked for")).map((node) => node.plainText);
    expect(footers).toHaveLength(2); expect(footers[0]).toContain("\n“Original task”");
    expect(footers[1]).toContain("Worked for 1m 30s • Sep 19 at 10:55 AM"); expect(footers[1]).not.toContain("Original task");
  } finally { await app.close(); }
});

test("숨긴 취소 경계 뒤의 독립 실행은 취소된 요청 문구를 완료 푸터에 재사용하지 않는다", async () => {
  const request: TranscriptSection = { id: "cancelled-request", kind: "user", title: "You", text: "Cancelled request", status: "complete" };
  const marker: TranscriptSection = { id: "cancelled-boundary", kind: "notice", title: "Cancelled", text: "", status: "cancelled", completion: { ...completion, outcome: "cancelled" } };
  const app = await mount([request, marker, answer(completion)]);
  try {
    // The invisible boundary still ends request ownership for a subsequent background run.
    const footer = descendants(app.renderer.root).find((node): node is TextRenderable => node instanceof TextRenderable && node.plainText.startsWith("Worked for"))!;

    expect(footer.plainText).toContain("Worked for 1m 30s"); expect(footer.plainText).not.toContain("Cancelled request");
    expect(app.captureCharFrame()).not.toContain("[Cancelled]");
  } finally { await app.close(); }
});

test("완료 요청의 말줄임은 resize에 맞춰 갱신하고 시간·원문·초안은 보존한다", async () => {
  const text = "Review 👩‍💻 한글 e\u0301 tab layout and keep all original details. ".repeat(12);
  const request: TranscriptSection = { id: "long-request", kind: "user", title: "You", text, status: "complete" };
  const app = await mount([request, answer(completion)]);
  try {
    const footer = () => descendants(app.renderer.root).find((node): node is TextRenderable => node instanceof TextRenderable && node.plainText.startsWith("Worked for"))!;
    app.resize(240, 40); await app.render(); const wide = footer().plainText;
    expect(wide.split("\n")[1]?.endsWith("…")).toBe(true);
    app.resize(120, 40); await app.render(); const narrow = footer().plainText;
    expect(narrow.split("\n")[0]).toBe("Worked for 1m 30s • Sep 19 at 10:55 AM");
    expect(narrow.split("\n")[1]).toStartWith("“Review"); expect(narrow.split("\n")[1]?.endsWith("…")).toBe(true);
    expect(Bun.stringWidth(narrow.split("\n")[1]!)).toBeLessThanOrEqual(footer().width); expect(narrow.length).toBeLessThan(wide.length);
    expect(footer().height).toBe(2); expect(narrow).not.toContain("\uFFFD");
    app.resize(240, 40); await app.render(); expect(footer().plainText).toBe(wide);
    expect(request.text).toBe(text); expect(app.view.promptDrafts.a1).toBe("Keep this draft"); expect(app.runs).toEqual([]);
  } finally { await app.close(); }
});

test("스킬 완료 줄에는 호출 이름만 표시하고 내부 지침은 요청으로 복제하지 않는다", async () => {
  const skill: TranscriptSection = { id: "skill", kind: "notice", title: "Skill", text: "PRIVATE_INTERNAL_SKILL_INSTRUCTIONS", skillName: "review-code", status: "complete" };
  const app = await mount([skill, answer(completion)]);
  try {
    const footer = descendants(app.renderer.root).find((node): node is TextRenderable => node instanceof TextRenderable && node.plainText.startsWith("Worked for"))!.plainText;
    expect(footer).toContain("\n“/skill:review-code”"); expect(footer).not.toContain("PRIVATE_INTERNAL_SKILL_INSTRUCTIONS");
  } finally { await app.close(); }
});

test("완료 요청의 아랫줄은 이미지·파일 배지를 보존하고 긴 본문만 줄인다", async () => {
  const text = 'Inspect the screenshots and update the file layout. '.repeat(20) + '[Image #1] [Image #2] @"/tmp/a.ts" @"/tmp/b.ts" @"/tmp/c.ts"';
  const user: TranscriptSection = { id: "attachments", kind: "user", title: "You", text, request: summarizeRequest(text, 2), status: "complete" };
  const app = await mount([user, answer(completion)]);
  try {
    app.resize(120, 40); await app.render();
    const footer = descendants(app.renderer.root).find((node): node is TextRenderable => node instanceof TextRenderable && node.plainText.startsWith("Worked for"))!;
    const [metadata, caption] = footer.plainText.split("\n");
    expect(metadata).toBe("Worked for 1m 30s • Sep 19 at 10:55 AM");
    expect(caption).toStartWith("“Inspect");
    expect(caption).toContain("…  [2 images] [3 files]"); expect(caption).not.toContain("/tmp/");
    expect(Bun.stringWidth(caption!)).toBeLessThanOrEqual(footer.width); expect(footer.height).toBe(2);
    expect(user.text).toBe(text); expect(app.view.promptDrafts.a1).toBe("Keep this draft");

    await app.update([{ ...user, text: "[Image: image/png]", request: { text: "", images: 1, files: 0 } }, answer(completion)]);
    expect(footer.plainText.split("\n")[1]).toBe("[1 image]");
  } finally { await app.close(); }
});

test("취소 푸터를 숨겨도 완료 정보의 저장 경고는 숨기지 않는다", async () => {
  // An accepted cancellation with a persistence warning is neither a failed request nor silent success.
  const app = await mount([answer({ ...completion, outcome: "cancelled", warning: "[STORAGE_FAILED] Cancellation timing could not be saved." })]);
  try {
    const frame = app.captureCharFrame();
    expect(frame).toContain("Cancelled (1m 30s)"); expect(frame).toContain("Cancellation timing could not be saved.");
    expect(frame).not.toContain("Cancelled after"); expect(frame).not.toContain("Failed after");
  } finally { await app.close(); }
});

test("완료 뒤 부가 저장 경고는 요청 실패나 새 본문으로 숨기지 않고 별도로 설명한다", async () => {
  const app = await mount([answer({ ...completion, warning: "[STORAGE_FAILED] Run finished, but saving its timing could not be confirmed." })]);
  try {
    expect(app.captureCharFrame()).toContain("Worked for 1m 30s"); expect(app.captureCharFrame()).toContain("STORAGE_FAILED");
    expect(app.captureCharFrame()).not.toContain("Failed after");
  } finally { await app.close(); }
});
