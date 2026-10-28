import { expect, test } from "bun:test";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { parseKeypress, TextAttributes, TextRenderable } from "@opentui/core";
import { Workbench } from "../../app/ui/workbench.ts";
import { WorkspaceSelection } from "../../app/workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { icons } from "../../icons.ts";
import { err, ok } from "../../result.ts";
import { PtyError } from "../../errors.ts";
import { uiTheme } from "../../ui/theme.ts";
import { parseKeymap, type Keymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";
import type { TerminalInfo, WorkViewPreferences } from "../../runtime/protocol.ts";
import type { TerminalActions } from "./panel.ts";

async function mount(initial?: WorkViewPreferences, clock?: ManualClock, keymap?: Keymap) {
  const app = await createTestRenderer({
    width: 120,
    height: 24,
    kittyKeyboard: true,
    exitOnCtrlC: false,
    ...(clock ? { clock } : {}),
  });
  const selection = new WorkspaceSelection(demoWorkspace());
  let items: TerminalInfo[] = [];
  let sequence = 0;
  const failures: ((error: unknown) => void)[] = [];
  const created: string[] = [],
    closed: string[] = [],
    inputs: string[] = [],
    detaches: string[] = [],
    commands: string[] = [];
  const actions: TerminalActions = {
    list: () => items,
    create: async (tree) => {
      const id = `shell-${++sequence}`;
      created.push(tree);
      items.push({
        id,
        worktreeId: tree,
        title: `Terminal ${sequence}`,
        pid: 100 + sequence,
        shellPid: 200 + sequence,
        exited: false,
        exitCode: null,
      });
      selection.replaceSnapshot(selection.snapshot);
      return ok(id);
    },
    close: async (id) => {
      closed.push(id);
      items = items.filter((item) => item.id !== id);
      selection.replaceSnapshot(selection.snapshot);
      return ok(undefined);
    },
    attach: async (id, receive, failed) => {
      failures.push(failed);
      let revision = 0,
        offset = 0,
        cols = 80,
        rows = 24;
      const send = () => {
        const item = items.find((item) => item.id === id)!;
        receive({
          ...item,
          cols,
          rows,
          revision: revision++,
          ansi: `\x1bcShell ${id} log ${offset}`,
          scrollback: { offset, available: 100, enabled: true },
        });
      };
      send();
      return ok({
        input: (data) => inputs.push(Buffer.from(data).toString("hex")),
        resize: (width, height) => {
          cols = width;
          rows = height;
          send();
        },
        scroll: (lines) => {
          offset = Math.max(0, Math.min(100, offset - lines));
          send();
        },
        disconnect: async () => {
          detaches.push(id);
        },
      });
    },
  };
  const view = new Workbench(app.renderer, selection, {
    onNewSession: () => {},
    onCloseSession: () => {},
    onDetach: () => commands.push("detach"),
    terminal: actions,
    ...(initial ? { initialWorkViews: initial } : {}),
    ...(keymap ? { keymap } : {}),
  });
  await app.renderOnce();
  return {
    ...app,
    selection,
    view,
    actions,
    failures,
    created,
    closed,
    inputs,
    detaches,
    commands,
    exit(id: string) {
      items = items.filter((item) => item.id !== id);
      selection.replaceSnapshot(selection.snapshot);
    },
    async showView(key: "a" | "e" | "g" | "t") {
      app.mockInput.pressKey(" ", { ctrl: true });
      app.mockInput.pressKey(key);
      await app.renderOnce();
    },
    async createTerminal() {
      app.mockInput.pressKey(" ", { ctrl: true });
      app.mockInput.pressKey("t");
      await app.renderOnce();
    },
    async click(text: string, right = false) {
      if (
        text.startsWith(icons.folder) &&
        !app.renderer.root.findDescendantById("workspace-sidebar")!.visible
      ) {
        app.mockInput.pressKey(" ", { ctrl: true });
        app.mockInput.pressKey("b");
        await app.renderOnce();
        await app.renderOnce();
      }
      const lines = app.captureCharFrame().split("\n");
      const start = right ? app.renderer.root.findDescendantById("work-panel")!.x : 0;
      const y = lines.findIndex((line) => line.indexOf(text, start) >= 0),
        x = lines[y]?.indexOf(text, start) ?? -1;
      if (x < 0) throw new Error(`Missing ${text}\n${app.captureCharFrame()}`);
      await app.mockMouse.click(x, y);
      await app.renderOnce();
    },
    async visible(text: string) {
      const deadline = Date.now() + 3000;
      while (!app.captureCharFrame().includes(text)) {
        if (Date.now() > deadline) throw new Error(`Missing ${text}\n${app.captureCharFrame()}`);
        await app.renderOnce();
        await Bun.sleep(1);
      }
    },
    leader(key: string) {
      app.mockInput.pressKey(" ", { ctrl: true });
      app.mockInput.pressKey(key);
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test("Restored Terminal screens create one default shell when none are open", async () => {
  // Runtime restart restores only the prior view and now-missing terminal selection.
  const app = await mount({
    active: { "demo:main": "terminal" },
    agentScroll: {},
    terminalSelection: { "demo:main": "stale" },
  });
  try {
    // First render completes default-shell preparation.
    await app.visible("Shell shell-1");

    // Activate one fresh shell instead of old commands or missing selections.
    expect(app.created).toEqual(["demo:main"]);
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-1");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
    expect(app.inputs).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Disconnected Terminal guidance stays centered and Enter reconnects the selected shell", async () => {
  // Keep the running shell while its attachment fails, rather than starting a replacement.
  const clock = new ManualClock();
  const app = await mount(undefined, clock);
  try {
    await app.showView("t");
    await app.visible("Shell shell-1");
    app.failures[0]!(new PtyError("PTY_UNAVAILABLE", "Attachment lost."));
    // Let the transient diagnostic toast expire so it cannot cover the compact recovery body.
    clock.advance(8000);

    // Both the recovery message and its focused action stay centered as the body resizes.
    for (const [width, height] of [
      [120, 24],
      [81, 18],
      [64, 12],
    ] as const) {
      app.resize(width, height);
      await app.renderOnce();
      await app.renderOnce();
      const viewport = app.renderer.root.findDescendantById("terminal-viewport")!;
      const lines = app.captureCharFrame().split("\n");
      const messageY = lines.findIndex((line) => line.includes("Terminal unavailable"));
      const actionY = lines.findIndex((line) => line.includes("Reconnect"));
      expect(app.captureCharFrame()).toContain("Terminal unavailable");
      expect(app.captureCharFrame()).toContain("Reconnect");
      for (const y of [messageY, actionY]) {
        expect(y).toBeGreaterThan(viewport.y);
        const text = y === messageY ? "Terminal unavailable · reconnect explicitly" : "Reconnect";
        const x = lines[y]!.indexOf(text);
        expect(
          Math.abs(x + text.length / 2 - (viewport.x + viewport.width / 2)),
        ).toBeLessThanOrEqual(1);
      }
      expect(
        Math.abs((messageY + actionY + 1) / 2 - (viewport.y + viewport.height / 2)),
      ).toBeLessThanOrEqual(1);
      expect(app.captureCharFrame()).not.toContain("Shell shell-1");
      expect(viewport.hasFocusedDescendant).toBe(true);
    }

    // The existing activation command reconnects without creating a shell or replaying input.
    app.mockInput.pressEnter();
    await app.visible("Shell shell-1");
    expect(app.created).toEqual(["demo:main"]);
    expect(app.failures).toHaveLength(2);
    expect(app.inputs).toEqual([]);
    expect(app.captureCharFrame()).not.toContain("Terminal unavailable");
    expect(app.captureCharFrame()).not.toContain("Reconnect");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
  } finally {
    await app.close();
  }
});

test("Terminal leader+c selects new tabs without sending shell control characters", async () => {
  // Request another terminal while the default shell owns input.
  const app = await mount();
  try {
    await app.showView("t");
    await app.visible("Shell shell-1");
    expect(app.captureCharFrame().trimEnd().split("\n").at(-1)).toContain("<leader>c New terminal");

    // Creation shortcuts during input prepare a second shell.
    app.leader("c");
    await app.visible("Shell shell-2");

    // New tabs own input and leader sequences reach no PTY.
    expect(app.created).toEqual(["demo:main", "demo:main"]);
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-2");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
    expect(app.inputs).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Terminal Ctrl+N/P reaches shells without creating tabs", async () => {
  // Separating creation/navigation leaves original readline keys PTY-owned.
  const app = await mount();
  try {
    await app.showView("t");
    await app.visible("Shell shell-1");

    // Press shell next/previous input keys directly.
    app.mockInput.pressKey("n", { ctrl: true });
    app.mockInput.pressKey("p", { ctrl: true });
    await app.renderOnce();

    // Forward control bytes unchanged without extra shells or creation-induced selection.
    expect(app.inputs).toContain("0e");
    expect(app.inputs).toContain("10");
    expect(app.created).toEqual(["demo:main"]);
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-1");
  } finally {
    await app.close();
  }
});

test("Snapshots and creation shortcuts during default startup never duplicate terminals", async () => {
  // Delay the first request at slow shell startup boundaries.
  const app = await mount(),
    ready = Promise.withResolvers<void>();
  const create = app.actions.create;
  let attempts = 0;
  app.actions.create = async (tree, size) => {
    attempts++;
    await ready.promise;
    return create(tree, size);
  };
  try {
    // Rerender the same view and explicitly request creation.
    await app.showView("t");
    app.selection.replaceSnapshot(app.selection.snapshot);
    app.leader("t");
    app.leader("c");
    app.mockInput.pressKey("n", { ctrl: true });
    await app.renderOnce();
    await app.renderOnce();

    // Execute only the initial request and activate its completed shell.
    expect(attempts).toBe(1);
    expect(app.renderer.root.findDescendantById("terminal-empty-state")!.visible).toBe(false);
    ready.resolve();
    await app.visible("Shell shell-1");
    expect(app.created).toEqual(["demo:main"]);
    expect(app.inputs).toEqual([]);
  } finally {
    ready.resolve();
    await app.close();
  }
});

test("Leaving and immediately returning before shell startup creates only one default shell", async () => {
  // Transitions before initial layout may leave cancelled creation requests.
  const app = await mount();
  try {
    // Reopen Terminal in the same input batch to establish the latest entry intent.
    app.leader("t");
    app.leader("g");
    app.leader("t");
    await app.visible("Shell shell-1");

    // Cancelled entries create nothing; only the final screen owns one shell.
    expect(app.created).toEqual(["demo:main"]);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
  } finally {
    await app.close();
  }
});

test.each(["before-layout", "during-startup"] as const)(
  "Search opened at %s retains query/focus through late default-shell creation",
  async (timing) => {
    // Allow search input while startup responses remain pending.
    const app = await mount(),
      ready = Promise.withResolvers<void>();
    const create = app.actions.create;
    app.actions.create = async (tree, size) => {
      await ready.promise;
      return create(tree, size);
    };
    try {
      app.leader("t");
      if (timing === "during-startup") {
        await app.renderOnce();
        await app.renderOnce();
      }

      // Enter workspace search before creation completes.
      app.leader("b");
      await app.mockInput.typeText("feature");
      await app.renderOnce();
      const focused = app.renderer.currentFocusedRenderable;
      ready.resolve();
      await app.visible("Shell shell-1");

      // Prepare tabs in background while search remains editable.
      expect(app.renderer.currentFocusedRenderable).toBe(focused);
      expect(app.captureCharFrame()).toContain("feature");
      expect(app.created).toEqual(["demo:main"]);
      expect(app.inputs).toEqual([]);
    } finally {
      ready.resolve();
      await app.close();
    }
  },
);

test("Default-shell failures never auto-retry and leader+c explicitly requests recovery", async () => {
  // Reject only the first startup with an operational error.
  const app = await mount(),
    create = app.actions.create;
  let attempts = 0;
  app.actions.create = async (tree, size) =>
    ++attempts === 1
      ? err(new PtyError("PTY_UNAVAILABLE", "Shell startup denied."))
      : create(tree, size);
  try {
    // Later snapshots and same-view selection never create new attempts.
    await app.showView("t");
    await app.visible("Shell startup denied.");
    app.selection.replaceSnapshot(app.selection.snapshot);
    app.leader("t");
    await app.renderOnce();

    // Empty views recover through shortcuts and retain only successful shells.
    expect(attempts).toBe(1);
    expect(app.created).toEqual([]);
    app.leader("c");
    await app.visible("Shell shell-1");
    expect(attempts).toBe(2);
    expect(app.created).toEqual(["demo:main"]);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
  } finally {
    await app.close();
  }
});

test.each(["disabled", "rebound"] as const)(
  "With %s creation shortcuts, default Ctrl+N reaches shells and hints reflect settings",
  async (mode) => {
    // Disable creation commands entirely or remap to other terminal keys.
    const keymap = expectOk(
      parseKeymap({
        bindings: { "tab.new": mode === "disabled" ? [] : [{ keys: "alt+n", scope: "terminal" }] },
      }),
    );
    const app = await mount(undefined, undefined, keymap);
    try {
      await app.showView("t");
      await app.visible("Shell shell-1");

      // User settings override default Ctrl+N.
      app.mockInput.pressKey("n", { ctrl: true });
      await app.renderOnce();

      // Defaults return to native input and hints show actual keys only.
      expect(app.inputs).toContain("0e");
      expect(app.created).toHaveLength(1);
      const footer = app.captureCharFrame().trimEnd().split("\n").at(-1)!;
      expect(footer).not.toContain("<C-n>");
      if (mode === "disabled") expect(footer).not.toContain("New terminal");
      else {
        expect(footer).toContain("<M-n> New terminal");
        app.mockInput.pressKey("n", { meta: true });
        await app.visible("Shell shell-2");
        expect(app.created).toHaveLength(2);
      }
    } finally {
      await app.close();
    }
  },
);

test.each(["arrows", "vim", "control"] as const)(
  "Terminal %s navigation remains native because tabs cannot take focus",
  async (navigation) => {
    // Passive tabs cannot steal native navigation from the selected shell.
    const app = await mount();
    const tab = (id: string) =>
      app.renderer.root.findDescendantById(`terminal-tab:${id}`)!.getChildren()[0]!;
    const move = (next: boolean) =>
      navigation === "arrows"
        ? app.mockInput.pressArrow(next ? "right" : "left")
        : navigation === "control"
          ? app.mockInput.pressKey(next ? "n" : "p", { ctrl: true })
          : app.mockInput.pressKey(next ? "l" : "h");
    try {
      await app.createTerminal();
      await app.visible("Shell shell-1");
      app.leader("c");
      await app.visible("Shell shell-2");
      app.leader("c");
      await app.visible("Shell shell-3");
      tab("shell-1").focus();
      await app.renderOnce();

      // Attempted tab focus leaves both directional input styles owned by the shell.
      move(true);
      move(false);
      await app.renderOnce();

      expect(tab("shell-1").focusable).toBe(false);
      expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
      expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-3");
      expect(app.inputs).toHaveLength(2);
      expect(app.created).toHaveLength(3);
      expect(app.closed).toEqual([]);
      expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).not.toContain(
        "h/l Terminal",
      );
      expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).toContain(
        "<leader>c New terminal",
      );

      // Other native editing and navigation chords also remain unmodified.
      app.mockInput.pressKey("h");
      app.mockInput.pressKey("l");
      app.mockInput.pressKey("n", { ctrl: true });
      app.mockInput.pressKey("p", { ctrl: true });
      app.mockInput.pressKey("d", { ctrl: true });
      app.mockInput.pressKey("u", { ctrl: true });
      app.mockInput.pressArrow("left");
      app.mockInput.pressArrow("right");
      expect(app.inputs).toContain("68");
      expect(app.inputs).toContain("6c");
      expect(app.inputs).toContain("0e");
      expect(app.inputs).toContain("10");
      expect(app.inputs).toContain("04");
      expect(app.inputs).toContain("15");
      expect(app.inputs.length).toBeGreaterThanOrEqual(8);
      expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-3");
    } finally {
      await app.close();
    }
  },
);

test("Terminal viewports fill work panels without upper tabs and resize never recreates shells", async () => {
  // The real native terminal is resized through the attachment boundary, not restarted.
  const app = await mount();
  try {
    await app.createTerminal();
    await app.visible("Shell shell-1");
    for (const [width, height] of [
      [120, 24],
      [60, 12],
      [79, 18],
      [80, 17],
      [120, 24],
    ] as const) {
      app.resize(width, height);
      await app.renderOnce();
      await app.renderOnce();
      const viewport = app.renderer.root.findDescendantById("terminal-viewport")!;
      const terminal = app.renderer.root.findDescendantById("shell-terminal")!;

      // Neither panel padding nor a stale VT size may leave an unused bottom row.
      const panel = app.renderer.root.findDescendantById("work-panel")!;
      expect(viewport.y).toBe(panel.y + 1); // Only the process-tab row remains.
      expect(viewport.y + viewport.height).toBe(panel.y + panel.height);
      expect(terminal.y + terminal.height).toBe(panel.y + panel.height);
      expect(terminal.height).toBe(viewport.height);
      expect(app.renderer.currentFocusedRenderable).toBe(terminal);
    }
    expect(app.created).toEqual(["demo:main"]);
    expect(app.closed).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Process-title updates never recreate terminals, focus, or tab instances", async () => {
  const clock = new ManualClock();
  const app = await mount(undefined, clock);
  let process = "zsh";
  app.actions.titles = async (items) =>
    ok(Object.fromEntries(items.map((item) => [item.id, process])));
  try {
    await app.createTerminal();
    await app.visible("zsh");
    const terminal = app.renderer.root.findDescendantById("shell-terminal")!;
    const tab = app.renderer.root.findDescendantById("terminal-tab:shell-1")!;
    const detached = app.detaches.length;
    const number = app.renderer.root.findDescendantById(
      "terminal-session:shell-1:number",
    ) as TextRenderable;
    expect(number.plainText).toBe("1.");
    process = "nvim";
    clock.advance(750);
    await app.visible("nvim");

    expect(app.renderer.root.findDescendantById("shell-terminal")).toBe(terminal);
    expect(app.renderer.root.findDescendantById("terminal-tab:shell-1")).toBe(tab);
    expect(app.renderer.currentFocusedRenderable).toBe(terminal);
    expect(app.captureCharFrame()).not.toContain("Terminal 1");
    expect(app.captureCharFrame()).not.toContain(" · running");
    expect(app.detaches).toHaveLength(detached);
    expect(number.plainText).toBe("1.");
    expect(app.closed).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Hiding terminals cancels title lookups and late responses preserve Git views", async () => {
  const clock = new ManualClock();
  const app = await mount(undefined, clock);
  const pending = Promise.withResolvers<ReturnType<typeof ok<Record<string, string>>>>();
  let signal: AbortSignal | undefined;
  app.actions.titles = async (_items, value) => {
    signal = value;
    return pending.promise;
  };
  try {
    await app.createTerminal();
    await app.visible("Shell shell-1");
    await app.showView("g");
    expect(signal?.aborted).toBe(true);
    pending.resolve(ok({ "shell-1": "late-process" }));
    await app.renderOnce();
    clock.advance(1000);
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("Git preview");
    expect(app.captureCharFrame()).not.toContain("late-process");
    expect(app.view.workViewPreferences.active["demo:main"]).toBe("git");
  } finally {
    pending.resolve(ok({}));
    await app.close();
  }
});

test("Legacy Terminal number prefixes hide while shell process names remain", async () => {
  const app = await mount();
  const create = app.actions.create;
  app.actions.create = async (tree, size) => {
    const result = await create(tree, size);
    if (result.ok)
      app.actions.list().find((item) => item.id === result.value)!.title = "Terminal 1 · zsh";
    return result;
  };
  try {
    await app.createTerminal();
    await app.visible("zsh");
    expect(app.captureCharFrame()).not.toContain("Terminal 1");
    expect(app.captureCharFrame()).not.toContain(" · running");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
  } finally {
    await app.close();
  }
});

test("Process-title failures notify explicitly while terminal connections/input survive", async () => {
  const app = await mount();
  app.actions.titles = async () =>
    err(new PtyError("PTY_UNAVAILABLE", "Process inspection denied."));
  try {
    await app.createTerminal();
    await app.visible("Shell shell-1");
    expect(app.captureCharFrame()).toContain("Process names unavailable");
    app.mockInput.pressCtrlC();
    expect(app.inputs).toContain("03");
    expect(app.closed).toEqual([]);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
  } finally {
    await app.close();
  }
});

test("Empty Terminal entry creates first shells and restores per-worktree lists/last selections", async () => {
  // Default shells are needed only on each worktree's initial entry.
  const app = await mount();
  try {
    // Create initial/additional terminals before switching worktrees.
    await app.showView("t");
    await app.visible("Shell shell-1");
    expect(app.captureCharFrame()).not.toContain("+ New");
    app.leader("c");
    await app.visible("Shell shell-2");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
    await app.click("Terminal 1", true);
    await app.visible("Shell shell-1");
    await app.click(`${icons.folder} radian-ui`);
    await app.showView("t");
    await app.visible("Shell shell-3");

    await app.click(`${icons.folder} radian`);
    await app.visible("Shell shell-1");

    // Returning reuses prior selection without new shells.
    expect(app.view.workViewPreferences.terminalSelection).toEqual({
      "demo:main": "shell-1",
      "demo:feature": "shell-3",
    });
    expect(app.created).toEqual(["demo:main", "demo:main", "demo:feature"]);
    expect(app.closed).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each(["default", "custom", "disabled"] as const)(
  "Final-terminal closure shows only %s creation keys centered in empty views",
  async (mode) => {
    // Closing defaults leaves only empty views and actually configured creation paths.
    const keymap = expectOk(
      parseKeymap(
        mode === "custom"
          ? { leader: "ctrl+b" }
          : mode === "disabled"
            ? { bindings: { "tab.new": [] } }
            : {},
      ),
    );
    const app = await mount(undefined, undefined, keymap);
    const leader = (key: string) => {
      app.mockInput.pressKey(mode === "custom" ? "b" : " ", { ctrl: true });
      app.mockInput.pressKey(key);
    };
    try {
      leader("t");
      await app.visible("Shell shell-1");
      const close = app.renderer.root.findDescendantById("close-terminal:shell-1")!;

      // Close final tabs without automatic creation.
      await app.mockMouse.click(close.x, close.y);
      await app.visible("No terminals");
      app.mockInput.pressKey("n", { ctrl: true });
      await app.renderOnce();

      // Shared empty guidance remains and Ctrl+N is not a creation alias.
      const empty = app.renderer.root.findDescendantById("terminal-empty-state")!;
      const hint = app.renderer.root.findDescendantById(
        "terminal-empty-state:hint",
      ) as TextRenderable;
      expect(empty.visible).toBe(true);
      expect(app.created).toHaveLength(1);
      expect(app.renderer.currentFocusedRenderable?.id).toBe("terminal-view");
      if (mode === "disabled") expect(hint.visible).toBe(false);
      else {
        expect(hint.plainText).toContain("<leader>c");
        expect(hint.y).toBeGreaterThan(empty.y);
        leader("c");
        await app.visible("Shell shell-2");
        expect(app.created).toHaveLength(2);
        expect(empty.visible).toBe(false);
      }
    } finally {
      await app.close();
    }
  },
);

test("Number shortcuts select current-worktree Terminal order without creating missing tabs", async () => {
  const app = await mount();
  try {
    // Missing numbers create nothing beyond initial-entry default shells.
    await app.showView("t");
    await app.visible("Shell shell-1");
    app.leader("9");
    await app.renderOnce();
    expect(app.created).toEqual(["demo:main"]);
    app.leader("c");
    await app.visible("Shell shell-2");
    const creations = [...app.created];

    app.leader("1");
    await app.visible("Shell shell-1");
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-1");
    const terminal = app.renderer.root.findDescendantById("shell-terminal");
    app.leader("1");
    await app.renderOnce();
    expect(app.renderer.root.findDescendantById("shell-terminal")).toBe(terminal);
    app.renderer.root.findDescendantById("footer-help")!.focus();
    app.leader("2");
    await app.visible("Shell shell-2");
    app.leader("9");
    await app.renderOnce();

    // Numeric selection and returning to Terminal must not leak app bytes or recreate shells.
    await app.showView("g");
    await app.showView("t");
    await app.visible("Shell shell-2");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-2");
    expect(app.created).toEqual(creations);
    expect(app.closed).toEqual([]);
    expect(app.inputs).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Closing earlier terminals renumbers tabs and numeric switching sends no PTY keys", async () => {
  // Display numbers represent current positions, not process names or internal IDs.
  const app = await mount();
  const number = (id: string) =>
    (app.renderer.root.findDescendantById(`terminal-session:${id}:number`) as TextRenderable)
      .plainText;
  try {
    await app.showView("t");
    await app.visible("Shell shell-1");
    app.leader("c");
    await app.visible("Shell shell-2");
    app.leader("c");
    await app.visible("Shell shell-3");
    expect(number("shell-1")).toBe("1.");
    expect(number("shell-2")).toBe("2.");
    expect(number("shell-3")).toBe("3.");
    const terminal = app.renderer.root.findDescendantById("shell-terminal")!;
    const tab = app.renderer.root.findDescendantById("terminal-session:shell-2")!;

    // Earlier tabs disappear while final shells keep input ownership.
    app.exit("shell-1");
    await app.renderOnce();
    await app.renderOnce();

    // Existing tabs receive new numbers and shortcuts follow identical order.
    expect(number("shell-2")).toBe("1.");
    expect(number("shell-3")).toBe("2.");
    expect(app.renderer.root.findDescendantById("terminal-session:shell-2")).toBe(tab);
    expect(app.renderer.currentFocusedRenderable).toBe(terminal);
    app.leader("1");
    await app.visible("Shell shell-2");
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-2");
    expect(app.inputs).toEqual([]);
    expect(app.created).toHaveLength(3);
  } finally {
    await app.close();
  }
});

test("Closing active subtabs selects next, previous, or empty state without final-tab recreation", async () => {
  const app = await mount();
  try {
    await app.createTerminal();
    await app.visible("Shell shell-1");
    app.leader("c");
    await app.visible("Shell shell-2");
    app.leader("c");
    await app.visible("Shell shell-3");
    await app.click("Terminal 2", true);
    await app.visible("Shell shell-2");
    app.leader("x");
    await app.visible("Shell shell-3");
    app.leader("x");
    await app.visible("Shell shell-1");
    app.leader("x");
    await app.visible("No terminals");

    expect(app.closed).toEqual(["shell-2", "shell-3", "shell-1"]);
    expect(app.created).toHaveLength(3);
    expect(app.view.workViewPreferences.active["demo:main"]).toBe("terminal");
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBeUndefined();

    // Empty final-tab views can request new shells without removed buttons.
    app.leader("c");
    await app.visible("Shell shell-4");
    expect(app.created).toHaveLength(4);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
  } finally {
    await app.close();
  }
});

test("Shell-exited tabs select neighbors and final exits leave empty views without replacements", async () => {
  // Keep current terminal input focused while servers remove exited tabs.
  const app = await mount();
  try {
    await app.createTerminal();
    await app.visible("Shell shell-1");
    app.leader("c");
    await app.visible("Shell shell-2");
    app.leader("c");
    await app.visible("Shell shell-3");
    await app.click("Terminal 2", true);

    // Middle natural exits choose next neighbors; final exits choose previous ones.
    app.exit("shell-2");
    await app.visible("Shell shell-3");
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-3");
    app.exit("shell-3");
    await app.visible("Shell shell-1");
    app.exit("shell-1");
    await app.visible("No terminals");

    expect(app.captureCharFrame()).not.toContain("Terminal 1");
    expect(app.created).toHaveLength(3);
    expect(app.closed).toEqual([]);
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBeUndefined();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("terminal-view");
    expect(app.captureCharFrame().trimEnd().split("\n").at(-1)).toContain("<leader>c New terminal");

    // Create defaults only on later empty-view reentry, never immediately on exit.
    await app.showView("a");
    await app.showView("t");
    await app.visible("Shell shell-4");
    expect(app.created).toHaveLength(4);
  } finally {
    await app.close();
  }
});

test("Ctrl+C stays native while leaders control detach, tab switching, and log scrolling", async () => {
  const app = await mount();
  try {
    await app.createTerminal();
    await app.visible("Shell shell-1");
    app.leader("c");
    await app.visible("Shell shell-2");
    app.leader("1");
    await app.visible("Shell shell-1");
    app.mockInput.pressCtrlC();
    const page = app.renderer.root.findDescendantById("shell-terminal")!.height - 1;
    app.renderer.keyInput.processParsedKey(parseKeypress("\x1b[5;2~")!);
    await app.visible(`log ${page}`);
    expect(app.inputs).toContain("03");
    expect(app.commands).toEqual([]);
    await app.mockMouse.scroll(70, 10, "up");
    await app.visible(`log ${page + 3}`);
    expect(app.captureCharFrame()).not.toContain(" · running");
    app.leader("d");
    expect(app.commands).toEqual(["detach"]);
    expect(app.closed).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Terminal tabs show only active selection through backgrounds without focus or underlines", async () => {
  // Real VT connections retain input while tab headers only reflect selection.
  const app = await mount();
  try {
    await app.createTerminal();
    await app.visible("Shell shell-1");
    app.leader("c");
    await app.visible("Shell shell-2");
    await app.renderOnce();
    const first = app.renderer.root.findDescendantById("terminal-tab:shell-1")!.getChildren()[0]!;
    const second = app.renderer.root.findDescendantById("terminal-tab:shell-2")!.getChildren()[0]!;
    const cell = (tab: typeof first) => {
      let x = 0;
      return app.captureSpans().lines[tab.y]!.spans.find((span) => {
        x += span.width;
        return x > tab.x + 1;
      })!;
    };
    const colors = uiTheme(app.renderer).colors;
    expect(cell(second).bg.toInts()).toEqual(colors.surface.toInts());
    expect(cell(second).attributes & TextAttributes.UNDERLINE).toBe(0);

    // Inactive tabs cannot acquire focus or introduce a second highlight.
    first.focus();
    await app.renderOnce();
    expect(first.focused).toBe(false);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
    expect(cell(first).bg.toInts()).toEqual(colors.panel.toInts());
    expect(cell(first).attributes & TextAttributes.UNDERLINE).toBe(0);
    expect(cell(second).bg.toInts()).toEqual(colors.surface.toInts());
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-2");

    // Clicking a tab transfers native input directly to its selected shell.
    await app.mockMouse.click(first.x, first.y);
    await app.visible("Shell shell-1");
    await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
    expect(cell(first).bg.toInts()).toEqual(colors.surface.toInts());
    expect(cell(first).attributes & TextAttributes.UNDERLINE).toBe(0);
    expect(cell(second).bg.toInts()).toEqual(colors.panel.toInts());
    expect(cell(second).attributes & TextAttributes.UNDERLINE).toBe(0);
    expect(app.created).toEqual(["demo:main", "demo:main"]);
    expect(app.closed).toEqual([]);
  } finally {
    await app.close();
  }
});

test("AI/Terminal tabs share 18-cell frames and right close positions regardless of names/status", async () => {
  // Compare AI geometry with short/long terminal names in the same work area.
  const clock = new ManualClock(),
    app = await mount(undefined, clock);
  const agent = app.renderer.root.findDescendantById("session:demo:main:a1")!;
  const agentWidth = agent.width;
  app.actions.titles = async (items) =>
    ok(
      Object.fromEntries(
        items.map((item, index) => [item.id, index === 0 ? "zsh" : "프로세스👩‍💻-very-long-name"]),
      ),
    );
  try {
    // Create differing-length terminal names and narrow the viewport.
    await app.showView("t");
    await app.visible("Shell shell-1");
    app.leader("c");
    await app.visible("Shell shell-2");
    await app.renderOnce();
    const first = app.renderer.root.findDescendantById("terminal-session:shell-1")!;
    const second = app.renderer.root.findDescendantById("terminal-session:shell-2")!;
    const title = app.renderer.root.findDescendantById(`${second.id}:title`) as TextRenderable;
    app.resize(60, 12);
    await app.renderOnce();
    await app.renderOnce();

    // Fixed boundaries/close positions match while long Unicode names truncate safely.
    expect(agentWidth).toBe(18);
    expect(first.width).toBe(agentWidth);
    expect(second.width).toBe(agentWidth);
    expect(second.x).toBe(first.x + first.width + 1);
    for (const [id, tab] of [
      ["shell-1", first],
      ["shell-2", second],
    ] as const) {
      const close = app.renderer.root.findDescendantById(`close-terminal:${id}`)!;
      expect(close.width).toBe(1);
      expect(close.x + close.width).toBe(tab.x + tab.width - 1);
    }
    expect(title.plainText).toEndWith("…");
    expect(title.plainText).not.toContain("\uFFFD");
    expect(app.created).toHaveLength(2);
    expect(app.closed).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Unselected terminal close buttons affect only their tab without changing active shell, connection, or focus", async () => {
  // Close the first shell while the second owns input.
  const app = await mount();
  try {
    await app.showView("t");
    await app.visible("Shell shell-1");
    app.leader("c");
    await app.visible("Shell shell-2");
    const terminal = app.renderer.root.findDescendantById("shell-terminal")!,
      detaches = [...app.detaches];
    const close = app.renderer.root.findDescendantById("close-terminal:shell-1")!;

    // Click inactive-tab closure directly.
    await app.mockMouse.click(close.x, close.y);
    await app.renderOnce();
    await app.renderOnce();

    // Close clicks propagate neither selection nor PTY input.
    expect(app.closed).toEqual(["shell-1"]);
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-2");
    expect(app.renderer.root.findDescendantById("terminal-tab:shell-1")).toBeUndefined();
    expect(app.renderer.root.findDescendantById("shell-terminal")).toBe(terminal);
    expect(app.renderer.currentFocusedRenderable).toBe(terminal);
    expect(app.detaches).toEqual(detaches);
    expect(app.inputs).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Rejected inactive-terminal closure notifies while preserving active input/connections", async () => {
  // Operational close failures must leave other shells editable.
  const app = await mount();
  try {
    await app.showView("t");
    await app.visible("Shell shell-1");
    app.leader("c");
    await app.visible("Shell shell-2");
    const terminal = app.renderer.root.findDescendantById("shell-terminal")!;
    const close = app.renderer.root.findDescendantById("close-terminal:shell-1")!;
    app.actions.close = async () => err(new PtyError("PTY_BUSY", "Cleanup was rejected."));

    // Request closure of first tabs rather than active shells.
    await app.mockMouse.click(close.x, close.y);
    await app.visible("Terminal could not be closed");
    app.leader("!");
    app.mockInput.pressEnter();
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("Cleanup was rejected.");
    app.mockInput.pressEscape();
    app.mockInput.pressEscape();
    await app.renderOnce();

    // Rejected tabs and active connections remain with only error notifications added.
    expect(app.renderer.root.findDescendantById("terminal-tab:shell-1")).toBeDefined();
    expect(app.renderer.root.findDescendantById("shell-terminal")).toBe(terminal);
    expect(app.renderer.currentFocusedRenderable).toBe(terminal);
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-2");
    app.mockInput.pressKey("h");
    expect(app.inputs).toContain("68");
    expect(app.closed).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Late terminal attachments after tab clicks never steal popup focus", async () => {
  // Reattaching an existing shell may finish after the user opens a popup.
  const app = await mount(),
    ready = Promise.withResolvers<void>();
  try {
    await app.showView("t");
    await app.visible("Shell shell-1");
    app.leader("c");
    await app.visible("Shell shell-2");
    const attach = app.actions.attach;
    app.actions.attach = async (...args) => {
      await ready.promise;
      return attach(...args);
    };
    const tab = app.renderer.root.findDescendantById("terminal-session:shell-1")!;

    // The click starts attachment, but subsequent workspace navigation owns focus.
    await app.mockMouse.click(tab.x, tab.y);
    app.leader("b");
    await app.renderOnce();
    const popup = app.renderer.currentFocusedRenderable;
    ready.resolve();
    await app.visible("Shell shell-1");
    await app.renderOnce();

    // Only closing the popup explicitly restores native input.
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-1");
    expect(app.renderer.currentFocusedRenderable).toBe(popup);
    expect(popup?.id).toBe("workspace-search");
    app.mockInput.pressEscape();
    await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
    expect(app.inputs).toEqual([]);
    expect(app.created).toHaveLength(2);
  } finally {
    ready.resolve();
    await app.close();
  }
});

test("Closing final terminals leaves valid empty content focus and leader+c recovers", async () => {
  // Closing the selected shell must retain input routing without a focusable tab.
  const app = await mount();
  try {
    await app.showView("t");
    await app.visible("Shell shell-1");
    const close = app.renderer.root.findDescendantById("close-terminal:shell-1")!;

    // Final closure creates no automatic replacement shells.
    await app.mockMouse.click(close.x, close.y);
    await app.visible("No terminals");

    // Retain empty state and valid focus until explicit creation shortcuts.
    expect(app.closed).toEqual(["shell-1"]);
    expect(app.created).toHaveLength(1);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("terminal-view");
    app.leader("c");
    await app.visible("Shell shell-2");
    expect(app.created).toHaveLength(2);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
  } finally {
    await app.close();
  }
});

test("Multiple subtabs and compact layouts show only selected tabs with per-tab close buttons", async () => {
  const app = await mount();
  try {
    await app.showView("t");
    await app.visible("Shell shell-1");
    for (let i = 2; i <= 6; i++) {
      app.leader("c");
      await app.visible(`Shell shell-${i}`);
    }
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("Terminal 6");
    const selectedTab = app
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text === "Terminal 6")!;
    expect(selectedTab.attributes & TextAttributes.UNDERLINE).toBe(0);
    expect(selectedTab.bg.toInts()).toEqual(uiTheme(app.renderer).colors.surface.toInts());
    app.resize(60, 12);
    await app.renderOnce();
    await app.renderOnce();
    const row = app
      .captureCharFrame()
      .split("\n")
      .find((line) => line.includes("Terminal 6"))!;
    expect(row).toContain("Terminal 6");
    expect(row).not.toContain("+ New");
    expect(row).not.toContain("Close");
    expect(row).toContain("×");
    const tab = app.renderer.root.findDescendantById("terminal-session:shell-6")!;
    const close = app.renderer.root.findDescendantById("close-terminal:shell-6")!;
    expect(tab.width).toBe(18);
    expect(close.x + close.width).toBe(tab.x + tab.width - 1);
    expect(close.x + close.width).toBeLessThanOrEqual(app.renderer.width);
  } finally {
    await app.close();
  }
});

test("Late terminal creation never steals other-worktree Git screens or selection", async () => {
  const app = await mount();
  const ready = Promise.withResolvers<ReturnType<typeof ok<string>>>();
  const create = app.actions.create;
  app.actions.create = async (tree, size) => {
    await ready.promise;
    return create(tree, size);
  };
  try {
    await app.createTerminal();
    await app.click(`${icons.folder} radian-ui`);
    await app.showView("g");
    ready.resolve(ok("ready"));
    await Bun.sleep(0);
    await app.renderOnce();

    expect(app.selection.worktree?.id).toBe("demo:feature");
    expect(app.captureCharFrame()).toContain("Git preview");
    expect(app.view.workViewPreferences.active["demo:feature"]).toBe("git");
  } finally {
    ready.resolve(ok("ready"));
    await app.close();
  }
});
