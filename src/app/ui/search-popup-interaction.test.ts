import { expect, test } from "bun:test";
import { BoxRenderable, InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { uiTheme } from "../../ui/theme.ts";
import { ok } from "../../result.ts";
import type { AccountsCatalog } from "../../accounts/model.ts";
import type { ModelCatalog } from "../../agents/model-selection.ts";
import type { SessionExtensionUi } from "../../agents/extension-ui.ts";
import type { GitSnapshot } from "../../git/model.ts";
import { submitPromptCommand } from "../../testing/keys.ts";

const surfaces = [
  "workspace",
  "monitor",
  "history",
  "model",
  "accounts",
  "messages",
  "refs",
  "reflog",
  "extension",
] as const;

type Surface = (typeof surfaces)[number];

const names = ["Alpha", "Beta", "Gamma", "Delta"];
const ids: Record<Surface, readonly [string, string]> = {
  workspace: ["workspace-search", "workspace-tree"],
  monitor: ["monitor-search", "monitor-list"],
  history: ["history-search", "history-list"],
  model: ["model-search", "model-list"],
  accounts: ["accounts-search", "accounts-list"],
  messages: ["messages-search", "messages-list"],
  refs: ["git-browser-search", "git-browser-list"],
  reflog: ["git-browser-search", "git-browser-list"],
  extension: ["extension-dialog-search", "extension-dialog-list"],
};

async function mount(surface: Surface, width = 140, pendingLoad = false) {
  const app = await createTestRenderer({
    width,
    height: 32,
    kittyKeyboard: true,
    exitOnCtrlC: false,
    clock: new ManualClock(),
  });
  const repository = demoWorkspace()[0]!;
  const original = repository.worktrees[0]!;
  const sessions = names.map((name) => ({
    id: name.toLowerCase(),
    name,
    status: "working" as const,
    subagents: [],
  }));
  const trees = names.map((name, index) => ({
    ...original,
    id: `tree-${index}`,
    name,
    branch: name.toLowerCase(),
    sessions: index ? [] : sessions,
  }));
  const selection = new WorkspaceSelection([{ ...repository, worktrees: trees }]);
  const omitted = new Set<string>();
  const accepted: string[] = [];
  const sent: string[] = [];
  const visibleNames = () => names.filter((name) => !omitted.has(name));
  let extensionState: SessionExtensionUi[] = [];
  let request = 0;
  let pending: Promise<void> | undefined;
  let release = () => {};
  const defer = () => {
    const gate = Promise.withResolvers<void>();
    pending = gate.promise;
    release = () => {
      pending = undefined;
      gate.resolve();
    };
  };
  if (pendingLoad) {
    defer();
  }

  const wait = () => pending ?? Promise.resolve();
  const catalog = (worktreeId: string): AccountsCatalog => ({
    revision: 1,
    worktreeId,
    selections: {},
    providers: [{ id: "fixture", name: "Fixture", methods: [{ id: "api_key", name: "API key" }] }],
    accounts: visibleNames().map((label) => ({
      id: `account-${label.toLowerCase()}`,
      provider: "fixture",
      label,
      type: "api_key",
      usedBy: [],
    })),
  });
  const snapshot: GitSnapshot = {
    commits: [],
    files: [],
    head: "alpha",
    headOid: null,
    refs: names.map((name, index) => ({
      kind: "local",
      name: name.toLowerCase(),
      ref: `refs/heads/${name.toLowerCase()}`,
      oid: String(index + 1).repeat(40),
    })),
    reflog: names.map((name, index) => ({
      oid: String(index + 1).repeat(40),
      selector: `HEAD@{${index}}`,
      date: "2026-10-21T00:00:00Z",
      subject: `${name} change`,
    })),
  };
  const view = new Workbench(app.renderer, selection, {
    onNewSession() {},
    onCloseSession() {},
    initialDrafts: { alpha: "Unsent draft" },
    getSessionDetails: (id) => ({
      conversationId: `conversation-${id}`,
      status: "working",
      output: "Audit output",
      error: null,
    }),
    onPrompt: (_id, text) => {
      sent.push(text);

      return ok(undefined);
    },
    onListHistory: async (worktreeId) => {
      await wait();

      return ok(
        visibleNames().map((title) => ({
          id: `saved-${title.toLowerCase()}`,
          title,
          worktreeId,
          modified: "2026-10-21T00:00:00Z",
          messageCount: 1,
          openSessionId: null,
          unavailableReason: null,
        })),
      );
    },
    onPreviewHistory: async (worktreeId, id) =>
      ok({ worktreeId, id, text: "Saved output", truncated: false }),
    onResumeSession: async () => {
      accepted.push("history");

      return ok("alpha");
    },
    onListModels: async (_id, conversationId) => {
      await wait();
      const result: ModelCatalog = {
        conversationId,
        current: { provider: "fixture", id: "alpha" },
        effort: "low",
        models: visibleNames().map((name) => ({
          provider: "fixture",
          id: name.toLowerCase(),
          name,
          contextWindow: 1000,
          images: false,
          reasoning: true,
          efforts: ["low", "high"],
          effort: "low",
        })),
      };

      return ok(result);
    },
    onSelectModel: async () => {
      accepted.push("model");

      return ok(null);
    },
    onAccountsRequest: async (action) => {
      await wait();
      if (action.type !== "list") {
        accepted.push(action.type);
      }

      return ok({ kind: "catalog", catalog: catalog(action.worktreeId) });
    },
    getExtensionUi: () => extensionState,
    onExtensionUiResponse: async () => ok(undefined),
    git: {
      source: () => ({
        load: async () => ok(snapshot),
        details: async (commit) => ok({ commit, message: "Audit commit", files: [], branches: [] }),
        lookup: async (oid) =>
          ok({
            commit: { oid, parents: [], subject: "Audit", author: "Fixture", date: "2026-10-21" },
            message: "Audit commit",
            files: [],
            branches: [],
          }),
        compare: async () =>
          ok({ before: "", after: "", beforeLabel: "before", afterLabel: "after" }),
      }),
      createSession: async () => ok("alpha"),
      prompt: () => ok(undefined),
    },
  });
  const render = async () => {
    for (let pass = 0; pass < 4; pass++) {
      await Promise.resolve();
      await app.renderOnce();
    }
  };
  const get = (id: string) => {
    const node = app.renderer.root.findDescendantById(id);
    if (!node) {
      throw new Error(`Missing ${surface}/${id}`);
    }

    return node;
  };
  const leader = (key: string) => {
    app.mockInput.pressKey(" ", { ctrl: true });
    app.mockInput.pressKey(key);
  };

  await render();

  const open = async () => {
    if (surface === "workspace" || surface === "monitor") {
      leader(surface === "workspace" ? "b" : "s");
    } else if (surface === "history") {
      submitPromptCommand(app, "/history");
    } else if (surface === "model" || surface === "accounts") {
      const prompt = get("session-prompt") as InputRenderable;
      prompt.focus();
      prompt.value = `/${surface}`;
      app.mockInput.pressEnter();
    } else if (surface === "messages") {
      view.notify("Alpha update", { level: "warning" });
      view.notify("Beta update", { level: "warning" });
      leader("!");
    } else if (surface === "refs" || surface === "reflog") {
      leader("g");
      await render();
      get("git-history").focus();
      app.mockInput.pressKey(surface === "refs" ? "b" : "r", { ctrl: surface === "reflog" });
    } else {
      extensionState = [
        {
          sessionId: "alpha",
          conversationId: "conversation-alpha",
          dialog: { id: `request-${++request}`, kind: "select", title: "Choose", options: names },
          notifications: [],
          statuses: {},
        },
      ];
      selection.replaceSnapshot(selection.snapshot);
    }

    await render();
  };
  await open();

  const input = get(ids[surface][0]) as InputRenderable;
  const list = get(ids[surface][1]) as ScrollBoxRenderable;
  const selected = () =>
    list.content
      .getChildren()
      .find(
        (node) =>
          node instanceof BoxRenderable &&
          node.backgroundColor.equals(uiTheme(app.renderer).styles["ui.selection"].bg!),
      )?.id;

  return {
    ...app,
    view,
    get,
    input,
    list,
    render,
    open,
    selected,
    omitted,
    accepted,
    sent,
    defer,
    release: () => release(),
    async close() {
      release();
      view.dispose();
      await app.dispose();
    },
  };
}

for (const width of [140, 60]) {
  test.each(surfaces)(
    `%s opens fresh search and shares candidate focus navigation at ${width} columns`,
    async (surface) => {
      // Each picker supplies only fixture data; actual Workbench routing owns all input and focus transitions.
      const app = await mount(surface, width);
      try {
        expect(app.renderer.currentFocusedRenderable).toBe(app.input);
        app.input.value = "a";
        app.input.cursorOffset = 0;
        await app.render();
        app.mockInput.pressKey("n", { ctrl: true });
        await app.render();
        expect(app.renderer.currentFocusedRenderable).toBe(app.input);
        expect(app.input.value).toBe("a");
        expect(app.input.cursorOffset).toBe(0);

        // Slash and Tab both return from results to search without changing the active query or caret.
        app.mockInput.pressTab();
        await app.render();
        expect(app.renderer.currentFocusedRenderable).toBe(app.list);
        app.mockInput.pressKey("/");
        await app.render();
        expect(app.renderer.currentFocusedRenderable).toBe(app.input);
        app.mockInput.pressTab();
        await app.render();
        for (
          let step = 0;
          step < 4 && app.renderer.currentFocusedRenderable !== app.input;
          step++
        ) {
          app.mockInput.pressTab();
          await app.render();
        }

        expect(app.renderer.currentFocusedRenderable).toBe(app.input);
        expect(app.input.value).toBe("a");
        expect(app.input.cursorOffset).toBe(0);
        app.list.focus();
        app.mockInput.pressCtrlC();
        await app.render();
        expect(app.input.value).toBe("");
        expect(app.renderer.currentFocusedRenderable).toBe(app.list);

        // Reopening is a fresh search, unlike refreshing a currently open picker.
        app.input.focus();
        app.input.value = "Beta";
        app.input.cursorOffset = 2;
        await app.render();
        app.mockInput.pressEscape();
        await app.render();
        await app.open();
        expect(app.renderer.currentFocusedRenderable).toBe(app.input);
        expect(app.input.value).toBe("");
        expect(app.input.cursorOffset).toBe(0);
        expect(app.sent).toEqual([]);
        expect(app.accepted).toEqual([]);
      } finally {
        await app.close();
      }
    },
  );
}

test.each(surfaces)(
  "%s normalizes Unicode and searches all whitespace-separated terms",
  async (surface) => {
    // Every catalog includes Alpha, while different domain fields may legitimately match additional candidates.
    const app = await mount(surface);
    try {
      for (const query of ["Ａｌｐｈａ", "pha   al"]) {
        app.input.value = query;
        await app.render();
        expect(app.selected()).toBeDefined();
        expect(app.renderer.currentFocusedRenderable).toBe(app.input);
      }

      expect(app.sent).toEqual([]);
      expect(app.accepted).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test.each(["history", "model", "accounts"] as const)(
  "%s initial loading preserves text entered before data arrives",
  async (surface) => {
    // Discovery deliberately stays pending while the user starts filtering the empty picker.
    const app = await mount(surface, 140, true);
    try {
      app.input.value = "Beta";
      app.input.cursorOffset = 2;
      await app.render();
      app.release();
      await app.render();

      // A late catalog is filtered using current input and never steals focus or restores an old query.
      expect(app.input.value).toBe("Beta");
      expect(app.input.cursorOffset).toBe(2);
      expect(app.renderer.currentFocusedRenderable).toBe(app.input);
      expect(app.selected()).toContain("beta");
      expect(app.accepted).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test.each(["history", "model", "accounts"] as const)(
  "%s refresh preserves query, caret, focus and an existing candidate",
  async (surface) => {
    const app = await mount(surface);
    try {
      // Select a non-default candidate before refreshing from result-list focus.
      app.input.value = "a";
      app.input.cursorOffset = 0;
      await app.render();
      app.mockInput.pressKey("n", { ctrl: true });
      await app.render();

      const selected = app.selected();
      expect(selected).toBeDefined();
      app.list.focus();
      app.defer();
      app.mockInput.pressKey("r", { ctrl: true });
      await app.render();
      app.release();
      await app.render();

      expect(app.input.value).toBe("a");
      expect(app.input.cursorOffset).toBe(0);
      expect(app.renderer.currentFocusedRenderable).toBe(app.list);
      expect(app.selected()).toBe(selected);
      expect(app.accepted).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test.each(["history", "model", "accounts"] as const)(
  "%s refresh applies the latest query typed while data is pending",
  async (surface) => {
    const app = await mount(surface);
    try {
      app.input.value = "a";
      await app.render();
      app.defer();
      app.mockInput.pressKey("r", { ctrl: true });
      await app.render();
      app.input.value = "Beta";
      app.input.cursorOffset = 1;
      await app.render();
      app.release();
      await app.render();

      expect(app.input.value).toBe("Beta");
      expect(app.input.cursorOffset).toBe(1);
      expect(app.renderer.currentFocusedRenderable).toBe(app.input);
      expect(app.selected()).toContain("beta");
      expect(app.accepted).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test.each(["history", "model", "accounts"] as const)(
  "%s refresh falls back to the first match when the selected candidate disappears",
  async (surface) => {
    const app = await mount(surface);
    try {
      // Keep Beta selected while broadening the query before it disappears from the next catalog.
      const first = app.selected();
      app.input.value = "Beta";
      await app.render();
      app.input.value = "a";
      app.input.cursorOffset = 0;
      await app.render();
      expect(app.selected()).toContain("beta");
      app.defer();
      app.mockInput.pressKey("r", { ctrl: true });
      await app.render();
      app.omitted.add("Beta");
      app.release();
      await app.render();

      expect(app.input.value).toBe("a");
      expect(app.input.cursorOffset).toBe(0);
      expect(app.selected()).toBe(first);
      expect(app.renderer.currentFocusedRenderable).toBe(app.input);
      expect(app.accepted).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test.each(["history", "model", "accounts"] as const)(
  "%s refresh drops removed candidates without activating stale data",
  async (surface) => {
    const app = await mount(surface);
    try {
      app.input.value = "Beta";
      app.input.cursorOffset = 2;
      await app.render();
      expect(app.selected()).toContain("beta");
      app.defer();
      app.mockInput.pressKey("r", { ctrl: true });
      await app.render();
      app.omitted.add("Beta");
      app.release();
      await app.render();
      app.mockInput.pressEnter();
      await app.render();

      expect(app.input.value).toBe("Beta");
      expect(app.input.cursorOffset).toBe(2);
      expect(app.selected()).toBeUndefined();
      expect(app.renderer.currentFocusedRenderable).toBe(app.input);
      expect(app.accepted).toEqual([]);
      expect(app.sent).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test.each(["history", "reflog"] as const)(
  "Compact %s previews share focus toggles and Tab traversal",
  async (surface) => {
    const app = await mount(surface, 60);
    try {
      // Preview is a real focus region even when it replaces the list on compact screens.
      app.mockInput.pressKey("o", { ctrl: true });
      await app.render();
      expect(app.list.visible).toBe(false);
      expect(app.renderer.currentFocusedRenderable).not.toBe(app.input);
      app.mockInput.pressKey("o", { ctrl: true });
      await app.render();
      expect(app.list.visible).toBe(true);
      expect(app.renderer.currentFocusedRenderable).toBe(app.input);
      app.mockInput.pressTab();
      app.mockInput.pressTab();
      await app.render();
      expect(app.list.visible).toBe(false);
      expect(app.renderer.currentFocusedRenderable).not.toBe(app.input);
      app.mockInput.pressTab();
      await app.render();
      expect(app.list.visible).toBe(true);
      expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    } finally {
      await app.close();
    }
  },
);
