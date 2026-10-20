import { expect, test } from "bun:test";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { ExecutionState } from "../../agents/session-registry.ts";
import type { TranscriptSection } from "../../agents/transcript.ts";
import type { WorkViewPreferences } from "../../runtime/protocol.ts";
import { ok } from "../../result.ts";

const summary = (): TranscriptSection => ({ id: "compaction", kind: "notice", title: "Context compacted", status: "complete",
  text: Array.from({ length: 80 }, (_, i) => `COMPACTION_SUMMARY_${i}`).join("\n") });
const history = (): TranscriptSection[] => [
  { id: "request", kind: "user", title: "You", text: "Previous delivered request", status: "complete" },
  { id: "answer", kind: "assistant", title: "Agent", text: "Previous response", status: "complete" },
];
async function mount(initial: ExecutionState = { status: "complete", output: "", error: null, sections: [...history(), summary()] }, preferences?: WorkViewPreferences) {
  const clock = new ManualClock(), app = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true, clock });
  const selection = new WorkspaceSelection(demoWorkspace());
  let current = initial;
  const copied: string[] = [], sent: string[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession: () => {}, onCloseSession: () => {}, onPrompt: (_id, text) => { sent.push(text); return ok(undefined); },
    getSessionDetails: () => current, initialDrafts: { a1: "retained draft" },
    ...(preferences ? { initialWorkViews: preferences } : {}),
    onCopyTranscript: async (text) => { copied.push(text); return ok("Copied to clipboard"); },
  });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  await render();
  const get = (id: string) => { const node = app.renderer.root.findDescendantById(id); if (!node) throw new Error(`Missing ${id}`); return node; };
  return { ...app, clock, selection, view, copied, sent, render, get,
    state: () => view.workViewPreferences.agentViews?.[selection.sessionId ?? ""],
    async update(state: ExecutionState) { current = state; selection.replaceSnapshot(selection.snapshot); await render(); },
    async transcript() { app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressKey("HOME"); app.mockInput.pressKey("j"); app.mockInput.pressKey("j"); await render(); },
    async clickSummary() {
      const lines = app.captureCharFrame().split("\n"), y = lines.findIndex((line) => line.includes("[Context compacted]"));
      if (y < 0) throw new Error(`Missing compaction heading\n${app.captureCharFrame()}`);
      await app.mockMouse.click(lines[y]!.indexOf("[Context compacted]"), y); await render();
    },
    async close() { view.dispose(); await app.dispose(); },
  };
}

test("압축 중 스피너와 전용 상태를 보이고 완료 시 접힌 요약만 남기며 초안·포커스를 보존한다", async () => {
  // 기존 요청이 남아 있는 같은 대화에서 수동 압축이 진행되는 상태를 준비한다.
  const compacting = { status: "working" as const, activity: "compacting" as const, output: "", error: null, sections: history() };
  const app = await mount(compacting);
  try {
    const status = app.get("agent-run-status-text"), prompt = app.get("session-prompt");
    app.mockInput.pressKey("e", { ctrl: true }); await app.render();
    const label = () => app.captureCharFrame().split("\n")[status.y]!.slice(status.x, status.x + status.width).trimEnd();
    expect(label()).toBe("Compacting context (0s · esc to interrupt)"); expect(app.get("agent-run-loading").visible).toBe(true);
    const first = app.captureCharFrame(); app.clock.advance(80); await app.render();
    expect(app.captureCharFrame()).not.toBe(first); expect(label()).not.toContain("Previous delivered request");

    // 압축이 끝나면 상태 문구를 지우고 긴 요약의 본문은 기본적으로 감춘다.
    await app.update({ status: "complete", output: "", error: null, sections: [...history(), summary()] });
    app.clock.advance(420); await app.render();

    expect(status.visible).toBe(false); expect(app.get("agent-run-loading").visible).toBe(false);
    expect(app.captureCharFrame()).toContain("[Context compacted] (Ctrl+o to expand)");
    expect(app.captureCharFrame()).not.toContain("COMPACTION_SUMMARY_");
    expect(app.view.promptDrafts.a1).toBe("retained draft"); expect(app.renderer.currentFocusedRenderable?.id).toBe(prompt.id);
    expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("접힌 압축 요약은 키보드로 펼치고 접으며 접힌 상태에서도 원문 전체를 복사한다", async () => {
  // 요약 전체가 viewport보다 길어도 처음에는 한 섹션 헤더만 보여야 한다.
  const app = await mount();
  try {
    await app.transcript();
    expect(app.captureCharFrame()).not.toContain("COMPACTION_SUMMARY_");

    // 기존 transcript 접기 단축키를 그대로 사용해 본문을 펼치고 다시 접는다.
    app.mockInput.pressKey("o", { ctrl: true }); await app.render();
    expect(app.captureCharFrame()).toContain("COMPACTION_SUMMARY_0"); expect(app.state()?.folded.compaction).toBe(false);
    app.mockInput.pressKey("z"); app.mockInput.pressKey("a"); await app.render();
    app.mockInput.pressKey("y"); await app.render();

    expect(app.captureCharFrame()).not.toContain("COMPACTION_SUMMARY_"); expect(app.state()?.folded.compaction).toBe(true);
    expect(app.copied).toEqual([summary().text]); expect(app.view.promptDrafts.a1).toBe("retained draft"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("압축 요약 헤더를 클릭하면 펼침·접힘을 전환하고 일반 안내 섹션은 기본 펼침을 유지한다", async () => {
  const app = await mount();
  try {
    // 마우스로 압축 헤더를 눌러도 입력을 전송하거나 본문을 수정하지 않는다.
    await app.clickSummary();
    expect(app.captureCharFrame()).toContain("COMPACTION_SUMMARY_0"); expect(app.state()?.folded.compaction).toBe(false);
    await app.clickSummary();

    expect(app.captureCharFrame()).not.toContain("COMPACTION_SUMMARY_"); expect(app.state()?.folded.compaction).toBe(true);
    await app.update({ status: "complete", output: "", error: null, sections: [...history(), summary(),
      { id: "notice", kind: "notice", title: "Compaction failed", text: "KEEP_FAILURE_VISIBLE", status: "error" },
    ] });
    expect(app.captureCharFrame()).toContain("KEEP_FAILURE_VISIBLE"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("사용자가 펼친 압축 요약은 스냅샷 갱신과 새 UI 복원 뒤에도 펼침 상태를 유지한다", async () => {
  let preferences: WorkViewPreferences | undefined;
  const app = await mount();
  try {
    // 기본 접힘보다 사용자가 명시적으로 저장한 펼침 설정이 우선한다.
    await app.transcript(); app.mockInput.pressKey("o", { ctrl: true }); await app.render();
    await app.update({ status: "complete", output: "", error: null, sections: [...history(), summary()] });
    expect(app.state()?.folded.compaction).toBe(false);
    preferences = structuredClone(app.view.workViewPreferences);
  } finally { await app.close(); }
  const next = await mount(undefined, preferences);
  try {
    // 새 renderable에서도 접힘 설정은 모델 대화가 아닌 UI 환경설정으로 복원한다.
    await next.transcript();
    expect(next.state()?.folded.compaction).toBe(false); expect(next.captureCharFrame()).toContain("COMPACTION_SUMMARY_0");
    expect(next.sent).toEqual([]);
  } finally { await next.close(); }
});
