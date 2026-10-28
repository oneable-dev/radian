import { expect, test } from "bun:test";
import { CodeRenderable, parseKeypress, type Renderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { ClipboardError, type ExpectedError } from "../../errors.ts";
import { err, ok, type Result } from "../../result.ts";
import { defaultKeymap, parseKeymap, type Keymap } from "../../keybindings/config.ts";
import { SearchInput } from "../../ui/search-input.ts";
import { expectOk } from "../../testing/results.ts";
import { pressLeader } from "../../testing/keys.ts";
import type { WorkView } from "../../runtime/protocol.ts";

const text = "copy this 한글 é 😀";

function descendants(root: Renderable): Renderable[] {
  return root.getChildren().flatMap((child) => [child, ...descendants(child)]);
}

async function mount(mode: WorkView = "agent", keymap: Keymap = defaultKeymap("linux")) {
  const app = await createTestRenderer({
    width: 100,
    height: 28,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const copied: string[] = [];
  const inputs: string[] = [];
  const prompts: string[] = [];
  const boundary = {
    copy: async (value: string): Promise<Result<string, ExpectedError>> => {
      copied.push(value);

      return ok("Copied to clipboard");
    },
  };
  const terminal = {
    id: "shell",
    worktreeId: "demo:main",
    title: "sh",
    pid: 100,
    shellPid: 101,
    exited: false,
    exitCode: null,
  };
  const view = new Workbench(app.renderer, new WorkspaceSelection(demoWorkspace()), {
    onNewSession() {},
    onCloseSession() {},
    initialDrafts: { a1: "Retain this draft" },
    keymap,
    onPrompt: (_id, value) => {
      prompts.push(value);

      return ok(undefined);
    },
    onCopyTranscript: (value) => boundary.copy(value),
    getSessionDetails: () => ({
      status: "complete",
      output: "",
      error: null,
      sections: [
        {
          id: "answer",
          kind: "assistant",
          title: "Agent",
          text: `**${text}**`,
          status: "complete",
        },
      ],
    }),
    initialWorkViews: {
      active: { "demo:main": mode },
      agentScroll: {},
      terminalSelection: { "demo:main": "shell" },
    },
    terminal: {
      list: () => [terminal],
      create: async () => ok("shell"),
      close: async () => ok(undefined),
      attach: async (_id, receive) => {
        let cols = 100;
        let rows = 28;
        let revision = 0;
        const send = () =>
          receive({ ...terminal, cols, rows, revision: revision++, ansi: `\x1bc${text}` });

        send();

        return ok({
          input: (bytes) => inputs.push(Buffer.from(bytes).toString()),
          resize: (width, height) => {
            cols = width;
            rows = height;
            send();
          },
          disconnect: async () => {},
        });
      },
    },
  });
  const render = async () => {
    await app.renderOnce();
    await app.renderOnce();
  };

  await render();
  await render();
  await Promise.all(
    descendants(app.renderer.root)
      .filter((node): node is CodeRenderable => node instanceof CodeRenderable)
      .map((node) => node.highlightingDone),
  );
  await render();

  const position = (label: string) => {
    const lines = app.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes(label));
    if (y < 0) {
      throw new Error(`Missing ${label}\n${app.captureCharFrame()}`);
    }

    return { x: Bun.stringWidth(lines[y]!.slice(0, lines[y]!.indexOf(label))), y };
  };

  return {
    ...app,
    view,
    copied,
    inputs,
    prompts,
    boundary,
    render,
    position,
    raw(value: string) {
      const key = parseKeypress(value, { useKittyKeyboard: true });
      if (!key) {
        throw new Error("Invalid keyboard event");
      }

      app.renderer.keyInput.processParsedKey(key);
    },
    async select() {
      const { x, y } = position(text);
      await app.mockMouse.drag(x, y, x + Bun.stringWidth(text) - 1, y);
      await render();
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

for (const mode of ["agent", "terminal"] as const) {
  for (const [platform, shortcut, event] of [
    ["darwin", "Cmd+C", "\x1b[99;9u"],
    ["win32", "Ctrl+C", "\x03"],
    ["linux", "Ctrl+C", "\x03"],
  ] as const) {
    test(`${platform} ${mode} drag selections copy rendered Unicode with ${shortcut} without editing or interrupting`, async () => {
      // Real native/Markdown selection is used with the target OS defaults, not a mocked process.platform.
      const app = await mount(mode, defaultKeymap(platform));
      try {
        await app.select();

        const focus = app.renderer.currentFocusedRenderable;
        const selected = app.renderer.getSelection();
        const original = selected?.getSelectedText();

        expect(original).toContain(text);
        expect(app.copied).toEqual([]);

        // Each OS exposes its conventional shortcut through the shared selection command.
        app.raw(event);
        await app.waitFor(() => app.copied.length === 1);

        // Hidden Markdown delimiters and display decorations never enter the clipboard.
        expect(app.copied).toEqual([text]);
        expect(app.inputs).toEqual([]);
        expect(app.prompts).toEqual([]);
        expect(app.view.promptDrafts.a1).toBe("Retain this draft");
        expect(app.renderer.currentFocusedRenderable).toBe(focus);
        expect(app.renderer.getSelection()).toBe(selected);
        expect(selected?.getSelectedText()).toBe(original);
      } finally {
        await app.close();
      }
    });
  }
}

test.each(["agent", "terminal"] as const)(
  "macOS %s Ctrl+C remains native even with a drag selection",
  async (mode) => {
    // Cmd+C alone owns copying on macOS; selecting text must never mask Ctrl+C interruption/clearing.
    const app = await mount(mode, defaultKeymap("darwin"));
    try {
      await app.select();
      if (mode === "agent") {
        app.renderer.root.findDescendantById("session-prompt")!.focus();
      }

      app.mockInput.pressCtrlC();
      await app.render();

      expect(app.copied).toEqual([]);
      expect(app.prompts).toEqual([]);
      if (mode === "terminal") {
        expect(app.inputs).toEqual(["\x03"]);
      } else {
        expect(app.view.promptDrafts.a1 ?? "").toBe("");
      }
    } finally {
      await app.close();
    }
  },
);

test("Windows Super+C does not copy an active drag selection", async () => {
  // The macOS copy chord is not installed as a second default on Windows.
  const app = await mount("terminal", defaultKeymap("win32"));
  try {
    await app.select();

    app.raw("\x1b[99;9u");
    await app.render();

    expect(app.copied).toEqual([]);
    expect(app.view.promptDrafts.a1).toBe("Retain this draft");
  } finally {
    await app.close();
  }
});

test.each(["agent", "terminal"] as const)(
  "Without a selection, %s Ctrl+C retains draft clearing or native interruption",
  async (mode) => {
    // An empty mouse click may leave a toolkit selection object without selected text.
    const app = await mount(mode);
    try {
      if (mode === "terminal") {
        const { x, y } = app.position(text);
        await app.mockMouse.click(x, y);
      } else {
        app.renderer.root.findDescendantById("session-prompt")!.focus();
      }

      app.mockInput.pressCtrlC();
      await app.render();

      // Copy interception must not turn ordinary input clearing/interruption into a no-op.
      expect(app.copied).toEqual([]);
      expect(app.prompts).toEqual([]);
      if (mode === "terminal") {
        expect(app.inputs).toEqual(["\x03"]);
      } else {
        expect(app.view.promptDrafts.a1 ?? "").toBe("");
      }
    } finally {
      await app.close();
    }
  },
);

test.each(["prompt", "search"] as const)(
  "Selected %s input copies instead of clearing its text",
  async (surface) => {
    // Native app text inputs participate without changing their ordinary Ctrl+C clearing policy.
    const app = await mount();
    try {
      if (surface === "search") {
        pressLeader(app, "b");
        await app.render();
        await app.mockInput.typeText("literal query");
        await app.render();
      }

      const label = surface === "prompt" ? "Retain this draft" : "literal query";
      const { x, y } = app.position(label);

      await app.mockMouse.drag(x, y, x + 5, y);
      await app.render();

      app.mockInput.pressCtrlC();
      await app.waitFor(() => app.copied.length === 1);

      expect(app.copied).toEqual([label.slice(0, 6)]);
      expect(app.view.promptDrafts.a1).toBe("Retain this draft");
      expect(app.inputs).toEqual([]);
      expect(app.prompts).toEqual([]);
      if (surface === "search") {
        const input = app.renderer.currentFocusedRenderable;
        expect(input).toBeInstanceOf(SearchInput);
        expect((input as SearchInput).value).toBe("literal query");
      }
    } finally {
      await app.close();
    }
  },
);

test("Copy failures preserve selection and drafts without falling through to a shell interrupt", async () => {
  // Clipboard rejection is an expected failure, not permission to send the key to a PTY.
  const app = await mount("terminal");
  app.boundary.copy = async () => err(new ClipboardError("Clipboard denied"));
  try {
    await app.select();

    app.mockInput.pressCtrlC();
    await app.waitForFrame((frame) => frame.includes("CLIPBOARD_UNAVAILABLE"));

    expect(app.renderer.getSelection()?.getSelectedText()).toBe(text);
    expect(app.inputs).toEqual([]);
    expect(app.view.promptDrafts.a1).toBe("Retain this draft");
    expect(app.captureCharFrame()).not.toContain("Copied to clipboard");
  } finally {
    await app.close();
  }
});

test("Held copy repeats stay consumed after selection disappears until release", async () => {
  // A user can clear a selection while the physical copy shortcut is still held.
  const app = await mount("terminal");
  try {
    await app.select();

    app.raw("\x1b[99;5u");
    app.renderer.clearSelection();
    app.raw("\x1b[99;5:2u");
    await app.waitFor(() => app.copied.length === 1);

    // Repeats cannot interrupt work, but a fresh press after release remains native.
    expect(app.inputs).toEqual([]);
    expect(app.copied).toEqual([text]);
    app.raw("\x1b[99;5:3u");
    app.mockInput.pressCtrlC();
    expect(app.inputs).toEqual(["\x03"]);
  } finally {
    await app.close();
  }
});

test("Selected terminal output does not steal native Tab or Ctrl+N navigation", async () => {
  // The selection scope overlays only explicitly configured selection commands.
  const app = await mount("terminal");
  try {
    await app.select();

    app.mockInput.pressTab();
    app.mockInput.pressKey("n", { ctrl: true });

    expect(app.inputs).toEqual(["\t", "\x0e"]);
    expect(app.copied).toEqual([]);
  } finally {
    await app.close();
  }
});

test("A selection behind workspace search does not intercept query clearing", async () => {
  // Opening a popup leaves the underlying renderables visible but no longer active.
  const app = await mount("terminal");
  try {
    await app.select();
    pressLeader(app, "b");
    await app.render();
    await app.mockInput.typeText("demo");

    app.mockInput.pressCtrlC();
    await app.render();

    expect(app.copied).toEqual([]);
    expect(app.inputs).toEqual([]);
    expect(app.renderer.root.findDescendantById("workspace-picker")!.visible).toBe(true);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-search");
    expect((app.renderer.currentFocusedRenderable as SearchInput).value).toBe("");
  } finally {
    await app.close();
  }
});

test("Hidden terminal selections do not intercept Agent draft clearing after a view switch", async () => {
  // A selection from a hidden surface must not outlive its input ownership.
  const app = await mount("terminal");
  try {
    await app.select();
    pressLeader(app, "a");
    await app.render();
    app.renderer.root.findDescendantById("session-prompt")!.focus();

    app.mockInput.pressCtrlC();
    await app.render();

    expect(app.copied).toEqual([]);
    expect(app.inputs).toEqual([]);
    expect(app.view.promptDrafts.a1 ?? "").toBe("");
  } finally {
    await app.close();
  }
});

test("Read-only dialog drag selections copy only their highlighted text", async () => {
  // Popup copying uses the same shared action rather than the whole-dialog yank command.
  const app = await mount("agent", defaultKeymap("darwin"));
  try {
    pressLeader(app, "?");
    await app.render();

    const { x, y } = app.position("Current context:");
    await app.mockMouse.drag(x, y, x + "Current".length - 1, y);
    await app.render();

    app.raw("\x1b[99;9u");
    await app.waitFor(() => app.copied.length === 1);

    expect(app.copied).toEqual(["Current"]);
    expect(app.inputs).toEqual([]);
    expect(app.renderer.root.findDescendantById("text-dialog")!.visible).toBe(true);
  } finally {
    await app.close();
  }
});

test("Selection copying accepts remapped sequences without changing ordinary terminal bindings", async () => {
  // A context-only override must support the same multi-key routing as every app command.
  const keymap = expectOk(
    parseKeymap({ bindings: { "selection.copy": [{ keys: "z z", scope: "selection" }] } }),
  );
  const app = await mount("terminal", keymap);
  try {
    await app.select();

    app.mockInput.pressCtrlC();
    app.mockInput.pressKey("z");
    app.mockInput.pressKey("z");
    await app.waitFor(() => app.copied.length === 1);

    expect(app.inputs).toEqual(["\x03"]);
    expect(app.copied).toEqual([text]);
    app.renderer.clearSelection();
    app.mockInput.pressKey("z");
    app.mockInput.pressKey("z");
    expect(app.inputs).toEqual(["\x03", "z", "z"]);
  } finally {
    await app.close();
  }
});

test("Disabling selection copying restores native Ctrl+C even while text is selected", async () => {
  // Explicit user overrides must take precedence over default selection shortcuts.
  const keymap = expectOk(parseKeymap({ bindings: { "selection.copy": [] } }));
  const app = await mount("terminal", keymap);
  try {
    await app.select();

    app.mockInput.pressCtrlC();
    await app.render();

    expect(app.copied).toEqual([]);
    expect(app.inputs).toEqual(["\x03"]);
  } finally {
    await app.close();
  }
});
