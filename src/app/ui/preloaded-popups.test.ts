import { expect, test } from "bun:test";
import { InputRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { HistoryPreviewCache } from "../../agents/history-preview-cache.ts";
import type { ModelCatalog } from "../../agents/model-selection.ts";
import type { AccountsCatalog } from "../../accounts/model.ts";
import type { HistoryItem } from "../../agents/history.ts";
import { CHAT_SCOPE_ID } from "../../agents/session-scope.ts";
import type { ChatCollection } from "../../runtime/protocol.ts";
import { CapabilityError, type ExpectedError } from "../../errors.ts";
import { err, ok, type Result } from "../../result.ts";
import { pressLeader } from "../../testing/keys.ts";
import { icons } from "../../icons.ts";

const flush = async () => {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
};

async function mount(
  previewUnits = 0,
  options: Pick<WorkbenchActions, "getChat" | "initialChatSessionId"> = {},
) {
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
    providers: [
      { id: "fixture", name: "Fixture", methods: [{ id: "api_key", name: "API key" }] },
      { id: "anthropic", name: "Anthropic", methods: [{ id: "oauth", name: "OAuth" }] },
      { id: "google", name: "Google", methods: [{ id: "api_key", name: "API key" }] },
    ],
    accounts: [
      { id: "one", label: "Preloaded account", provider: "fixture", type: "api_key", usedBy: [] },
    ],
    existingAccounts: [{ provider: "anthropic", name: "Anthropic", type: "oauth" }],
  };
  const accountCatalogs = new Map<string, Result<AccountsCatalog, ExpectedError>>([
    ["demo:main", ok(accounts)],
  ]);
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
    ...options,
    onNewSession() {},
    onCloseSession() {},
    onPrompt: async () => ok(undefined),
    getSessionDetails: () => ({
      conversationId: "conversation",
      status: "complete",
      output: "",
      error: null,
      telemetry: {
        provider: "openai-codex",
        model: "original",
        effort: "off",
        fast: false,
        context: null,
        weekly: null,
        usage: {
          provider: "openai",
          status: "ready",
          windows: [{ id: "period", usedPercent: 18, resetsAt: null, periodMs: 604800000 }],
          updatedAt: 0,
          errorCode: null,
        },
      },
    }),
    preloaded: {
      cachedModels: () => ok(models),
      cachedAccounts: (scope) => accountCatalogs.get(scope),
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
    selection,
    accounts,
    get,
    render,
    requests,
    statusLine() {
      return app.captureCharFrame().split("\n")[get("session-status-line").y]!;
    },
    footerLine() {
      return app.captureCharFrame().split("\n")[get("footer-bar").y]!;
    },
    providerIcon(provider: string) {
      const footer = get("footer-bar");
      // Generic provider glyphs are drawn in their usage layer rather than a vector icon node.
      return (
        footer.findDescendantById(`footer-provider-icon-${provider}`) ??
        footer.findDescendantById(`footer-usage-loading-${provider}`)?.parent
      );
    },
    setAccounts(scope: string, result: Result<AccountsCatalog, ExpectedError> | undefined) {
      if (result) {
        accountCatalogs.set(scope, result);
      } else {
        accountCatalogs.delete(scope);
      }

      view.refreshPreloadedData();
    },
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
      accountCatalogs.set("demo:main", ok(accounts));
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

test("Startup footer includes saved and default connections without opening popups or requesting data", async () => {
  // The prepared catalog contains a named account, default authentication, and an unsigned provider.
  const app = await mount();
  try {
    // Account usage belongs to the global footer; session chrome retains model and context only.
    const status = app.statusLine();
    const footer = app.footerLine();
    expect(status).toContain("original");
    expect(status).toContain(icons.context);
    expect(status).not.toContain("18% used");
    expect(status).not.toContain(icons.openai);
    expect(status).not.toContain(icons.claude);
    expect(status.split(icons.robot).length - 1).toBe(1);
    expect(footer).toContain("18% used");
    expect(footer).toContain(icons.openai);
    expect(footer).toContain(icons.claude);
    expect(app.providerIcon("openai-codex")?.visible).toBe(true);
    expect(app.providerIcon("fixture")?.visible).toBe(true);
    expect(app.providerIcon("anthropic")?.visible).toBe(true);
    expect(app.providerIcon("google")?.visible).not.toBe(true);
    expect(footer.split(icons.robot).length - 1).toBe(1);
    expect(footer).not.toMatch(/usage|fixture|claude|google|chatgpt|openai|Help|<F1>/iu);
    expect(app.get("session-status").y).toBeGreaterThan(app.get("agent-composer").y);
    expect(app.get("accounts-picker").visible).toBe(false);
    expect(app.get("model-picker").visible).toBe(false);
    expect(app.requests.accounts).toBe(0);
    expect(app.requests.models).toBe(0);
    expect(app.requests.history).toBe(0);
  } finally {
    await app.close();
  }
});

test("Account cache additions and removals update the footer without changing the active draft", async () => {
  // The composer owns an unfinished prompt while authentication changes arrive in the background.
  const app = await mount();
  try {
    const input = app.get("session-prompt") as InputRenderable;
    input.focus();
    input.value = "unfinished prompt";
    input.cursorOffset = 4;

    // A newly connected provider must appear without restarting the Agent panel.
    app.setAccounts(
      "demo:main",
      ok({
        ...app.accounts,
        revision: 2,
        accounts: [
          ...app.accounts.accounts,
          { id: "google", label: "Work", provider: "google", type: "api_key", usedBy: [] },
        ],
      }),
    );
    await app.render();
    // Fixture and Google each keep one footer icon alongside Anthropic and the active provider.
    expect(app.footerLine().split(icons.robot).length - 1).toBe(2);
    expect(app.providerIcon("google")?.visible).toBe(true);
    expect(app.providerIcon("fixture")?.visible).toBe(true);
    expect(app.providerIcon("anthropic")?.visible).toBe(true);

    // Removing all authentication must not leave badges behind or steal the draft's focus and caret.
    app.setAccounts(
      "demo:main",
      ok({ ...app.accounts, revision: 3, accounts: [], existingAccounts: [] }),
    );
    await app.render();
    expect(app.providerIcon("fixture")?.visible).not.toBe(true);
    expect(app.providerIcon("google")?.visible).not.toBe(true);
    expect(app.providerIcon("anthropic")?.visible).not.toBe(true);
    expect(app.providerIcon("openai-codex")?.visible).toBe(true);
    expect(app.footerLine()).toContain("18% used");
    expect(app.statusLine()).toContain("original");
    expect(app.statusLine()).not.toContain("18% used");
    expect(input.value).toBe("unfinished prompt");
    expect(input.cursorOffset).toBe(4);
    expect(app.renderer.currentFocusedRenderable).toBe(input);
    expect(app.get("accounts-picker").visible).toBe(false);
    expect(app.requests.accounts).toBe(0);
  } finally {
    await app.close();
  }
});

test.each([
  ["missing", undefined],
  ["failed", err(new CapabilityError("Account discovery is unavailable."))],
] as const)(
  "A %s account cache clears stale connections without requesting data",
  async (_state, result) => {
    // A previously successful catalog must not remain visible after its cache becomes unusable.
    const app = await mount();
    try {
      expect(app.providerIcon("fixture")?.visible).toBe(true);
      expect(app.providerIcon("anthropic")?.visible).toBe(true);

      app.setAccounts("demo:main", result);
      await app.render();

      // Clearing passive connections leaves session metadata and active-provider footer usage intact.
      expect(app.providerIcon("fixture")?.visible).not.toBe(true);
      expect(app.providerIcon("anthropic")?.visible).not.toBe(true);
      expect(app.providerIcon("openai-codex")?.visible).toBe(true);
      expect(app.statusLine()).toContain("original");
      expect(app.statusLine()).not.toContain("18% used");
      expect(app.footerLine()).toContain("18% used");
      expect(app.requests.accounts).toBe(0);
    } finally {
      await app.close();
    }
  },
);

test("CHAT and worktree navigation clear or replace connections from the current scope", async () => {
  // CHAT has its own account cache even while a project worktree remains selected.
  const chat: ChatCollection = {
    id: CHAT_SCOPE_ID,
    path: "/demo/chat",
    name: "CHAT",
    sessions: [{ id: "chat-session", name: "Chat", status: "complete", subagents: [] }],
    details: {},
    historyRevision: 0,
    accountsRevision: 0,
    closingCount: 0,
  };
  const app = await mount(0, { getChat: () => chat, initialChatSessionId: "chat-session" });
  try {
    expect(app.providerIcon("fixture")?.visible).toBe(true);
    expect(app.providerIcon("anthropic")?.visible).toBe(true);
    expect(app.providerIcon("google")?.visible).not.toBe(true);

    // Entering an unprepared scope must clear the previous scope's connected providers immediately.
    pressLeader(app, "m");
    await app.render();
    expect(app.view.currentView).toBe("chat");
    expect(app.providerIcon("fixture")?.visible).not.toBe(true);
    expect(app.providerIcon("anthropic")?.visible).not.toBe(true);
    expect(app.providerIcon("google")?.visible).not.toBe(true);

    app.setAccounts(
      CHAT_SCOPE_ID,
      ok({
        ...app.accounts,
        worktreeId: CHAT_SCOPE_ID,
        accounts: [
          { id: "chat-key", label: "Chat", provider: "google", type: "api_key", usedBy: [] },
        ],
        existingAccounts: [],
      }),
    );
    await app.render();
    expect(app.providerIcon("google")?.visible).toBe(true);
    expect(app.providerIcon("fixture")?.visible).not.toBe(true);
    expect(app.providerIcon("anthropic")?.visible).not.toBe(true);

    // A worktree selection while CHAT is active must keep using CHAT's catalog on render and refresh.
    app.selection.selectWorktree("demo:feature");
    app.view.refreshPreloadedData();
    await app.render();
    expect(app.providerIcon("google")?.visible).toBe(true);
    expect(app.providerIcon("fixture")?.visible).not.toBe(true);
    expect(app.providerIcon("anthropic")?.visible).not.toBe(true);
    pressLeader(app, "a");
    await app.render();
    expect(app.view.currentView).toBe("agent");
    expect(app.providerIcon("google")?.visible).not.toBe(true);
    expect(app.providerIcon("fixture")?.visible).not.toBe(true);
    expect(app.providerIcon("anthropic")?.visible).not.toBe(true);

    app.setAccounts(
      "demo:feature",
      ok({ ...app.accounts, worktreeId: "demo:feature", accounts: [] }),
    );
    await app.render();
    expect(app.providerIcon("anthropic")?.visible).toBe(true);
    expect(app.providerIcon("fixture")?.visible).not.toBe(true);
    expect(app.providerIcon("google")?.visible).not.toBe(true);

    // Returning to each prepared scope must replace badges instead of accumulating live connections.
    pressLeader(app, "m");
    await app.render();
    expect(app.providerIcon("google")?.visible).toBe(true);
    expect(app.providerIcon("anthropic")?.visible).not.toBe(true);
    pressLeader(app, "a");
    await app.render();
    expect(app.providerIcon("anthropic")?.visible).toBe(true);
    expect(app.providerIcon("google")?.visible).not.toBe(true);
    app.selection.selectWorktree("demo:main");
    await app.render();
    expect(app.providerIcon("fixture")?.visible).toBe(true);
    expect(app.providerIcon("anthropic")?.visible).toBe(true);
    expect(app.providerIcon("google")?.visible).not.toBe(true);
    expect(app.requests.accounts).toBe(0);
  } finally {
    await app.close();
  }
});

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
      await app.command("/history");
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

    await app.command("/history");

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

    // A second saved Fixture account must not duplicate the provider's footer icon.
    expect(app.footerLine().split(icons.robot).length - 1).toBe(1);
    expect(app.providerIcon("fixture")?.visible).toBe(true);
    expect(app.providerIcon("anthropic")?.visible).toBe(true);

    await app.command("/history");
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
