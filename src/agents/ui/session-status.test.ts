import { pressLeader } from "../../testing/keys.ts";
import { expect, spyOn, test } from "bun:test";
import type { TerminalColors, TextRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench } from "../../app/ui/workbench.ts";
import { WorkspaceSelection } from "../../app/workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { ok } from "../../result.ts";
import type { SessionTelemetry } from "../telemetry.ts";
import type { ProviderUsage } from "../../usage/model.ts";
import { uiTheme } from "../../ui/theme.ts";
import { icons, spinnerFrames } from "../../icons.ts";
import { SessionStatus } from "./session-status.ts";

const unavailable = (): ProviderUsage => ({ provider: "openai", status: "unavailable", windows: [], updatedAt: null, errorCode: null });
const sample = (): SessionTelemetry => ({ provider: "openai-codex", model: "gpt-5.5", effort: "high", fast: true,
  context: { usedTokens: 72000, maxTokens: 200000 }, weekly: null,
  usage: { provider: "openai", status: "ready", windows: [{ id: "period", usedPercent: 18, periodMs: 604800000, resetsAt: Date.now() + 3600000 }],
    updatedAt: Date.now(), errorCode: null } });
async function mount(telemetry: SessionTelemetry = sample(), clock?: ManualClock, settled = false) {
  const app = await createTestRenderer({ width: 140, height: 24, kittyKeyboard: true, ...(clock ? { clock } : {}) });
  const snapshot = demoWorkspace();
  const selection = new WorkspaceSelection(settled ? snapshot.map(repo => ({ ...repo, worktrees: repo.worktrees.map(tree => ({ ...tree,
    sessions: tree.sessions.map(session => ({ ...session, subagents: [] })),
  })) })) : snapshot);
  const states: Record<string, SessionTelemetry | undefined> = { a1: telemetry };
  const view = new Workbench(app.renderer, selection, { onNewSession: () => {}, onCloseSession: () => {}, onPrompt: () => ok(undefined),
    getSessionDetails: (id) => ({ status: "complete", output: "Transcript", error: null, ...(states[id] ? { telemetry: states[id] } : {}) }) });
  await app.renderOnce();
  const root = app.renderer.root.findDescendantById("session-status")!;
  const row = root.getChildren()[0]!;
  return { ...app, view, selection, root, row,
    line: () => app.captureCharFrame().split("\n")[row.y]!,
    async set(value: SessionTelemetry) { states[selection.sessionId!] = value; selection.replaceSnapshot(selection.snapshot); await app.renderOnce(); },
    async close() { view.dispose(); await app.dispose(); } };
}
const palette = (light: boolean): TerminalColors => ({ palette: ["#000000", "#CC2222", "#228822", "#998800", "#2255AA", "#AA22AA", light ? "#996633" : "#117799", "#DDDDDD"],
  defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
  cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null, highlightForeground: null, highlightBackground: null });

test("Status below prompts has one-row outer spacing and separates context from usage", async () => {
  // The session has 64% context remaining, while its account has used 18% of the selected allowance.
  const app = await mount();
  try {
    pressLeader(app, "a"); await app.mockInput.typeText("keep this draft"); await app.renderOnce();

    const prompt = app.renderer.root.findDescendantById("session-prompt")!, composer = app.renderer.root.findDescendantById("agent-composer")!;
    // The telemetry has its own one-row gutters, separate from the prompt's internal padding.
    expect(app.root.y).toBe(composer.y + composer.height); expect(app.root.height).toBe(3);
    expect(app.row.y - app.root.y).toBe(1); expect(app.root.y + app.root.height - app.row.y - app.row.height).toBe(1);
    const frame = app.captureCharFrame().split("\n");
    for (const y of [app.row.y - 1, app.row.y + 1]) expect(frame[y]!.slice(app.root.x, app.root.x + app.root.width).trim()).toBe("");
    const panel = app.renderer.root.findDescendantById("agent-view")!;
    expect(composer.x).toBe(panel.x); expect(composer.width).toBe(panel.width);
    expect(prompt.x).toBe(app.root.x); expect(prompt.x + prompt.width).toBe(app.root.x + app.root.width);
    expect(app.line()).toContain(`${icons.model} gpt-5.5 · ${icons.brain} high · ${icons.bolt} fast on`);
    expect(app.line()).toContain(icons.context); expect(app.line()).toContain("64% left");
    expect(app.line()).toContain("chatgpt"); expect(app.line()).not.toContain("ChatGPT");
    expect(app.line()).toMatch(/context ▉{8} 64%/);
    expect(app.line()).toContain(icons.openai); expect(app.line()).toContain("18% used 1h 0m");
    const usageText = app.line().slice(app.line().indexOf(icons.openai));
    expect(usageText).not.toContain("·"); expect(usageText).not.toContain("━");
    expect(usageText).toMatch(/▉{8} 18% used 1h 0m/);
    expect(app.renderer.root.findDescendantById("usage-provider-icon")?.width).toBe(2);
    expect(app.line()).not.toContain("82%"); expect(app.line()).not.toContain("weekly"); expect(app.line()).not.toContain("⟳");

    // Passive status text never steals focus or submits a draft.
    await app.mockMouse.click(app.row.x + 2, app.row.y); await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable).toBe(prompt); expect(app.view.promptDrafts.a1).toBe("keep this draft");
    const icon = app.renderer.root.findDescendantById("usage-provider-icon")!;
    await app.mockMouse.click(icon.x, icon.y); await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable).toBe(prompt); expect(app.view.promptDrafts.a1).toBe("keep this draft");
  } finally { await app.close(); }
});

test("워크트리·브랜치를 괄호로 묶고 테마 변경에도 구분점·이름·브랜치의 색상 위계를 유지한다", async () => {
  // The location is passive metadata, not a button or a separate background badge.
  const app = await mount();
  const span = (text: string) => app.captureSpans().lines[app.row.y]!.spans.find((value) => value.text.includes(text))!;
  try {
    for (const light of [false, true]) {
      // Changing the terminal palette must repaint every part without a workspace switch.
      app.renderer.emit("palette", palette(light)); await app.renderOnce();

      // Only the current branch is accented; brackets and the dot stay muted on the panel.
      const colors = uiTheme(app.renderer).colors;
      expect(app.line()).toContain(`[ ${icons.folder} radian · ${icons.branch} main ]`);
      for (const text of ["[ ", " · ", " ]"]) expect(span(text).fg.toInts()).toEqual(colors.muted.toInts());
      for (const text of [icons.folder, "radian"]) expect(span(text).fg.toInts()).toEqual(colors.text.toInts());
      for (const text of [icons.branch, "main"]) expect(span(text).fg.toInts()).toEqual(colors.accent.toInts());
      for (const text of ["[ ", icons.folder, "radian", icons.branch, " ]"]) expect(span(text).bg.toInts()).toEqual(colors.panel.toInts());
    }
  } finally { await app.close(); }
});

test("워크트리 그룹 전체를 담을 수 없으면 숨기고 넓히면 복원하며 사용량 비율은 유지한다", async () => {
  // A standalone status row also covers widths too small for the full workbench layout.
  const app = await createTestRenderer({ width: 60, height: 5 });
  const status = new SessionStatus(app.renderer); app.renderer.root.add(status.root);
  status.update(sample(), true, { name: "radian", branch: "main" });
  const scope = status.root.findDescendantById("session-worktree-context") as TextRenderable;
  try {
    for (const [width, visible] of [[60, true], [50, true], [40, false], [30, false], [60, true]] as const) {
      // Shrinking and restoring the row must never leave orphan brackets or hide known percentages.
      app.resize(width, 5); await app.renderOnce();

      expect(scope.visible).toBe(visible); expect(Bun.stringWidth(scope.plainText)).toBeLessThanOrEqual(scope.width);
      if (visible) {
        expect(scope.plainText.startsWith(`[ ${icons.folder} `)).toBe(true); expect(scope.plainText.endsWith(" ]")).toBe(true);
        expect(scope.plainText).toContain(` · ${icons.branch} `);
      } else expect(scope.plainText).toBe("");
      const line = app.captureCharFrame().split("\n")[scope.y]!;
      expect(line).toContain("64%"); expect(line).toContain("18% used");
    }
  } finally { status.dispose(); await app.dispose(); }
});

test("입력 배경은 패널 양끝을 채우고 입력 내용은 실행 상태·모델 줄과 같은 내부 여백에 정렬한다", async () => {
  // The surface reaches the pane edges; its editable content keeps the shared responsive inset.
  const app = await mount({ ...sample(), model: "gpt-6.1-sol", effort: "xhigh", fast: null,
    context: { usedTokens: 6000, maxTokens: 200000 }, usage: unavailable() });
  try {
    // Width changes adapt text insets; height changes keep the same vertical treatment.
    for (const [width, height, inset, gap] of [[120, 24, 2, 1], [79, 18, 1, 1], [80, 18, 2, 1], [60, 12, 1, 1], [120, 24, 2, 1]] as const) {
      app.resize(width, height); await app.renderOnce();
      const run = app.renderer.root.findDescendantById("agent-run-status")!;
      const composer = app.renderer.root.findDescendantById("agent-composer")!;
      const prompt = app.renderer.root.findDescendantById("session-prompt")!;
      const panel = app.renderer.root.findDescendantById("agent-view")!;
      const statusColumn = run.x;

      // Only the background expands; the mode line, telemetry and editable text stay aligned.
      expect(composer.x).toBe(panel.x); expect(composer.width).toBe(panel.width);
      expect(prompt.x - composer.x).toBe(inset); expect(composer.x + composer.width - prompt.x - prompt.width).toBe(inset);
      expect(statusColumn).toBe(prompt.x); expect(app.root.x).toBe(prompt.x);
      expect(app.root.x + app.root.width).toBe(prompt.x + prompt.width);
      expect(composer.y - run.y - run.height).toBe(gap); expect(app.row.y - composer.y - composer.height).toBe(1);
      expect(app.root.y + app.root.height - app.row.y - app.row.height).toBe(1);
    }
  } finally { await app.close(); }
});

test("빈 입력창은 placeholder만 표시하고 포커스와 테마 변경에도 내부 배경을 바꾸지 않는다", async () => {
  // Placeholder and native caret identify the input without a border or second background stripe.
  const app = await mount();
  const composer = app.renderer.root.findDescendantById("agent-composer")!;
  const prompt = app.renderer.root.findDescendantById("session-prompt")!;
  const verifyBackground = () => {
    const frame = app.captureSpans(), surface = uiTheme(app.renderer).colors.surface.toInts();
    for (let y = composer.y; y < composer.y + composer.height; y++) {
      let column = 0;
      for (const span of frame.lines[y]!.spans) {
        if (column < composer.x + composer.width && column + span.width > composer.x) expect(span.bg.toInts()).toEqual(surface);
        column += span.width;
      }
    }
  };
  try {
    // Empty, focused and unfocused states must look consistent in both terminal palettes.
    for (const light of [false, true]) {
      app.renderer.emit("palette", palette(light));
      for (const focused of [false, true]) {
        if (focused) prompt.focus(); else prompt.blur();
        await app.renderOnce();

        expect(app.captureCharFrame().split("\n")[prompt.y]!.slice(composer.x + 1, composer.x + composer.width).trim()).toBe("Ask to do anything");
        verifyBackground();
      }
    }
    await app.mockInput.typeText("aligned draft"); await app.renderOnce();

    // Removing the decoration must not change focus, draft editing or text alignment.
    expect(app.captureCharFrame().split("\n")[prompt.y]!.indexOf("aligned draft")).toBe(app.root.x);
    expect(app.renderer.currentFocusedRenderable).toBe(prompt); expect(app.view.promptDrafts.a1).toBe("aligned draft");
    verifyBackground();
  } finally { await app.close(); }
});

test("바의 채워진 부분은 테마 accent 그라데이션으로 다시 칠하고 context와 usage의 방향을 유지한다", async () => {
  const data = sample();
  const app = await mount({ ...data, context: { usedTokens: 0, maxTokens: 200000 },
    usage: { ...data.usage!, windows: [{ ...data.usage!.windows[0]!, usedPercent: 100 }] } });
  const spanAt = (column: number) => { let x = 0; return app.captureSpans().lines[app.row.y]!.spans.find((span) => { x += span.width; return x > column; })!; };
  const verify = () => {
    const line = app.line(), start = Bun.stringWidth(line.slice(0, line.indexOf("context"))) + "context ".length;
    const first = spanAt(start), last = spanAt(start + 7);
    expect(first.fg.toInts()).toEqual(uiTheme(app.renderer).colors.accent.toInts()); expect(last.fg.equals(first.fg)).toBe(false);
    expect(first.bg.equals(uiTheme(app.renderer).colors.panel)).toBe(true);
    expect(app.line()).toContain("context ▉▉▉▉▉▉▉▉ 100%"); expect(app.line()).toContain("▉▉▉▉▉▉▉▉ 100% used");
    return first.fg.toInts();
  };
  try {
    app.resize(140, 24); app.renderer.emit("palette", palette(false)); await app.renderOnce(); const dark = verify();

    app.renderer.emit("palette", palette(true)); await app.renderOnce();

    expect(verify()).not.toEqual(dark);
  } finally { await app.close(); }
});

test("77%·53% 바는 굵은 세그먼트 모양을 고정하고 한 칸 단위로 채움 색을 구분한다", async () => {
  // Eight segments approximate the fill; the labels must retain the exact percentages.
  const data = sample(), app = await mount({ ...data, context: { usedTokens: 46000, maxTokens: 200000 },
    usage: { ...data.usage!, windows: [{ ...data.usage!.windows[0]!, usedPercent: 53 }] } });
  const spanAt = (column: number) => { let x = 0; return app.captureSpans().lines[app.row.y]!.spans.find((span) => { x += span.width; return x > column; })!; };
  try {
    for (const light of [false, true]) {
      // Switching palettes must preserve thick segments without adding a continuous background track.
      app.renderer.emit("palette", palette(light)); await app.renderOnce();

      // Six context segments and four usage segments are active; empty cells keep the same glyph.
      const line = app.line(), panel = uiTheme(app.renderer).colors.panel;
      expect(line).toContain("context ▉▉▉▉▉▉▉▉ 77% left"); expect(line).toContain("chatgpt ▉▉▉▉▉▉▉▉ 53% used");
      for (const [label, filled] of [["context ", 6], ["chatgpt ", 4]] as const) {
        const start = Bun.stringWidth(line.slice(0, line.indexOf(label) + label.length));
        const empty = spanAt(start + 7).fg;
        expect(empty.equals(panel)).toBe(false);
        for (let cell = 0; cell < 8; cell++) {
          const span = spanAt(start + cell);
          expect(span.bg.toInts()).toEqual(panel.toInts());
          expect(span.fg.equals(empty)).toBe(cell >= filled);
        }
      }
    }
  } finally { await app.close(); }
});

test("context는 used와 같은 본문색이고 모델·effort·Fast는 테마 역할과 상태를 따른다", async () => {
  const app = await mount();
  const span = (text: string) => app.captureSpans().lines[app.row.y]!.spans.find((value) => value.text.includes(text))!;
  const verify = (enabled: boolean) => {
    const colors = uiTheme(app.renderer).colors;
    expect(span("context").fg.toInts()).toEqual(span("18% used").fg.toInts());
    expect(span("context").fg.toInts()).toEqual(colors.text.toInts());
    expect(span("gpt-5.5").fg.toInts()).toEqual(colors.success.toInts());
    expect(span("high").fg.toInts()).toEqual(colors.keyword.toInts());
    expect(span(`fast ${enabled ? "on" : "off"}`).fg.toInts()).toEqual((enabled ? colors.number : colors.muted).toInts());
  };
  try {
    // A known palette makes each role distinguishable from a hardcoded color or blanket muted style.
    app.renderer.emit("palette", palette(false)); await app.renderOnce(); verify(true);

    await app.set({ ...sample(), fast: false }); verify(false);
    app.renderer.emit("palette", { ...palette(true), palette: ["#000000", "#CC2222", "#447711", "#BB7700", "#6655AA", "#773399", "#996633", "#DDDDDD"] });
    await app.renderOnce();

    verify(false);
    expect(app.line()).toContain(`${icons.model} gpt-5.5 · ${icons.brain} high · ${icons.bolt} fast off`);
  } finally { await app.close(); }
});

test("Narrow layouts compact bars, settings, and time while preserving ratios and drafts for restoration", async () => {
  const app = await mount();
  try {
    pressLeader(app, "a"); await app.mockInput.typeText("resize draft");
    for (const [width, height, gap] of [[100, 20, 1], [60, 12, 1], [140, 24, 1]] as const) {
      app.resize(width, height); await app.renderOnce();

      expect(app.line()).toContain("context"); expect(app.line()).toContain("64%"); expect(app.line()).toContain("18% used");
      expect(app.line()).toContain(icons.openai); expect(Bun.stringWidth(app.line())).toBeLessThanOrEqual(width);
      const prompt = app.renderer.root.findDescendantById("session-prompt")!, composer = app.renderer.root.findDescendantById("agent-composer")!;
      const footer = app.renderer.root.findDescendantById("footer-bar")!;
      const run = app.renderer.root.findDescendantById("agent-run-status")!;
      expect(composer.y - run.y - run.height).toBe(gap); expect(app.row.y - composer.y - composer.height).toBe(1);
      expect(app.root.y + app.root.height).toBeLessThanOrEqual(footer.y);
      expect(app.root.x).toBe(prompt.x); expect(app.root.x + app.root.width).toBe(prompt.x + prompt.width);
      expect(composer.y + composer.height).toBeLessThanOrEqual(footer.y);
      expect(app.renderer.currentFocusedRenderable).toBe(prompt); expect(app.view.promptDrafts.a1).toBe("resize draft");
    }
    expect(app.line()).toContain("fast on"); expect(app.line()).toContain("▉▉▉▉▉▉▉▉"); expect(app.line()).toContain("1h 0m");
  } finally { await app.close(); }
});

test("fast의 전체·축약 표시는 상태와 관계없이 소문자로 통일한다", async () => {
  const app = await mount();
  try {
    expect(app.line()).toContain("fast on"); expect(app.line()).not.toContain("Fast");

    // A compact identity keeps the robot, brain and bolt while dropping verbose labels.
    app.resize(84, 24); await app.renderOnce();
    const compact = `${icons.model} gpt-5.5 ${icons.brain} high ${icons.bolt}`;
    expect(app.line()).toContain(`${compact} on`);
    await app.set({ ...sample(), fast: false }); expect(app.line()).toContain(`${compact} off`);
    await app.set({ ...sample(), fast: null }); expect(app.line()).toContain(`${compact} —`);
    expect(app.line()).not.toContain("Fast");
  } finally { await app.close(); }
});

test("작업 중이 아닐 때 Fast 표시는 정적이고 입력창은 애니메이션이나 보더를 만들지 않는다", async () => {
  // Fast is session configuration; it must not animate the idle composer or passive metadata.
  const clock = new ManualClock(), app = await mount(sample(), clock, true);
  try {
    const before = app.captureSpans().lines[app.row.y], baseline = clock.pendingTimerCount;

    clock.advance(450); await app.renderOnce();

    expect(app.captureSpans().lines[app.row.y]).toEqual(before);
    expect(clock.pendingTimerCount).toBe(baseline);
    const composer = app.renderer.root.findDescendantById("agent-composer")!;
    const frame = app.captureCharFrame().split("\n");
    for (const y of [composer.y, composer.y + composer.height - 1]) expect(frame[y]!.trim()).toBe("");
    expect(app.line()).toContain("fast on");
    await app.set({ ...sample(), fast: false }); expect(app.line()).toContain("fast off");
    await app.set({ ...sample(), fast: null }); expect(app.line()).toContain("fast —");
    expect(clock.pendingTimerCount).toBe(baseline);
  } finally { await app.close(); }
});

test("미확정 context와 미지원 usage는 바 없이 -로 표시하고 세션 사이에 섞지 않는다", async () => {
  const app = await mount();
  try {
    await app.set({ ...sample(), fast: null, context: { usedTokens: null, maxTokens: 200000 }, usage: unavailable() });

    expect(app.line()).toContain("fast —"); expect(app.line()).toContain("context -");
    expect(app.line().slice(app.line().indexOf(icons.openai)).trim().replace(/\s+/g, " ")).toBe(`${icons.openai} chatgpt -`);
    expect(app.line()).not.toContain("▉"); expect(app.line()).not.toContain("0%");
    app.selection.selectSession("demo:main", "a2"); await app.renderOnce();
    expect(app.line()).not.toContain("gpt-5.5"); expect(app.line()).not.toContain("18% used");
  } finally { await app.close(); }
});

test("압축 후 추정 컨텍스트도 별도 표식 없이 현재 모델 한도의 잔량 퍼센트로 표시한다", async () => {
  // 사용량이 미확정이면 추정값을 받되 실제 모델의 총한도로 잔량을 계산한다.
  const app = await mount();
  try {
    // 87.2만 토큰 모델에서 추정 사용량 4만 토큰은 반올림한 잔량 95%이다.
    await app.set({ ...sample(), context: { usedTokens: 40000, maxTokens: 872000 } });

    // 기존 바·퍼센트 형식을 유지하며 틸드나 미확정 대시를 덧붙이지 않는다.
    expect(app.line()).toMatch(/context ▉{8} 95%/);
    expect(app.line()).not.toContain("~"); expect(app.line()).not.toContain("context -");
  } finally { await app.close(); }
});

test("미지원 usage는 context 바만 유지하고 사용률 바나 시간을 꾸미지 않는다", async () => {
  // 조회를 지원하지 않는 제공자는 복구 스피너를 계속 돌려서는 안 된다.
  const app = await mount();
  try {
    await app.set({ ...sample(), usage: unavailable() });

    // 미지원 상태는 오류 재시도와 달리 정적인 미확정 표시를 유지한다.
    expect(app.line()).toMatch(/context ▉+ 64% left/);
    expect(app.line().slice(app.line().indexOf(icons.openai)).trim().replace(/\s+/g, " ")).toBe(`${icons.openai} chatgpt -`);
  } finally { await app.close(); }
});

test("Usage recovery shows only gray last-fill bars and spinners until fresh success", async () => {
  // Start with usage failure after the session's last successful value of 18%.
  const clock = new ManualClock(), data = sample(), app = await mount(data, clock, true);
  const spinner = () => app.renderer.root.findDescendantById("usage-loading") as TextRenderable;
  const spanAt = (column: number) => { let x = 0; return app.captureSpans().lines[app.row.y]!.spans.find(span => { x += span.width; return x > column; })!; };
  try {
    pressLeader(app, "a"); await app.mockInput.typeText("keep recovery draft");
    for (const light of [false, true]) {
      // Backoff 중의 상태 재전송과 테마 변경은 스피너나 마지막 바를 초기화하지 않는다.
      await app.set({ ...data, usage: { ...data.usage!, status: "error", errorCode: "USAGE_TIMEOUT" } });
      app.renderer.emit("palette", palette(light)); await app.renderOnce();
      const usage = app.line().slice(app.line().indexOf(icons.openai));
      const start = Bun.stringWidth(app.line().slice(0, app.line().indexOf("chatgpt ") + "chatgpt ".length));
      const styles = uiTheme(app.renderer).styles;

      // 마지막 채움은 보존하되 수치·단위·카운트다운은 숨기고 context는 정상 색으로 남긴다.
      expect(usage).toContain("▉▉▉▉▉▉▉▉"); expect(usage).not.toMatch(/18%|used|1h|-/);
      expect(spanAt(start).fg.toInts()).toEqual(styles["ui.muted"].fg.toInts());
      expect(spanAt(start + 7).fg.equals(spanAt(start).fg)).toBe(false);
      expect(spinner().visible).toBe(true); expect(spinnerFrames.some(frame => frame === spinner().plainText)).toBe(true);
      expect(spanAt(spinner().x).fg.toInts()).toEqual(styles["ui.muted"].fg.toInts());
      expect(app.line()).toContain("64% left");
      const before = spinner().plainText;
      clock.advance(80); await app.renderOnce(); expect(spinner().plainText).not.toBe(before);
    }
    clock.advance(60000); await app.renderOnce(); expect(spinner().visible).toBe(true);
    await app.set({ ...data, usage: { ...data.usage!, windows: [{ ...data.usage!.windows[0]!, usedPercent: 42 }] } });

    // 복구는 새 값을 즉시 표시하고 입력 초안이나 포커스를 건드리지 않는다.
    expect(app.line()).toContain("42% used"); expect(spinner().visible).toBe(false);
    expect(app.view.promptDrafts.a1).toBe("keep recovery draft");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
  } finally { await app.close(); }
});

test("첫 사용량 조회와 실패 후 대기는 이전 값이 없어도 스피너를 표시하고 성공값을 지연하지 않는다", async () => {
  // 앱을 막 켠 상태에는 보존할 사용량이 없으므로 가짜 퍼센트나 채움을 만들지 않는다.
  const clock = new ManualClock(), app = await createTestRenderer({ width: 100, height: 5, clock });
  const status = new SessionStatus(app.renderer); app.renderer.root.add(status.root);
  const data = sample(), spinner = () => status.root.findDescendantById("usage-loading") as TextRenderable;
  try {
    for (const state of ["loading", "error"] as const) {
      status.update({ ...data, usage: { ...unavailable(), status: state } }, true); await app.renderOnce();

      // 최초 실패도 재시도 대상이며 미지원 상태와 다르게 스피너가 유지된다.
      const line = app.captureCharFrame().split("\n")[spinner().y]!;
      expect(spinner().visible).toBe(true);
      expect(line.slice(line.indexOf(icons.openai))).not.toMatch(/▉|%|used|-/);
    }
    status.update(data, true); await app.renderOnce();

    // 공통 스피너의 최소 표시 시간 동안에도 새 성공값은 즉시 표시하고 겹치지 않는다.
    expect(app.captureCharFrame()).toContain("18% used 1h 0m");
    expect(spinner().visible).toBe(true);
    clock.advance(500); await app.renderOnce();
    expect(spinner().visible).toBe(false);
    // 스피너 숨김으로 예약된 렌더 프레임까지 소비한 뒤 애니메이션 누수를 확인한다.
    clock.advance(20); await app.renderOnce(); expect(clock.pendingTimerCount).toBe(0);
  } finally { status.dispose(); await app.dispose(); }
});

test("복구 중 리셋된 usage 창을 숨기고 화면·정적 이력·폐기에서는 스피너 타이머를 정리한다", async () => {
  // 만료된 성공값을 가진 오류 상태는 과거 채움을 현재 한도로 재사용해서는 안 된다.
  const clock = new ManualClock(), app = await createTestRenderer({ width: 100, height: 5, clock });
  const status = new SessionStatus(app.renderer); app.renderer.root.add(status.root);
  const data = sample(), now = Date.now();
  const failed: SessionTelemetry = { ...data, usage: { ...data.usage!, status: "error", errorCode: "USAGE_QUERY_FAILED",
    windows: [{ ...data.usage!.windows[0]!, resetsAt: now - 1 }] } };
  try {
    status.update(failed, true); await app.renderOnce(); clock.advance(20); await app.renderOnce();
    const line = app.captureCharFrame().split("\n")[status.root.y + 1]!;
    expect(line.slice(line.indexOf(icons.openai))).not.toContain("▉");
    expect(clock.pendingTimerCount).toBe(1);

    // 화면 변경의 렌더 프레임을 소비하면 복구 애니메이션 외의 타이머가 남지 않는다.
    status.update(failed, false); clock.advance(20); await app.renderOnce(); expect(clock.pendingTimerCount).toBe(0);
    status.update(failed, true, null, now); await app.renderOnce(); clock.advance(20); await app.renderOnce(); expect(clock.pendingTimerCount).toBe(0);
    status.update(failed, true); await app.renderOnce(); clock.advance(20); await app.renderOnce(); expect(clock.pendingTimerCount).toBe(1);
    status.dispose(); clock.advance(20); await app.renderOnce();

    expect(clock.pendingTimerCount).toBe(0);
  } finally { status.dispose(); await app.dispose(); }
});

test("실제 사용량 0%와 context 잔량 0%는 미확정 값과 다른 빈 바를 표시한다", async () => {
  const data = sample();
  const app = await mount({ ...data, context: { usedTokens: 200000, maxTokens: 200000 },
    usage: { ...data.usage!, windows: [{ ...data.usage!.windows[0]!, usedPercent: 0 }] } });
  try {
    await app.renderOnce();

    expect(app.line()).toContain("context ▉▉▉▉▉▉▉▉ 0%"); expect(app.line()).toContain("▉▉▉▉▉▉▉▉ 0% used");
    expect(app.line()).not.toContain("100%");
    const colors = uiTheme(app.renderer).colors;
    for (const span of app.captureSpans().lines[app.row.y]!.spans.filter((span) => span.text.includes("▉"))) {
      expect(span.fg.equals(colors.accent)).toBe(false); expect(span.bg.toInts()).toEqual(colors.panel.toInts());
    }
  } finally { await app.close(); }
});

test("이전 runtime의 weekly 응답도 used 기준으로 변환하고 새 제공자에는 맞는 아이콘을 사용한다", async () => {
  const data = sample(); const { usage: _usage, ...legacy } = data;
  const app = await mount({ ...legacy, weekly: { remainingPercent: 82, observedAt: Date.now(), resetsAt: Date.now() + 3600000 } });
  try {
    await app.renderOnce(); expect(app.line()).toContain("18% used");

    await app.set({ ...sample(), provider: "anthropic", usage: { ...unavailable(), provider: "anthropic" } });

    expect(app.line()).toContain(icons.claude); expect(app.line()).toContain("claude"); expect(app.line()).not.toContain("Claude"); expect(app.line()).not.toContain(icons.openai);
    await app.set({ ...sample(), provider: "openai" });
    expect(app.line()).toContain(icons.openai); expect(app.line()).toContain("openai"); expect(app.line()).not.toContain("OpenAI"); expect(app.line()).not.toContain("chatgpt");
  } finally { await app.close(); }
});

test("카운트다운은 로컬 시계로 갱신하고 리셋 뒤에는 새 한도를 임의로 채우지 않는다", async () => {
  const now = 1800000000000, reset = now + (5 * 24 + 23) * 3600000;
  const clock = spyOn(Date, "now").mockReturnValue(now), scheduled = spyOn(globalThis, "setTimeout");
  const app = await mount({ ...sample(), usage: { ...sample().usage!, windows: [{ id: "period", usedPercent: 10, periodMs: 604800000, resetsAt: reset }] } });
  const tick = () => {
    const index = scheduled.mock.calls.findLastIndex(([, delay]) => delay === 60000), result = scheduled.mock.results[index];
    const callback = scheduled.mock.calls[index]?.[0];
    if (!result || result.type !== "return" || typeof callback !== "function") throw new Error("Countdown did not acquire a local timer.");
    clearTimeout(result.value); callback();
  };
  try {
    expect(app.line()).toContain("10% used 5d 23h");

    clock.mockReturnValue(now + 3600000); tick(); await app.renderOnce();

    expect(app.line()).toContain("10% used 5d 22h");
    clock.mockReturnValue(reset + 1); tick(); await app.renderOnce();
    expect(app.line().slice(app.line().indexOf(icons.openai)).trim().replace(/\s+/g, " ")).toBe(`${icons.openai} chatgpt -`);
    expect(app.line()).not.toContain("100%");
  } finally { await app.close(); scheduled.mockRestore(); clock.mockRestore(); }
});

test("여러 사용량 창 중 긴 기간을 선택하고 제공자 이름이나 primary·secondary 순서에 의존하지 않는다", async () => {
  const now = Date.now();
  const app = await mount({ ...sample(), provider: "another-provider", usage: { provider: "another-provider", status: "ready", updatedAt: now, errorCode: null,
    windows: [{ id: "first", usedPercent: 90, periodMs: 18000000, resetsAt: now + 3600000 },
      { id: "second", usedPercent: 10, periodMs: 604800000, resetsAt: now + (5 * 24 + 23) * 3600000 }] } });
  try {
    app.resize(160, 24); await app.renderOnce();

    expect(app.line()).toContain("usage"); expect(app.line()).toContain("10% used 5d 23h");
    expect(app.line()).not.toContain("90% used"); expect(app.line()).not.toContain(icons.openai);
  } finally { await app.close(); }
});

test("숨기거나 제거하면 카운트다운 타이머를 정리한다", async () => {
  const scheduled = spyOn(globalThis, "setTimeout"), cleared = spyOn(globalThis, "clearTimeout");
  const app = await mount();
  const timer = () => {
    const index = scheduled.mock.calls.findLastIndex(([, delay]) => delay === 60000), result = scheduled.mock.results[index];
    if (!result || result.type !== "return") throw new Error("Countdown timer was not scheduled.");
    return result.value;
  };
  try {
    const hidden = timer(); app.selection.selectWorktree("demo:empty"); await app.renderOnce();
    expect(cleared).toHaveBeenCalledWith(hidden);

    app.selection.selectSession("demo:main", "a1"); await app.renderOnce(); const disposed = timer(); app.view.dispose();

    expect(cleared).toHaveBeenCalledWith(disposed);
  } finally { await app.close(); scheduled.mockRestore(); cleared.mockRestore(); }
});
