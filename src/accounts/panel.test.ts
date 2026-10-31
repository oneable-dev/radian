import { expect, spyOn, test } from "bun:test";
import { InputRenderable, OptimizedBuffer, type ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock, setRendererCapabilities } from "@opentui/core/testing";
import { icons } from "../icons.ts";
import { Workbench, type WorkbenchActions } from "../app/ui/workbench.ts";
import { WorkspaceSelection } from "../app/workspace-selection.ts";
import { demoWorkspace } from "../workspace/demo.ts";
import {
  accountsCommand,
  type AccountReply,
  type AccountRequest,
  type AccountsCatalog,
  type LoginView,
} from "./model.ts";
import {
  BrowserError,
  CancelledError,
  InputError,
  StorageError,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { parseKeymap } from "../keybindings/config.ts";
import { keymapHelp } from "../keybindings/help.ts";
import { expectOk } from "../testing/results.ts";

const catalog: AccountsCatalog = {
  revision: 1,
  worktreeId: "",
  selections: {},
  accounts: [{ id: "named", provider: "fixture", label: "Personal", type: "api_key", usedBy: [] }],
  providers: [
    {
      id: "fixture",
      name: "Fixture",
      methods: [
        { id: "api_key", name: "API key" },
        { id: "oauth", name: "OAuth" },
      ],
    },
  ],
};

async function mount(overrides: Partial<WorkbenchActions> = {}) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true, clock });
  const selection = new WorkspaceSelection(demoWorkspace());
  const sent: string[] = [];
  const requests: AccountRequest[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession() {},
    onCloseSession() {},
    onPrompt: async (_id, text) => {
      sent.push(text);

      return ok(undefined);
    },
    onComplete: async () => ok({ items: [accountsCommand], truncated: false }),
    onAccountsRequest: async (request) => {
      requests.push(request);

      return ok({
        kind: "catalog",
        catalog: { ...structuredClone(catalog), worktreeId: request.worktreeId },
      });
    },
    ...overrides,
  });
  const get = (id: string) => {
    const item = app.renderer.root.findDescendantById(id);
    if (!item) {
      throw new Error(`Missing ${id}`);
    }

    return item;
  };
  const render = async () => {
    await app.renderOnce();
    await app.renderOnce();
  };
  const prompt = get("session-prompt") as InputRenderable;

  await render();
  prompt.focus();

  return {
    ...app,
    view,
    clock,
    selection,
    requests,
    sent,
    get,
    prompt,
    render,
    async open(text = "/accounts") {
      await app.mockInput.typeText(text);
      await render();
      clock.advance(150);
      await render();
      app.mockInput.pressEnter();
      await render();
      if (get("accounts-picker").visible) {
        // Explicitly enter the list for the account-action scenarios below.
        expect(app.renderer.currentFocusedRenderable?.id).toBe("accounts-search");
        app.mockInput.pressTab();
        await render();
      }
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test("The accounts command opens a native popup and changes only the current workspace selection", async () => {
  // Show shared accounts before selection and offer command completion.
  const app = await mount();
  try {
    // Searching and selecting a named account changes only the current workspace.
    await app.open("/acc");
    expect(app.get("accounts-picker").visible).toBe(true);
    app.mockInput.pressKey("/");
    await app.render();
    await app.mockInput.typeText("Personal");
    await app.render();
    app.mockInput.pressEnter();
    await app.render();

    // Commands and account selection neither prompt the model nor replace conversations.
    expect(app.requests.find((request) => request.type === "select")).toEqual({
      type: "select",
      worktreeId: app.selection.worktree!.id,
      provider: "fixture",
      accountId: "named",
      revision: 1,
    });
    expect(app.sent).toEqual([]);
    expect(app.prompt.value).toBe("");
    app.mockInput.pressEscape();
    await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
  } finally {
    await app.close();
  }
});

test("The initial account list shows saved accounts and lists unauthenticated providers only when adding", async () => {
  // Unauthenticated providers remain available when adding an account.
  const app = await mount({
    onAccountsRequest: async (request) =>
      ok({
        kind: "catalog",
        catalog: {
          ...catalog,
          worktreeId: request.worktreeId,
          providers: [
            ...catalog.providers,
            { id: "other", name: "Other Service", methods: [{ id: "oauth", name: "Sign in" }] },
          ],
        },
      }),
  });
  try {
    // Do not invent unauthenticated defaults in the account switcher.
    await app.open();

    const frame = app.captureCharFrame();
    expect(frame).toContain("Fixture · Personal");
    expect(frame).not.toContain("Other Service");
    expect(frame).not.toContain("Pi default");
    expect(frame).not.toContain("[Active]");

    // Show all login providers only when adding an account.
    app.mockInput.pressEnter();
    await app.render();
    expect(app.captureCharFrame()).toContain("Other Service");
    expect(app.captureCharFrame()).toContain("Fixture");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Account switching keeps add, existing, and saved accounts on adjacent single lines", async () => {
  // Existing connections and saved credentials share the same compact account list.
  const app = await mount({
    onAccountsRequest: async (request) =>
      ok({
        kind: "catalog",
        catalog: {
          ...catalog,
          worktreeId: request.worktreeId,
          selections: { fixture: "named" },
          existingAccounts: [{ provider: "fixture", name: "Fixture", type: "oauth" }],
        },
      }),
  });
  try {
    await app.open();

    // Keep account identities and the active marker without secondary descriptions or blank rows.
    const rows = ["add", "existing:fixture", "named"].map((id) => app.get(`accounts-row:${id}`));
    expect(rows.map((row) => row.height)).toEqual([1, 1, 1]);
    expect(rows.map((row) => row.y - rows[0]!.y)).toEqual([0, 1, 2]);

    const frame = app.captureCharFrame();
    expect(frame).toContain("Fixture · Existing login");
    expect(frame).toContain("Fixture · Personal [Active]");
    expect(frame).not.toContain("Sign in to another account");
    expect(frame).not.toContain("already connected");
    expect(frame).not.toContain("worktree(s)");
  } finally {
    await app.close();
  }
});

test("Delete confirmation uses single-line options and retains affected worktree guidance", async () => {
  // Deletion must still explain affected worktrees after secondary option descriptions are removed.
  const calls: AccountRequest[] = [];
  const app = await mount({
    onAccountsRequest: async (request) => {
      calls.push(request);

      return ok({
        kind: "catalog",
        catalog: {
          ...catalog,
          worktreeId: request.worktreeId,
          accounts: [{ ...catalog.accounts[0]!, usedBy: ["other:main"] }],
        },
      });
    },
  });
  try {
    await app.open();
    app.mockInput.pressKey("j");
    app.mockInput.pressKey("x");
    await app.render();

    // Both options occupy one row while the meaningful deletion warning remains in the body.
    const keep = app.get("accounts-row:cancel");
    const remove = app.get("accounts-row:delete");
    expect([keep.height, remove.height]).toEqual([1, 1]);
    expect(remove.y).toBe(keep.y + 1);

    const frame = app.captureCharFrame();
    expect(frame).toContain("Keep account");
    expect(frame).toContain("Used by these worktrees:");
    expect(frame).toContain("other:main");
    expect(frame).not.toContain("Switch any worktrees using this account");

    // The compact viewport reveals the destructive choice through navigation without accepting it.
    app.mockInput.pressKey("n", { ctrl: true });
    await app.render();
    expect(app.captureCharFrame()).toContain("Delete local account");
    app.mockInput.pressKey("p", { ctrl: true });
    await app.render();
    expect(app.captureCharFrame()).toContain("Keep account");
    expect(calls.map((request) => request.type)).toEqual(["list"]);
  } finally {
    await app.close();
  }
});

test("No connected accounts shows an add-account hint instead of a fake selection", async () => {
  // Start with supported providers but no saved credentials.
  const app = await mount({
    onAccountsRequest: async (request) =>
      ok({
        kind: "catalog",
        catalog: { ...catalog, accounts: [], worktreeId: request.worktreeId },
      }),
  });
  try {
    await app.open();

    // Never mark an unauthenticated provider as the active account.
    const frame = app.captureCharFrame();
    expect(frame).toContain("No connected accounts");
    expect(frame).toContain("+ Add account");
    expect(frame).not.toContain("Fixture");
    expect(frame).not.toContain("[Selected]");
    expect(frame).not.toContain("[Active]");
    app.mockInput.pressEnter();
    await app.render();
    expect(app.captureCharFrame()).toContain("Fixture");
  } finally {
    await app.close();
  }
});

test.each(["oauth", "api_key"] as const)(
  "Existing verified %s authentication is switchable without Pi terminology",
  async (type) => {
    // Saved accounts and verified external credentials are switch targets for the same provider.
    const connected: AccountsCatalog = {
      ...structuredClone(catalog),
      selections: { fixture: "named" },
      existingAccounts: [{ provider: "fixture", name: "Fixture", type }],
    };
    const calls: AccountRequest[] = [];
    const app = await mount({
      onAccountsRequest: async (request) => {
        calls.push(request);
        if (request.type === "select" && request.accountId === null) {
          delete connected.selections[request.provider];
        }

        return ok({ kind: "catalog", catalog: { ...connected, worktreeId: request.worktreeId } });
      },
    });
    try {
      await app.open();
      expect(app.captureCharFrame()).toContain("Personal [Active]");

      // Search for and switch to an existing verified account.
      app.mockInput.pressKey("/");
      await app.render();
      await app.mockInput.typeText(type === "oauth" ? "Existing login" : "Existing API key");
      await app.render();
      app.mockInput.pressEnter();
      await app.render();

      // Switch authentication without adding an account; show only the active account.
      expect(calls.find((request) => request.type === "select")).toMatchObject({
        provider: "fixture",
        accountId: null,
        worktreeId: app.selection.worktree!.id,
      });

      const frame = app.captureCharFrame();
      expect(frame).toContain(
        `${type === "oauth" ? "Existing login" : "Existing API key"} [Active]`,
      );
      expect(frame).not.toContain("Personal [Active]");
      expect(frame).not.toContain("Pi default");
      expect(app.sent).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test.each(["oauth", "api_key", "named"] as const)(
  "The rename command labels %s accounts without switching authentication",
  async (target) => {
    // Both externally connected and saved accounts expose the same context-local rename action.
    const connected: AccountsCatalog = {
      ...structuredClone(catalog),
      selections: target === "named" ? { fixture: "named" } : {},
      existingAccounts: [
        { provider: "fixture", name: "Fixture", type: target === "oauth" ? "oauth" : "api_key" },
      ],
    };
    const calls: AccountRequest[] = [];
    const app = await mount({
      onAccountsRequest: async (request) => {
        calls.push(request);
        if (request.type === "rename") {
          if (request.accountId === null) {
            connected.existingAccounts![0]!.label = request.label;
          } else {
            connected.accounts[0]!.label = request.label;
          }

          connected.revision++;
        }

        return ok({ kind: "catalog", catalog: { ...connected, worktreeId: request.worktreeId } });
      },
    });
    try {
      await app.open();
      expect(app.captureCharFrame()).not.toContain("Rename account");
      app.mockInput.pressKey("n", { ctrl: true });
      if (target === "named") {
        app.mockInput.pressKey("j");
      }

      await app.render();
      expect(app.captureCharFrame()).toContain("r Rename account");

      // Enter a label through native editing; only Enter accepts the change.
      app.mockInput.pressKey("r");
      await app.render();

      const input = app.get("accounts-input") as InputRenderable;
      expect(app.renderer.currentFocusedRenderable).toBe(input);
      expect(input.value).toBe(
        target === "named"
          ? "Personal"
          : target === "oauth"
            ? "Existing login"
            : "Existing API key",
      );
      app.mockInput.pressKey("u", { ctrl: true });
      await app.mockInput.typeText("ONEABLE");
      await app.render();
      expect(calls.some((request) => request.type === "rename")).toBe(false);
      app.mockInput.pressEnter();
      await app.render();

      // Display the accepted label without changing active markers, credentials, or conversations.
      expect(calls.find((request) => request.type === "rename")).toEqual({
        type: "rename",
        worktreeId: app.selection.worktree!.id,
        provider: "fixture",
        accountId: target === "named" ? "named" : null,
        label: "ONEABLE",
        revision: 1,
      });
      expect(app.captureCharFrame()).toContain("Fixture · ONEABLE [Active]");
      expect(calls.some((request) => request.type === "select" || request.type === "login")).toBe(
        false,
      );
      expect(app.sent).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Cancelling label edits preserves the existing account and native text entry", async () => {
  // External logins can be renamed without creating an account or starting authentication.
  const connected: AccountsCatalog = {
    ...catalog,
    existingAccounts: [{ provider: "fixture", name: "Fixture", type: "oauth" }],
  };
  const calls: AccountRequest[] = [];
  const app = await mount({
    onAccountsRequest: async (request) => {
      calls.push(request);

      return ok({ kind: "catalog", catalog: { ...connected, worktreeId: request.worktreeId } });
    },
  });
  try {
    await app.open();
    app.mockInput.pressKey("j");
    app.mockInput.pressKey("r");
    await app.render();

    // Empty labels are not submitted, and normal Vim letters remain literal in the input.
    app.mockInput.pressKey("u", { ctrl: true });
    app.mockInput.pressEnter();
    await app.render();
    expect(app.captureCharFrame()).toContain("Account label must not be blank.");
    await app.mockInput.typeText("hjklr");
    await app.render();
    expect((app.get("accounts-input") as InputRenderable).value).toBe("hjklr");
    app.mockInput.pressEscape();
    await app.render();

    // Esc discards only the unsubmitted name and returns to the account list.
    expect(app.get("accounts-picker").visible).toBe(true);
    expect(app.get("accounts-input").visible).toBe(false);
    expect(app.captureCharFrame()).toContain("Existing login [Active]");
    expect(calls.map((request) => request.type)).toEqual(["list"]);
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each(["label", "rename", "delete"] as const)(
  "Account %s prompts use compact sizing and return to the standard list",
  async (stage) => {
    // A stage change, not result count, determines whether account actions use a compact prompt.
    const app = await mount();
    try {
      await app.open();
      if (stage === "label") {
        for (let step = 0; step < 3; step++) {
          app.mockInput.pressEnter();
          await app.render();
        }
      } else {
        app.mockInput.pressKey("j");
        app.mockInput.pressKey(stage === "rename" ? "r" : "x");
        await app.render();
      }

      const input = app.get("accounts-input") as InputRenderable;
      if (stage !== "delete") {
        input.value = "unsubmitted-hjkl";
        input.cursorOffset = 4;
      }

      const focus = app.renderer.currentFocusedRenderable;

      // Compact geometry and native text ownership survive small-terminal shrink/grow cycles.
      for (const [width, height, columns, rows] of [
        [120, 30, 64, 10],
        [60, 16, 54, 10],
        [30, 10, 27, 8],
        [120, 30, 64, 10],
      ] as const) {
        app.resize(width, height);
        await app.render();

        const panel = app.get("accounts-dialog");
        expect([panel.width, panel.height]).toEqual([columns, rows]);
        expect(panel.x).toBe(Math.floor((width - columns) / 2));
        expect(panel.y).toBe(Math.floor((height - rows) / 2));
        expect(app.renderer.currentFocusedRenderable).toBe(focus);
        if (stage !== "delete") {
          expect(input.value).toBe("unsubmitted-hjkl");
          expect(input.cursorOffset).toBe(4);
        }

        expect(app.requests.map((request) => request.type)).toEqual(["list"]);
      }

      // Going back restores the standard list immediately without accepting or persisting the prompt.
      app.mockInput.pressEscape();
      await app.render();

      const panel = app.get("accounts-dialog");
      expect([panel.width, panel.height]).toEqual([100, 24]);
      expect(app.renderer.currentFocusedRenderable?.id).toBe("accounts-search");
      expect(app.get("accounts-input").visible).toBe(false);
      expect(app.requests.map((request) => request.type)).toEqual(["list"]);
      expect(app.sent).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Rename shortcuts and Help follow user overrides without changing literal search input", async () => {
  // Override the mnemonic without adding an unconfigurable widget-local shortcut.
  const keymap = expectOk(
    parseKeymap({ bindings: { "accounts.rename": [{ keys: "e", scope: "accounts" }] } }),
  );
  const app = await mount({ keymap });
  try {
    await app.open();
    app.mockInput.pressKey("j");
    await app.render();
    expect(app.captureCharFrame()).toContain("e Rename account");
    expect(app.captureCharFrame()).not.toContain("r Rename account");

    // Search owns literal characters; the remapped command applies only to the results list.
    app.mockInput.pressKey("/");
    await app.render();
    await app.mockInput.typeText("Personal");
    await app.render();
    expect((app.get("accounts-search") as InputRenderable).value).toBe("Personal");
    app.mockInput.pressKey("d", { ctrl: true });
    await app.render();
    app.mockInput.pressKey("r");
    await app.render();
    expect(app.get("accounts-input").visible).toBe(false);
    expect(keymapHelp(keymap, "accounts", () => true)).toMatch(/e\s+Rename the selected account/u);
    app.mockInput.pressKey("e");
    await app.render();

    // The configured action opens label entry, preserving the current account name.
    expect((app.get("accounts-input") as InputRenderable).value).toBe("Personal");
    expect(app.requests.map((request) => request.type)).toEqual(["list"]);
  } finally {
    await app.close();
  }
});

test("Failed label saves retain the draft for retry instead of claiming a successful rename", async () => {
  // Persistence errors leave the account name unchanged and remain visible in the edit surface.
  const calls: AccountRequest[] = [];
  const app = await mount({
    onAccountsRequest: async (request) => {
      calls.push(request);
      if (request.type === "rename") {
        return err(new StorageError("Fixture label save failed"));
      }

      return ok({ kind: "catalog", catalog: { ...catalog, worktreeId: request.worktreeId } });
    },
  });
  try {
    await app.open();
    app.mockInput.pressKey("j");
    app.mockInput.pressKey("r");
    await app.render();
    app.mockInput.pressKey("u", { ctrl: true });
    await app.mockInput.typeText("ONEABLE");
    app.mockInput.pressEnter();
    await app.render();

    // Keep the submitted draft editable; cancelling must reveal the original label.
    expect(app.captureCharFrame()).toContain("Fixture label save failed");
    expect((app.get("accounts-input") as InputRenderable).value).toBe("ONEABLE");
    app.mockInput.pressEscape();
    await app.render();
    expect(app.captureCharFrame()).toContain("Fixture · Personal");
    expect(calls.filter((request) => request.type === "rename")).toHaveLength(1);
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Incomplete connection checks show saved accounts alongside a warning", async () => {
  // Never replace failed connection checks with an unauthenticated default.
  const app = await mount({
    onAccountsRequest: async (request) =>
      ok({
        kind: "catalog",
        catalog: {
          ...catalog,
          worktreeId: request.worktreeId,
          warning: "Some existing connections could not be checked. Refresh to retry.",
        },
      }),
  });
  try {
    await app.open();

    // Keep saved accounts selectable while indicating the list is incomplete.
    const frame = app.captureCharFrame();
    expect(frame).toContain("Fixture · Personal");
    expect(frame).toContain("could not be checked");
    expect(frame).not.toContain("Existing login");
    expect(frame).not.toContain("Pi default");
  } finally {
    await app.close();
  }
});

test("The GPT icon retains its scale and colors behind the undimmed accounts popup", async () => {
  // Connect the real status line and popup, replacing only terminal image transport.
  const app = await mount({
    getSessionDetails: () => ({
      status: "complete",
      output: "Retained answer",
      error: null,
      telemetry: {
        provider: "openai-codex",
        model: "gpt-fixture",
        effort: "high",
        fast: false,
        weekly: null,
        context: { usedTokens: 74000, maxTokens: 200000 },
        usage: {
          provider: "openai",
          status: "ready",
          windows: [
            {
              id: "weekly",
              usedPercent: 73,
              periodMs: 604800000,
              resetsAt: Date.now() + 5 * 86400000,
            },
          ],
          updatedAt: Date.now(),
          errorCode: null,
        },
      },
    }),
  });
  const draw = spyOn(OptimizedBuffer.prototype, "drawImage").mockReturnValue(true);

  setRendererCapabilities(app.renderer, { kitty_graphics: true, image_protocol: "kitty" });
  Object.defineProperty(app.renderer, "resolution", {
    configurable: true,
    get: () => ({
      width: app.renderer.terminalWidth * 10,
      height: app.renderer.terminalHeight * 20,
    }),
  });
  try {
    app.resize(120, 48);
    await app.render();
    expect(draw).toHaveBeenCalled();

    const original = draw.mock.calls.at(-1)!;
    const pixels = original[0].raw().data.slice();
    const geometry = original.slice(3, 7);

    // Uncovered telemetry keeps its colors because the default modal backdrop adds no tint.
    await app.open();
    await app.render();

    const icon = app.get("usage-provider-icon");
    expect(app.captureCharFrame().split("\n")[icon.y]).not.toContain(icons.openai);
    expect(app.captureCharFrame().split("\n")[icon.y]).toContain("73% used");

    const uncovered = draw.mock.calls.at(-1)!;
    expect(uncovered.slice(3, 7)).toEqual(geometry);
    expect(uncovered[0].raw().data).toEqual(pixels);

    // Cancellation restores image presentation without changing usage or conversations.
    app.mockInput.pressEscape();
    await app.render();
    expect(draw.mock.calls.at(-1)![0].raw().data).toEqual(pixels);
    expect(app.captureCharFrame().split("\n")[icon.y]).not.toContain(icons.openai);
    expect(app.sent).toEqual([]);
  } finally {
    draw.mockRestore();
    Reflect.deleteProperty(app.renderer, "resolution");
    await app.close();
  }
});

test("Add-account lists show display names on one line and preserve authentication methods", async () => {
  // Prepare a provider with different display and request identifiers.
  const provider = {
    id: "openai-codex",
    name: "OpenAI Codex (legacy)",
    methods: [
      { id: "api_key" as const, name: "API key" },
      { id: "oauth" as const, name: "Sign in with ChatGPT" },
    ],
  };
  const calls: AccountRequest[] = [];
  const app = await mount({
    onAccountsRequest: async (request) => {
      calls.push(request);

      return ok({
        kind: "catalog",
        catalog: { ...catalog, providers: [provider], worktreeId: request.worktreeId },
      });
    },
  });
  try {
    // Preserve display names and compatibility indicators when choosing a provider.
    await app.open();
    app.mockInput.pressEnter();
    await app.render();
    expect(app.captureCharFrame()).toContain("OpenAI Codex (legacy)");
    expect(app.captureCharFrame()).not.toContain("openai-codex");
    expect(app.get("accounts-row:openai-codex").height).toBe(1);
    app.mockInput.pressEnter();
    await app.render();

    // Authentication methods also omit empty secondary rows and internal values.
    const frame = app.captureCharFrame();
    const key = app.get("accounts-row:api_key");
    const oauth = app.get("accounts-row:oauth");

    expect(frame).toContain("API key");
    expect(frame).toContain("Sign in with ChatGPT");
    expect(frame).not.toContain("api_key");
    expect(frame).not.toContain("oauth");
    expect(key.height).toBe(1);
    expect(oauth.height).toBe(1);
    expect(oauth.y).toBe(key.y + 1);

    // Compact presentation must not change provider or authentication request identifiers.
    app.mockInput.pressKey("n", { ctrl: true });
    app.mockInput.pressEnter();
    await app.render();
    app.mockInput.pressEnter();
    await app.render();
    expect(calls.find((request) => request.type === "login")).toMatchObject({
      provider: "openai-codex",
      method: "oauth",
      label: "OpenAI Codex (legacy)",
    });
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Esc steps back through account name, authentication method, and provider selection", async () => {
  // Before login starts, selections go back one step without closing the popup.
  const app = await mount();
  try {
    await app.open();
    for (let i = 0; i < 3; i++) {
      app.mockInput.pressEnter();
      await app.render();
    }

    await app.mockInput.typeText("Unsubmitted label");
    await app.render();

    // Cancelling name entry returns to the current provider's authentication methods.
    app.mockInput.pressEscape();
    await app.render();
    expect(app.captureCharFrame()).toContain("Sign-in methods");
    expect(app.captureCharFrame()).not.toContain("Choose how to sign in");
    expect(app.captureCharFrame()).toContain("API key");
    expect(app.get("accounts-input").visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("accounts-search");

    // Going back from methods returns to providers, not the initial account list.
    app.mockInput.pressEscape();
    await app.render();
    expect(app.captureCharFrame()).toContain("Providers");
    expect(app.captureCharFrame()).not.toContain("Choose a service to sign in.");
    expect(app.captureCharFrame()).toContain("Fixture");
    expect(app.captureCharFrame()).not.toContain("Personal");
    expect(app.get("accounts-picker").visible).toBe(true);
    app.mockInput.pressEscape();
    await app.render();
    expect(app.captureCharFrame()).toContain("Fixture · Personal");

    // Only the initial screen closes; cancelled names never initiate login.
    app.mockInput.pressEscape();
    await app.render();
    expect(app.get("accounts-picker").visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    expect(app.requests.some((request) => request.type === "login")).toBe(false);
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each([
  [120, 30],
  [60, 16],
])(
  "The %dx%d single-line provider list preserves search and jumps half a viewport",
  async (width, height) => {
    // Prepare scrollable provider lists for both full and compact layouts.
    const providers = Array.from({ length: 60 }, (_, index) => ({
      id: `provider-${index}`,
      name: `Service ${index}`,
      methods: catalog.providers[0]!.methods,
    }));
    const calls: AccountRequest[] = [];
    const app = await mount({
      onAccountsRequest: async (request) => {
        calls.push(request);
        return ok({
          kind: "catalog",
          catalog: { ...catalog, providers, worktreeId: request.worktreeId },
        });
      },
    });
    try {
      app.resize(width, height);
      await app.render();
      await app.open();
      app.mockInput.pressEnter();
      await app.render();
      await app.mockInput.typeText("Service");
      await app.render();

      const search = app.get("accounts-search") as InputRenderable;
      const caret = search.cursorOffset;
      const jump = Math.max(
        1,
        Math.floor((app.get("accounts-list") as ScrollBoxRenderable).viewport.height / 2),
      );

      // Move from search input to results, then continue repeated jumps and upward navigation.
      app.mockInput.pressKey("n", { ctrl: true });
      app.mockInput.pressKey("p", { ctrl: true });
      app.mockInput.pressKey("d", { ctrl: true });
      await app.render();
      expect(app.renderer.currentFocusedRenderable?.id).toBe("accounts-list");
      expect(search.value).toBe("Service");
      expect(search.cursorOffset).toBe(caret);
      app.mockInput.pressKey("d", { ctrl: true });
      app.mockInput.pressKey("u", { ctrl: true });
      app.mockInput.pressKey("j");
      app.mockInput.pressKey("k");
      app.mockInput.pressArrow("down");
      app.mockInput.pressArrow("up");
      app.mockInput.pressEnter();
      await app.render();

      // Opening methods only previews the provider; explicit activation still owns sign-in.
      expect(app.captureCharFrame()).toContain("Sign-in methods");
      expect(app.captureCharFrame()).not.toContain("Choose how to sign in");
      expect(calls.some((request) => request.type === "login")).toBe(false);
      app.mockInput.pressEnter();
      await app.render();
      app.mockInput.pressEnter();
      await app.render();
      expect(calls.find((request) => request.type === "login")).toMatchObject({
        provider: `provider-${jump}`,
        label: `Service ${jump}`,
      });
      expect(app.sent).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test.each([
  [120, 30],
  [60, 16],
])(
  "The %dx%d account list jumps half a viewport of single-line candidates",
  async (width, height) => {
    // Use more accounts than fit in one viewport to test input/results navigation.
    const many = {
      ...catalog,
      accounts: Array.from({ length: 60 }, (_, i) => ({
        ...catalog.accounts[0]!,
        id: `account-${i}`,
        label: `Account ${i}`,
      })),
    };
    const calls: AccountRequest[] = [];
    const app = await mount({
      onAccountsRequest: async (request) => {
        calls.push(request);

        return ok({ kind: "catalog", catalog: { ...many, worktreeId: request.worktreeId } });
      },
    });
    try {
      app.resize(width, height);
      await app.render();
      await app.open();
      app.mockInput.pressKey("/");
      await app.render();
      await app.mockInput.typeText("Fixture");
      await app.render();

      const search = app.get("accounts-search") as InputRenderable;
      const caret = search.cursorOffset;
      const jump = Math.max(
        1,
        Math.floor((app.get("accounts-list") as ScrollBoxRenderable).viewport.height / 2),
      );

      // Move candidates from input focus, then hand off focus with a half-page jump.
      app.mockInput.pressKey("n", { ctrl: true });
      app.mockInput.pressKey("p", { ctrl: true });
      app.mockInput.pressKey("d", { ctrl: true });
      await app.render();
      expect(app.renderer.currentFocusedRenderable?.id).toBe("accounts-list");
      expect(search.value).toBe("Fixture");
      expect(search.cursorOffset).toBe(caret);
      app.mockInput.pressKey("n", { ctrl: true });
      app.mockInput.pressKey("k");
      app.mockInput.pressEnter();
      await app.render();

      // A half-page jump selects the exact candidate implied by single-line row spacing.
      expect(calls.find((request) => request.type === "select")).toMatchObject({
        provider: "fixture",
        accountId: `account-${jump}`,
      });

      expect(app.sent).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Ctrl+C on empty account search keeps the popup open and h/j/k/l literal", async () => {
  // Clearing search and typing must not trigger account actions or app exit.
  const app = await mount();
  try {
    await app.open();
    app.mockInput.pressKey("/");
    await app.render();
    app.mockInput.pressKey("c", { ctrl: true });
    await app.mockInput.typeText("hjkl");
    await app.render();
    expect((app.get("accounts-search") as InputRenderable).value).toBe("hjkl");

    // Clear only search; Ctrl+L is not an alias.
    app.mockInput.pressKey("l", { ctrl: true });
    await app.render();
    expect((app.get("accounts-search") as InputRenderable).value).toBe("hjkl");
    app.mockInput.pressKey("c", { ctrl: true });
    await app.render();
    expect((app.get("accounts-search") as InputRenderable).value).toBe("");
    expect(app.get("accounts-picker").visible).toBe(true);
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("API key input stays masked and reaches only the SDK login request", async () => {
  // Use bounded operation responses for secret prompts and polling instead of a server.
  const calls: AccountRequest[] = [];
  const waiting = Promise.withResolvers<Result<AccountReply, ExpectedError>>();
  const flow: LoginView = {
    id: "flow",
    revision: 1,
    status: "pending",
    events: [],
    prompt: { id: "secret", type: "secret", message: "Enter API key" },
  };
  const app = await mount({
    onAccountsRequest: async (request, signal) => {
      calls.push(request);
      if (request.type === "login") {
        return ok({ kind: "login", login: structuredClone(flow) });
      }
      if (request.type === "poll") {
        signal?.addEventListener("abort", () => waiting.resolve(err(new CancelledError())), {
          once: true,
        });

        return waiting.promise;
      }
      if (request.type === "answer") {
        return ok({
          kind: "login" as const,
          login: {
            ...flow,
            status: "complete" as const,
            revision: 2,
            account: catalog.accounts[0]!,
          },
        });
      }

      return ok({ kind: "catalog", catalog: { ...catalog, worktreeId: request.worktreeId } });
    },
  });
  try {
    // Choose add, provider, and API key authentication, then accept the default label.
    await app.open();
    for (let i = 0; i < 4; i++) {
      app.mockInput.pressEnter();
      await app.render();
    }

    expect(app.renderer.currentFocusedRenderable?.id).toBe("accounts-secret");
    await app.mockInput.typeText("sk-private-key");
    await app.render();

    // Render only a mask; Enter submits solely to the login operation.
    expect(app.captureCharFrame()).not.toContain("sk-private-key");
    expect(app.captureCharFrame()).toContain("•••");
    app.mockInput.pressEnter();
    await app.render();
    expect(calls.find((request) => request.type === "answer")).toMatchObject({
      value: "sk-private-key",
      promptId: "secret",
    });
    expect(JSON.stringify(app.view.promptDrafts)).not.toContain("sk-private-key");
    expect(app.sent).toEqual([]);
    // Late polls after completion must not reopen secret input.
    waiting.resolve(ok({ kind: "login", login: flow }));
    await app.render();
    expect(app.get("accounts-secret").visible).toBe(false);
    expect(app.captureCharFrame()).not.toContain("Enter API key");
  } finally {
    waiting.resolve(err(new CancelledError()));
    await app.close();
  }
});

test("Authentication choices use single lines while descriptions remain searchable", async () => {
  // Provider-defined descriptions remain search metadata, not extra option rows.
  const calls: AccountRequest[] = [];
  const waiting = Promise.withResolvers<Result<AccountReply, ExpectedError>>();
  const flow: LoginView = {
    id: "workspace-choice",
    revision: 1,
    status: "pending",
    events: [],
    prompt: {
      id: "workspace",
      type: "select",
      message: "Choose a workspace",
      options: [
        { id: "personal", label: "Personal workspace", description: "Individual access" },
        { id: "team", label: "Team workspace", description: "Organization access" },
      ],
    },
  };
  const app = await mount({
    onAccountsRequest: async (request, signal) => {
      calls.push(request);
      if (request.type === "login" || request.type === "answer") {
        return ok({ kind: "login", login: flow });
      }
      if (request.type === "poll") {
        signal?.addEventListener("abort", () => waiting.resolve(err(new CancelledError())), {
          once: true,
        });

        return waiting.promise;
      }

      return ok({ kind: "catalog", catalog: { ...catalog, worktreeId: request.worktreeId } });
    },
  });
  try {
    await app.open();
    for (let step = 0; step < 4; step++) {
      app.mockInput.pressEnter();
      await app.render();
    }

    // Authentication choices have no secondary rows, just like account and provider choices.
    const personal = app.get("accounts-row:personal");
    const team = app.get("accounts-row:team");
    expect([personal.height, team.height]).toEqual([1, 1]);
    expect(team.y).toBe(personal.y + 1);
    expect(app.captureCharFrame()).not.toContain("Individual access");
    expect(app.captureCharFrame()).not.toContain("Organization access");

    // Searching hidden metadata still activates the provider's original option identifier.
    await app.mockInput.typeText("Organization");
    await app.render();
    expect(app.captureCharFrame()).toContain("Team workspace");
    expect(app.captureCharFrame()).not.toContain("Personal workspace");
    app.mockInput.pressEnter();
    await app.render();
    expect(calls.find((request) => request.type === "answer")).toMatchObject({
      flowId: "workspace-choice",
      promptId: "workspace",
      value: "team",
    });
    expect(app.sent).toEqual([]);
  } finally {
    waiting.resolve(err(new CancelledError()));
    await app.close();
  }
});

test("OAuth provides browser, URL, code, and cancel commands without buttons in compact layouts", async () => {
  // Provide a URL and code for failed automatic opening and manual authentication.
  const calls: AccountRequest[] = [];
  const opened: string[] = [];
  const copied: string[] = [];
  const waiting = Promise.withResolvers<Result<AccountReply, ExpectedError>>();
  const flow: LoginView = {
    id: "oauth",
    revision: 1,
    status: "pending",
    events: [{ message: "Open the URL", url: "https://example.test/device", code: "ABCD-EFGH" }],
  };
  const app = await mount({
    onOpenLoginUrl: async (url) => {
      opened.push(url);

      return err(new BrowserError("Copy the login URL and open it manually."));
    },
    onCopyTranscript: async (text) => {
      copied.push(text);

      return ok("Copied");
    },
    onAccountsRequest: async (request, signal) => {
      calls.push(request);
      if (request.type === "login") {
        return ok({ kind: "login", login: flow });
      }
      if (request.type === "poll") {
        signal?.addEventListener("abort", () => waiting.resolve(err(new CancelledError())), {
          once: true,
        });

        return waiting.promise;
      }

      return ok({ kind: "catalog", catalog: { ...catalog, worktreeId: request.worktreeId } });
    },
  });
  try {
    await app.open();
    app.mockInput.pressEnter();
    await app.render();
    app.mockInput.pressEnter();
    await app.render();
    app.mockInput.pressKey("n", { ctrl: true });
    app.mockInput.pressEnter();
    await app.render();
    app.mockInput.pressEnter();
    await app.render();

    // Keep the URL visible for manual authentication regardless of automatic opening.
    expect(opened).toEqual(["https://example.test/device"]);
    expect(app.captureCharFrame()).toContain("https://example.test/device");
    expect(app.captureCharFrame()).toContain("ABCD-EFGH");
    // Authentication uses only content and shortcuts, even in narrow layouts.
    app.resize(60, 16);
    await app.render();
    for (const id of [
      "accounts-continue",
      "accounts-cancel",
      "accounts-browser",
      "accounts-copy-url",
      "accounts-copy-code",
    ]) {
      expect(app.renderer.root.findDescendantById(id)).toBeUndefined();
    }

    expect(app.captureCharFrame()).toContain("ABCD-EFGH");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("accounts-login-details");
    app.mockInput.pressKey("y");
    await app.render();
    app.mockInput.pressKey("y", { shift: true });
    await app.render();
    app.mockInput.pressKey("o");
    await app.render();

    // Verify copy, reopen, and safe cancellation without real authentication.
    expect(copied).toEqual(["https://example.test/device", "ABCD-EFGH"]);
    expect(opened).toEqual(["https://example.test/device", "https://example.test/device"]);
    app.mockInput.pressEscape();
    await app.render();
    expect(calls.some((request) => request.type === "cancel" && request.flowId === "oauth")).toBe(
      true,
    );
    expect(app.captureCharFrame()).not.toContain("ABCD-EFGH");
    expect(app.sent).toEqual([]);
  } finally {
    waiting.resolve(err(new CancelledError()));
    await app.close();
  }
});

test("Closing before login starts cancels late operations without reopening the popup", async () => {
  // The request was already sent; cancel once its operation ID arrives.
  const waiting = Promise.withResolvers<Result<AccountReply, ExpectedError>>();
  const calls: AccountRequest[] = [];
  const app = await mount({
    onAccountsRequest: async (request) => {
      calls.push(request);
      if (request.type === "login") {
        return waiting.promise;
      }

      return ok({ kind: "catalog", catalog: { ...catalog, worktreeId: request.worktreeId } });
    },
  });
  try {
    await app.open();
    for (let i = 0; i < 4; i++) {
      app.mockInput.pressEnter();
      await app.render();
    }

    // Close before the operation ID is known, then deliver the late response.
    app.mockInput.pressEscape();
    await app.render();
    waiting.resolve(
      ok({ kind: "login", login: { id: "late-flow", revision: 1, status: "pending", events: [] } }),
    );
    await app.render();

    expect(app.get("accounts-picker").visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    expect(calls.filter((request) => request.type === "cancel")).toEqual([
      { type: "cancel", worktreeId: app.selection.worktree!.id, flowId: "late-flow" },
    ]);
  } finally {
    waiting.resolve(err(new CancelledError()));
    await app.close();
  }
});

test("Account lookup failures preserve drafts and never resend to the model", async () => {
  // Unavailability errors stop at the host UI boundary.
  const app = await mount({
    onAccountsRequest: async () => err(new InputError("Fixture failure")),
  });
  try {
    await app.open();
    expect(app.captureCharFrame()).toContain("Fixture failure");
    expect(app.sent).toEqual([]);
    app.mockInput.pressEscape();
    await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
  } finally {
    await app.close();
  }
});
