import { expect, test } from "bun:test";
import { InputRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { HistoryPreviewCache } from "../../agents/history-preview-cache.ts";
import type { ModelCatalog } from "../../agents/model-selection.ts";
import type { AccountsCatalog } from "../../accounts/model.ts";
import type { HistoryItem } from "../../agents/history.ts";
import { ok } from "../../result.ts";
import { pressLeader } from "../../testing/keys.ts";

const flush = async () => {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
};

async function mount(previewUnits = 0) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 120, height: 28, kittyKeyboard: true, clock });
  const selection = new WorkspaceSelection(demoWorkspace());
  const models: ModelCatalog = {
    conversationId: "conversation",
    current: { provider: "fixture", id: "original" },
    effort: "off",
    models: [
      {
        provider: "fixture",
        id: "original",
        name: "Preloaded model",
        contextWindow: 1000,
        reasoning: false,
        images: false,
        efforts: ["off"],
        effort: "off",
      },
    ],
  };
  let accounts: AccountsCatalog = {
    revision: 1,
    worktreeId: "demo:main",
    selections: {},
    providers: [],
    accounts: [
      { id: "one", label: "Preloaded account", provider: "fixture", type: "api_key", usedBy: [] },
    ],
  };
  let history: readonly HistoryItem[] = [
    "first",
    "second",
    ...(previewUnits ? ["third", "fourth"] : []),
  ].map((id) => ({
    id,
    title: `Saved ${id}`,
    worktreeId: "demo:main",
    modified: "2026-10-14T12:34:00.000Z",
    messageCount: 1,
    openSessionId: null,
    unavailableReason: null,
  }));
  const requests = { models: 0, accounts: 0, history: 0, previews: 0 };
  const previews = new HistoryPreviewCache(
    async (tree, id) => {
      requests.previews++;

      return ok({
        worktreeId: tree,
        id,
        text: "x".repeat(previewUnits),
        truncated: false,
        sections: [
          {
            id: `${id}:answer`,
            kind: "assistant",
            title: "Agent",
            text: `Preloaded answer ${id}`,
            status: "complete",
          },
        ],
      });
    },
    () => {},
    (error) => {
      throw error;
    },
  );

  previews.preload(
    "demo:main",
    history.map((item) => ({ id: item.id, revision: "1" })),
  );
  await flush();

  const view = new Workbench(app.renderer, selection, {
    onNewSession() {},
    onCloseSession() {},
    onPrompt: async () => ok(undefined),
    getSessionDetails: () => ({
      conversationId: "conversation",
      status: "complete",
      output: "",
      error: null,
    }),
    preloaded: {
      cachedModels: () => ok(models),
      cachedAccounts: () => ok(accounts),
      cachedHistory: () => ok(history),
      previews,
    },
    onListModels: async () => {
      requests.models++;

      return ok(models);
    },
    onSelectModel: async () => ok(null),
    onAccountsRequest: async () => {
      requests.accounts++;

      return ok({ kind: "catalog", catalog: accounts });
    },
    onListHistory: async () => {
      requests.history++;

      return ok(history);
    },
  });
  const get = (id: string) => {
    const node = app.renderer.root.findDescendantById(id);
    if (!node) {
      throw new Error(`Missing ${id}`);
    }

    return node;
  };
  const render = async () => {
    await app.renderOnce();
    await app.renderOnce();
  };

  await render();

  return {
    ...app,
    clock,
    view,
    get,
    render,
    requests,
    async command(text: string) {
      const input = get("session-prompt") as InputRenderable;
      input.focus();
      input.value = text;
      app.mockInput.pressEnter();
      await render();
    },
    updateAccounts() {
      accounts = {
        ...accounts,
        revision: 2,
        accounts: [
          ...accounts.accounts,
          { id: "two", label: "New account", provider: "fixture", type: "api_key", usedBy: [] },
        ],
      };
      view.refreshPreloadedData();
    },
    updateHistory() {
      history = [history[1]!, history[0]!];
      view.refreshPreloadedData();
    },
    async close() {
      view.dispose();
      previews.clear();
      await app.dispose();
    },
  };
}

test("Prepared model and account popups reopen immediately without requests or loading indicators", async () => {
  // Preparation is complete before either popup is mounted on screen.
  const app = await mount();
  try {
    for (let i = 0; i < 2; i++) {
      await app.command("/model");
      expect(app.captureCharFrame()).toContain("Preloaded model");
      expect(app.get("model-loading").visible).toBe(false);
      app.mockInput.pressEscape();
      await app.render();
      await app.command("/accounts");
      expect(app.captureCharFrame()).toContain("Preloaded account");
      expect(app.get("accounts-loading").visible).toBe(false);
      app.mockInput.pressEscape();
      await app.render();
    }

    expect(app.requests.models).toBe(0);
    expect(app.requests.accounts).toBe(0);
  } finally {
    await app.close();
  }
});

test("Prepared History and complete previews survive closure without rediscovery", async () => {
  // Popup lifetime must not own the cached conversation bodies.
  const app = await mount();
  try {
    for (let i = 0; i < 2; i++) {
      pressLeader(app, "h");
      await app.render();
      expect(app.captureCharFrame()).toContain("Saved first");
      expect(app.captureCharFrame()).toContain("Preloaded answer first");
      expect(app.get("history-loading").visible).toBe(false);
      app.mockInput.pressEscape();
      await app.render();
    }

    expect(app.requests.history).toBe(0);
    expect(app.requests.previews).toBe(2);
  } finally {
    await app.close();
  }
});

test("History opens its preloaded newest body without loading after background cache saturation", async () => {
  // Four speculative bodies exceed the budget; the first two are the most recent conversations.
  const app = await mount(3 * 1024 * 1024);
  try {
    expect(app.requests.previews).toBe(4);

    pressLeader(app, "h");
    await app.render();

    // Opening the default selection must use its prepared body rather than start a fifth read.
    expect(app.captureCharFrame()).toContain("Preloaded answer first");
    expect(app.get("history-loading").visible).toBe(false);
    expect(app.captureCharFrame()).not.toContain("Loading saved sessions…");
    expect(app.requests.history).toBe(0);
    expect(app.requests.previews).toBe(4);
  } finally {
    await app.close();
  }
});

test("Incoming account and history snapshots preserve search caret, focus, and selected candidate", async () => {
  // Live updates replace data without restarting a search or committing a selection.
  const app = await mount();
  try {
    await app.command("/accounts");
    await app.mockInput.typeText("account");
    await app.render();

    const accountSearch = app.get("accounts-search") as InputRenderable;
    accountSearch.cursorOffset = 3;
    app.updateAccounts();
    await app.render();
    expect(accountSearch.value).toBe("account");
    expect(accountSearch.cursorOffset).toBe(3);
    expect(app.renderer.currentFocusedRenderable).toBe(accountSearch);
    expect(app.captureCharFrame()).toContain("New account");
    app.mockInput.pressEscape();
    await app.render();

    pressLeader(app, "h");
    await app.render();
    await app.mockInput.typeText("Saved");
    app.mockInput.pressKey("n", { ctrl: true });
    await app.render();

    const historySearch = app.get("history-search") as InputRenderable;
    historySearch.cursorOffset = 2;
    app.updateHistory();
    await app.render();
    expect(historySearch.value).toBe("Saved");
    expect(historySearch.cursorOffset).toBe(2);
    expect(app.renderer.currentFocusedRenderable).toBe(historySearch);
    expect(app.captureCharFrame()).toContain("Preloaded answer second");
  } finally {
    await app.close();
  }
});
