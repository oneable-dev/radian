import { expect, test } from "bun:test";
import { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { ok } from "../../result.ts";
import { parseKeymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";
import type { EditorFrame } from "../../runtime/protocol.ts";

async function mount(actions: Partial<WorkbenchActions> = {}) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true, clock });
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

test("접기 아이콘 없이 같은 단축키로 좌측 패널을 접고 다시 펼치며 너비와 선택을 복원한다", async () => {
  // The sidebar's component instances stay alive while their space is given to the work pane.
  const app = await mount();
  try {
    const sidebar = app.get("workspace-sidebar"), pane = app.get("work-panel"), width = pane.width;
    const tree = app.get("workspace-tree"), selected = app.selection.sessionId;
    expect(app.renderer.root.findDescendantById("sidebar-toggle")).toBeUndefined();
    expect(app.captureCharFrame()).not.toContain("≡");

    await app.toggle();

    expect(sidebar.visible).toBe(false); expect(pane.x).toBe(0); expect(pane.width).toBe(120);
    expect(app.captureCharFrame()).not.toContain("Search repo/worktree/branch");
    expect(app.captureCharFrame()).toContain("main draft"); expect(app.selection.sessionId).toBe(selected);
    await app.toggle();
    expect(sidebar.visible).toBe(true); expect(pane.width).toBe(width); expect(app.get("workspace-tree")).toBe(tree);
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("leader b 왕복은 프롬프트 포커스·커서·초안과 대화 스크롤을 유지한다", async () => {
  const app = await mount();
  try {
    const prompt = app.get("session-prompt") as InputRenderable, scroll = app.get("session-transcript") as ScrollBoxRenderable;
    prompt.focus(); scroll.scrollTo(31); await app.render(); const top = scroll.scrollTop, cursor = prompt.cursorOffset;

    app.leader("b"); await app.render();
    expect(app.get("workspace-sidebar").visible).toBe(false);
    app.leader("b"); await app.render();

    expect(app.get("workspace-sidebar").visible).toBe(true); expect(app.renderer.currentFocusedRenderable).toBe(prompt);
    expect(prompt.cursorOffset).toBe(cursor); expect(app.view.promptDrafts.a1).toBe("main draft"); expect(scroll.scrollTop).toBe(top);
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("숨긴 패널은 Tab 대상에서 빠지고 검색·사이드바 포커스 명령은 패널을 다시 연다", async () => {
  // Focus must never remain inside a hidden navigation control.
  const app = await mount();
  try {
    const sidebar = app.get("workspace-sidebar");
    app.leader("b"); await app.render();
    expect(app.renderer.currentFocusedRenderable?.parent?.parent).toBe(app.get("work-panel"));
    for (let index = 0; index < 8; index++) {
      app.mockInput.pressTab(); await app.render();
      for (let node = app.renderer.currentFocusedRenderable; node; node = node.parent as typeof node) expect(node).not.toBe(sidebar);
    }

    app.mockInput.pressKey("f", { ctrl: true }); await app.render();
    expect(sidebar.visible).toBe(true); expect(app.renderer.currentFocusedRenderable).toBe(app.get("workspace-search"));
    app.leader("b"); await app.render(); app.leader("w"); await app.render();
    expect(sidebar.visible).toBe(true); expect(app.renderer.currentFocusedRenderable).toBe(app.get("workspace-tree"));
  } finally { await app.close(); }
});

test("History의 현재 목록과 스크롤은 접기 왕복만으로 재조회하거나 초기화하지 않는다", async () => {
  let lookups = 0;
  const app = await mount({ onListHistory: async () => { lookups++; return ok(Array.from({ length: 30 }, (_, i) => ({ id: `saved-${i}`,
    title: `Saved-${i}`, worktreeId: "demo:main", modified: "2026-10-17T00:00:00Z", messageCount: 1, openSessionId: null, unavailableReason: null }))); } });
  try {
    const lines = app.captureCharFrame().split("\n"), y = lines.findIndex((line) => line.includes("History"));
    await app.mockMouse.click(lines[y]!.indexOf("History"), y); await app.render();
    const list = app.get("history-list") as ScrollBoxRenderable; list.scrollTo(20); await app.render();
    const top = list.scrollTop, row = app.get("history:saved-10");

    await app.toggle(); await app.toggle();

    expect(lookups).toBe(1); expect(list.scrollTop).toBe(top); expect(app.get("history:saved-10")).toBe(row);
    expect(app.captureCharFrame()).toContain("Saved-10"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("접힌 History는 연결 복구 갱신을 펼칠 때까지 미루고 숨은 스피너를 실행하지 않는다", async () => {
  let lookups = 0;
  const app = await mount({ onListHistory: async () => { lookups++; return ok([]); } });
  try {
    const lines = app.captureCharFrame().split("\n"), y = lines.findIndex((line) => line.includes("History"));
    await app.mockMouse.click(lines[y]!.indexOf("History"), y); await app.render();
    await app.toggle();

    app.view.refreshHistory(); app.view.refreshHistory(); await app.render();

    expect(lookups).toBe(1); expect(app.get("session-history").visible).toBe(false);
    await app.toggle();
    expect(lookups).toBe(2); expect(app.captureCharFrame()).toContain("No saved sessions");
  } finally { await app.close(); }
});

test("조회 중 History를 접으면 늦은 응답을 무시하고 다시 펼칠 때 조회를 재개한다", async () => {
  const pending = [Promise.withResolvers<ReturnType<typeof ok<never[]>>>(), Promise.withResolvers<ReturnType<typeof ok<never[]>>>()];
  let lookups = 0;
  const app = await mount({ onListHistory: () => pending[lookups++]!.promise });
  try {
    const lines = app.captureCharFrame().split("\n"), y = lines.findIndex((line) => line.includes("History"));
    await app.mockMouse.click(lines[y]!.indexOf("History"), y); await app.render();
    expect(lookups).toBe(1);

    await app.toggle(); pending[0]!.resolve(ok([])); await app.render();
    await app.toggle();

    expect(lookups).toBe(2); pending[1]!.resolve(ok([])); await app.render();
    expect(app.captureCharFrame()).toContain("No saved sessions"); expect(app.requests).toEqual([]);
  } finally { for (const gate of pending) gate.resolve(ok([])); await app.close(); }
});

test("접기 명령은 재할당할 수 있고 기존 기본 조합은 더 이상 패널을 토글하지 않는다", async () => {
  const app = await mount({ keymap: expectOk(parseKeymap({ bindings: { "sidebar.toggle": ["alt+b"] } })) });
  try {
    app.leader("b"); await app.render(); expect(app.get("workspace-sidebar").visible).toBe(true);

    app.mockInput.pressKey("b", { meta: true }); await app.render();

    expect(app.get("workspace-sidebar").visible).toBe(false);
    app.mockInput.pressKey("b", { meta: true }); await app.render(); expect(app.get("workspace-sidebar").visible).toBe(true);
  } finally { await app.close(); }
});

test("Editor 입력 중 토글은 같은 surface·연결을 유지하고 변경된 너비만 전달한다", async () => {
  const inputs: string[] = [], sizes: number[] = []; let opens = 0, attaches = 0;
  const app = await mount({ editor: { info: (id) => ({ id, worktreeId: id, pid: 123, exited: false, exitCode: null }),
    open: async (id) => { opens++; return ok(id); }, attach: async (id, receive) => { attaches++; let revision = 0;
      const frame = (cols: number, rows: number): EditorFrame => ({ id, worktreeId: id, pid: 123, exited: false, exitCode: null,
        cols, rows, revision: revision++, ansi: "\x1bc\x1b[1;1HEditor buffer" });
      receive(frame(80, 24)); return ok({ input: (bytes) => inputs.push(new TextDecoder().decode(bytes)),
        resize: (cols, rows) => { sizes.push(cols); receive(frame(cols, rows)); }, disconnect: async () => {} }); } } });
  try {
    app.leader("2"); await app.render(); await app.waitFor(() => app.renderer.currentFocusedRenderable?.id.startsWith("editor-terminal:") === true);
    const surface = app.renderer.currentFocusedRenderable, width = surface!.width;

    app.leader("b"); await app.render();
    expect(app.get("workspace-sidebar").visible).toBe(false); expect(app.renderer.currentFocusedRenderable).toBe(surface);
    expect(surface!.width).toBeGreaterThan(width);
    app.leader("b"); await app.render();

    expect(surface!.width).toBe(width); expect(attaches).toBe(1); expect(opens).toBe(0); expect(inputs).toEqual([]);
    expect(sizes.length).toBeGreaterThan(1); expect(app.view.promptDrafts.a1).toBe("main draft");
  } finally { await app.close(); }
});
