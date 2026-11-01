import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { homedir } from "node:os";
import { CHAT_SCOPE_ID } from "../../agents/session-scope.ts";
import type { PromptDraft } from "../../agents/prompt-input.ts";
import type { ChatCollection, WorkView } from "../../runtime/protocol.ts";
import { CapabilityError } from "../../errors.ts";
import { err, ok } from "../../result.ts";
import { pressLeader } from "../../testing/keys.ts";
import { PromptInput } from "../../ui/prompt-input.ts";
import type { Repository, Worktree } from "../../workspace/model.ts";
import type { UiState } from "../ui-state.ts";
import { initialView, WorkspaceDeletions } from "../workspace-deletion.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { Workbench, type WorkbenchActions } from "./workbench.ts";

function worktree(id: string, sessions: readonly string[]): Worktree {
  return {
    id,
    path: `/fixture/${id}`,
    name: id,
    branch: id,
    sessions: sessions.map((session) => ({
      id: session,
      name: `Session ${session}`,
      status: null,
      subagents: [],
    })),
  };
}

const workspace = (...trees: Worktree[]): Repository[] => [
  { id: "repo", name: "repo", worktrees: trees },
];

const chatWith = (ids: readonly string[]): ChatCollection => ({
  id: CHAT_SCOPE_ID,
  path: homedir(),
  name: "CHAT",
  sessions: ids.map((id) => ({ id, name: `Conversation ${id}`, status: null, subagents: [] })),
  details: {},
  historyRevision: 0,
  accountsRevision: 0,
  closingCount: 0,
});

type Mount = {
  repositories?: Repository[];
  chat?: ChatCollection;
  initialView?: "chat" | WorkView;
  initialChatSessionId?: string | null;
  initialDrafts?: Record<string, string>;
  // Prompts stay pending until the test settles them.
  holdPrompts?: (() => void)[];
  // Session IDs kept open although absent from the catalog, like drafts of cold scopes.
  retained?: string[];
};

// Mounts the actual Workbench with daemon-shaped callbacks and records every side effect.
async function mount(options: Mount = {}) {
  const app = await createTestRenderer({ width: 120, height: 28, kittyKeyboard: true });
  const selection = new WorkspaceSelection(
    options.repositories ?? workspace(worktree("w1", ["s1"]), worktree("w2", ["s2"])),
  );
  const chat = options.chat ?? chatWith(["chat-1"]);
  const effects: string[] = [];
  const drafts: Record<string, string>[] = [];
  const views: string[] = [];
  const actions: WorkbenchActions = {
    getChat: () => chat,
    initialView: options.initialView ?? "agent",
    initialChatSessionId: options.initialChatSessionId ?? "chat-1",
    ...(options.initialDrafts ? { initialDrafts: options.initialDrafts } : {}),
    onViewChange: (view) => views.push(view),
    onNewSession: (scope) => effects.push(`create:${scope}`),
    onCloseSession: (scope, id) => effects.push(`close:${scope}:${id}`),
    onPrompt: (id, text) => {
      effects.push(`prompt:${id}:${text}`);
      const held = options.holdPrompts;
      return held
        ? new Promise((resolve) => held.push(() => resolve(ok(undefined))))
        : ok(undefined);
    },
    onDraftChange: (next: Record<string, string>, _inputs: Record<string, PromptDraft>) => {
      drafts.push(next);
    },
    getSessionDetails: () => ({ status: "complete", output: "", error: null }),
    getRetainedSessionIds: () => new Set(options.retained ?? []),
    editor: {
      info: () => undefined,
      open: async (id) => {
        effects.push(`editor:${id}`);
        return ok("editor");
      },
      attach: async () => err(new CapabilityError("Fixture editors never attach.")),
    },
    terminal: {
      list: () => [],
      create: async (id) => {
        effects.push(`terminal:${id}`);
        return ok("terminal");
      },
      attach: async () => err(new CapabilityError("Fixture terminals never attach.")),
      close: async () => ok(undefined),
    },
  };
  const view = new Workbench(app.renderer, selection, actions);
  const render = async () => {
    for (let index = 0; index < 5; index++) await Promise.resolve();
    await app.renderOnce();
    await app.renderOnce();
  };
  await render();
  const prompt = app.renderer.root.findDescendantById("session-prompt") as PromptInput;

  return {
    ...app,
    selection,
    view,
    prompt,
    effects,
    drafts,
    views,
    render,
    // Applies an explicit deletion the way bootstrap does: forget first, then the new catalog.
    async deleteWorktrees(ids: string[], sessionIds: string[], next: Repository[]) {
      const deletion = { worktreeIds: new Set(ids), sessionIds: new Set(sessionIds) };
      view.forgetWorkspaces(deletion);
      selection.forget(deletion);
      selection.replaceSnapshot(next);
      await render();
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test.each([
  ["w1", "w2"],
  ["w2", "w3"],
  ["w3", "w2"],
])("Deleting selected worktree %s shows survivor %s in the Agent view", async (deleted, next) => {
  const trees = ["w1", "w2", "w3"].map((id) => worktree(id, [`${id}-s`]));
  // The retained set may still list the deleted session until the client processes the receipt.
  const app = await mount({ repositories: workspace(...trees), retained: [`${deleted}-s`] });
  try {
    app.selection.selectWorktree(deleted);
    await app.render();
    app.prompt.focus();
    await app.mockInput.typeText("deleted draft");
    await app.render();

    await app.deleteWorktrees(
      [deleted],
      [`${deleted}-s`],
      workspace(...trees.filter((tree) => tree.id !== deleted)),
    );

    // The survivor's session is displayed; the deleted draft is gone from memory and callbacks.
    expect(app.selection.worktree?.id).toBe(next);
    expect(app.view.currentView).toBe("agent");
    expect(app.captureCharFrame()).toContain(`${next}-s`);
    expect(app.captureCharFrame()).not.toContain(`${deleted}-s`);
    expect(app.prompt.value).toBe("");
    expect(app.view.promptDrafts).toEqual({});
    expect(app.drafts.at(-1)).not.toHaveProperty(`${deleted}-s`);
    expect(app.effects).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Deleting another worktree keeps the selected session, its draft, caret and focus", async () => {
  const app = await mount();
  try {
    app.prompt.focus();
    await app.mockInput.typeText("keep this");
    app.prompt.cursorOffset = 4;
    await app.render();

    await app.deleteWorktrees(["w2"], ["s2"], workspace(worktree("w1", ["s1"])));

    expect(app.selection.sessionId).toBe("s1");
    expect(app.prompt.value).toBe("keep this");
    expect(app.prompt.cursorOffset).toBe(4);
    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    expect(app.view.promptDrafts).toEqual({ s1: "keep this" });
  } finally {
    await app.close();
  }
});

test.each(["agent", "editor", "git", "terminal"] as const)(
  "Deleting the last workspace from the %s view reuses the existing CHAT conversation",
  async (code) => {
    const app = await mount({
      repositories: workspace(worktree("w1", ["s1"])),
      initialView: "chat",
      initialDrafts: { "chat-1": "CHAT draft" },
    });
    try {
      pressLeader(app, code[0]!);
      await app.render();
      expect(app.view.currentView).toBe(code);
      app.effects.length = 0;

      await app.deleteWorktrees(["w1"], ["s1"], []);

      // The existing CHAT conversation and its draft return without creating or sending anything.
      expect(app.view.currentView).toBe("chat");
      expect(app.view.chatSessionId).toBe("chat-1");
      expect(app.prompt.value).toBe("CHAT draft");
      expect(app.prompt.visible).toBe(true);
      expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
      expect(app.effects).toEqual([]);
      expect(app.views.at(-1)).toBe("chat");
    } finally {
      await app.close();
    }
  },
);

test("Deleting the last workspace with no conversations shows the existing empty CHAT state", async () => {
  const app = await mount({
    repositories: workspace(worktree("w1", ["s1"])),
    chat: chatWith([]),
    initialChatSessionId: null,
  });
  try {
    await app.deleteWorktrees(["w1"], ["s1"], []);

    expect(app.view.currentView).toBe("chat");
    expect(app.captureCharFrame()).toContain("No conversations");
    expect(app.effects).toEqual([]);
  } finally {
    await app.close();
  }
});

test("An active CHAT view keeps its conversation, draft, caret, focus and open search", async () => {
  const app = await mount({ initialView: "chat" });
  try {
    app.prompt.focus();
    await app.mockInput.typeText("CHAT input");
    app.prompt.cursorOffset = 2;
    await app.render();
    pressLeader(app, "b");
    await app.mockInput.typeText("w");
    await app.render();
    const search = app.renderer.currentFocusedRenderable;

    await app.deleteWorktrees(["w1", "w2"], ["s1", "s2"], []);

    expect(app.view.currentView).toBe("chat");
    expect(app.view.chatSessionId).toBe("chat-1");
    expect(app.renderer.currentFocusedRenderable).toBe(search);
    expect(app.renderer.root.findDescendantById("workspace-picker")!.visible).toBe(true);
    expect(app.captureCharFrame()).toContain("> w");
    expect(app.prompt.value).toBe("CHAT input");
    expect(app.prompt.cursorOffset).toBe(2);
    expect(app.views).toEqual([]);
    expect(app.effects).toEqual([]);

    // Ordinary keyboard input still edits the CHAT draft literally after the popup closes.
    app.mockInput.pressEscape();
    await app.render();
    app.prompt.focus();
    await app.mockInput.typeText("jk");
    expect(app.prompt.value).toBe("CHjkAT input");
  } finally {
    await app.close();
  }
});

test("An attachment preview of a deleted session closes while unrelated dialogs stay open", async () => {
  const app = await mount({
    repositories: workspace(worktree("w1", ["s1"]), worktree("w2", ["s2"])),
  });
  try {
    app.prompt.focus();
    app.prompt.attachFile("/fixture/w1/notes.txt");
    app.prompt.cursorOffset = 0;
    await app.render();
    app.mockInput.pressKey("o", { ctrl: true });
    await app.render();
    const dialog = app.renderer.root.findDescendantById("text-dialog")!;
    expect(dialog.visible).toBe(true);

    await app.deleteWorktrees(["w1"], ["s1"], workspace(worktree("w2", ["s2"])));

    expect(dialog.visible).toBe(false);
    expect(app.selection.worktree?.id).toBe("w2");
  } finally {
    await app.close();
  }
});

test("A recreated worktree is a new generation without the old draft or session", async () => {
  const app = await mount({ repositories: workspace(worktree("w1", ["s1"])) });
  try {
    app.prompt.focus();
    await app.mockInput.typeText("old generation");
    await app.render();

    // The path is recreated and the daemon reopens the same worktree ID with a fresh session.
    await app.deleteWorktrees(["w1"], ["s1"], workspace(worktree("w1", ["fresh"])));

    expect(app.selection.worktree?.id).toBe("w1");
    expect(app.selection.sessionId).toBe("fresh");
    expect(app.prompt.value).toBe("");
    expect(app.view.promptDrafts).toEqual({});

    // A stale snapshot that still lists the old session never selects or revives it.
    app.selection.replaceSnapshot(workspace(worktree("w1", ["s1", "fresh"])));
    app.selection.selectSession("w1", "s1");
    await app.render();
    expect(app.selection.sessionId).toBe("fresh");
    expect(app.view.promptDrafts).not.toHaveProperty("s1");
  } finally {
    await app.close();
  }
});

test("A submission settling after its session was deleted publishes nothing for it", async () => {
  const held: (() => void)[] = [];
  const app = await mount({
    repositories: workspace(worktree("w1", ["s1"]), worktree("w2", ["s2"])),
    holdPrompts: held,
  });
  try {
    app.prompt.focus();
    await app.mockInput.typeText("pending prompt");
    app.mockInput.pressEnter();
    await app.render();
    expect(app.effects).toEqual(["prompt:s1:pending prompt"]);

    await app.deleteWorktrees(["w1"], ["s1"], workspace(worktree("w2", ["s2"])));
    app.prompt.focus();
    await app.mockInput.typeText("next");
    await app.render();
    const published = app.drafts.length;

    // The accepted request settles late; it neither republishes nor restores the deleted draft.
    held.shift()?.();
    await app.render();

    expect(app.drafts.length).toBe(published);
    for (const drafts of app.drafts.slice(-2)) {
      expect(drafts).not.toHaveProperty("s1");
    }
    expect(app.view.promptDrafts).toEqual({ s2: "next" });
    expect(app.view.promptInputDrafts).not.toHaveProperty("s1");
    expect(app.prompt.value).toBe("next");
  } finally {
    await app.close();
  }
});

test("Deleting another repository's historical path keeps the repository that reuses it", async () => {
  // Repository A was deleted; its old worktree path `/x` now belongs to repository B.
  const reused = { ...worktree("/x", ["newB"]), path: "/x" };
  const repositories: Repository[] = [{ id: "/b/.git", name: "b", worktrees: [reused] }];
  const app = await mount({ repositories });
  const state: UiState = {
    version: 1,
    view: "agent",
    chatSessionId: "chat-1",
    preferences: {
      selection: { worktreeId: "/x", sessions: { "/x": "newB" } },
      drafts: { oldA: "A draft" },
    },
    sessionScopes: { oldA: "/x" },
  };
  const deletions = new WorkspaceDeletions(state, undefined, 0);
  try {
    app.prompt.focus();
    await app.mockInput.typeText("B draft");
    app.prompt.cursorOffset = 2;
    await app.render();

    deletions.apply(
      {
        revision: 1,
        scopes: [
          {
            token: "cleanup-token-a",
            repositoryId: "/a/.git",
            kind: "repository",
            worktreeIds: ["/x"],
            sessionIds: ["oldA"],
            revision: 1,
            state: "complete",
          },
        ],
      },
      repositories,
      { selection: app.selection, view: app.view, persist: () => {} },
    );
    await app.render();

    expect(app.selection.worktree?.id).toBe("/x");
    expect(app.selection.sessionId).toBe("newB");
    expect(app.view.currentView).toBe("agent");
    expect(app.prompt.value).toBe("B draft");
    expect(app.prompt.cursorOffset).toBe(2);
    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    expect(app.view.promptDrafts).toEqual({ newB: "B draft" });
    expect(state.preferences.drafts).toEqual({});
    expect(app.effects).toEqual([]);
  } finally {
    await app.close();
  }
});

test("A Code view reconnecting after its last workspace was deleted mounts the existing CHAT", async () => {
  // Bootstrap resolved the initial view from the persisted deleted-selection marker.
  const app = await mount({
    repositories: [],
    initialView: initialView("agent", true, []),
    initialDrafts: { "chat-1": "CHAT draft" },
  });
  try {
    expect(app.view.currentView).toBe("chat");
    expect(app.view.chatSessionId).toBe("chat-1");
    expect(app.prompt.value).toBe("CHAT draft");
    expect(app.effects).toEqual([]);
  } finally {
    await app.close();
  }
});
