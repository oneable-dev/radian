import { expect, test } from "bun:test";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { TextRenderable } from "@opentui/core";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { icons, spinnerFrames } from "../../icons.ts";
import { ok } from "../../result.ts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

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
      return app.captureCharFrame().split("\n").slice(node.y, node.y + node.height).map((line) => {
        // Native geometry uses cells, while frame strings contain variable-width graphemes.
        let text = "", column = 0;
        for (const { segment } of graphemes.segment(line)) {
          const start = column; column += Bun.stringWidth(segment);
          if (start >= node.x && column <= node.x + node.width) text += segment;
          if (column >= node.x + node.width) break;
        }
        return text;
      }).join("\n");
    },
    async openWorkspaces() { app.mockInput.pressKey("f", { ctrl: true }); app.mockInput.pressTab(); await render(); },
    async click(label: string) {
      if (label.startsWith(icons.folder)) { app.mockInput.pressKey("f", { ctrl: true }); app.mockInput.pressCtrlC(); await render(); }
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
    await app.openWorkspaces(); app.mockInput.pressKey("j"); await app.render();
    app.selection.replaceSnapshot(structuredClone(app.selection.snapshot)); await app.render();

    expect(app.selection.worktree?.id).toBe("demo:main");
    expect(app.get("editor-view").visible).toBe(true);
    expect(app.saved).toHaveLength(saves);
    expect(app.region("workspace-tree")).not.toContain("a1");

    // Confirmation commits only the highlighted worktree and uses its existing view identity.
    app.mockInput.pressEnter(); await app.render();
    expect(app.selection.worktree?.id).toBe("demo:feature");
    expect(app.captureCharFrame()).toContain("Git preview");
    await app.openWorkspaces(); app.mockInput.pressKey("k"); await app.render();
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
    await app.openWorkspaces(); app.mockInput.pressKey("END"); app.mockInput.pressArrow("up"); await app.render();
    expect(app.selection.worktree?.id).toBe("demo:main");
    app.mockInput.pressEnter(); await app.render();
    expect(app.selection.worktree?.id).toBe("demo:feature");
    await app.openWorkspaces(); app.mockInput.pressKey("HOME"); await app.render();
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
    await app.click("a1");

    expect(app.selection.sessionId).toBe("a1");
    expect(app.captureCharFrame()).toContain("main draft");
    expect(app.view.promptDrafts.a2).toBe("hjklnx");
    expect(app.requests).toEqual([]);
    expect(app.region("workspace-tree")).not.toContain("a2");
    expect(app.region("agent-session-tabs")).toContain("a2");
  } finally { await app.close(); }
});

test("세션 상태는 같은 칸에 표시하고 미확정은 빈 상태 공간 없이 ID를 표시한다", async () => {
  // 실행·완료·실패 표시는 서로 다른 글리프를 사용해도 같은 위치에 놓인다.
  const app = await mount();
  const ordered = (id: string, title: string, glyphs: readonly string[]) => {
    const text = app.region(id), position = text.indexOf(title);
    expect(position).toBeGreaterThanOrEqual(0);
    expect(text.startsWith("│ ")).toBe(true);
    expect(glyphs).toContain(text[5]!);
    expect(glyphs).toContain(text.slice(5, position).trim());
    expect(text.slice(position + title.length).trim()).toBe("×");
    expect(app.get(id).width).toBe(18);
  };
  try {
    // Initial rendering and tab focus use the same edge gutters and leading status cell.
    for (const focused of [false, true]) {
      if (focused) { app.get("agent-session-list").focus(); await app.render(); }
      ordered("session:demo:main:a1", "a1", spinnerFrames);
      expect(app.region("session:demo:main:a2")).toBe("│ 2. a2         × ");
      ordered("session:demo:main:a3", "a3", [icons.failure]);
    }

    // Unreported sessions keep the tab's outer padding, not an empty badge and its extra gap.
    await app.click(`${icons.folder} radian-ui`);
    for (const focused of [false, true]) {
      if (focused) { app.get("agent-session-list").focus(); await app.render(); }
      expect(app.region("session:demo:feature:b1")).toBe("│ 1. b1         × ");
    }
    expect(app.view.promptDrafts.a1).toBe("main draft"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("세션 탭은 왼쪽 보더 안쪽과 오른쪽에 한 칸 패딩을 두고 번호·상태·제목 사이 간격을 유지한다", async () => {
  // Edge padding belongs to each tab, independently of its selection or execution status.
  const app = await mount();
  try {
    // Native cell positions include both edge gutters without enlarging the close button.
    for (const id of ["a1", "a2", "a3"]) {
      const tab = app.get(`session:demo:main:${id}`), close = app.get(`close-session:${id}`);
      const [number, status, title] = tab.getChildren();
      expect(app.region(tab.id).startsWith(`│ ${id.slice(1)}. `)).toBe(true);
      expect(number!.x).toBe(tab.x + 2);
      if (status!.visible) expect(status!.x).toBe(number!.x + number!.width + 1);
      expect(title!.x).toBe(status!.visible ? status!.x + status!.width + 1 : number!.x + number!.width + 1);
      expect(close.x).toBe(title!.x + title!.width + 1);
      expect(close.width).toBe(1);
      expect(close.x + close.width).toBe(tab.x + tab.width - 1);
      expect(app.region(tab.id).endsWith("× ")).toBe(true);
    }
    const first = app.get("session:demo:main:a1"), second = app.get("session:demo:main:a2");
    expect(second.x).toBe(first.x + first.width + 1);
    expect(app.view.promptDrafts.a1).toBe("main draft"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test.each([["완료", "complete", ""], ["실패", "failure", icons.failure], ["미확정", null, ""]] as const)(
  "실행이 %s 상태로 바뀌어도 한 아이콘만 표시하고 빈 상태 칸을 회수한다", async (_label, status, glyph) => {
    // A short run settles before the spinner's 500 ms minimum interval has elapsed.
    const app = await mount();
    try {
      const tab = app.get("session:demo:main:a1"), close = app.get("close-session:a1"), title = app.get(`${tab.id}:title`);
      const geometry = [tab.x, tab.width, title.x, close.x];
      app.clock.advance(120); await app.render();
      expect(spinnerFrames.some((frame) => frame === app.region(tab.id)[5])).toBe(true);

      // Failure supersedes the spinner immediately; an empty badge can retain its minimum-visible tail.
      app.selection.replaceSnapshot(app.selection.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => ({ ...tree,
        sessions: tree.sessions.map((session) => session.id === "a1" ? { ...session, status, subagents: [] } : session),
      })) })));
      await app.render();
      const prefix = () => app.region(tab.id).slice(5, app.region(tab.id).indexOf("a1")).trim();
      if (status === "failure") expect(app.region(tab.id)).toBe(`│ 1. ${glyph} a1       × `);
      else expect(spinnerFrames.some(frame => frame === prefix())).toBe(true);
      app.clock.advance(379); await app.render();
      if (status === "failure") expect(app.region(tab.id)).toBe(`│ 1. ${glyph} a1       × `);
      else expect(spinnerFrames.some(frame => frame === prefix())).toBe(true);
      app.clock.advance(1); await app.render();

      // The badge collapses into label space without moving the tab boundary or close control.
      if (status !== "failure") {
        expect(app.region(tab.id)).toBe("│ 1. a1         × ");
        expect([tab.x, tab.width, title.x, close.x]).toEqual([geometry[0]!, geometry[1]!, geometry[2]! - 2, geometry[3]!]);
      } else {
        expect(app.region(tab.id)[5]).toBe(glyph); expect(app.region(tab.id)[6]).toBe(" ");
        expect([tab.x, tab.width, title.x, close.x]).toEqual(geometry);
      }
      expect(app.region(tab.id).startsWith("│ 1. ")).toBe(true); expect(app.region(tab.id).endsWith("× ")).toBe(true);
      expect(app.view.promptDrafts.a1).toBe("main draft"); expect(app.requests).toEqual([]);
    } finally { await app.close(); }
  },
);

test("비선택 세션 탭의 닫기 버튼은 현재 세션과 초안을 바꾸지 않는다", async () => {
  // Closing A2 must not first activate its tab or clear A1's text.
  const app = await mount();
  try {
    const close = app.get("close-session:a2");
    await app.mockMouse.click(close.x, close.y); await app.render();

    expect(app.selection.sessionId).toBe("a1");
    expect(app.selection.worktree?.sessions.map((session) => session.id)).toEqual(["a1", "a3"]);
    expect((app.get("session:demo:main:a3:number") as TextRenderable).plainText).toBe("2.");
    expect(app.view.promptDrafts.a1).toBe("main draft");
    expect(app.requests).toEqual(["close:a2"]);
  } finally { await app.close(); }
});

test("생성은 leader+n으로 통일하고 탭의 닫기는 x로 유지한다", async () => {
  // The left panel no longer owns hidden active-session actions.
  const app = await mount();
  try {
    app.mockInput.pressKey("n"); app.mockInput.pressKey("x"); await app.render();
    expect(app.requests).toEqual([]);
    app.get("agent-session-list").focus();
    app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("n"); app.mockInput.pressKey("x"); await app.render();

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
    expect(app.region("transcript-status-row")).not.toContain("Completed");
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
    expect(app.region("session:demo:main:a1")).toContain(icons.failure);
    expect([tab.x, tab.y, tab.width, input.y, row.y, row.height]).toEqual(geometry);
    await app.click("a2");
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
    expect((app.get(`${alpha.id}:number`) as TextRenderable).plainText).toBe("3.");
    expect((app.get("session:demo:main:a3:number") as TextRenderable).plainText).toBe("1.");
    app.get("agent-session-list").focus(); app.mockInput.pressKey("h"); await app.render();
    expect(app.selection.sessionId).toBe("a2");
    app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("1"); await app.render();
    expect(app.selection.sessionId).toBe("a3");
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("좁은 Workspace는 기본 확정 안내 없이도 탐색과 Enter 확정을 유지한다", async () => {
  // 기본 조작 대신 Help만 남겨도 워크트리 전환 의미는 바뀌지 않는다.
  const app = await mount();
  try {
    app.resize(60, 12); await app.render(); await app.openWorkspaces();
    expect(app.captureCharFrame().split("\n")[11]).not.toContain("<CR>");
    expect(app.captureCharFrame().split("\n")[11]).toContain("<F1>");
    app.mockInput.pressKey("j"); await app.render();
    expect(app.selection.worktree?.id).toBe("demo:main");
    app.mockInput.pressEnter(); await app.render();
    expect(app.selection.worktree?.id).toBe("demo:feature");
    expect(app.get("agent-session-tabs").height).toBe(1);
  } finally { await app.close(); }
});

test("좁은 세션 탭은 긴 Unicode 이름 대신 ID를 표시하고 닫기와 상태 셀을 유지한다", async () => {
  // Display names may contain complex text, but tabs consistently use the stable ID.
  const app = await mount();
  try {
    app.selection.replaceSnapshot(app.selection.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => ({ ...tree,
      sessions: tree.sessions.map((session) => session.id === "a1" ? { ...session, name: "연결 👩‍💻 e\u0301 긴 세션 이름" } : session),
    })) })));
    app.resize(60, 12); await app.render();
    const tab = app.get("session:demo:main:a1"), close = app.get("close-session:a1");
    expect(tab.width).toBeLessThanOrEqual(app.get("agent-session-list").width);
    expect(app.region(tab.id).startsWith("│ 1. ")).toBe(true);
    expect(app.region(tab.id).endsWith("× ")).toBe(true);
    expect(spinnerFrames.some((frame) => frame === app.region(tab.id)[5])).toBe(true);
    expect(close.x + close.width).toBe(tab.x + tab.width - 1);
    const title = app.get(`${tab.id}:title`);
    if (!(title instanceof TextRenderable)) throw new Error("Missing session ID label");
    expect(title.plainText).toBe("a1");
    expect(app.region(tab.id)).not.toContain("연결");
    expect(app.captureCharFrame()).not.toContain("\uFFFD");
    expect(app.selection.sessionId).toBe("a1");
  } finally { await app.close(); }
});
