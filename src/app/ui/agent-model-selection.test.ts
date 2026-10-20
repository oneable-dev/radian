import { expect, test } from "bun:test";
import { InputRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { modelCommand, type ModelCatalog, type ModelIdentity } from "../../agents/model-selection.ts";
import type { ExecutionState } from "../../agents/session-registry.ts";
import { ModelSelectionError } from "../../errors.ts";
import { err, ok } from "../../result.ts";

const catalog: ModelCatalog = { conversationId: "first", current: { provider: "fixture", id: "original" }, models: [
  { provider: "fixture", id: "original", name: "Original model", contextWindow: 200000, images: true, reasoning: true },
  { provider: "other", id: "target", name: "Target model", contextWindow: 64000, images: false, reasoning: false },
] };
async function mount(overrides: Partial<WorkbenchActions> = {}) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 120, height: 28, kittyKeyboard: true, clock });
  const selection = new WorkspaceSelection(demoWorkspace()), sent: string[] = [], changes: { id: string; conversation: string; model: ModelIdentity }[] = [];
  let state: ExecutionState = { conversationId: "first", status: "complete", output: "Retained answer", error: null,
    telemetry: { provider: "fixture", model: "original", effort: "high", fast: false, context: null, weekly: null } };
  const view = new Workbench(app.renderer, selection, { onNewSession() {}, onCloseSession() {}, onPrompt: async (_id, text) => { sent.push(text); return ok(undefined); },
    onComplete: async () => ok({ items: [modelCommand], truncated: false }), getSessionDetails: () => state,
    onListModels: async () => ok(structuredClone(catalog)), onSelectModel: async (id, conversation, model) => {
      changes.push({ id, conversation, model });
      state = { ...state, telemetry: { ...state.telemetry!, provider: model.provider, model: model.id } };
      selection.replaceSnapshot(selection.snapshot); return ok(null);
    }, ...overrides });
  const get = (id: string) => { const item = app.renderer.root.findDescendantById(id); if (!item) throw new Error(`Missing ${id}`); return item; };
  const prompt = get("session-prompt") as InputRenderable;
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  await render(); prompt.focus(); await render();
  return { ...app, view, selection, sent, changes, get, prompt, render,
    async open(text = "/model") { await app.mockInput.typeText(text); await render(); clock.advance(150); await render(); app.mockInput.pressEnter(); await render(); },
    update(next: ExecutionState) { state = next; selection.replaceSnapshot(selection.snapshot); },
    async close() { view.dispose(); await app.dispose(); } };
}

test("model 자동완성을 실행하면 검색 팝업을 열고 선택한 세션의 모델만 변경하며 프롬프트를 보내지 않는다", async () => {
  // 명령은 모델 요청 대신 호스트 팝업을 열고 현재 모델을 식별해야 한다.
  const app = await mount();
  try {
    await app.open("/mod");
    expect(app.get("model-picker").visible).toBe(true); expect(app.captureCharFrame()).toContain("Original model [Current]");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("model-search"); expect(app.sent).toEqual([]);

    // provider 이름으로 검색한 뒤 Enter를 누르면 실제 모델 식별자를 적용한다.
    await app.mockInput.typeText("other"); await app.render(); app.mockInput.pressEnter(); await app.render();
    expect(app.changes).toEqual([{ id: "a1", conversation: "first", model: { provider: "other", id: "target" } }]);
    expect(app.get("model-picker").visible).toBe(false); expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    expect(app.captureCharFrame()).toContain("target"); expect(app.sent).toEqual([]); expect(app.prompt.value).toBe("");
  } finally { await app.close(); }
});

test("큰 모델 목록에서도 현재 모델을 맨 위에 표시하고 처음 Enter로 다른 모델을 오선택하지 않는다", async () => {
  const many = Array.from({ length: 205 }, (_, index) => ({ ...catalog.models[1]!, id: `extra-${index}`, name: `Extra model ${index}` }));
  const app = await mount({ onListModels: async () => ok({ ...catalog, models: [...many, ...catalog.models] }) });
  try {
    await app.open();
    expect(app.captureCharFrame()).toContain("Original model [Current]");

    // 표시 개수 상한 뒤에 있던 현재 모델도 초기 선택에서 빠지면 안 된다.
    app.mockInput.pressEnter(); await app.render();
    expect(app.changes[0]?.model).toEqual({ provider: "fixture", id: "original" });
    expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("모델 행을 클릭하면 식별자가 다른 모델을 한 번만 적용한다", async () => {
  const app = await mount();
  try {
    await app.open();
    const row = app.get('model:["other","target"]');

    // 클릭은 단순 탐색이 아니라 사용자가 명시적으로 선택한 모델을 적용한다.
    await app.mockMouse.click(row.x + 2, row.y); await app.render();
    expect(app.changes).toEqual([{ id: "a1", conversation: "first", model: { provider: "other", id: "target" } }]);
    expect(app.get("model-picker").visible).toBe(false); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("model 인수 오류는 팝업이나 유료 프롬프트로 우회하지 않고 입력을 유지한다", async () => {
  const app = await mount();
  try {
    await app.open("/model other/target");

    expect(app.get("model-picker").visible).toBe(false); expect(app.prompt.value).toBe("/model other/target");
    expect(app.captureCharFrame()).toContain("INVALID_INPUT"); expect(app.sent).toEqual([]); expect(app.changes).toEqual([]);
  } finally { await app.close(); }
});

test("팝업에서 Esc는 모델 변경이나 실행 중단 없이 닫고 원래 입력창으로 돌아간다", async () => {
  // 검색과 목록 포커스는 팝업 안에 머물고 실행 중인 배경의 Esc 명령은 실행되지 않는다.
  const interrupted: string[] = [];
  const app = await mount({ getSessionDetails: () => ({ conversationId: "first", status: "working", output: "Running work", error: null }),
    onInterrupt: async id => { interrupted.push(id); return ok(undefined); } });
  try {
    await app.open();
    app.mockInput.pressTab(); await app.render(); expect(app.renderer.currentFocusedRenderable?.id).toBe("model-list");
    app.mockInput.pressTab(); await app.render(); expect(app.renderer.currentFocusedRenderable?.id).toBe("model-search");
    app.mockInput.pressKey("e", { ctrl: true }); await app.render(); expect(app.renderer.currentFocusedRenderable?.id).toBe("model-search");

    app.mockInput.pressEscape(); await app.render();
    expect(app.get("model-picker").visible).toBe(false); expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    expect(app.changes).toEqual([]); expect(app.sent).toEqual([]); expect(interrupted).toEqual([]);
  } finally { await app.close(); }
});

test("닫은 팝업의 늦은 모델 목록은 무시하고 로딩 타이머를 즉시 정리한다", async () => {
  // 네트워크 경계만 지연시켜 팝업 수명보다 늦은 응답을 재현한다.
  const gate = Promise.withResolvers<ReturnType<typeof ok<ModelCatalog>>>(); let signal: AbortSignal | undefined;
  const app = await mount({ onListModels: async (_id, _conversation, abort) => { signal = abort; return gate.promise; } });
  try {
    await app.open(); expect(app.get("model-loading").visible).toBe(true);
    app.mockInput.pressEscape(); await app.render();
    expect(signal?.aborted).toBe(true); expect(app.get("model-loading").visible).toBe(false);

    gate.resolve(ok(catalog)); await app.render();
    expect(app.get("model-picker").visible).toBe(false); expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    expect(app.changes).toEqual([]);
  } finally { gate.resolve(ok(catalog)); await app.close(); }
});

test("모델 조회 실패·검색 결과 없음·미인증 빈 목록을 구분하고 새로 조회할 수 있다", async () => {
  let calls = 0;
  const app = await mount({ onListModels: async () => ++calls === 1 ? err(new ModelSelectionError("Fixture login unavailable")) : ok(catalog) });
  try {
    await app.open(); expect(app.captureCharFrame()).toContain("MODEL_UNAVAILABLE");
    expect(app.captureCharFrame()).not.toContain("No available models");

    app.mockInput.pressKey("r", { ctrl: true }); await app.render();
    await app.mockInput.typeText("no-such-model"); await app.render();
    expect(app.captureCharFrame()).toContain("No matching models"); app.mockInput.pressEnter(); await app.render();
    expect(app.changes).toEqual([]); expect(app.get("model-picker").visible).toBe(true);
  } finally { await app.close(); }
  const empty = await mount({ onListModels: async () => ok({ ...catalog, models: [] }) });
  try { await empty.open(); expect(empty.captureCharFrame()).toContain("No available models"); }
  finally { await empty.close(); }
});

test.each(["tab", "conversation"] as const)("선택 처리 중 %s이 바뀌면 팝업을 닫고 늦은 성공으로 포커스를 되돌리지 않는다", async (change) => {
  const gate = Promise.withResolvers<ReturnType<typeof ok<null>>>();
  const app = await mount({ onSelectModel: async () => gate.promise });
  try {
    await app.open(); app.mockInput.pressArrow("down"); app.mockInput.pressEnter(); await app.render();
    if (change === "tab") app.selection.selectSession("demo:main", "a2");
    else app.update({ conversationId: "replacement", status: null, output: "", error: null });
    await app.render();
    expect(app.get("model-picker").visible).toBe(false);
    const focus = app.renderer.currentFocusedRenderable;

    gate.resolve(ok(null)); await app.render();
    expect(app.selection.sessionId).toBe(change === "tab" ? "a2" : "a1"); expect(app.renderer.currentFocusedRenderable).toBe(focus);
    expect(app.sent).toEqual([]);
  } finally { gate.resolve(ok(null)); await app.close(); }
});

test("좁은 화면에서도 모델 팝업은 화면 안에 머물고 검색한 내용을 리사이즈 후 보존한다", async () => {
  const app = await mount();
  try {
    await app.open(); await app.mockInput.typeText("target"); await app.render();
    app.resize(46, 12); await app.render();
    const panel = app.get("model-dialog");
    expect(panel.x).toBeGreaterThanOrEqual(0); expect(panel.y).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(46); expect(panel.y + panel.height).toBeLessThanOrEqual(12);
    expect(app.captureCharFrame()).toContain("Target model");

    app.resize(120, 28); await app.render();
    expect((app.get("model-search") as InputRenderable).value).toBe("target"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});
