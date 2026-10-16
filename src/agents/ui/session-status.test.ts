import { expect, spyOn, test } from "bun:test";
import type { TerminalColors } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "../../app/ui/workbench.ts";
import { WorkspaceSelection } from "../../app/workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { ok } from "../../result.ts";
import type { SessionTelemetry } from "../telemetry.ts";
import { uiTheme } from "../../ui/theme.ts";

const sample = (): SessionTelemetry => ({ provider: "openai-codex", model: "gpt-5.5", effort: "high", fast: true,
  context: { usedTokens: 72000, maxTokens: 200000 },
  weekly: { remainingPercent: 82, resetsAt: Date.now() + 3600000, observedAt: Date.now() } });
async function mount(telemetry: SessionTelemetry | undefined = sample()) {
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace());
  const states: Record<string, SessionTelemetry | undefined> = { a1: telemetry };
  const view = new Workbench(app.renderer, selection, { onNewSession: () => {}, onCloseSession: () => {}, onPrompt: () => ok(undefined),
    getSessionDetails: (id) => ({ status: "complete", output: "Transcript", error: null, ...(states[id] ? { telemetry: states[id] } : {}) }) });
  await app.renderOnce();
  const root = app.renderer.root.findDescendantById("session-status")!;
  return { ...app, view, selection, root,
    line: () => app.captureCharFrame().split("\n")[root.y]!,
    async set(value: SessionTelemetry | undefined) { states[selection.sessionId!] = value; selection.replaceSnapshot(selection.snapshot); await app.renderOnce(); },
    async close() { view.dispose(); await app.dispose(); } };
}

const palette = (light: boolean): TerminalColors => ({ palette: ["#000000", "#CC2222", "#228822", "#998800", "#2255AA", "#AA22AA", light ? "#996633" : "#117799", "#DDDDDD"],
  defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
  cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null,
  highlightForeground: null, highlightBackground: null });

test("프롬프트 박스 바깥 바로 위에 설정과 남은 context·weekly의 그라데이션 바를 표시한다", async () => {
  // These values intentionally distinguish remaining context (64%) from used context (36%).
  const app = await mount();
  try {
    app.mockInput.pressKey("e", { ctrl: true }); await app.mockInput.typeText("keep this draft"); await app.renderOnce();

    const prompt = app.renderer.root.findDescendantById("session-prompt")!;
    const composer = app.renderer.root.findDescendantById("agent-composer")!;
    expect(app.root.y + app.root.height + 1).toBe(composer.y);
    expect(app.root.x).toBe(composer.x);
    expect(app.root.x + app.root.width).toBe(composer.x + composer.width);
    expect(app.root.y).toBeLessThan(prompt.y);
    expect(app.line()).toContain("gpt-5.5 · high · Fast on");
    expect(app.line()).toMatch(/context [█▏▎▍▌▋▊▉░]+ 64%/);
    expect(app.line()).toMatch(/weekly [█▏▎▍▌▋▊▉░]+ 82%/);
    expect(app.line()).not.toContain("36%");

    // Passive status text must not steal the editor's focus or submit its draft.
    await app.mockMouse.click(app.root.x + 2, app.root.y); await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable).toBe(prompt);
    expect(app.view.promptDrafts.a1).toBe("keep this draft");
  } finally { await app.close(); }
});

test("TRANSCRIPT·모델 줄·입력 박스는 양끝을 맞추고 사이마다 한 줄씩 띄운다", async () => {
  // Reproduce the reported screenshot with an unknown weekly allowance and an indented model label.
  const app = await mount({ ...sample(), model: "gpt-6.1-sol", effort: "xhigh", fast: null,
    context: { usedTokens: 6000, maxTokens: 200000 }, weekly: null });
  try {
    await app.renderOnce();

    const frame = app.captureCharFrame().split("\n");
    const modeY = frame.findIndex((line) => line.includes("TRANSCRIPT ·"));
    const mode = frame[modeY]!;
    const composer = app.renderer.root.findDescendantById("agent-composer")!;
    const modelColumn = Bun.stringWidth(app.line().slice(0, app.line().indexOf("gpt-6.1-sol")));
    const modeColumn = Bun.stringWidth(mode.slice(0, mode.indexOf("TRANSCRIPT")));

    // The content starts at the same left edge and the resource group reaches the same right edge.
    expect(modeColumn).toBe(composer.x); expect(modelColumn).toBe(composer.x);
    expect(Bun.stringWidth(app.line().trimEnd())).toBe(composer.x + composer.width);
    expect(app.root.y - modeY - 1).toBe(1);
    expect(composer.y - app.root.y - app.root.height).toBe(1);
    const blankAbove = frame[app.root.y - 1]!.slice(composer.x, composer.x + composer.width);
    const blankBelow = frame[app.root.y + app.root.height]!.slice(composer.x, composer.x + composer.width);
    expect(blankAbove.trim()).toBe(""); expect(blankBelow.trim()).toBe("");
    expect(app.line().slice(app.line().indexOf("weekly")).trim()).toBe("weekly -");
  } finally { await app.close(); }
});

test("바의 채워진 부분만 테마 accent를 따라 그라데이션으로 다시 칠한다", async () => {
  const data = { ...sample(), context: { usedTokens: 0, maxTokens: 200000 }, weekly: { ...sample().weekly!, remainingPercent: 100 } };
  const app = await mount(data);
  const spanAt = (column: number) => {
    let x = 0;
    return app.captureSpans().lines[app.root.y]!.spans.find((span) => { x += span.width; return x > column; })!;
  };
  const verify = () => {
    const line = app.line();
    const start = Bun.stringWidth(line.slice(0, line.indexOf("context"))) + "context ".length;
    const first = spanAt(start), last = spanAt(start + 7);
    expect(first.fg.toInts()).toEqual(uiTheme(app.renderer).colors.accent.toInts());
    expect(last.fg.equals(first.fg)).toBe(false);
    expect(first.bg.equals(uiTheme(app.renderer).colors.panel)).toBe(true);
    expect(app.line()).toContain("context ████████ 100%");
    return first.fg.toInts();
  };
  try {
    app.renderer.emit("palette", palette(false)); await app.renderOnce();
    const dark = verify();

    app.renderer.emit("palette", palette(true)); await app.renderOnce();

    expect(verify()).not.toEqual(dark);
    expect(app.line()).toContain("weekly ████████ 100%");
  } finally { await app.close(); }
});

test("좁은 화면은 바와 설정을 축약해 두 잔량과 입력·푸터를 보존하고 넓히면 복원한다", async () => {
  const app = await mount();
  try {
    app.mockInput.pressKey("e", { ctrl: true }); await app.mockInput.typeText("resize draft");

    for (const [width, height, gap] of [[100, 20, 1], [60, 12, 0], [120, 24, 1]] as const) {
      app.resize(width!, height!); await app.renderOnce();

      expect(app.line()).toContain("context"); expect(app.line()).toContain("64%");
      expect(app.line()).toContain("weekly"); expect(app.line()).toContain("82%");
      expect(Bun.stringWidth(app.line())).toBeLessThanOrEqual(width!);
      const prompt = app.renderer.root.findDescendantById("session-prompt")!;
      const footer = app.renderer.root.findDescendantById("footer-bar")!;
      const composer = app.renderer.root.findDescendantById("agent-composer")!;
      const modeY = app.captureCharFrame().split("\n").findIndex((line) => line.includes("INPUT ·"));
      expect(app.root.y - modeY - 1).toBe(gap);
      expect(composer.y - app.root.y - app.root.height).toBe(gap);
      expect(app.root.x).toBe(composer.x);
      expect(app.root.x + app.root.width).toBe(composer.x + composer.width);
      expect(composer.y + composer.height).toBeLessThanOrEqual(footer.y);
      expect(app.renderer.currentFocusedRenderable).toBe(prompt);
      expect(app.view.promptDrafts.a1).toBe("resize draft");
      expect(app.captureCharFrame().split("\n")[height! - 1]).toContain("Radian 0.0.0");
    }
    expect(app.line()).toContain("Fast on"); expect(app.line()).toContain("█");
  } finally { await app.close(); }
});

test("압축 뒤 미확정 context와 미지원 weekly는 바 없이 -로 표시하고 세션 사이에 섞지 않는다", async () => {
  const app = await mount();
  try {
    const data = { ...sample(), fast: null, context: { usedTokens: null, maxTokens: 200000 }, weekly: null };

    await app.set(data);

    expect(app.line()).toContain("Fast —");
    expect(app.line()).toContain("context -"); expect(app.line()).toContain("weekly -");
    expect(app.line()).not.toMatch(/[█▏▎▍▌▋▊▉░─]/);
    expect(app.line()).not.toContain("0%"); expect(app.line()).not.toContain("82%");
    app.selection.selectSession("demo:main", "a2"); await app.renderOnce();
    expect(app.line()).not.toContain("gpt-5.5"); expect(app.line()).not.toContain("Fast on");
  } finally { await app.close(); }
});

test("weekly 데이터가 없으면 context 바는 유지하고 weekly -만 표시한다", async () => {
  // A usable context measurement must not make an unknown weekly allowance look like an empty bar.
  const app = await mount({ ...sample(), weekly: null });
  try {
    await app.renderOnce();

    expect(app.line()).toMatch(/context [█▏▎▍▌▋▊▉░]+ 64%/);
    expect(app.line().slice(app.line().indexOf("weekly")).trim()).toBe("weekly -");
  } finally { await app.close(); }
});

test("실제 잔량 0%는 미확정 값과 다르게 비어 있는 바와 함께 표시한다", async () => {
  const data = { ...sample(), context: { usedTokens: 200000, maxTokens: 200000 }, weekly: { ...sample().weekly!, remainingPercent: 0 } };
  const app = await mount(data);
  try {
    await app.renderOnce();

    expect(app.line()).toContain("context ░░░░░░░░ 0%");
    expect(app.line()).toContain("weekly ░░░░░░░░ 0%");
    expect(app.line()).not.toContain("100%");
  } finally { await app.close(); }
});

test("weekly가 리셋되면 추정으로 100%를 채우지 않고 숨김·제거 시 만료 타이머를 정리한다", async () => {
  // Control only the expiry clock; actual OpenTUI rendering and view transitions remain real.
  const now = 1800000000000;
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const scheduled = spyOn(globalThis, "setTimeout");
  const cleared = spyOn(globalThis, "clearTimeout");
  const data = { ...sample(), weekly: { remainingPercent: 82, resetsAt: now + 1000, observedAt: now } };
  const app = await mount(data);
  const expiry = () => {
    const index = scheduled.mock.calls.findLastIndex(([, delay]) => delay === 1000);
    const result = scheduled.mock.results[index];
    const callback = scheduled.mock.calls[index]?.[0];
    if (!result || result.type !== "return" || typeof callback !== "function") throw new Error("Quota expiry timer was not scheduled.");
    return { timer: result.value, callback };
  };
  try {
    const first = expiry();
    clearTimeout(first.timer); clock.mockReturnValue(now + 1001); first.callback(); await app.renderOnce();

    expect(app.line().slice(app.line().indexOf("weekly")).trim()).toBe("weekly -");
    expect(app.line()).not.toContain("100%");

    clock.mockReturnValue(now); await app.set(data); const hidden = expiry();
    app.selection.selectWorktree("demo:empty"); await app.renderOnce();
    expect(cleared).toHaveBeenCalledWith(hidden.timer);
    app.selection.selectSession("demo:main", "a1"); await app.renderOnce(); const disposed = expiry();
    app.view.dispose();
    expect(cleared).toHaveBeenCalledWith(disposed.timer);
  } finally { await app.close(); scheduled.mockRestore(); cleared.mockRestore(); clock.mockRestore(); }
});
