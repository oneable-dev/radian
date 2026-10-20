import { expect, test } from "bun:test";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { icons } from "../../icons.ts";
import { ok } from "../../result.ts";

async function mount(actions: Partial<WorkbenchActions> = {}) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 140, height: 30, kittyKeyboard: true, clock });
  const repositories = demoWorkspace().map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => ({ ...tree,
    sessions: tree.sessions.map((session, index) => ({ ...session, name: ["Alpha", "Beta", "Gamma"][index] ?? session.name })),
  })) }));
  const selection = new WorkspaceSelection(repositories);
  const requests: string[] = [], saved: unknown[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession: (tree) => requests.push(`new:${tree}`),
    onCloseSession: (tree, id) => {
      requests.push(`close:${id}`);
      selection.replaceSnapshot(selection.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((item) => item.id !== tree ? item : {
        ...item, sessions: item.sessions.filter((session) => session.id !== id),
      }) })));
    },
    onPrompt: (id, text) => { requests.push(`prompt:${id}:${text}`); return ok(undefined); },
    getSessionDetails: (id) => ({ status: "complete", error: null, output: `BODY-${id}` }),
    initialDrafts: { a1: "main draft", b1: "feature draft" }, onWorkViewsChange: (state) => saved.push(state), ...actions,
  });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  await render();
  const get = (id: string) => {
    const node = app.renderer.root.findDescendantById(id);
    if (!node) throw new Error(`Missing ${id}`);
    return node;
  };
  return { ...app, clock, selection, view, requests, saved, render, get,
    region(id: string) {
      const node = get(id);
      return app.captureCharFrame().split("\n").slice(node.y, node.y + node.height)
        .map((line) => line.slice(node.x, node.x + node.width)).join("\n");
    },
    async click(label: string) {
      const lines = app.captureCharFrame().split("\n"), y = lines.findIndex((line) => line.includes(label));
      const x = lines[y]?.indexOf(label) ?? -1;
      if (x < 0) throw new Error(`Missing ${label}\n${app.captureCharFrame()}`);
      await app.mockMouse.click(x + 1, y); await render();
    },
    async close() { view.dispose(); await app.dispose(); },
  };
}

test("워크트리 커서 이동과 snapshot은 현재 화면을 바꾸지 않고 Enter만 마지막 탭을 복원한다", async () => {
  // A's Editor and B's Git are independent of the navigation cursor and saved Agent drafts.
  const app = await mount({ initialWorkViews: { active: { "demo:main": "editor", "demo:feature": "git" }, agentScroll: {} } });
  try {
    const saves = app.saved.length;
    app.mockInput.pressKey("j"); await app.render();
    app.selection.replaceSnapshot(structuredClone(app.selection.snapshot)); await app.render();

    expect(app.selection.worktree?.id).toBe("demo:main");
    expect(app.captureCharFrame()).toContain("Editor preview");
    expect(app.saved).toHaveLength(saves);
    expect(app.region("workspace-tree")).not.toContain("Alpha");

    // Confirmation commits only the highlighted worktree and uses its existing view identity.
    app.mockInput.pressEnter(); await app.render();
    expect(app.selection.worktree?.id).toBe("demo:feature");
    expect(app.captureCharFrame()).toContain("Git preview");
    app.mockInput.pressKey("k"); await app.render();
    expect(app.selection.worktree?.id).toBe("demo:feature");
    app.mockInput.pressEnter(); await app.render();

    expect(app.selection.worktree?.id).toBe("demo:main");
    expect(app.captureCharFrame()).toContain("Editor preview");
    expect(app.view.workViewPreferences.active).toEqual({ "demo:main": "editor", "demo:feature": "git" });
    expect(app.view.promptDrafts).toEqual({ a1: "main draft", b1: "feature draft" });
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("방향키와 Home/End도 탐색만 하고 실제 선택은 Enter로 확정한다", async () => {
  // Arrow alternatives must obey exactly the same deferred-activation rule as j/k.
  const app = await mount();
  try {
    app.mockInput.pressKey("END"); app.mockInput.pressArrow("up"); await app.render();
    expect(app.selection.worktree?.id).toBe("demo:main");
    app.mockInput.pressEnter(); await app.render();
    expect(app.selection.worktree?.id).toBe("demo:feature");
    app.mockInput.pressKey("HOME"); await app.render();
    expect(app.selection.worktree?.id).toBe("demo:feature");
    app.mockInput.pressEnter(); await app.render();
    expect(app.selection.worktree?.id).toBe("demo:main");
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("Agents 세션 탭의 h/l 전환은 각 초안을 보존하고 프롬프트의 hjklnx는 일반 입력이다", async () => {
  // Session navigation is scoped to its strip, never to the editor or prompt input.
  const app = await mount();
  try {
    app.get("agent-session-list").focus(); app.mockInput.pressKey("l"); await app.render();
    expect(app.selection.sessionId).toBe("a2");
    app.mockInput.pressKey("e", { ctrl: true }); await app.mockInput.typeText("hjklnx");
    await app.click("Alpha");

    expect(app.selection.sessionId).toBe("a1");
    expect(app.captureCharFrame()).toContain("main draft");
    expect(app.view.promptDrafts.a2).toBe("hjklnx");
    expect(app.requests).toEqual([]);
    expect(app.region("workspace-tree")).not.toContain("Beta");
    expect(app.region("agent-session-tabs")).toContain("Beta");
  } finally { await app.close(); }
});

test("비선택 세션 탭의 닫기 버튼은 현재 세션과 초안을 바꾸지 않는다", async () => {
  // Closing A2 must not first activate its tab or clear A1's text.
  const app = await mount();
  try {
    const close = app.get("close-session:a2");
    await app.mockMouse.click(close.x + 1, close.y); await app.render();

    expect(app.selection.sessionId).toBe("a1");
    expect(app.selection.worktree?.sessions.map((session) => session.id)).toEqual(["a1", "a3"]);
    expect(app.view.promptDrafts.a1).toBe("main draft");
    expect(app.requests).toEqual(["close:a2"]);
  } finally { await app.close(); }
});

test("세션 생성과 닫기 키는 Workspace에서 실행되지 않고 세션 탭에서만 실행된다", async () => {
  // The left panel no longer owns hidden active-session actions.
  const app = await mount();
  try {
    app.mockInput.pressKey("n"); app.mockInput.pressKey("x"); await app.render();
    expect(app.requests).toEqual([]);
    app.get("agent-session-list").focus(); app.mockInput.pressKey("n"); app.mockInput.pressKey("x"); await app.render();

    expect(app.requests).toEqual(["new:demo:main", "close:a1"]);
    expect(app.selection.sessionId).toBe("a2");
  } finally { await app.close(); }
});

test("서브에이전트는 선택한 세션의 실행 상태 행에만 집계하고 상태 변화는 탭과 화면 좌표를 유지한다", async () => {
  // A1 has a running child; A2 has none. Updating status must not recreate keyed tabs.
  const app = await mount();
  try {
    app.mockInput.pressKey("e", { ctrl: true }); await app.render();
    const tab = app.get("session:demo:main:a1"), input = app.get("agent-composer"), row = app.get("transcript-status-row");
    const geometry = [tab.x, tab.y, tab.width, input.y, row.y, row.height];
    expect(app.region("transcript-status-row")).toContain("Completed");
    expect(app.region("transcript-status-row")).toContain("Subagents");
    app.clock.advance(160); await app.render();
    expect([tab.x, tab.y, tab.width, input.y, row.y, row.height]).toEqual(geometry);

    // The completed parent must not hide the failed child, and final outcome is immediate.
    app.selection.replaceSnapshot(app.selection.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => ({ ...tree,
      sessions: tree.sessions.map((session) => session.id !== "a1" ? session : { ...session,
        subagents: session.subagents.map((child) => ({ ...child, status: "failure" as const })),
      }),
    })) })));
    await app.render();
    expect(app.get("session:demo:main:a1")).toBe(tab);
    expect(app.region("session:demo:main:a1")).toContain(icons.error);
    expect([tab.x, tab.y, tab.width, input.y, row.y, row.height]).toEqual(geometry);
    await app.click("Beta");
    expect(app.region("transcript-status-row")).not.toContain("Subagents");
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("snapshot의 세션 순서가 바뀌어도 ID 선택과 탭 인스턴스를 보존하고 키 이동은 표시 순서를 따른다", async () => {
  // Reordering existing IDs must not rebuild the active tab or retain a stale visual order.
  const app = await mount();
  try {
    const alpha = app.get("session:demo:main:a1");
    app.selection.replaceSnapshot(app.selection.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => ({
      ...tree, sessions: [...tree.sessions].reverse(),
    })) })));
    await app.render();

    expect(app.selection.sessionId).toBe("a1");
    expect(app.get("session:demo:main:a1")).toBe(alpha);
    expect(app.get("session:demo:main:a2").x).toBeLessThan(alpha.x);
    app.get("agent-session-list").focus(); app.mockInput.pressKey("h"); await app.render();
    expect(app.selection.sessionId).toBe("a2");
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("좁은 화면의 Workspace 푸터도 Enter 확정 안내를 우선 표시한다", async () => {
  // Essential confirmation must fit before optional first/last navigation hints.
  const app = await mount();
  try {
    app.resize(60, 12); await app.render();
    expect(app.captureCharFrame().split("\n")[11]).toContain("Enter Open worktree");
    app.mockInput.pressKey("j"); await app.render();
    expect(app.selection.worktree?.id).toBe("demo:main");
    app.mockInput.pressEnter(); await app.render();
    expect(app.selection.worktree?.id).toBe("demo:feature");
    expect(app.get("agent-session-tabs").height).toBe(1);
  } finally { await app.close(); }
});

test("좁은 세션 탭은 Unicode 이름을 자르더라도 닫기와 상태 셀을 화면 안에 유지한다", async () => {
  // Combining characters and emoji must be shortened as graphemes, not UTF-16 halves.
  const app = await mount();
  try {
    app.selection.replaceSnapshot(app.selection.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => ({ ...tree,
      sessions: tree.sessions.map((session) => session.id === "a1" ? { ...session, name: "연결 👩‍💻 e\u0301 긴 세션 이름" } : session),
    })) })));
    app.resize(60, 12); await app.render();
    expect(app.get("session:demo:main:a1").width).toBeLessThanOrEqual(app.get("agent-session-list").width);
    expect(app.captureCharFrame()).toContain("…");
    expect(app.captureCharFrame()).not.toContain("\uFFFD");
    expect(app.selection.sessionId).toBe("a1");
  } finally { await app.close(); }
});
