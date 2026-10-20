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
    expect(app.text()).toBe("Working (0s · esc to interrupt) “Implement the search carefully.”"); expect(app.spinner().visible).toBe(true);

    app.status.update("a", { ...state, sections: [...state.sections!, settled("complete")] }, true); await app.render();
    expect(app.text()).toBe("Working (0s · esc to interrupt) “Implement the search carefully.”");
    expect(latest.text).toBe("  Implement\nthe search\t carefully.  ");
  } finally { await app.close(); }
});

test("압축 중에는 이전 요청 대신 전용 문구와 움직이는 스피너를 표시하고 작업 재개 시 요청을 복원한다", async () => {
  // 자동 압축은 기존 실행을 끝내거나 이전 요청을 새 요청으로 만들지 않는다.
  const app = await mount(), state = working([user("Previous delivered request")]);
  try {
    const compacting = { ...state, activity: "compacting" as const };
    app.status.update("a", compacting, true); await app.render();
    const first = app.captureCharFrame();

    // 압축이 진행되는 동안에도 공통 스피너의 프레임은 계속 바뀐다.
    app.clock.advance(80); app.status.update("a", compacting, true); await app.render();
    expect(app.text()).toBe("Compacting context (0s · esc to interrupt)"); expect(app.spinner().visible).toBe(true);
    expect(app.captureCharFrame()).not.toBe(first); expect(app.text()).not.toContain("Previous delivered request");

    // 압축 이후 일반 실행으로 돌아오면 같은 요청과 스피너를 이어서 표시한다.
    app.status.update("a", state, true); await app.render();
    expect(app.text()).toBe("Working (0s · esc to interrupt) “Previous delivered request”"); expect(app.spinner().visible).toBe(true);
  } finally { await app.close(); }
});

test("빠른 압축 완료는 이전 요청을 다시 표시하지 않고 스피너 최소 시간만 마무리한다", async () => {
  // 압축 결과는 즉시 보여 주되 스피너가 깜빡이며 사라지지는 않아야 한다.
  const app = await mount(), state = { ...working([user("Previous request")]), activity: "compacting" as const };
  try {
    app.status.update("a", state, true); await app.render(); app.clock.advance(100);

    app.status.update("a", { ...state, status: "complete" }, true); await app.render();

    expect(app.text()).toBe(""); expect(app.spinner().visible).toBe(true);
    app.clock.advance(400); await app.render();
    expect(app.spinner().visible).toBe(false); expect(app.status.hasContent).toBe(false);
  } finally { await app.close(); }
});

test("Working 요청도 한 줄 말줄임하며 실제 첨부 배지 공간은 먼저 확보한다", async () => {
  const app = await mount(50);
  try {
    const request = { ...user("Original full prompt"), request: { text: "A long original prompt ".repeat(20), images: 2, files: 3 } };
    app.status.update("a", working([request]), true); await app.render();
    expect(app.text()).toStartWith("Working (0s)"); expect(app.text()).toContain("…  [2 images] [3 files]");
    expect(Bun.stringWidth(app.text())).toBeLessThanOrEqual(48);
    expect(app.captureCharFrame().split("\n")[1]?.trim()).toBe(""); expect(request.text).toBe("Original full prompt");
  } finally { await app.close(); }
});

test("이미지 전용 요청의 첨부 섹션은 파일명을 작업 요청으로 오인하지 않고 이미지 개수만 표시한다", async () => {
  const app = await mount();
  try {
    const attachment: TranscriptSection = { id: "attachment", kind: "notice", title: "read", text: "clipboard-1.png", status: "complete",
      image: { id: "a".repeat(64), name: "clipboard-1.png", mimeType: "image/png", byteLength: 80 }, request: { text: "", images: 1, files: 0 } };
    app.status.update("a", working([attachment]), true); await app.render();

    expect(app.text()).toStartWith("Working"); expect(app.text()).toContain("[1 image]");
    expect(app.text()).not.toContain("clipboard-1.png"); expect(app.text()).not.toContain("“");
  } finally { await app.close(); }
});

test("반복 스냅샷은 최소 시간을 다시 시작하지 않고 정상 완료 문구 없이 스피너만 마무리한다", async () => {
  const app = await mount();
  try {
    const state = working([user("Short job")]); app.status.update("a", state, true); await app.render();
    const first = app.captureCharFrame(); app.clock.advance(80); await app.render(); expect(app.captureCharFrame()).not.toBe(first);
    app.clock.advance(400); app.status.update("a", state, true);
    app.status.update("a", { ...state, status: "complete" }, true); await app.render();

    // The final answer can show its completion footer while the shared spinner finishes its minimum interval.
    expect(app.text()).toBe(""); expect(app.spinner().visible).toBe(true); expect(app.status.hasContent).toBe(true);
    app.clock.advance(20); await app.render(); expect(app.spinner().visible).toBe(false); expect(app.status.hasContent).toBe(false);
    app.clock.advance(1000); await app.render(); expect(app.text()).toBe("");
  } finally { await app.close(); }
});

test.each(["cancelled", "unfinished", "error"] as const)("스피너 없는 %s 상태는 빈 칸 없이 본문 시작선에 맞춘다", async (outcome) => {
  // Static outcomes have no loading indicator whose width needs reserving.
  const app = await mount();
  try {
    app.status.update("a", { status: null, output: "", error: null, sections: [user("Task"), settled(outcome)] }, true);
    await app.render();

    expect(app.spinner().visible).toBe(false);
    expect(app.node().x).toBe(app.status.root.x);
    expect(app.node().width).toBe(app.status.root.width);
    if (outcome === "cancelled") expect(app.text()).toBe("Cancelled (1s) “Task”");
  } finally { await app.close(); }
});

test.each([false, true])("취소 문구는 테마 밝기 %s에서도 warning 색이고 시간은 회색·요청은 본문색이다", async (light) => {
  const app = await mount(), theme = uiTheme(app.renderer);
  try {
    // Host palette roles, not hardcoded product colors, define the cancellation presentation.
    theme.configure({ palette: [], defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
      cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null, highlightForeground: null, highlightBackground: null });

    app.status.update("a", { status: null, output: "", error: null, sections: [user("Task"), settled("cancelled")] }, true); await app.render();

    const spans = app.captureSpans().lines[app.node().y]!.spans;
    expect(spans.find(span => span.text.includes("Cancelled"))!.fg.toInts()).toEqual(theme.colors.warning.toInts());
    expect(spans.find(span => span.text.includes("(1s)"))!.fg.toInts()).toEqual(theme.colors.muted.toInts());
    expect(spans.find(span => span.text.includes("Task"))!.fg.toInts()).toEqual(theme.colors.text.toInts());
    expect(app.node().x).toBe(app.status.root.x);
  } finally { await app.close(); }
});

test("빠른 취소의 스피너 꼬리가 끝나는 즉시 자리와 간격도 사라지고 취소 시간은 고정된다", async () => {
  const app = await mount();
  try {
    // The shared spinner keeps its minimum interval, independently of the settled result.
    app.status.update("a", working([user("Task")]), true); await app.render();
    expect(app.node().x).toBe(app.status.root.x + 2);
    app.clock.advance(100);
    app.status.update("a", { status: null, output: "", error: null, sections: [user("Task"), settled("cancelled")] }, true); await app.render();
    expect(app.spinner().visible).toBe(true); expect(app.text()).toBe("Cancelled (1s) “Task”");

    app.clock.advance(400); await app.render();

    expect(app.spinner().visible).toBe(false); expect(app.node().x).toBe(app.status.root.x);
    app.clock.advance(5000); await app.render(); expect(app.text()).toBe("Cancelled (1s) “Task”");
  } finally { await app.close(); }
});

test("취소·중단·실패는 완료와 구분하고 이전 요청의 완료 정보는 새 요청에 재사용하지 않는다", async () => {
  const app = await mount();
  try {
    for (const [outcome, label] of [["cancelled", "Cancelled (1s)"], ["unfinished", "Stopped"], ["error", "Failed"], ["complete", ""]] as const) {
      app.status.update("a", { status: null, output: "", error: null, sections: [user("Task"), settled(outcome)] }, true); await app.render();
      expect(app.text()).toBe(label ? `${label} “Task”` : ""); expect(app.spinner().visible).toBe(false);
    }
    app.status.update("a", { status: null, output: "", error: null, sections: [user("Old"), settled("cancelled"), user("New", "new")] }, true); await app.render();
    expect(app.text()).toBe("");
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
    app.resize(70, 4); await app.render(); expect(app.text()).toBe(`Working (0s · esc to interrupt) “${request.text}”`);
  } finally { await app.close(); }
});

test("스킬 호출은 내부 지침을 노출하지 않고 요청 없는 실행도 이름을 추측하지 않는다", async () => {
  const app = await mount();
  try {
    app.status.update("a", working([{ id: "skill", kind: "notice", title: "write-good-code", skillName: "write-good-code", text: "PRIVATE INTERNAL INSTRUCTIONS", status: "complete" }]), true); await app.render();
    expect(app.text()).toBe("Working (0s · esc to interrupt) “/skill:write-good-code”"); expect(app.captureCharFrame()).not.toContain("PRIVATE INTERNAL INSTRUCTIONS");
    app.status.update("a", { status: "working", output: "Legacy output", error: null }, true); await app.render(); expect(app.text()).toBe("Working (0s · esc to interrupt)");
    app.status.update("a", { status: null, output: "Legacy output", error: null }, true); await app.render(); expect(app.text()).toBe("");
  } finally { await app.close(); }
});

test.each([false, true])("종료 상태 없는 대화는 기록 형식이 %s여도 Ready나 빈 상태 행을 남기지 않는다", async (structured) => {
  // Retained transcript content is not evidence of active work or a terminal outcome.
  const app = await mount();
  try {
    const state: ExecutionState = { status: null, output: "Retained conversation", error: null,
      ...(structured ? { sections: [user("Previous request")] } : {}) };

    app.status.update("a", state, true); await app.render();

    expect(app.text()).toBe(""); expect(app.status.hasContent).toBe(false); expect(app.spinner().visible).toBe(false);
    expect(app.captureCharFrame()).not.toContain("Ready"); expect(state.output).toBe("Retained conversation");
  } finally { await app.close(); }
});

test("실행 시간은 런타임 관측값에서 이어지고 반복 스냅샷·숨김·재연결에도 초기화되지 않는다", async () => {
  // A reattached UI has already missed twelve seconds of this runtime-owned run.
  const app = await mount();
  const state = { ...working([user("Long job")]), runTiming: { startedAt: 1000, elapsedMs: 12000 } };
  try {
    app.status.update("a", state, true); await app.render();
    expect(app.text()).toContain("Working (12s · esc to interrupt)");

    // Equal snapshots must not restart the locally interpolated timer.
    app.clock.advance(2000); app.status.update("a", state, true); await app.render();
    expect(app.text()).toContain("Working (14s · esc to interrupt)");
    app.status.update("a", state, false); app.clock.advance(2000);
    app.status.update("a", { ...state, runTiming: { startedAt: 1000, elapsedMs: 16000 } }, true); await app.render();

    expect(app.text()).toContain("Working (16s · esc to interrupt)");
    app.status.update("a", { ...state, status: "complete" }, true); app.clock.advance(1000); await app.render();
    expect(app.text()).toBe("");
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

test.each([70, 28])("경과 시간은 화면 너비 %i에서도 회색으로 표시하고 Working·요청의 색은 유지한다", async (width) => {
  // Both full interrupt hints and compact labels keep elapsed time visually secondary.
  const app = await mount(width), theme = uiTheme(app.renderer);
  try {
    app.status.update("a", working([user("Task")]), true);
    for (const [advance, elapsed] of [[36000, "36s"], [60000, "1m 36s"]] as const) {
      app.clock.advance(advance);
      // Time ticks and terminal palette changes must not restore the timer's accent color.
      for (const light of [false, true]) {
        const palette: TerminalColors = { palette: [], defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
          cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null, highlightForeground: null, highlightBackground: null };
        theme.configure(palette); await app.render();

        const spans = app.captureSpans().lines[app.node().y]!.spans;
        expect(app.text()).toContain(`Working (${elapsed}`);
        expect(spans.find((span) => span.text.includes(elapsed))!.fg.toInts()).toEqual(theme.colors.muted.toInts());
        expect(spans.find((span) => span.text.includes("Working"))!.fg.toInts()).toEqual(theme.colors.accent.toInts());
        expect(spans.find((span) => span.text.includes("Task"))!.fg.toInts()).toEqual(theme.colors.text.toInts());
      }
    }
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
