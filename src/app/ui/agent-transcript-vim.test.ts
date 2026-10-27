import { expect, test } from "bun:test";
import {
  EditBufferRenderable,
  InputRenderable,
  MarkdownRenderable,
  parseKeypress,
  type Renderable,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { pressLeader, pressTranscriptRead } from "../../testing/transcript-keys.ts";
import { expectOk } from "../../testing/results.ts";
import { parseKeymap } from "../../keybindings/config.ts";
import { ok } from "../../result.ts";
import type { TranscriptSection } from "../../agents/transcript.ts";

function descendants(root: Renderable): Renderable[] {
  return root.getChildren().flatMap((child) => [child, ...descendants(child)]);
}
async function mount(
  text: string,
  actions: Partial<WorkbenchActions> = {},
  kind: TranscriptSection["kind"] = "user",
) {
  const app = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace()),
    copied: string[] = [],
    sent: string[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession: () => {},
    onCloseSession: () => {},
    initialDrafts: { a1: "Unsent draft" },
    onPrompt: (_id, text) => {
      sent.push(text);
      return ok(undefined);
    },
    onCopyTranscript: async (text) => {
      copied.push(text);
      return ok("Copied to clipboard");
    },
    getSessionDetails: () => ({
      status: "complete",
      output: "",
      error: null,
      sections: [{ id: "body", kind, title: "Message", text, status: "complete" }],
    }),
    ...actions,
  });
  const render = async () => {
    await app.renderOnce();
    await app.renderOnce();
  };
  const body = () => {
    const reader = app.renderer.currentFocusedRenderable;
    if (!(reader instanceof EditBufferRenderable)) throw new Error(`No reader: ${reader?.id}`);
    return reader;
  };
  await render();
  return {
    ...app,
    view,
    selection,
    copied,
    sent,
    render,
    body,
    async read(position = 0) {
      pressTranscriptRead(app, actions.keymap);
      app.mockInput.pressKey("HOME");
      app.mockInput.pressEnter();
      await render();
      body().cursorOffset = body().editBuffer.measureText(body().plainText.slice(0, position));
      await render();
    },
    cursor() {
      return body().getTextRange(0, body().cursorOffset).length;
    },
    async keys(keys: string) {
      for (const key of keys) {
        if (key === "\n") app.mockInput.pressEnter();
        else if (/^[A-Z]$/u.test(key)) app.mockInput.pressKey(key.toLowerCase(), { shift: true });
        else app.mockInput.pressKey(key);
      }
      await render();
    },
    search() {
      return app.renderer.root.findDescendantById("transcript-search") as InputRenderable;
    },
    state() {
      return view.workViewPreferences.agentViews?.[selection.sessionId ?? ""];
    },
    async update(value: string) {
      text = value;
      selection.replaceSnapshot(demoWorkspace());
      await render();
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test.each([
  { keys: "viw", position: 8, expected: "beta" },
  { keys: "vaw", position: 8, expected: "beta " },
  { keys: "viW", position: 3, expected: "one.two" },
  { keys: 'vi"', position: 14, expected: "hello world" },
  { keys: "vi(", position: 14, expected: "two" },
])(
  "Actual keys [$keys] select full objects from interior cursors without source edits",
  async ({ keys, position, expected }) => {
    // Render source matching the target kind through the real native reading surface.
    const text =
      keys === "viW"
        ? "one.two next"
        : keys === 'vi"'
          ? 'before "hello world" after'
          : keys === "vi("
            ? "outer (one (two) three) tail"
            : "alpha beta gamma";
    const app = await mount(text);
    try {
      await app.read(position);

      await app.keys(keys);

      expect(app.body().getSelectedText()).toBe(expected);
      expect(app.body().plainText).toBe(text);
      expect(app.copied).toEqual([]);
      expect(app.view.promptDrafts.a1).toBe("Unsent draft");
      expect(app.sent).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("yiw, yw, and y$ copy distinct ranges without moving reading cursors", async () => {
  // Operator-pending y alone must not modify the clipboard.
  const app = await mount("alpha beta gamma");
  try {
    await app.read(8);
    await app.keys("y");
    expect(app.copied).toEqual([]);
    expect(app.captureCharFrame()).toContain("TEXT · y");

    await app.keys("iw");
    await app.waitFor(() => app.copied.length === 1);
    await app.keys("yw");
    await app.waitFor(() => app.copied.length === 2);
    await app.keys("y$");
    await app.waitFor(() => app.copied.length === 3);

    expect(app.copied).toEqual(["beta", "ta ", "ta gamma"]);
    expect(app.cursor()).toBe(8);
    expect(app.state()?.mode).toBe("text");
    expect(app.body().hasSelection()).toBe(false);
  } finally {
    await app.close();
  }
});

test("yy, y3w, and 2y2w preserve counts and original newlines", async () => {
  // Literal CRLF source must not copy normalized native-buffer LF.
  const text = "one two three four five\r\nsecond line",
    app = await mount(text);
  try {
    await app.read();

    await app.keys("yy");
    await app.waitFor(() => app.copied.length === 1);
    await app.keys("y3w");
    await app.waitFor(() => app.copied.length === 2);
    await app.keys("2y2w");
    await app.waitFor(() => app.copied.length === 3);

    expect(app.copied).toEqual([
      "one two three four five\r\n",
      "one two three ",
      "one two three four ",
    ]);
    expect(app.cursor()).toBe(0);
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("3w, 5j, and 3gg honor counts and treat 0 after a digit as part of the count", async () => {
  // Standalone 0 means line start; after a digit it belongs to the count.
  const text =
      "one two three four five\n" +
      Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"),
    app = await mount(text);
  try {
    await app.read();

    await app.keys("3w");
    expect(app.cursor()).toBe(14);
    await app.keys("0");
    expect(app.cursor()).toBe(0);
    await app.keys("5j");
    expect(app.body().logicalCursor.row).toBe(5);
    await app.keys("3gg");
    expect(app.body().logicalCursor.row).toBe(2);
    await app.keys("10j");

    expect(app.body().logicalCursor.row).toBe(12);
    expect(app.copied).toEqual([]);
  } finally {
    await app.close();
  }
});

test("f character arguments override existing motion bindings and repeats follow find direction", async () => {
  // In fw, w is the target character, not a word-motion command.
  const app = await mount("one two wow");
  try {
    await app.read();

    await app.keys("fw");
    expect(app.cursor()).toBe(5);
    await app.keys(";");
    expect(app.cursor()).toBe(8);
    await app.keys(",");
    expect(app.cursor()).toBe(5);
    await app.keys("yfw");
    await app.waitFor(() => app.copied.length === 1);

    expect(app.copied).toEqual(["wo w"]);
    expect(app.cursor()).toBe(5);
  } finally {
    await app.close();
  }
});

test("Esc, invalid keys, and session switching cancel pending operators without clipboard changes", async () => {
  // Cancelled pending yanks must not turn later ordinary motions into copying.
  const app = await mount("alpha beta gamma");
  try {
    await app.read();
    await app.keys("y");
    app.mockInput.pressEscape();
    await app.render();
    expect(app.state()?.mode).toBe("text");

    await app.keys("w");
    expect(app.cursor()).toBe(6);
    await app.keys("ydw");
    expect(app.cursor()).toBe(11);
    await app.keys("y");
    pressLeader(app, "2");
    await app.render();
    await app.read();
    await app.keys("w");

    expect(app.copied).toEqual([]);
    expect(app.body().plainText).toBe("alpha beta gamma");
  } finally {
    await app.close();
  }
});

test("Search input keeps h/j/k/l and digits literal and Esc cancels without moving", async () => {
  // Search is command-line input, not body navigation or Agent prompting.
  const app = await mount("alpha beta gamma");
  try {
    await app.read(6);

    await app.keys("/");
    await app.mockInput.typeText("hjkl123");
    await app.render();
    expect(app.search().value).toBe("hjkl123");
    app.mockInput.pressEscape();
    await app.render();

    expect(app.cursor()).toBe(6);
    expect(app.state()?.mode).toBe("text");
    expect(app.view.promptDrafts.a1).toBe("Unsent draft");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Search Enter, n/N, and ? wrap bidirectionally within current sections", async () => {
  // Only Enter accepts navigation to matching positions.
  const app = await mount("one two one two one");
  try {
    await app.read();

    await app.keys("/one\n");
    expect(app.cursor()).toBe(8);
    await app.keys("n");
    expect(app.cursor()).toBe(16);
    await app.keys("N");
    expect(app.cursor()).toBe(8);
    await app.keys("?one\n");
    expect(app.cursor()).toBe(0);
    await app.keys("n");

    expect(app.cursor()).toBe(16);
    expect(app.view.promptDrafts.a1).toBe("Unsent draft");
  } finally {
    await app.close();
  }
});

test("* and # exclude partial words while y/search copies ranges without movement", async () => {
  // Star searches must not match alphaX as alpha.
  const app = await mount("alpha alphaX alpha beta");
  try {
    await app.read();

    await app.keys("*");
    expect(app.cursor()).toBe(13);
    await app.keys("#");
    expect(app.cursor()).toBe(0);
    await app.keys("y/beta\n");
    await app.waitFor(() => app.copied.length === 1);

    expect(app.copied).toEqual(["alpha alphaX alpha "]);
    expect(app.cursor()).toBe(0);
  } finally {
    await app.close();
  }
});

test("Search Ctrl+C clears only queries and empty repeats never interrupt drafts or execution", async () => {
  // Use the shared router boundary that consumes repeats even after focus changes.
  let interrupted = 0;
  const app = await mount("alpha beta", {
    onInterrupt: async () => {
      interrupted++;
      return ok(undefined);
    },
  });
  const raw = (sequence: string) => {
    const key = parseKeypress(sequence, { useKittyKeyboard: true });
    if (!key) throw new Error("Invalid key");
    app.renderer.keyInput.processParsedKey(key);
  };
  try {
    await app.read();
    await app.keys("/");
    await app.mockInput.typeText("beta");

    raw("\x1b[99;5u");
    expect(app.search().value).toBe("");
    app.mockInput.pressEscape();
    raw("\x1b[99;5:2u");
    raw("\x1b[99;5:3u");
    await app.render();

    expect(app.state()?.mode).toBe("text");
    expect(app.view.promptDrafts.a1).toBe("Unsent draft");
    expect(interrupted).toBe(0);
  } finally {
    await app.close();
  }
});

test("vip/yap select and copy paragraph/blank-line ranges while retaining Markdown", async () => {
  // Paragraph objects follow actual blank lines rather than soft wrapping.
  const app = await mount("first line\nsecond\n\nthird", {}, "assistant");
  try {
    await app.read(3);

    await app.keys("vip");
    expect(app.body().getSelectedText()).toBe("first line\nsecond\n");
    await app.keys("y");
    await app.waitFor(() => app.copied.length === 1);
    await app.keys("yap");
    await app.waitFor(() => app.copied.length === 2);

    expect(app.copied).toEqual(["first line\nsecond\n", "first line\nsecond\n\n"]);
    expect(
      descendants(app.renderer.root).some(
        (node) => node instanceof MarkdownRenderable && node.visible,
      ),
    ).toBe(true);
  } finally {
    await app.close();
  }
});

test("Search cancellation preserves original Visual selection and rendered highlighting", async () => {
  // Protect existing body selections while focus moves to search.
  const app = await mount("**alpha beta gamma**", {}, "assistant");
  try {
    await app.read(8);
    await app.keys("viw");
    const before = app.cursor();

    await app.keys("/");
    await app.mockInput.typeText("gamma");
    await app.render();
    expect(app.renderer.getSelection()?.getSelectedText()).toBe("beta");
    app.mockInput.pressEscape();
    await app.render();

    expect(app.cursor()).toBe(before);
    expect(app.body().getSelectedText()).toBe("beta");
    expect(app.state()?.mode).toBe("visual");
  } finally {
    await app.close();
  }
});

test("Streaming appends preserve pending viw/yw while body replacement cancels operators", async () => {
  // Cancelling object prefixes on every chunk would turn viw back into v+w.
  const app = await mount("alpha beta", {}, "assistant");
  try {
    await app.read(8);
    await app.keys("vi");

    await app.update("alpha beta gamma");
    await app.keys("w");
    expect(app.body().getSelectedText()).toBe("beta");
    app.mockInput.pressEscape();
    await app.render();
    app.body().cursorOffset = app.body().editBuffer.measureText("alpha be");
    await app.keys("y");
    await app.update("alpha beta gamma delta");
    await app.keys("w");
    await app.waitFor(() => app.copied.length === 1);
    await app.keys("y");
    await app.update("replacement text");
    await app.keys("w");

    expect(app.copied).toEqual(["ta "]);
    expect(app.body().plainText).toBe("replacement text");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Pastes cancel pending yanks and editing keys never modify read-only bodies", async () => {
  // Pasted data and editing commands must not become new Vim actions.
  const text = "alpha beta gamma",
    app = await mount(text);
  try {
    await app.read();
    await app.keys("y");

    await app.mockInput.pasteBracketedText("iw\nwould edit");
    await app.keys("w");
    await app.keys("iaIAoOdcxpru.");

    expect(app.copied).toEqual([]);
    expect(app.body().plainText).toBe(text);
    expect(app.sent).toEqual([]);
    app.mockInput.pressEscape();
    app.mockInput.pressEscape();
    await app.render();
    await app.mockInput.typeText("viwy");
    await app.render();
    expect(app.view.promptDrafts.a1).toBe("Unsent draftviwy");
  } finally {
    await app.close();
  }
});

test("Shift and held repeats in character arguments never become motions", async () => {
  // Kitty Shift+quote means double-quote objects; repeated w is not extra motion.
  const app = await mount('before "hello world" after');
  const raw = (sequence: string) => {
    const key = parseKeypress(sequence, { useKittyKeyboard: true });
    if (!key) throw new Error("Invalid key");
    app.renderer.keyInput.processParsedKey(key);
  };
  try {
    await app.read(12);
    await app.keys("vi");

    app.mockInput.pressKey("'", { shift: true });
    await app.render();
    expect(app.body().getSelectedText()).toBe("hello world");
    app.mockInput.pressEscape();
    await app.render();
    app.body().cursorOffset = 0;
    await app.keys("f");
    raw("\x1b[119u");
    const cursor = app.cursor();
    raw("\x1b[119;1:2u");
    raw("\x1b[119;1:3u");
    await app.render();

    expect(app.cursor()).toBe(cursor);
    expect(app.body().plainText).toBe('before "hello world" after');
  } finally {
    await app.close();
  }
});

test("User overrides apply to inner/yank/word commands while object arguments stay literal", async () => {
  // Operators and object prefixes are commands; following w is a fixed object name.
  const keymap = expectOk(
    parseKeymap({
      bindings: {
        "transcript.inner-object": [
          { keys: "u", scope: "transcript-text" },
          { keys: "u", scope: "transcript-visual" },
        ],
        "transcript.copy": [
          { keys: "c", scope: "transcript-text" },
          { keys: "c", scope: "transcript-visual" },
        ],
        "transcript.word-next": [
          { keys: "q", scope: "transcript-text" },
          { keys: "q", scope: "transcript-visual" },
        ],
      },
    }),
  );
  const app = await mount("alpha beta gamma", { keymap });
  try {
    await app.read(8);

    await app.keys("c");
    expect(app.captureCharFrame()).toContain("TEXT · c");
    await app.keys("uw");
    await app.waitFor(() => app.copied.length === 1);
    await app.keys("cq");
    await app.waitFor(() => app.copied.length === 2);

    expect(app.copied).toEqual(["beta", "ta "]);
    expect(app.cursor()).toBe(8);
  } finally {
    await app.close();
  }
});

test.each(["user", "assistant"] as const)(
  "y copies mouse-selected %s text and later motion begins a new yank operator",
  async (kind) => {
    // Native mouse selection must not start a new y operator or copy another input's selection.
    const text = "alpha beta gamma",
      app = await mount(kind === "assistant" ? `**${text}**` : text, {}, kind);
    try {
      await app.read();
      const lines = app.captureCharFrame().split("\n"),
        y = lines.findIndex((line) => line.includes("beta"));
      const x = Bun.stringWidth(lines[y]!.slice(0, lines[y]!.indexOf("beta")));

      await app.mockMouse.drag(x, y, x + 3, y);
      await app.render();
      await app.keys("y");
      await app.waitFor(() => app.copied.length === 1);
      await app.keys("w");
      await app.keys("y");
      expect(app.copied).toEqual(["beta"]);
      await app.keys("y");
      await app.waitFor(() => app.copied.length === 2);

      expect(app.copied).toEqual(["beta", text]);
      expect(app.body().plainText).toBe(text);
      expect(app.sent).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Held Ctrl+C cancelling character arguments never clears subsequently focused Agent drafts", async () => {
  // Distinguish find-argument cancellation from a fresh input-clear press.
  const app = await mount("alpha beta");
  const raw = (sequence: string) => {
    const key = parseKeypress(sequence, { useKittyKeyboard: true });
    if (!key) throw new Error("Invalid key");
    app.renderer.keyInput.processParsedKey(key);
  };
  try {
    await app.read();
    await app.keys("f");

    raw("\x1b[99;5u");
    app.mockInput.pressEscape();
    app.mockInput.pressEscape();
    await app.render();
    raw("\x1b[99;5:2u");
    raw("\x1b[99;5:3u");
    await app.render();

    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
    expect(app.view.promptDrafts.a1).toBe("Unsent draft");
    raw("\x1b[99;5u");
    await app.render();
    expect(app.view.promptDrafts.a1).toBeUndefined();
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Remapped count prefixes accept subsequent digits as literal count arguments", async () => {
  // Count commands remain configurable without forcibly intercepting default digit mappings.
  const keymap = expectOk(
    parseKeymap({ bindings: { "transcript.count": [{ keys: "q", scope: "transcript-text" }] } }),
  );
  const app = await mount("one two three four five", { keymap });
  try {
    await app.read();

    await app.keys("q3w");
    expect(app.cursor()).toBe(14);
    await app.keys("0yq2w");
    await app.waitFor(() => app.copied.length === 1);

    expect(app.copied).toEqual(["one two "]);
    expect(app.cursor()).toBe(0);
  } finally {
    await app.close();
  }
});

test("Rendered Markdown Korean, combining characters, and emoji support viw/yiw without source markers", async () => {
  // Never confuse source offsets or UTF-16 units with display-cell offsets.
  const app = await mount("**한글 é 👨‍👩‍👧‍👦**", {}, "assistant");
  try {
    await app.read(1);
    await app.keys("viw");
    expect(app.body().getSelectedText()).toBe("한글");
    app.mockInput.pressEscape();
    await app.render();
    const text = app.body().plainText,
      target = text.indexOf("👨");
    app.body().cursorOffset = app.body().editBuffer.measureText(text.slice(0, target));

    await app.keys("yiw");
    await app.waitFor(() => app.copied.length === 1);

    expect(app.copied).toEqual(["👨‍👩‍👧‍👦"]);
    expect(
      descendants(app.renderer.root).some(
        (node) => node instanceof MarkdownRenderable && node.visible,
      ),
    ).toBe(true);
    expect(app.captureCharFrame()).not.toContain("**한글");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});
