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
  await render();
  const get = (id: string) => { const node = app.renderer.root.findDescendantById(id); if (!node) throw new Error(`Missing ${id}`); return node; };
  const input = get("workspace-search"); if (!(input instanceof InputRenderable)) throw new Error("Missing workspace input.");
  const cell = (x: number, y: number) => { let column = 0; return app.captureSpans().lines[y]!.spans.find((span) => { column += span.width; return column > x; })!; };
  return { ...app, selection, requests, view, render, get, input, cell, async close() { view.dispose(); await app.dispose(); } };
}

function palette(light: boolean): TerminalColors {
  return { palette: [], defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
    cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null, highlightForeground: null, highlightBackground: null };
}

test("Workspace 제목 없이 검색 영역부터 시작하고 세 줄 검색 높이와 입력 정렬을 유지한다", async () => {
  const app = await mount();
  try {
    // 작업 화면의 너비는 바꾸지 않고 검색 배경만 양쪽 inset까지 확장한다.
    const sidebar = app.get("workspace-sidebar"), field = app.get("workspace-search-box"), tree = app.get("workspace-tree");

    expect(sidebar.width).toBe(40);
    expect(app.get("work-panel").width).toBe(80);
    expect(field.x).toBe(sidebar.x); expect(field.width).toBe(sidebar.width - 1);
    expect(field.y).toBe(sidebar.y);
    const sidebarText = app.captureCharFrame().split("\n").slice(sidebar.y, sidebar.y + sidebar.height)
      .map((line) => line.slice(sidebar.x, sidebar.x + sidebar.width)).join("\n");
    expect(sidebarText).not.toContain("Workspace");
    expect(field.height).toBe(3); expect(app.input.height).toBe(1);
    expect(app.input.y).toBe(field.y + 1); expect(app.input.x - sidebar.x).toBe(2);
    expect(app.input.width).toBe(field.width - 4);
    expect(tree.y - field.y - field.height).toBe(1);
    expect(app.captureCharFrame()).toContain("Search repo/worktree/branch");
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("Tab과 Shift+Tab은 제거된 제목에 멈추지 않고 검색과 결과 사이를 바로 이동한다", async () => {
  // With only one sidebar destination, its title must not consume a focus stop.
  const app = await mount();
  try {
    app.mockInput.pressKey("f", { ctrl: true }); await app.render();

    // Traverse forward to results and back without changing the query or active worktree.
    app.mockInput.pressTab(); await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-tree");
    app.mockInput.pressTab({ shift: true }); await app.render();

    // Navigation is local UI state: no prompt, session creation or close request is sent.
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    expect(app.selection.worktree?.id).toBe("demo:main"); expect(app.input.value).toBe("");
    expect(app.view.promptDrafts.a1).toBe("keep agent draft"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test.each([false, true])("밝기 %j에서도 검색 여백 클릭으로 포커스하고 전체 배경이 입력과 같은 색을 유지한다", async (light) => {
  const app = await mount();
  try {
    const theme = uiTheme(app.renderer); theme.configure(palette(light)); await app.render();
    const field = app.get("workspace-search-box");
    expect(app.cell(field.x, field.y).bg.toInts()).toEqual(theme.colors.surface.toInts());

    // 입력 글자가 없는 위쪽 여백도 실제 클릭 가능한 검색 영역이다.
    await app.mockMouse.click(field.x + 1, field.y); await app.render();
    await app.mockInput.typeText("main"); await app.render();

    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    expect(app.input.value).toBe("main");
    expect(app.cell(field.x, field.y).bg.toInts()).toEqual(theme.colors.selected.toInts());
    expect(app.cell(field.x + field.width - 1, field.y + 2).bg.toInts()).toEqual(theme.colors.selected.toInts());
    expect(app.cell(app.input.x, app.input.y).bg.toInts()).toEqual(theme.colors.selected.toInts());
    app.mockInput.pressEnter(); await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(app.get("workspace-tree"));
    expect(app.cell(field.x, field.y).bg.toInts()).toEqual(theme.colors.surface.toInts());
    expect(app.selection.worktree?.id).toBe("demo:main"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("리사이즈는 검색어·커서·초안과 일관된 검색 높이를 보존한다", async () => {
  const app = await mount();
  try {
    // 긴 입력은 가로로 스크롤하고 리사이즈로 검색 객체를 다시 만들지 않는다.
    app.mockInput.pressKey("f", { ctrl: true }); await app.mockInput.typeText("workspace-query-".repeat(6));
    app.mockInput.pressArrow("left"); await app.render();
    const value = app.input.value, cursor = app.input.cursorOffset, field = app.get("workspace-search-box");
    expect(cursor).toBe(value.length - 1);

    app.resize(60, 24); await app.render();
    expect(field.height).toBe(3); expect(field.width).toBe(25);
    expect(field.y).toBe(app.get("workspace-sidebar").y);
    expect(app.input.x - app.get("workspace-sidebar").x).toBe(1);
    app.resize(60, 12); await app.render();
    expect(field.height).toBe(3); expect(app.input.y).toBe(field.y + 1);
    expect(app.get("workspace-tree").height).toBeGreaterThan(0);
    expect(app.input.value).toBe(value); expect(app.input.cursorOffset).toBe(cursor);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    expect(app.view.promptDrafts.a1).toBe("keep agent draft");

    // 좁은 화면에서는 빈 검색창의 안내도 잘리지 않게 짧게 표시한다.
    app.mockInput.pressEscape(); await app.render();
    expect(app.input.value).toBe(""); expect(app.captureCharFrame()).toContain("Search workspaces");
    app.resize(120, 24); await app.render();
    expect(app.get("workspace-search")).toBe(app.input); expect(field.height).toBe(3);
    expect(app.captureCharFrame()).toContain("Search repo/worktree/branch");
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("검색 중 패널을 접고 검색 단축키로 다시 열어도 입력과 커서가 남는다", async () => {
  const app = await mount();
  try {
    app.mockInput.pressKey("f", { ctrl: true }); await app.mockInput.typeText("feature"); app.mockInput.pressArrow("left"); await app.render();
    const cursor = app.input.cursorOffset, field = app.get("workspace-search-box");

    // 패널 표시 전환은 검색 컨트롤이나 편집 상태를 파괴하지 않는다.
    app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("b"); await app.render();
    expect(app.get("workspace-sidebar").visible).toBe(false);
    app.mockInput.pressKey("f", { ctrl: true }); await app.render();

    expect(app.get("workspace-sidebar").visible).toBe(true);
    expect(app.get("workspace-search-box")).toBe(field);
    expect(app.input.value).toBe("feature"); expect(app.input.cursorOffset).toBe(cursor);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    expect(app.view.promptDrafts.a1).toBe("keep agent draft"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});
