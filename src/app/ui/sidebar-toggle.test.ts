import { expect, test } from "bun:test";
import { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { ok } from "../../result.ts";
import { parseKeymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";

async function mount(actions: Partial<WorkbenchActions> = {}) {
  const clock = new ManualClock(), app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true, clock });
  const selection = new WorkspaceSelection(demoWorkspace()), requests: string[] = [];
  const view = new Workbench(app.renderer, selection, { onNewSession: () => requests.push("new"), onCloseSession: () => requests.push("close"),
    onPrompt: () => { requests.push("prompt"); return ok(undefined); }, initialDrafts: { a1: "main draft" },
    getSessionDetails: () => ({ status: "complete", error: null, output: Array.from({ length: 100 }, (_, i) => `LINE-${i}`).join("\n") }), ...actions });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  await render();
  const get = (id: string) => { const node = app.renderer.root.findDescendantById(id); if (!node) throw new Error(`Missing ${id}`); return node; };
  return { ...app, clock, view, selection, requests, get, render,
    leader(key: string) { app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey(key); },
    async toggle() { app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("b"); await render(); },
    async close() { view.dispose(); await app.dispose(); } };
}

test("기존 leader b는 작업 영역 크기를 바꾸지 않고 워크스페이스 팝업만 토글한다", async () => {
  // 이전 사용자 설정의 명령 ID를 유지하되 영구 패널은 만들지 않는다.
  const app = await mount();
  try {
    const pane = app.get("work-panel"), tree = app.get("workspace-tree");
    expect(app.get("workspace-picker").visible).toBe(false); expect(pane.width).toBe(120);

    await app.toggle(); expect(app.get("workspace-picker").visible).toBe(true); expect(pane.width).toBe(120);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-search");
    await app.toggle();

    expect(app.get("workspace-picker").visible).toBe(false); expect(pane.width).toBe(120); expect(app.get("workspace-tree")).toBe(tree);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("팝업 취소는 원래 입력 커서와 대화 스크롤을 보존한다", async () => {
  // 팝업 개폐가 기존 Agent renderable을 재생성하면 안 된다.
  const app = await mount();
  try {
    const prompt = app.get("session-prompt") as InputRenderable, scroll = app.get("session-transcript") as ScrollBoxRenderable;
    prompt.focus(); scroll.scrollTo(31); await app.render(); const top = scroll.scrollTop, cursor = prompt.cursorOffset;

    await app.toggle(); app.mockInput.pressEscape(); await app.render();

    expect(app.renderer.currentFocusedRenderable).toBe(prompt); expect(prompt.cursorOffset).toBe(cursor); expect(scroll.scrollTop).toBe(top);
    expect(app.view.promptDrafts.a1).toBe("main draft"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("닫힌 팝업은 Tab 대상에서 제외되고 기존 검색·탐색 명령으로 다시 열린다", async () => {
  // 숨겨진 네비게이션에 키 입력이 들어가지 않도록 실제 focus traversal을 확인한다.
  const app = await mount();
  try {
    for (let i = 0; i < 8; i++) { app.mockInput.pressTab(); await app.render(); expect(["workspace-search", "workspace-tree"]).not.toContain(app.renderer.currentFocusedRenderable?.id ?? ""); }

    app.leader("w"); await app.render();
    expect(app.get("workspace-picker").visible).toBe(true); expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-search");
    app.mockInput.pressEscape(); await app.render(); app.mockInput.pressKey("f", { ctrl: true }); await app.render();

    expect(app.get("workspace-picker").visible).toBe(true); expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-search");
  } finally { await app.close(); }
});

test("History가 열려 있으면 다른 팝업 명령은 목록·스크롤·선택을 바꾸지 않는다", async () => {
  // 모달이 겹쳐 보이지 않는 입력 대상이 생기는 것을 막는다.
  let lookups = 0;
  const app = await mount({ onListHistory: async () => { lookups++; return ok(Array.from({ length: 30 }, (_, i) => ({ id: `saved-${i}`, title: `Saved-${i}`, worktreeId: "demo:main", modified: "2026-10-17T00:00:00Z", messageCount: 1, openSessionId: null, unavailableReason: null }))); } });
  try {
    app.leader("h"); await app.render(); const list = app.get("history-list") as ScrollBoxRenderable;
    list.scrollTo(20); await app.render(); const top = list.scrollTop;

    app.leader("b"); app.leader("s"); await app.render();

    expect(app.get("workspace-picker").visible).toBe(false); expect(app.get("session-monitor").visible).toBe(false);
    expect(list.scrollTop).toBe(top); expect(lookups).toBe(1); expect(app.selection.sessionId).toBe("a1");
  } finally { await app.close(); }
});

test("팝업 개폐와 연결 복구만으로 닫힌 History를 조회하지 않는다", async () => {
  // workspace picker는 세션 파일 I/O를 수행할 이유가 없다.
  let lookups = 0;
  const app = await mount({ onListHistory: async () => { lookups++; return ok([]); } });
  try {
    await app.toggle(); await app.toggle(); app.view.refreshHistory(); await app.render();

    expect(lookups).toBe(0); expect(app.get("history-loading").visible).toBe(false);
    app.leader("h"); await app.render(); expect(lookups).toBe(1);
  } finally { await app.close(); }
});

test("늦은 History 응답은 닫힌 팝업을 다시 열거나 선택을 바꾸지 않는다", async () => {
  // 비동기 조회의 완료와 사용자 취소를 분리한다.
  const pending = Promise.withResolvers<ReturnType<typeof ok<never[]>>>();
  const app = await mount({ onListHistory: () => pending.promise });
  try {
    app.leader("h"); await app.render(); app.mockInput.pressEscape(); await app.render();
    pending.resolve(ok([])); await app.render();

    expect(app.get("session-history").visible).toBe(false); expect(app.selection.sessionId).toBe("a1"); expect(app.requests).toEqual([]);
  } finally { pending.resolve(ok([])); await app.close(); }
});

test("기존 sidebar.toggle 키 재할당도 팝업 개폐에 적용된다", async () => {
  // 설정 파일을 깨뜨리지 않고 새 화면으로 기존 명령을 연결한다.
  const app = await mount({ keymap: expectOk(parseKeymap({ bindings: { "sidebar.toggle": ["alt+b"] } })) });
  try {
    app.leader("b"); await app.render(); expect(app.get("workspace-picker").visible).toBe(false);

    app.mockInput.pressKey("b", { meta: true }); await app.render(); expect(app.get("workspace-picker").visible).toBe(true);
    app.mockInput.pressKey("b", { meta: true }); await app.render();

    expect(app.get("workspace-picker").visible).toBe(false); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});
