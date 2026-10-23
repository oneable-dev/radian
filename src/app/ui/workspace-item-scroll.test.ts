import { openWorkspaceSearch } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { ScrollBoxRenderable, TextRenderable, type Renderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { ok } from "../../result.ts";
import { icons, spinnerFrames } from "../../icons.ts";

const texts = (node: Renderable): TextRenderable[] => [...(node instanceof TextRenderable ? [node] : []), ...node.getChildren().flatMap(texts)];
async function mount() {
  const clock = new ManualClock(), app = await createTestRenderer({ width: 60, height: 20, kittyKeyboard: true, clock });
  const repository = demoWorkspace()[0]!;
  const selection = new WorkspaceSelection([{ ...repository, worktrees: repository.worktrees.map((tree, index) => index ? tree : { ...tree,
    name: "folder-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ-TAIL", branch: "branch-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ-TAIL",
    sessions: tree.sessions.map((session) => ({ ...session, status: "working" as const, subagents: [] })),
  }) }]);
  const actions: string[] = [];
  const view = new Workbench(app.renderer, selection, { onNewSession: () => actions.push("new"), onCloseSession: () => actions.push("close"),
    onPrompt: () => { actions.push("prompt"); return ok(undefined); }, initialDrafts: { a1: "preserved draft" },
    getSessionDetails: () => ({ status: "working", error: null, output: "", sections: [{ id: "request", kind: "user", title: "You", text: "Actual work", status: "complete" }] }) });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  openWorkspaceSearch(app); app.mockInput.pressTab(); await render();
  const item = app.renderer.root.findDescendantById("worktree:demo:main")!;
  const content = item.findDescendantById("worktree:demo:main:label")!;
  const lines = () => app.captureCharFrame().split("\n").slice(content.y, content.y + 2).map((line) => line.slice(item.x + 1, item.x + item.width - 1));
  return { ...app, clock, selection, actions, view, render, item, lines,
    label: () => texts(item).find((text) => text.plainText.includes("folder-") || text.plainText.includes("short-folder"))!,
    async close() { view.dispose(); await app.dispose(); } };
}

test("폴더 줄에서 가로 스크롤하면 같은 워크트리의 브랜치도 같은 오프셋으로 이동한다", async () => {
  const app = await mount();
  try {
    const before = app.lines();
    await app.mockMouse.scroll(app.item.x + 6, app.label().y, "right"); await app.render();
    const first = app.lines();
    expect(first[0]).not.toBe(before[0]); expect(first[1]).not.toBe(before[1]);
    expect(app.label().plainText).toContain("\n"); expect(app.label().height).toBe(2);
    const offset = app.label().scrollX;

    await app.mockMouse.scroll(app.item.x + 6, app.label().y + 1, "right"); await app.render();
    expect(app.label().scrollX).toBe(offset + 1); expect(app.lines()[0]).not.toBe(first[0]); expect(app.lines()[1]).not.toBe(first[1]);
    expect(app.selection.worktree?.id).toBe("demo:main"); expect(app.view.promptDrafts.a1).toBe("preserved draft"); expect(app.actions).toEqual([]);
  } finally { await app.close(); }
});

test("고정 상태 영역 위의 가로 스크롤도 두 줄을 함께 이동시키며 상태 영역은 움직이지 않는다", async () => {
  const app = await mount();
  try {
    const slot = app.item.findDescendantById("worktree:demo:main:status")!;
    const body = app.item.findDescendantById("worktree:demo:main:body")!;
    // 긴 이름의 자연 너비가 선택 배경이나 고정 상태 영역을 테두리 밖으로 밀어내면 안 된다.
    expect(body.x).toBe(app.item.x + 1); expect(body.width).toBe(app.item.width - 2);
    expect(slot.x + slot.width).toBe(app.item.x + app.item.width - 1);
    expect(slot.height).toBe(2); expect(slot.y).toBe(app.label().y);
    const status = slot.getChildren()[0]!, geometry = [slot.x, slot.y, slot.width, slot.height];
    expect(status.visible).toBe(false);
    const before = app.lines();
    await app.mockMouse.scroll(slot.x, slot.y + 1, "right"); await app.render();

    expect(app.lines()[0]).not.toBe(before[0]); expect(app.lines()[1]).not.toBe(before[1]);
    expect([slot.x, slot.y, slot.width, slot.height]).toEqual(geometry); expect(status.visible).toBe(false);
    expect(app.item.height).toBe(4); expect(app.actions).toEqual([]);
  } finally { await app.close(); }
});

test("사이드바는 실행 중에도 애니메이션 없이 오류만 표시하고 Agent 실행 스피너는 유지한다", async () => {
  const app = await mount();
  try {
    // The sidebar is navigation; execution feedback belongs to the Agent work surface.
    const sidebar = app.renderer.root.findDescendantById("workspace-sidebar")!, frames = new Set<string>(spinnerFrames);
    expect(texts(sidebar).some((text) => frames.has(text.plainText))).toBe(false);
    expect(app.renderer.root.findDescendantById("agent-run-loading")!.visible).toBe(true);
    const before = app.lines(); app.clock.advance(160); await app.render(); expect(app.lines()).toEqual(before);

    app.selection.replaceSnapshot(app.selection.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => tree.id !== "demo:main" ? tree : { ...tree,
      sessions: tree.sessions.map((session) => ({ ...session, subagents: [{ id: "failed-child", name: "Failed child", status: "failure" as const }] })),
    }) })));
    await app.render();
    expect(app.lines().join("\n")).toContain(icons.error);
    app.selection.replaceSnapshot(app.selection.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => tree.id !== "demo:main" ? tree : { ...tree,
      sessions: tree.sessions.map((session) => ({ ...session, subagents: [] })),
    }) })));
    await app.render(); expect(app.lines().join("\n")).not.toContain(icons.error);
    expect(texts(sidebar).some((text) => frames.has(text.plainText))).toBe(false);
    expect(app.renderer.root.findDescendantById("agent-run-loading")!.visible).toBe(true);
    expect(app.actions).toEqual([]); expect(app.view.promptDrafts.a1).toBe("preserved draft");
  } finally { await app.close(); }
});

test("가로 위치는 snapshot 갱신에 유지되고 짧은 이름이나 넓어진 패널에서는 유효 범위로 줄인다", async () => {
  const app = await mount();
  try {
    await app.mockMouse.scroll(app.item.x + 6, app.label().y, "right"); await app.render();
    const label = app.label(), offset = label.scrollX;
    app.selection.replaceSnapshot(app.selection.snapshot); await app.render(); expect(app.label()).toBe(label); expect(label.scrollX).toBe(offset);
    label.scrollX = 1000; await app.render(); const narrowOffset = label.scrollX; expect(narrowOffset).toBeGreaterThan(0);
    app.resize(120, 20); await app.render();
    expect(label.scrollX).toBeLessThan(narrowOffset); expect(label.scrollX).toBeLessThanOrEqual(label.maxScrollX);
    app.selection.replaceSnapshot(app.selection.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => tree.id !== "demo:main" ? tree : { ...tree, name: "short-folder", branch: "main" }) })));
    await app.render(); expect(app.label()).toBe(label); expect(label.scrollX).toBe(0);
    expect(app.lines()[0]).toContain("short-folder"); expect(app.lines()[1]).toContain("main");
  } finally { await app.close(); }
});

test("After horizontal scrolling, branch clicks open one worktree and vertical wheel reaches lists", async () => {
  const app = await mount();
  try {
    await app.mockMouse.scroll(app.item.x + 6, app.label().y + 1, "right"); await app.render();
    await app.mockMouse.click(app.item.x + 6, app.label().y + 1); await app.render();
    expect(app.selection.worktree?.id).toBe("demo:main"); expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
    openWorkspaceSearch(app); app.mockInput.pressTab(); await app.render();
    expect(app.item.height).toBe(4); expect(app.view.promptDrafts.a1).toBe("preserved draft"); expect(app.actions).toEqual([]);
    app.resize(60, 12); await app.render();
    const tree = app.renderer.root.findDescendantById("workspace-tree")! as ScrollBoxRenderable, top = tree.scrollTop;
    await app.mockMouse.scroll(app.item.x + 6, app.label().y + 1, "down"); await app.render();
    expect(tree.scrollTop).toBeGreaterThan(top); expect(app.label().scrollY).toBe(0);
  } finally { await app.close(); }
});

test("짧은 폴더와 긴 브랜치도 하나의 뷰포트를 쓰며 한글·emoji·줄바꿈은 두 줄 안에 보존한다", async () => {
  const app = await mount();
  try {
    const rawName = "short-folder\n한글 👨‍👩‍👧‍👦 é";
    app.selection.replaceSnapshot(app.selection.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => tree.id !== "demo:main" ? tree : { ...tree, name: rawName }) })));
    await app.render(); const label = app.label();
    expect(label.plainText).toContain("short-folder 한글 👨‍👩‍👧‍👦 é\n"); expect(label.lineCount).toBe(2);
    app.resize(40, 20); await app.render();
    label.scrollX = label.maxScrollX; await app.render();
    expect(app.lines()[0]!.trim()).toBe(""); expect(app.lines()[1]).toContain("TAIL");
    label.scrollX = 3; await app.render();
    expect(app.captureCharFrame()).not.toContain("\uFFFD"); expect(app.selection.worktree?.name).toBe(rawName);
    expect(app.actions).toEqual([]); expect(app.view.promptDrafts.a1).toBe("preserved draft");
  } finally { await app.close(); }
});
