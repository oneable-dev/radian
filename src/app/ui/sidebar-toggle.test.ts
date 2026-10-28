import { openWorkspaceSearch } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { ok } from "../../result.ts";
import { parseKeymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";

async function mount(actions: Partial<WorkbenchActions> = {}) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true, clock });
  const selection = new WorkspaceSelection(demoWorkspace());
  const requests: string[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession: () => requests.push("new"),
    onCloseSession: () => requests.push("close"),
    onPrompt: () => {
      requests.push("prompt");

      return ok(undefined);
    },
    initialDrafts: { a1: "main draft" },
    getSessionDetails: () => ({
      status: "complete",
      error: null,
      output: Array.from({ length: 100 }, (_, i) => `LINE-${i}`).join("\n"),
    }),
    ...actions,
  });
  const render = async () => {
    await app.renderOnce();
    await app.renderOnce();
  };

  await render();

  const get = (id: string) => {
    const node = app.renderer.root.findDescendantById(id);
    if (!node) {
      throw new Error(`Missing ${id}`);
    }

    return node;
  };

  return {
    ...app,
    clock,
    view,
    selection,
    requests,
    get,
    render,
    leader(key: string) {
      app.mockInput.pressKey(" ", { ctrl: true });
      app.mockInput.pressKey(key);
    },
    async toggle() {
      app.mockInput.pressKey(" ", { ctrl: true });
      app.mockInput.pressKey("b");
      await render();
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test("Legacy leader b toggles only workspace popups without resizing work areas", async () => {
  // Retain legacy command IDs without creating permanent panels.
  const app = await mount();
  try {
    const pane = app.get("work-panel");
    const tree = app.get("workspace-tree");

    expect(app.get("workspace-picker").visible).toBe(false);
    expect(pane.width).toBe(120);

    await app.toggle();
    expect(app.get("workspace-picker").visible).toBe(true);
    expect(pane.width).toBe(120);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-search");
    await app.toggle();

    expect(app.get("workspace-picker").visible).toBe(false);
    expect(pane.width).toBe(120);
    expect(app.get("workspace-tree")).toBe(tree);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Popup cancellation preserves original input carets and transcript scroll", async () => {
  // Popup open/close must not recreate existing Agent renderables.
  const app = await mount();
  try {
    const prompt = app.get("session-prompt") as InputRenderable;
    const scroll = app.get("session-transcript") as ScrollBoxRenderable;

    prompt.focus();
    scroll.scrollTo(31);
    await app.render();

    const top = scroll.scrollTop;
    const cursor = prompt.cursorOffset;

    await app.toggle();
    app.mockInput.pressEscape();
    await app.render();

    expect(app.renderer.currentFocusedRenderable).toBe(prompt);
    expect(prompt.cursorOffset).toBe(cursor);
    expect(scroll.scrollTop).toBe(top);
    expect(app.view.promptDrafts.a1).toBe("main draft");
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Closed popups leave Tab traversal and reopen through the workspace toggle", async () => {
  // Verify real focus traversal excludes hidden navigation from input.
  const app = await mount();
  try {
    for (let i = 0; i < 8; i++) {
      app.mockInput.pressTab();
      await app.render();
      expect(["workspace-search", "workspace-tree"]).not.toContain(
        app.renderer.currentFocusedRenderable?.id ?? "",
      );
    }

    app.leader("b");
    await app.render();
    expect(app.get("workspace-picker").visible).toBe(true);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-search");
    app.mockInput.pressEscape();
    await app.render();
    openWorkspaceSearch(app);
    await app.render();

    expect(app.get("workspace-picker").visible).toBe(true);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-search");
  } finally {
    await app.close();
  }
});

test("While History is open, other popup commands preserve lists, scroll, and selection", async () => {
  // Prevent overlapping modals from creating invisible input owners.
  let lookups = 0;
  const app = await mount({
    onListHistory: async () => {
      lookups++;

      return ok(
        Array.from({ length: 30 }, (_, i) => ({
          id: `saved-${i}`,
          title: `Saved-${i}`,
          worktreeId: "demo:main",
          modified: "2026-10-17T00:00:00Z",
          messageCount: 1,
          openSessionId: null,
          unavailableReason: null,
        })),
      );
    },
  });
  try {
    app.leader("h");
    await app.render();

    const list = app.get("history-list") as ScrollBoxRenderable;
    list.scrollTo(20);
    await app.render();

    const top = list.scrollTop;

    app.leader("b");
    app.leader("s");
    await app.render();

    expect(app.get("workspace-picker").visible).toBe(false);
    expect(app.get("session-monitor").visible).toBe(false);
    expect(list.scrollTop).toBe(top);
    expect(lookups).toBe(1);
    expect(app.selection.sessionId).toBe("a1");
  } finally {
    await app.close();
  }
});

test("Popup toggles and reconnection never query closed History", async () => {
  // Workspace pickers have no reason to perform session-file I/O.
  let lookups = 0;
  const app = await mount({
    onListHistory: async () => {
      lookups++;

      return ok([]);
    },
  });
  try {
    await app.toggle();
    await app.toggle();
    app.view.refreshHistory();
    await app.render();

    expect(lookups).toBe(0);
    expect(app.get("history-loading").visible).toBe(false);
    app.leader("h");
    await app.render();
    expect(lookups).toBe(1);
  } finally {
    await app.close();
  }
});

test("Late History responses neither reopen closed popups nor change selection", async () => {
  // Separate asynchronous completion from user cancellation.
  const pending = Promise.withResolvers<ReturnType<typeof ok<never[]>>>();
  const app = await mount({ onListHistory: () => pending.promise });
  try {
    app.leader("h");
    await app.render();
    app.mockInput.pressEscape();
    await app.render();
    pending.resolve(ok([]));
    await app.render();

    expect(app.get("session-history").visible).toBe(false);
    expect(app.selection.sessionId).toBe("a1");
    expect(app.requests).toEqual([]);
  } finally {
    pending.resolve(ok([]));
    await app.close();
  }
});

test("Legacy sidebar.toggle overrides apply to popup toggling", async () => {
  // Route existing commands to new surfaces without breaking config files.
  const app = await mount({
    keymap: expectOk(parseKeymap({ bindings: { "sidebar.toggle": ["alt+b"] } })),
  });
  try {
    app.leader("b");
    await app.render();
    expect(app.get("workspace-picker").visible).toBe(false);

    app.mockInput.pressKey("b", { meta: true });
    await app.render();
    expect(app.get("workspace-picker").visible).toBe(true);
    app.mockInput.pressKey("b", { meta: true });
    await app.render();

    expect(app.get("workspace-picker").visible).toBe(false);
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});
