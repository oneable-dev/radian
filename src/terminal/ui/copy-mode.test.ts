import { expect, test } from "bun:test";
import { EditBufferRenderable, parseKeypress } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "../../app/ui/workbench.ts";
import { WorkspaceSelection } from "../../app/workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { ClipboardError, PtyError, type ExpectedError } from "../../errors.ts";
import { err, ok, type Result } from "../../result.ts";
import type { PtyFrame, TerminalText } from "../../runtime/protocol.ts";
import { parseKeymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";
import { pressLeader } from "../../testing/keys.ts";

async function mount(text = "alpha beta\n한글 👨‍👩‍👧‍👦 é\nlast line", custom = false) {
  const app = await createTestRenderer({
    width: 100,
    height: 24,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const selection = new WorkspaceSelection(demoWorkspace());
  const terminal = {
    id: "shell",
    worktreeId: "demo:main",
    title: "sh",
    pid: 100,
    shellPid: 101,
    exited: false,
    exitCode: null,
  };
  const inputs: string[] = [],
    copied: string[] = [],
    sizes: string[] = [];
  const boundary = {
    read: async (): Promise<Result<TerminalText, ExpectedError>> =>
      ok({ text, cursor: { row: 0, column: 0 } }),
    copy: async (text: string): Promise<Result<string, ExpectedError>> => {
      copied.push(text);
      return ok("Copied to clipboard");
    },
  };
  let receive: ((frame: PtyFrame) => void) | undefined,
    cols = 80,
    rows = 24,
    revision = 0;
  const send = (output = "LIVE SHELL") =>
    receive?.({
      ...terminal,
      cols,
      rows,
      revision: revision++,
      ansi: `\x1bc${output}`,
      scrollback: { enabled: true, offset: 0, available: 100 },
    });
  const keymap = custom
    ? expectOk(
        parseKeymap({
          leader: "ctrl+b",
          bindings: {
            "output.read": [{ keys: "<leader> r", scope: "global" }],
            "terminal.copy-right": [
              { keys: "s", scope: "terminal-copy" },
              { keys: "s", scope: "terminal-visual" },
            ],
          },
        }),
      )
    : undefined;
  const view = new Workbench(app.renderer, selection, {
    onNewSession() {},
    onCloseSession() {},
    onPrompt: () => ok(undefined),
    initialDrafts: { a1: "retained draft" },
    getSessionDetails: () => ({
      status: "complete",
      error: null,
      output: "",
      sections: [
        {
          id: "answer",
          kind: "assistant",
          title: "Agent",
          text: "Agent answer",
          status: "complete",
        },
      ],
    }),
    onCopyTranscript: (text) => boundary.copy(text),
    ...(keymap ? { keymap } : {}),
    initialWorkViews: {
      active: { "demo:main": "terminal" },
      agentScroll: {},
      terminalSelection: { "demo:main": "shell" },
    },
    terminal: {
      list: () => [terminal],
      create: async () => ok("shell"),
      close: async () => ok(undefined),
      attach: async (_id, frame) => {
        receive = frame;
        send();
        return ok({
          input: (bytes) => inputs.push(Buffer.from(bytes).toString("hex")),
          read: () => boundary.read(),
          resize: (width, height) => {
            cols = width;
            rows = height;
            sizes.push(`${cols}:${rows}`);
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
  const reader = () =>
    app.renderer.root.findDescendantById("terminal-copy")! as EditBufferRenderable;
  return {
    ...app,
    view,
    selection,
    inputs,
    copied,
    sizes,
    boundary,
    send,
    reader,
    render,
    async open() {
      if (custom) {
        app.mockInput.pressKey("b", { ctrl: true });
        app.mockInput.pressKey("r");
      } else pressLeader(app, "[");
      await render();
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test("Shared terminal reading/copying preserves shell input and PTY sizes", async () => {
  // Replace clipboard/connection boundaries only; use actual routers and Unicode editing buffers.
  const app = await mount();
  try {
    const sizes = [...app.sizes];
    await app.open();
    expect(app.sizes).toEqual(sizes);
    app.mockInput.pressKey("v");
    app.mockInput.pressKey("l");
    app.mockInput.pressKey("y");
    await app.render();

    // Entry preserves size and copies only selections; notifications reuse existing rows.
    expect(app.copied).toEqual(["al"]);
    expect(app.inputs).toEqual([]);
    expect(app.captureCharFrame()).toContain("Completed");
    expect(app.captureCharFrame()).toContain("Copied to clipboard");
    expect(app.captureCharFrame()).toContain("NORMAL · frozen output");
    app.mockInput.pressEscape();
    await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
    await app.mockInput.typeText("v");
    expect(app.inputs).toContain("76");
  } finally {
    await app.close();
  }
});

test("Agent shares navigation entry/Esc defaults while preserving drafts", async () => {
  // Shared commands read only current-screen output without changing terminal selection.
  const app = await mount();
  try {
    pressLeader(app, "a");
    await app.render();
    pressLeader(app, "[");
    await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-transcript");
    app.mockInput.pressEscape();
    await app.render();

    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
    expect(app.view.promptDrafts.a1).toBe("retained draft");
    expect(app.inputs).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each(["vim", "arrow", "control"] as const)(
  "%s navigation moves cursors and line selection copies logical newlines",
  async (navigation) => {
    // Actual wide/combined-character selection detects byte/character index confusion.
    const app = await mount();
    try {
      await app.open();
      if (navigation === "vim") app.mockInput.pressKey("j");
      else if (navigation === "arrow") app.mockInput.pressArrow("down");
      else app.mockInput.pressKey("n", { ctrl: true });
      app.mockInput.pressKey("0");
      app.mockInput.pressKey("v");
      app.mockInput.pressKey("l");
      app.mockInput.pressKey("y");
      await app.render();
      expect(app.copied).toEqual(["한글"]);
      app.mockInput.pressKey("v", { shift: true });
      app.mockInput.pressKey("y");
      await app.render();

      expect(app.copied.at(-1)).toBe("한글 👨‍👩‍👧‍👦 é\n");
      expect(app.inputs).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Streaming/resize retain selected snapshots and i returns to latest input", async () => {
  // Live output must not replace selected navigation content.
  const app = await mount();
  try {
    await app.open();
    app.mockInput.pressKey("v");
    app.mockInput.pressKey("l");
    app.send("NEW LIVE OUTPUT");
    app.resize(60, 16);
    await app.render();
    await app.mockInput.pasteBracketedText("must not edit");
    app.mockInput.pressBackspace();
    app.mockInput.pressKey("y");
    await app.render();

    expect(app.copied).toEqual(["al"]);
    expect(app.reader().plainText).toStartWith("alpha beta");
    expect(app.inputs).toEqual([]);
    app.mockInput.pressKey("i");
    await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
    expect(app.reader().visible).toBe(false);
  } finally {
    await app.close();
  }
});

test("Copy failures preserve selection and Esc clears selection before a later press returns", async () => {
  // Failed delivery must not discard selection as if successful.
  const app = await mount();
  app.boundary.copy = async () => err(new ClipboardError("Unavailable"));
  try {
    await app.open();
    app.mockInput.pressKey("v");
    app.mockInput.pressKey("l");
    app.mockInput.pressKey("y");
    await app.render();
    expect(app.reader().getSelectedText()).toBe("al");
    expect(app.captureCharFrame()).toContain("CLIPBOARD_UNAVAILABLE");
    expect(app.captureCharFrame()).toContain("Failed");
    app.mockInput.pressEscape();
    await app.render();
    expect(app.reader().focused).toBe(true);
    expect(app.reader().hasSelection()).toBe(false);
    app.mockInput.pressEscape();
    await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
    expect(app.inputs).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Esc during pending reads prevents late navigation reopening", async () => {
  // Slow responses cannot restore closed modes or steal other-screen focus.
  const app = await mount(),
    pending = Promise.withResolvers<Result<TerminalText, ExpectedError>>();
  app.boundary.read = () => pending.promise;
  try {
    await app.open();
    app.mockInput.pressEscape();
    await app.render();
    pending.resolve(ok({ text: "LATE SNAPSHOT", cursor: { row: 0, column: 0 } }));
    await app.render();

    expect(app.reader().visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
    await app.mockInput.typeText("x");
    expect(app.inputs).toContain("78");
  } finally {
    pending.resolve(ok({ text: "", cursor: { row: 0, column: 0 } }));
    await app.close();
  }
});

test("Read failures report explicitly and restore ordinary shell input", async () => {
  // Reject only copying without interrupting shells or creating replacements.
  const app = await mount();
  app.boundary.read = async () => err(new PtyError("PTY_BUSY", "Attachment changed"));
  try {
    await app.open();
    await app.mockInput.typeText("x");

    expect(app.reader().visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
    expect(app.captureCharFrame()).toContain("PTY_BUSY");
    expect(app.captureCharFrame()).toContain("Failed");
    expect(app.inputs).toContain("78");
  } finally {
    await app.close();
  }
});

test("Native Esc and Ctrl+C/T/E reach embedded programs unchanged", async () => {
  // Shells and programs own existing controls except shared entry sequences.
  const app = await mount();
  try {
    app.mockInput.pressEscape();
    app.mockInput.pressCtrlC();
    app.mockInput.pressKey("t", { ctrl: true });
    app.mockInput.pressKey("e", { ctrl: true });
    await app.render();

    expect(app.inputs).toEqual(["1b", "03", "14", "05"]);
    expect(app.reader().visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
  } finally {
    await app.close();
  }
});

test("Read failures preserve popup focus and closing resumes shell input", async () => {
  // Users can open other surfaces while asynchronous reads fail.
  const app = await mount(),
    pending = Promise.withResolvers<Result<TerminalText, ExpectedError>>();
  app.boundary.read = () => pending.promise;
  try {
    await app.open();
    pressLeader(app, "?");
    await app.render();
    const focus = app.renderer.currentFocusedRenderable;
    pending.resolve(err(new PtyError("PTY_BUSY", "Attachment changed")));
    await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(focus);
    expect(app.reader().visible).toBe(false);
    app.mockInput.pressEscape();
    await app.render();
    await app.mockInput.typeText("x");

    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
    expect(app.inputs).toContain("78");
  } finally {
    pending.resolve(err(new PtyError("PTY_BUSY", "Cancelled")));
    await app.close();
  }
});

test("Repeated Esc never replays as shell Esc after mode return", async () => {
  // Holding keys through mode changes finishes the same input as an app command.
  const app = await mount();
  const raw = (data: string) => {
    const parsed = parseKeypress(data, { useKittyKeyboard: true });
    if (!parsed) throw new Error("Invalid Kitty key");
    app.renderer.keyInput.processParsedKey(parsed);
  };
  try {
    await app.open();
    raw("\x1b[27;1u");
    raw("\x1b[27;1:2u");
    await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
    expect(app.inputs).toEqual([]);
    raw("\x1b[27;1:3u");
    raw("\x1b[27;1u");
    expect(app.inputs).toContain("1b");
  } finally {
    await app.close();
  }
});

test("Custom entry/navigation keys and help follow actual keymaps", async () => {
  // Enable only remapped commands, not hardcoded defaults.
  const app = await mount(undefined, true);
  try {
    await app.open();
    app.mockInput.pressKey("v");
    app.mockInput.pressKey("s");
    app.mockInput.pressKey("l");
    app.mockInput.pressKey("y");
    await app.render();
    expect(app.copied).toEqual(["al"]);
    app.mockInput.pressKey("b", { ctrl: true });
    app.mockInput.pressKey("?");
    await app.render();

    expect(app.captureCharFrame()).toContain("Current context: terminal-copy");
    expect(app.inputs).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Half-page and boundary motions navigate full scrollback by keyboard", async () => {
  // Output longer than viewports stays in the same reading buffer.
  const app = await mount(Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n"));
  try {
    await app.open();
    app.mockInput.pressKey("d", { ctrl: true });
    await app.render();
    expect(app.reader().logicalCursor.row).toBe(Math.max(1, Math.floor(app.reader().height / 2)));
    app.mockInput.pressKey("u", { ctrl: true });
    expect(app.reader().logicalCursor.row).toBe(0);
    app.mockInput.pressKey("g", { shift: true });
    app.mockInput.pressKey("y");
    await app.render();
    expect(app.copied).toEqual(["line 99"]);
    app.mockInput.pressKey("g");
    app.mockInput.pressKey("g");
    app.mockInput.pressKey("y");
    await app.render();

    expect(app.copied.at(-1)).toBe("line 0");
    expect(app.inputs).toEqual([]);
  } finally {
    await app.close();
  }
});
