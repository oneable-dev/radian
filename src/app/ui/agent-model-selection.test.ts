import { expect, test } from "bun:test";
import { InputRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { modelCommand, type ModelCatalog, type ModelEffort, type ModelIdentity } from "../../agents/model-selection.ts";
import type { ExecutionState } from "../../agents/session-registry.ts";
import { ModelSelectionError } from "../../errors.ts";
import { err, ok } from "../../result.ts";

const catalog: ModelCatalog = { conversationId: "first", current: { provider: "fixture", id: "original" }, effort: "high", models: [
  { provider: "fixture", id: "original", name: "Original model", contextWindow: 200000, images: true, reasoning: true, efforts: ["off", "low", "medium", "high"], effort: "high" },
  { provider: "other", id: "target", name: "Target model", contextWindow: 64000, images: false, reasoning: false, efforts: ["off"], effort: "off" },
] };
async function mount(overrides: Partial<WorkbenchActions> = {}) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 120, height: 28, kittyKeyboard: true, clock });
  const selection = new WorkspaceSelection(demoWorkspace()), sent: string[] = [], changes: { id: string; conversation: string; model: ModelIdentity; effort?: ModelEffort }[] = [];
  let state: ExecutionState = { conversationId: "first", status: "complete", output: "Retained answer", error: null,
    telemetry: { provider: "fixture", model: "original", effort: "high", fast: false, context: null, weekly: null } };
  const view = new Workbench(app.renderer, selection, { onNewSession() {}, onCloseSession() {}, onPrompt: async (_id, text) => { sent.push(text); return ok(undefined); },
    onComplete: async () => ok({ items: [modelCommand], truncated: false }), getSessionDetails: () => state,
    onListModels: async () => ok(structuredClone(catalog)), onSelectModel: async (id, conversation, model, effort) => {
      changes.push({ id, conversation, model, ...(effort !== undefined ? { effort } : {}) });
      state = { ...state, telemetry: { ...state.telemetry!, provider: model.provider, model: model.id, effort: effort ?? state.telemetry!.effort } };
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
    expect(app.renderer.currentFocusedRenderable?.id).toBe("model-list"); expect(app.sent).toEqual([]);

    // 목록에서 /로 검색에 진입한 뒤 Enter를 누르면 모델과 표시된 effort를 함께 적용한다.
    app.mockInput.pressKey("/"); await app.render(); await app.mockInput.typeText("other"); await app.render(); app.mockInput.pressEnter(); await app.render();
    expect(app.changes).toEqual([{ id: "a1", conversation: "first", model: { provider: "other", id: "target" }, effort: "off" }]);
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

test("모델 행 클릭은 미리 선택만 하고 Apply를 눌러야 한 번만 적용한다", async () => {
  const app = await mount();
  try {
    await app.open();
    const row = app.get('model:["other","target"]');

    // 모델 클릭만으로는 적용하지 않고 effort를 확인한 뒤 Apply로 확정한다.
    await app.mockMouse.click(row.x + 2, row.y); await app.render();
    expect(app.changes).toEqual([]); expect(app.get("model-picker").visible).toBe(true);
    const apply = app.get("model-apply"); await app.mockMouse.click(apply.x + 1, apply.y); await app.render();
    expect(app.changes).toEqual([{ id: "a1", conversation: "first", model: { provider: "other", id: "target" }, effort: "off" }]);
    expect(app.get("model-picker").visible).toBe(false); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("j/k와 h/l로 모델·effort를 미리 고르고 Tab 영역 이동 후 한 번에 적용한다", async () => {
  // 목록에 포커스한 상태에서도 h/l로 현재 모델의 effort만 조절할 수 있다.
  const app = await mount();
  try {
    await app.open(); expect(app.renderer.currentFocusedRenderable?.id).toBe("model-list");
    app.mockInput.pressKey("h"); await app.render(); expect(app.captureCharFrame()).toContain("[medium]");
    app.mockInput.pressKey("j"); await app.render(); expect(app.captureCharFrame()).toContain("not supported (off)");
    app.mockInput.pressKey("k"); await app.render(); expect(app.captureCharFrame()).toContain("[medium]");

    // 모델을 왕복해도 미리 고른 effort를 보존하고 방향키도 h/l과 같은 보조 입력으로 지원한다.
    app.mockInput.pressTab(); await app.render(); expect(app.renderer.currentFocusedRenderable?.id).toBe("model-effort");
    app.mockInput.pressKey("h"); await app.render(); expect(app.captureCharFrame()).toContain("[low]");
    app.mockInput.pressKey("l"); app.mockInput.pressArrow("right"); await app.render(); expect(app.captureCharFrame()).toContain("[high]");
    app.mockInput.pressArrow("left"); await app.render(); expect(app.captureCharFrame()).toContain("[medium]");
    expect(app.changes).toEqual([]);
    app.mockInput.pressEnter(); await app.render();

    expect(app.changes).toEqual([{ id: "a1", conversation: "first", model: { provider: "fixture", id: "original" }, effort: "medium" }]);
    expect(app.sent).toEqual([]); expect(app.get("model-picker").visible).toBe(false);
  } finally { await app.close(); }
});

test("검색 창의 hjkl은 검색 문자이고 Ctrl+N/P만 목록을 이동한다", async () => {
  const app = await mount();
  try {
    await app.open(); app.mockInput.pressKey("/"); await app.render();
    await app.mockInput.typeText("hjkl"); await app.render();
    expect((app.get("model-search") as InputRenderable).value).toBe("hjkl");
    for (let index = 0; index < 4; index++) app.mockInput.pressBackspace();
    await app.mockInput.typeText("model"); await app.render();

    app.mockInput.pressKey("n", { ctrl: true }); app.mockInput.pressKey("p", { ctrl: true }); app.mockInput.pressKey("n", { ctrl: true });
    app.mockInput.pressEnter(); await app.render();

    expect(app.changes).toEqual([{ id: "a1", conversation: "first", model: { provider: "other", id: "target" }, effort: "off" }]);
    expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("지원하는 effort만 표시하고 SDK가 보정한 미리 선택 값을 적용 전에 확인할 수 있다", async () => {
  const app = await mount({ onListModels: async () => ok({ ...catalog, models: [catalog.models[0]!,
    { ...catalog.models[1]!, reasoning: true, efforts: ["low", "medium"], effort: "medium" }] }) });
  try {
    await app.open(); app.mockInput.pressKey("j"); await app.render();

    expect(app.captureCharFrame()).toContain("[medium]"); expect(app.captureCharFrame()).not.toContain("[high]");
    expect(app.renderer.root.findDescendantById("model-effort:high")).toBeUndefined();
    expect(app.changes).toEqual([]);
    app.mockInput.pressKey("h"); app.mockInput.pressEnter(); await app.render();

    expect(app.changes[0]?.effort).toBe("low"); expect(app.changes[0]?.model.provider).toBe("other");
  } finally { await app.close(); }
});

test("모델·effort 미리 선택을 Esc로 버리면 다시 열 때 현재 조합으로 시작한다", async () => {
  const app = await mount();
  try {
    await app.open(); app.mockInput.pressKey("h"); app.mockInput.pressKey("j"); await app.render();
    app.mockInput.pressEscape(); await app.render();

    expect(app.changes).toEqual([]); expect(app.sent).toEqual([]);
    await app.open(); expect(app.captureCharFrame()).toContain("[high]");
    expect(app.captureCharFrame()).toContain("Original model [Current]");
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
    app.mockInput.pressTab(); await app.render(); expect(app.renderer.currentFocusedRenderable?.id).toBe("model-effort");
    app.mockInput.pressTab(); await app.render(); expect(app.renderer.currentFocusedRenderable?.id).toBe("model-list");
    app.mockInput.pressKey("e", { ctrl: true }); await app.render(); expect(app.renderer.currentFocusedRenderable?.id).toBe("model-list");

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
    app.mockInput.pressKey("/"); await app.render(); await app.mockInput.typeText("no-such-model"); await app.render();
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

test("좁은 화면의 많은 effort 옵션도 줄바꿈해 화면 안에서 선택하고 적용한다", async () => {
  // 최대 지원 범위를 가진 모델에서도 선택 버튼이 팝업 밖으로 밀려나면 안 된다.
  const app = await mount({ onListModels: async () => ok({ ...catalog, models: [{ ...catalog.models[0]!,
    efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] }] }) });
  try {
    await app.open(); app.resize(46, 12); await app.render();
    const panel = app.get("model-dialog"), maximum = app.get("model-effort:max");

    await app.mockMouse.click(maximum.x + 1, maximum.y); await app.render();

    expect(maximum.y + maximum.height).toBeLessThan(panel.y + panel.height);
    expect(maximum.x + maximum.width).toBeLessThan(panel.x + panel.width);
    expect(app.captureCharFrame()).toContain("[max]"); expect(app.changes).toEqual([]);
    app.mockInput.pressEnter(); await app.render(); expect(app.changes[0]?.effort).toBe("max");
  } finally { await app.close(); }
});

test("좁은 화면에서도 모델 팝업은 화면 안에 머물고 검색한 내용을 리사이즈 후 보존한다", async () => {
  const app = await mount();
  try {
    await app.open(); app.mockInput.pressKey("/"); await app.render(); await app.mockInput.typeText("target"); await app.render();
    app.resize(46, 12); await app.render();
    const panel = app.get("model-dialog");
    expect(panel.x).toBeGreaterThanOrEqual(0); expect(panel.y).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(46); expect(panel.y + panel.height).toBeLessThanOrEqual(12);
    expect(app.captureCharFrame()).toContain("Target model");

    app.resize(120, 28); await app.render();
    expect((app.get("model-search") as InputRenderable).value).toBe("target"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});
