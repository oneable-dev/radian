import { expect, test } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { filterCompletions } from "../../agents/completion.ts";
import { sessionControlCommands } from "../../agents/session-controls.ts";
import { PromptInput } from "../../agents/ui/prompt-input.ts";
import { SessionError, type ExpectedError } from "../../errors.ts";
import { err, ok, type Result } from "../../result.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { Workbench } from "./workbench.ts";

async function mount(
  closing: Promise<Result<void, ExpectedError>> = Promise.resolve(ok(undefined)),
) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true, clock });
  const selection = new WorkspaceSelection(demoWorkspace());
  const submitted: { id: string; text: string }[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession() {},
    onCloseSession() {},
    initialDrafts: { a2: "Second draft", b1: "Feature draft" },
    getSessionDetails: (id) => ({
      conversationId: id,
      status: "working",
      output: "",
      error: null,
      sections: [
        {
          id: `${id}:answer`,
          kind: "assistant",
          title: "Agent",
          text: "```text\n" + "RETAINED_LINE\n".repeat(80) + "```",
          status: "complete",
        },
      ],
    }),
    onComplete: async (_id, query) => ok(filterCompletions(sessionControlCommands, query.query)),
    onPrompt: async (id, text) => {
      submitted.push({ id, text });

      const result = await closing;
      if (!result.ok) {
        return result;
      }

      selection.replaceSnapshot(
        selection.snapshot.map((repo) => ({
          ...repo,
          worktrees: repo.worktrees.map((tree) => ({
            ...tree,
            sessions: tree.sessions.filter((session) => session.id !== id),
          })),
        })),
      );

      return result;
    },
  });
  const render = async () => {
    for (let i = 0; i < 12; i++) {
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

  input.focus();
  await render();

  return {
    ...app,
    view,
    selection,
    input,
    scroll,
    submitted,
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

test("exit closes the current tab while preserving the next draft and other worktrees", async () => {
  // Prepare an active current conversation and a next tab with its own draft.
  const app = await mount();
  try {
    // Execute exit through Agent input rather than a button.
    await app.submit("/exit");

    // Consume only the closed tab's command; preserve surviving input and focus.
    expect(app.submitted).toEqual([{ id: "a1", text: "/exit" }]);
    expect(app.selection.worktree?.sessions.map((session) => session.id)).toEqual(["a2", "a3"]);
    expect(app.selection.sessionId).toBe("a2");
    expect(app.input.value).toBe("Second draft");
    expect(app.view.promptDrafts.a1).toBeUndefined();
    expect(app.view.promptDrafts.b1).toBe("Feature draft");
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    expect(app.view.root.isDestroyed).toBe(false);
  } finally {
    await app.close();
  }
});

test("exit completion closes the last tab without exiting the app or other worktrees", async () => {
  // Leave only one session in the selected worktree.
  const app = await mount();
  try {
    app.selection.selectSession("demo:feature", "b1");
    await app.render();
    app.input.focus();

    // Enter on abbreviated input submits the completed host command.
    await app.submit("/ex");

    // Closing the final tab returns to empty state, not full Radian exit.
    expect(app.submitted).toEqual([{ id: "b1", text: "/exit" }]);
    expect(app.selection.sessionId).toBeNull();
    expect(app.selection.worktree?.sessions).toEqual([]);
    expect(app.captureCharFrame()).toContain("No AI sessions");
    expect(app.view.root.isDestroyed).toBe(false);
    expect(app.selection.snapshot[0]?.worktrees[0]?.sessions.map((session) => session.id)).toEqual([
      "a1",
      "a2",
      "a3",
    ]);
    expect(app.view.promptDrafts.a2).toBe("Second draft");
  } finally {
    await app.close();
  }
});

test("exit arguments preserve the tab, error, and original input", async () => {
  // Use real input routing so invalid exit commands never become ordinary prompts.
  const app = await mount();
  try {
    // Exit commands accept no arguments.
    await app.submit("/exit later");

    // Rejected commands remain in the current tab input.
    expect(app.submitted).toEqual([]);
    expect(app.selection.sessionId).toBe("a1");
    expect(app.input.value).toBe("/exit later");
    expect(app.captureCharFrame()).toContain("INVALID_INPUT");
  } finally {
    await app.close();
  }
});

test("exit with image attachments preserves tabs, commands, and attachments", async () => {
  // Images attached to exit must neither disappear nor reach the model.
  const app = await mount();
  try {
    app.input.value = "/exit ";
    app.input.attachFile("/tmp/exit-fixture.png");

    const draft = app.input.draft;

    // Submit an attached exit command through real input routing.
    app.mockInput.pressEnter();
    await app.render();

    // Invalid commands remain in input without close requests.
    expect(app.submitted).toEqual([]);
    expect(app.selection.sessionId).toBe("a1");
    expect(app.input.draft).toEqual(draft);
    expect(app.captureCharFrame()).toContain("INVALID_INPUT");
  } finally {
    await app.close();
  }
});

test("Rejected exit preserves tabs, commands, and reading positions", async () => {
  // Simulate host rejection before close acceptance.
  const app = await mount(
    Promise.resolve(err(new SessionError("SESSION_CONFLICT", "Conversation changed"))),
  );
  try {
    app.scroll.scrollTo(10);
    await app.render();

    const top = app.scroll.scrollTop;
    const navigation = structuredClone(app.view.workViewPreferences.agentViews?.a1);

    // Rejected exit must not alter current conversation navigation.
    await app.submit("/exit");

    // Original input remains retryable without changing tabs or conversations.
    expect(app.selection.sessionId).toBe("a1");
    expect(app.input.value).toBe("/exit");
    expect(app.scroll.scrollTop).toBe(top);
    expect(app.view.workViewPreferences.agentViews?.a1).toEqual(navigation);
    expect(app.captureCharFrame()).toContain("SESSION_CONFLICT");
  } finally {
    await app.close();
  }
});

test("Late exit after switching tabs preserves current selection and drafts", async () => {
  // Continue typing in another tab while awaiting exit.
  const ready = Promise.withResolvers<Result<void, ExpectedError>>();
  const app = await mount(ready.promise);
  try {
    await app.submit("/exit");
    app.selection.selectSession("demo:main", "a2");
    await app.render();
    app.input.value = "Edited while closing";
    await app.render();

    // Accept the original tab's close request late.
    ready.resolve(ok(undefined));
    await app.render();

    // Apply closure only to its originating tab.
    expect(app.selection.sessionId).toBe("a2");
    expect(app.input.value).toBe("Edited while closing");
    expect(app.view.promptDrafts.a1).toBeUndefined();
    expect(app.view.promptDrafts.a2).toBe("Edited while closing");
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
  } finally {
    ready.resolve(ok(undefined));
    await app.render();
    await app.close();
  }
});
