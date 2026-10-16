import { expect, test } from "bun:test";
import { CodeRenderable, ScrollBoxRenderable, type Renderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { WorkspaceView, type WorkspaceActions } from "./workspace.ts";
import { WorkspaceSelection } from "../workspace/selection.ts";
import { demoWorkspace } from "../workspace/demo.ts";
import { ok } from "../result.ts";
import { initialGitState, type GitSource } from "../git/model.ts";

const lines = (prefix: string) => Array.from({ length: 100 }, (_, index) => `${prefix}-${String(index).padStart(3, "0")}`).join("\n");
const walk = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(walk)];

async function mount(actions: Partial<WorkspaceActions> = {}) {
  const app = await createTestRenderer({ width: 140, height: 30, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace());
  const view = new WorkspaceView(app.renderer, selection, {
    onNewSession: () => {}, onCloseSession: () => {}, onPrompt: () => ok(undefined),
    getSessionDetails: (id) => ({ status: "complete", error: null, output: lines(id === "a1" ? "MAIN" : "FEATURE") }), ...actions,
  });
  const get = (id: string) => {
    const node = walk(app.renderer.root).find((item) => item.id === id);
    if (!node) throw new Error(`Missing ${id}`);
    return node;
  };
  await app.renderOnce(); await app.renderOnce();
  return { ...app, selection, view, get,
    first(pattern: RegExp) { return app.captureCharFrame().match(pattern)?.[0] ?? null; },
    capture(pattern: RegExp) {
      const frames: { tree: string | null; first: string | null }[] = [];
      const capture = () => frames.push({ tree: selection.worktree?.id ?? null, first: app.captureCharFrame().match(pattern)?.[0] ?? null });
      app.renderer.on("frame", capture);
      return { frames, stop: () => app.renderer.off("frame", capture) };
    },
    async click(label: string, right = false) {
      const text = app.captureCharFrame().split("\n"), offset = right ? 36 : 0;
      const y = text.findIndex((line) => line.indexOf(label, offset) >= 0), x = text[y]?.indexOf(label, offset) ?? -1;
      if (x < 0) throw new Error(`Missing ${label}\n${app.captureCharFrame()}`);
      await app.mockMouse.click(x + 1, y); await app.renderOnce(); await app.renderOnce();
    },
    async scroll(id: string, position: number) {
      const target = get(id);
      if (!(target instanceof ScrollBoxRenderable)) throw new Error(`Not a scroll box: ${id}`);
      target.scrollTo(position); await app.renderOnce(); await app.renderOnce();
    },
    async close() { view.dispose(); await app.dispose(); },
  };
}

function gitFixture(counts = { MAIN: 70, FEATURE: 70 }) {
  const loads: string[] = [], comparisons: string[] = [];
  const source = (tree: string): GitSource => ({
    load: async () => {
      loads.push(tree);
      const count = tree === "MAIN" ? counts.MAIN : counts.FEATURE;
      const commits = Array.from({ length: count }, (_, index) => ({ oid: (index + 1).toString(16).padStart(40, "0"),
        parents: index < count - 1 ? [(index + 2).toString(16).padStart(40, "0")] : [], subject: `GIT${tree}-${String(index).padStart(3, "0")}`, author: "Ada", date: "2026-10-15" }));
      return ok({ head: tree, headOid: commits[0]!.oid, commits, refs: [], reflog: [], files: [{ kind: "unstaged" as const, status: "M", path: "probe.txt" }] });
    },
    details: async (commit) => ok({ commit, message: commit.subject, files: [] }),
    compare: async () => {
      comparisons.push(tree);
      const before = lines(`DIFF${tree}`) + "\n";
      return ok({ before, after: before.replace("-050", "-050 modified"), beforeLabel: "HEAD:probe.txt", afterLabel: "worktree:probe.txt" });
    },
  });
  return { loads, comparisons, git: { source: (tree: { id: string }) => source(tree.id === "demo:main" ? "MAIN" : "FEATURE"),
    createSession: async () => ok("unused"), prompt: () => ok(undefined) } };
}

test("Agent 워크트리 전환은 첫 표시 프레임부터 저장된 대화 위치를 사용한다", async () => {
  // 두 세션의 저장 위치가 다르므로 이전 viewport가 한 프레임 노출되는 회귀를 구분한다.
  const app = await mount();
  try {
    await app.scroll("session-transcript", 17);
    const main = app.first(/MAIN-\d{3}/); expect(main).toBe("MAIN-017");
    await app.click("radian-ui (feature"); await app.scroll("session-transcript", 43);
    const feature = app.first(/FEATURE-\d{3}/); expect(feature).toBe("FEATURE-043");
    const record = app.capture(/(?:MAIN|FEATURE)-\d{3}/);

    // 실제로 표시된 모든 전환 프레임을 검사하고 최종 화면만 기다려 문제를 숨기지 않는다.
    await app.click("radian (main)"); await app.click("radian-ui (feature"); record.stop();

    expect(record.frames.length).toBeGreaterThan(0);
    expect(record.frames.filter((frame) => frame.tree === "demo:main").map((frame) => frame.first)).not.toContain(null);
    expect(new Set(record.frames.filter((frame) => frame.tree === "demo:main").map((frame) => frame.first))).toEqual(new Set([main]));
    expect(new Set(record.frames.filter((frame) => frame.tree === "demo:feature").map((frame) => frame.first))).toEqual(new Set([feature]));
  } finally { await app.close(); }
});

test("짧은 대화에서 긴 세션을 복원할 때 이전 스크롤 범위로 저장 위치를 잘라내지 않는다", async () => {
  // 직전 대화는 스크롤할 수 없지만 다음 세션에는 57번째 줄을 복원해야 한다.
  const app = await mount({ initialWorkViews: { active: {}, agentScroll: { a1: 0, b1: 57 } },
    getSessionDetails: (id) => ({ status: "complete", error: null, output: id === "a1" ? "SHORT-000" : lines("LONG") }) });
  const record = app.capture(/(?:SHORT|LONG)-\d{3}/);
  try {
    app.resize(100, 20); await app.renderOnce(); await app.renderOnce();
    await app.click("radian-ui (feature");

    expect(new Set(record.frames.filter((frame) => frame.tree === "demo:feature").map((frame) => frame.first))).toEqual(new Set(["LONG-057"]));
    expect(app.view.workViewPreferences.agentScroll.b1).toBe(57);

    // 첫 프레임 전에 선택이 다시 바뀌어도 취소된 세션의 위치는 덮어쓰지 않는다.
    app.selection.selectSession("demo:main", "a1"); app.selection.selectSession("demo:feature", "b1");
    app.selection.selectSession("demo:main", "a1"); await app.renderOnce(); await app.renderOnce();
    expect(app.first(/(?:SHORT|LONG)-\d{3}/)).toBe("SHORT-000");
    expect(app.view.workViewPreferences.agentScroll.b1).toBe(57);
  } finally { record.stop(); await app.close(); }
});

test("긴 Git 목록의 초기 복원은 로딩 placeholder나 짧은 이전 목록에 의해 제한되지 않는다", async () => {
  // 첫 worktree의 짧은 목록으로는 다음 worktree의 저장된 48행 위치를 측정할 수 없다.
  const fixture = gitFixture({ MAIN: 3, FEATURE: 70 });
  const app = await mount({ git: fixture.git, initialWorkViews: { active: {}, agentScroll: {},
    gitViews: { "demo:feature": { ...initialGitState(), historyScroll: 48 } } } });
  const record = app.capture(/GIT(?:MAIN|FEATURE)-\d{3}/);
  try {
    await app.click("Git", true); await app.waitForFrame((frame) => frame.includes("GITMAIN-000"));
    await app.click("radian-ui (feature"); await app.click("Git", true);
    await app.waitForFrame((frame) => frame.includes("GITFEATURE-"));

    const populated = record.frames.filter((frame) => frame.tree === "demo:feature" && frame.first !== null);
    expect(populated.length).toBeGreaterThan(0);
    expect(new Set(populated.map((frame) => frame.first))).toEqual(new Set(["GITFEATURE-023"]));
    expect(app.view.workViewPreferences.gitViews?.["demo:feature"]?.historyScroll).toBe(48);
  } finally { record.stop(); await app.close(); }
});

test("캐시된 Git 목록은 재조회 없이 첫 표시 프레임에 워크트리별 스크롤을 복원한다", async () => {
  // 데이터 조회만 대역으로 제어하고 목록과 그래프의 레이아웃·paint는 실제 native UI를 사용한다.
  const fixture = gitFixture(), app = await mount({ git: fixture.git });
  try {
    await app.click("Git", true); await app.waitForFrame((frame) => frame.includes("GITMAIN-000"));
    await app.scroll("git-history", 24); const main = app.first(/GITMAIN-\d{3}/);
    await app.click("radian-ui (feature"); await app.click("Git", true);
    await app.waitForFrame((frame) => frame.includes("GITFEATURE-000"));
    await app.scroll("git-history", 48); const feature = app.first(/GITFEATURE-\d{3}/);
    expect(main).not.toBeNull(); expect(feature).not.toBeNull();
    const record = app.capture(/GIT(?:MAIN|FEATURE)-\d{3}/);

    await app.click("radian (main)"); await app.click("radian-ui (feature"); record.stop();

    expect(new Set(record.frames.filter((frame) => frame.tree === "demo:main").map((frame) => frame.first))).toEqual(new Set([main]));
    expect(new Set(record.frames.filter((frame) => frame.tree === "demo:feature").map((frame) => frame.first))).toEqual(new Set([feature]));
    expect(fixture.loads).toEqual(["MAIN", "FEATURE"]);
  } finally { await app.close(); }
});

test("캐시된 Git diff는 첫 표시 프레임부터 저장 위치를 적용하고 재조회하지 않는다", async () => {
  // 새 diff 렌더러의 초기 위치 0이 서로 다른 저장 위치보다 먼저 표시되면 안 된다.
  const fixture = gitFixture(), app = await mount({ git: fixture.git });
  const scroll = async (position: number) => {
    const panes = walk(app.get("git-diff")).filter((node): node is CodeRenderable => node instanceof CodeRenderable);
    expect(panes).toHaveLength(2);
    for (const pane of panes) pane.scrollY = position;
    await app.renderOnce(); await app.renderOnce();
  };
  try {
    await app.click("Git", true); await app.waitForFrame((frame) => frame.includes("probe.txt"));
    await app.click("probe.txt", true); await app.waitForFrame((frame) => frame.includes("DIFFMAIN-000"));
    await scroll(35); const main = app.first(/DIFFMAIN-\d{3}/); expect(main).toBe("DIFFMAIN-035");
    await app.click("radian-ui (feature"); await app.click("Git", true);
    await app.waitForFrame((frame) => frame.includes("probe.txt")); await app.click("probe.txt", true);
    await app.waitForFrame((frame) => frame.includes("DIFFFEATURE-000"));
    await scroll(7); const feature = app.first(/DIFFFEATURE-\d{3}/); expect(feature).toBe("DIFFFEATURE-007");
    const record = app.capture(/DIFF(?:MAIN|FEATURE)-\d{3}/);

    await app.click("radian (main)"); await app.click("radian-ui (feature"); record.stop();

    expect(new Set(record.frames.filter((frame) => frame.tree === "demo:main").map((frame) => frame.first))).toEqual(new Set([main]));
    expect(new Set(record.frames.filter((frame) => frame.tree === "demo:feature").map((frame) => frame.first))).toEqual(new Set([feature]));
    expect(fixture.loads).toEqual(["MAIN", "FEATURE"]); expect(fixture.comparisons).toEqual(["MAIN", "FEATURE"]);
  } finally { await app.close(); }
});
