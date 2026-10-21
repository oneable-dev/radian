import { expect, test } from "bun:test";
import { InputRenderable, type TerminalColors } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { uiTheme } from "../../ui/theme.ts";
import { ok } from "../../result.ts";

async function mount() {
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace()), requests: string[] = [];
  const view = new Workbench(app.renderer, selection, { onNewSession: () => requests.push("new"), onCloseSession: () => requests.push("close"),
    onPrompt: () => { requests.push("prompt"); return ok(undefined); }, initialDrafts: { a1: "keep agent draft" } });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  app.mockInput.pressKey("f", { ctrl: true }); app.mockInput.pressTab(); await render();
  const get = (id: string) => { const node = app.renderer.root.findDescendantById(id); if (!node) throw new Error(`Missing ${id}`); return node; };
  const input = get("workspace-search"); if (!(input instanceof InputRenderable)) throw new Error("Missing workspace input.");
  const cell = (x: number, y: number) => { let column = 0; return app.captureSpans().lines[y]!.spans.find(span => { column += span.width; return column > x; })!; };
  return { ...app, selection, requests, view, render, get, input, cell, async close() { view.dispose(); await app.dispose(); } };
}
function palette(light: boolean): TerminalColors {
  return { palette: [], defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
    cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null, highlightForeground: null, highlightBackground: null };
}

test("검색 팝업은 중앙에 배치되고 작업 영역을 줄이지 않으며 Preview를 만들지 않는다", async () => {
  // 상시 사이드바의 너비 대신 터미널 안에 들어오는 독립적인 overlay를 사용한다.
  const app = await mount();
  try {
    const panel = app.get("workspace-sidebar"), field = app.get("workspace-search-box");

    expect(panel.x).toBeGreaterThan(0); expect(panel.y).toBeGreaterThan(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(120); expect(panel.y + panel.height).toBeLessThanOrEqual(24);
    expect(app.get("work-panel").width).toBe(120); expect(field.height).toBe(3); expect(app.input.height).toBe(1);
    expect(app.input.y).toBe(field.y + 1); expect(app.captureCharFrame()).toContain("Search repo/worktree/branch");
    expect(app.renderer.root.findDescendantById("workspace-preview")).toBeUndefined(); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("Tab과 Shift+Tab은 팝업 안의 검색과 결과만 순회한다", async () => {
  // 배경 Agent 입력에 검색 내용이 새어 들어가면 안 된다.
  const app = await mount();
  try {
    app.mockInput.pressTab({ shift: true }); await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    app.mockInput.pressTab(); await app.render(); expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-tree");
    app.mockInput.pressTab(); await app.render();

    expect(app.renderer.currentFocusedRenderable).toBe(app.input); expect(app.selection.worktree?.id).toBe("demo:main");
    expect(app.view.promptDrafts.a1).toBe("keep agent draft"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test.each([false, true])("밝기 %j에서도 검색 여백 클릭으로 포커스하고 검색 배경을 일관되게 표시한다", async light => {
  // 글자가 없는 padding도 검색 입력의 클릭 영역이다.
  const app = await mount();
  try {
    const theme = uiTheme(app.renderer); theme.configure(palette(light)); await app.render();
    const field = app.get("workspace-search-box");
    expect(app.cell(field.x + 1, field.y).bg.toInts()).toEqual(theme.colors.surface.toInts());

    await app.mockMouse.click(field.x + 1, field.y); await app.render(); await app.mockInput.typeText("main"); await app.render();

    expect(app.renderer.currentFocusedRenderable).toBe(app.input); expect(app.input.value).toBe("main");
    expect(app.cell(app.input.x, app.input.y).bg.toInts()).toEqual(theme.colors.selected.toInts());
    app.mockInput.pressEnter(); await app.render();
    expect(app.get("workspace-picker").visible).toBe(false); expect(app.selection.worktree?.id).toBe("demo:main"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("리사이즈는 검색어·커서·초안을 보존하고 작은 화면에서도 팝업을 터미널 안에 배치한다", async () => {
  // 긴 검색 입력의 편집 위치가 resize로 초기화되면 안 된다.
  const app = await mount();
  try {
    app.mockInput.pressKey("f", { ctrl: true }); await app.mockInput.typeText("workspace-query-".repeat(6)); app.mockInput.pressArrow("left"); await app.render();
    const value = app.input.value, cursor = app.input.cursorOffset;

    app.resize(60, 12); await app.render();

    const panel = app.get("workspace-sidebar"); expect(panel.x).toBeGreaterThanOrEqual(0); expect(panel.x + panel.width).toBeLessThanOrEqual(60);
    expect(panel.y + panel.height).toBeLessThanOrEqual(12); expect(app.get("workspace-tree").height).toBeGreaterThan(0);
    expect(app.input.value).toBe(value); expect(app.input.cursorOffset).toBe(cursor); expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    app.mockInput.pressKey("l", { ctrl: true }); await app.render(); expect(app.captureCharFrame()).toContain("Search workspaces");
    expect(app.view.promptDrafts.a1).toBe("keep agent draft"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("팝업을 취소하고 다시 열어도 검색 내용과 커서를 유지한다", async () => {
  // 닫기는 선택 확정이나 검색 컨트롤 파괴와 다르다.
  const app = await mount();
  try {
    app.mockInput.pressKey("f", { ctrl: true }); await app.mockInput.typeText("feature"); app.mockInput.pressArrow("left"); await app.render();
    const cursor = app.input.cursorOffset;

    app.mockInput.pressEscape(); await app.render(); app.mockInput.pressKey("f", { ctrl: true }); await app.render();

    expect(app.get("workspace-picker").visible).toBe(true); expect(app.input.value).toBe("feature"); expect(app.input.cursorOffset).toBe(cursor);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input); expect(app.selection.worktree?.id).toBe("demo:main"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});
