import { expect, test } from "bun:test";
import type { TerminalColors } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import type { ExecutionState } from "../session-registry.ts";
import type { TranscriptSection } from "../transcript.ts";
import { uiTheme } from "../../ui/theme.ts";
import { RunStatus } from "./run-status.ts";

const user = (text: string, id = "request"): TranscriptSection => ({ id, kind: "user", title: "You", text, status: "complete" });
const working = (sections: readonly TranscriptSection[]): ExecutionState => ({ status: "working", output: "", error: null, sections });
const settled = (outcome: "complete" | "cancelled" | "unfinished" | "error"): TranscriptSection => ({ id: "answer", kind: "assistant", title: "Agent", text: "Output", status: "complete",
  completion: { startedAt: 1800000000000, completedAt: 1800000001000, durationMs: 1000, outcome } });
async function mount(width = 70) {
  const clock = new ManualClock(), app = await createTestRenderer({ width, height: 4, kittyKeyboard: true, clock });
  const status = new RunStatus(app.renderer); app.renderer.root.add(status.root);
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  const node = () => app.renderer.root.findDescendantById("agent-run-status-text")!;
  return { ...app, clock, status, render, node, text: () => node().visible ? app.captureCharFrame().split("\n")[node().y]!.slice(node().x).trimEnd() : "",
    spinner: () => app.renderer.root.findDescendantById("agent-run-loading")!, async close() { status.dispose(); await app.dispose(); } };
}

test("실제 최근 요청만 한 줄로 표시하고 도구 출력·응답으로 요청을 대체하지 않는다", async () => {
  const app = await mount();
  try {
    const latest = user("  Implement\nthe search\t carefully.  ", "latest");
    const state = working([user("Old request", "old"), latest, { id: "tool", kind: "tool", title: "bash", text: "DO NOT USE TOOL OUTPUT", status: "running" }]);
    app.status.update("a", state, true); await app.render();
    expect(app.text()).toBe("Working on “Implement the search carefully.”"); expect(app.spinner().visible).toBe(true);

    app.status.update("a", { ...state, sections: [...state.sections!, settled("complete")] }, true); await app.render();
    expect(app.text()).toBe("Working on “Implement the search carefully.”");
    expect(latest.text).toBe("  Implement\nthe search\t carefully.  ");
  } finally { await app.close(); }
});

test("반복 스냅샷은 스피너 최소 시간을 다시 시작하지 않고 완료 결과를 즉시 표시한다", async () => {
  const app = await mount();
  try {
    const state = working([user("Short job")]); app.status.update("a", state, true); await app.render();
    const first = app.captureCharFrame(); app.clock.advance(80); await app.render(); expect(app.captureCharFrame()).not.toBe(first);
    app.clock.advance(400); app.status.update("a", state, true);
    app.status.update("a", { ...state, status: "complete" }, true); await app.render();

    // Only the shared indicator's tail may remain; the settled result is never delayed.
    expect(app.text()).toBe("Completed “Short job”"); expect(app.spinner().visible).toBe(true);
    app.clock.advance(20); await app.render(); expect(app.spinner().visible).toBe(false);
    app.clock.advance(1000); await app.render(); expect(app.text()).toBe("Completed “Short job”");
  } finally { await app.close(); }
});

test("취소·중단·실패는 완료와 구분하고 이전 요청의 완료 정보는 새 요청에 재사용하지 않는다", async () => {
  const app = await mount();
  try {
    for (const [outcome, label] of [["cancelled", "Cancelled"], ["unfinished", "Stopped"], ["error", "Failed"], ["complete", "Completed"]] as const) {
      app.status.update("a", { status: null, output: "", error: null, sections: [user("Task"), settled(outcome)] }, true); await app.render();
      expect(app.text()).toBe(`${label} “Task”`); expect(app.spinner().visible).toBe(false);
    }
    app.status.update("a", { status: null, output: "", error: null, sections: [user("Old"), settled("cancelled"), user("New", "new")] }, true); await app.render();
    expect(app.text()).toBe("Ready");
    app.status.update("a", { status: "failure", output: "", error: "AGENT_FAILED: fixture failure", sections: [user("Task"), settled("complete")] }, true); await app.render();
    expect(app.text()).toBe("Failed: AGENT_FAILED: fixture failure");
  } finally { await app.close(); }
});

test("한글·결합 문자·emoji는 grapheme 경계와 셀 너비로 자르고 원문과 다음 줄을 보존한다", async () => {
  const app = await mount(34);
  try {
    const request = user("A 👨‍👩‍👧‍👦 e\u0301 한글👩🏽‍💻 ZZZZZZZZZZZ");
    app.status.update("a", working([request]), true); await app.render();
    expect(app.text()).toContain("👨‍👩‍👧‍👦"); expect(app.text()).toContain("e\u0301"); expect(app.text().endsWith("…")).toBe(true);
    expect(app.text()).not.toContain("\uFFFD"); expect(Bun.stringWidth(app.text())).toBeLessThanOrEqual(32);
    expect(app.captureCharFrame().split("\n")[1]!.trim()).toBe("");
    app.resize(6, 4); await app.render(); expect(Bun.stringWidth(app.text())).toBeLessThanOrEqual(4);
    app.resize(70, 4); await app.render(); expect(app.text()).toBe(`Working on “${request.text}”`);
  } finally { await app.close(); }
});

test("스킬 호출은 내부 지침을 노출하지 않고 요청 없는 실행도 이름을 추측하지 않는다", async () => {
  const app = await mount();
  try {
    app.status.update("a", working([{ id: "skill", kind: "notice", title: "write-good-code", skillName: "write-good-code", text: "PRIVATE INTERNAL INSTRUCTIONS", status: "complete" }]), true); await app.render();
    expect(app.text()).toBe("Working on “/skill:write-good-code”"); expect(app.captureCharFrame()).not.toContain("PRIVATE INTERNAL INSTRUCTIONS");
    app.status.update("a", { status: "working", output: "Legacy output", error: null }, true); await app.render(); expect(app.text()).toBe("Working…");
    app.status.update("a", { status: null, output: "Legacy output", error: null }, true); await app.render(); expect(app.text()).toBe("Ready");
  } finally { await app.close(); }
});

test("화면 숨김·대화 교체·제거는 이전 스피너를 즉시 정리하고 늦은 갱신을 무시한다", async () => {
  const app = await mount();
  try {
    const state = { ...working([user("Task")]), conversationId: "old" };
    app.status.update("a", state, true); await app.render(); expect(app.spinner().visible).toBe(true);
    app.status.update("a", state, false); expect(app.spinner().visible).toBe(false);
    app.status.update("a", state, true); expect(app.spinner().visible).toBe(true);
    app.status.update("a", { status: null, error: null, output: "", sections: [], conversationId: "new" }, true); await app.render();
    expect(app.text()).toBe(""); expect(app.spinner().visible).toBe(false); expect(app.status.hasContent).toBe(false);
    app.status.update("a", state, true); app.status.root.destroyRecursively(); app.clock.advance(5000);
    expect(() => app.status.update("a", state, true)).not.toThrow();
  } finally { await app.close(); }
});

test("테마 전환은 작업 상태와 실패 색상을 반영하고 고정 제품색을 사용하지 않는다", async () => {
  const app = await mount();
  try {
    for (const light of [false, true]) {
      const palette: TerminalColors = { palette: [], defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
        cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null, highlightForeground: null, highlightBackground: null };
      const theme = uiTheme(app.renderer); theme.configure(palette);
      app.status.update("a", working([user("Theme request")]), true); await app.render();
      const spans = () => app.captureSpans().lines[0]!.spans;
      expect(spans().find((span) => span.text.includes("Working"))!.fg.toInts()).toEqual(theme.colors.accent.toInts());
      expect(spans().find((span) => span.text.includes("Theme request"))!.fg.toInts()).toEqual(theme.colors.text.toInts());
      app.status.update("a", { status: "failure", error: "Fixture failure", output: "" }, true); await app.render();
      expect(spans().find((span) => span.text.includes("Failed"))!.fg.toInts()).toEqual(theme.colors.error.toInts());
    }
  } finally { await app.close(); }
});
