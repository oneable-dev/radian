import { expect, test } from "bun:test";
import { ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { icons } from "../../icons.ts";
import { ok } from "../../result.ts";
import { uiTheme } from "../../ui/theme.ts";

async function mount(repositories = demoWorkspace(), size: { width?: number; height?: number } = {}) {
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true, ...size });
  const selection = new WorkspaceSelection(repositories), requests: string[] = [];
  const view = new Workbench(app.renderer, selection, { onNewSession: () => requests.push("new"), onCloseSession: () => requests.push("close"),
    onPrompt: () => { requests.push("prompt"); return ok(undefined); },
    getSessionDetails: () => ({ status: "complete", output: "Transcript", error: null }), initialDrafts: { a1: "main draft" } });
  await app.renderOnce(); await app.renderOnce();
  const get = (id: string) => app.renderer.root.findDescendantById(id)!;
  const line = (id: string, offset = 0) => { const node = get(id), label = get(`${id}:label`); return app.captureCharFrame().split("\n")[label.y + offset]!.slice(node.x, node.x + node.width); };
  const cell = (x: number, y: number) => { let column = 0; return app.captureSpans().lines[y]!.spans.find((span) => { column += span.width; return column > x; })!; };
  const frame = (id: string) => { const node = get(id); return app.captureCharFrame().split("\n").slice(node.y, node.y + node.height).map((line) => line.slice(node.x, node.x + node.width)); };
  return { ...app, selection, requests, get, line, cell, frame, view, async close() { view.dispose(); await app.dispose(); } };
}

test.each([[60, 26, 1], [80, 40, 2], [120, 40, 2]] as const)("너비 %i에서도 스크롤바 오른쪽은 한 칸만 띄우고 사이드바 너비·왼쪽 여백을 유지한다", async (width, sidebarWidth, leftInset) => {
  // 모든 높이에서 세로 스크롤바가 실제로 나타나도록 충분한 항목을 준비한다.
  const repository = demoWorkspace()[0]!, original = repository.worktrees[0]!;
  const worktrees = Array.from({ length: 30 }, (_, index) => ({ ...original, id: `spacing-${index}`,
    path: `/demo/spacing-${index}`, name: `workspace-${index}`, sessions: index === 0 ? original.sessions : [] }));
  const app = await mount([{ ...repository, worktrees }], { width, height: 36 });
  try {
    for (const height of [12, 36]) {
      // 창 높이가 바뀌어도 오른쪽 간격만 줄이고 검색·작업 패널 배치는 바꾸지 않는다.
      app.resize(width, height); await app.renderOnce(); await app.renderOnce();
      const sidebar = app.get("workspace-sidebar"), tree = app.get("workspace-tree");
      if (!(tree instanceof ScrollBoxRenderable)) throw new Error("Missing native workspace scroll area.");
      const bar = tree.verticalScrollBar, divider = sidebar.x + sidebar.width - 1;

      expect(bar.visible).toBe(true); expect(divider - bar.x - bar.width).toBe(1);
      expect(sidebar.width).toBe(sidebarWidth); expect(tree.x - sidebar.x).toBe(leftInset);
      expect(app.get("work-panel").width).toBe(width - sidebarWidth);
      expect(app.get("workspace-search-box").width).toBe(sidebarWidth - 1);
    }
    expect(app.selection.worktree?.id).toBe("spacing-0"); expect(app.view.promptDrafts.a1).toBe("main draft"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("Workspace는 폴더명과 브랜치 아이콘·이름을 들여쓰기 없이 같은 열의 두 줄로 표시한다", async () => {
  // A repository owns multiple two-line worktrees, not separately selectable branch nodes.
  const app = await mount();
  try {
    await app.renderOnce();
    const main = app.get("worktree:demo:main"), feature = app.get("worktree:demo:feature");

    expect(main.height).toBe(4); expect(feature.y).toBe(main.y + 3);
    expect(app.line("worktree:demo:main").trim()).toContain(`${icons.folder} radian`);
    expect(app.line("worktree:demo:main")).not.toContain("(main)");
    const status = main.findDescendantById("worktree:demo:main:status")!;
    const label = app.get("worktree:demo:main:label");
    expect(status.height).toBe(2); expect(status.y).toBe(label.y);
    const indicator = status.getChildren()[0]!;
    expect(app.line("worktree:demo:main", indicator.y - label.y)).toContain(icons.error);
    expect(app.line("worktree:demo:main", 1)).toContain(`${icons.branch} main`);
    expect(app.line("worktree:demo:main", 1).indexOf(icons.branch)).toBe(app.line("worktree:demo:main").indexOf(icons.folder));
    expect(app.line("worktree:demo:main", 1)).not.toContain("└");
    expect(app.get("repository:demo:radian").height).toBe(1);
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("폴더와 브랜치 줄은 선택 배경을 공유하고 브랜치 줄 클릭도 같은 워크트리를 연다", async () => {
  // The whole worktree is one click target, including its subordinate branch line.
  const app = await mount();
  try {
    const main = app.get("worktree:demo:main"), feature = app.get("worktree:demo:feature");
    const folderColumn = main.x + app.line("worktree:demo:main").indexOf("radian");
    const branchColumn = main.x + app.line("worktree:demo:main", 1).indexOf("main");
    const folderY = app.get("worktree:demo:main:label").y;
    expect(app.cell(folderColumn, folderY).bg.toInts()).toEqual(app.cell(branchColumn, folderY + 1).bg.toInts());
    expect(app.cell(branchColumn, folderY + 1).attributes & TextAttributes.BOLD).not.toBe(0);

    await app.mockMouse.click(feature.x + 5, app.get("worktree:demo:feature:label").y + 1); await app.renderOnce();

    expect(app.selection.worktree?.id).toBe("demo:feature"); expect(app.selection.sessionId).toBe("b1");
    expect(app.renderer.currentFocusedRenderable).toBe(app.get("workspace-tree"));
    expect(app.view.promptDrafts.a1).toBe("main draft"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("키보드 탐색은 브랜치 줄을 별도 항목으로 세지 않고 한 번에 다음 폴더로 이동한다", async () => {
  // Moving the cursor must not activate the next worktree before Enter.
  const app = await mount();
  try {
    app.mockInput.pressKey("j"); await app.renderOnce();
    const feature = app.get("worktree:demo:feature");

    expect(app.selection.worktree?.id).toBe("demo:main");
    expect(app.cell(feature.x + 1, feature.y + 1).bg.toInts()).toEqual(uiTheme(app.renderer).colors.panel.toInts());
    expect(app.cell(feature.x + 1, feature.y + 2).bg.toInts()).toEqual(uiTheme(app.renderer).colors.panel.toInts());
    app.mockInput.pressEnter(); await app.renderOnce();
    expect(app.selection.worktree?.id).toBe("demo:feature"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test.each([false, true])("밝기 %j에서도 선택 배경 없이 테두리·글자만 강조하고 포커스 이동 후 같은 모양을 유지한다", async (light) => {
  // 밝은 테마에서도 기본 배경을 유지하고 강조는 테두리와 글자에만 적용한다.
  const app = await mount();
  try {
    const theme = uiTheme(app.renderer);
    theme.configure({ palette: [], defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
      cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null, highlightForeground: null, highlightBackground: null });
    await app.renderOnce(); await app.renderOnce();
    const main = app.get("worktree:demo:main"), label = app.get("worktree:demo:main:label"), colors = theme.colors;

    // 두 줄 본문은 그대로 두고 기존 간격에 위아래 테두리를 표시한다.
    expect(main.height).toBe(4); expect(label.height).toBe(2); expect(label.y).toBe(main.y + 1);
    const frame = app.frame(main.id);
    expect(frame[0]).toBe(`┌${"─".repeat(main.width - 2)}┐`);
    expect(frame[3]).toBe(`└${"─".repeat(main.width - 2)}┘`);
    expect(frame[1]?.at(0)).toBe("│"); expect(frame[1]?.at(-1)).toBe("│");
    expect(frame[2]?.at(0)).toBe("│"); expect(frame[2]?.at(-1)).toBe("│");
    // 테두리 칸뿐 아니라 안쪽 여백·본문·상태 영역에도 선택 배경을 칠하지 않는다.
    for (let y = main.y; y < main.y + main.height; y++) {
      for (let x = main.x; x < main.x + main.width; x++) {
        expect(app.cell(x, y).bg.toInts()).toEqual(colors.panel.toInts());
      }
    }
    expect(app.cell(main.x, main.y).fg.toInts()).toEqual(colors.accent.toInts());
    expect(app.frame("worktree:demo:feature").at(-1)?.trim()).toBe("");
    const appearance = () => ({ text: app.frame(main.id), cells: Array.from({ length: main.height }, (_, y) =>
      Array.from({ length: main.width }, (_, x) => {
        const cell = app.cell(main.x + x, main.y + y);
        return `${cell.fg.toInts()}/${cell.bg.toInts()}/${cell.attributes}`;
      })) });
    const focused = appearance();

    // 검색·입력·다른 작업 탭에 포커스가 가더라도 같은 선택을 흐리게 만들지 않는다.
    app.mockInput.pressKey("e", { ctrl: true }); await app.renderOnce(); await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt"); expect(appearance()).toEqual(focused);
    app.mockInput.pressKey("f", { ctrl: true }); await app.renderOnce(); await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-search"); expect(appearance()).toEqual(focused);
    app.get("work-view-tabs").getChildren()[0]!.focus(); await app.renderOnce(); await app.renderOnce();
    expect(appearance()).toEqual(focused);
    app.get("workspace-tree").focus(); await app.renderOnce(); await app.renderOnce();
    expect(appearance()).toEqual(focused);
    expect(app.selection.worktree?.id).toBe("demo:main"); expect(app.view.promptDrafts.a1).toBe("main draft"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("선택 테두리는 인접 여백에 지워지지 않고 여백 클릭·포커스 이동에도 위치와 크기를 유지한다", async () => {
  // 인접한 항목은 위아래 테두리 한 줄을 공유하므로 현재 커서의 경계를 우선 표시한다.
  const app = await mount();
  const geometry = () => ["main", "feature", "empty"].map((id) => {
    const item = app.get(`worktree:demo:${id}`), label = app.get(`worktree:demo:${id}:label`);
    return [item.x, item.y, item.width, item.height, label.x, label.y, label.width, label.height];
  });
  try {
    const before = geometry();
    app.mockInput.pressKey("j"); await app.renderOnce(); await app.renderOnce();
    const feature = app.get("worktree:demo:feature"), colors = uiTheme(app.renderer).colors;

    // 커서 이동은 작업 공간을 열지 않으며 공유된 위아래 행까지 새 선택에 속한다.
    expect(app.selection.worktree?.id).toBe("demo:main"); expect(geometry()).toEqual(before);
    expect(app.frame(feature.id)[0]).toBe(`┌${"─".repeat(feature.width - 2)}┐`);
    expect(app.frame(feature.id)[3]).toBe(`└${"─".repeat(feature.width - 2)}┘`);
    expect(app.frame("worktree:demo:main")[0]?.trim()).toBe("");
    const main = app.get("worktree:demo:main");
    expect(app.cell(main.x + 1, main.y + 1).bg.toInts()).toEqual(colors.panel.toInts());
    expect(app.cell(feature.x + 1, feature.y + 1).bg.toInts()).toEqual(colors.panel.toInts());

    // 아래쪽 테두리를 눌러도 인접 항목이 아니라 해당 워크트리를 연다.
    await app.mockMouse.click(feature.x + 5, feature.y + feature.height - 1); await app.renderOnce();
    expect(app.selection.worktree?.id).toBe("demo:feature"); expect(app.selection.sessionId).toBe("b1");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-tree"); expect(geometry()).toEqual(before);
    app.mockInput.pressKey("e", { ctrl: true }); await app.renderOnce();
    expect(app.frame(feature.id)[0]).toBe(`┌${"─".repeat(feature.width - 2)}┐`);
    expect(app.cell(feature.x, feature.y).bg.toInts()).toEqual(colors.panel.toInts());
    expect(app.cell(feature.x, feature.y).fg.toInts()).toEqual(colors.accent.toInts());
    expect(app.cell(feature.x + 1, feature.y + 1).bg.toInts()).toEqual(colors.panel.toInts());
    expect(geometry()).toEqual(before); expect(app.view.promptDrafts.a1).toBe("main draft"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test.each([11, 12])("높이 %i의 작은 화면에서 End는 폴더·브랜치를 함께 표시하고 공간이 있으면 테두리도 보인다", async (height) => {
  // 테두리까지 들어가지 않는 viewport에서는 두 줄의 실제 본문을 우선한다.
  const repository = demoWorkspace()[0]!;
  const worktrees = Array.from({ length: 20 }, (_, index) => ({ ...repository.worktrees[0]!, id: `tree-${index}`,
    path: `/demo/workspace-${index}`, name: `workspace-${index}`, branch: `branch-${index}`, sessions: [] }));
  const app = await mount([{ ...repository, worktrees }]);
  try {
    app.resize(60, height); await app.renderOnce();
    app.mockInput.pressKey("END"); await app.renderOnce(); await app.renderOnce();
    const last = app.get("worktree:tree-19"), label = app.get("worktree:tree-19:label"), tree = app.get("workspace-tree");

    expect(label.y).toBeGreaterThanOrEqual(tree.y); expect(label.y + label.height).toBeLessThanOrEqual(tree.y + tree.height);
    if (height === 12) {
      expect(last.y).toBeGreaterThanOrEqual(tree.y); expect(last.y + last.height).toBeLessThanOrEqual(tree.y + tree.height);
    }
    expect(app.captureCharFrame()).toContain(`${icons.folder} workspace-19`);
    expect(app.captureCharFrame()).toContain(`${icons.branch} branch-19`);
    expect(app.selection.worktree?.id).toBe("tree-0");
    app.mockInput.pressEnter(); await app.renderOnce();
    expect(app.selection.worktree?.id).toBe("tree-19"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("브랜치 갱신과 detached HEAD·긴 이름도 두 줄 높이와 기존 행을 유지한다", async () => {
  // A snapshot changes metadata without recreating the keyed worktree or wrapping its branch.
  const app = await mount();
  try {
    const feature = app.get("worktree:demo:feature"), empty = app.get("worktree:demo:empty");
    const update = (branch: string | null) => app.selection.replaceSnapshot(app.selection.snapshot.map((repo) => ({ ...repo,
      worktrees: repo.worktrees.map((tree) => tree.id === "demo:feature" ? { ...tree, branch } : tree) })));
    update(null); await app.renderOnce();
    expect(app.line("worktree:demo:feature", 1)).toContain("detached HEAD");

    update("feature/a-very-long-branch-that-must-not-wrap"); app.resize(60, 12); await app.renderOnce();

    expect(app.get("worktree:demo:feature")).toBe(feature); expect(feature.height).toBe(4);
    expect(empty.y).toBe(feature.y + 3);
    app.mockInput.pressKey("j"); await app.renderOnce(); await app.renderOnce();
    expect(app.line("worktree:demo:feature", 1)).toContain("feature/");
    expect(app.selection.worktree?.id).toBe("demo:main"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

function groupedRepositories() {
  const repository = demoWorkspace()[0]!;
  return [{ ...repository, worktrees: repository.worktrees.slice(0, 2) }, { id: "tools", name: "tools", worktrees: repository.worktrees.slice(0, 2).map((tree, index) => ({
    ...tree, id: `tools-${index}`, path: `/tools/${index}`, name: `tool-${index}`, sessions: [],
  })) }];
}

test("레포 묶음과 워크트리 및 헤더 사이는 한 줄 간격으로 구분한다", async () => {
  // 두 레포가 모두 보이는 화면에서 계층별 여백을 실제 셀 좌표로 확인한다.
  const app = await mount(groupedRepositories(), { height: 36 });
  try {
    const repository = app.get("repository:demo:radian"), main = app.get("worktree:demo:main"), tools = app.get("repository:tools");

    // 항목의 테두리는 기존 한 줄 간격을 공유하며 폴더/브랜치 본문 간격은 늘리지 않는다.
    const mainLabel = app.get("worktree:demo:main:label"), featureLabel = app.get("worktree:demo:feature:label");
    expect(repository.marginTop).toBe(0);
    expect(mainLabel.y - repository.y - repository.height).toBe(1);
    expect(featureLabel.y - mainLabel.y - mainLabel.height).toBe(1);
    expect(tools.y - featureLabel.y - featureLabel.height).toBe(1);
    expect(app.get("worktree:tools-0:label").y - tools.y - tools.height).toBe(1);
    expect(main.height).toBe(4);
    expect(app.cell(main.x + 1, main.y).bg.toInts()).toEqual(uiTheme(app.renderer).colors.panel.toInts());
    await app.mockMouse.click(main.x + 5, main.y + main.height - 1); await app.renderOnce();
    expect(app.selection.worktree?.id).toBe("demo:main"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("좁고 낮은 화면에서도 항목·레포 간격과 기존 초안을 유지한다", async () => {
  const app = await mount(groupedRepositories(), { height: 36 });
  try {
    const main = app.get("worktree:demo:main"), feature = app.get("worktree:demo:feature");

    // 높이에 따라 별도 모드로 전환하지 않고 같은 행과 간격을 유지한다.
    app.resize(60, 12); await app.renderOnce(); await app.renderOnce();
    expect(app.get("worktree:demo:main")).toBe(main);
    expect(feature.y - main.y).toBe(3);
    expect(app.get("repository:tools").y - feature.y - feature.height).toBe(0);
    expect(app.view.promptDrafts.a1).toBe("main draft");

    app.resize(120, 36); await app.renderOnce(); await app.renderOnce();
    expect(feature.y - main.y).toBe(3);
    expect(app.get("repository:tools").y - feature.y - feature.height).toBe(0);
  } finally { await app.close(); }
});

test("검색 후 첫 레포에는 그룹 앞 여백이 남지 않고 폴더·브랜치 정렬을 유지한다", async () => {
  const app = await mount(groupedRepositories(), { height: 36 });
  try {
    // 검색은 표시 대상만 줄이며 사라진 이전 레포의 그룹 여백을 물려받지 않는다.
    app.mockInput.pressKey("f", { ctrl: true }); await app.mockInput.typeText("tools"); await app.renderOnce(); await app.renderOnce();

    const repository = app.get("repository:tools"), first = app.get("worktree:tools-0:label");
    expect(repository.marginTop).toBe(0);
    expect(first.y - repository.y - repository.height).toBe(1);
    expect(app.line("worktree:tools-0").indexOf(icons.folder)).toBe(app.line("worktree:tools-0", 1).indexOf(icons.branch));
    expect(app.selection.worktree?.id).toBe("demo:main"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("간격이 바뀌는 리사이즈도 탐색 중인 마지막 워크트리의 두 줄을 화면 안에 유지한다", async () => {
  const repository = demoWorkspace()[0]!;
  const app = await mount([{ ...repository, worktrees: Array.from({ length: 20 }, (_, index) => ({ ...repository.worktrees[0]!, id: `resize-${index}`, name: `item-${index}`, sessions: [] })) }], { width: 60, height: 12 });
  try {
    // 커서는 마지막 행으로 이동하지만 실제 워크스페이스는 아직 첫 항목이다.
    app.mockInput.pressKey("END"); await app.renderOnce(); await app.renderOnce();
    app.resize(120, 24); await app.renderOnce(); await app.renderOnce();

    const last = app.get("worktree:resize-19"), tree = app.get("workspace-tree");
    expect(last.y).toBeGreaterThanOrEqual(tree.y);
    expect(last.y + last.height).toBeLessThanOrEqual(tree.y + tree.height);
    expect(app.selection.worktree?.id).toBe("resize-0"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});
