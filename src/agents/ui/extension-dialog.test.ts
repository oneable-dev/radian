import { expect, test } from "bun:test";
import {
  InputRenderable,
  parseKeypress,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "../../app/ui/workbench.ts";
import { WorkspaceSelection } from "../../app/workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { halfPageStep } from "../../ui/navigation.ts";
import { uiTheme } from "../../ui/theme.ts";
import { parseKeymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";
import { ok } from "../../result.ts";
import type { ExtensionDialog, ExtensionUiResponse, SessionExtensionUi } from "../extension-ui.ts";

async function mount(width = 120, height = 30, overrides: Partial<WorkbenchActions> = {}) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width, height, kittyKeyboard: true, clock });
  const selection = new WorkspaceSelection(demoWorkspace());
  const answers: ExtensionUiResponse[] = [];
  const answerListeners = new Set<() => void>();
  const sent: string[] = [];
  let state: SessionExtensionUi[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession() {},
    onCloseSession() {},
    getExtensionUi: () => state,
    getSessionDetails: () => ({
      conversationId: "conversation",
      status: null,
      output: "",
      error: null,
    }),
    onExtensionUiResponse: async (_id, _conversation, response) => {
      answers.push(response);
      for (const listener of answerListeners) listener();

      return ok(undefined);
    },
    onPrompt: async (_id, text) => {
      sent.push(text);

      return ok(undefined);
    },
    ...overrides,
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
  const prompt = get("session-prompt") as InputRenderable;

  await render();
  prompt.focus();
  prompt.value = "Unsent Agent draft";

  return {
    ...app,
    selection,
    view,
    answers,
    kitty(sequence: string): void {
      const key = parseKeypress(sequence, { useKittyKeyboard: true });
      if (!key) throw new Error("Invalid Kitty key");
      app.renderer.keyInput.processParsedKey(key);
    },
    waitForAnswer(predicate: (answers: readonly ExtensionUiResponse[]) => boolean): Promise<void> {
      if (predicate(answers)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          answerListeners.delete(check);
          reject(new Error("Extension answer timed out"));
        }, 2000);
        const check = () => {
          if (!predicate(answers)) return;
          clearTimeout(timer);
          answerListeners.delete(check);
          resolve();
        };
        answerListeners.add(check);
      });
    },
    sent,
    prompt,
    clock,
    get,
    render,
    async show(dialog: ExtensionDialog) {
      state = [
        {
          sessionId: selection.sessionId!,
          conversationId: "conversation",
          dialog,
          notifications: [],
          statuses: {},
        },
      ];
      selection.replaceSnapshot(selection.snapshot);
      await render();
    },
    async clear() {
      state = [];
      selection.replaceSnapshot(selection.snapshot);
      await render();
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test("Extension input submits only through its response channel and restores the untouched Agent draft", async () => {
  // An OAuth-style title may contain Pi terminal hyperlinks and a long callback URL.
  const app = await mount();
  try {
    await app.show({
      id: "request",
      kind: "input",
      title:
        "Complete OAuth\n\u001b]8;;https://example.test/auth\u0007Open page\u001b]8;;\u0007\nhttps://example.test/auth",
      placeholder: "Paste callback",
    });

    // Text entry belongs to the dialog, including unmodified Vim letters.
    await app.mockInput.typeText("https://localhost/callback?code=hjkl");
    await app.render();
    app.mockInput.pressEnter();
    await app.render();

    expect(app.answers).toEqual([
      { requestId: "request", value: "https://localhost/callback?code=hjkl" },
    ]);
    expect(app.sent).toEqual([]);
    expect(app.prompt.value).toBe("Unsent Agent draft");
    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    expect(app.get("extension-dialog").visible).toBe(false);
    expect((app.get("extension-dialog-input") as InputRenderable).value).toBe("");
  } finally {
    await app.close();
  }
});

test.each(["input", "confirm"] as const)(
  "Extension %s dialogs use the compact preset and preserve focus through resize",
  async (kind) => {
    // Short prompts use compact geometry rather than the searchable selection frame.
    const app = await mount();
    try {
      await app.show(
        kind === "input"
          ? { id: "request", kind, title: "Callback" }
          : { id: "request", kind, title: "Authorize", message: "Allow access?" },
      );

      const input = app.get("extension-dialog-input") as InputRenderable;
      if (kind === "input") {
        await app.mockInput.typeText("unsubmitted-hjkl");
      }

      const focus = app.renderer.currentFocusedRenderable;

      // Resizing never accepts the request or clears an unsubmitted answer.
      for (const [width, height, columns, rows] of [
        [120, 30, 64, 10],
        [60, 16, 54, 10],
        [30, 10, 27, 8],
        [120, 30, 64, 10],
      ] as const) {
        app.resize(width, height);
        await app.render();

        const panel = app.get("extension-dialog-panel");
        expect([panel.width, panel.height]).toEqual([columns, rows]);
        expect(panel.x).toBe(Math.floor((width - columns) / 2));
        expect(panel.y).toBe(Math.floor((height - rows) / 2));
        expect(app.renderer.currentFocusedRenderable).toBe(focus);
        if (kind === "input") {
          expect(input.value).toBe("unsubmitted-hjkl");
        }

        expect(app.answers).toEqual([]);
      }

      // A following selection request returns to the standard frame without a terminal resize.
      await app.show({
        id: "selection",
        kind: "select",
        title: "Choose",
        options: ["First", "Second"],
      });

      const panel = app.get("extension-dialog-panel");
      expect([panel.width, panel.height]).toEqual([100, 24]);
      expect(app.renderer.currentFocusedRenderable?.id).toBe("extension-dialog-search");
      expect(app.answers).toEqual([]);
      expect(app.prompt.value).toBe("Unsent Agent draft");
    } finally {
      await app.close();
    }
  },
);

test.each([
  [120, 30],
  [60, 16],
  [30, 10],
])(
  "Extension choices use their search title without a separate heading or gap at %dx%d",
  async (width, height) => {
    // Authentication needs a distinct picker title rather than a generic options label.
    const app = await mount(width, height);
    try {
      await app.show({
        id: "authentication",
        kind: "select",
        title: "MCP authentication",
        options: ["supabase", "vercel"],
      });

      // The search field starts the popup and the first candidate immediately follows it.
      const panel = app.get("extension-dialog-panel");
      const field = app.get("extension-dialog-search-field");
      const search = app.get("extension-dialog-search");
      const list = app.get("extension-dialog-list") as ScrollBoxRenderable;

      expect(app.captureCharFrame().match(/MCP authentication/gu)).toHaveLength(1);
      expect(app.captureCharFrame()).not.toContain("Options");
      expect(field.y).toBe(panel.y);
      expect(app.get("extension-option:0").y).toBe(field.y + field.height);
      expect(app.renderer.currentFocusedRenderable).toBe(search);

      // Tab traversal skips the absent description and returns to search without accepting.
      app.mockInput.pressTab();
      await app.render();
      expect(app.renderer.currentFocusedRenderable).toBe(list);
      app.mockInput.pressTab();
      await app.render();
      expect(app.renderer.currentFocusedRenderable).toBe(search);
      expect(app.answers).toEqual([]);
      expect(app.prompt.value).toBe("Unsent Agent draft");
    } finally {
      await app.close();
    }
  },
);

test("Extension selection titles preserve multiline instructions as body content", async () => {
  // Extension titles can include meaningful instructions in addition to the picker name.
  const app = await mount();
  try {
    await app.show({
      id: "selection",
      kind: "select",
      title: "MCP authentication\n\nSelect the server for your workspace.",
      options: ["vercel"],
    });

    // Only the first line becomes the search title; the remaining content stays readable.
    const frame = app.captureCharFrame();
    expect(frame.match(/MCP authentication/gu)).toHaveLength(1);
    expect(frame).toContain("Select the server for your workspace.");
    expect(frame).not.toContain("Options");
    expect(app.get("extension-dialog-details").visible).toBe(true);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("extension-dialog-search");
  } finally {
    await app.close();
  }
});

test.each([
  [120, 30],
  [60, 16],
])(
  "Extension choices preserve search input and navigate candidates across focus at %dx%d",
  async (width, height) => {
    // A long list forces viewport-based navigation in both ordinary and compact layouts.
    const app = await mount(width, height);
    const options = Array.from(
      { length: 60 },
      (_, index) => `Choice ${String(index).padStart(2, "0")}`,
    );
    try {
      await app.show({ id: "request", kind: "select", title: "Choose server", options });
      await app.mockInput.typeText("Choice");
      await app.render();

      const search = app.get("extension-dialog-search") as InputRenderable;
      const caret = search.cursorOffset;

      // Single steps retain search focus; half-page jumps transfer it without editing the query.
      app.mockInput.pressKey("n", { ctrl: true });
      await app.render();
      expect(app.renderer.currentFocusedRenderable).toBe(search);

      const selected = app.get("extension-option:1");
      for (const x of [selected.x, selected.x + selected.width - 1]) {
        let column = 0;
        const span = app.captureSpans().lines[selected.y]!.spans.find((span) => {
          column += span.width;

          return column > x;
        });

        expect(span?.bg.toInts()).toEqual(
          uiTheme(app.renderer).styles["ui.selection"].bg!.toInts(),
        );
      }

      app.mockInput.pressKey("p", { ctrl: true });
      await app.render();

      const list = app.get("extension-dialog-list") as ScrollBoxRenderable;
      const step = halfPageStep(list.viewport.height);

      app.mockInput.pressKey("d", { ctrl: true });
      await app.render();
      expect(app.renderer.currentFocusedRenderable).toBe(list);
      expect(search.value).toBe("Choice");
      expect(search.cursorOffset).toBe(caret);
      for (let repeat = 0; repeat < 3; repeat++) {
        app.mockInput.pressKey("d", { ctrl: true });
        await app.render();
      }

      app.mockInput.pressKey("u", { ctrl: true });
      await app.render();

      const candidate = app.get(`extension-option:${step * 3}`);
      expect(candidate.y).toBeGreaterThanOrEqual(list.viewport.y);
      expect(candidate.y).toBeLessThan(list.viewport.y + list.viewport.height);
      app.mockInput.pressEnter();
      await app.render();

      expect(app.answers).toEqual([{ requestId: "request", value: options[step * 3]! }]);
      expect(app.prompt.value).toBe("Unsent Agent draft");
      expect(app.sent).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Extension search clearing preserves literal text ownership and empty clearing never dismisses the popup", async () => {
  // An empty search is not an application cancellation or an Agent draft clear.
  const app = await mount();
  try {
    await app.show({ id: "request", kind: "select", title: "Choose", options: ["hjkl", "other"] });
    await app.mockInput.typeText("hjkl");
    await app.render();

    const search = app.get("extension-dialog-search") as InputRenderable;
    expect(search.value).toBe("hjkl");

    app.mockInput.pressKey("c", { ctrl: true });
    await app.render();
    app.mockInput.pressKey("c", { ctrl: true });
    await app.render();

    expect(search.value).toBe("");
    expect(app.get("extension-dialog").visible).toBe(true);
    expect(app.answers).toEqual([]);
    expect(app.prompt.value).toBe("Unsent Agent draft");
    app.mockInput.pressEscape();
    await app.render();
    expect(app.answers).toEqual([{ requestId: "request", cancelled: true }]);
  } finally {
    await app.close();
  }
});

test("Confirmation requires explicit activation and respects configured navigation and submit keys", async () => {
  // Permission prompts default to No, while explicit overrides own their keys.
  const keymap = expectOk(
    parseKeymap({
      bindings: {
        "extension.next": [{ keys: "ctrl+j", scope: "extension" }],
        "extension.submit": [{ keys: "ctrl+s", scope: "extension" }],
      },
    }),
  );
  const app = await mount(120, 30, { keymap });
  try {
    await app.show({
      id: "request",
      kind: "confirm",
      title: "Authorize",
      message: "Allow access?",
    });
    app.mockInput.pressKey("n", { ctrl: true });
    await app.render();
    app.mockInput.pressEnter();
    await app.render();
    expect(app.answers).toEqual([]);
    expect(app.captureCharFrame()).toContain("<C-s>");
    expect(app.captureCharFrame()).not.toContain("<Down>");

    app.mockInput.pressKey("j", { ctrl: true });
    await app.render();
    app.mockInput.pressKey("s", { ctrl: true });
    await app.render();

    expect(app.answers).toEqual([{ requestId: "request", confirmed: true }]);
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Held submission never accepts a following dialog or submits the restored Agent draft", async () => {
  // Kitty repeats belong to the original activation until its key is released.
  const app = await mount();
  const raw = (event: string) => {
    const key = parseKeypress(event, { useKittyKeyboard: true });
    if (!key) {
      throw new Error("Invalid Kitty key");
    }

    app.renderer.keyInput.processParsedKey(key);
  };
  try {
    await app.show({ id: "first", kind: "input", title: "First callback" });
    await app.mockInput.typeText("answer");
    await app.render();

    raw("\u001b[13;1u");
    await app.render();
    raw("\u001b[13;1:2u");
    await app.render();
    await app.show({
      id: "second",
      kind: "confirm",
      title: "Continue",
      message: "Another permission",
    });
    raw("\u001b[13;1:2u");
    await app.render();

    expect(app.answers).toEqual([{ requestId: "first", value: "answer" }]);
    expect(app.sent).toEqual([]);
    expect(app.prompt.value).toBe("Unsent Agent draft");
    raw("\u001b[13;1:3u");
    app.mockInput.pressEnter();
    await app.render();
    expect(app.answers.at(-1)).toEqual({ requestId: "second", confirmed: false });
  } finally {
    await app.close();
  }
});

test("Help temporarily covers extension input and returns to the unsubmitted answer without runtime events", async () => {
  // Local popup navigation must not cancel the request or discard a partially entered callback.
  const app = await mount();
  try {
    await app.show({ id: "request", kind: "input", title: "Callback" });
    await app.mockInput.typeText("partial-callback");
    await app.render();

    app.mockInput.pressKey("F1");
    await app.render();
    expect(app.get("text-dialog").visible).toBe(true);
    expect(app.get("extension-dialog").visible).toBe(false);
    app.mockInput.pressEscape();
    await app.render();

    expect(app.get("extension-dialog").visible).toBe(true);
    expect((app.get("extension-dialog-input") as InputRenderable).value).toBe("partial-callback");
    expect(app.renderer.currentFocusedRenderable).toBe(app.get("extension-dialog-input"));
    expect(app.answers).toEqual([]);
    expect(app.prompt.value).toBe("Unsent Agent draft");
  } finally {
    await app.close();
  }
});

test("Multiline extension editors keep Enter literal and save through the configured command", async () => {
  const app = await mount();
  try {
    await app.show({ id: "editor", kind: "editor", title: "Edit system prompt", prefill: "" });
    const editor = app.get("extension-dialog-editor") as TextareaRenderable;
    expect(app.renderer.currentFocusedRenderable?.id).toBe(editor.id);

    await app.mockInput.typeText("first");
    app.mockInput.pressEnter();
    await app.mockInput.typeText("hjkl");
    await app.render();

    expect(editor.plainText).toBe("first\nhjkl");
    expect(app.answers).toEqual([]);
    app.mockInput.pressKey("s", { ctrl: true });
    await app.render();

    expect(app.answers).toEqual([{ requestId: "editor", value: "first\nhjkl" }]);
    expect(app.sent).toEqual([]);
    expect(app.prompt.value).toBe("Unsent Agent draft");
    expect(editor.plainText).toBe("");
  } finally {
    await app.close();
  }
});

test("Cancelling a prefilled multiline editor returns no edited text", async () => {
  const app = await mount();
  try {
    await app.show({
      id: "editor",
      kind: "editor",
      title: "Edit configuration",
      prefill: "first\nsecond",
    });
    const editor = app.get("extension-dialog-editor") as TextareaRenderable;
    expect(editor.plainText).toBe("first\nsecond");

    await app.mockInput.typeText("unsaved");
    app.mockInput.pressEscape();
    await app.render();

    expect(app.answers).toEqual([{ requestId: "editor", cancelled: true }]);
    expect(editor.plainText).toBe("");
    expect(app.prompt.value).toBe("Unsent Agent draft");
  } finally {
    await app.close();
  }
});

test("Custom component input, repeats and cancellation keys stay in their isolated terminal", async () => {
  const app = await mount();
  try {
    await app.show({
      id: "component",
      kind: "custom",
      title: "",
      frame: { cols: 80, rows: 24, revision: 1, ansi: "\u001bcComponent fixture" },
    });
    expect(app.renderer.currentFocusedRenderable?.id).toBe("extension-dialog-component");

    await app.mockInput.typeText("hjkl");
    app.mockInput.pressKey("n", { ctrl: true });
    app.mockInput.pressKey("n", { ctrl: true });
    app.mockInput.pressEnter();
    app.mockInput.pressKey("c", { ctrl: true });
    app.mockInput.pressEscape();
    await app.waitForAnswer((answers) =>
      answers.some((answer) => "input" in answer && answer.input === "\u001b"),
    );
    await app.render();

    const input = app.answers
      .flatMap((answer) => ("input" in answer ? [answer.input] : []))
      .join("");
    expect(input).toContain("hjkl");
    expect(input.split("\u000e").length - 1).toBe(2);
    expect(input).toContain("\r");
    expect(input).toContain("\u0003");
    expect(input).toContain("\u001b");
    expect(app.answers.some((answer) => "cancelled" in answer)).toBe(false);
    expect(app.answers.some((answer) => "viewport" in answer)).toBe(true);
    expect(app.get("extension-dialog").visible).toBe(true);
    expect(app.prompt.value).toBe("Unsent Agent draft");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Held component Enter never submits a following native dialog", async () => {
  const app = await mount();
  try {
    await app.show({
      id: "component",
      kind: "custom",
      title: "",
      frame: { cols: 80, rows: 24, revision: 1, ansi: "" },
    });
    app.kitty("\u001b[13;1u");
    await app.render();
    await app.waitForAnswer((answers) =>
      answers.some((answer) => "input" in answer && answer.input === "\r"),
    );
    await app.show({ id: "following", kind: "input", title: "Callback" });

    app.kitty("\u001b[13;1:2u");
    await app.render();

    expect(app.answers.filter((answer) => answer.requestId === "following")).toEqual([]);
    app.kitty("\u001b[13;1:3u");
    app.kitty("\u001b[13;1u");
    await app.render();
    expect(app.answers.filter((answer) => answer.requestId === "following")).toEqual([
      { requestId: "following", value: "" },
    ]);
  } finally {
    await app.close();
  }
});

test("Held component cancellation never clears the restored Agent draft", async () => {
  const app = await mount();
  try {
    await app.show({
      id: "component",
      kind: "custom",
      title: "",
      frame: { cols: 80, rows: 24, revision: 1, ansi: "" },
    });
    app.kitty("\u001b[99;5u");
    await app.render();
    await app.waitForAnswer((answers) =>
      answers.some((answer) => "input" in answer && answer.input === "\u0003"),
    );
    await app.clear();

    app.kitty("\u001b[99;5:2u");
    await app.render();

    expect(app.prompt.value).toBe("Unsent Agent draft");
    app.kitty("\u001b[99;5:3u");
    expect(app.prompt.isDestroyed).toBe(false);
    app.mockInput.pressKey("c", { ctrl: true });
    await app.render();
    expect(app.prompt.value).toBe("");
  } finally {
    await app.close();
  }
});

test("Retracted extension requests clear input without answering an expired or replaced conversation", async () => {
  // Runtime cancellation can arrive while a callback has been partially entered.
  const app = await mount();
  try {
    await app.show({ id: "request", kind: "input", title: "Callback" });
    await app.mockInput.typeText("private-partial-callback");
    await app.render();

    await app.clear();
    app.mockInput.pressEscape();
    await app.render();

    expect(app.get("extension-dialog").visible).toBe(false);
    expect((app.get("extension-dialog-input") as InputRenderable).value).toBe("");
    expect(app.answers).toEqual([]);
    expect(app.prompt.value).toBe("Unsent Agent draft");
  } finally {
    await app.close();
  }
});
