import { pressLeader } from "../../testing/keys.ts";
import { expect, spyOn, test } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { ExecutionState } from "../../agents/session-registry.ts";
import { PromptInput } from "../../agents/ui/prompt-input.ts";
import { InputError, type ExpectedError } from "../../errors.ts";
import { ok, err, type Result } from "../../result.ts";
import { defaultPreferences } from "../../runtime/client.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { submitAgentPrompt } from "../agent-prompt.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { Workbench } from "./workbench.ts";
import type { CompletionProvider } from "../../agents/ui/completion-menu.ts";

async function mount(
  creation: Promise<Result<string, ExpectedError>> = Promise.resolve(ok("created")),
  promptResult: Result<void, ExpectedError> = ok(undefined),
  onComplete?: CompletionProvider,
) {
  const app = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true });
  let repositories = demoWorkspace();
  const selection = new WorkspaceSelection(repositories);
  const sent: string[] = [];
  const createdFrom: string[] = [];
  const details: Record<string, ExecutionState> = {
    a1: {
      conversationId: "original",
      status: "working",
      output: "",
      error: null,
      sections: [
        {
          id: "history",
          kind: "assistant",
          title: "Agent",
          text: "```text\n" + "ORIGINAL_LINE\n".repeat(80) + "```",
          status: "complete",
        },
      ],
    },
    a2: { conversationId: "second", status: null, output: "", error: null, sections: [] },
    b1: { conversationId: "feature", status: null, output: "", error: null, sections: [] },
  };
  const client: Parameters<typeof submitAgentPrompt>[0] = {
    get snapshot() {
      return {
        repositories,
        details,
        preferences: defaultPreferences(),
        closingCount: 0,
        notice: "",
      };
    },
    async newTab(id) {
      createdFrom.push(id);

      const result = await creation;
      if (!result.ok) {
        return result;
      }

      repositories = repositories.map((repo) => ({
        ...repo,
        worktrees: repo.worktrees.map((tree) =>
          tree.sessions.some((session) => session.id === id)
            ? {
                ...tree,
                sessions: [
                  ...tree.sessions,
                  { id: result.value, name: "New tab", status: null, subagents: [] },
                ],
              }
            : tree,
        ),
      }));
      details[result.value] = {
        conversationId: "fresh",
        status: null,
        output: "",
        error: null,
        sections: [],
      };
      selection.replaceSnapshot(repositories);

      return result;
    },
    async prompt(id, text) {
      sent.push(text);
      if (text === "/clear") {
        details[id] = {
          conversationId: "cleared",
          status: null,
          output: "",
          error: null,
          sections: [],
        };
        repositories = repositories.map((repo) => ({
          ...repo,
          worktrees: repo.worktrees.map((tree) => ({
            ...tree,
            sessions: tree.sessions.map((session) =>
              session.id === id ? { ...session, status: null, subagents: [] } : session,
            ),
          })),
        }));
        selection.replaceSnapshot(repositories);
      }

      return promptResult;
    },
  };
  const view = new Workbench(app.renderer, selection, {
    onNewSession() {},
    onCloseSession() {},
    initialDrafts: { a2: "Second draft", b1: "Feature draft" },
    getSessionDetails: (id) => details[id] ?? null,
    onPrompt: (id, text, images) => submitAgentPrompt(client, selection, id, text, images),
    ...(onComplete ? { onComplete } : {}),
  });
  const render = async () => {
    for (let index = 0; index < 12; index++) {
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

  return {
    ...app,
    view,
    selection,
    input,
    scroll,
    details,
    sent,
    createdFrom,
    render,
    async submit(text: string) {
      pressLeader(app, "a");
      input.value = text;
      app.mockInput.pressEnter();
      await render();
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test("Q12 repair errors retain the draft and reading position with a coded notice", async () => {
  // The reader is inspecting older transcript content when a host command is rejected.
  const app = await mount(undefined, err(new InputError("Repair request rejected")));
  const notice = spyOn(app.view, "notify");
  try {
    app.scroll.scrollTo(10);
    await app.render();
    const top = app.scroll.scrollTop;

    await app.submit("/repair recheck task-1");

    // No extra result surface or follow-latest jump is needed for a host repair command.
    expect(app.sent).toEqual(["/repair recheck task-1"]);
    expect(app.input.value).toBe("/repair recheck task-1");
    expect(app.scroll.scrollTop).toBe(top);
    expect(notice).toHaveBeenCalledWith(
      "[INVALID_INPUT] Repair request rejected · prompt retained",
      expect.objectContaining({ level: "error" }),
    );
  } finally {
    notice.mockRestore();
    await app.close();
  }
});

test("Q12 invalid repair arguments remain in the input without reaching the client", async () => {
  // Parsing failures belong to the typed input, not an SDK slash-command handler.
  const app = await mount();
  try {
    await app.submit("/repair cancel");

    expect(app.sent).toEqual([]);
    expect(app.input.value).toBe("/repair cancel");
    expect(app.captureCharFrame()).toContain("[INVALID_INPUT]");
    expect(app.view.promptDrafts.a1).toBe("/repair cancel");
  } finally {
    await app.close();
  }
});

test.each(["command", "template"] as const)(
  "Q12 a %s completion named repair cannot replace reserved typed input",
  async (kind) => {
    // A conflicting extension/template is present in the visible completion source.
    const items = [{ kind, value: "repair", description: "Conflicting user resource" }];
    const provider: CompletionProvider = Object.assign(
      async () => ok({ items, truncated: false }),
      {
        read: () => ok({ items, truncated: false }),
      },
    );
    const app = await mount(undefined, undefined, provider);
    try {
      app.scroll.scrollTo(10);
      await app.render();
      const top = app.scroll.scrollTop;

      await app.submit("/repair");

      // Enter preserves the exact host command and does not force transcript follow-latest.
      expect(app.sent).toEqual(["/repair"]);
      expect(app.input.value).toBe("");
      expect(app.scroll.scrollTop).toBe(top);
    } finally {
      await app.close();
    }
  },
);

test("new selects new tabs while preserving existing conversation, runs, reading positions, and selection", async () => {
  const app = await mount();
  try {
    pressLeader(app, "[");
    app.mockInput.pressKey("HOME");
    app.mockInput.pressEnter();
    app.mockInput.pressKey("v");
    app.mockInput.pressKey("l");
    await app.render();
    app.scroll.scrollTo(10);
    await app.render();
    pressLeader(app, "a");
    await app.render();

    const oldView = structuredClone(app.view.workViewPreferences.agentViews?.a1);
    const top = app.scroll.scrollTop;
    const original = app.details.a1;

    await app.submit("/new");

    expect(app.selection.sessionId).toBe("created");
    expect(app.selection.worktree?.sessions).toHaveLength(4);
    expect(app.createdFrom).toEqual(["a1"]);
    expect(app.sent).toEqual([]);
    expect(app.details.a1).toBe(original);
    expect(app.view.workViewPreferences.agentViews?.a1).toEqual(oldView);
    expect(app.view.workViewPreferences.agentScroll.a1).toBe(top);
    expect(app.input.value).toBe("");
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    expect(app.view.promptDrafts.a1).toBeUndefined();
    expect(app.view.promptDrafts.a2).toBe("Second draft");
    app.selection.selectSession("demo:main", "a1");
    await app.render();
    expect(app.scroll.scrollTop).toBe(top);
    expect(app.view.workViewPreferences.agentViews?.a1).toEqual(oldView);
  } finally {
    await app.close();
  }
});

test("New-tab failures preserve commands, drafts, and original tabs without model submission", async () => {
  const app = await mount(Promise.resolve(err(new InputError("Creation denied"))));
  try {
    await app.submit("/new");
    expect(app.selection.sessionId).toBe("a1");
    expect(app.selection.worktree?.sessions).toHaveLength(3);
    expect(app.input.value).toBe("/new");
    expect(app.details.a1?.conversationId).toBe("original");
    expect(app.sent).toEqual([]);
    expect(app.captureCharFrame()).toContain("Creation denied");
  } finally {
    await app.close();
  }
});

test.each(["a2", "b1"])(
  "Late new results after moving to %s never steal selection, drafts, or focus",
  async (target) => {
    const ready = Promise.withResolvers<Result<string, ExpectedError>>();
    const app = await mount(ready.promise);
    try {
      await app.submit("/new");
      app.selection.selectSession(target === "b1" ? "demo:feature" : "demo:main", target);
      await app.render();

      const focus = app.renderer.currentFocusedRenderable;
      const draft = app.input.value;

      ready.resolve(ok("created"));
      await app.render();
      expect(app.selection.sessionId).toBe(target);
      expect(app.input.value).toBe(draft);
      expect(app.renderer.currentFocusedRenderable).toBe(focus);
      expect(app.view.promptDrafts.a1).toBeUndefined();
      expect(
        app.selection.snapshot[0]!.worktrees[0]!.sessions.some(
          (session) => session.id === "created",
        ),
      ).toBe(true);
    } finally {
      ready.resolve(ok("created"));
      await app.render();
      await app.close();
    }
  },
);

test("Original drafts edited while awaiting new acceptance survive switching to created tabs", async () => {
  const ready = Promise.withResolvers<Result<string, ExpectedError>>();
  const app = await mount(ready.promise);
  try {
    await app.submit("/new");
    app.input.value = "Edited while creating";
    await app.render();
    ready.resolve(ok("created"));
    await app.render();
    expect(app.selection.sessionId).toBe("created");
    expect(app.input.value).toBe("");
    expect(app.view.promptDrafts.a1).toBe("Edited while creating");
    app.selection.selectSession("demo:main", "a1");
    await app.render();
    expect(app.input.value).toBe("Edited while creating");
  } finally {
    ready.resolve(ok("created"));
    await app.render();
    await app.close();
  }
});

test("clear resets only current conversation and navigation without creating tabs", async () => {
  const app = await mount();
  try {
    const count = app.selection.worktree!.sessions.length;
    await app.submit("/clear");
    expect(app.createdFrom).toEqual([]);
    expect(app.sent).toEqual(["/clear"]);
    expect(app.selection.sessionId).toBe("a1");
    expect(app.selection.worktree?.sessions).toHaveLength(count);
    expect(app.details.a1?.conversationId).toBe("cleared");
    expect(app.details.a1?.sections).toEqual([]);
    expect(app.input.value).toBe("");
    expect(app.view.promptDrafts.a2).toBe("Second draft");
    expect(app.view.workViewPreferences.agentViews?.a1).toMatchObject({
      selectedId: null,
      mode: "sections",
      follow: true,
    });
  } finally {
    await app.close();
  }
});
