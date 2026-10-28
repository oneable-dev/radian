import { expect, test } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { filterCompletions } from "../../agents/completion.ts";
import { historyCommand } from "../../agents/history-command.ts";
import { PromptInput } from "../../agents/ui/prompt-input.ts";
import { ok } from "../../result.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { Workbench } from "./workbench.ts";

async function mount(completion = false) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true, clock });
  const selection = new WorkspaceSelection(demoWorkspace());
  const sent: string[] = [];
  const lookups: string[] = [];
  const interrupted: string[] = [];
  const state = {
    conversationId: "original",
    status: "working" as const,
    output: "",
    error: null,
    sections: [
      {
        id: "answer",
        kind: "assistant" as const,
        title: "Agent",
        text: "```text\n" + "RETAINED_LINE\n".repeat(80) + "```",
        status: "complete" as const,
      },
    ],
  };
  const view = new Workbench(app.renderer, selection, {
    onNewSession() {},
    onCloseSession() {},
    onPrompt: (_id, text) => {
      sent.push(text);

      return ok(undefined);
    },
    getSessionDetails: () => state,
    onListHistory: async (id) => {
      lookups.push(id);

      return ok([]);
    },
    onInterrupt: async (id) => {
      interrupted.push(id);

      return ok(undefined);
    },
    ...(completion
      ? {
          onComplete: async (_id: string, query: { query: string }) =>
            ok(filterCompletions([historyCommand], query.query)),
        }
      : {}),
  });
  const render = async () => {
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }

    await app.renderOnce();
    await app.renderOnce();
  };

  await render();

  const input = app.renderer.root.findDescendantById("session-prompt");
  const scroll = app.renderer.root.findDescendantById("session-transcript");
  if (!(input instanceof PromptInput) || !(scroll instanceof ScrollBoxRenderable)) {
    throw new Error("Missing prompt/transcript");
  }

  const popup = app.renderer.root.findDescendantById("session-history")!;
  input.focus();
  await render();

  return {
    ...app,
    view,
    selection,
    input,
    scroll,
    popup,
    sent,
    lookups,
    interrupted,
    clock,
    render,
    async submit(text: string) {
      input.value = text;
      await render();
      clock.advance(150);
      await render();
      app.mockInput.pressEnter();
      await render();
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test("history opens only a popup while preserving active conversations and reading positions, then Esc restores input", async () => {
  // Opening history while reading older output must not scroll active conversations to the bottom.
  const app = await mount();
  try {
    app.scroll.scrollTo(10);
    await app.render();

    const top = app.scroll.scrollTop;
    const navigation = structuredClone(app.view.workViewPreferences.agentViews?.a1);

    // Submit the command rather than using a shortcut, then close the popup.
    await app.submit("/history");
    expect(app.popup.visible).toBe(true);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("history-search");
    app.mockInput.pressEscape();
    await app.render();

    // Consume only the command; preserve tab, run, reading position, and input focus.
    expect(app.lookups).toEqual(["demo:main"]);
    expect(app.sent).toEqual([]);
    expect(app.interrupted).toEqual([]);
    expect(app.selection.sessionId).toBe("a1");
    expect(app.input.value).toBe("");
    expect(app.view.promptDrafts.a1).toBeUndefined();
    expect(app.popup.visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    expect(app.scroll.scrollTop).toBe(top);
    expect(app.view.workViewPreferences.agentViews?.a1).toEqual(navigation);
  } finally {
    await app.close();
  }
});

test("Enter on history completion opens the current worktree's history", async () => {
  // Switch worktrees before invoking abbreviated command completion.
  const app = await mount(true);
  try {
    app.selection.selectSession("demo:feature", "b1");
    await app.render();
    app.input.focus();

    // Activating completion candidates must not become model input.
    await app.submit("/his");

    // Scope the popup to the selected worktree, not the original one.
    expect(app.popup.visible).toBe(true);
    expect(app.lookups).toEqual(["demo:feature"]);
    expect(app.sent).toEqual([]);
    expect(app.input.value).toBe("");
    expect(app.selection.sessionId).toBe("b1");
  } finally {
    await app.close();
  }
});

test("history arguments preserve errors and input without opening popups or prompting", async () => {
  // Use actual submission routing to catch silently discarded unsupported arguments.
  const app = await mount();
  try {
    await app.submit("/history recent");

    // Rejected commands remain drafts and start neither conversations nor queries.
    expect(app.popup.visible).toBe(false);
    expect(app.lookups).toEqual([]);
    expect(app.sent).toEqual([]);
    expect(app.input.value).toBe("/history recent");
    expect(app.captureCharFrame()).toContain("INVALID_INPUT");
  } finally {
    await app.close();
  }
});

test("history with images preserves attachments and commands without opening popups", async () => {
  // Images attached to non-model commands must not be consumed or lost.
  const app = await mount();
  try {
    app.input.value = "/history ";
    app.input.attachFile("/tmp/history-fixture.png");

    const draft = app.input.draft;

    // Submit a history command with attachments.
    app.mockInput.pressEnter();
    await app.render();

    // Invalid input preserves original attachments without model submission.
    expect(app.popup.visible).toBe(false);
    expect(app.lookups).toEqual([]);
    expect(app.sent).toEqual([]);
    expect(app.input.draft).toEqual(draft);
    expect(app.captureCharFrame()).toContain("INVALID_INPUT");
  } finally {
    await app.close();
  }
});
