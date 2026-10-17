import { expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { icons } from "../../icons.ts";
import { ok } from "../../result.ts";
import { uiTheme } from "../../ui/theme.ts";

async function mount(repositories = demoWorkspace()) {
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
  const selection = new WorkspaceSelection(repositories), requests: string[] = [];
  const view = new Workbench(app.renderer, selection, { onNewSession: () => requests.push("new"), onCloseSession: () => requests.push("close"),
    onPrompt: () => { requests.push("prompt"); return ok(undefined); },
    getSessionDetails: () => ({ status: "complete", output: "Transcript", error: null }), initialDrafts: { a1: "main draft" } });
  await app.renderOnce(); await app.renderOnce();
  const get = (id: string) => app.renderer.root.findDescendantById(id)!;
  const line = (id: string, offset = 0) => { const node = get(id); return app.captureCharFrame().split("\n")[node.y + offset]!.slice(node.x, node.x + node.width); };
  const cell = (x: number, y: number) => { let column = 0; return app.captureSpans().lines[y]!.spans.find((span) => { column += span.width; return column > x; })!; };
  return { ...app, selection, requests, get, line, cell, view, async close() { view.dispose(); await app.dispose(); } };
}

test("Workspace는 폴더명과 브랜치 아이콘·이름을 들여쓰기 없이 같은 열의 두 줄로 표시한다", async () => {
  // A repository owns multiple two-line worktrees, not separately selectable branch nodes.
  const app = await mount();
  try {
    await app.renderOnce();
    const main = app.get("worktree:demo:main"), feature = app.get("worktree:demo:feature");

    expect(main.height).toBe(2); expect(feature.y).toBe(main.y + 2);
    expect(app.line("worktree:demo:main").trim()).toContain(`${icons.folder} radian`);
    expect(app.line("worktree:demo:main")).not.toContain("(main)");
    expect(app.line("worktree:demo:main")).toContain(icons.error);
    expect(app.line("worktree:demo:main", 1)).not.toContain(icons.error);
    expect(app.line("worktree:demo:main", 1).trim()).toBe(`${icons.branch} main`);
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
    expect(app.cell(folderColumn, main.y).bg.toInts()).toEqual(app.cell(branchColumn, main.y + 1).bg.toInts());
    expect(app.cell(branchColumn, main.y + 1).attributes & TextAttributes.BOLD).not.toBe(0);

    await app.mockMouse.click(feature.x + 5, feature.y + 1); await app.renderOnce();

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
    expect(app.cell(feature.x, feature.y).bg.toInts()).toEqual(uiTheme(app.renderer).colors.selected.toInts());
    expect(app.cell(feature.x, feature.y + 1).bg.toInts()).toEqual(uiTheme(app.renderer).colors.selected.toInts());
    app.mockInput.pressEnter(); await app.renderOnce();
    expect(app.selection.worktree?.id).toBe("demo:feature"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("작은 화면의 End는 마지막 폴더와 브랜치 두 줄을 함께 스크롤해 표시한다", async () => {
  // A long workspace list must reveal the full grouped item, not just its folder heading.
  const repository = demoWorkspace()[0]!;
  const worktrees = Array.from({ length: 20 }, (_, index) => ({ ...repository.worktrees[0]!, id: `tree-${index}`,
    path: `/demo/workspace-${index}`, name: `workspace-${index}`, branch: `branch-${index}`, sessions: [] }));
  const app = await mount([{ ...repository, worktrees }]);
  try {
    app.resize(60, 12); await app.renderOnce();
    app.mockInput.pressKey("END"); await app.renderOnce(); await app.renderOnce();
    const last = app.get("worktree:tree-19"), tree = app.get("workspace-tree");

    expect(last.y).toBeGreaterThanOrEqual(tree.y); expect(last.y + last.height).toBeLessThanOrEqual(tree.y + tree.height);
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

    expect(app.get("worktree:demo:feature")).toBe(feature); expect(feature.height).toBe(2);
    expect(empty.y).toBe(feature.y + 2); expect(app.line("worktree:demo:feature", 1)).toContain("feature/");
    expect(app.selection.worktree?.id).toBe("demo:main"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});
