import { expect, test } from "bun:test";
import type { TerminalColors } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import type { ExecutionState } from "../session-registry.ts";
import { SessionTranscript, type TranscriptSection } from "../transcript.ts";
import { uiTheme } from "../../ui/theme.ts";
import { RunStatus } from "./run-status.ts";

const user = (text: string, id = "request"): TranscriptSection => ({ id, kind: "user", title: "You", text, status: "complete" });
const working = (sections: readonly TranscriptSection[]): ExecutionState => ({ status: "working", output: "", error: null, sections });
const settled = (outcome: "complete" | "cancelled" | "unfinished" | "error"): TranscriptSection => ({ id: "answer", kind: "assistant", title: "Agent", text: "Output", status: "complete",
  completion: { startedAt: 1800000000000, completedAt: 1800000001000, durationMs: 1000, outcome } });
async function mount(width = 70, interruptKey?: () => string) {
  const clock = new ManualClock(), app = await createTestRenderer({ width, height: 4, kittyKeyboard: true, clock });
  const status = new RunStatus(app.renderer, interruptKey); app.renderer.root.add(status.root);
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  const node = () => app.renderer.root.findDescendantById("agent-run-status-text")!;
  const captionNode = () => app.renderer.root.findDescendantById("agent-run-request")!;
  return { ...app, clock, status, render, node, captionNode,
    caption: () => captionNode().visible ? app.captureCharFrame().split("\n")[captionNode().y]!.slice(captionNode().x).trimEnd() : "",
    text: () => node().visible ? app.captureCharFrame().split("\n")[node().y]!.slice(node().x).trimEnd() : "",
    spinner: () => app.renderer.root.findDescendantById("agent-run-loading")!, async close() { status.dispose(); await app.dispose(); } };
}

test("Working 다음 줄에 실제 최근 요청을 표시하고 도구 출력·응답으로 요청을 대체하지 않는다", async () => {
  const app = await mount();
  try {
    const latest = user("  Implement\nthe search\t carefully.  ", "latest");
    const state = working([user("Old request", "old"), latest, { id: "tool", kind: "tool", title: "bash", text: "DO NOT USE TOOL OUTPUT", status: "running" }]);
    app.status.update("a", state, true); await app.render();
    expect(app.text()).toBe("Working (0s · <Esc> to interrupt)"); expect(app.caption()).toBe("“Implement the search carefully.”");
    expect(app.spinner().visible).toBe(true); expect(app.status.rows).toBe(2);
    expect(app.captionNode().y).toBe(app.node().y + 1); expect(app.captionNode().x).toBe(app.spinner().x);

    app.status.update("a", { ...state, sections: [...state.sections!, settled("complete")] }, true); await app.render();
    expect(app.text()).toBe("Working (0s · <Esc> to interrupt)"); expect(app.caption()).toBe("“Implement the search carefully.”");
    expect(latest.text).toBe("  Implement\nthe search\t carefully.  ");
  } finally { await app.close(); }
});

test.each(["<C-x>", "<S-Tab>"])("실행 상태는 설정된 중단 키 %s의 Neovim 표기를 유지한다", async key => {
  // 중단 키는 이미 포맷된 안내이므로 수식키의 대문자를 바꾸면 안 된다.
  const app = await mount(70, () => key);
  try {
    // 실행 중 상태를 표시해 실제 작업 안내에도 같은 표기가 전달되는지 확인한다.
    app.status.update("a", working([user("Task")]), true); await app.render();

    // 기본 키가 아닌 사용자 설정도 그대로 안내하고 입력 설정은 변경하지 않는다.
    expect(app.text()).toBe(`Working (0s · ${key} to interrupt)`);
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
    expect(app.text()).toBe("Compacting context (0s · <Esc> to interrupt)"); expect(app.spinner().visible).toBe(true);
    expect(app.captureCharFrame()).not.toBe(first); expect(app.text()).not.toContain("Previous delivered request");

    // 압축 이후 일반 실행으로 돌아오면 같은 요청과 스피너를 이어서 표시한다.
    app.status.update("a", state, true); await app.render();
    expect(app.text()).toBe("Working (0s · <Esc> to interrupt)"); expect(app.caption()).toBe("“Previous delivered request”"); expect(app.spinner().visible).toBe(true);
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
    expect(app.text()).toBe("Working (0s · <Esc> to interrupt)"); expect(app.caption()).toContain("…  [2 images] [3 files]");
    expect(Bun.stringWidth(app.caption())).toBeLessThanOrEqual(50);
    expect(app.captureCharFrame().split("\n")[2]?.trim()).toBe(""); expect(request.text).toBe("Original full prompt");
  } finally { await app.close(); }
});

test("Working은 이미지 내부 안내 없이 입력값과 기존 이미지·파일 개수만 표시한다", async () => {
  // 실제 SDK 메시지에서 나온 섹션으로 작업 상태의 표시 경로를 확인한다.
  const app = await mount(120), transcript = new SessionTranscript([]);
  const text = '이거 두 개 확인해봐 [Image #1] [Image #2] @"/tmp/a.ts" @"/tmp/b.ts"\n\n[Image: original 3000x4000, displayed at 1500x2000. Multiply coordinates by 2.00 to map to original image.]';
  transcript.handle({ type: "message_end", message: { role: "user", timestamp: 1, content: [{ type: "text", text },
    { type: "image", mimeType: "image/png", data: "one" }, { type: "image", mimeType: "image/png", data: "two" }] } });
  try {
    // 두 줄과 높이가 부족한 한 줄 상태 모두 같은 표시 정책을 따른다.
    app.status.update("a", working(transcript.sections), true); await app.render();
    expect(app.caption()).toBe("“이거 두 개 확인해봐”  [2 images] [2 files]");
    app.status.fitRows(1); await app.render();

    // 한 줄로 전환해도 안내문 대신 입력값과 첨부 집계를 유지한다.
    expect(app.text()).toContain("“이거 두 개 확인해봐”  [2 images] [2 files]");
    expect(app.captureCharFrame()).not.toContain("Image:");
    expect(app.captureCharFrame()).not.toContain("Multiply coordinates");
  } finally { await app.close(); }
});

test("이미지 전용 요청의 첨부 섹션은 파일명을 작업 요청으로 오인하지 않고 이미지 개수만 표시한다", async () => {
  const app = await mount();
  try {
    const attachment: TranscriptSection = { id: "attachment", kind: "notice", title: "read", text: "clipboard-1.png", status: "complete",
      image: { id: "a".repeat(64), name: "clipboard-1.png", mimeType: "image/png", byteLength: 80 }, request: { text: "", images: 1, files: 0 } };
    app.status.update("a", working([attachment]), true); await app.render();

    expect(app.text()).toStartWith("Working"); expect(app.caption()).toBe("[1 image]");
    expect(app.captureCharFrame()).not.toContain("clipboard-1.png"); expect(app.caption()).not.toContain("“");
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

test.each([false, true])("테마 밝기 %s에서도 취소는 회색이고 미완료 중단·실패는 오류색이다", async (light) => {
  // Semantic palette roles must keep intentional cancellation neutral without changing time or request colors.
  const app = await mount(), theme = uiTheme(app.renderer);
  try {
    theme.configure({ palette: [], defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
      cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null, highlightForeground: null, highlightBackground: null });

    // Render each terminal outcome independently of the aggregate session status.
    for (const [outcome, label, color] of [["cancelled", "Cancelled", "muted"], ["unfinished", "Stopped", "error"], ["error", "Failed", "error"]] as const) {
      app.status.update("a", { status: null, output: "", error: null, sections: [user("Task"), settled(outcome)] }, true); await app.render();

      // Failed and unfinished work share error red; only cancellation and elapsed time use neutral gray.
      const spans = app.captureSpans().lines[app.node().y]!.spans;
      expect(spans.find(span => span.text.includes(label))!.fg.toInts()).toEqual(theme.colors[color].toInts());
      if (outcome === "cancelled") expect(spans.find(span => span.text.includes("(1s)"))!.fg.toInts()).toEqual(theme.colors.muted.toInts());
      expect(spans.find(span => span.text.includes("Task"))!.fg.toInts()).toEqual(theme.colors.text.toInts());
      expect(app.node().x).toBe(app.status.root.x);
    }
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
    const request = user("A 👨‍👩‍👧‍👦 e\u0301 한글👩🏽‍💻 " + "Z".repeat(40));
    app.status.update("a", working([request]), true); await app.render();
    expect(app.caption()).toContain("👨‍👩‍👧‍👦"); expect(app.caption()).toContain("e\u0301"); expect(app.caption().endsWith("…")).toBe(true);
    expect(app.caption()).not.toContain("\uFFFD"); expect(Bun.stringWidth(app.caption())).toBeLessThanOrEqual(34);
    expect(app.captureCharFrame().split("\n")[2]!.trim()).toBe("");
    app.resize(6, 4); await app.render(); expect(Bun.stringWidth(app.text())).toBeLessThanOrEqual(4); expect(Bun.stringWidth(app.caption())).toBeLessThanOrEqual(6);
    app.resize(70, 4); await app.render(); expect(app.text()).toBe("Working (0s · <Esc> to interrupt)"); expect(app.caption()).toBe(`“${request.text}”`);
  } finally { await app.close(); }
});

test("스킬 호출은 내부 지침을 노출하지 않고 요청 없는 실행도 이름을 추측하지 않는다", async () => {
  const app = await mount();
  try {
    app.status.update("a", working([{ id: "skill", kind: "notice", title: "write-good-code", skillName: "write-good-code", text: "PRIVATE INTERNAL INSTRUCTIONS", status: "complete" }]), true); await app.render();
    expect(app.text()).toBe("Working (0s · <Esc> to interrupt)"); expect(app.caption()).toBe("“/skill:write-good-code”"); expect(app.captureCharFrame()).not.toContain("PRIVATE INTERNAL INSTRUCTIONS");
    app.status.update("a", { status: "working", output: "Legacy output", error: null }, true); await app.render(); expect(app.text()).toBe("Working (0s · <Esc> to interrupt)");
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
    expect(app.text()).toContain("Working (12s · <Esc> to interrupt)");

    // Equal snapshots must not restart the locally interpolated timer.
    app.clock.advance(2000); app.status.update("a", state, true); await app.render();
    expect(app.text()).toContain("Working (14s · <Esc> to interrupt)");
    app.status.update("a", state, false); app.clock.advance(2000);
    app.status.update("a", { ...state, runTiming: { startedAt: 1000, elapsedMs: 16000 } }, true); await app.render();

    expect(app.text()).toContain("Working (16s · <Esc> to interrupt)");
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
        const caption = app.captureSpans().lines[app.captionNode().y]!.spans;
        expect(caption.find(span => span.text.includes("Task"))!.fg.toInts()).toEqual(theme.colors.muted.toInts());
      }
    }
  } finally { await app.close(); }
});

test("Fast에서만 노란 화살표와 Working shimmer를 표시하고 시간·요청은 움직이지 않는다", async () => {
  // Fast is observed telemetry, never inferred from the model name or a user's draft.
  const app = await mount();
  const state = { ...working([user("Keep this request")]), telemetry: { provider: "openai-codex", model: "fixture", effort: "high", fast: true, context: null, weekly: null } };
  const colorAt = (offset: number) => {
    let column = 0;
    return app.captureSpans().lines[app.node().y]!.spans.find(span => { column += span.width; return column > app.node().x + offset; })!.fg.toInts();
  };
  try {
    app.status.update("a", state, true); await app.render();
    const base = uiTheme(app.renderer).colors.number.toInts(), geometry = [app.node().x, app.node().y, app.captionNode().x, app.status.root.height];
    const caption = app.caption();
    expect(app.node().x).toBe(app.status.root.x + 4); expect(app.captionNode().x).toBe(app.spinner().x);
    expect(app.captureCharFrame()).toContain("▶▷▷ Working"); expect(colorAt(0)).toEqual(base);

    // Only the word Working is swept; elapsed time, interrupt hint and request remain fixed.
    app.clock.advance(100); await app.render(); const first = colorAt(0);

    expect(first).not.toEqual(base); expect(colorAt(3)).toEqual(base);
    app.clock.advance(350); await app.render();
    expect(colorAt(0)).toEqual(base); expect(colorAt(3)).not.toEqual(base);
    expect(app.caption()).toBe(caption); expect(app.text()).toBe("Working (0s · <Esc> to interrupt)");
    expect([app.node().x, app.node().y, app.captionNode().x, app.status.root.height]).toEqual(geometry);
    app.clock.advance(1150); await app.render(); expect(colorAt(0)).toEqual(first);
    const timers = app.clock.pendingTimerCount;
    app.status.update("a", { ...state, telemetry: { ...state.telemetry, fast: false } }, true); await app.render();
    expect(app.clock.pendingTimerCount).toBe(timers - 1);
    expect(colorAt(0)).toEqual(uiTheme(app.renderer).colors.accent.toInts()); expect(app.spinner().width).toBe(1);
    expect(app.captionNode().x).toBe(app.spinner().x);
    app.clock.advance(450); await app.render(); expect(colorAt(0)).toEqual(uiTheme(app.renderer).colors.accent.toInts());
    app.status.update("a", state, false); await app.render(); expect(app.clock.pendingTimerCount).toBe(0);
  } finally { await app.close(); }
});

test("두 줄 Working은 높이가 부족하면 한 줄로 줄고 공간 복원 시 요약을 다음 줄에 복원한다", async () => {
  // Layout policy may reclaim the caption row, but must not lose the original request.
  const app = await mount();
  try {
    app.status.update("a", working([user("Retained request")]), true); await app.render();
    expect(app.status.rows).toBe(2); expect(app.caption()).toBe("“Retained request”");

    app.status.fitRows(1); await app.render();

    expect(app.status.rows).toBe(1); expect(app.caption()).toBe(""); expect(app.text()).toContain("Retained request");
    app.status.fitRows(2); await app.render();
    expect(app.status.rows).toBe(2); expect(app.caption()).toBe("“Retained request”"); expect(app.text()).not.toContain("Retained request");
  } finally { await app.close(); }
});

test("Fast 화면 숨김·세션 전환·제거는 shimmer와 스피너 타이머를 정리한다", async () => {
  // Per-session animation must not survive its owning screen or leak into a different session.
  const app = await mount();
  const state = { ...working([user("Fast request")]), telemetry: { provider: "fixture", model: "fixture", effort: "high", fast: true, context: null, weekly: null } };
  try {
    app.status.update("a", state, true); await app.render();
    const timers = app.clock.pendingTimerCount;
    app.clock.advance(120); app.status.update("a", state, true); expect(app.clock.pendingTimerCount).toBe(timers);

    app.status.update("a", state, false); expect(app.clock.pendingTimerCount).toBe(0);

    app.status.update("a", state, true); await app.render();
    app.status.update("b", { status: null, error: null, output: "" }, true); await app.render();
    expect(app.clock.pendingTimerCount).toBe(0); expect(app.captureCharFrame()).not.toContain("▶");
    app.status.update("a", state, true); app.status.root.destroyRecursively(); await app.render();
    expect(app.clock.pendingTimerCount).toBe(0); expect(() => app.clock.advance(5000)).not.toThrow();
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
      expect(app.captureSpans().lines[app.captionNode().y]!.spans.find(span => span.text.includes("Theme request"))!.fg.toInts()).toEqual(theme.colors.muted.toInts());
      app.status.update("a", { status: "failure", error: "Fixture failure", output: "" }, true); await app.render();
      expect(spans().find((span) => span.text.includes("Failed"))!.fg.toInts()).toEqual(theme.colors.error.toInts());
    }
  } finally { await app.close(); }
});
