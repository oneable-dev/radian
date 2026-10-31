import { expect, test } from "bun:test";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { ScrollBoxRenderable } from "@opentui/core";
import { homedir } from "node:os";
import { CHAT_SCOPE_ID } from "../../agents/session-scope.ts";
import type { HistoryItem } from "../../agents/history.ts";
import type { ChatCollection } from "../../runtime/protocol.ts";
import type { CompletionProvider } from "../../agents/completion-cache.ts";
import { filterCatalog } from "../../agents/completion.ts";
import { PromptInput } from "../../ui/prompt-input.ts";
import { SearchInput } from "../../ui/search-input.ts";
import { submitPromptCommand } from "../../testing/keys.ts";
import { ok } from "../../result.ts";
import { parseKeymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { Workbench, type WorkbenchActions } from "./workbench.ts";

const sessions = demoWorkspace()[0]!
  .worktrees[0]!.sessions.slice(0, 2)
  .map((session, index) => ({
    ...session,
    id: `chat-${index + 1}`,
    name: `Conversation ${index + 1}`,
  }));
const chat: ChatCollection = {
  id: CHAT_SCOPE_ID,
  path: homedir(),
  name: "CHAT",
  sessions,
  details: {},
  historyRevision: 0,
  accountsRevision: 0,
  closingCount: 0,
};
const items: HistoryItem[] = sessions.map((session, index) => ({
  id: `canonical-${index + 1}`,
  worktreeId: CHAT_SCOPE_ID,
  title: session.name,
  modified: "2026-01-01T00:00:00Z",
  messageCount: 2,
  openSessionId: session.id,
  unavailableReason: null,
}));

async function mount(options: Partial<WorkbenchActions> = {}, repositories = demoWorkspace()) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 120, height: 27, kittyKeyboard: true, clock });
  const selection = new WorkspaceSelection(repositories);
  const created: string[] = [];
  const resumed: string[] = [];
  const views: string[] = [];
  const selected: (string | null)[] = [];
  const state = new Map(sessions.map((session, index) => [session.id, `canonical-${index + 1}`]));
  const view = new Workbench(app.renderer, selection, {
    getChat: () => chat,
    initialView: "chat",
    initialChatSessionId: sessions[0]!.id,
    onViewChange: (current) => views.push(current),
    onChatSessionChange: (id) => selected.push(id),
    onNewSession: (scope, done) => {
      created.push(scope);
      done?.("new-chat");
    },
    onCloseSession() {},
    onPrompt: () => ok(undefined),
    getSessionDetails: (id) => ({
      ...(state.get(id) ? { conversationId: state.get(id)! } : {}),
      status: "complete",
      output: "Answer",
      error: null,
    }),
    onListHistory: async () => ok(items),
    onPreviewHistory: async (scope, id) =>
      ok({
        id,
        worktreeId: scope,
        text: "Preview answer",
        truncated: false,
      }),
    onResumeSession: async (scope, id) => {
      resumed.push(`${scope}:${id}`);
      return ok(sessions.find((session) => state.get(session.id) === id)!.id);
    },
    ...options,
  });
  const render = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await app.renderOnce();
    await app.renderOnce();
  };
  const leader = (key: string) => {
    app.mockInput.pressKey(" ", { ctrl: true });
    app.mockInput.pressKey(key);
  };
  await render();
  return {
    ...app,
    clock,
    selection,
    view,
    state,
    created,
    resumed,
    views,
    selected,
    render,
    leader,
    async openHistory() {
      submitPromptCommand(app, "/history");
      await render();
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test("CHAT shows one conversation without a session strip and AGENT restores its session tabs", async () => {
  // CHAT is selected independently of the worktree's AGENT tab and has no tab chrome.
  const app = await mount();
  try {
    expect(app.view.currentView).toBe("chat");
    expect(app.view.chatSessionId).toBe("chat-1");
    expect(app.renderer.root.findDescendantById("agent-session-tabs")!.visible).toBe(false);
    expect(app.captureCharFrame()).toContain("CHAT");
    expect(app.captureCharFrame().split("\n")[26]).toContain("<leader>b Workspace");
    expect(app.renderer.root.findDescendantById("footer-workspace")!.visible).toBe(false);

    // An AGENT view remains selectable without changing CHAT's remembered conversation.
    app.leader("a");
    await app.render();
    expect(app.view.currentView).toBe("agent");
    expect(app.selection.sessionId).toBe("a1");
    expect(app.renderer.root.findDescendantById("agent-session-tabs")!.visible).toBe(true);
    expect(app.captureCharFrame().split("\n")[26]?.trimStart()).toStartWith("AGENT");
    app.leader("m");
    await app.render();
    expect(app.view.currentView).toBe("chat");
    expect(app.view.chatSessionId).toBe("chat-1");
    expect(app.views).toEqual(["agent", "chat"]);
  } finally {
    await app.close();
  }
});

test.each([
  ["a", "agent"],
  ["e", "editor"],
  ["g", "git"],
  ["t", "terminal"],
] as const)("CHAT shortcut returns directly from %s and never toggles back", async (key, view) => {
  // Every project view must return to the same app-scoped conversation and draft.
  const app = await mount();
  try {
    const input = app.renderer.root.findDescendantById("session-prompt") as PromptInput;
    await app.mockInput.typeText("message draft");
    app.leader(key);
    await app.render();
    expect(app.view.currentView).toBe(view);

    // Repeating the CHAT command is idempotent, not a mode toggle or literal input.
    app.leader("m");
    await app.render();
    app.leader("m");
    await app.render();

    expect(app.view.currentView).toBe("chat");
    expect(app.view.chatSessionId).toBe("chat-1");
    expect(input.value).toBe("message draft");
    expect(app.views).toEqual([view, "chat"]);
    expect(app.selection.worktree?.id).toBe("demo:main");
    expect(app.renderer.root.findDescendantById("work-view-tabs")).toBeUndefined();
  } finally {
    await app.close();
  }
});

test("Explicit legacy CHAT shortcuts keep direct navigation after the default changes", async () => {
  // User mappings keep the same view.chat command even when its default becomes m.
  const keymap = expectOk(parseKeymap({ bindings: { "view.chat": ["<leader> q"] } }));
  const app = await mount({ keymap });
  try {
    app.leader("a");
    await app.render();

    // The configured legacy key selects CHAT once and remains idempotent afterwards.
    app.leader("q");
    await app.render();
    app.leader("q");
    await app.render();

    expect(app.view.currentView).toBe("chat");
    expect(app.view.chatSessionId).toBe("chat-1");
    expect(app.views).toEqual(["agent", "chat"]);
    expect(keymap.hint("view.chat", "prompt")).toBe("<leader>q");
  } finally {
    await app.close();
  }
});

test("CHAT remains usable without any repository or selected worktree", async () => {
  // CHAT must not inherit AGENT's repository prerequisite for prompting or browsing.
  const app = await mount({}, []);
  try {
    expect(app.selection.worktree).toBeNull();
    expect(app.view.currentView).toBe("chat");
    expect(app.renderer.root.findDescendantById("session-prompt")!.visible).toBe(true);
    expect(app.captureCharFrame()).toContain("CHAT");
    await app.openHistory();
    expect(app.captureCharFrame()).toContain("Conversation 2");
  } finally {
    await app.close();
  }
});

test("CHAT and AGENT preserve separate composer caret, attachments and scroll when views switch", async () => {
  // Switching the shared renderer must save each session's input state without changing the running executor.
  const app = await mount();
  try {
    const input = app.renderer.root.findDescendantById("session-prompt") as PromptInput;
    const scroll = app.renderer.root.findDescendantById(
      "session-transcript",
    ) as ScrollBoxRenderable;
    input.value = "CHAT draft ";
    input.attachFile("/tmp/chat-attachment.txt");
    input.cursorOffset = 3;
    await app.render();
    const chatDraft = input.draft;
    const chatScroll = scroll.scrollTop;

    app.leader("a");
    await app.render();
    input.value = "AGENT draft";
    input.cursorOffset = 2;
    await app.render();
    app.leader("m");
    await app.render();

    expect(input.draft).toEqual(chatDraft);
    expect(scroll.scrollTop).toBe(chatScroll);
    expect(app.view.promptInputDrafts.a1?.value).toBe("AGENT draft");
    expect(app.view.promptInputDrafts.a1?.cursor).toBe(2);
    expect(app.selection.sessionId).toBe("a1");
  } finally {
    await app.close();
  }
});

test("CHAT history excludes the current canonical conversation from candidates and counts until Enter", async () => {
  // The selected live conversation has a canonical ID different from its UI session ID.
  const app = await mount();
  try {
    await app.openHistory();
    const frame = app.captureCharFrame();
    expect(frame).toContain("Conversation 2");
    expect(frame).not.toContain("Conversation 1");
    expect(frame).toContain("1/1");
    expect(app.view.chatSessionId).toBe("chat-1");
    expect(app.resumed).toEqual([]);

    // Browsing and Escape must not commit the conversation.
    app.mockInput.pressEscape();
    await app.render();
    expect(app.view.chatSessionId).toBe("chat-1");
    await app.openHistory();
    app.mockInput.pressEnter();
    await app.render();
    expect(app.resumed).toEqual([`${CHAT_SCOPE_ID}:canonical-2`]);
    expect(app.view.chatSessionId).toBe("chat-2");
    expect(app.selected).toEqual(["chat-2"]);
  } finally {
    await app.close();
  }
});

test("CHAT history includes every conversation without a selection and shows empty when only current exists", async () => {
  // An explicit shortcut can browse without a prompt or implicitly selecting a conversation.
  const none = await mount({
    initialChatSessionId: null,
    keymap: expectOk(parseKeymap({ bindings: { "history.show": ["<leader> h"] } })),
  });
  try {
    none.leader("h");
    await none.render();
    expect(none.view.chatSessionId).toBeNull();
    expect(none.captureCharFrame()).toContain("Conversation 1");
    expect(none.captureCharFrame()).toContain("Conversation 2");
    expect(none.captureCharFrame()).toContain("2/2");
  } finally {
    await none.close();
  }

  const onlyCurrent = await mount({ onListHistory: async () => ok([items[0]!]) });
  try {
    await onlyCurrent.openHistory();
    expect(onlyCurrent.captureCharFrame()).toContain("No other conversations");
    expect(onlyCurrent.captureCharFrame()).toContain("0/0");
  } finally {
    await onlyCurrent.close();
  }
});

test("CHAT history reacts to canonical identity changes without mutating shared candidates", async () => {
  // Replacing the canonical identity of the displayed executor should update exclusion immediately.
  const app = await mount();
  try {
    await app.openHistory();
    app.state.set("chat-1", "canonical-2");
    app.view.refreshPreloadedData();
    await app.render();
    const frame = app.captureCharFrame();
    expect(frame).toContain("Conversation 1");
    expect(frame).not.toContain("Conversation 2");
    expect(frame).toContain("1/1");
    expect(items).toHaveLength(2);
  } finally {
    await app.close();
  }
});

test("CHAT treats @ literally without claiming Tab or Esc while commands and skills still complete", async () => {
  // A deliberately file-capable provider must not receive CHAT file lookups or prepare a file index.
  const prepared: boolean[] = [];
  const lookups: string[] = [];
  const provider = Object.assign(
    async (_id: string, query: Parameters<CompletionProvider>[1]) => {
      lookups.push(query.kind);
      return ok(
        filterCatalog(
          [
            { kind: "file", value: "needle", description: "File" },
            { kind: "command", value: "help", description: "Help" },
            { kind: "skill", value: "skill:review-code", description: "Review" },
          ],
          query,
        ),
      );
    },
    {
      prepare: (_id: string, _cwd: string, options?: { files?: boolean }) =>
        prepared.push(options?.files !== false),
    },
  );
  const app = await mount({ onComplete: provider });
  try {
    const input = app.renderer.root.findDescendantById("session-prompt") as PromptInput;
    input.focus();
    await app.mockInput.typeText("@needle");
    await app.render();
    expect(app.renderer.root.findDescendantById("prompt-completions")!.visible).toBe(false);
    expect(lookups).toEqual([]);
    app.mockInput.pressTab();
    await app.render();
    expect(input.value).toBe("@needle");
    input.focus();
    app.mockInput.pressEscape();
    await app.render();
    expect(input.value).toBe("@needle");
    expect(prepared).toContain(false);

    input.value = "/he";
    input.focus();
    await app.render();
    app.clock.advance(150);
    await app.render();
    expect(lookups).toContain("command");
    expect(app.captureCharFrame()).toContain("Help");
    input.value = "$rev";
    await app.render();
    app.clock.advance(150);
    await app.render();
    expect(lookups).toContain("skill");
    expect(app.captureCharFrame()).toContain("review-code");
  } finally {
    await app.close();
  }
});

test("Session monitor can open running CHAT work without a workspace lookup", async () => {
  // Monitoring is global even when AGENT is displayed, and CHAT remains a workspace-free scope.
  const app = await mount();
  try {
    app.leader("a");
    await app.render();
    app.leader("s");
    await app.render();
    const search = app.renderer.root.findDescendantById("monitor-search") as SearchInput;
    search.value = "CHAT";
    await app.render();
    expect(app.captureCharFrame()).toContain("Conversation 1");
    expect(app.captureCharFrame()).not.toContain("detached HEAD");
    app.mockInput.pressEnter();
    await app.render();
    expect(app.view.currentView).toBe("chat");
    expect(app.view.chatSessionId).toBe("chat-1");
  } finally {
    await app.close();
  }
});

test("Opening a CHAT completion notification selects its conversation without a worktree", async () => {
  // Notifications may arrive while AGENT is displayed; only explicit activation switches the app view.
  const app = await mount();
  try {
    app.leader("a");
    await app.render();
    app.view.notifySession({
      id: "chat-notification",
      sessionId: "chat-2",
      worktreeId: CHAT_SCOPE_ID,
      conversationId: "canonical-2",
      repository: "CHAT",
      worktree: "CHAT",
      branch: null,
      result: { id: "chat-result", outcome: "complete", completedAt: 1234 },
    });
    await app.render();
    expect(app.view.currentView).toBe("agent");
    const toast = app.renderer.root.findDescendantById("session-toast:chat-notification")!;
    await app.mockMouse.click(toast.x + 2, toast.y + 1);
    await app.render();
    expect(app.view.currentView).toBe("chat");
    expect(app.view.chatSessionId).toBe("chat-2");
    expect(app.selection.sessionId).toBe("a1");
  } finally {
    await app.close();
  }
});

test("Changing worktrees restores the actual work view and lets new AGENT sessions take focus", async () => {
  // Worktree-local pane state must agree with app navigation after leaving an Editor worktree.
  let scope: string | undefined;
  let created: ((id: string) => void) | undefined;
  const app = await mount({
    onNewSession: (id, done) => {
      scope = id;
      created = done;
    },
  });
  try {
    app.leader("e");
    await app.render();
    expect(app.view.currentView).toBe("editor");

    app.selection.selectWorktree("demo:feature");
    await app.render();
    expect(app.view.currentView).toBe("agent");
    expect(app.views.at(-1)).toBe("agent");
    app.leader("c");
    await app.render();
    app.selection.replaceSnapshot(
      app.selection.snapshot.map((repository) => ({
        ...repository,
        worktrees: repository.worktrees.map((tree) =>
          tree.id === "demo:feature"
            ? {
                ...tree,
                sessions: [
                  ...tree.sessions,
                  { id: "new-code", name: "Created", status: null, subagents: [] },
                ],
              }
            : tree,
        ),
      })),
    );
    created?.("new-code");
    await app.render();

    expect(scope).toBe("demo:feature");
    expect(app.selection.sessionId).toBe("new-code");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
  } finally {
    await app.close();
  }
});

test("Workspace activation preserves the app-scoped CHAT conversation and draft", async () => {
  // Workspaces share CHAT, while each keeps its own project-view selection.
  const app = await mount();
  try {
    const input = app.renderer.root.findDescendantById("session-prompt") as PromptInput;
    input.value = "Shared CHAT draft";
    input.cursorOffset = 5;
    await app.render();

    app.leader("b");
    await app.render();
    app.mockInput.pressKey("n", { ctrl: true });
    app.mockInput.pressEnter();
    app.mockInput.pressEnter();
    await app.render();

    expect(app.selection.worktree?.id).toBe("demo:feature");
    expect(app.view.currentView).toBe("agent");
    expect(app.view.chatSessionId).toBe("chat-1");

    // Returning from another workspace must not create a workspace-specific CHAT.
    app.leader("m");
    await app.render();

    expect(app.view.currentView).toBe("chat");
    expect(app.view.chatSessionId).toBe("chat-1");
    expect(input.value).toBe("Shared CHAT draft");
    expect(input.cursorOffset).toBe(5);
    expect(app.selection.worktree?.id).toBe("demo:feature");
    expect(app.renderer.root.findDescendantById("footer-workspace")!.visible).toBe(false);
  } finally {
    await app.close();
  }
});

test("CHAT creation uses the canonical scope and cannot claim focus after switching to AGENT", async () => {
  // The request is accepted asynchronously while the user explicitly changes views.
  let done: ((id: string) => void) | undefined;
  const app = await mount({
    onNewSession: (scope, callback) => {
      expect(scope).toBe(CHAT_SCOPE_ID);
      done = callback;
    },
  });
  try {
    app.leader("c");
    app.leader("a");
    await app.render();
    done?.("chat-2");
    await app.render();
    expect(app.view.currentView).toBe("agent");
    expect(app.view.chatSessionId).toBe("chat-1");
    expect(app.selection.sessionId).toBe("a1");

    // Returning to the same CHAT input does not revive an older creation's focus claim.
    app.leader("m");
    await app.render();
    app.leader("c");
    app.leader("a");
    app.leader("m");
    await app.render();
    done?.("chat-2");
    await app.render();
    expect(app.view.currentView).toBe("chat");
    expect(app.view.chatSessionId).toBe("chat-1");
  } finally {
    await app.close();
  }
});
