import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { PromptInput } from "./prompt-input.ts";
import type { DialogContent } from "../../ui/text-dialog.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tinyPng } from "../../testing/image.ts";
import { err, ok } from "../../result.ts";
import { ClipboardError } from "../../errors.ts";
import type { NoticeOptions } from "../../ui/messages.ts";
import type { ClipboardRepresentation } from "@opentui/core";
import type { Result } from "../../result.ts";
import type { ExpectedError } from "../../errors.ts";
import { CompletionMenu } from "./completion-menu.ts";
import { KeyRouter } from "../../keybindings/router.ts";
import { defaultKeymap } from "../../keybindings/config.ts";

async function mount(options: ConstructorParameters<typeof PromptInput>[3] = {}) {
  const app = await createTestRenderer({ width: 80, height: 10, kittyKeyboard: true });
  const notices: string[] = [],
    levels: NoticeOptions["level"][] = [],
    details: DialogContent[] = [];
  const input = new PromptInput(
    app.renderer,
    (message, options) => {
      notices.push(message);
      levels.push(options?.level);
    },
    (content) => details.push(content),
    options,
  );
  app.renderer.root.add(input.field);
  input.focus();
  await app.renderOnce();
  return {
    ...app,
    input,
    notices,
    levels,
    details,
    async close() {
      input.dispose();
      await app.dispose();
    },
  };
}

test.each(["", "/", "@"])(
  "Ctrl+V adds images with %j input while preserving existing input and focus",
  async (prefix) => {
    // Only OS clipboard contents are replaced; the real keymap, router, menu and attachment conversion stay active.
    const directory = await mkdtemp(join(tmpdir(), "radian-clipboard-keys-"));
    let reads = 0,
      paste: Promise<void> | undefined;
    const app = await mount({
      cacheRoot: directory,
      clipboard: {
        read: async () => {
          reads++;
          return ok({ mimeType: "image/png", bytes: tinyPng() });
        },
        dispose: async () => {},
      },
    });
    const menu = new CompletionMenu(
      app.renderer,
      app.input,
      () => "session",
      async () => ok({ items: [], truncated: false }),
      () => {},
    );
    app.renderer.root.add(menu.root);
    const router = new KeyRouter(
      app.renderer,
      defaultKeymap(),
      () => (menu.engaged ? "prompt-completion" : "prompt"),
      (command) => command === "agent.paste",
      (command) => {
        if (command === "agent.paste") paste = app.input.pasteClipboard();
      },
    );
    try {
      await app.mockInput.typeText(prefix);
      await app.renderOnce();
      expect(menu.open).toBe(Boolean(prefix));

      // Completion ownership must not swallow the paste shortcut while / or @ suggestions are open.
      app.mockInput.pressKey("v", { ctrl: true });
      expect(paste).toBeDefined();
      if (!paste) throw new Error("Clipboard paste shortcut was not routed");
      await paste;
      await app.renderOnce();

      // The original prefix remains, and the image is retained as private bytes rather than submitted or exposed as a path.
      expect(reads).toBe(1);
      expect(app.input.value).toBe(`${prefix}[Image #1]`);
      const path = app.input.submission.images[0]!;
      expect(path.startsWith(directory)).toBe(true);
      expect(await readFile(path)).toEqual(tinyPng());
      expect(app.input.draft.tokens).toHaveLength(1);
      expect(app.input.pending).toBe(false);
      expect(app.renderer.currentFocusedRenderable?.id).toBe(app.input.id);
      expect(app.notices).toEqual([]);
    } finally {
      router.dispose();
      menu.dispose();
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("Read-only prompts ignore keys and pastes without reading OS clipboards", async () => {
  // Preview reuses input components without read or file-creation side effects.
  let reads = 0;
  const app = await mount({
    readOnly: true,
    clipboard: {
      read: async () => {
        reads++;
        return ok({ mimeType: "image/png", bytes: tinyPng() });
      },
      dispose: async () => {},
    },
  });
  try {
    app.input.value = "Saved draft";

    // Try ordinary keys, native paste, and explicit clipboard actions.
    await app.mockInput.typeText("edit");
    app.mockInput.pressBackspace();
    app.mockInput.pressEnter();
    app.mockInput.pressKey("return", { shift: true });
    await app.mockInput.pasteBracketedText("pasted edit");
    app.input.pasteText("direct paste");
    await app.input.pasteClipboard();
    await app.renderOnce();

    // Preserve saved display values without attachments, loading, or OS reads.
    expect(app.input.value).toBe("Saved draft");
    expect(reads).toBe(0);
    expect(app.input.draft.tokens).toEqual([]);
    expect(app.input.pending).toBe(false);
    expect(app.input.activity.root.visible).toBe(false);
  } finally {
    await app.close();
  }
});

test("Clipboard images display numbers and reference private files retained in drafts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "radian-clipboard-ui-"));
  const app = await mount({
    cacheRoot: directory,
    clipboard: {
      read: async () => ok({ mimeType: "image/png", bytes: tinyPng() }),
      dispose: async () => {},
    },
  });
  try {
    await app.input.pasteClipboard();
    expect(app.input.value).toBe("[Image #1]");
    expect(app.input.pending).toBe(false);
    const path = app.input.submission.images[0]!;
    expect(path.startsWith(directory)).toBe(true);
    expect(await readFile(path)).toEqual(tinyPng());
    const saved = app.input.draft;
    app.input.value = "";
    expect(app.input.restore(saved).ok).toBe(true);
    expect(app.input.submission.images).toEqual([path]);
    expect(app.notices).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Late clipboard images never enter drafts replaced during reading", async () => {
  const gate = Promise.withResolvers<Result<ClipboardRepresentation, ExpectedError>>();
  const app = await mount({ clipboard: { read: () => gate.promise, dispose: async () => {} } });
  try {
    const pending = app.input.pasteClipboard();
    expect(app.input.pending).toBe(true);
    app.input.value = "new session draft";
    gate.resolve(ok({ mimeType: "image/png", bytes: tinyPng() }));
    await pending;

    expect(app.input.value).toBe("new session draft");
    expect(app.input.draft.tokens).toEqual([]);
    expect(app.input.pending).toBe(false);
    expect(app.input.activity.root.visible).toBe(false);
  } finally {
    await app.close();
  }
});

test("Clipboard failures are errors rather than quiet informational notices", async () => {
  // A failed clipboard read must remain visible after informational toasts are disabled.
  const app = await mount({
    clipboard: {
      read: async () => err(new ClipboardError("Clipboard unavailable")),
      dispose: async () => {},
    },
  });
  try {
    await app.mockInput.typeText("retained input");
    await app.renderOnce();

    // Request a paste whose OS boundary rejects the read.
    await app.input.pasteClipboard();

    // The draft is unchanged and the rejection is explicitly classified as an error.
    expect(app.input.value).toBe("retained input");
    expect(app.levels).toEqual(["error"]);
    expect(app.notices[0]).toContain("CLIPBOARD_UNAVAILABLE");
  } finally {
    await app.close();
  }
});

test("Rejected attachment paths are warnings and preserve input", async () => {
  // Invalid user input needs actionable feedback, not a quiet navigation record.
  const app = await mount();
  try {
    app.input.value = "retained input";

    // Reject a path exceeding the documented attachment boundary.
    const accepted = app.input.attachFile("/" + "a".repeat(4096));

    // The rejected action does not mutate the draft or disappear as Info.
    expect(accepted).toBe(false);
    expect(app.input.value).toBe("retained input");
    expect(app.levels).toEqual(["warning"]);
    expect(app.notices[0]).toContain("INVALID_INPUT");
  } finally {
    await app.close();
  }
});

test("Moving the caret during clipboard reads prevents misplaced insertion and offers retry", async () => {
  const gate = Promise.withResolvers<Result<ClipboardRepresentation, ExpectedError>>();
  const app = await mount({ clipboard: { read: () => gate.promise, dispose: async () => {} } });
  try {
    await app.mockInput.typeText("before");
    const pending = app.input.pasteClipboard();
    app.mockInput.pressArrow("left");
    gate.resolve(ok({ mimeType: "text/plain", bytes: new TextEncoder().encode("paste") }));
    await pending;

    expect(app.input.value).toBe("before");
    expect(app.notices[0]).toContain("paste again");
    expect(app.levels).toEqual(["warning"]);
    expect(app.input.pending).toBe(false);
  } finally {
    await app.close();
  }
});

test("Undo/redo after draft replacement never restores previous-session attachment metadata", async () => {
  const app = await mount();
  try {
    app.input.attachFile("/tmp/secret.png");
    await app.mockInput.typeText(" old");
    app.input.value = "new session";
    app.mockInput.pressKey("-", { ctrl: true });
    app.mockInput.pressKey(".", { ctrl: true });
    expect(app.input.value).toBe("new session");
    expect(app.input.draft.tokens).toEqual([]);
    await app.mockInput.typeText(" edit");
    app.mockInput.pressKey("-", { ctrl: true });
    expect(app.input.draft.tokens).toEqual([]);
    expect(app.input.submission.images).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Collapsed paste undo/redo restores display and source together", async () => {
  const app = await mount();
  try {
    const text = "long pasted content\n".repeat(100);
    await app.mockInput.pasteBracketedText(text);
    app.mockInput.pressKey("-", { ctrl: true });
    expect(app.input.value).toBe("");
    expect(app.input.draft.tokens).toEqual([]);
    app.mockInput.pressKey(".", { ctrl: true });
    expect(app.input.value).toContain("[Pasted Content");
    expect(app.input.submission.text).toBe(text);
    expect(app.input.draft.tokens).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test("Long pastes display compactly while submitting full source exceeding 1,000 characters", async () => {
  const app = await mount();
  try {
    // Collapse only presentation; preserve actual user data.
    const text = "A".repeat(6324);
    await app.mockInput.pasteBracketedText(text);
    await app.renderOnce();

    expect(app.input.value).toBe("[Pasted Content 6324 chars]");
    expect(app.input.submission.text).toBe(text);
    expect(app.input.draft.tokens).toHaveLength(1);
    expect(app.notices).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Short multiline pastes and Shift/Alt Enter preserve newlines", async () => {
  const app = await mount();
  try {
    // Newlines are pasted data, not key events.
    await app.mockInput.pasteBracketedText("first\nsecond");
    app.mockInput.pressEnter({ shift: true });
    await app.mockInput.typeText("third");
    app.mockInput.pressEnter({ meta: true });
    await app.mockInput.typeText("fourth");

    expect(app.input.value).toBe("first\nsecond\nthird\nfourth");
    expect(app.input.submission.text).toBe(app.input.value);
    expect(app.input.draft.tokens).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Attachment paths display numbers while submissions retain image paths and file references", async () => {
  const app = await mount();
  try {
    app.input.setWorkingDirectory("/workspace");
    await app.mockInput.pasteBracketedText('"/tmp/한글 image.png" /tmp/file.txt');

    expect(app.input.value).toBe("[Image #1] [File #1] ");
    expect(app.input.value).not.toContain("/tmp/");
    expect(app.input.submission.images).toEqual(["/tmp/한글 image.png"]);
    expect(app.input.submission.text).toBe('[Image #1] @"/tmp/file.txt" ');
    expect(app.input.legacyText).toBe('@"/tmp/한글 image.png" @"/tmp/file.txt" ');
  } finally {
    await app.close();
  }
});

test("Korean/emoji edits around attachments preserve source positions and caret through save/restore", async () => {
  const app = await mount();
  try {
    const text = "원문👩🏽‍💻\n".repeat(100);
    await app.mockInput.pasteBracketedText("앞👩🏽‍💻 ");
    await app.mockInput.pasteBracketedText(text);
    await app.mockInput.typeText(" 뒤");
    app.mockInput.pressArrow("left");
    const cursor = app.input.cursorOffset;
    const saved = app.input.draft,
      expanded = app.input.submission.text;
    app.input.value = "another session";
    const restored = app.input.restore(saved);

    expect(restored.ok).toBe(true);
    expect(app.input.cursorOffset).toBe(cursor);
    expect(app.input.submission.text).toBe(expanded);
    expect(expanded).toBe(`앞👩🏽‍💻 ${text} 뒤`);
    expect(app.input.draft).toEqual(saved);
  } finally {
    await app.close();
  }
});

test("Backspace deletes whole collapsed pastes and undo restores their source", async () => {
  const app = await mount();
  try {
    const text = "large text ".repeat(200);
    await app.mockInput.typeText("before ");
    await app.mockInput.pasteBracketedText(text);
    app.mockInput.pressBackspace();
    expect(app.input.value).toBe("before ");
    expect(app.input.draft.tokens).toEqual([]);

    app.mockInput.pressKey("-", { ctrl: true });

    expect(app.input.submission.text).toBe(`before ${text}`);
    expect(app.input.draft.tokens).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test("Attachment details are read-only and Backspace removes only the selected item", async () => {
  // Viewing details must not change attachments or the input caret.
  const app = await mount();
  try {
    app.input.attachFile("/tmp/one.txt");
    app.input.attachFile("/tmp/two.png");
    const draft = app.input.draft;

    // View source without deletion actions, then use ordinary input deletion.
    app.input.inspectAtCursor();
    expect(app.details[0]).toEqual({
      title: "[Image #1]",
      text: "Image reference\n\n/tmp/two.png",
    });
    expect(app.input.draft).toEqual(draft);
    app.mockInput.pressBackspace();

    // Only the selected attachment disappears; remaining file references stay intact.
    expect(app.input.value).toBe("[File #1]");
    expect(app.input.submission.images).toEqual([]);
    expect(app.input.submission.text).toBe('@"/tmp/one.txt"');
  } finally {
    await app.close();
  }
});

test("Completion replaces only its target range without losing attachments", async () => {
  const app = await mount();
  try {
    app.input.attachFile("/tmp/image.png");
    await app.mockInput.typeText(" /mode");
    const start = app.input.value.indexOf("/mode");
    app.input.replaceRange(start, app.input.value.length, "/model ");

    expect(app.input.value).toBe("[Image #1] /model ");
    expect(app.input.submission.images).toEqual(["/tmp/image.png"]);
    expect(app.input.draft.tokens).toHaveLength(1);
  } finally {
    await app.close();
  }
});
