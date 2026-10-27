import { openWorkspaceSearch } from "../../testing/keys.ts";
import { expect, spyOn, test } from "bun:test";
import {
  CodeRenderable,
  DiffRenderable,
  ScrollBoxRenderable,
  parseKeypress,
  TextAttributes,
  TextRenderable,
  type ClipboardRepresentation,
  type Renderable,
  type TerminalColors,
} from "@opentui/core";
import { uiTheme } from "../../ui/theme.ts";
import { blendColors } from "../../ui/color.ts";
import { Button } from "../../ui/button.ts";
import { PromptInput } from "../../ui/prompt-input.ts";
import { Clipboard } from "../../ui/clipboard.ts";
import { SearchInput } from "../../ui/search-input.ts";
import { createTestRenderer, ManualClock, MockTreeSitterClient } from "@opentui/core/testing";
import { Workbench } from "../../app/ui/workbench.ts";
import { WorkspaceSelection } from "../../app/workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { icons } from "../../icons.ts";
import type { GitActions } from "./panel.ts";
import {
  initialGitState,
  type GitCommit,
  type GitComparison,
  type GitDetails,
  type GitFile,
  type GitSnapshot,
  type GitSource,
} from "../model.ts";
import type { WorkViewPreferences } from "../../runtime/protocol.ts";
import { ClipboardError, GitError, InputError, type ExpectedError } from "../../errors.ts";
import { err, ok, type Result } from "../../result.ts";
import { parseKeymap, type Keymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";

const commit: GitCommit = {
  oid: "a".repeat(40),
  parents: ["b".repeat(40)],
  subject: "Update login",
  author: "Ada",
  date: "2026-10-15",
};
const rootCommit: GitCommit = {
  ...commit,
  oid: "b".repeat(40),
  parents: [],
  subject: "Initial login",
};
const snapshot = (): GitSnapshot => ({
  head: "main",
  headOid: commit.oid,
  commits: [commit, rootCommit],
  refs: [
    { kind: "local", name: "main", ref: "refs/heads/main", oid: commit.oid },
    { kind: "remote", name: "origin/main", ref: "refs/remotes/origin/main", oid: rootCommit.oid },
    { kind: "tag", name: "v1", ref: "refs/tags/v1", oid: rootCommit.oid },
  ],
  files: [
    { kind: "unstaged", status: "M", path: "src/login.ts" },
    { kind: "untracked", status: "?", path: "notes.txt" },
  ],
  reflog: [
    { oid: commit.oid, selector: "HEAD@{0}", subject: "commit: Update login", date: "2026-10-15" },
  ],
});
const comparison = (): GitComparison => {
  const before =
    Array.from({ length: 70 }, (_, i) => `const line${String(i).padStart(2, "0")} = ${i};`).join(
      "\n",
    ) + "\n";
  return {
    before,
    after: before.replace("line30 = 30", "line30 = 300"),
    beforeLabel: "HEAD:src/login.ts",
    afterLabel: "worktree:src/login.ts",
  };
};

async function mount(
  options: {
    actions?: Partial<GitActions>;
    initial?: WorkViewPreferences;
    source?: GitSource;
    clock?: ManualClock;
    keymap?: Keymap;
  } = {},
) {
  const app = await createTestRenderer({
    width: 160,
    height: 32,
    kittyKeyboard: true,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const selection = new WorkspaceSelection(demoWorkspace());
  const copies: string[] = [],
    requests: { id: string; text: string }[] = [],
    loads: string[] = [],
    creations: string[] = [];
  const highlighter = new MockTreeSitterClient({ autoResolveTimeout: 0 });
  const source: GitSource = options.source ?? {
    load: async (ref) => {
      loads.push(ref ?? "all");
      return ok(snapshot());
    },
    details: async (selected) =>
      ok({
        commit: selected,
        message: `${selected.subject}\n\nFull explanation of the change.\n`,
        branches: snapshot().refs.filter((ref) => ref.kind !== "tag" && ref.oid === selected.oid),
        files: [
          { kind: "commit", status: "M", path: "src/login.ts", commit: selected },
          { kind: "commit", status: "M", path: "src/other.ts", commit: selected },
        ],
      }),
    compare: async () => ok(comparison()),
  };
  const git: GitActions = {
    source: () => source,
    treeSitterClient: highlighter,
    createSession: async (id) => {
      creations.push(id);
      return ok("new-session");
    },
    prompt: (id, text) => {
      requests.push({ id, text });
      return ok(undefined);
    },
    copy: async (text) => {
      copies.push(text);
      return ok("Copied to clipboard");
    },
    ...options.actions,
  };
  const view = new Workbench(app.renderer, selection, {
    onNewSession: () => {},
    onCloseSession: () => {},
    onPrompt: git.prompt,
    git,
    ...(options.keymap ? { keymap: options.keymap } : {}),
    initialWorkViews: options.initial ?? { active: {}, agentScroll: {} },
    initialDrafts: { a1: "existing Agent draft" },
    getSessionDetails: () => ({ status: "working", output: "Existing agent run", error: null }),
  });
  const walk = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(walk)];
  const get = (id: string) => {
    const result = walk(app.renderer.root).find((node) => node.id === id);
    if (!result) throw new Error(`Missing ${id}`);
    return result;
  };
  await app.renderOnce();
  const click = async (text: string) => {
    if (text.startsWith(icons.folder)) {
      openWorkspaceSearch(app);
      app.mockInput.pressCtrlC();
      await app.renderOnce();
    }
    const lines = app.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes(text)),
      x = lines[y]?.indexOf(text) ?? -1;
    if (x < 0) throw new Error(`Missing ${text}\n${app.captureCharFrame()}`);
    await app.mockMouse.click(x + Math.min(1, text.length - 1), y);
    await app.renderOnce();
  };
  const showGit = async () => {
    app.mockInput.pressKey(" ", { ctrl: true });
    app.mockInput.pressKey("g");
    await app.renderOnce();
    await app.renderOnce();
  };
  if (!options.initial?.active["demo:main"]) await showGit();
  await app.waitForFrame(
    (frame) =>
      frame.includes("Working tree") ||
      get("git-diff").visible ||
      get("git-details-card").visible ||
      frame.includes("HEAD@{"),
  );
  const positionIn = (id: string, text: string) => {
    const region = get(id),
      lines = app.captureCharFrame().split("\n");
    for (let y = region.y; y < region.y + region.height; y++) {
      const offset = lines[y]?.slice(region.x, region.x + region.width).indexOf(text) ?? -1;
      if (offset >= 0) return { x: region.x + offset, y };
    }
    throw new Error(`Missing ${text} in ${id}\n${app.captureCharFrame()}`);
  };
  return {
    ...app,
    view,
    selection,
    copies,
    requests,
    loads,
    creations,
    get,
    click,
    showGit,
    positionIn,
    async clickIn(id: string, text: string) {
      const { x, y } = positionIn(id, text);
      await app.mockMouse.click(x + Math.min(1, text.length - 1), y);
      await app.renderOnce();
    },
    spanIn(id: string, text: string) {
      const position = positionIn(id, text);
      let x = 0;
      const span = app.captureSpans().lines[position.y]!.spans.find((item) => {
        x += item.width;
        return x > position.x;
      });
      if (!span) throw new Error(`Missing colored text ${text} in ${id}`);
      return span;
    },
    codes: () =>
      walk(get("git-diff")).filter(
        (node): node is CodeRenderable => node instanceof CodeRenderable,
      ),
    async chooseCommit() {
      await click("Update login");
      await app.waitFor(
        () => view.workViewPreferences.gitViews?.["demo:main"]?.selected === commit.oid,
      );
    },
    async openChanges() {
      get("git-history").focus();
      app.mockInput.pressEnter();
      await app.renderOnce();
      await app.renderOnce();
    },
    async openRefs() {
      get("git-history").focus();
      app.mockInput.pressKey("b");
      await app.renderOnce();
      await app.renderOnce();
    },
    async openReflog() {
      get("git-history").focus();
      app.mockInput.pressKey("r", { ctrl: true });
      await app.renderOnce();
      await app.renderOnce();
    },
    async openWorkingTree() {
      await click("Working tree");
      get("git-history").focus();
      app.mockInput.pressEnter();
      await app.renderOnce();
      await app.renderOnce();
    },
    async ask(text: string) {
      app.mockInput.pressKey("a");
      await app.renderOnce();
      await app.mockInput.typeText(text);
      app.mockInput.pressEnter();
      await app.waitFor(() => requests.length > 0);
      await app.renderOnce();
    },
    async close() {
      view.dispose();
      await app.dispose();
      await highlighter.destroy();
    },
  };
}

test.each(["refs", "reflog"] as const)(
  "Git %s modals align search with lists and give split previews full content height",
  async (mode) => {
    // Refs without previews keep full-width search; only Reflog splits into columns.
    const app = await mount();
    try {
      if (mode === "refs") await app.openRefs();
      else await app.openReflog();
      const input = app.get("git-browser-search");
      if (!(input instanceof SearchInput)) throw new Error("Missing Git search");
      await app.mockInput.typeText(mode === "refs" ? "main" : "login");
      app.mockInput.pressArrow("left");
      await app.renderOnce();
      const value = input.value,
        cursor = input.cursorOffset;

      // Crossing breakpoints in both directions keeps search aligned with list columns.
      for (const width of [160, 100, 99, 60, 160]) {
        app.resize(width, 32);
        await app.renderOnce();
        await app.renderOnce();
        const field = input.field,
          list = app.get("git-browser-list"),
          preview = app.get("git-reflog-preview-pane"),
          message = app.get("git-browser-status");

        // Search and result hints must not extend over right-side previews.
        expect(field.x + 1).toBe(list.x);
        expect(field.width - 2).toBe(list.width);
        expect(message.x).toBe(list.x);
        expect(message.y).toBe(field.y + field.height);
        expect(list.y).toBe(message.y + message.height);
        expect(preview.visible).toBe(mode === "reflog" && width >= 100);
        if (preview.visible) {
          expect(field.x + field.width).toBe(preview.x);
          expect(preview.y).toBe(field.y);
          expect(preview.y + preview.height).toBe(list.y + list.height);
          const lines = app.captureCharFrame().split("\n");
          expect(lines[field.y]![preview.x]).toBe("│");
          expect(lines[message.y]![preview.x]).toBe("│");
        }
        expect(input.value).toBe(value);
        expect(input.cursorOffset).toBe(cursor);
        expect(app.renderer.currentFocusedRenderable).toBe(input);
      }
      expect(app.view.promptDrafts.a1).toBe("existing Agent draft");
      expect(app.requests).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Reflog previews distinguish event/commit times and open absent commits in Changes before restoring main selection", async () => {
  // Model commits absent from all refs but retained in reflog.
  const lost: GitCommit = {
    ...commit,
    oid: "c".repeat(40),
    parents: [rootCommit.oid],
    subject: "Lost change",
    date: "2026-10-10",
  };
  const details: GitDetails = {
    commit: lost,
    message: "Complete lost commit message",
    branches: [],
    files: [{ kind: "commit", status: "M", path: "lost.txt", commit: lost }],
  };
  const data = snapshot();
  data.reflog = [
    {
      oid: lost.oid,
      selector: "HEAD@{1}",
      date: "2026-10-21 14:32:00 +0900",
      subject: "commit: Lost change",
    },
  ];
  const lookedUp: string[] = [],
    compared: GitFile[] = [];
  const app = await mount({
    source: {
      load: async () => ok(data),
      details: async (selected) =>
        ok({ commit: selected, message: "Main details", files: [], branches: [] }),
      lookup: async (oid) => {
        lookedUp.push(oid);
        return ok(details);
      },
      compare: async (file) => {
        compared.push(file);
        return ok({
          before: "old lost content\n",
          after: "only in lost commit\n",
          beforeLabel: "parent:lost.txt",
          afterLabel: "commit:lost.txt",
        });
      },
    },
  });
  try {
    await app.chooseCommit();
    await app.waitForFrame((frame) => frame.includes("Main details"));
    const before = structuredClone(app.view.workViewPreferences.gitViews?.["demo:main"]);

    await app.openReflog();
    await app.waitForFrame((frame) => frame.includes("Complete lost commit message"));
    const preview = app.get("git-reflog-preview-text");
    if (!(preview instanceof TextRenderable)) throw new Error("Missing reflog preview");
    expect(preview.plainText).toContain("Occurred: 2026-10-21");
    expect(preview.plainText).toContain("Date: 2026-10-10");
    expect(preview.plainText).toContain("Target commit");
    expect(lookedUp).toEqual([lost.oid]);
    app.mockInput.pressEnter();
    await app.waitForFrame((frame) => frame.includes("only in lost commit"));

    expect(app.get("git-browser").visible).toBe(false);
    expect(app.get("git-changes").visible).toBe(true);
    expect(compared[0]?.commit).toEqual(lost);
    expect(app.captureCharFrame()).not.toContain("ccccccc · Lost change");
    const saved = app.view.workViewPreferences.gitViews?.["demo:main"];
    expect(saved?.selected).toBe(before?.selected);
    expect(saved?.file).toBe(before?.file);
    expect(saved?.diff).toBe(false);
    app.mockInput.pressEscape();
    await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("git-history");
    expect(app.captureCharFrame()).toContain("Main details");
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBe(commit.oid);
    expect(app.view.promptDrafts.a1).toBe("existing Agent draft");
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Enter intent survives loading Reflog previews and opens the ready target commit", async () => {
  // Enter before metadata arrival must not discard valid selection intent.
  const target = { ...commit, oid: "c".repeat(40), subject: "Delayed target" },
    data = snapshot();
  data.reflog = [
    { oid: target.oid, selector: "HEAD@{0}", date: "2026-10-21", subject: "delayed event" },
  ];
  const pending = Promise.withResolvers<Result<GitDetails, ExpectedError>>(),
    compared: GitFile[] = [];
  const app = await mount({
    source: {
      load: async () => ok(data),
      lookup: () => pending.promise,
      details: async (selected) =>
        ok({ commit: selected, message: selected.subject, files: [], branches: [] }),
      compare: async (file) => {
        compared.push(file);
        return ok({
          before: "previous content\n",
          after: "Ready delayed commit\n",
          beforeLabel: "parent:delayed.txt",
          afterLabel: "commit:delayed.txt",
        });
      },
    },
  });
  try {
    await app.openReflog();
    app.mockInput.pressEnter();
    await app.renderOnce();
    expect(app.get("git-changes").visible).toBe(false);

    pending.resolve(
      ok({
        commit: target,
        message: "Delayed full message",
        files: [{ kind: "commit", status: "M", path: "delayed.txt", commit: target }],
        branches: [],
      }),
    );
    await app.waitForFrame((frame) => frame.includes("Ready delayed commit"));

    // Verify the actual opened target through its file comparison, not a removed popup title.
    expect(app.get("git-changes").visible).toBe(true);
    expect(compared[0]?.commit).toEqual(target);
    expect(app.get("git-browser").visible).toBe(false);
    expect(app.captureCharFrame()).not.toContain("ccccccc · Delayed target");
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBeNull();
    expect(app.requests).toEqual([]);
  } finally {
    pending.resolve(ok({ commit: target, message: "cleanup", files: [], branches: [] }));
    await app.close();
  }
});

test("Late Reflog previews never overwrite new events and shared commits reuse lookups", async () => {
  // Events pointing to the same commit retain distinct descriptions.
  const slow: GitCommit = { ...commit, oid: "c".repeat(40) },
    fresh: GitCommit = { ...commit, oid: "d".repeat(40) };
  const data = snapshot();
  data.reflog = [slow, fresh, fresh].map((target, index) => ({
    oid: target.oid,
    selector: `HEAD@{${index}}`,
    date: "2026-10-21",
    subject: `event ${index}`,
  }));
  const pending = Promise.withResolvers<Result<GitDetails, ExpectedError>>();
  let previousSignal: AbortSignal | undefined;
  const reads: string[] = [];
  const app = await mount({
    source: {
      load: async () => ok(data),
      details: async (selected) =>
        ok({ commit: selected, message: selected.subject, files: [], branches: [] }),
      compare: async () => ok(comparison()),
      lookup: async (oid, signal) => {
        reads.push(oid);
        if (oid === slow.oid) {
          previousSignal = signal;
          return pending.promise;
        }
        return ok({ commit: fresh, message: "Fresh target", files: [], branches: [] });
      },
    },
  });
  try {
    await app.openReflog();
    app.mockInput.pressKey("n", { ctrl: true });
    await app.waitForFrame((frame) => frame.includes("Fresh target"));
    pending.resolve(ok({ commit: slow, message: "Stale target", files: [], branches: [] }));
    await app.renderOnce();
    await app.renderOnce();
    app.mockInput.pressKey("n", { ctrl: true });
    await app.renderOnce();

    const preview = app.get("git-reflog-preview-text");
    if (!(preview instanceof TextRenderable)) throw new Error("Missing reflog preview");
    expect(previousSignal?.aborted).toBe(true);
    expect(preview.plainText).toContain("Event HEAD@{2}");
    expect(preview.plainText).toContain("event 2");
    expect(preview.plainText).toContain("Fresh target");
    expect(preview.plainText).not.toContain("Stale target");
    expect(reads).toEqual([slow.oid, fresh.oid]);
    expect(app.requests).toEqual([]);
  } finally {
    pending.resolve(ok({ commit: slow, message: "cleanup", files: [], branches: [] }));
    await app.close();
  }
});

test("Closing after Enter during preview loading prevents late Changes reopening and cleans timers", async () => {
  // Read completion does not imply reopening user-dismissed modals.
  const target = { ...commit, oid: "c".repeat(40) },
    data = snapshot();
  data.reflog = [
    { oid: target.oid, selector: "HEAD@{0}", date: "2026-10-21", subject: "lost event" },
  ];
  const pending = Promise.withResolvers<Result<GitDetails, ExpectedError>>();
  let signal: AbortSignal | undefined;
  const app = await mount({
    source: {
      load: async () => ok(data),
      details: async (selected) =>
        ok({ commit: selected, message: selected.subject, files: [], branches: [] }),
      compare: async () => ok(comparison()),
      lookup: (_oid, current) => {
        signal = current;
        return pending.promise;
      },
    },
  });
  try {
    await app.openReflog();
    expect(app.get("git-browser-loading").visible).toBe(true);

    app.mockInput.pressEnter();
    app.mockInput.pressEscape();
    await app.renderOnce();
    pending.resolve(ok({ commit: target, message: "Late target", files: [], branches: [] }));
    await app.renderOnce();
    await app.renderOnce();

    expect(signal?.aborted).toBe(true);
    expect(app.get("git-browser").visible).toBe(false);
    expect(app.get("git-changes").visible).toBe(false);
    expect(app.get("git-browser-loading").visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("git-history");
    expect(app.requests).toEqual([]);
  } finally {
    pending.resolve(ok({ commit: target, message: "cleanup", files: [], branches: [] }));
    await app.close();
  }
});

test.each([160, 60])(
  "%d-column Reflog failures show errors, block empty Enter details, and retry with r",
  async (width) => {
    // Treating failed commits as empty changes misrepresents recovery targets.
    const target = { ...commit, oid: "c".repeat(40) },
      data = snapshot();
    data.reflog = [
      { oid: target.oid, selector: "HEAD@{0}", date: "2026-10-21", subject: "lost event" },
    ];
    let reads = 0;
    const app = await mount({
      source: {
        load: async () => ok(data),
        details: async (selected) =>
          ok({ commit: selected, message: selected.subject, files: [], branches: [] }),
        compare: async () => ok(comparison()),
        lookup: async () =>
          ++reads === 1
            ? err(new GitError("GIT_QUERY_FAILED", "Lookup rejected"))
            : ok({ commit: target, message: "Recovered preview", files: [], branches: [] }),
      },
    });
    try {
      app.resize(width, 32);
      await app.renderOnce();
      await app.openReflog();
      await app.waitForFrame((frame) => frame.includes("Lookup rejected"));
      app.mockInput.pressEnter();
      await app.renderOnce();
      expect(app.get("git-changes").visible).toBe(false);

      app.get("git-browser-list").focus();
      app.mockInput.pressKey("r");
      await app.waitFor(() => {
        const text = app.get("git-reflog-preview-text");
        return text instanceof TextRenderable && text.plainText.includes("Recovered preview");
      });
      if (width < 100) app.mockInput.pressKey("o", { ctrl: true });
      await app.renderOnce();

      expect(reads).toBe(2);
      expect(app.get("git-browser").visible).toBe(true);
      expect(app.get("git-changes").visible).toBe(false);
      expect(app.requests).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test.each(["refs", "reflog"] as const)(
  "%s search keeps hjklay literal and Ctrl+C preserves modals and drafts even when empty",
  async (mode) => {
    // Git action letters in shared search must not trigger Copy or Ask.
    const data = snapshot();
    data.refs.push({
      kind: "local",
      name: "feature/hjklay",
      ref: "refs/heads/feature/hjklay",
      oid: commit.oid,
    });
    data.reflog[0] = { ...data.reflog[0]!, subject: "commit: hjklay" };
    const app = await mount({
      source: {
        load: async () => ok(data),
        details: async (selected) =>
          ok({ commit: selected, message: selected.subject, files: [], branches: [] }),
        compare: async () => ok(comparison()),
      },
    });
    try {
      if (mode === "refs") await app.openRefs();
      else await app.openReflog();
      await app.mockInput.typeText("hjklay");
      await app.renderOnce();
      const input = app.get("git-browser-search");
      if (!(input instanceof SearchInput)) throw new Error("Missing Git search");
      const cursor = input.cursorOffset;

      app.mockInput.pressKey("l", { ctrl: true });
      await app.renderOnce();
      expect(input.value).toBe("hjklay");
      expect(input.cursorOffset).toBe(cursor);
      expect(app.get("git-ask").visible).toBe(false);
      expect(app.copies).toEqual([]);
      app.mockInput.pressCtrlC();
      await app.renderOnce();
      const selected = app.view.workViewPreferences.gitViews?.["demo:main"];
      app.mockInput.pressCtrlC();
      await app.renderOnce();

      expect(input.value).toBe("");
      expect(app.get("git-browser").visible).toBe(true);
      expect(app.renderer.isDestroyed).toBe(false);
      expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.refSelected).toBe(
        selected?.refSelected,
      );
      expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.reflogSelected).toBe(
        selected?.reflogSelected,
      );
      expect(app.view.promptDrafts.a1).toBe("existing Agent draft");
      expect(app.requests).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test.each(
  (["refs", "reflog"] as const).flatMap((mode) => [160, 60].map((width) => ({ mode, width }))),
)(
  "$mode at $width columns preserves query/caret and repeated jumps continue from current candidates",
  async ({ mode, width }) => {
    // Reveal results before jumping when returning from compact Reflog previews to search.
    const data = snapshot();
    data.refs = Array.from({ length: 40 }, (_, index) => ({
      kind: "local",
      name: `candidate-${index}`,
      ref: `refs/heads/candidate-${index}`,
      oid: commit.oid,
    }));
    data.reflog = Array.from({ length: 40 }, (_, index) => ({
      oid: commit.oid,
      selector: `HEAD@{${index}}`,
      subject: `candidate event ${index}`,
      date: "2026-10-21",
    }));
    const app = await mount({
      source: {
        load: async () => ok(data),
        details: async (selected) =>
          ok({ commit: selected, message: "Preview body", files: [], branches: [] }),
        compare: async () => ok(comparison()),
      },
    });
    const raw = (value: string) => {
      const parsed = parseKeypress(value, { useKittyKeyboard: true });
      if (!parsed) throw new Error("Invalid Kitty key");
      app.renderer.keyInput.processParsedKey(parsed);
    };
    try {
      app.resize(width, 32);
      await app.renderOnce();
      if (mode === "refs") await app.openRefs();
      else await app.openReflog();
      await app.mockInput.typeText("candidate");
      for (let index = 0; index < 10; index++) app.mockInput.pressKey("n", { ctrl: true });
      await app.renderOnce();
      const input = app.get("git-browser-search"),
        list = app.get("git-browser-list") as ScrollBoxRenderable;
      if (!(input instanceof SearchInput)) throw new Error("Missing Git search");
      input.cursorOffset = 2;
      const step = Math.max(1, Math.floor(list.viewport.height / 2));
      if (mode === "reflog" && width < 100) {
        app.mockInput.pressKey("o", { ctrl: true });
        await app.renderOnce();
        input.focus();
        await app.renderOnce();
        expect(list.visible).toBe(false);
      }

      raw("\x1b[100;5u");
      await app.renderOnce();
      raw("\x1b[100;5:2u");
      await app.renderOnce();
      raw("\x1b[100;5:3u");

      expect(list.visible).toBe(true);
      expect(app.renderer.currentFocusedRenderable).toBe(list);
      expect(input.value).toBe("candidate");
      expect(input.cursorOffset).toBe(2);
      const key =
        mode === "refs" ? `refs/heads/candidate-${10 + 2 * step}` : `HEAD@{${10 + 2 * step}}`;
      expect(
        mode === "refs"
          ? app.view.workViewPreferences.gitViews?.["demo:main"]?.refSelected
          : app.view.workViewPreferences.gitViews?.["demo:main"]?.reflogSelected,
      ).toBe(key);
      const row = app.get(`git-browser-list:${key}`);
      expect(row.y).toBeGreaterThanOrEqual(list.viewport.y);
      expect(row.y + row.height).toBeLessThanOrEqual(list.viewport.y + list.viewport.height);
      expect(app.requests).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test.each([160, 60])(
  "%d-column Reflog previews scroll bodies by half-pages and trap Tab focus inside modals",
  async (width) => {
    // Preview scroll keys never become event navigation or search editing.
    const app = await mount({
      source: {
        load: async () => ok(snapshot()),
        compare: async () => ok(comparison()),
        details: async (selected) =>
          ok({
            commit: selected,
            message: Array.from({ length: 80 }, (_, index) => `Preview line ${index}`).join("\n"),
            files: [],
            branches: [],
          }),
      },
    });
    try {
      app.resize(width, 32);
      await app.renderOnce();
      await app.openReflog();
      app.mockInput.pressKey("o", { ctrl: true });
      await app.renderOnce();
      const preview = app.get("git-reflog-preview") as ScrollBoxRenderable,
        selected = app.view.workViewPreferences.gitViews?.["demo:main"]?.reflogSelected;
      expect(app.renderer.currentFocusedRenderable).toBe(preview);

      app.mockInput.pressKey("d", { ctrl: true });
      await app.renderOnce();
      expect(preview.scrollTop).toBe(Math.max(1, Math.floor(preview.viewport.height / 2)));
      app.mockInput.pressKey("u", { ctrl: true });
      await app.renderOnce();
      expect(preview.scrollTop).toBe(0);
      app.mockInput.pressTab();
      await app.renderOnce();
      expect(app.renderer.currentFocusedRenderable?.id).toBe("git-browser-search");
      app.mockInput.pressTab();
      await app.renderOnce();
      expect(app.renderer.currentFocusedRenderable?.id).toBe("git-browser-list");
      app.mockInput.pressTab();
      await app.renderOnce();
      expect(app.renderer.currentFocusedRenderable).toBe(preview);

      expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.reflogSelected).toBe(selected);
      expect(app.requests).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Legacy Reflog/Refs preferences restore Commits without replaying removed tabs or modals", async () => {
  // Read legacy wire fields without forcing old tab/modal state on new connections.
  const app = await mount({
    initial: {
      active: { "demo:main": "git" },
      agentScroll: {},
      gitViews: {
        "demo:main": { ...initialGitState(), tab: "reflog", right: "refs", selected: commit.oid },
      },
    },
  });
  try {
    expect(app.get("git-browser").visible).toBe(false);
    expect(app.get("git-toolbar").visible).toBe(false);
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.tab).toBe("commits");
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.right).toBe("commit");
    expect(app.get("git-history").y).toBe(app.get("git-view").y);
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Left ref labels connect to graph nodes and graph/message bands share colors", async () => {
  // Summarize local branches, remote branches, and tags on one commit label.
  const data = snapshot();
  data.refs = [
    { kind: "local", name: "main", ref: "refs/heads/main", oid: commit.oid },
    { kind: "remote", name: "origin/main", ref: "refs/remotes/origin/main", oid: commit.oid },
    { kind: "tag", name: "v1", ref: "refs/tags/v1", oid: commit.oid },
  ];
  const app = await mount({
    source: {
      load: async () => ok(data),
      details: async (selected) =>
        ok({ commit: selected, message: selected.subject, files: [], branches: [] }),
      compare: async () => ok(comparison()),
    },
  });
  try {
    const prefix = `git-history:${commit.oid}`;
    const refs = app.positionIn("git-history", `HEAD → ${icons.branch} main +2`),
      graph = app.get(`${prefix}:graph`);
    const link = app.get(`${prefix}:message-link`),
      label = app.get(`${prefix}:label`);

    // Connectors never replace messages or commit parent relationships.
    expect(refs.y).toBe(graph.y);
    expect(refs.x).toBeLessThan(graph.x);
    expect(
      app
        .captureCharFrame()
        .split("\n")
        [refs.y]!.slice(refs.x, graph.x + 2),
    ).toMatch(new RegExp(`HEAD → ${icons.branch} main \\+2 ─+●`, "u"));
    expect(link.x).toBe(graph.x + graph.width);
    expect(label.x).toBe(link.x + link.width + 2);
    expect(link instanceof TextRenderable && link.plainText).toBe("    ");
    if (!(graph instanceof TextRenderable) || !(link instanceof TextRenderable))
      throw new Error("Missing graph band");
    expect(graph.plainText.slice(graph.plainText.indexOf("●") + 1).trim()).toBe("");
    const foreground = app.spanIn("git-history", "aaaaaaa").fg;
    const previousBand = blendColors(uiTheme(app.renderer).colors.panel, foreground, 0.16);
    const distance = (values: readonly number[]) =>
      values
        .slice(0, 3)
        .reduce((sum, value, index) => sum + (value - foreground.toInts()[index]!) ** 2, 0);
    expect(distance(link.bg.toInts())).toBeLessThan(distance(previousBand.toInts()));
    expect(app.spanIn("git-history", `HEAD → ${icons.branch} main +2`).fg.toInts()).toEqual(
      app.spanIn("git-history", "aaaaaaa").fg.toInts(),
    );
    expect(
      link instanceof TextRenderable && link.bg.equals(uiTheme(app.renderer).colors.panel),
    ).toBe(false);
    expect(app.captureCharFrame()).not.toContain("Update login [");
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each([160, 60])(
  "HEAD/current-branch labels retain leading branch icons at %d columns",
  async (width) => {
    // Combined HEAD/current-branch labels need the same icons as other branches.
    const app = await mount();
    try {
      app.resize(width, 32);
      await app.renderOnce();
      await app.renderOnce();

      const caption = app.get(`git-history:${commit.oid}:refs`);
      if (!(caption instanceof TextRenderable)) throw new Error("Missing HEAD ref label");
      expect(caption.plainText).toBe(`HEAD → ${icons.branch} main`);
      expect(app.positionIn("git-history", `${icons.branch} main`).y).toBe(caption.y);
      expect(app.requests).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Detached HEAD labels never invent current-branch icons", async () => {
  // Directly checked-out HEAD without a branch differs from branch labels.
  const data = { ...snapshot(), head: "" };
  const app = await mount({
    source: {
      load: async () => ok(data),
      compare: async () => ok(comparison()),
      details: async (selected) =>
        ok({ commit: selected, message: selected.subject, files: [], branches: [] }),
    },
  });
  try {
    const caption = app.get(`git-history:${commit.oid}:refs`);
    if (!(caption instanceof TextRenderable)) throw new Error("Missing HEAD ref label");

    expect(caption.plainText).toStartWith("HEAD (detached)");
    expect(caption.plainText).not.toContain(icons.branch);
    expect(caption.plainText).not.toContain("HEAD →");
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each([
  { width: 160, light: false },
  { width: 60, light: false },
  { width: 160, light: true },
  { width: 60, light: true },
])("History selection strengthens only node-to-message bands: %j", async ({ width, light }) => {
  // Both terminal brightnesses and compact layouts must distinguish selection without row fills.
  const app = await mount();
  const cell = (x: number, y: number) => {
    let end = 0;
    const span = app.captureSpans().lines[y]!.spans.find((item) => {
      end += item.width;
      return end > x;
    });
    if (!span) throw new Error(`Missing cell ${x},${y}`);
    return span;
  };
  const bandBackground = (prefix: string) => {
    const graph = app.get(`${prefix}:graph`);
    return cell(graph.x + 1, graph.y).bg;
  };
  try {
    app.resize(width, 32);
    uiTheme(app.renderer).configure({
      palette: [],
      defaultForeground: light ? "#202020" : "#ECECEC",
      defaultBackground: light ? "#FAFAF6" : "#141414",
      cursorColor: null,
      mouseForeground: null,
      mouseBackground: null,
      tekForeground: null,
      tekBackground: null,
      highlightForeground: null,
      highlightBackground: null,
    });
    app.get("git-history").focus();
    await app.renderOnce();
    await app.renderOnce();
    const neutral = uiTheme(app.renderer).styles["ui.text"].bg!.toInts();
    const working = "git-history:__working_tree__",
      prefix = `git-history:${commit.oid}`;
    const idleBand = bandBackground(prefix).toInts(),
      foreground = app.spanIn("git-history", "aaaaaaa").fg.toInts();
    const distance = (values: readonly number[]) =>
      values.slice(0, 3).reduce((sum, value, index) => sum + (value - foreground[index]!) ** 2, 0);
    const expectBandOnly = (key: string) => {
      const graph = app.get(`${key}:graph`),
        band = app.get(`${key}:message-link`),
        label = app.get(`${key}:label`);
      const tint = bandBackground(key).toInts();
      expect(cell(graph.x, graph.y).bg.toInts()).toEqual(neutral);
      for (let x = graph.x + 1; x < band.x + band.width; x++)
        expect(cell(x, graph.y).bg.toInts()).toEqual(tint);
      for (let x = band.x + band.width; x < label.x + label.width; x++)
        expect(cell(x, label.y).bg.toInts()).toEqual(neutral);
      for (let x = graph.x; x < label.x + label.width; x++)
        expect(cell(x, graph.y + 1).bg.toInts()).toEqual(neutral);
      expect(label.x - band.x - band.width).toBe(2);
      expect(
        app
          .captureCharFrame()
          .split("\n")
          [label.y]!.slice(band.x + band.width, label.x),
      ).toBe("  ");
    };

    // Working tree shares the solid band, while its hollow node and dotted parent lane remain distinct.
    const workingBand = bandBackground(working).toInts();
    expect(distance(workingBand)).toBeLessThan(distance(idleBand));
    expectBandOnly(working);
    expect(app.captureCharFrame()).toContain("◌");
    expect(app.captureCharFrame()).toContain("┊");

    // Choosing a commit softens Working tree's solid band without removing it.
    await app.chooseCommit();
    await app.renderOnce();
    const focusedBand = bandBackground(prefix).toInts();
    expect(distance(focusedBand)).toBeLessThan(distance(idleBand));
    expectBandOnly(prefix);
    expect(bandBackground(working).toInts()).toEqual(idleBand);
    expectBandOnly(working);
    expect(app.get(`${working}:label`).x).toBe(app.get(`${prefix}:label`).x);

    // Losing focus softens, but does not erase, the selected commit's band.
    app.get("git-history").blur();
    await app.renderOnce();
    const inactiveBand = bandBackground(prefix).toInts();
    expect(distance(inactiveBand)).toBeGreaterThan(distance(focusedBand));
    expect(distance(inactiveBand)).toBeLessThan(distance(idleBand));
    expectBandOnly(prefix);

    // Keyboard selection transfers the emphasis and restores the previous idle band.
    app.get("git-history").focus();
    await app.renderOnce();
    expect(bandBackground(prefix).toInts()).toEqual(focusedBand);
    app.mockInput.pressKey("n", { ctrl: true });
    await app.renderOnce();
    await app.renderOnce();
    expect(bandBackground(prefix).toInts()).toEqual(idleBand);
    const next = `git-history:${rootCommit.oid}`;
    expect(distance(bandBackground(next).toInts())).toBeLessThan(distance(idleBand));
    expectBandOnly(next);
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Branching ref labels and message connectors preserve other lanes and both parent paths", async () => {
  // Prepare two splitting/joining merge lanes with a ref on one branch.
  const side = {
    ...commit,
    oid: "c".repeat(40),
    subject: "Side commit",
    parents: ["d".repeat(40)],
  };
  const left = { ...rootCommit, parents: ["d".repeat(40)] },
    base = { ...rootCommit, oid: "d".repeat(40), subject: "Base commit" };
  const data = snapshot();
  data.commits = [{ ...commit, parents: [left.oid, side.oid] }, left, side, base];
  data.refs.push({
    kind: "local",
    name: "feature/topic",
    ref: "refs/heads/feature/topic",
    oid: side.oid,
  });
  const app = await mount({
    source: {
      load: async () => ok(data),
      compare: async () => ok(comparison()),
      details: async (selected) =>
        ok({
          commit: selected,
          message: selected.subject,
          files: [],
          branches: data.refs.filter((ref) => ref.kind !== "tag" && ref.oid === selected.oid),
        }),
    },
  });
  try {
    const sideGraph = app.get(`git-history:${side.oid}:graph`),
      mainGraph = app.get(`git-history:${commit.oid}:graph`);
    if (!(sideGraph instanceof TextRenderable)) throw new Error("Missing side graph");

    expect(sideGraph.plainText).toMatch(/│──● /u);
    expect(app.captureCharFrame()).toContain("├──╮");
    expect(app.positionIn("git-history", "feature/topic").y).toBe(sideGraph.y);
    expect(
      app.spanIn("git-history", "ccccccc").fg.equals(app.spanIn("git-history", "aaaaaaa").fg),
    ).toBe(false);
    expect(mainGraph.x).toBe(sideGraph.x);

    // Expanded details retain commit nodes and messages on their original rows.
    await app.click("Side commit");
    await app.waitForFrame((frame) => frame.includes("Branches: feature/topic"));
    expect(sideGraph.plainText).toMatch(/│──● /u);
    expect(app.get(`git-history:${side.oid}`).height).toBe(2);
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Long Korean/emoji ref labels truncate by cells and retain additional-ref counts", async () => {
  // Branch names with differing string/cell widths verify connector alignment.
  const data = snapshot();
  data.refs = [
    {
      kind: "local",
      name: "feature/커밋🙂아주긴브랜치이름",
      ref: "refs/heads/feature/커밋🙂아주긴브랜치이름",
      oid: rootCommit.oid,
    },
    { kind: "remote", name: "origin/topic", ref: "refs/remotes/origin/topic", oid: rootCommit.oid },
    { kind: "tag", name: "v1", ref: "refs/tags/v1", oid: rootCommit.oid },
  ];
  const app = await mount({
    source: {
      load: async () => ok(data),
      compare: async () => ok(comparison()),
      details: async (selected) =>
        ok({ commit: selected, message: selected.subject, files: [], branches: [] }),
    },
  });
  try {
    app.resize(80, 24);
    await app.renderOnce();
    await app.renderOnce();

    const refs = app.get(`git-history:${rootCommit.oid}:refs`),
      graph = app.get(`git-history:${rootCommit.oid}:graph`);
    if (!(refs instanceof TextRenderable)) throw new Error("Missing ref caption");
    expect(refs.plainText).toContain("… +2");
    expect(refs.plainText).not.toContain("�");
    expect(Bun.stringWidth(refs.plainText)).toBeLessThan(graph.x - refs.x);
    expect(app.positionIn("git-history", "bbbbbbb").y).toBe(graph.y);
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Opening and closing commit details retains reserved left width and graph-row positions", async () => {
  // Detail cards sit outside graph layout and must not shift other commit rows.
  const app = await mount();
  try {
    const prefix = `git-history:${commit.oid}`,
      row = app.get(prefix),
      graph = app.get(`${prefix}:graph`);
    const reserved = graph.x,
      position = [row.y, row.height];

    await app.chooseCommit();
    await app.waitForFrame((frame) => frame.includes("Full explanation of the change."));
    const card = app.get("git-details-card"),
      anchor = app.get("git-details-anchor");

    expect(card.visible).toBe(true);
    expect(graph.x).toBe(reserved);
    expect([row.y, row.height]).toEqual(position);
    expect(card.x + card.width).toBeLessThanOrEqual(graph.x);
    expect([anchor.x, anchor.y]).toEqual([card.x + card.width - 1, row.y]);
    expect(app.get("git-changes").visible).toBe(false);

    // Disappearing details retain reserved space without graph movement.
    app.get("git-history").blur();
    await app.renderOnce();
    expect(card.visible).toBe(false);
    expect(graph.x).toBe(reserved);
    expect([row.y, row.height]).toEqual(position);
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBe(commit.oid);
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each(["arrows", "vim", "control"] as const)(
  "%s round-trips between Working tree and commits reserve details to stabilize graphs/messages",
  async (navigation) => {
    // Cardless Working tree uses the same column width as card-bearing commits.
    const app = await mount();
    const move = (next: boolean) =>
      navigation === "arrows"
        ? app.mockInput.pressArrow(next ? "down" : "up")
        : navigation === "control"
          ? app.mockInput.pressKey(next ? "n" : "p", { ctrl: true })
          : app.mockInput.pressKey(next ? "j" : "k");
    try {
      for (const width of [160, 60]) {
        app.resize(width, 32);
        app.get("git-history").focus();
        app.mockInput.pressKey("HOME");
        await app.renderOnce();
        await app.renderOnce();
        const graphX = app.get(`git-history:${commit.oid}:graph`).x,
          messageX = app.get(`git-history:${commit.oid}:label`).x;

        // Only card visibility changes; graph/message x coordinates stay fixed.
        for (const next of [true, false, true]) {
          move(next);
          await app.renderOnce();
          await app.renderOnce();
          expect(app.get("git-details-card").visible).toBe(next);
          expect(app.get(`git-history:${commit.oid}:graph`).x).toBe(graphX);
          expect(app.get(`git-history:${commit.oid}:label`).x).toBe(messageX);
          expect(app.get("git-history:__working_tree__:graph").x).toBe(graphX);
          expect(app.get("git-history:__working_tree__:label").x).toBe(messageX);
        }
        app.get("git-history").blur();
        await app.renderOnce();
        expect(app.get("git-details-card").visible).toBe(false);
        expect(app.get(`git-history:${commit.oid}:graph`).x).toBe(graphX);
      }
      expect(app.requests).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Detail branches, remotes, and tags show only refs directly targeting selected commits", async () => {
  // main/origin/main containment must not show refs whose tips point elsewhere.
  const data = snapshot();
  data.refs = [
    { kind: "local", name: "main", ref: "refs/heads/main", oid: commit.oid },
    { kind: "remote", name: "origin/main", ref: "refs/remotes/origin/main", oid: commit.oid },
    { kind: "tag", name: "old-tag", ref: "refs/tags/old-tag", oid: rootCommit.oid },
    { kind: "tag", name: "new-tag", ref: "refs/tags/new-tag", oid: commit.oid },
  ];
  const app = await mount({
    source: {
      load: async () => ok(data),
      compare: async () => ok(comparison()),
      details: async (selected) =>
        ok({
          commit: selected,
          message: `Message for ${selected.subject}`,
          files: [],
          branches: data.refs.filter((ref) => ref.kind !== "tag" && ref.oid === selected.oid),
        }),
    },
  });
  try {
    await app.click("Initial login");
    await app.waitForFrame((frame) => frame.includes("Message for Initial login"));

    const text = app.get("git-detail-text");
    if (!(text instanceof TextRenderable)) throw new Error("Missing commit details");
    expect(text.plainText).toContain("Branches: —");
    expect(text.plainText).toContain("Remotes: —");
    expect(text.plainText).toContain("Tags: old-tag");
    expect(text.plainText).not.toContain("new-tag");
    expect(text.plainText).not.toContain("HEAD");
    const tip = app.get(`git-history:${commit.oid}:refs`),
      ancestor = app.get(`git-history:${rootCommit.oid}:refs`);
    if (!(tip instanceof TextRenderable) || !(ancestor instanceof TextRenderable))
      throw new Error("Missing ref labels");
    expect(tip.plainText).toContain("main");
    expect(ancestor.plainText).not.toContain("main");

    // Moving to actual tips restores matching local/remote names and tags.
    await app.chooseCommit();
    await app.waitForFrame((frame) => frame.includes("Message for Update login"));
    expect(text.plainText).toContain("Branches: main");
    expect(text.plainText).toContain("Remotes: origin/main");
    expect(text.plainText).toContain("Tags: new-tag");
    expect(text.plainText).not.toContain("old-tag");
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Stable left-detail geometry never requests additional renders during screen refresh", async () => {
  // Resetting text or borders on every position correction would schedule endless frames.
  const clock = new ManualClock(),
    app = await mount({ clock });
  let cardRender: ReturnType<typeof spyOn<Renderable, "requestRender">> | undefined,
    anchorRender: ReturnType<typeof spyOn<Renderable, "requestRender">> | undefined;
  try {
    await app.chooseCommit();
    clock.advance(500);
    await app.renderOnce();
    await app.renderOnce();
    const card = app.get("git-details-card");
    cardRender = spyOn(card, "requestRender");
    anchorRender = spyOn(app.get("git-details-anchor"), "requestRender");

    // Frames from other UI must not make unchanged cards/connectors request rendering.
    await app.renderOnce();
    await app.renderOnce();

    expect(card.visible).toBe(true);
    expect(app.get("git-loading").visible).toBe(false);
    expect(cardRender).not.toHaveBeenCalled();
    expect(anchorRender).not.toHaveBeenCalled();
    const text = app.get("git-detail-text");
    if (!(text instanceof TextRenderable)) throw new Error("Missing details body");
    expect(card.height).toBe(text.virtualLineCount + 2);
  } finally {
    cardRender?.mockRestore();
    anchorRender?.mockRestore();
    await app.close();
  }
});

test("Details fully expand messages beyond old height caps without internal scrolling", async () => {
  // Prepare messages fitting the screen but exceeding the former 65% cap.
  const app = await mount({
    source: {
      load: async () => ok(snapshot()),
      compare: async () => ok(comparison()),
      details: async (selected) =>
        ok({
          commit: selected,
          message: Array.from({ length: 15 }, (_, index) => `Expanded message ${index}`).join("\n"),
          files: [],
          branches: [],
        }),
    },
  });
  try {
    await app.chooseCommit();
    await app.waitForFrame((frame) => frame.includes("Expanded message 14"));

    const card = app.get("git-details-card"),
      body = app.get("git-details"),
      text = app.get("git-detail-text");
    if (!(text instanceof TextRenderable)) throw new Error("Missing details body");
    expect(body instanceof ScrollBoxRenderable).toBe(false);
    expect(card.height).toBe(text.virtualLineCount + 2);
    expect(text.height).toBe(text.virtualLineCount);
    expect(card.height).toBeGreaterThan(app.get("git-history").height * 0.65);
    expect(app.captureCharFrame()).toContain("Author: Ada");
    expect(app.captureCharFrame()).toContain("Expanded message 14");
    expect(app.get(`git-history:${commit.oid}`).height).toBe(2);
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Oversized details fully expand and use shared Commits scrolling to read/copy tails", async () => {
  // Cards taller than terminals must not gain private scrollbars or inaccessible clipped content.
  const message =
    Array.from({ length: 80 }, (_, index) => `Long message ${index}`).join("\n") +
    "\nLast detail line";
  const app = await mount({
    source: {
      load: async () => ok(snapshot()),
      compare: async () => ok(comparison()),
      details: async (selected) => ok({ commit: selected, message, files: [], branches: [] }),
    },
  });
  try {
    await app.chooseCommit();
    app.mockInput.pressTab();
    await app.renderOnce();
    const history = app.get("git-history") as ScrollBoxRenderable,
      card = app.get("git-details-card"),
      body = app.get("git-details");
    expect(body instanceof ScrollBoxRenderable).toBe(false);
    expect(card.height).toBeGreaterThan(history.height);

    // Wheel input over cards moves shared viewports, not internal content.
    const author = app.positionIn("git-details", "Author: Ada");
    await app.mockMouse.scroll(author.x, author.y, "down");
    await app.renderOnce();
    expect(history.scrollTop).toBeGreaterThan(0);
    expect(app.renderer.currentFocusedRenderable).toBe(body);

    // End moves shared viewports while preserving commit selection.
    app.mockInput.pressKey("END");
    await app.renderOnce();
    await app.renderOnce();
    expect(history.scrollTop).toBeGreaterThan(0);
    expect(app.captureCharFrame()).toContain("Last detail line");
    expect(app.renderer.currentFocusedRenderable).toBe(body);
    expect(card.visible).toBe(true);
    const { x, y } = app.positionIn("git-details", "Last detail line");
    await app.mockMouse.drag(x, y, x + 3, y);
    await app.waitFor(() => app.copies.length > 0);

    expect(app.copies).toEqual(["Last"]);
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBe(commit.oid);
    expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).toContain("GIT");
    // Settle the shared scroll position and the independently mounted copy notification.
    app.mockInput.pressKey("HOME");
    await app.renderOnce();
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("Author: Ada");
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Detail cards omit duplicate titles and show actual branches/tags above authors", async () => {
  // Cards expose branch/tag names hidden behind ref-summary +N indicators.
  const data = snapshot();
  data.refs = [
    { kind: "local", name: "main", ref: "refs/heads/main", oid: commit.oid },
    { kind: "local", name: "feature/topic", ref: "refs/heads/feature/topic", oid: commit.oid },
    { kind: "remote", name: "origin/main", ref: "refs/remotes/origin/main", oid: commit.oid },
    { kind: "tag", name: "release/current", ref: "refs/tags/release/current", oid: commit.oid },
  ];
  const app = await mount({
    source: {
      load: async () => ok(data),
      compare: async () => ok(comparison()),
      details: async (selected) =>
        ok({
          commit: selected,
          message: "Full commit message",
          files: [],
          branches: data.refs.filter((ref) => ref.kind !== "tag" && ref.oid === selected.oid),
        }),
    },
  });
  try {
    await app.chooseCommit();
    await app.waitForFrame((frame) => frame.includes("Full commit message"));

    const card = app.get("git-details-card"),
      text = app.get("git-detail-text");
    expect(app.captureCharFrame()).not.toContain("Commit details");
    expect(text.y).toBe(card.y + 1);
    expect(app.captureCharFrame()).toContain("Branches: main, feature/topic");
    expect(app.captureCharFrame()).toContain("Remotes: origin/main");
    expect(app.captureCharFrame()).toContain("Tags: release/current");
    expect(app.positionIn("git-details", "Tags:").y).toBeLessThan(
      app.positionIn("git-details", "Author:").y,
    );
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Left details show all matching refs while excluding other commits' refs", async () => {
  // Details expose full source hidden behind summary +N counts.
  const data = snapshot();
  data.refs.push(
    { kind: "remote", name: "origin/main", ref: "refs/remotes/origin/main", oid: commit.oid },
    { kind: "tag", name: "release/current", ref: "refs/tags/release/current", oid: commit.oid },
  );
  const app = await mount({
    source: {
      load: async () => ok(data),
      compare: async () => ok(comparison()),
      details: async (selected) =>
        ok({
          commit: selected,
          message: "Full message",
          files: [],
          branches: data.refs.filter((ref) => ref.kind !== "tag" && ref.oid === selected.oid),
        }),
    },
  });
  try {
    await app.chooseCommit();
    await app.waitForFrame((frame) => frame.includes("Full message"));

    const text = app.get("git-detail-text");
    if (!(text instanceof TextRenderable)) throw new Error("Missing commit details");
    expect(text.plainText).toContain("HEAD → main");
    expect(text.plainText).toContain("Branches: main");
    expect(text.plainText).toContain("Remotes: origin/main");
    expect(text.plainText).toContain("Tags: release/current");
    expect(text.plainText).not.toContain("Tags: v1");
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each(["arrows", "vim", "control"] as const)(
  "%s navigation to refless commits updates left details and connector targets",
  async (navigation) => {
    // Ordinary commits away from branch tips also expose details when focused.
    const data = snapshot();
    data.refs = data.refs.filter((ref) => ref.oid === commit.oid);
    const app = await mount({
      source: {
        load: async () => ok(data),
        compare: async () => ok(comparison()),
        details: async (selected) =>
          ok({
            commit: selected,
            message: `Message for ${selected.subject}`,
            files: [],
            branches: [],
          }),
      },
    });
    try {
      await app.chooseCommit();

      if (navigation === "arrows") app.mockInput.pressArrow("down");
      else if (navigation === "control") app.mockInput.pressKey("n", { ctrl: true });
      else app.mockInput.pressKey("j");
      await app.waitForFrame((frame) => frame.includes("Message for Initial login"));

      const text = app.get("git-detail-text");
      if (!(text instanceof TextRenderable)) throw new Error("Missing commit details");
      expect(text.plainText).toContain(rootCommit.oid);
      expect(text.plainText).not.toContain("HEAD");
      expect(text.plainText).toContain("Branches: —");
      expect(text.plainText).toContain("Remotes: —");
      expect(text.plainText).toContain("Tags: —");
      expect(app.get("git-details-anchor").y).toBe(app.get(`git-history:${rootCommit.oid}`).y);
      expect(app.renderer.currentFocusedRenderable?.id).toBe("git-history");
      expect(app.requests).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Tab reads details and Esc returns without losing selection or hash actions", async () => {
  // Read-only details create neither separate commit actions nor Changes popups.
  const app = await mount();
  try {
    await app.chooseCommit();
    const list = app.get("git-history") as ScrollBoxRenderable,
      position = list.scrollTop;

    app.mockInput.pressTab();
    await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("git-details");
    app.mockInput.pressEscape();
    await app.renderOnce();
    app.mockInput.pressKey("y");
    await app.waitFor(() => app.copies.length > 0);

    expect(app.renderer.currentFocusedRenderable?.id).toBe("git-history");
    expect(list.scrollTop).toBe(position);
    expect(app.copies).toEqual([commit.oid]);
    expect(app.get("git-changes").visible).toBe(false);
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Rapid commit navigation prevents late details from overwriting current ref cards", async () => {
  // Late previous messages must preserve current selection and connectors.
  const pending = Promise.withResolvers<Result<import("../model.ts").GitDetails, ExpectedError>>();
  let previousSignal: AbortSignal | undefined;
  const app = await mount({
    source: {
      load: async () => ok(snapshot()),
      compare: async () => ok(comparison()),
      details: async (selected, signal) => {
        if (selected.oid === commit.oid) {
          previousSignal = signal;
          return pending.promise;
        }
        return ok({ commit: selected, message: "Current commit message", files: [], branches: [] });
      },
    },
  });
  try {
    await app.chooseCommit();
    app.mockInput.pressKey("n", { ctrl: true });
    await app.waitForFrame((frame) => frame.includes("Current commit message"));

    pending.resolve(ok({ commit, message: "Obsolete commit message", files: [], branches: [] }));
    await app.renderOnce();
    await app.renderOnce();

    const text = app.get("git-detail-text");
    if (!(text instanceof TextRenderable)) throw new Error("Missing commit details");
    expect(previousSignal?.aborted).toBe(true);
    expect(text.plainText).toContain(rootCommit.oid);
    expect(text.plainText).not.toContain("Obsolete commit message");
    expect(app.get("git-details-anchor").y).toBe(app.get(`git-history:${rootCommit.oid}`).y);
    expect(app.requests).toEqual([]);
  } finally {
    pending.resolve(ok({ commit, message: "cleanup", files: [], branches: [] }));
    await app.close();
  }
});

test("Changes round-trips retain left-detail message reading positions", async () => {
  // Inspecting changed files must not discard long-message reading positions.
  const app = await mount({
    source: {
      load: async () => ok(snapshot()),
      compare: async () => ok(comparison()),
      details: async (selected) =>
        ok({
          commit: selected,
          message: Array.from({ length: 80 }, (_, index) => `Message ${index}`).join("\n"),
          branches: [],
          files: [{ kind: "commit", status: "M", path: "src/login.ts", commit: selected }],
        }),
    },
  });
  try {
    await app.chooseCommit();
    app.mockInput.pressTab();
    await app.renderOnce();
    const history = app.get("git-history") as ScrollBoxRenderable;
    app.mockInput.pressKey("d", { ctrl: true });
    app.mockInput.pressKey("d", { ctrl: true });
    await app.renderOnce();
    const position = history.scrollTop;
    expect(position).toBeGreaterThan(0);

    app.mockInput.pressEscape();
    await app.renderOnce();
    await app.openChanges();
    await app.waitForFrame((frame) => frame.includes("const line00"));
    app.mockInput.pressEscape();
    await app.renderOnce();
    app.mockInput.pressTab();
    await app.renderOnce();

    expect(history.scrollTop).toBe(position);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("git-details");
    expect(app.get("git-details-card").visible).toBe(true);
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("New UIs restore shared viewport positions for expanded details", async () => {
  // Shared screen positions restore even without separate detail-scroll state.
  const source: GitSource = {
    load: async () => ok(snapshot()),
    compare: async () => ok(comparison()),
    details: async (selected) =>
      ok({
        commit: selected,
        message: Array.from({ length: 80 }, (_, index) => `Restored detail ${index}`).join("\n"),
        files: [],
        branches: [],
      }),
  };
  const app = await mount({ source });
  let retained: WorkViewPreferences;
  try {
    await app.chooseCommit();
    app.mockInput.pressTab();
    await app.renderOnce();
    app.mockInput.pressKey("END");
    await app.renderOnce();
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("Restored detail 79");
    retained = app.view.workViewPreferences;
  } finally {
    await app.close();
  }

  // Short commit lists must not clamp saved positions before full message heights are ready.
  const restored = await mount({ source, initial: retained! });
  try {
    await restored.waitForFrame((frame) => frame.includes("Restored detail 79"));

    expect(restored.view.workViewPreferences.gitViews?.["demo:main"]?.historyScroll).toBe(
      retained!.gitViews?.["demo:main"]?.historyScroll,
    );
    expect(restored.get("git-details") instanceof ScrollBoxRenderable).toBe(false);
    expect(restored.requests).toEqual([]);
  } finally {
    await restored.close();
  }
});

test("Closing Changes after reconnection restores shared long-detail reading positions", async () => {
  // Hidden background lists may be shorter than saved positions before cards expand.
  const source: GitSource = {
    load: async () => ok(snapshot()),
    compare: async () => ok(comparison()),
    details: async (selected) =>
      ok({
        commit: selected,
        message: Array.from({ length: 80 }, (_, index) => `Popup return ${index}`).join("\n"),
        branches: [],
        files: [{ kind: "commit", status: "M", path: "src/login.ts", commit: selected }],
      }),
  };
  const app = await mount({ source });
  let retained: WorkViewPreferences;
  try {
    await app.chooseCommit();
    app.mockInput.pressTab();
    await app.renderOnce();
    app.mockInput.pressKey("END");
    await app.renderOnce();
    app.mockInput.pressEscape();
    await app.renderOnce();
    await app.openChanges();
    await app.waitForFrame((frame) => frame.includes("const line00"));
    retained = app.view.workViewPreferences;
    expect(retained.gitViews?.["demo:main"]?.historyScroll).toBeGreaterThan(0);
  } finally {
    await app.close();
  }

  // Popup Esc must not overwrite saved positions with unexpanded background zero.
  const restored = await mount({ source, initial: retained! });
  try {
    await restored.waitForFrame((frame) => frame.includes("const line00"));
    restored.mockInput.pressEscape();
    await restored.waitForFrame((frame) => frame.includes("Popup return 79"));

    expect(restored.get("git-details-card").visible).toBe(true);
    expect(restored.get("git-changes").visible).toBe(false);
    expect(restored.view.workViewPreferences.gitViews?.["demo:main"]?.historyScroll).toBe(
      retained!.gitViews?.["demo:main"]?.historyScroll,
    );
    expect(restored.requests).toEqual([]);
  } finally {
    await restored.close();
  }
});

test("Scrolling selected commits offscreen hides details and removes hidden-body focus", async () => {
  // Mouse wheel scrolling must not attach detail bodies to unrelated commit rows.
  const data = snapshot();
  data.commits.push(
    ...Array.from({ length: 40 }, (_, index) => ({
      ...commit,
      oid: (index + 1).toString(16).padStart(40, "0"),
      subject: `Other ${index}`,
      parents: [],
    })),
  );
  const app = await mount({
    source: {
      load: async () => ok(data),
      compare: async () => ok(comparison()),
      details: async (selected) =>
        ok({ commit: selected, message: selected.subject, files: [], branches: [] }),
    },
  });
  try {
    await app.chooseCommit();
    app.mockInput.pressTab();
    await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("git-details");

    (app.get("git-history") as ScrollBoxRenderable).scrollTo(30);
    await app.renderOnce();
    await app.renderOnce();

    expect(app.get("git-details-card").visible).toBe(false);
    expect(app.get("git-details-anchor").visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("git-history");
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBe(commit.oid);
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Narrow left details retain full heights without changing graph-row heights", async () => {
  // Use final candidates and long messages whose cards extend below the viewport.
  const app = await mount();
  try {
    await app.chooseCommit();
    app.mockInput.pressKey("END");
    await app.renderOnce();

    for (const [width, height] of [
      [160, 32],
      [60, 12],
      [79, 18],
      [80, 17],
      [160, 32],
    ] as const) {
      app.resize(width, height);
      await app.renderOnce();
      await app.renderOnce();
      const card = app.get("git-details-card"),
        history = app.get("git-history"),
        row = app.get(`git-history:${rootCommit.oid}`);
      expect(card.visible).toBe(true);
      expect(card.y).toBeGreaterThanOrEqual(history.y);
      const text = app.get("git-detail-text");
      if (!(text instanceof TextRenderable)) throw new Error("Missing details body");
      expect(card.height).toBe(text.virtualLineCount + 2);
      expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).toContain("GIT");
      expect(card.x + card.width).toBeLessThanOrEqual(
        app.get(`git-history:${rootCommit.oid}:graph`).x,
      );
      expect(row.height).toBe(2);
      expect(app.get(`git-history:${rootCommit.oid}:label`).width).toBeGreaterThan(12);
    }
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each(["arrows", "vim", "control"] as const)(
  "Changes file %s navigation refreshes diffs and resets new-file scroll",
  async (navigation) => {
    // Distinct file contents verify selection matches actual diff targets.
    const compared: string[] = [];
    const app = await mount({
      source: {
        load: async () => ok(snapshot()),
        details: async (selected) =>
          ok({
            commit: selected,
            message: selected.subject,
            branches: [],
            files: [
              { kind: "commit", status: "M", path: "first.ts", commit: selected },
              { kind: "commit", status: "M", path: "second.ts", commit: selected },
            ],
          }),
        compare: async (file) => {
          compared.push(file.path);
          const before =
            Array.from({ length: 70 }, (_, index) => `${file.path} line ${index}`).join("\n") +
            "\n";
          return ok({
            before,
            after: before + "added\n",
            beforeLabel: file.path,
            afterLabel: file.path,
          });
        },
      },
    });
    const move = (next: boolean) =>
      navigation === "arrows"
        ? app.mockInput.pressArrow(next ? "down" : "up")
        : navigation === "control"
          ? app.mockInput.pressKey(next ? "n" : "p", { ctrl: true })
          : app.mockInput.pressKey(next ? "j" : "k");
    try {
      await app.chooseCommit();
      await app.openChanges();
      await app.waitForFrame((frame) => frame.includes("first.ts line 0"));
      app.get("git-diff").focus();
      app.mockInput.pressKey("END");
      await app.renderOnce();
      expect(app.codes()[0]!.scrollY).toBeGreaterThan(0);

      // File navigation preserves focus while replacing comparisons.
      app.get("git-files").focus();
      move(true);
      await app.waitForFrame((frame) => frame.includes("second.ts line 0"));
      expect(app.renderer.currentFocusedRenderable?.id).toBe("git-files");
      expect(app.codes().map((pane) => pane.scrollY)).toEqual([0, 0]);
      move(false);
      await app.waitForFrame((frame) => frame.includes("first.ts line 0"));

      expect(compared).toEqual(["first.ts", "second.ts", "first.ts"]);
      expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBe(commit.oid);
      expect(app.requests).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Empty-commit details remain readable in lists and Changes shows only empty-file state", async () => {
  // Empty commits retain readable messages without file-comparison calls.
  let comparisons = 0;
  const app = await mount({
    source: {
      load: async () => ok(snapshot()),
      details: async (selected) =>
        ok({ commit: selected, message: "Empty commit explanation", files: [], branches: [] }),
      compare: async () => {
        comparisons++;
        return ok(comparison());
      },
    },
  });
  try {
    await app.chooseCommit();
    await app.waitForFrame((frame) => frame.includes("Empty commit explanation"));
    await app.openChanges();

    expect(app.captureCharFrame()).not.toContain("Empty commit explanation");
    expect(app.get("git-details-card").visible).toBe(false);
    expect(app.get("git-changes").visible).toBe(true);
    expect(app.captureCharFrame()).toContain("Changed files (0)");
    expect(app.captureCharFrame()).toContain("No changed files");
    expect(comparisons).toBe(0);
    app.mockInput.pressEscape();
    await app.renderOnce();

    expect(app.get("git-changes").visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("git-history");
  } finally {
    await app.close();
  }
});

test("Changes results appear immediately while spinners honor minimums and clean timers on close", async () => {
  // Delay only comparisons while observing actual popup spinner lifetimes.
  const clock = new ManualClock(),
    pending = Promise.withResolvers<Result<GitComparison, ExpectedError>>();
  const app = await mount({
    clock,
    source: {
      load: async () =>
        ok({ ...snapshot(), files: [{ kind: "unstaged", status: "M", path: "loading.txt" }] }),
      details: async (selected) =>
        ok({ commit: selected, message: selected.subject, files: [], branches: [] }),
      compare: () => pending.promise,
    },
  });
  try {
    await app.openWorkingTree();
    const spinner = app.get("git-changes-loading");
    expect(spinner.visible).toBe(true);
    expect(app.captureCharFrame()).toContain("Loading file comparison");

    // Results stay readable before the spinner minimum ends.
    pending.resolve(ok(comparison()));
    await app.renderOnce();
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("const line00");
    expect(spinner.visible).toBe(true);
    clock.advance(499);
    await app.renderOnce();
    expect(spinner.visible).toBe(true);
    app.mockInput.pressEscape();
    await app.renderOnce();

    expect(spinner.visible).toBe(false);
    clock.advance(1000);
    await app.renderOnce();
    expect(spinner.visible).toBe(false);
    expect(app.get("git-changes").visible).toBe(false);
    expect(app.requests).toEqual([]);
  } finally {
    pending.resolve(ok(comparison()));
    await app.close();
  }
});

test("Closing during detail lookup prevents late popup or diff reopening", async () => {
  // Sources ignoring cancellation still must not resurrect dismissed surfaces.
  const pending = Promise.withResolvers<Result<import("../model.ts").GitDetails, ExpectedError>>();
  let comparisons = 0;
  const app = await mount({
    source: {
      load: async () => ok(snapshot()),
      details: () => pending.promise,
      compare: async () => {
        comparisons++;
        return ok(comparison());
      },
    },
  });
  try {
    await app.chooseCommit();
    expect(app.captureCharFrame()).toContain("Loading commit details");
    await app.openChanges();
    expect(app.get("git-details-card").visible).toBe(false);

    app.mockInput.pressEscape();
    await app.renderOnce();
    pending.resolve(
      ok({
        commit,
        message: "Late detail",
        branches: [],
        files: [{ kind: "commit", status: "M", path: "late.ts", commit }],
      }),
    );
    await app.renderOnce();
    await app.renderOnce();

    expect(app.get("git-changes").visible).toBe(false);
    expect(comparisons).toBe(0);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("git-history");
    expect(app.requests).toEqual([]);
  } finally {
    pending.resolve(ok({ commit, message: "cleanup", files: [], branches: [] }));
    await app.close();
  }
});

test("Rapid file switching prevents old comparisons from overwriting new diffs", async () => {
  // Only current comparisons display even if first-file sources ignore cancellation.
  const pending = Promise.withResolvers<Result<GitComparison, ExpectedError>>();
  let previousSignal: AbortSignal | undefined;
  const app = await mount({
    source: {
      load: async () => ok(snapshot()),
      details: async (selected) =>
        ok({
          commit: selected,
          message: selected.subject,
          branches: [],
          files: [
            { kind: "commit", status: "M", path: "slow.txt", commit: selected },
            { kind: "commit", status: "M", path: "fresh.txt", commit: selected },
          ],
        }),
      compare: async (file, signal) => {
        if (file.path === "slow.txt") {
          previousSignal = signal;
          return pending.promise;
        }
        return ok({
          before: "Fresh comparison\n",
          after: "Fresh comparison updated\n",
          beforeLabel: file.path,
          afterLabel: file.path,
        });
      },
    },
  });
  try {
    await app.chooseCommit();
    await app.openChanges();

    app.mockInput.pressKey("n", { ctrl: true });
    await app.waitForFrame((frame) => frame.includes("Fresh comparison"));
    pending.resolve(
      ok({
        before: "Stale comparison\n",
        after: "Stale comparison updated\n",
        beforeLabel: "slow.txt",
        afterLabel: "slow.txt",
      }),
    );
    await app.renderOnce();
    await app.renderOnce();

    expect(previousSignal?.aborted).toBe(true);
    expect(app.captureCharFrame()).not.toContain("Stale comparison");
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.file).toBe("commit:fresh.txt");
    expect(app.requests).toEqual([]);
  } finally {
    pending.resolve(ok(comparison()));
    await app.close();
  }
});

test("Comparison failures stay inside popups and support refresh retries", async () => {
  // Expected failures neither close popups nor masquerade as empty files.
  let comparisons = 0;
  const app = await mount({
    source: {
      load: async () => ok(snapshot()),
      details: async (selected) =>
        ok({ commit: selected, message: selected.subject, files: [], branches: [] }),
      compare: async () =>
        ++comparisons === 1 ? err(new InputError("Comparison unavailable")) : ok(comparison()),
    },
  });
  try {
    await app.openWorkingTree();
    await app.waitForFrame((frame) => frame.includes("Comparison unavailable"));
    expect(app.get("git-changes").visible).toBe(true);

    app.mockInput.pressKey("r");
    await app.waitForFrame((frame) => frame.includes("const line00"));

    expect(comparisons).toBe(2);
    expect(app.get("git-changes").visible).toBe(true);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("git-files");
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Search above Changes owns typing, clearing, and Tab while preserving commit popups", async () => {
  // Global search overlays Git popups and must bypass their focus traps.
  const app = await mount();
  try {
    await app.chooseCommit();
    await app.openChanges();

    openWorkspaceSearch(app);
    await app.renderOnce();
    await app.mockInput.typeText("radian-ui");
    await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-search");
    app.mockInput.pressCtrlC();
    await app.renderOnce();
    app.mockInput.pressCtrlC();
    await app.renderOnce();
    app.mockInput.pressTab();
    await app.renderOnce();

    expect(app.renderer.isDestroyed).toBe(false);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-tree");
    expect(app.get("git-changes").visible).toBe(true);
    expect(app.view.promptDrafts.a1).toBe("existing Agent draft");
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("After Changes closes, commit text drags copy lists rather than hidden diffs", async () => {
  // Old hidden-code coordinates must not intercept main-list selections.
  const app = await mount();
  try {
    await app.openWorkingTree();
    await app.waitForFrame((frame) => frame.includes("const line00"));
    app.mockInput.pressEscape();
    await app.renderOnce();
    const { x, y } = app.positionIn("git-history", `HEAD → ${icons.branch} main`);

    await app.mockMouse.drag(x, y, x + 3, y);
    await app.waitFor(() => app.copies.length > 0);

    expect(app.copies).toEqual(["HEAD"]);
    expect(app.get("git-changes").visible).toBe(false);
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each([
  { width: 160, light: false },
  { width: 60, light: false },
  { width: 160, light: true },
  { width: 60, light: true },
])(
  "Shared Agent/Git prompts use identical appearance, padding, auto-height, and clearing: %j",
  async ({ width, light }) => {
    // Render identical source in each view to detect parent style overrides.
    const app = await mount();
    const render = async () => {
      await app.renderOnce();
      await app.renderOnce();
    };
    const appearance = (input: PromptInput) => ({
      rows: input.height,
      height: input.field.height,
      top: input.y - input.field.y,
      left: input.x - input.field.x,
      right: input.field.x + input.field.width - input.x - input.width,
      background: input.field.backgroundColor.toInts(),
      editorBackground: input.backgroundColor.toInts(),
      border: input.field.border,
      borderColor: input.field.borderColor.toInts(),
    });
    try {
      app.resize(width, 32);
      uiTheme(app.renderer).configure({
        palette: [],
        defaultForeground: light ? "#202020" : "#ECECEC",
        defaultBackground: light ? "#FAFAF6" : "#141414",
        cursorColor: null,
        mouseForeground: null,
        mouseBackground: null,
        tekForeground: null,
        tekBackground: null,
        highlightForeground: null,
        highlightBackground: null,
      });
      app.mockInput.pressKey(" ", { ctrl: true });
      app.mockInput.pressKey("a");
      await render();
      const live = app.get("session-prompt");
      if (!(live instanceof PromptInput)) throw new Error("Missing Agent prompt");
      live.value = "first\nsecond";
      live.focus();
      await render();
      const expected = appearance(live);

      // Git reuses the same field rather than building a separate editor.
      await app.showGit();
      await app.chooseCommit();
      app.mockInput.pressKey("a");
      await render();
      const input = app.get("git-prompt");
      if (!(input instanceof PromptInput)) throw new Error("Missing Git prompt");
      input.value = "first\nsecond";
      await render();
      expect(appearance(input)).toEqual(expected);
      expect(input.height).toBe(2);
      expect(input.field.height).toBe(4);
      expect(input.activity.root.parent).toBe(input.field);
      input.cursorOffset = 3;
      app.get("git-history").focus();
      await app.mockMouse.click(input.field.x + 2, input.field.y);
      await render();
      expect(app.renderer.currentFocusedRenderable).toBe(input);
      expect(input.cursorOffset).toBe(3);
      app.mockInput.pressCtrlC();
      await render();
      app.mockInput.pressCtrlC();
      await render();

      // Ctrl+C clears current input only, never requests, closure, or other Agent drafts.
      expect(input.value).toBe("");
      expect(input.field.height).toBe(3);
      expect(app.get("git-ask").visible).toBe(true);
      expect(app.renderer.currentFocusedRenderable).toBe(input);
      expect(app.view.promptDrafts.a1).toBe("first\nsecond");
      expect(app.requests).toEqual([]);
      expect(app.creations).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Git paste loading uses shared Prompt right padding and cleans immediately on close", async () => {
  // Control only OS clipboards while using real fields, routing, and shared spinners.
  const clock = new ManualClock();
  let pending = Promise.withResolvers<Result<ClipboardRepresentation, ExpectedError>>(),
    signal: AbortSignal | undefined;
  const read = spyOn(Clipboard.prototype, "read").mockImplementation((current) => {
    signal = current;
    return pending.promise;
  });
  const app = await mount({ clock });
  const render = async () => {
    await app.renderOnce();
    await app.renderOnce();
  };
  try {
    await app.chooseCommit();
    app.mockInput.pressKey("a");
    await render();
    const input = app.get("git-prompt");
    if (!(input instanceof PromptInput)) throw new Error("Missing Git prompt");
    input.value = "draft";
    await render();
    const geometry = () => [
      input.field.y,
      input.field.height,
      input.width,
      app.get("git-ask").height,
    ];
    const before = geometry();

    // Reads and minimum durations never change input width or dialog height.
    app.mockInput.pressKey("v", { ctrl: true });
    await render();
    expect(input.pending).toBe(true);
    expect(input.activity.root.visible).toBe(true);
    expect(geometry()).toEqual(before);
    expect(input.activity.root.parent).toBe(input.field);
    expect(input.activity.root.x).toBeGreaterThanOrEqual(input.x + input.width);
    pending.resolve(ok({ mimeType: "text/plain", bytes: new TextEncoder().encode(" pasted") }));
    await render();
    expect(input.value).toBe("draft pasted");
    expect(input.pending).toBe(false);
    expect(geometry()).toEqual(before);
    expect(input.activity.root.visible).toBe(true);
    clock.advance(500);
    await render();
    expect(input.activity.root.visible).toBe(false);
    pending = Promise.withResolvers<Result<ClipboardRepresentation, ExpectedError>>();
    app.mockInput.pressKey("v", { ctrl: true });
    await render();
    app.mockInput.pressEscape();
    await render();
    pending.resolve(ok({ mimeType: "text/plain", bytes: new TextEncoder().encode(" too late") }));
    await render();

    // Discard hidden-dialog results while preserving existing input and Agent drafts.
    expect(signal?.aborted).toBe(true);
    expect(input.activity.root.visible).toBe(false);
    expect(input.value).toBe("draft pasted");
    expect(app.get("git-ask").visible).toBe(false);
    expect(app.view.promptDrafts.a1).toBe("existing Agent draft");
    expect(app.requests).toEqual([]);
  } finally {
    pending.resolve(ok({ mimeType: "text/plain", bytes: new Uint8Array() }));
    read.mockRestore();
    await app.close();
  }
});

test("Git commit Ctrl+D/U jumps selection by half-pages without querying skipped commits", async () => {
  // Jump candidates using actual row heights including graph connectors.
  const commits = Array.from({ length: 40 }, (_, index) => ({
    ...commit,
    oid: (index + 1).toString(16).padStart(40, "0"),
    subject: `Candidate ${index}`,
    parents: [],
  }));
  const data = { ...snapshot(), headOid: commits[0]!.oid, commits },
    lookups: string[] = [];
  const app = await mount({
    source: {
      load: async () => ok(data),
      compare: async () => ok(comparison()),
      details: async (selected) => {
        lookups.push(selected.oid);
        return ok({ commit: selected, message: selected.subject, files: [], branches: [] });
      },
    },
  });
  try {
    const list = app.get("git-history") as ScrollBoxRenderable;
    const step = Math.max(
      1,
      Math.floor(list.viewport.height / (2 * app.get("git-history:__working_tree__").height)),
    );
    list.focus();

    app.mockInput.pressKey("d", { ctrl: true });
    await app.renderOnce();
    await app.renderOnce();

    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBe(
      commits[step - 1]!.oid,
    );
    expect(lookups).toEqual([commits[step - 1]!.oid]);
    app.mockInput.pressKey("u", { ctrl: true });
    await app.renderOnce();
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBeNull();
    expect(lookups).toHaveLength(1);
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Git details and both diffs scroll focused bodies by half-pages", async () => {
  // Detail bodies scroll without changing candidate selection.
  const app = await mount({
    source: {
      load: async () => ok(snapshot()),
      compare: async () => ok(comparison()),
      details: async (selected) =>
        ok({
          commit: selected,
          message: Array.from({ length: 80 }, (_, index) => `Detail ${index}`).join("\n"),
          branches: [],
          files: [{ kind: "commit", status: "M", path: "src/login.ts", commit: selected }],
        }),
    },
  });
  try {
    await app.chooseCommit();
    const details = app.get("git-details"),
      history = app.get("git-history") as ScrollBoxRenderable;
    details.focus();
    history.scrollTo(0);
    await app.renderOnce();
    const half = Math.floor(history.viewport.height / 2);

    app.mockInput.pressKey("d", { ctrl: true });
    await app.renderOnce();
    expect(history.scrollTop).toBe(half);
    app.mockInput.pressKey("u", { ctrl: true });
    await app.renderOnce();
    expect(history.scrollTop).toBe(0);
    await app.openChanges();
    app.get("git-files").focus();
    app.mockInput.pressEnter();
    await app.waitFor(() => app.codes().length === 2);
    await app.renderOnce();
    app.get("git-diff").focus();
    const panes = app.codes(),
      distance = Math.floor(panes[0]!.height / 2);
    for (const pane of panes) pane.scrollY = 0;
    app.mockInput.pressKey("d", { ctrl: true });
    await app.renderOnce();

    expect(panes.map((pane) => pane.scrollY)).toEqual([distance, distance]);
    app.mockInput.pressKey("u", { ctrl: true });
    await app.renderOnce();
    expect(panes.map((pane) => pane.scrollY)).toEqual([0, 0]);
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBe(commit.oid);
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each(["arrows", "vim", "control"] as const)(
  "Refs supports %s navigation, preserves query/caret, and applies filters only with Enter",
  async (navigation) => {
    // Search and results share candidate cursors.
    const app = await mount();
    const move = (next: boolean) =>
      navigation === "arrows"
        ? app.mockInput.pressArrow(next ? "down" : "up")
        : navigation === "control"
          ? app.mockInput.pressKey(next ? "n" : "p", { ctrl: true })
          : app.mockInput.pressKey(next ? "j" : "k");
    try {
      await app.openRefs();
      await app.mockInput.typeText("main");
      await app.renderOnce();
      const input = app.get("git-browser-search");
      if (!(input instanceof SearchInput)) throw new Error("Missing Git search");
      input.cursorOffset = 2;

      app.mockInput.pressKey("n", { ctrl: true });
      await app.renderOnce();
      expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.refSelected).toBe(
        "refs/remotes/origin/main",
      );
      app.mockInput.pressKey("p", { ctrl: true });
      app.mockInput.pressTab();
      await app.renderOnce();
      move(true);
      await app.renderOnce();
      move(false);
      await app.renderOnce();

      expect(input.value).toBe("main");
      expect(input.cursorOffset).toBe(2);
      expect(app.renderer.currentFocusedRenderable?.id).toBe("git-browser-list");
      expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.reference).toBeNull();
      expect(app.loads).toEqual(["all"]);
      app.mockInput.pressEnter();
      await app.waitFor(() => app.loads.includes("refs/heads/main"));
      await app.renderOnce();
      expect(app.get("git-browser").visible).toBe(false);
      expect(app.captureCharFrame()).toContain("Ref: main");
      expect(app.requests).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Reflog search matches events, hashes, and times while unmatched Enter opens nothing", async () => {
  // Search browses original events without changing main commit selection.
  const data = snapshot();
  data.reflog = [
    {
      oid: commit.oid,
      selector: "HEAD@{0}",
      date: "2026-10-21 14:32:00 +0900",
      subject: "reset: moving to HEAD~2",
    },
    {
      oid: rootCommit.oid,
      selector: "HEAD@{1}",
      date: "2026-10-20 10:00:00 +0900",
      subject: "checkout: moving from main to feature/topic",
    },
  ];
  const app = await mount({
    source: {
      load: async () => ok(data),
      compare: async () => ok(comparison()),
      details: async (selected) =>
        ok({ commit: selected, message: selected.subject, files: [], branches: [] }),
    },
  });
  try {
    await app.openReflog();
    const input = app.get("git-browser-search");
    if (!(input instanceof SearchInput)) throw new Error("Missing Git search");

    for (const query of ["checkout main", rootCommit.oid.slice(0, 12), "2026-10-20", "HEAD@{1}"]) {
      input.value = query;
      await app.renderOnce();
      expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.reflogSelected).toBe("HEAD@{1}");
    }
    input.value = "no such event";
    await app.renderOnce();
    app.mockInput.pressEnter();
    await app.renderOnce();

    expect(app.captureCharFrame()).toContain("No matches");
    expect(app.get("git-browser").visible).toBe(true);
    expect(app.get("git-changes").visible).toBe(false);
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBeNull();
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Refs uses Esc without close icons to discard search and return to main commits", async () => {
  // Commands own non-destructive popup closure instead of separate icons.
  const app = await mount();
  try {
    await app.chooseCommit();
    await app.openRefs();
    await app.mockInput.typeText("origin");
    await app.renderOnce();

    const panel = app.get("git-browser-panel");
    expect(app.captureCharFrame().split("\n")[panel.y + 1]).not.toContain("×");
    expect(app.renderer.root.findDescendantById("git-browser-close")).toBeUndefined();
    app.mockInput.pressEscape();
    await app.renderOnce();

    expect(app.get("git-browser").visible).toBe(false);
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.reference).toBeNull();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("git-history");
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Git Agent requests preserve multiline/collapsed source and image references with shared input rules", async () => {
  const sent: { text: string; images: readonly string[] }[] = [];
  const app = await mount({
    actions: {
      prompt: (_id, text, images) => {
        sent.push({ text, images: images ?? [] });
        return ok(undefined);
      },
    },
  });
  try {
    await app.chooseCommit();
    app.mockInput.pressKey("a");
    await app.renderOnce();
    const input = app.get("git-prompt");
    if (!(input instanceof PromptInput)) throw new Error("Missing Git prompt");
    const original = "Long Git request\n".repeat(100);
    await app.mockInput.pasteBracketedText(original);
    app.mockInput.pressEnter({ shift: true });
    await app.mockInput.pasteBracketedText("/tmp/image.png /tmp/context.txt");
    await app.renderOnce();
    expect(input.value).toContain("[Pasted Content");
    expect(input.value).toContain("[Image #1]");
    expect(sent).toEqual([]);
    app.mockInput.pressEnter();
    await app.waitFor(() => sent.length > 0);

    expect(sent[0]!.text).toContain(original);
    expect(sent[0]!.text).toContain('@"/tmp/context.txt"');
    expect(sent[0]!.text).toContain(commit.oid);
    expect(sent[0]!.images).toEqual(["/tmp/image.png"]);
    expect(app.view.promptDrafts.a1).toBe("existing Agent draft");
  } finally {
    await app.close();
  }
});

test.each([false, true])(
  "At brightness %j, candidates stay highlighted and button-free Ask focuses input",
  async (light) => {
    // Candidate backgrounds remain explicit while search retains input focus.
    const app = await mount();
    const controls = (node: Renderable): Button[] => [
      ...(node instanceof Button ? [node] : []),
      ...node.getChildren().flatMap(controls),
    ];
    try {
      uiTheme(app.renderer).configure({
        palette: [],
        defaultForeground: light ? "#202020" : "#ECECEC",
        defaultBackground: light ? "#FAFAF6" : "#141414",
        cursorColor: null,
        mouseForeground: null,
        mouseBackground: null,
        tekForeground: null,
        tekBackground: null,
        highlightForeground: null,
        highlightBackground: null,
      });
      await app.openRefs();
      await app.mockInput.typeText("main");
      await app.renderOnce();

      expect(app.renderer.currentFocusedRenderable?.id).toBe("git-browser-search");
      expect(app.spanIn("git-browser-list", `${icons.branch} main`).bg.toInts()).not.toEqual(
        uiTheme(app.renderer).colors.panel.toInts(),
      );
      expect(
        app.spanIn("git-browser-list", `${icons.branch} main`).attributes &
          TextAttributes.UNDERLINE,
      ).toBe(0);
      app.mockInput.pressEscape();
      await app.renderOnce();
      await app.chooseCommit();
      app.mockInput.pressKey("a");
      await app.renderOnce();
      expect(controls(app.get("git-ask"))).toEqual([]);
      app.mockInput.pressTab();
      await app.renderOnce();
      expect(app.renderer.currentFocusedRenderable?.id).toBe("git-prompt");
      app.mockInput.pressEscape();
      await app.renderOnce();
      expect(app.get("git-ask").visible).toBe(false);
      expect(app.requests).toEqual([]);
      expect(app.creations).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test.each(["view", "worktree"] as const)(
  "Returning to a cached Git %s reloads files and the selected comparison without losing reading position",
  async (target) => {
    // A status-identical edit still needs a fresh comparison when the cached screen returns.
    let data = snapshot(),
      revision = "before return",
      reads = 0,
      comparisons = 0;
    const app = await mount({
      source: {
        load: async () => {
          reads++;
          return ok(structuredClone(data));
        },
        details: async (selected) =>
          ok({ commit: selected, message: selected.subject, files: [], branches: [] }),
        compare: async () => {
          comparisons++;
          const diff = comparison();
          return ok({
            ...diff,
            after: diff.after.replace("line69 = 69", `line69 = '${revision}'`),
          });
        },
      },
    });
    try {
      await app.openWorkingTree();
      await app.waitForFrame((frame) => frame.includes("const line00"));
      app.get("git-diff").focus();
      app.mockInput.pressKey("END");
      await app.renderOnce();
      const scroll = app.codes()[0]!.scrollY;
      expect(scroll).toBeGreaterThan(0);
      if (target === "view") {
        app.mockInput.pressKey(" ", { ctrl: true });
        app.mockInput.pressKey("a");
        await app.renderOnce();
      } else await app.click(`${icons.folder} radian-ui`);
      data = {
        ...snapshot(),
        files: [...snapshot().files, { kind: "untracked", status: "?", path: "fresh.txt" }],
      };
      revision = "after return";

      // Returning must revalidate the snapshot as well as an already cached file diff.
      if (target === "view") await app.showGit();
      else await app.click(`${icons.folder} radian`);
      await app.waitForFrame((frame) => frame.includes("after return"));

      // View identities and synchronized scroll survive while external edits become visible.
      expect(reads).toBe(2);
      expect(comparisons).toBe(2);
      expect(app.captureCharFrame()).toContain("Changed files (3)");
      expect(app.captureCharFrame()).toContain("fresh.txt");
      expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.file).toBe(
        "unstaged:src/login.ts",
      );
      expect(app.codes().map((pane) => pane.scrollY)).toEqual([scroll, scroll]);
      expect(app.requests).toEqual([]);
      expect(app.view.promptDrafts.a1).toBe("existing Agent draft");
    } finally {
      await app.close();
    }
  },
);

test.each(["terminal", "workspace"] as const)(
  "Git %s focus return refreshes status-identical edits and preserves diff focus",
  async (target) => {
    // Porcelain status alone cannot reveal another edit to the same modified file.
    let revision = "original focus",
      reads = 0,
      comparisons = 0;
    const app = await mount({
      source: {
        load: async () => {
          reads++;
          return ok(snapshot());
        },
        details: async (selected) =>
          ok({ commit: selected, message: selected.subject, files: [], branches: [] }),
        compare: async () => {
          comparisons++;
          const diff = comparison();
          return ok({
            ...diff,
            after: diff.after.replace("line69 = 69", `line69 = '${revision}'`),
          });
        },
      },
    });
    try {
      await app.openWorkingTree();
      await app.waitForFrame((frame) => frame.includes("const line00"));
      app.get("git-diff").focus();
      app.mockInput.pressKey("END");
      await app.renderOnce();
      const scroll = app.codes()[0]!.scrollY;
      if (target === "terminal") app.renderer.emit("blur");
      else {
        openWorkspaceSearch(app);
        await app.renderOnce();
      }
      revision = "updated focus";

      // Native terminal focus and app-owned overlay focus are distinct return paths.
      if (target === "terminal") app.renderer.emit("focus");
      else app.mockInput.pressEscape();
      await app.waitForFrame((frame) => frame.includes("updated focus"));

      // Refresh must not move focus or reset either column to the top.
      expect(reads).toBe(2);
      expect(comparisons).toBe(2);
      expect(app.renderer.currentFocusedRenderable?.id).toBe("git-diff");
      expect(app.codes().map((pane) => pane.scrollY)).toEqual([scroll, scroll]);
      expect(app.requests).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test.each(["arrows", "vim", "control"] as const)(
  "Git %s navigation reads only newly selected previews, not the repository snapshot",
  async (navigation) => {
    // Navigation owns preview selection; it must not act as an implicit full refresh.
    let reads = 0,
      details = 0,
      comparisons = 0;
    const app = await mount({
      source: {
        load: async () => {
          reads++;
          return ok(snapshot());
        },
        details: async (selected) => {
          details++;
          return ok({ commit: selected, message: selected.subject, files: [], branches: [] });
        },
        compare: async () => {
          comparisons++;
          return ok(comparison());
        },
      },
    });
    const move = (down: boolean) =>
      navigation === "arrows"
        ? app.mockInput.pressArrow(down ? "down" : "up")
        : navigation === "control"
          ? app.mockInput.pressKey(down ? "n" : "p", { ctrl: true })
          : app.mockInput.pressKey(down ? "j" : "k");
    try {
      app.get("git-history").focus();
      move(false);
      await app.renderOnce();
      move(true);
      await app.waitForFrame((frame) => frame.includes("Author: Ada"));
      move(false);
      await app.renderOnce();
      await app.openChanges();
      await app.waitForFrame((frame) => frame.includes("const line00"));

      // Staying on the first file or scrolling diff bodies does not reread any Git data.
      move(false);
      await app.renderOnce();
      app.get("git-diff").focus();
      move(true);
      await app.renderOnce();
      expect(reads).toBe(1);
      expect(details).toBe(1);
      expect(comparisons).toBe(1);
      app.get("git-files").focus();
      move(true);
      await app.renderOnce();
      await app.renderOnce();

      // Selecting another file reads that comparison only and keeps list focus.
      expect(reads).toBe(1);
      expect(details).toBe(1);
      expect(comparisons).toBe(2);
      expect(app.renderer.currentFocusedRenderable?.id).toBe("git-files");

      // A clamped move on Working tree must not discard its remembered file or cached diff.
      app.mockInput.pressEscape();
      await app.renderOnce();
      move(false);
      await app.renderOnce();
      app.mockInput.pressEnter();
      await app.renderOnce();
      await app.renderOnce();
      expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.file).toBe(
        "untracked:notes.txt",
      );
      expect(reads).toBe(1);
      expect(comparisons).toBe(2);
      expect(app.requests).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Overlapping focus returns share one reload and hidden Git views ignore terminal focus", async () => {
  // A delayed focus reload must not be restarted by the accompanying focus handoff.
  const pending = Promise.withResolvers<Result<GitSnapshot, ExpectedError>>();
  let reads = 0,
    signal: AbortSignal | undefined;
  const app = await mount({
    source: {
      load: async (_ref, _limit, current) => {
        reads++;
        if (reads === 2) {
          signal = current;
          return pending.promise;
        }
        return ok(snapshot());
      },
      details: async (selected) =>
        ok({ commit: selected, message: selected.subject, files: [], branches: [] }),
      compare: async () => ok(comparison()),
    },
  });
  try {
    // Multiple return signals during the same query must not create competing reloads.
    openWorkspaceSearch(app);
    await app.renderOnce();
    app.renderer.emit("focus");
    app.mockInput.pressEscape();
    await app.renderOnce();
    app.renderer.emit("focus");
    await app.renderOnce();
    expect(reads).toBe(2);
    expect(signal?.aborted).toBe(false);
    app.mockInput.pressKey(" ", { ctrl: true });
    app.mockInput.pressKey("a");
    await app.renderOnce();
    app.renderer.emit("focus");
    const stale = snapshot();
    stale.commits[0] = { ...commit, subject: "Hidden stale snapshot" };
    pending.resolve(ok(stale));
    await app.renderOnce();

    // Hiding cancels outstanding refreshes; a later return starts a new current read.
    expect(signal?.aborted).toBe(true);
    expect(reads).toBe(2);
    await app.showGit();
    await app.waitForFrame((frame) => frame.includes("Update login"));
    expect(reads).toBe(3);
    expect(app.captureCharFrame()).not.toContain("Hidden stale snapshot");
    expect(app.requests).toEqual([]);
  } finally {
    pending.resolve(ok(snapshot()));
    await app.close();
  }
});

test.each(["before", "during"] as const)(
  "Focus refresh invalidates comparisons started %s the snapshot reload",
  async (timing) => {
    // Even sources ignoring AbortSignal must not restore stale text for the same selected file.
    const pendingLoad = Promise.withResolvers<Result<GitSnapshot, ExpectedError>>();
    const pendingDiff = Promise.withResolvers<Result<GitComparison, ExpectedError>>();
    let reads = 0,
      comparisons = 0,
      signal: AbortSignal | undefined;
    const app = await mount({
      source: {
        load: async () => (++reads === 2 ? pendingLoad.promise : ok(snapshot())),
        details: async (selected) =>
          ok({ commit: selected, message: selected.subject, files: [], branches: [] }),
        compare: async (_file, current) => {
          comparisons++;
          if (comparisons === (timing === "before" ? 1 : 2)) {
            signal = current;
            return pendingDiff.promise;
          }
          return ok({
            before: "Latest comparison\n",
            after: "Latest comparison updated\n",
            beforeLabel: "before",
            afterLabel: "after",
          });
        },
      },
    });
    try {
      await app.openWorkingTree();

      // Changing selection while the snapshot is pending can start another old-snapshot preview.
      app.renderer.emit("focus");
      if (timing === "during") {
        app.mockInput.pressArrow("down");
        await app.renderOnce();
      }
      pendingLoad.resolve(ok(snapshot()));
      await app.waitForFrame((frame) => frame.includes("Latest comparison"));
      pendingDiff.resolve(
        ok({
          before: "Stale comparison\n",
          after: "Stale comparison updated\n",
          beforeLabel: "old",
          afterLabel: "old",
        }),
      );
      await app.renderOnce();
      await app.renderOnce();

      // Only the post-refresh preview is allowed to update the current comparison.
      expect(signal?.aborted).toBe(true);
      expect(reads).toBe(2);
      expect(comparisons).toBe(timing === "before" ? 2 : 3);
      expect(app.captureCharFrame()).toContain("Latest comparison");
      expect(app.captureCharFrame()).not.toContain("Stale comparison");
      expect(app.requests).toEqual([]);
    } finally {
      pendingLoad.resolve(ok(snapshot()));
      pendingDiff.resolve(ok(comparison()));
      await app.close();
    }
  },
);

test("Slow commit previews do not block later focus refreshes after snapshots finish", async () => {
  // A completed snapshot is not an in-flight reload merely because its details are still pending.
  const pending = Promise.withResolvers<Result<GitDetails, ExpectedError>>();
  let reads = 0,
    details = 0,
    signal: AbortSignal | undefined;
  const app = await mount({
    source: {
      load: async () => {
        reads++;
        return ok(snapshot());
      },
      details: async (selected, current) => {
        if (++details < 3) {
          signal = current;
          return pending.promise;
        }
        return ok({
          commit: selected,
          message: "Current commit after focus",
          files: [],
          branches: [],
        });
      },
      compare: async () => ok(comparison()),
    },
  });
  try {
    await app.chooseCommit();
    app.renderer.emit("focus");
    await app.waitFor(() => details === 2);

    // Another actual return must revalidate the repository and replace the delayed preview.
    app.renderer.emit("blur");
    app.renderer.emit("focus");
    await app.waitForFrame((frame) => frame.includes("Current commit after focus"));
    pending.resolve(ok({ commit, message: "Stale commit preview", files: [], branches: [] }));
    await app.renderOnce();

    expect(reads).toBe(3);
    expect(signal?.aborted).toBe(true);
    expect(app.captureCharFrame()).not.toContain("Stale commit preview");
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBe(commit.oid);
  } finally {
    pending.resolve(ok({ commit, message: "cleanup", files: [], branches: [] }));
    await app.close();
  }
});

test("Terminal focus refresh preserves Ask input, caret, target and frozen Git context", async () => {
  // An accepted file selection may disappear externally while its unsubmitted question remains editable.
  let data = snapshot(),
    reads = 0;
  const app = await mount({
    source: {
      load: async () => {
        reads++;
        return ok(structuredClone(data));
      },
      details: async (selected) =>
        ok({ commit: selected, message: selected.subject, files: [], branches: [] }),
      compare: async () => ok(comparison()),
    },
  });
  try {
    await app.openWorkingTree();
    app.mockInput.pressKey("a");
    await app.renderOnce();
    await app.mockInput.typeText("explain this file");
    app.mockInput.pressArrow("left");
    const input = app.get("git-prompt");
    if (!(input instanceof PromptInput)) throw new Error("Missing Ask input");
    const caret = input.cursorOffset;
    data = { ...snapshot(), files: [{ kind: "untracked", status: "?", path: "replacement.txt" }] };

    // Native focus refresh must not reinitialize an app-owned prompt or silently replace its attachment.
    app.renderer.emit("blur");
    app.renderer.emit("focus");
    await app.waitForFrame((frame) => frame.includes("replacement.txt"));

    expect(reads).toBe(2);
    expect(input.value).toBe("explain this file");
    expect(input.cursorOffset).toBe(caret);
    expect(app.renderer.currentFocusedRenderable).toBe(input);
    expect(app.captureCharFrame()).toContain("File src/login.ts");
    expect(app.requests).toEqual([]);
    expect(app.creations).toEqual([]);
    expect(app.view.promptDrafts.a1).toBe("existing Agent draft");
  } finally {
    await app.close();
  }
});

test("r refreshes without headers/buttons and spinners show at least 500ms without shifting layout", async () => {
  // Keep refresh pending at the query boundary and drive animation with the renderer clock.
  const clock = new ManualClock();
  let reads = 0;
  const pending = Promise.withResolvers<Result<GitSnapshot, ExpectedError>>();
  const app = await mount({
    clock,
    source: {
      load: async () => (++reads === 1 ? ok(snapshot()) : pending.promise),
      details: async (commit) => ok({ commit, message: commit.subject, files: [], branches: [] }),
      compare: async () => ok(comparison()),
    },
  });
  try {
    clock.advance(500);
    await app.renderOnce();
    const toolbar = app.get("git-toolbar"),
      spinner = app.get("git-loading"),
      list = app.get("git-history");
    const glyph = () =>
      app
        .captureCharFrame()
        .split("\n")
        [spinner.y]!.slice(spinner.x, spinner.x + 1);
    expect(toolbar.visible).toBe(false);
    expect(spinner.visible).toBe(false);
    const position = [spinner.x, spinner.y, list.height, list.y];

    // The scoped key still performs a real source reload, not just a visual animation.
    app.get("git-history").focus();
    app.mockInput.pressKey("r");
    await app.renderOnce();
    expect(reads).toBe(2);
    expect(spinner.visible).toBe(true);
    expect(spinner.y).toBe(list.y);
    expect(glyph()).toBe("⠋");
    expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).toContain("r Refresh");
    clock.advance(80);
    await app.renderOnce();
    expect(glyph()).toBe("⠙");
    pending.resolve(ok(snapshot()));
    await app.renderOnce();
    await app.renderOnce();
    clock.advance(419);
    await app.renderOnce();
    expect(spinner.visible).toBe(true);
    clock.advance(1);
    await app.renderOnce();
    expect(spinner.visible).toBe(false);
    expect([spinner.x, spinner.y, list.height, list.y]).toEqual(position);
    expect(app.requests).toEqual([]);
  } finally {
    pending.resolve(ok(snapshot()));
    await app.close();
  }
});

test("+ loads commits in batches of 300 without More buttons and stops querying when exhausted", async () => {
  // Keep pagination available without adding an action beside the history tabs.
  const limits: number[] = [];
  const app = await mount({
    source: {
      load: async (_reference, limit) => {
        limits.push(limit);
        const data = snapshot();
        data.commits =
          limits.length === 1
            ? Array.from({ length: 300 }, (_, index) => ({
                ...commit,
                oid: (index + 1).toString(16).padStart(40, "0"),
                subject: `Commit ${index}`,
              }))
            : [commit];
        return ok(data);
      },
      details: async (commit) => ok({ commit, message: commit.subject, files: [], branches: [] }),
      compare: async () => ok(comparison()),
    },
  });
  try {
    expect(app.captureCharFrame()).not.toContain("+ More");
    app.get("git-history").focus();
    app.mockInput.pressKey("+");
    await app.waitFor(() => limits.length === 2);
    await app.renderOnce();
    expect(limits).toEqual([300, 600]);
    expect(app.captureCharFrame()).not.toContain("+ More");
    app.mockInput.pressKey("+");
    await app.renderOnce();
    expect(limits).toEqual([300, 600]);
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Git lists use full width and compact Changes popups fit inside footers", async () => {
  // Actual list layouts leave no permanent right-hand pane.
  const app = await mount();
  try {
    for (const [width, height] of [
      [160, 32],
      [60, 12],
      [79, 18],
      [80, 17],
      [160, 32],
    ] as const) {
      app.resize(width, height);
      await app.renderOnce();
      await app.renderOnce();
      const panel = app.get("git-view"),
        list = app.get("git-history");
      expect(list.y + list.height).toBe(app.get("work-panel").y + app.get("work-panel").height);
      expect(list.y).toBe(panel.y);
      expect(list.width).toBe(panel.width - (width < 80 ? 2 : 4));
      expect(app.get("git-changes").visible).toBe(false);
      expect(app.captureCharFrame()).not.toContain("Changed files");
    }

    // Enter-opened popups retain real file-list and both diff viewports.
    await app.openWorkingTree();
    await app.waitForFrame((frame) => frame.includes("const line00"));
    for (const [width, height] of [
      [160, 32],
      [60, 12],
      [79, 18],
      [80, 17],
      [160, 32],
    ] as const) {
      app.resize(width, height);
      await app.renderOnce();
      await app.renderOnce();
      const popup = app.get("git-changes"),
        diff = app.get("git-diff");
      expect(popup.y + popup.height).toBe(app.get("work-panel").y + app.get("work-panel").height);
      expect(diff.y + diff.height).toBe(popup.y + popup.height - 1);
      expect(app.get("git-files").height).toBeGreaterThan(0);
      expect(app.codes()).toHaveLength(2);
      expect(app.codes().every((pane) => pane.width > 0 && pane.height > 0)).toBe(true);
      expect(app.codes().every((pane) => pane.y + pane.height <= popup.y + popup.height - 1)).toBe(
        true,
      );
      expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).toContain("GIT");
    }
    expect(app.requests).toEqual([]);
    expect(app.creations).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Commit clicks expand left details and Enter shows only files with Before/After", async () => {
  // Mouse commit selection preserves immediate hash-copy and Ask actions.
  const app = await mount();
  try {
    await app.chooseCommit();
    expect(app.get("git-changes").visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("git-history");
    expect(app.get("git-details-card").visible).toBe(true);
    expect(app.captureCharFrame()).toContain("Author: Ada");

    // Load first-file comparisons automatically without reopening files.
    await app.openChanges();
    await app.waitForFrame((frame) => frame.includes("const line00"));

    const files = app.get("git-files"),
      diff = app.get("git-diff");
    expect(app.get("git-details-card").visible).toBe(false);
    expect(app.captureCharFrame()).not.toContain("Author: Ada");
    expect(app.captureCharFrame()).not.toContain("Commit details");
    expect(app.captureCharFrame()).not.toContain("aaaaaaa · Update login");
    expect(app.get("git-changes-body").y).toBe(app.get("git-changes").y + 1);
    expect(app.captureCharFrame()).not.toContain("Changes ·");
    expect(app.captureCharFrame()).toContain("Changed files (2)");
    expect(app.captureCharFrame()).toContain("Before ·");
    expect(app.captureCharFrame()).toContain("After ·");
    expect(files.x).toBeLessThan(diff.x);
    expect(app.codes()).toHaveLength(2);
    expect(app.renderer.currentFocusedRenderable).toBe(files);
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Ask popups begin with the selected Git context instead of a popup title", async () => {
  // Removing chrome must preserve the actual Git target, session choice and prompt ownership.
  const app = await mount();
  try {
    await app.chooseCommit();
    app.mockInput.pressKey("a");
    await app.renderOnce();
    await app.renderOnce();

    // The selected context is the first content row, not a replacement decorative header.
    const popup = app.get("git-ask"),
      context = popup
        .getChildren()
        .find((node) => node instanceof TextRenderable && node.plainText.startsWith("Commit "));
    expect(context).toBeDefined();
    expect(context!.y).toBe(popup.y + 1);
    expect(app.captureCharFrame()).not.toContain("Ask Agent · selected Git context");
    expect(app.captureCharFrame()).toContain("Session:");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("git-prompt");
    expect(app.requests).toEqual([]);
    expect(app.creations).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Changes Tab cycles only files/diffs and Esc returns to commits with left details", async () => {
  // Popup focus must not leak into background tabs or Agent input.
  const app = await mount();
  try {
    await app.chooseCommit();
    await app.openChanges();
    const selected = app.view.workViewPreferences.gitViews?.["demo:main"]?.selected;

    // No detail focus remains in popups; cycle only the two regions.
    for (const id of ["git-diff", "git-files", "git-diff", "git-files"]) {
      app.mockInput.pressTab();
      await app.renderOnce();
      expect(app.renderer.currentFocusedRenderable?.id).toBe(id);
    }
    app.mockInput.pressTab({ shift: true });
    await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("git-diff");
    app.mockInput.pressEscape();
    await app.renderOnce();

    expect(app.get("git-changes").visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("git-history");
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBe(selected);
    expect(app.view.promptDrafts.a1).toBe("existing Agent draft");
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Refs uses groups/search instead of kind tabs and retains compact results", async () => {
  // All refs remain searchable without switching kinds.
  const app = await mount();
  try {
    await app.openRefs();
    expect(app.captureCharFrame()).toContain("All refs");
    await app.mockInput.typeText("origin");
    await app.renderOnce();

    for (const [width, height] of [
      [160, 32],
      [79, 18],
      [80, 18],
      [60, 12],
      [160, 32],
    ] as const) {
      app.resize(width, height);
      await app.renderOnce();
      await app.renderOnce();
      const list = app.get("git-browser-list"),
        group = app.positionIn("git-browser-list", "Remote");
      expect(list.height).toBeGreaterThan(1);
      expect(app.positionIn("git-browser-list", `${icons.branch} origin/main`).x).toBe(group.x);
      expect(app.get("git-reflog-preview-pane").visible).toBe(false);
      expect(app.renderer.currentFocusedRenderable?.id).toBe("git-browser-search");
    }
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Changes file titles and first files have exactly one blank row at every height", async () => {
  // Moving details into lists preserves existing space beneath file titles.
  const app = await mount({
    source: {
      load: async () => ok(snapshot()),
      details: async (selected) =>
        ok({
          commit: selected,
          message: "Commit explanation\n".repeat(40),
          branches: [],
          files: [{ kind: "commit", status: "M", path: "src/only-file.ts", commit: selected }],
        }),
      compare: async () => ok(comparison()),
    },
  });
  try {
    await app.chooseCommit();
    await app.openChanges();
    for (const width of [120, 160, 240])
      for (let height = 20; height <= 70; height++) {
        app.resize(width, height);
        await app.renderOnce();
        await app.renderOnce();
        const title = app.positionIn("git-files-panel", "Changed files"),
          file = app.positionIn("git-files", "M src/only-file.ts");
        expect({ width, height, gap: file.y - title.y - 1 }).toEqual({ width, height, gap: 1 });
        expect(
          app
            .captureCharFrame()
            .split("\n")
            [title.y + 1]!.slice(
              title.x,
              app.get("git-files-panel").x + app.get("git-files-panel").width,
            )
            .trim(),
        ).toBe("");
      }
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each(["search", "list"] as const)(
  "Refs %s Esc preserves commit selection/drafts without applying filters",
  async (focus) => {
    // Candidate browsing differs from filter application; closing retains main selection.
    const app = await mount();
    try {
      await app.chooseCommit();
      await app.openRefs();
      await app.mockInput.typeText("origin");
      if (focus === "list") app.mockInput.pressTab();
      await app.renderOnce();

      app.mockInput.pressEscape();
      await app.renderOnce();

      expect(app.get("git-browser").visible).toBe(false);
      expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.reference).toBeNull();
      expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBe(commit.oid);
      expect(app.renderer.currentFocusedRenderable?.id).toBe("git-history");
      expect(app.view.promptDrafts.a1).toBe("existing Agent draft");
      expect(app.loads).toEqual(["all"]);
      expect(app.requests).toEqual([]);
      expect(app.creations).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test.each(["all", "escape"] as const)(
  "Refs Enter applies filters and closes while %s returns to all commits",
  async (clear) => {
    // Show-all and main Esc clear only query filters without checkout.
    const app = await mount();
    try {
      await app.openRefs();
      await app.mockInput.typeText("origin/main");
      app.mockInput.pressEnter();
      await app.waitFor(() => app.loads.includes("refs/remotes/origin/main"));
      await app.renderOnce();
      expect(app.get("git-browser").visible).toBe(false);
      expect(app.captureCharFrame()).toContain("Ref: origin/main");

      if (clear === "all") {
        await app.openRefs();
        app.mockInput.pressTab();
        app.mockInput.pressKey("HOME");
        app.mockInput.pressEnter();
      } else {
        await app.openRefs();
        app.mockInput.pressEscape();
        await app.renderOnce();
        expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.reference).toBe(
          "refs/remotes/origin/main",
        );
        app.mockInput.pressEscape();
      }
      await app.waitFor(() => app.loads.at(-1) === "all");
      await app.renderOnce();

      expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.reference).toBeNull();
      expect(app.get("git-toolbar").visible).toBe(false);
      expect(app.renderer.currentFocusedRenderable?.id).toBe("git-history");
      expect(app.captureCharFrame()).toContain("Working tree");
      expect(app.view.promptDrafts.a1).toBe("existing Agent draft");
      expect(app.requests).toEqual([]);
      expect(app.creations).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Filtered diff Esc closes only diffs first and clears ref filters on the next press", async () => {
  // Going back one level must not unexpectedly discard the ref being reviewed.
  const app = await mount();
  try {
    await app.openRefs();
    await app.mockInput.typeText("origin/main");
    app.mockInput.pressEnter();
    await app.waitFor(() => app.loads.includes("refs/remotes/origin/main"));
    await app.renderOnce();
    await app.chooseCommit();
    await app.openChanges();
    await app.waitForFrame((frame) => frame.includes("const line00"));
    app.get("git-diff").focus();
    await app.renderOnce();
    expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).not.toContain(
      "<Esc> Close",
    );
    expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).not.toContain(
      "<Esc> Commits",
    );

    app.mockInput.pressEscape();
    await app.renderOnce();
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.reference).toBe(
      "refs/remotes/origin/main",
    );
    expect(app.get("git-history").visible).toBe(true);
    app.mockInput.pressEscape();
    await app.waitFor(() => app.loads.at(-1) === "all");
    await app.renderOnce();

    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.reference).toBeNull();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("git-history");
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Main starts in tabless Commits and opens Refs/Reflog through footer shortcuts", async () => {
  // Opening modals preserves main commit selection and screen identity.
  const app = await mount();
  try {
    expect(app.get("git-toolbar").visible).toBe(false);
    expect(app.get("git-history").y).toBe(app.get("git-view").y);
    const footer = app.captureCharFrame().split("\n")[app.renderer.height - 1]!;
    expect(footer).toContain("b Refs");
    expect(footer).toContain("<C-r> Reflog");

    await app.chooseCommit();
    await app.openReflog();

    expect(app.get("git-browser").visible).toBe(true);
    expect(app.captureCharFrame()).toContain("HEAD@{0}");
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.tab).toBe("commits");
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBe(commit.oid);
    expect(app.get("git-changes").visible).toBe(false);
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Commit refs, graphs, and connectors share colors while messages use theme text colors", async () => {
  // A visible graph and ref label expose accidental whole-row coloring.
  const app = await mount();
  try {
    await app.chooseCommit();
    app.get("git-history").blur();
    await app.renderOnce();
    await app.renderOnce();
    const before = app.captureCharFrame();

    // Repaint the mounted list in both dark and light terminal palettes.
    for (const text of ["#EEEEEE", "#202020"]) {
      uiTheme(app.renderer).configure({
        palette: [],
        defaultForeground: text,
        defaultBackground: text === "#EEEEEE" ? "#121212" : "#FAFAFA",
        cursorColor: null,
        mouseForeground: null,
        mouseBackground: null,
        tekForeground: null,
        tekBackground: null,
        highlightForeground: null,
        highlightBackground: null,
      });
      await app.renderOnce();

      const colors = uiTheme(app.renderer).colors;
      expect(app.spanIn("git-history", "aaaaaaa").fg.equals(colors.text)).toBe(false);
      expect(app.spanIn("git-history", "aaaaaaa").fg.toInts()).toEqual(
        app.spanIn("git-history", "●").fg.toInts(),
      );
      expect(app.spanIn("git-history", "Update login").fg.toInts()).toEqual(colors.text.toInts());
      expect(app.spanIn("git-history", `HEAD → ${icons.branch} main`).fg.toInts()).toEqual(
        app.spanIn("git-history", "aaaaaaa").fg.toInts(),
      );
      const band = app.get(`git-history:${commit.oid}:message-link`);
      if (!(band instanceof TextRenderable)) throw new Error("Missing graph band");
      expect(band.plainText.trim()).toBe("");
      expect(band.fg.toInts()).toEqual(app.spanIn("git-history", "aaaaaaa").fg.toInts());
      expect(app.spanIn("git-history", "Working tree").fg.toInts()).toEqual(colors.text.toInts());
      expect(app.captureCharFrame()).toBe(before);
      expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBe(commit.oid);
    }
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Reflog highlights only hashes while selectors/messages use normal text colors", async () => {
  // Reflog has no graph, so its hash needs an explicit semantic color.
  const app = await mount();
  try {
    await app.openReflog();

    const colors = uiTheme(app.renderer).colors;
    expect(app.spanIn("git-browser-list", "aaaaaaa").fg.toInts()).toEqual(colors.warning.toInts());
    expect(app.spanIn("git-browser-list", "HEAD@{0}").fg.toInts()).toEqual(colors.text.toInts());
    expect(app.spanIn("git-browser-list", "commit: Update login").fg.toInts()).toEqual(
      colors.text.toInts(),
    );
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Changed-file sections have one blank separator that cannot select or open diffs", async () => {
  // Multiple staged files distinguish section spacing from per-file spacing.
  const data = snapshot();
  data.files.unshift(
    { kind: "staged", status: "A", path: "new.ts" },
    { kind: "staged", status: "M", path: "staged.ts" },
  );
  const app = await mount({
    source: {
      load: async () => ok(data),
      details: async () => ok({ commit, message: commit.subject, files: [], branches: [] }),
      compare: async () => ok(comparison()),
    },
  });
  try {
    await app.openWorkingTree();
    const staged = app.positionIn("git-files", "STAGED"),
      first = app.positionIn("git-files", "A new.ts");
    const last = app.positionIn("git-files", "M staged.ts"),
      unstaged = app.positionIn("git-files", "UNSTAGED");
    const modified = app.positionIn("git-files", "M src/login.ts"),
      untracked = app.positionIn("git-files", "UNTRACKED");
    expect(staged.y).toBe(app.get("git-files").y);
    expect(first.y).toBe(staged.y + 1);
    expect(last.y).toBe(first.y + 1);
    expect(unstaged.y).toBe(last.y + 2);
    expect(modified.y).toBe(unstaged.y + 1);
    expect(untracked.y).toBe(modified.y + 2);
    expect(app.positionIn("git-files", "? notes.txt").y).toBe(untracked.y + 1);

    // Blank margins remain inert even though clicking them can focus the list.
    const list = app.get("git-files"),
      selected = app.view.workViewPreferences.gitViews?.["demo:main"]?.file;
    for (const y of [unstaged.y - 1, untracked.y - 1]) {
      expect(
        app
          .captureCharFrame()
          .split("\n")
          [y]!.slice(list.x, list.x + list.width)
          .trim(),
      ).toBe("");
      await app.mockMouse.click(list.x + 1, y);
      await app.renderOnce();
      expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.file).toBe(selected);
      expect(app.get("git-history").visible).toBe(true);
    }

    // Keyboard navigation counts only files, not headings or the new whitespace.
    list.focus();
    app.mockInput.pressKey("HOME");
    for (let index = 0; index < 3; index++) app.mockInput.pressArrow("down");
    app.mockInput.pressKey("y");
    await app.waitFor(() => app.copies.length > 0);
    expect(app.copies).toEqual(["notes.txt"]);
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Skipping empty changed-file sections adds no leading or inter-file gaps", async () => {
  // With no staged or unstaged files, untracked is the first visible section.
  const data = snapshot();
  data.files = [
    { kind: "untracked", status: "?", path: "first.txt" },
    { kind: "untracked", status: "?", path: "second.txt" },
  ];
  const app = await mount({
    source: {
      load: async () => ok(data),
      details: async () => ok({ commit, message: commit.subject, files: [], branches: [] }),
      compare: async () => ok(comparison()),
    },
  });
  try {
    await app.openWorkingTree();
    const title = app.positionIn("git-files", "UNTRACKED"),
      first = app.positionIn("git-files", "? first.txt");
    expect(title.y).toBe(app.get("git-files").y);
    expect(first.y).toBe(title.y + 1);
    expect(app.positionIn("git-files", "? second.txt").y).toBe(first.y + 1);
    expect(app.captureCharFrame()).not.toContain("UNSTAGED");
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Changed files highlight only M letters while retaining full A/D/untracked colors", async () => {
  // Exercise working-tree statuses without changing repository files on disk.
  const data = snapshot();
  data.files.push(
    { kind: "staged", status: "A", path: "added.ts" },
    { kind: "unstaged", status: "D", path: "deleted.ts" },
  );
  const app = await mount({
    source: {
      load: async () => ok(data),
      details: async () => ok({ commit, message: commit.subject, files: [], branches: [] }),
      compare: async () => ok(comparison()),
    },
  });
  try {
    await app.openWorkingTree();
    app.get("git-files").focus();
    await app.renderOnce();

    const colors = uiTheme(app.renderer).colors;
    expect(app.spanIn("git-files", "M src/login.ts").fg.toInts()).toEqual(colors.warning.toInts());
    expect(app.spanIn("git-files", "src/login.ts").fg.toInts()).toEqual(colors.text.toInts());
    for (const text of ["A added.ts", "added.ts", "? notes.txt", "notes.txt"])
      expect(app.spanIn("git-files", text).fg.toInts()).toEqual(colors.success.toInts());
    for (const text of ["D deleted.ts", "deleted.ts"])
      expect(app.spanIn("git-files", text).fg.toInts()).toEqual(colors.error.toInts());
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Commit-list a sends only hashes and y copies full untruncated hashes", async () => {
  // The graph row contains a subject and labels that must not leak into its context.
  const app = await mount();
  try {
    await app.chooseCommit();
    app.mockInput.pressKey("y");
    await app.waitFor(() => app.copies.length === 1);

    await app.ask("review ay");

    expect(app.copies).toEqual([commit.oid]);
    expect(app.requests[0]).toEqual({
      id: "a1",
      text: `review ay\n\nGit context (quoted data):\n${JSON.stringify(commit.oid)}`,
    });
    expect(app.view.workViewPreferences.active["demo:main"]).toBe("git");
    expect(app.view.promptDrafts.a1).toBe("existing Agent draft");
  } finally {
    await app.close();
  }
});

test("Commit details provide reading/drag copying without y or a actions", async () => {
  // Detail character selection differs from list hash-copy and Ask commands.
  const app = await mount();
  try {
    await app.chooseCommit();
    await app.waitForFrame((frame) => frame.includes("Author: Ada"));
    app.get("git-details").focus();
    await app.renderOnce();

    app.mockInput.pressKey("y");
    app.mockInput.pressKey("a");
    await app.renderOnce();
    const footer = app.captureCharFrame().split("\n")[app.renderer.height - 1]!;
    expect(app.get("git-ask").visible).toBe(false);
    expect(footer).not.toContain("Ask");
    expect(footer).not.toContain("Copy");
    expect(footer).not.toContain("<Tab> Pane");
    expect(footer).not.toContain("<Esc> Back");
    expect(footer).toContain("Help");
    const { x, y } = app.positionIn("git-details", "Author: Ada");
    await app.mockMouse.drag(x + 8, y, x + 10, y);
    await app.waitFor(() => app.copies.length > 0);

    expect(app.copies).toEqual(["Ada"]);
    expect(app.requests).toEqual([]);
    expect(app.get("git-changes").visible).toBe(false);
    expect(app.get("git-details-card").visible).toBe(true);
  } finally {
    await app.close();
  }
});

test("Refs shows branch/tag icons and distinguishes current branches with accents instead of checks", async () => {
  // Two local branches can share a tip without both being the checked-out branch.
  const data = snapshot();
  data.refs.push({
    kind: "local",
    name: "feature/topic",
    ref: "refs/heads/feature/topic",
    oid: commit.oid,
  });
  const app = await mount({
    source: {
      load: async () => ok(data),
      details: async () => ok({ commit, message: commit.subject, files: [], branches: [] }),
      compare: async () => ok(comparison()),
    },
  });
  try {
    await app.openRefs();
    const colors = uiTheme(app.renderer).colors;
    expect(app.positionIn("git-browser-list", `${icons.branch} main`).x).toBe(
      app.positionIn("git-browser-list", `${icons.branch} feature/topic`).x,
    );
    expect(app.spanIn("git-browser-list", `${icons.branch} main`).fg.toInts()).toEqual(
      colors.accent.toInts(),
    );
    expect(app.spanIn("git-browser-list", "main").fg.toInts()).toEqual(colors.accent.toInts());
    expect(app.spanIn("git-browser-list", `${icons.branch} feature/topic`).fg.toInts()).toEqual(
      colors.text.toInts(),
    );
    expect(app.captureCharFrame()).not.toContain("✓ main");

    // Candidate selection changes neither current-branch emphasis nor active filters.
    await app.clickIn("git-browser-list", "feature/topic");
    expect(app.spanIn("git-browser-list", `${icons.branch} main`).fg.toInts()).toEqual(
      colors.accent.toInts(),
    );
    expect(app.spanIn("git-browser-list", `${icons.branch} feature/topic`).fg.toInts()).toEqual(
      colors.text.toInts(),
    );
    app.mockInput.pressKey("y");
    await app.waitFor(() => app.copies.length === 1);
    expect(app.copies).toEqual(["feature/topic"]);
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.reference).toBeNull();
    expect(app.spanIn("git-browser-list", `${icons.branch} origin/main`).fg.toInts()).toEqual(
      colors.text.toInts(),
    );
    expect(app.spanIn("git-browser-list", `${icons.tag} v1`).fg.toInts()).toEqual(
      colors.text.toInts(),
    );
    expect(app.requests).toEqual([]);
    expect(app.creations).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Refs Ask traps Tab inside input and Esc returns to candidates", async () => {
  // Closing nested input must not close outer modals or main filters.
  const app = await mount();
  try {
    await app.openRefs();
    await app.clickIn("git-browser-list", "origin/main");
    app.mockInput.pressKey("a");
    await app.renderOnce();

    app.mockInput.pressTab();
    await app.renderOnce();
    app.mockInput.pressEscape();
    await app.renderOnce();

    expect(app.get("git-ask").visible).toBe(false);
    expect(app.get("git-browser").visible).toBe(true);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("git-browser-list");
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.reference).toBeNull();
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Refs Local/Remote/Tags attach and copy only names while Enter changes query filters only", async () => {
  // Reference selection never changes the working branch or includes a tip hash.
  const app = await mount();
  try {
    await app.openRefs();
    await app.clickIn("git-browser-list", "origin/main");
    app.mockInput.pressKey("y");
    await app.waitFor(() => app.copies.length > 0);

    await app.ask("compare this branch");

    expect(app.copies[0]).toBe("origin/main");
    expect(app.requests[0]!.text).toContain(JSON.stringify("origin/main"));
    expect(app.requests[0]!.text).not.toContain(rootCommit.oid);
    await app.clickIn("git-browser-list", "v1");
    app.mockInput.pressKey("y");
    await app.waitFor(() => app.copies.length === 2);
    expect(app.copies[1]).toBe("v1");
    expect(app.loads).toEqual(["all"]);
    app.mockInput.pressEnter();
    await app.waitFor(() => app.loads.includes("refs/tags/v1"));
    expect(app.get("git-browser").visible).toBe(false);
  } finally {
    await app.close();
  }
});

test("Git diff h/l synchronizes horizontal positions without forwarding input", async () => {
  const longLine = `const horizontal = "${"wide content ".repeat(30)}";\n`;
  const source: GitSource = {
    load: async () => ok(snapshot()),
    details: async () => {
      throw new Error("Unexpected details request");
    },
    compare: async () =>
      ok({
        before: longLine,
        after: longLine + "// after\n",
        beforeLabel: "before",
        afterLabel: "after",
      }),
  };
  const app = await mount({ source });
  try {
    await app.openWorkingTree();
    await app.waitForFrame((frame) => frame.includes("const horizontal"));
    app.get("git-diff").focus();
    app.mockInput.pressKey("l");
    await app.renderOnce();
    const panes = app.codes();
    expect(panes).toHaveLength(2);
    expect(panes[0]!.scrollX).toBe(4);
    expect(panes[1]!.scrollX).toBe(4);
    app.mockInput.pressKey("h");
    await app.renderOnce();
    expect(panes[0]!.scrollX).toBe(0);
    expect(panes[1]!.scrollX).toBe(0);
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("File selection updates right-side diffs and scrolls both sides as one focus region", async () => {
  // The comparison has unchanged content far outside the modified middle line.
  const app = await mount();
  try {
    await app.openWorkingTree();
    await app.waitForFrame((frame) => frame.includes("const line00"));
    expect(app.get("git-changes").visible).toBe(true);
    expect(app.captureCharFrame()).toContain("Changed files");
    expect(app.captureCharFrame()).not.toContain("← Commits");
    expect(app.captureCharFrame()).not.toContain("Before / After");
    expect(app.get("git-file-diff").y).toBe(app.get("git-diff").y + 1);
    expect(app.get("git-file-diff").height).toBe(app.get("git-diff").height - 1);
    app.get("git-diff").focus();

    app.mockInput.pressArrow("down");
    await app.renderOnce();
    const codes = app.codes();
    expect(codes).toHaveLength(2);
    expect(codes[0]!.scrollY).toBeGreaterThan(0);
    expect(codes[0]!.scrollY).toBe(codes[1]!.scrollY);
    app.mockInput.pressKey("END");
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("const line69");
    app.mockInput.pressKey("y");
    await app.waitFor(() => app.copies.length > 0);
    expect(app.copies).toEqual(["src/login.ts"]);
    await app.ask("review file");
    expect(app.requests[0]!.text).toContain("File: src/login.ts");
    expect(app.requests[0]!.text).not.toContain("const line");

    app.mockInput.pressEscape();
    await app.renderOnce();
    expect(app.get("git-history").visible).toBe(true);
  } finally {
    await app.close();
  }
});

test("Code dragging auto-copies only one side without line numbers or Agent requests", async () => {
  // Both code panes are native renderables; only the final clipboard boundary is stubbed.
  const app = await mount();
  try {
    await app.openWorkingTree();
    await app.waitForFrame((frame) => frame.includes("const line00"));
    const codes = app.codes().sort((a, b) => a.x - b.x),
      left = codes[0]!;

    await app.mockMouse.drag(left.x, left.y, left.x + 4, left.y);
    await app.waitFor(() => app.copies.length > 0);

    expect(app.copies[0]).toBe("const");
    expect(app.requests).toEqual([]);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("git-diff");
    expect(app.view.workViewPreferences.active["demo:main"]).toBe("git");
  } finally {
    await app.close();
  }
});

test("Git selection, diffs, and scroll survive worktree round-trips and UI restoration", async () => {
  // Only view identities and positions are persisted, not file content or pending requests.
  const app = await mount();
  let retained: WorkViewPreferences;
  try {
    await app.chooseCommit();
    await app.openChanges();
    await app.waitForFrame((frame) => frame.includes("const line00"));
    app.get("git-diff").focus();
    app.mockInput.pressKey("END");
    await app.renderOnce();
    await app.click(`${icons.folder} radian-ui`);
    await app.click(`${icons.folder} radian`);
    expect(app.get("git-diff").visible).toBe(true);
    retained = app.view.workViewPreferences;
    expect(retained.gitViews?.["demo:main"]?.diffScroll).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
  const restored = await mount({ initial: retained! });
  try {
    await restored.waitForFrame((frame) => frame.includes("const line69"));
    expect(restored.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBe(commit.oid);
    expect(restored.requests).toEqual([]);
  } finally {
    await restored.close();
  }
});

test.each([false, true])(
  "Remapped %j Git target commands preserve input and send only to selected sessions",
  async (overridden) => {
    // Keep input characters literal and expose targets as independent configurable commands.
    const keymap = expectOk(
      parseKeymap({
        bindings: overridden
          ? { "git.change-session": [{ keys: "alt+s", scope: "git-prompt" }] }
          : {},
      }),
    );
    const app = await mount({ keymap });
    try {
      await app.chooseCommit();
      app.mockInput.pressKey("a");
      await app.renderOnce();
      const input = app.get("git-prompt");
      if (!(input instanceof PromptInput)) throw new Error("Missing Git prompt");
      await app.mockInput.typeText("explain hjklay");
      app.mockInput.pressArrow("left");
      const value = input.value,
        caret = input.cursorOffset;

      // Held defaults switch once; overrides preserve drafts and carets too.
      if (overridden) app.mockInput.pressKey("s", { meta: true });
      else
        for (const event of ["\x1b[115;5u", "\x1b[115;5:2u", "\x1b[115;5:3u"]) {
          const parsed = parseKeypress(event, { useKittyKeyboard: true });
          if (!parsed) throw new Error("Invalid Kitty key");
          app.renderer.keyInput.processParsedKey(parsed);
        }
      await app.renderOnce();
      expect(input.value).toBe(value);
      expect(input.cursorOffset).toBe(caret);
      expect(app.renderer.currentFocusedRenderable).toBe(input);
      const footer = app.captureCharFrame().split("\n")[app.renderer.height - 1]!;
      expect(footer).toContain(`${overridden ? "<M-s>" : "<C-s>"} Change session`);
      expect(app.requests).toEqual([]);
      expect(app.creations).toEqual([]);
      app.mockInput.pressEnter();
      await app.waitFor(() => app.requests.length === 1);

      // Target selection alone never executes; explicit submission reaches the second session.
      expect(app.requests[0]?.id).toBe("a2");
      expect(app.requests[0]?.text).toContain(value);
      expect(app.view.promptDrafts.a1).toBe("existing Agent draft");
    } finally {
      await app.close();
    }
  },
);

test("Target commands during Git submission are consumed while preserving retry targets", async () => {
  // Targets cannot change before the first request's acceptance is known.
  const pending = Promise.withResolvers<Result<void, ExpectedError>>(),
    targets: string[] = [];
  const app = await mount({
    actions: {
      prompt: (id) => {
        targets.push(id);
        return pending.promise;
      },
    },
  });
  try {
    await app.chooseCommit();
    app.mockInput.pressKey("a");
    await app.renderOnce();
    await app.mockInput.typeText("Retained request");
    app.mockInput.pressEnter();
    await app.waitFor(() => targets.length === 1);

    // Keys during submission become neither input text nor new targets.
    app.mockInput.pressKey("s", { ctrl: true });
    await app.renderOnce();
    pending.resolve(err(new InputError("Retry request")));
    await app.waitForFrame((frame) => frame.includes("Retry request"));
    const input = app.get("git-prompt");
    if (!(input instanceof PromptInput)) throw new Error("Missing Git prompt");
    expect(input.value).toBe("Retained request");
    app.mockInput.pressEnter();
    await app.waitFor(() => targets.length === 2);

    // Retrying rejected submissions uses the originally selected session.
    expect(targets).toEqual(["a1", "a1"]);
    expect(app.creations).toEqual([]);
  } finally {
    pending.resolve(err(new InputError("cleanup")));
    await app.close();
  }
});

test("Target commands defer session creation until submission and rejection preserves drafts", async () => {
  // The session selector includes an explicit New session choice, never implicit creation on browse.
  const app = await mount({ actions: { prompt: () => err(new InputError("Request rejected")) } });
  try {
    await app.chooseCommit();
    app.mockInput.pressKey("a");
    await app.renderOnce();
    for (let i = 0; i < 3; i++) {
      app.mockInput.pressKey("s", { ctrl: true });
      await app.renderOnce();
    }
    expect(app.creations).toEqual([]);
    expect(app.captureCharFrame()).toContain("New session");

    app.get("git-prompt").focus();
    await app.mockInput.typeText("keep this ay");
    app.mockInput.pressEnter();
    await app.waitForFrame((frame) => frame.includes("Request rejected"));

    expect(app.creations).toEqual(["demo:main"]);
    expect(app.captureCharFrame()).toContain("keep this ay");
    expect(app.get("git-ask").visible).toBe(true);
    expect(app.view.workViewPreferences.active["demo:main"]).toBe("git");
  } finally {
    await app.close();
  }
});

test("Reflog a sends event details and y copies complete target hashes", async () => {
  // Reflog uses the full-width history without resurrecting the right panel.
  const app = await mount();
  try {
    await app.openReflog();
    app.get("git-browser-list").focus();
    app.mockInput.pressKey("y");
    await app.waitFor(() => app.copies.length > 0);

    await app.ask("explain this event");

    expect(app.copies[0]).toBe(commit.oid);
    expect(app.requests[0]!.text).toContain("HEAD@{0}");
    expect(app.requests[0]!.text).toContain("commit: Update login");
    expect(app.get("git-changes").visible).toBe(false);
  } finally {
    await app.close();
  }
});

test("Dragging popup filenames copies substrings without selecting files or focusing diffs", async () => {
  // Text-selection drags must not become click activation.
  const app = await mount();
  try {
    await app.openWorkingTree();
    const { x, y } = app.positionIn("git-files", "M src/login.ts");
    const file = app.view.workViewPreferences.gitViews?.["demo:main"]?.file;

    await app.mockMouse.drag(x + 2, y, x + 2 + "src/login.ts".length - 1, y);
    await app.waitFor(() => app.copies.length > 0);

    expect(app.copies).toEqual(["src/login.ts"]);
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.file).toBe(file);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("git-files");
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Dragging into opposite diffs copies only the originating code region", async () => {
  // A terminal-native whole-screen selection would mix both columns and line numbers.
  const app = await mount();
  try {
    await app.openWorkingTree();
    await app.waitForFrame((frame) => frame.includes("const line00"));
    const [left, right] = app.codes().sort((a, b) => a.x - b.x);

    await app.mockMouse.drag(left!.x, left!.y, right!.x + 4, right!.y);
    await app.waitFor(() => app.copies.length > 0);
    await app.renderOnce();

    expect(app.copies[0]).toBe("const line00 = 0;");
    expect(right!.hasSelection()).toBe(false);
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Hidden interrupted detail lookups refetch on return and ignore stale results", async () => {
  // A cached commit list must not leave an aborted detail request stuck on Loading forever.
  const pending = Promise.withResolvers<Result<import("../model.ts").GitDetails, ExpectedError>>();
  let reads = 0;
  const app = await mount({
    source: {
      load: async () => ok(snapshot()),
      compare: async () => ok(comparison()),
      details: async (selected) =>
        ++reads === 1
          ? pending.promise
          : ok({ commit: selected, message: "Fresh detail", files: [], branches: [] }),
    },
  });
  try {
    await app.click("Update login");
    await app.click(`${icons.folder} radian-ui`);
    await app.click(`${icons.folder} radian`);

    await app.waitForFrame((frame) => frame.includes("Fresh detail"));
    pending.resolve(ok({ commit, message: "Stale detail", files: [], branches: [] }));
    await app.renderOnce();

    expect(reads).toBe(2);
    expect(app.captureCharFrame()).not.toContain("Stale detail");
  } finally {
    pending.resolve(ok({ commit, message: "cleanup", files: [], branches: [] }));
    await app.close();
  }
});

test("Unsupported clipboards never report copy success", async () => {
  // The platform boundary can explicitly reject writes even when text selection works.
  const app = await mount({
    actions: { copy: async () => err(new ClipboardError("Clipboard denied")) },
  });
  try {
    await app.chooseCommit();
    app.mockInput.pressKey("y");

    await app.waitForFrame((frame) => frame.includes("Clipboard denied"));

    expect(app.captureCharFrame()).not.toContain("Copied to clipboard");
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Git diff themes update light backgrounds/syntax while preserving scroll and request drafts", async () => {
  // Theme updates must not reset navigation or accidentally send the open request.
  const app = await mount();
  const dark: TerminalColors = {
    palette: [
      "#000000",
      "#AA2222",
      "#228822",
      "#887700",
      "#2255AA",
      "#AA22AA",
      "#117799",
      "#DDDDDD",
    ],
    defaultForeground: "#EEEEEE",
    defaultBackground: "#121212",
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightForeground: null,
    highlightBackground: null,
  };
  try {
    uiTheme(app.renderer).configure(dark);
    await app.chooseCommit();
    await app.openChanges();
    await app.waitForFrame((frame) => frame.includes("const line00"));
    const oldDiff = app.get("git-file-diff");
    if (!(oldDiff instanceof DiffRenderable)) throw new Error("Missing whole-file diff");
    expect(oldDiff.contextBg.toInts().slice(0, 3)).toEqual([18, 18, 18]);
    expect(oldDiff.addedBg.toInts().slice(0, 3)).toEqual([23, 53, 23]);
    expect(oldDiff.removedBg.toInts().slice(0, 3)).toEqual([64, 23, 23]);
    expect(oldDiff.addedSignColor.toInts().slice(0, 3)).toEqual([34, 136, 34]);
    expect(oldDiff.removedSignColor.toInts().slice(0, 3)).toEqual([170, 34, 34]);
    app.get("git-diff").focus();
    app.mockInput.pressKey("END");
    await app.renderOnce();
    const scroll = app.codes()[0]!.scrollY;
    app.mockInput.pressKey("a");
    await app.renderOnce();
    await app.mockInput.typeText("keep this request");
    const prompt = app.get("git-prompt");

    app.renderer.emit("palette", {
      ...dark,
      defaultForeground: "#202020",
      defaultBackground: "#FAFAFA",
      palette: [...dark.palette.slice(0, 5), "#664488", "#117799", "#DDDDDD"],
    });
    await app.renderOnce();
    await app.renderOnce();

    const diff = app.get("git-file-diff");
    if (!(diff instanceof DiffRenderable) || !(prompt instanceof PromptInput))
      throw new Error("Missing themed controls");
    expect(diff.contextBg.toInts().slice(0, 3)).toEqual([250, 250, 250]);
    expect(diff.lineNumberFg.toInts()[0]).toBeLessThan(160);
    expect(diff.addedBg.toInts().slice(0, 3)).toEqual([185, 216, 185]);
    expect(diff.removedBg.toInts().slice(0, 3)).toEqual([226, 185, 185]);
    expect(diff.addedContentBg?.toInts()).toEqual(diff.addedBg.toInts());
    expect(diff.removedContentBg?.toInts()).toEqual(diff.removedBg.toInts());
    expect(diff.addedLineNumberBg.toInts()).toEqual(diff.addedBg.toInts());
    expect(diff.removedLineNumberBg.toInts()).toEqual(diff.removedBg.toInts());
    expect(diff.syntaxStyle?.getStyle("keyword")?.fg?.toInts().slice(0, 3)).toEqual([102, 68, 136]);
    expect(app.codes()[0]!.scrollY).toBe(scroll);
    expect(app.codes()[1]!.scrollY).toBe(scroll);
    expect(prompt.value).toBe("keep this request");
    expect(app.renderer.currentFocusedRenderable).toBe(prompt);
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBe(commit.oid);
    expect(app.view.promptDrafts.a1).toBe("existing Agent draft");
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Compact diff/Reflog transitions preserve selection and bottom footers", async () => {
  // Native layout must not assume the original Neovim viewer's minimum terminal width.
  const app = await mount();
  try {
    await app.chooseCommit();
    await app.openChanges();
    await app.waitForFrame((frame) => frame.includes("const line00"));

    app.resize(60, 12);
    await app.renderOnce();
    app.resize(160, 32);
    await app.renderOnce();
    app.mockInput.pressEscape();
    await app.renderOnce();
    await app.openReflog();

    expect(app.get("git-changes").visible).toBe(false);
    expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).toContain("GIT");
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBe(commit.oid);
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Renderer-first shutdown prevents late Git responses and cleanup from accessing native buffers", async () => {
  // UI shutdown is independent from the lifetime of a slow read-only query.
  const pending = Promise.withResolvers<Result<import("../model.ts").GitDetails, ExpectedError>>();
  const app = await mount({
    source: {
      load: async () => ok(snapshot()),
      details: () => pending.promise,
      compare: async () => ok(comparison()),
    },
  });
  const errors = spyOn(console, "error");
  try {
    await app.click("Update login");

    app.renderer.destroy();
    await app.renderer.closed;
    pending.resolve(ok({ commit, message: "Late detail", files: [], branches: [] }));
    await Promise.resolve();
    app.view.dispose();

    expect(app.view.workViewPreferences.active["demo:main"]).toBe("git");
    expect(app.requests).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    errors.mockRestore();
    pending.resolve(ok({ commit, message: "cleanup", files: [], branches: [] }));
    await app.close();
  }
});

test("Late worktree lookups never overwrite current Git screens", async () => {
  // The first source ignores cancellation deliberately to exercise the UI generation guard.
  const pending = Promise.withResolvers<Result<GitSnapshot, ExpectedError>>();
  const app = await mount({
    actions: {
      source: (worktree) =>
        worktree.id === "demo:feature"
          ? {
              load: () => pending.promise,
              details: async () => err(new InputError("unused")),
              compare: async () => err(new InputError("unused")),
            }
          : {
              load: async () => ok(snapshot()),
              details: async () => err(new InputError("unused")),
              compare: async () => err(new InputError("unused")),
            },
    },
  });
  try {
    await app.click(`${icons.folder} radian-ui`);
    await app.showGit();
    await app.click(`${icons.folder} radian`);

    const delayed = snapshot();
    delayed.commits[0] = { ...commit, subject: "Stale result" };
    pending.resolve(ok(delayed));
    await app.renderOnce();

    expect(app.captureCharFrame()).not.toContain("Stale result");
    expect(app.selection.worktree?.id).toBe("demo:main");
    expect(app.requests).toEqual([]);
  } finally {
    pending.resolve(ok(snapshot()));
    await app.close();
  }
});
