import { expect, test } from "bun:test";
import { parseKeypress } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { PromptInput } from "../../ui/prompt-input.ts";
import { pressLeader } from "../../testing/keys.ts";
import { defaultKeymap, parseKeymap } from "../../keybindings/config.ts";
import { keymapHelp } from "../../keybindings/help.ts";
import { expectOk } from "../../testing/results.ts";
import { InputError, type ExpectedError } from "../../errors.ts";
import { err, ok, type Result } from "../../result.ts";
import type { CompletionResult } from "../../agents/completion.ts";

async function mount(actions: Partial<WorkbenchActions> = {}) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 120, height: 32, kittyKeyboard: true, clock });
  const selection = new WorkspaceSelection(demoWorkspace());
  const sent: { id: string; text: string; images: readonly string[] }[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession() {},
    onCloseSession() {},
    getSessionDetails: () => ({ status: "complete", output: "", error: null, sections: [] }),
    ...actions,
    onPrompt: (id, text, images) => {
      sent.push({ id, text, images: images ?? [] });

      return actions.onPrompt?.(id, text, images) ?? ok(undefined);
    },
  });
  const render = async () => {
    for (let index = 0; index < 8; index++) {
      await Promise.resolve();
    }

    await app.renderOnce();
    await app.renderOnce();
  };

  await render();
  pressLeader(app, "a");
  await render();

  const input = app.renderer.root.findDescendantById("session-prompt");
  if (!(input instanceof PromptInput)) {
    throw new Error("Missing Agent prompt");
  }

  return {
    ...app,
    clock,
    selection,
    view,
    input,
    sent,
    render,
    async submit(text: string) {
      input.value = text;
      app.mockInput.pressEnter();
      await render();
    },
    async history(direction: "previous" | "next") {
      app.mockInput.pressKey(direction === "previous" ? "p" : "n", { ctrl: true });
      await render();
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test.each([120, 60])(
  "At width %i, Ctrl+P/N recalls accepted inputs from any line and restores the unsent rich draft and caret",
  async (width) => {
    // A multiline prompt and a later prompt precede an unfinished draft with private attachment metadata.
    const app = await mount();
    try {
      app.resize(width, 32);
      await app.render();
      expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).not.toContain(
        "Input history",
      );
      await app.submit("first\nsecond");
      await app.submit("latest accepted");
      app.input.value = "unsent\n한글 👨‍👩‍👧‍👦 ";
      app.input.attachFile("/tmp/draft.png");
      app.input.cursorOffset = 2;

      const draft = app.input.draft;

      // History shortcuts change whole inputs regardless of the current cursor's row.
      await app.history("previous");
      expect(app.input.value).toBe("latest accepted");
      await app.history("previous");
      expect(app.input.value).toBe("first\nsecond");
      app.mockInput.pressArrow("left");

      const cursor = app.input.cursorOffset;
      await app.history("previous");
      expect(app.input.cursorOffset).toBe(cursor);
      await app.history("next");
      expect(app.input.value).toBe("latest accepted");
      await app.history("next");

      // Returning beyond the newest entry restores the original draft, never sending or flattening its attachments.
      expect(app.input.draft).toEqual(draft);
      expect(app.input.submission.images).toEqual(["/tmp/draft.png"]);
      expect(app.renderer.currentFocusedRenderable).toBe(app.input);
      expect(app.sent).toHaveLength(2);
      await app.history("next");
      expect(app.input.draft).toEqual(draft);
    } finally {
      await app.close();
    }
  },
);

test("Arrows only move within the current input, including while browsing history and at input boundaries", async () => {
  // Recalled multiline content must remain editable without accidentally selecting a different prompt.
  const app = await mount();
  try {
    await app.submit("older");
    await app.submit("first\nsecond");
    app.mockInput.pressArrow("up");
    app.mockInput.pressArrow("down");
    await app.render();
    expect(app.input.value).toBe("");
    await app.history("previous");

    // Repeated boundary arrows stay in this input instead of navigating history.
    app.mockInput.pressArrow("up");
    await app.render();
    expect(app.input.logicalCursor.row).toBe(0);
    app.mockInput.pressArrow("up");
    await app.render();
    expect(app.input.value).toBe("first\nsecond");
    app.mockInput.pressArrow("down");
    app.mockInput.pressArrow("down");
    await app.render();

    // Only the explicit history shortcut returns to the blank, unsent draft.
    expect(app.input.logicalCursor.row).toBe(1);
    expect(app.input.value).toBe("first\nsecond");
    await app.history("next");
    expect(app.input.value).toBe("");
    expect(app.sent).toHaveLength(2);
  } finally {
    await app.close();
  }
});

test("Recalled attachments retain their full source and edits never mutate the accepted history entry", async () => {
  // History stores rich drafts rather than the collapsed labels that happen to be painted in the editor.
  const app = await mount();
  try {
    const source = "full pasted source\n".repeat(100);
    app.input.pasteText(source);
    app.input.attachFile("/tmp/original.png");

    const draft = app.input.draft;
    const submission = app.input.submission;

    app.mockInput.pressEnter();
    await app.render();

    // A recalled entry is an editable copy, including its original attachment indexes and payloads.
    await app.history("previous");
    expect(app.input.draft).toEqual(draft);
    expect(app.input.submission).toEqual(submission);
    app.input.insertText(" edited");
    await app.render();
    await app.history("next");
    await app.history("previous");

    // Revisiting the stored entry cannot replace its source with the temporary edited copy.
    expect(app.input.draft).toEqual(draft);
    expect(app.sent).toEqual([{ id: "a1", ...submission }]);
  } finally {
    await app.close();
  }
});

test("Rejected inputs stay as drafts and do not become accepted history entries", async () => {
  // A rejection must not displace the most recent successfully accepted prompt.
  const app = await mount({
    onPrompt: (_id, text) =>
      text === "rejected" ? err(new InputError("Rejected fixture")) : ok(undefined),
  });
  try {
    await app.submit("accepted");
    await app.submit("rejected");

    // Recalling an older input leaves the rejected draft available at the forward boundary.
    await app.history("previous");
    expect(app.input.value).toBe("accepted");
    await app.history("next");

    // Nothing is resent as a side effect of browsing.
    expect(app.input.value).toBe("rejected");
    expect(app.sent.map((item) => item.text)).toEqual(["accepted", "rejected"]);
  } finally {
    await app.close();
  }
});

test("Acceptance records the captured input without clearing newer edits made while waiting", async () => {
  // Admission is asynchronous, but the recorded history must refer to the submitted draft.
  const pending = Promise.withResolvers<Result<void, ExpectedError>>();
  const app = await mount({ onPrompt: () => pending.promise });
  try {
    app.input.value = "captured";
    app.mockInput.pressEnter();
    app.input.insertText(" plus next");
    await app.render();
    pending.resolve(ok(undefined));
    await app.render();
    expect(app.input.value).toBe("captured plus next");

    // Navigation after admission recalls only the input that was actually sent.
    await app.history("previous");
    expect(app.input.value).toBe("captured");
    await app.history("next");

    // The newer edit remains the current draft and has never been submitted.
    expect(app.input.value).toBe("captured plus next");
    expect(app.sent.map((item) => item.text)).toEqual(["captured"]);
  } finally {
    pending.resolve(ok(undefined));
    await app.close();
  }
});

test("Session switching keeps input history and unfinished browsing drafts isolated", async () => {
  // Each session owns its accepted prompts as well as the draft saved before browsing.
  const app = await mount();
  try {
    await app.submit("session one");
    app.input.value = "draft one";
    await app.history("previous");
    app.selection.selectSession("demo:main", "a2");
    await app.render();
    await app.history("previous");
    expect(app.input.value).toBe("");
    await app.submit("session two");
    app.input.value = "draft two";
    await app.history("previous");

    // Returning to either session resumes its own browse position and original draft.
    app.selection.selectSession("demo:main", "a1");
    await app.render();
    expect(app.input.value).toBe("session one");
    await app.history("next");
    expect(app.input.value).toBe("draft one");
    app.selection.selectSession("demo:main", "a2");
    await app.render();
    expect(app.input.value).toBe("session two");
    await app.history("next");

    // Cross-session navigation cannot insert another session's prompts or send requests.
    expect(app.input.value).toBe("draft two");
    expect(app.sent.map((item) => item.id)).toEqual(["a1", "a2"]);
  } finally {
    await app.close();
  }
});

test.each(["ready", "loading", "empty", "error"] as const)(
  "%s completion owns Ctrl+N/P and arrows ahead of input history",
  async (state) => {
    // A visible completion interaction must never fall through to replacing the whole draft, even without candidates.
    const pending = Promise.withResolvers<Result<CompletionResult, ExpectedError>>();
    const app = await mount({
      onComplete: async () => {
        if (state === "loading") {
          return pending.promise;
        } else if (state === "error") {
          return err(new InputError("Lookup failed"));
        } else {
          return ok({
            items:
              state === "empty"
                ? []
                : ["alpha", "beta"].map((value) => ({
                    kind: "command" as const,
                    value,
                    description: value,
                  })),
            truncated: false,
          });
        }
      },
    });
    try {
      await app.submit("accepted");
      app.input.value = "/";
      await app.render();
      app.clock.advance(150);
      await app.render();
      expect(app.renderer.root.findDescendantById("prompt-completions")?.visible).toBe(true);

      // All navigation remains owned by completion, rather than history or native cursor movement.
      await app.history("next");
      if (state === "ready") {
        expect(app.captureCharFrame()).toContain("→ beta");
      }

      await app.history("previous");
      app.mockInput.pressArrow("down");
      app.mockInput.pressArrow("up");
      await app.render();
      expect(app.input.value).toBe("/");
      expect(app.input.cursorOffset).toBe(1);
      app.mockInput.pressEscape();
      await app.render();
      await app.history("previous");

      // Dismissal explicitly returns shortcut ownership to history; restoring slash input must not reopen completion.
      expect(app.input.value).toBe("accepted");
      await app.history("next");
      expect(app.input.value).toBe("/");
      expect(app.renderer.root.findDescendantById("prompt-completions")?.visible).toBe(false);
      expect(app.sent).toHaveLength(1);
    } finally {
      pending.resolve(ok({ items: [], truncated: false }));
      await app.close();
    }
  },
);

test("Recalled command inputs do not reopen completion or trap subsequent history navigation", async () => {
  // A stored command remains editable, but merely recalling it is not an autocomplete request.
  const app = await mount({
    onComplete: async () =>
      ok({
        items: [{ kind: "command", value: "fixture", description: "Fixture" }],
        truncated: false,
      }),
  });
  try {
    await app.submit("older");
    await app.submit("/fixture");

    // Consecutive history shortcuts step over the recalled slash command without changing contexts.
    await app.history("previous");
    expect(app.input.value).toBe("/fixture");
    expect(app.renderer.root.findDescendantById("prompt-completions")?.visible).toBe(false);
    await app.history("previous");

    // No command runs until the user explicitly submits the current input; editing a recalled command can reopen suggestions.
    expect(app.input.value).toBe("older");
    expect(app.sent.map((item) => item.text)).toEqual(["older", "/fixture"]);
    await app.history("next");
    app.input.insertText("x");
    await app.render();
    expect(app.renderer.root.findDescendantById("prompt-completions")?.visible).toBe(true);
  } finally {
    await app.close();
  }
});

test("History shortcuts honor remapping and disabling and Help shows the configured input-history commands", async () => {
  // Application commands, not hard-coded editor handlers, own the history shortcuts.
  const keymap = expectOk(
    parseKeymap({
      bindings: {
        "agent.history-previous": [{ keys: "alt+p", scope: "prompt" }],
        "agent.history-next": [],
      },
    }),
  );
  const app = await mount({ keymap });
  try {
    await app.submit("accepted");

    // Removed defaults stay unbound while an explicit override recalls the prompt.
    await app.history("previous");
    expect(app.input.value).toBe("");
    app.mockInput.pressKey("p", { meta: true });
    await app.render();
    expect(app.input.value).toBe("accepted");
    expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).not.toContain(
      "<M-p> Input history",
    );

    const help = keymapHelp(keymap, "prompt", () => true);
    const defaults = defaultKeymap();

    // Help advertises actual mappings, never implying that bare arrows recall prompts.
    expect(help).toContain("<M-p>");
    expect(help).toContain("Previous input");
    expect(help).not.toContain("Next input");
    expect(defaults.hints("agent.history-previous", "prompt")).toBe("<C-p>");
    expect(defaults.hints("agent.history-next", "prompt")).toBe("<C-n>");
    expect(defaults.bound("up", "prompt")).toBe(false);
    expect(defaults.bound("down", "prompt")).toBe(false);
  } finally {
    await app.close();
  }
});

test("Held history shortcuts keep navigating without inserting literal control-key names", async () => {
  // Kitty repeats must stay repeatable history actions instead of becoming native edits after the first press.
  const app = await mount();
  const raw = (sequence: string) => {
    const key = parseKeypress(sequence, { useKittyKeyboard: true });
    if (!key) {
      throw new Error("Invalid Kitty key");
    }

    app.renderer.keyInput.processParsedKey(key);
  };
  try {
    await app.submit("first");
    await app.submit("second");
    app.input.value = "draft";

    // A held previous key traverses entries and clamps, and held next restores the draft exactly once.
    app.mockInput.pressKey("p", { ctrl: true });
    raw("\x1b[112;5:2u");
    raw("\x1b[112;5:2u");
    raw("\x1b[112;5:3u");
    await app.render();
    expect(app.input.value).toBe("first");
    app.mockInput.pressKey("n", { ctrl: true });
    raw("\x1b[110;5:2u");
    raw("\x1b[110;5:2u");
    raw("\x1b[110;5:3u");
    await app.render();

    // Navigation has no submission or draft-corruption side effects.
    expect(app.input.value).toBe("draft");
    expect(app.sent).toHaveLength(2);
  } finally {
    await app.close();
  }
});

test("Empty history is a no-op and consecutive duplicate inputs occupy only one history step", async () => {
  // An unfinished input must survive navigation when no accepted history exists.
  const app = await mount();
  try {
    app.input.value = "unsent";
    app.input.cursorOffset = 2;

    const draft = app.input.draft;
    await app.history("previous");
    await app.history("next");
    expect(app.input.draft).toEqual(draft);
    await app.submit("same input");
    await app.submit("same input");
    app.input.value = "new draft";

    // Repeated previous steps clamp at the one distinct accepted input.
    await app.history("previous");
    await app.history("previous");
    expect(app.input.value).toBe("same input");
    await app.history("next");

    // A single forward step reaches the original draft, rather than a duplicate history entry.
    expect(app.input.value).toBe("new draft");
    expect(app.sent).toHaveLength(2);
  } finally {
    await app.close();
  }
});

test("Clearing a recalled input ends browsing without deleting accepted history", async () => {
  // Explicit Clear discards the current browse operation, not the accepted prompts behind it.
  const app = await mount();
  try {
    await app.submit("accepted");
    app.input.value = "unsent";
    await app.history("previous");

    // Forward navigation after Clear must not unexpectedly resurrect the discarded draft.
    app.mockInput.pressCtrlC();
    await app.render();
    await app.history("next");
    expect(app.input.value).toBe("");
    await app.history("previous");
    expect(app.input.value).toBe("accepted");
    await app.history("next");

    // The next browse operation starts from the intentionally empty input.
    expect(app.input.value).toBe("");
    expect(app.sent).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test("Conversation replacement releases history and late acceptance cannot put outgoing inputs into the replacement", async () => {
  // An outgoing request may still be awaiting admission when the runtime replaces its conversation.
  let conversationId = "before";
  const pending = Promise.withResolvers<Result<void, ExpectedError>>();
  const app = await mount({
    getSessionDetails: () => ({
      status: "complete",
      output: "",
      error: null,
      sections: [],
      conversationId,
    }),
    onPrompt: (_id, text) => (text === "pending old input" ? pending.promise : ok(undefined)),
  });
  try {
    await app.submit("accepted old input");
    await app.submit("pending old input");
    conversationId = "after";
    app.selection.replaceSnapshot(app.selection.snapshot);
    await app.render();
    app.input.value = "replacement draft";

    // The late acknowledgement belongs to the now-detached history, not the replacement conversation.
    pending.resolve(ok(undefined));
    await app.render();
    await app.history("previous");

    // Neither the formerly accepted input nor the delayed one is available for recall in the replacement.
    expect(app.input.value).toBe("replacement draft");
    expect(app.sent).toHaveLength(2);
  } finally {
    pending.resolve(ok(undefined));
    await app.close();
  }
});

test("Long-running sessions keep only the most recent 100 input-history entries", async () => {
  // History storage must stay bounded even when a session submits many distinct inputs.
  const app = await mount();
  try {
    for (let index = 0; index <= 100; index++) {
      await app.submit(`input-${index}`);
    }

    app.input.value = "draft";

    // Repeated navigation reaches the oldest retained input and clamps there.
    for (let index = 0; index <= 100; index++) {
      await app.history("previous");
    }

    // The evicted first input is not silently retained past the entry budget.
    expect(app.input.value).toBe("input-1");
    expect(app.sent).toHaveLength(101);
  } finally {
    await app.close();
  }
});

test("Large collapsed pastes respect the history byte budget without truncating the latest input", async () => {
  // Collapsed display labels must not hide unbounded retained source text from the history budget.
  const app = await mount();
  try {
    for (const character of ["a", "b"]) {
      app.input.pasteText(character.repeat(2 * 1024 * 1024));
      app.mockInput.pressEnter();
      await app.render();
    }

    // Two serialized rich drafts exceed the byte budget, so only the complete newest input remains.
    await app.history("previous");
    await app.history("previous");

    // Recall preserves every source byte, rather than truncating a retained entry to satisfy the limit.
    expect(app.input.submission.text).toBe("b".repeat(2 * 1024 * 1024));
    expect(app.sent).toHaveLength(2);
  } finally {
    await app.close();
  }
});
