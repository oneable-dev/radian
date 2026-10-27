import { openWorkspaceSearch } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { CodeRenderable, ScrollBoxRenderable, type Renderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { icons } from "../../icons.ts";
import { ok } from "../../result.ts";
import { initialGitState, type GitSource } from "../../git/model.ts";

const lines = (prefix: string) =>
  Array.from({ length: 100 }, (_, index) => `${prefix}-${String(index).padStart(3, "0")}`).join(
    "\n",
  );
const walk = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(walk)];

async function mount(actions: Partial<WorkbenchActions> = {}) {
  const app = await createTestRenderer({ width: 140, height: 30, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace());
  const view = new Workbench(app.renderer, selection, {
    onNewSession: () => {},
    onCloseSession: () => {},
    onPrompt: () => ok(undefined),
    getSessionDetails: (id) => ({
      status: "complete",
      error: null,
      output: lines(id === "a1" ? "MAIN" : "FEATURE"),
    }),
    ...actions,
  });
  const get = (id: string) => {
    const node = walk(app.renderer.root).find((item) => item.id === id);
    if (!node) throw new Error(`Missing ${id}`);
    return node;
  };
  await app.renderOnce();
  await app.renderOnce();
  return {
    ...app,
    selection,
    view,
    get,
    first(pattern: RegExp) {
      return app.captureCharFrame().match(pattern)?.[0] ?? null;
    },
    capture(pattern: RegExp, unobscured = false) {
      const frames: { tree: string | null; first: string | null }[] = [];
      const capture = () => {
        // The workspace picker can cover the first diff line while leaving its last line visible.
        if (unobscured && get("workspace-picker").visible) return;
        frames.push({
          tree: selection.worktree?.id ?? null,
          first: app.captureCharFrame().match(pattern)?.[0] ?? null,
        });
      };
      app.renderer.on("frame", capture);
      return { frames, stop: () => app.renderer.off("frame", capture) };
    },
    async showGit() {
      app.mockInput.pressKey(" ", { ctrl: true });
      app.mockInput.pressKey("g");
      await app.renderOnce();
      await app.renderOnce();
    },
    async click(label: string, right = false) {
      if (label.startsWith(icons.folder)) {
        openWorkspaceSearch(app);
        app.mockInput.pressCtrlC();
        await app.renderOnce();
        await app.renderOnce();
      }
      const text = app.captureCharFrame().split("\n"),
        offset = right ? 36 : 0;
      const y = text.findIndex((line) => line.indexOf(label, offset) >= 0),
        x = text[y]?.indexOf(label, offset) ?? -1;
      if (x < 0) throw new Error(`Missing ${label}\n${app.captureCharFrame()}`);
      await app.mockMouse.click(x + 1, y);
      await app.renderOnce();
      await app.renderOnce();
    },
    async scroll(id: string, position: number) {
      const target = get(id);
      if (!(target instanceof ScrollBoxRenderable)) throw new Error(`Not a scroll box: ${id}`);
      target.scrollTo(position);
      await app.renderOnce();
      await app.renderOnce();
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

function gitFixture(counts = { MAIN: 70, FEATURE: 70 }) {
  const loads: string[] = [],
    comparisons: string[] = [];
  const source = (tree: string): GitSource => ({
    load: async () => {
      loads.push(tree);
      const count = tree === "MAIN" ? counts.MAIN : counts.FEATURE;
      const commits = Array.from({ length: count }, (_, index) => ({
        oid: (index + 1).toString(16).padStart(40, "0"),
        parents: index < count - 1 ? [(index + 2).toString(16).padStart(40, "0")] : [],
        subject: `GIT${tree}-${String(index).padStart(3, "0")}`,
        author: "Ada",
        date: "2026-10-15",
      }));
      return ok({
        head: tree,
        headOid: commits[0]!.oid,
        commits,
        refs: [],
        reflog: [],
        files: [{ kind: "unstaged" as const, status: "M", path: "probe.txt" }],
      });
    },
    details: async (commit) => ok({ commit, message: commit.subject, files: [], branches: [] }),
    compare: async () => {
      comparisons.push(tree);
      const before = lines(`DIFF${tree}`) + "\n";
      return ok({
        before,
        after: before.replace("-050", "-050 modified"),
        beforeLabel: "HEAD:probe.txt",
        afterLabel: "worktree:probe.txt",
      });
    },
  });
  return {
    loads,
    comparisons,
    git: {
      source: (tree: { id: string }) => source(tree.id === "demo:main" ? "MAIN" : "FEATURE"),
      createSession: async () => ok("unused"),
      prompt: () => ok(undefined),
    },
  };
}

test("Agent worktree transitions use saved reading positions from the first visible frame", async () => {
  // Distinct saved positions reveal one-frame exposure of old viewports.
  const app = await mount();
  try {
    await app.scroll("session-transcript", 17);
    const main = app.first(/MAIN-\d{3}/);
    expect(main).toBe("MAIN-017");
    await app.click(`${icons.folder} radian-ui`);
    await app.scroll("session-transcript", 43);
    const feature = app.first(/FEATURE-\d{3}/);
    expect(feature).toBe("FEATURE-043");
    const record = app.capture(/(?:MAIN|FEATURE)-\d{3}/);

    // Inspect all visible transition frames rather than hiding bugs behind final-state waits.
    await app.click(`${icons.folder} radian`);
    await app.click(`${icons.folder} radian-ui`);
    record.stop();

    expect(record.frames.length).toBeGreaterThan(0);
    expect(
      record.frames.filter((frame) => frame.tree === "demo:main").map((frame) => frame.first),
    ).not.toContain(null);
    expect(
      new Set(
        record.frames.filter((frame) => frame.tree === "demo:main").map((frame) => frame.first),
      ),
    ).toEqual(new Set([main]));
    expect(
      new Set(
        record.frames.filter((frame) => frame.tree === "demo:feature").map((frame) => frame.first),
      ),
    ).toEqual(new Set([feature]));
  } finally {
    await app.close();
  }
});

test("Restoring long sessions from short conversations never clamps saved positions to old scroll ranges", async () => {
  // The previous unscrollable conversation must not prevent restoring line 57.
  const app = await mount({
    initialWorkViews: { active: {}, agentScroll: { a1: 0, b1: 57 } },
    getSessionDetails: (id) => ({
      status: "complete",
      error: null,
      output: id === "a1" ? "SHORT-000" : lines("LONG"),
    }),
  });
  const record = app.capture(/(?:SHORT|LONG)-\d{3}/);
  try {
    app.resize(100, 20);
    await app.renderOnce();
    await app.renderOnce();
    await app.click(`${icons.folder} radian-ui`);

    expect(
      new Set(
        record.frames.filter((frame) => frame.tree === "demo:feature").map((frame) => frame.first),
      ),
    ).toEqual(new Set(["LONG-057"]));
    expect(app.view.workViewPreferences.agentScroll.b1).toBe(57);

    // Selection changes before first paint must not overwrite cancelled-session positions.
    app.selection.selectSession("demo:main", "a1");
    app.selection.selectSession("demo:feature", "b1");
    app.selection.selectSession("demo:main", "a1");
    await app.renderOnce();
    await app.renderOnce();
    expect(app.first(/(?:SHORT|LONG)-\d{3}/)).toBe("SHORT-000");
    expect(app.view.workViewPreferences.agentScroll.b1).toBe(57);
  } finally {
    record.stop();
    await app.close();
  }
});

test("Long Git list restoration never clamps to placeholders or shorter previous lists", async () => {
  // A short first-worktree list cannot measure the next worktree's saved row 48.
  const fixture = gitFixture({ MAIN: 3, FEATURE: 70 });
  const app = await mount({
    git: fixture.git,
    initialWorkViews: {
      active: {},
      agentScroll: {},
      gitViews: { "demo:feature": { ...initialGitState(), historyScroll: 48 } },
    },
  });
  const record = app.capture(/GIT(?:MAIN|FEATURE)-\d{3}/);
  try {
    await app.showGit();
    await app.waitForFrame((frame) => frame.includes("GITMAIN-000"));
    await app.click(`${icons.folder} radian-ui`);
    await app.showGit();
    await app.waitForFrame((frame) => frame.includes("GITFEATURE-"));

    const populated = record.frames.filter(
      (frame) => frame.tree === "demo:feature" && frame.first !== null,
    );
    expect(populated.length).toBeGreaterThan(0);
    expect(new Set(populated.map((frame) => frame.first))).toEqual(new Set(["GITFEATURE-023"]));
    expect(app.view.workViewPreferences.gitViews?.["demo:feature"]?.historyScroll).toBe(48);
  } finally {
    record.stop();
    await app.close();
  }
});

test("Cached Git lists preserve per-worktree scroll from the first paint while revalidating", async () => {
  // Distinct cached positions must survive fresh repository reads on each worktree return.
  const fixture = gitFixture(),
    app = await mount({ git: fixture.git });
  try {
    await app.showGit();
    await app.waitForFrame((frame) => frame.includes("GITMAIN-000"));
    await app.scroll("git-history", 24);
    const main = app.first(/GITMAIN-\d{3}/);
    await app.click(`${icons.folder} radian-ui`);
    await app.showGit();
    await app.waitForFrame((frame) => frame.includes("GITFEATURE-000"));
    await app.scroll("git-history", 48);
    const feature = app.first(/GITFEATURE-\d{3}/);
    expect(main).not.toBeNull();
    expect(feature).not.toBeNull();
    expect(fixture.loads).toEqual(["MAIN", "FEATURE"]);
    const record = app.capture(/GIT(?:MAIN|FEATURE)-\d{3}/);

    // Return to both cached worktrees and inspect every frame during revalidation.
    await app.click(`${icons.folder} radian`);
    await app.click(`${icons.folder} radian-ui`);
    record.stop();

    expect(
      new Set(
        record.frames.filter((frame) => frame.tree === "demo:main").map((frame) => frame.first),
      ),
    ).toEqual(new Set([main]));
    expect(
      new Set(
        record.frames.filter((frame) => frame.tree === "demo:feature").map((frame) => frame.first),
      ),
    ).toEqual(new Set([feature]));
    // Each return refreshes its snapshot without briefly displaying a reset viewport.
    expect(fixture.loads).toEqual(["MAIN", "FEATURE", "MAIN", "FEATURE"]);
  } finally {
    await app.close();
  }
});

test("Cached Git diffs preserve saved positions from the first paint while revalidating", async () => {
  // Fresh comparisons must retain each worktree's distinct synchronized reading position.
  const fixture = gitFixture(),
    app = await mount({ git: fixture.git });
  const scroll = async (position: number) => {
    const panes = walk(app.get("git-diff")).filter(
      (node): node is CodeRenderable => node instanceof CodeRenderable,
    );
    expect(panes).toHaveLength(2);
    for (const pane of panes) pane.scrollY = position;
    await app.renderOnce();
    await app.renderOnce();
  };
  try {
    await app.showGit();
    await app.waitForFrame((frame) => frame.includes("Working tree"));
    app.get("git-history").focus();
    app.mockInput.pressEnter();
    await app.waitForFrame((frame) => frame.includes("DIFFMAIN-000"));
    await scroll(35);
    const main = app.first(/DIFFMAIN-\d{3}/);
    expect(main).toBe("DIFFMAIN-035");
    await app.click(`${icons.folder} radian-ui`);
    await app.showGit();
    await app.waitForFrame((frame) => frame.includes("Working tree"));
    app.get("git-history").focus();
    app.mockInput.pressEnter();
    await app.waitForFrame((frame) => frame.includes("DIFFFEATURE-000"));
    await scroll(7);
    const feature = app.first(/DIFFFEATURE-\d{3}/);
    expect(feature).toBe("DIFFFEATURE-007");
    expect(fixture.loads).toEqual(["MAIN", "FEATURE"]);
    expect(fixture.comparisons).toEqual(["MAIN", "FEATURE"]);
    const record = app.capture(/DIFF(?:MAIN|FEATURE)-\d{3}/, true);

    // Reopen the cached diffs and observe the first visible frame as new comparisons arrive.
    await app.click(`${icons.folder} radian`);
    await app.click(`${icons.folder} radian-ui`);
    record.stop();

    expect(
      new Set(
        record.frames.filter((frame) => frame.tree === "demo:main").map((frame) => frame.first),
      ),
    ).toEqual(new Set([main]));
    expect(
      new Set(
        record.frames.filter((frame) => frame.tree === "demo:feature").map((frame) => frame.first),
      ),
    ).toEqual(new Set([feature]));
    // Snapshots and comparisons both refresh on return while the cached positions remain stable.
    expect(fixture.loads).toEqual(["MAIN", "FEATURE", "MAIN", "FEATURE"]);
    expect(fixture.comparisons).toEqual(["MAIN", "FEATURE", "MAIN", "FEATURE"]);
  } finally {
    await app.close();
  }
});
