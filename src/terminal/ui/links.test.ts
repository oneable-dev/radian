import { expect, test } from "bun:test";
import { EditBufferRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Terminal } from "@xterm/headless";
import { Workbench } from "../../app/ui/workbench.ts";
import { WorkspaceSelection } from "../../app/workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { BrowserError, type ExpectedError } from "../../errors.ts";
import { err, ok, type Result } from "../../result.ts";
import { parseKeymap, type Keymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";
import { pressLeader } from "../../testing/keys.ts";
import { terminalLinks } from "../../runtime/pty/links.ts";
import { terminalScreen } from "../../runtime/pty/screen.ts";
import { terminalText } from "../../runtime/pty/text.ts";
import type { PtyFrame, TerminalLink } from "../../runtime/protocol.ts";

async function mount(output: string, keymap?: Keymap) {
  const app = await createTestRenderer({
    width: 80,
    height: 24,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const screen = new Terminal({ cols: 80, rows: 24, scrollback: 100, allowProposedApi: true });
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
    opened: string[] = [];
  const boundary = {
    open: async (url: string): Promise<Result<void, ExpectedError>> => {
      opened.push(url);
      return ok(undefined);
    },
  };
  let receive: ((frame: PtyFrame) => void) | undefined,
    revision = 0;
  const send = (links: TerminalLink[] = terminalLinks(screen)) =>
    receive?.({
      ...terminal,
      cols: screen.cols,
      rows: screen.rows,
      revision: revision++,
      ansi: terminalScreen(screen) + "\x1b[?1006h",
      links,
    });
  const view = new Workbench(app.renderer, new WorkspaceSelection(demoWorkspace()), {
    onNewSession() {},
    onCloseSession() {},
    initialDrafts: { a1: "retained draft" },
    ...(keymap ? { keymap } : {}),
    onOpenTerminalUrl: (url) => boundary.open(url),
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
          input: (bytes) => inputs.push(Buffer.from(bytes).toString()),
          read: async () => ok(terminalText(screen)),
          resize: (cols, rows) => {
            screen.resize(cols, rows);
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
  const display = async (text: string) => {
    screen.reset();
    await new Promise<void>((resolve) => screen.write(text, resolve));
    send();
    await render();
  };
  await render();
  await render();
  await display(output);
  return {
    ...app,
    view,
    opened,
    inputs,
    boundary,
    screen,
    send,
    render,
    display,
    position(label: string) {
      const lines = app.captureCharFrame().split("\n"),
        y = lines.findIndex((line) => line.includes(label));
      if (y < 0) throw new Error(`Missing ${label}\n${app.captureCharFrame()}`);
      return { x: Bun.stringWidth(lines[y]!.slice(0, lines[y]!.indexOf(label))), y };
    },
    async read(at: string) {
      pressLeader(app, "[");
      await render();
      const reader = app.renderer.currentFocusedRenderable;
      if (!(reader instanceof EditBufferRenderable)) throw new Error("Missing terminal reader");
      const offset = reader.plainText.indexOf(at);
      if (offset < 0) throw new Error(`Missing ${at}`);
      reader.cursorOffset = reader.editBuffer.measureText(reader.plainText.slice(0, offset));
      await render();
      return reader;
    },
    async gx() {
      app.mockInput.pressKey("g");
      app.mockInput.pressKey("x");
      await render();
    },
    async close() {
      view.dispose();
      screen.dispose();
      await app.dispose();
    },
  };
}
const control = { modifiers: { ctrl: true } };

test("Ctrl-click opens terminal URLs after Unicode without sending shell input", async () => {
  // The attached UI uses real runtime cell mapping and a fake browser boundary only.
  const app = await mount("한글 é http://localhost:3000/path_(part).");
  try {
    const { x, y } = app.position("http://");

    // Only the explicitly modified left click activates the URL.
    await app.mockMouse.click(x + 3, y, 0, control);
    await app.waitFor(() => app.opened.length === 1);

    // Sentence punctuation is excluded and unrelated Agent drafts stay untouched.
    expect(app.opened).toEqual(["http://localhost:3000/path_(part)"]);
    expect(app.inputs).toEqual([]);
    expect(app.view.promptDrafts.a1).toBe("retained draft");
  } finally {
    await app.close();
  }
});

test("Plain clicks, right clicks, Ctrl-drags and URL margins never open browsers", async () => {
  // Link activation must not replace ordinary mouse selection or nearby blank cells.
  const app = await mount("https://example.invalid");
  try {
    const { x, y } = app.position("https://");

    await app.mockMouse.click(x + 2, y);
    await app.mockMouse.click(x + 2, y, 2, control);
    await app.mockMouse.drag(x + 1, y, x + 8, y, 0, control);
    await app.mockMouse.click(x + 25, y, 0, control);
    await app.render();

    // No incidental mouse gesture is treated as an explicit browser request.
    expect(app.opened).toEqual([]);
    expect(app.inputs).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Ordinary terminal dragging still selects output without opening links", async () => {
  // The browser gesture must not replace unmodified mouse text selection.
  const app = await mount("https://example.invalid");
  try {
    const { x, y } = app.position("https://");

    await app.mockMouse.drag(x + 8, y, x + 15, y);
    await app.render();

    // Existing selection remains usable for copying, with no browser or shell action.
    expect(app.renderer.getSelection()?.getSelectedText()).toContain("example");
    expect(app.opened).toEqual([]);
    expect(app.inputs).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each(["click", "drag"] as const)(
  "Ctrl-click opens links after an ordinary %s creates a native selection",
  async (gesture) => {
    // OpenTUI normally consumes Ctrl-down for both empty and nonempty existing selections.
    const app = await mount("https://example.invalid");
    try {
      const { x, y } = app.position("https://");
      if (gesture === "drag") await app.mockMouse.drag(x + 8, y, x + 15, y);
      else await app.mockMouse.click(x + 2, y);

      await app.mockMouse.click(x + 3, y, 0, control);
      await app.waitFor(() => app.opened.length === 1);

      // An existing toolkit selection must not steal explicit browser activation.
      expect(app.opened).toEqual(["https://example.invalid"]);
      expect(app.inputs).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test.each(["javascript:alert(1)", "file:///tmp/private", "data:text/html,unsafe"])(
  "Terminal link metadata cannot open unsafe target %s",
  async (url) => {
    // Even a received link target must pass host-side browser validation.
    const app = await mount("https://label.invalid");
    try {
      app.send([{ url, cells: [{ row: 0, start: 0, end: 21 }] }]);
      await app.render();
      const { x, y } = app.position("https://");

      await app.mockMouse.click(x + 2, y, 0, control);
      await app.waitForFrame((frame) => frame.includes("Only HTTP(S)"));

      // Unsafe schemes never reach the operating-system opener or the embedded shell.
      expect(app.opened).toEqual([]);
      expect(app.inputs).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Native mouse reporting remains intact except for complete Ctrl-link gestures", async () => {
  // Full-screen programs can own mouse input, including modified non-link clicks.
  const app = await mount("\x1b[?1000hhttps://example.invalid");
  try {
    const { x, y } = app.position("https://");

    await app.mockMouse.click(x + 2, y, 0, control);
    await app.waitFor(() => app.opened.length === 1);
    expect(app.inputs).toEqual([]);
    await app.mockMouse.click(x + 25, y, 0, control);
    await app.mockMouse.click(x + 2, y);

    // Ordinary press/release pairs still reach the PTY using its SGR mouse mode.
    expect(app.inputs).toHaveLength(4);
    expect(app.inputs[0]).toStartWith("\x1b[<16;");
    expect(app.inputs[1]).toEndWith("m");
    expect(app.inputs[2]).toStartWith("\x1b[<0;");
    expect(app.inputs[3]).toEndWith("m");
    expect(app.opened).toEqual(["https://example.invalid"]);
  } finally {
    await app.close();
  }
});

test.each(["fresh", "selected"] as const)(
  "Output changing during a %s Ctrl-click cancels stale link activation",
  async (state) => {
    // Running jobs may replace a URL between mouse press and release, including selection-extension clicks.
    const app = await mount("https://old.invalid");
    try {
      const { x, y } = app.position("https://");
      if (state === "selected") await app.mockMouse.drag(x + 8, y, x + 12, y);

      await app.mockMouse.pressDown(x + 2, y, 0, control);
      await app.display("https://new.invalid");
      await app.mockMouse.release(x + 2, y, 0, control);
      await app.render();

      // Neither old nor new content was explicitly accepted as a full click.
      expect(app.opened).toEqual([]);
      expect(app.inputs).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Ctrl-click on wrapped continuation rows opens complete URLs", async () => {
  // The address spans multiple physical rows but remains one logical target.
  const url = "https://example.invalid/" + "segment/".repeat(15) + "target";
  const app = await mount(url);
  try {
    const { x, y } = app.position("target");

    await app.mockMouse.click(x + 2, y, 0, control);
    await app.waitFor(() => app.opened.length === 1);

    // Do not open only the visible continuation fragment.
    expect(app.opened).toEqual([url]);
    expect(app.inputs).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Terminal gx preserves Visual selections and stays literal in ordinary shell input", async () => {
  // Reading uses a frozen snapshot while native terminal input remains nonmodal.
  const app = await mount("한글 é https://example.invalid");
  try {
    await app.gx();
    expect(app.inputs.join("")).toBe("gx");
    app.inputs.length = 0;
    const reader = await app.read("https://");
    app.mockInput.pressKey("v");
    app.mockInput.pressKey("l");
    const selection = reader.getSelectedText(),
      cursor = reader.cursorOffset;

    await app.gx();
    await app.waitFor(() => app.opened.length === 1);

    // Opening a browser does not change reading state or submit text to the shell.
    expect(app.opened).toEqual(["https://example.invalid"]);
    expect(app.inputs).toEqual([]);
    expect(reader.getSelectedText()).toBe(selection);
    expect(reader.cursorOffset).toBe(cursor);
    expect(app.captureCharFrame()).toContain("VISUAL · frozen output");
  } finally {
    await app.close();
  }
});

test("Ctrl-click also opens links in frozen terminal output", async () => {
  // A frozen reading buffer remains interactive even while live output changes below it.
  const app = await mount("https://example.invalid");
  try {
    await app.read("https://");
    const { x, y } = app.position("https://");
    await app.display("different live output");

    await app.mockMouse.click(x + 2, y, 0, control);
    await app.waitFor(() => app.opened.length === 1);

    // The visible snapshot supplies the target, not the hidden live terminal.
    expect(app.opened).toEqual(["https://example.invalid"]);
    expect(app.inputs).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Browser failures report errors without retrying or interrupting terminal input", async () => {
  // A missing desktop browser is an expected host failure, not a rejected shell command.
  const app = await mount("https://example.invalid");
  let attempts = 0;
  app.boundary.open = async () => {
    attempts++;
    return err(new BrowserError("No browser handler"));
  };
  try {
    const { x, y } = app.position("https://");

    await app.mockMouse.click(x + 2, y, 0, control);
    await app.waitForFrame((frame) => frame.includes("No browser handler"));
    await app.mockInput.typeText("echo");

    // Failure is visible and never causes automatic replay or shell disruption.
    expect(attempts).toBe(1);
    expect(app.opened).toEqual([]);
    expect(app.inputs.join("")).toBe("echo");
  } finally {
    await app.close();
  }
});

test("Remapped terminal link commands replace gx and update configured hints", async () => {
  // Only shared keymap commands may own reading-mode shortcuts.
  const keymap = expectOk(
    parseKeymap({
      bindings: { "terminal.copy-open-link": [{ keys: "o", scope: "terminal-copy" }] },
    }),
  );
  const app = await mount("https://example.invalid", keymap);
  try {
    app.resize(120, 24);
    await app.render();
    await app.read("https://");

    await app.gx();
    expect(app.opened).toEqual([]);
    app.mockInput.pressKey("o");
    await app.waitFor(() => app.opened.length === 1);
    await app.render();

    // User overrides are reflected in both behavior and the contextual footer.
    expect(app.captureCharFrame()).toContain("o Open link");
    expect(app.captureCharFrame()).not.toContain("gx Open link");
    expect(app.inputs).toEqual([]);
  } finally {
    await app.close();
  }
});
