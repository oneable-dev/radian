import { openWorkspaceSearch } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { icons } from "../../icons.ts";
import { ok } from "../../result.ts";
import { uiTheme } from "../../ui/theme.ts";

async function mount(repositories = demoWorkspace(), size: { width?: number; height?: number } = {}) {
  const app = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true, ...size });
  const selection = new WorkspaceSelection(repositories), requests: string[] = [];
  const view = new Workbench(app.renderer, selection, { onNewSession: () => requests.push("new"), onCloseSession: () => requests.push("close"),
    onPrompt: () => { requests.push("prompt"); return ok(undefined); }, getSessionDetails: () => ({ status: "complete", output: "Transcript", error: null }), initialDrafts: { a1: "main draft" } });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  openWorkspaceSearch(app); app.mockInput.pressTab(); await render();
  const get = (id: string) => app.renderer.root.findDescendantById(id)!;
  const line = (id: string, offset = 0) => { const node = get(id), label = get(`${id}:label`); return app.captureCharFrame().split("\n")[label.y + offset]!.slice(node.x, node.x + node.width); };
  const cell = (x: number, y: number) => { let column = 0; return app.captureSpans().lines[y]!.spans.find(span => { column += span.width; return column > x; })!; };
  return { ...app, selection, requests, get, line, cell, view, render, async close() { view.dispose(); await app.dispose(); } };
}

test("워크스페이스 팝업은 저장소와 폴더·브랜치 두 줄을 표시하고 세션을 섞지 않는다", async () => {
  // 워크트리의 브랜치는 별도 선택 항목이 아닌 같은 항목의 메타데이터다.
  const app = await mount();
  try {
    const main = app.get("worktree:demo:main"), label = app.get(`${main.id}:label`);

    expect(main.height).toBe(4); expect(label.height).toBe(2);
    expect(app.line(main.id)).toContain(`${icons.folder} radian`); expect(app.line(main.id, 1)).toContain(`${icons.branch} main`);
    expect(app.line(main.id, 1).indexOf(icons.branch)).toBe(app.line(main.id).indexOf(icons.folder));
    expect(app.captureCharFrame()).toContain(`${icons.repo} radian [demo]`);
    expect(app.captureCharFrame()).not.toContain("UI review"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("키보드 이동과 백그라운드 갱신은 선택을 바꾸지 않고 Enter만 워크트리를 연다", async () => {
  // 검색 팝업의 후보 커서는 현재 작업 세션과 독립적이다.
  const app = await mount();
  try {
    app.mockInput.pressKey("j"); await app.render();
    app.selection.replaceSnapshot(structuredClone(app.selection.snapshot)); await app.render();
    expect(app.selection.worktree?.id).toBe("demo:main");

    app.mockInput.pressEnter(); await app.render();

    expect(app.selection.worktree?.id).toBe("demo:feature"); expect(app.selection.sessionId).toBe("b1");
    expect(app.get("workspace-picker").visible).toBe(false); expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
    expect(app.view.promptDrafts.a1).toBe("main draft"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test.each(["search", "results"] as const)("%s 포커스에서 Ctrl+N/P는 화면 안 후보의 강조만 옮기고 스크롤하지 않는다", async focus => {
  // 세 후보가 모두 보이는 목록에서는 키보드 탐색이 뷰포트를 움직일 이유가 없다.
  const app = await mount();
  try {
    if (focus === "search") app.mockInput.pressTab({ shift: true });
    await app.render();
    const tree = app.get("workspace-tree") as ScrollBoxRenderable, top = tree.scrollTop;
    const border = (id: string) => { const row = app.get(id); return app.captureCharFrame().split("\n")[row.y]![row.x]; };

    // 검색에 포커스가 남아 있어도 다음 후보를 실제 화면에서 식별할 수 있어야 한다.
    app.mockInput.pressKey("n", { ctrl: true }); await app.render();

    expect(border("worktree:demo:feature")).toBe("┌"); expect(border("worktree:demo:main")).not.toBe("┌");
    expect(tree.scrollTop).toBe(top); expect(app.selection.worktree?.id).toBe("demo:main");
    app.selection.replaceSnapshot(structuredClone(app.selection.snapshot)); await app.render();
    expect(border("worktree:demo:feature")).toBe("┌"); expect(tree.scrollTop).toBe(top);
    app.mockInput.pressTab(); await app.render();
    expect(border("worktree:demo:feature")).toBe("┌");
    app.mockInput.pressKey("p", { ctrl: true }); await app.render();

    expect(border("worktree:demo:main")).toBe("┌"); expect(border("worktree:demo:feature")).not.toBe("┌");
    expect(tree.scrollTop).toBe(top); expect(app.view.promptDrafts.a1).toBe("main draft"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test.each(["search", "results"] as const)("%s 포커스의 긴 목록에서도 Ctrl+N/P는 후보를 표시하며 필요한 만큼만 따라간다", async focus => {
  // 화면 밖 후보로 이동할 때도 선택 표시 없이 목록만 스크롤하는 상태가 되면 안 된다.
  const repository = demoWorkspace()[0]!;
  const worktrees = Array.from({ length: 20 }, (_, index) => ({ ...repository.worktrees[0]!, id: `tree-${index}`, path: `/demo/${index}`, name: `workspace-${index}`, branch: `branch-${index}`, sessions: [] }));
  const app = await mount([{ ...repository, worktrees }], { width: 60, height: 12 });
  try {
    if (focus === "search") app.mockInput.pressTab({ shift: true });
    await app.render();
    const tree = app.get("workspace-tree") as ScrollBoxRenderable, theme = uiTheme(app.renderer);

    // 다음/이전 후보가 이미 보이면 뷰포트를 유지하고, 벗어날 때만 그 후보를 드러낸다.
    for (const [index, key] of [[1, "n"], [2, "n"], [3, "n"], [4, "n"], [5, "n"], [4, "p"], [3, "p"]] as const) {
      const row = app.get(`worktree:tree-${index}`), top = tree.scrollTop;
      const visible = row.y >= tree.viewport.y && row.y + row.height <= tree.viewport.y + tree.viewport.height;
      app.mockInput.pressKey(key, { ctrl: true }); await app.render();

      const label = app.get(`${row.id}:label`);
      expect(label.y).toBeGreaterThanOrEqual(tree.viewport.y); expect(label.y + 2).toBeLessThanOrEqual(tree.viewport.y + tree.viewport.height);
      expect(app.cell(label.x, label.y).fg.toInts()).toEqual(theme.styles["sidebar.selected"].fg.toInts());
      if (visible) expect(tree.scrollTop).toBe(top);
      expect(app.selection.worktree?.id).toBe("tree-0");
    }
    expect(app.renderer.currentFocusedRenderable?.id).toBe(focus === "search" ? "workspace-search" : "workspace-tree");
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("브랜치 줄 클릭도 같은 워크트리를 열고 팝업을 닫는다", async () => {
  // 두 줄의 클릭 영역을 같은 워크트리로 취급한다.
  const app = await mount();
  try {
    const feature = app.get("worktree:demo:feature"), label = app.get(`${feature.id}:label`);

    await app.mockMouse.click(label.x + 3, label.y + 1); await app.render();

    expect(app.selection.worktree?.id).toBe("demo:feature"); expect(app.get("workspace-picker").visible).toBe(false);
    expect(app.view.promptDrafts.a1).toBe("main draft"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test.each([false, true])("밝기 %j에서도 팝업의 후보는 배경 대신 테두리·글자로 강조한다", async light => {
  // 밝기 전환은 검색과 선택을 재생성하지 않아야 한다.
  const app = await mount();
  try {
    const theme = uiTheme(app.renderer);
    theme.configure({ palette: [], defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
      cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null, highlightForeground: null, highlightBackground: null });
    await app.render();
    const main = app.get("worktree:demo:main");

    expect(app.cell(main.x, main.y).fg.toInts()).toEqual(theme.colors.accent.toInts());
    expect(app.cell(main.x + 1, main.y + 1).bg.toInts()).toEqual(theme.colors.panel.toInts());
    expect(app.get("work-panel").width).toBe(120); expect(app.selection.worktree?.id).toBe("demo:main");
  } finally { await app.close(); }
});

test.each([11, 12, 36])("높이 %i에서도 마지막 후보의 폴더와 브랜치를 표시하고 작업 너비를 유지한다", async height => {
  // 모든 후보가 들어가지 않는 상황에서 실제 네이티브 viewport의 reveal을 검증한다.
  const repository = demoWorkspace()[0]!;
  const worktrees = Array.from({ length: 20 }, (_, index) => ({ ...repository.worktrees[0]!, id: `tree-${index}`, path: `/demo/${index}`, name: `workspace-${index}`, branch: `branch-${index}`, sessions: [] }));
  const app = await mount([{ ...repository, worktrees }], { width: 60, height });
  try {
    app.mockInput.pressKey("END"); await app.render();
    const label = app.get("worktree:tree-19:label"), tree = app.get("workspace-tree");
    if (!(tree instanceof ScrollBoxRenderable)) throw new Error("Missing workspace list");

    expect(label.y).toBeGreaterThanOrEqual(tree.viewport.y); expect(label.y + 2).toBeLessThanOrEqual(tree.viewport.y + tree.viewport.height);
    expect(app.captureCharFrame()).toContain("workspace-19"); expect(app.captureCharFrame()).toContain("branch-19");
    expect(app.get("work-panel").width).toBe(60); expect(app.selection.worktree?.id).toBe("tree-0");
  } finally { await app.close(); }
});

test("브랜치 갱신과 detached HEAD는 검색 후보를 재생성하거나 선택을 바꾸지 않는다", async () => {
  // 파일시스템 watcher가 전달한 메타데이터 갱신도 기존 후보를 유지한다.
  const app = await mount();
  try {
    const feature = app.get("worktree:demo:feature");
    app.selection.replaceSnapshot(app.selection.snapshot.map(repo => ({ ...repo, worktrees: repo.worktrees.map(tree => tree.id === "demo:feature" ? { ...tree, branch: null } : tree) })));
    await app.render();

    expect(app.get(feature.id)).toBe(feature); expect(app.line(feature.id, 1)).toContain("detached HEAD");
    expect(feature.height).toBe(4); expect(app.selection.worktree?.id).toBe("demo:main"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});
