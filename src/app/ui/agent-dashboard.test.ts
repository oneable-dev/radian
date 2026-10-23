import { expect, test } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { emptyDashboard, type DashboardPeriod, type DashboardSnapshot } from "../../agents/dashboard.ts";
import { PromptInput } from "../../ui/prompt-input.ts";
import { SessionError } from "../../errors.ts";
import { err, ok, type Result } from "../../result.ts";
import { parseKeymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { Workbench, type WorkbenchActions } from "./workbench.ts";

function sample(days: DashboardPeriod = 7): DashboardSnapshot {
  const data = emptyDashboard(days);
  data.totals = { tokens: 1240, runs: 9, durationMs: 65000 }; Object.assign(data.daily.at(-1)!, data.totals);
  data.skills = [{ name: "write-good-code", value: 42 }, { name: "review-code", value: 18 }];
  data.models = [{ name: "test/large", value: 1240 }]; data.mcp = [{ name: "figma-remote", value: 12 }]; data.subagents = [{ name: "reviewer", value: 3 }];
  return data;
}
async function mount(options: Partial<WorkbenchActions> = {}, width = 120, height = 32) {
  const clock = new ManualClock(), app = await createTestRenderer({ width, height, kittyKeyboard: true, clock });
  const lookups: { days: DashboardPeriod; project: string | undefined; signal: AbortSignal | undefined }[] = [], sent: string[] = [];
  const view = new Workbench(app.renderer, new WorkspaceSelection(demoWorkspace()), { onNewSession() {}, onCloseSession() {},
    getSessionDetails: () => ({ conversationId: "conversation", status: "complete", output: "Answer", error: null }),
    onPrompt: (_id, text) => { sent.push(text); return ok(undefined); },
    onDashboard: async (days, project, signal) => { lookups.push({ days, project, signal }); return ok(sample(days)); }, ...options });
  const render = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await app.renderOnce(); await app.renderOnce(); };
  await render();
  const input = app.renderer.root.findDescendantById("session-prompt");
  if (!(input instanceof PromptInput)) throw new Error("Missing prompt"); input.focus();
  const get = (id: string) => { const node = app.renderer.root.findDescendantById(id); if (!node) throw new Error(`Missing ${id}`); return node; };
  return { ...app, view, input, lookups, sent, render, get,
    async open() { app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("u"); await render(); },
    async close() { view.dispose(); await app.dispose(); } };
}

test("dashboard 명령은 대화 전송 없이 화면만 열고 인수·첨부가 있으면 원문을 유지한다", async () => {
  // 명령 실행과 일반 대화 제출이 같은 입력 경로를 지나더라도 구분한다.
  const app = await mount();
  try {
    app.input.value = "/dashboard"; await app.render();

    // 명시 명령은 입력을 소비하고 통계 조회만 수행한다.
    app.mockInput.pressEnter(); await app.render();
    expect(app.get("agent-dashboard").visible).toBe(true); expect(app.input.value).toBe(""); expect(app.sent).toEqual([]);
    app.mockInput.pressEscape(); await app.render();
    app.input.value = "/dashboard recent"; await app.render(); app.mockInput.pressEnter(); await app.render();

    // 잘못된 인수는 모델에 전달하거나 조용히 버리지 않는다.
    expect(app.input.value).toBe("/dashboard recent"); expect(app.get("agent-dashboard").visible).toBe(false); expect(app.sent).toEqual([]);
    app.input.value = "/dashboard "; app.input.attachFile("/tmp/dashboard-fixture.png"); const draft = app.input.draft;
    await app.render(); app.mockInput.pressEnter(); await app.render();
    expect(app.input.draft).toEqual(draft); expect(app.get("agent-dashboard").visible).toBe(false); expect(app.lookups).toHaveLength(1);
  } finally { await app.close(); }
});

test("새 필터의 응답이 먼저 끝나면 이전 조회가 현재 통계를 덮어쓰지 않는다", async () => {
  // 느린 7일 조회와 빠른 30일 조회를 서로 다른 결과로 준비한다.
  const old = Promise.withResolvers<Result<DashboardSnapshot, SessionError>>();
  const app = await mount({ onDashboard: async days => { if (days === 7) return old.promise; const data = sample(days); data.totals.tokens = 9999; return ok(data); } });
  try {
    await app.open(); app.get("dashboard-period").focus();

    // 먼저 시작한 요청보다 새 필터의 결과를 우선한다.
    app.mockInput.pressKey("n", { ctrl: true }); await app.render(); expect(app.captureCharFrame()).toContain("9,999");
    old.resolve(ok(sample(7))); await app.render();

    // 늦은 결과가 이전 기간의 숫자나 포커스를 되살리지 않는다.
    expect(app.captureCharFrame()).toContain("9,999"); expect(app.renderer.currentFocusedRenderable?.id).toBe("dashboard-period");
  } finally { old.resolve(ok(sample(7))); await app.close(); }
});

test("대시보드는 세 요약 지표와 그래프를 표시하고 닫으면 기존 초안과 입력 포커스를 보존한다", async () => {
  // 통계를 여는 작업이 대화나 초안을 소비하지 않도록 실제 Workbench에서 시작한다.
  const app = await mount();
  try {
    app.input.value = "Retained draft";

    // 전역 단축키로 읽기 전용 통계를 열고 닫는다.
    await app.open();
    const frame = app.captureCharFrame();
    expect(frame).toContain("Agent Dashboard"); expect(frame).toContain("Total tokens"); expect(frame).toContain("Total run time");
    expect(frame).toContain("1,240"); expect(frame).toContain("1m 5s"); expect(frame).toContain("write-good-code"); expect(frame).toContain("█");
    app.mockInput.pressEscape(); await app.render();

    // 모델 실행 없이 원래 입력 소유권으로 돌아온다.
    expect(app.lookups.map(query => query.days)).toEqual([7]); expect(app.sent).toEqual([]);
    expect(app.get("agent-dashboard").visible).toBe(false); expect(app.input.value).toBe("Retained draft"); expect(app.renderer.currentFocusedRenderable).toBe(app.input);
  } finally { await app.close(); }
});

test("리소스 탭은 Ctrl+N/P와 좌우 탐색을 반복해도 포커스를 유지하고 올바른 사용량 단위를 표시한다", async () => {
  // 각 탭은 서로 다른 단위와 데이터를 같은 막대그래프 형식으로 보여준다.
  const app = await mount();
  try {
    await app.open();

    // 탭 스트립 안에서 연속 이동한다.
    app.mockInput.pressKey("n", { ctrl: true }); await app.render();
    expect(app.captureCharFrame()).toContain("test/large"); expect(app.captureCharFrame()).toContain("Model usage · tokens");
    app.mockInput.pressKey("ARROW_RIGHT"); await app.render(); expect(app.captureCharFrame()).toContain("figma-remote");
    app.mockInput.pressKey("l"); await app.render(); expect(app.captureCharFrame()).toContain("reviewer");
    app.mockInput.pressKey("p", { ctrl: true }); app.mockInput.pressKey("ARROW_LEFT"); await app.render();

    // 탐색 키를 한 번 썼다고 본문으로 포커스가 넘어가지 않으며 힌트에 맨 화살표 키는 없다.
    expect(app.renderer.currentFocusedRenderable?.id).toBe("dashboard-category"); expect(app.captureCharFrame()).toContain("test/large");
    const footer = app.captureCharFrame().split("\n").at(-2) ?? "";
    expect(footer).not.toContain("Right"); expect(footer).not.toContain("Left");
  } finally { await app.close(); }
});

test("기간과 프로젝트를 바꾸면 범위별로 다시 집계하고 반 페이지 탐색은 읽기 본문을 스크롤한다", async () => {
  // 긴 순위 목록은 화면 크기와 무관하게 스크롤로 읽을 수 있어야 한다.
  const queries: [DashboardPeriod, string | undefined][] = [];
  const app = await mount({ onDashboard: async (days, project) => { queries.push([days, project]); const data = sample(days); data.skills = Array.from({ length: 80 }, (_, i) => ({ name: `skill-${i}`, value: 80 - i })); return ok(data); } });
  try {
    await app.open(); app.get("dashboard-period").focus(); app.mockInput.pressKey("n", { ctrl: true }); await app.render();
    expect(app.captureCharFrame()).toContain("30 days");
    app.get("dashboard-project").focus(); app.mockInput.pressKey("n", { ctrl: true }); await app.render();
    expect(app.captureCharFrame()).not.toContain("Project ‹ All projects ›");
    expect(queries).toEqual([[7, undefined], [30, undefined], [30, "demo:radian"]]);

    // 필터에서 반 페이지 이동하면 본문 소유권으로 넘어가고 이어서 계속 스크롤한다.
    app.mockInput.pressKey("d", { ctrl: true }); await app.render();
    const body = app.get("dashboard-body"); if (!(body instanceof ScrollBoxRenderable)) throw new Error("Missing scroll body");
    const first = body.scrollTop; app.mockInput.pressKey("d", { ctrl: true }); await app.render();

    // 키 입력이 원래 Agent 초안에 새어나가지 않는다.
    expect(app.renderer.currentFocusedRenderable).toBe(body); expect(first).toBeGreaterThan(0); expect(body.scrollTop).toBeGreaterThan(first); expect(app.input.value).toBe("");
  } finally { await app.close(); }
});

test("사용자 탐색 키 재정의는 대시보드 동작과 푸터 힌트에 함께 적용된다", async () => {
  // 기본 Ctrl+N을 명시적으로 대체한 설정을 유지한다.
  const keymap = expectOk(parseKeymap({ bindings: { "dashboard.next": [{ keys: "q", scope: "dashboard-tabs" }] } }));
  const app = await mount({ keymap });
  try {
    await app.open();

    // 기존 키는 탭을 바꾸지 않고 설정된 키만 작동한다.
    app.mockInput.pressKey("n", { ctrl: true }); await app.render(); expect(app.captureCharFrame()).toContain("write-good-code");
    app.mockInput.pressKey("q"); await app.render();

    // 화면과 실제 키 동작이 일치한다.
    expect(app.captureCharFrame()).toContain("test/large"); expect(app.captureCharFrame()).toContain("q Next");
  } finally { await app.close(); }
});

test("닫힌 화면의 느린 응답은 화면을 되살리지 않고 spinner와 요청을 취소한다", async () => {
  // 사용자가 결과보다 먼저 화면을 닫을 수 있는 지연된 조회를 준비한다.
  const pending = Promise.withResolvers<Result<DashboardSnapshot, SessionError>>(); let signal: AbortSignal | undefined;
  const app = await mount({ onDashboard: async (_days, _project, abort) => { signal = abort; return pending.promise; } });
  try {
    await app.open(); expect(app.get("dashboard-loading").visible).toBe(true);

    // 읽기 요청이 끝나기 전에 닫고 이후 응답을 전달한다.
    app.mockInput.pressEscape(); await app.render(); pending.resolve(ok(sample())); await app.render();

    // 취소된 소유자가 후속 응답으로 포커스나 화면을 탈취하지 않는다.
    expect(signal?.aborted).toBe(true); expect(app.get("dashboard-loading").visible).toBe(false);
    expect(app.get("agent-dashboard").visible).toBe(false); expect(app.renderer.currentFocusedRenderable).toBe(app.input);
  } finally { pending.resolve(err(new SessionError("SESSION_BUSY", "Cancelled fixture"))); await app.close(); }
});

test("좁은 터미널에서도 빈 통계와 조회 실패를 구분하고 그래프는 잘못된 값을 만들지 않는다", async () => {
  // 기록이 없다는 결과와 조회 자체 실패는 구분해야 한다.
  let fail = false;
  const app = await mount({ onDashboard: async days => fail ? err(new SessionError("SESSION_BUSY", "Lookup failed")) : ok(emptyDashboard(days)) }, 50, 18);
  try {
    await app.open(); expect(app.captureCharFrame()).toContain("Agent Dashboard"); expect(app.captureCharFrame()).not.toContain("NaN");
    app.get("dashboard-body").focus(); app.mockInput.pressKey("END"); await app.render();
    expect(app.captureCharFrame()).toContain("No recorded usage");

    // 재조회 실패 시 기존 숫자나 가짜 0으로 성공처럼 보이게 하지 않는다.
    fail = true; app.mockInput.pressKey("r"); await app.render();

    expect(app.captureCharFrame()).toContain("SESSION_BUSY"); expect(app.captureCharFrame()).not.toContain("NaN");
  } finally { await app.close(); }
});
