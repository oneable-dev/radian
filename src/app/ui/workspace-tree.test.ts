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

test("Workspace popups show repositories plus two-row folder/branch items without sessions", async () => {
  // Worktree branches are metadata on the same item, not separate candidates.
  const app = await mount();
  try {
    const main = app.get("worktree:demo:main"), label = app.get(`${main.id}:label`);

    expect(main.height).toBe(2); expect(label.height).toBe(2);
    expect(app.line(main.id)).toContain(`${icons.folder} radian`); expect(app.line(main.id, 1)).toContain(`${icons.branch} main`);
    expect(app.line(main.id, 1).indexOf(icons.branch)).toBe(app.line(main.id).indexOf(icons.folder));
    expect(app.captureCharFrame()).toContain(`${icons.repo} radian [demo]`);
    expect(app.captureCharFrame()).not.toContain("UI review"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("Keyboard browsing and background updates preserve selection while only Enter opens worktrees", async () => {
  // Popup candidate cursors are independent of current work sessions.
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

test.each(["search", "results"] as const)("Ctrl+N/P at %s focus moves visible highlights without scrolling", async focus => {
  // Lists showing all three candidates need no viewport movement.
  const app = await mount();
  try {
    if (focus === "search") app.mockInput.pressTab({ shift: true });
    await app.render();
    const tree = app.get("workspace-tree") as ScrollBoxRenderable, top = tree.scrollTop;
    const highlighted = (id: string) => { const row = app.get(id); return app.cell(row.x, row.y).bg.equals(uiTheme(app.renderer).styles["ui.selection"].bg!); };

    // Next candidates remain visibly identifiable even with search focus retained.
    app.mockInput.pressKey("n", { ctrl: true }); await app.render();

    expect(highlighted("worktree:demo:feature")).toBe(true); expect(highlighted("worktree:demo:main")).toBe(false);
    expect(tree.scrollTop).toBe(top); expect(app.selection.worktree?.id).toBe("demo:main");
    app.selection.replaceSnapshot(structuredClone(app.selection.snapshot)); await app.render();
    expect(highlighted("worktree:demo:feature")).toBe(true); expect(tree.scrollTop).toBe(top);
    app.mockInput.pressTab(); await app.render();
    expect(highlighted("worktree:demo:feature")).toBe(true);
    app.mockInput.pressKey("p", { ctrl: true }); await app.render();

    expect(highlighted("worktree:demo:main")).toBe(true); expect(highlighted("worktree:demo:feature")).toBe(false);
    expect(tree.scrollTop).toBe(top); expect(app.view.promptDrafts.a1).toBe("main draft"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test.each(["search", "results"] as const)("Long-list Ctrl+N/P at %s focus reveals candidates with minimal scrolling", async focus => {
  // Offscreen movement must not scroll lists without candidate highlighting.
  const repository = demoWorkspace()[0]!;
  const worktrees = Array.from({ length: 20 }, (_, index) => ({ ...repository.worktrees[0]!, id: `tree-${index}`, path: `/demo/${index}`, name: `workspace-${index}`, branch: `branch-${index}`, sessions: [] }));
  const app = await mount([{ ...repository, worktrees }], { width: 60, height: 12 });
  try {
    if (focus === "search") app.mockInput.pressTab({ shift: true });
    await app.render();
    const tree = app.get("workspace-tree") as ScrollBoxRenderable, theme = uiTheme(app.renderer);

    // Keep viewports for visible neighbors; reveal candidates only when outside.
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

test("Branch-row clicks open the same worktree and close popups", async () => {
  // Both row click targets belong to one worktree.
  const app = await mount();
  try {
    const feature = app.get("worktree:demo:feature"), label = app.get(`${feature.id}:label`);

    await app.mockMouse.click(label.x + 3, label.y + 1); await app.render();

    expect(app.selection.worktree?.id).toBe("demo:feature"); expect(app.get("workspace-picker").visible).toBe(false);
    expect(app.view.promptDrafts.a1).toBe("main draft"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test.each([false, true])("At brightness %j, popup candidates highlight across their full width without borders", async light => {
  // Theme changes must not recreate searches or selections.
  const app = await mount();
  try {
    const theme = uiTheme(app.renderer);
    theme.configure({ palette: [], defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
      cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null, highlightForeground: null, highlightBackground: null });
    await app.render();
    const main = app.get("worktree:demo:main");

    expect(app.cell(main.x, main.y).bg.toInts()).toEqual(theme.styles["ui.selection"].bg!.toInts());
    expect(app.cell(main.x + main.width - 1, main.y + 1).bg.toInts()).toEqual(theme.styles["ui.selection"].bg!.toInts());
    const other = app.get("worktree:demo:feature");
    expect(app.cell(other.x, other.y).bg.toInts()).toEqual(theme.styles["ui.popup"].bg!.toInts());
    expect(app.get("work-panel").width).toBe(120); expect(app.selection.worktree?.id).toBe("demo:main");
  } finally { await app.close(); }
});

test.each([11, 12, 36])("At height %i, final candidates show folders/branches while preserving work width", async height => {
  // Verify real native viewport reveal when not all candidates fit.
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

test("Branch and detached HEAD updates never recreate candidates or change selection", async () => {
  // Filesystem watcher metadata updates retain existing candidates.
  const app = await mount();
  try {
    const feature = app.get("worktree:demo:feature");
    app.selection.replaceSnapshot(app.selection.snapshot.map(repo => ({ ...repo, worktrees: repo.worktrees.map(tree => tree.id === "demo:feature" ? { ...tree, branch: null } : tree) })));
    await app.render();

    expect(app.get(feature.id)).toBe(feature); expect(app.line(feature.id, 1)).toContain("detached HEAD");
    expect(feature.height).toBe(2); expect(app.selection.worktree?.id).toBe("demo:main"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});
