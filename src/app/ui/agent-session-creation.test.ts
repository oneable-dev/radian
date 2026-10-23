import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { PromptInput } from "../../agents/ui/prompt-input.ts";
import { ok } from "../../result.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { Workbench } from "./workbench.ts";

type Creation = { worktreeId: string; onCreated: ((sessionId: string) => void) | undefined };

async function mount() {
  const app = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace());
  const creations: Creation[] = [], prompts: { id: string; text: string }[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession: (worktreeId: string, onCreated?: (sessionId: string) => void) => { creations.push({ worktreeId, onCreated }); },
    onCloseSession() {}, initialDrafts: { a1: "Original draft", a2: "Second draft", b1: "Feature draft" },
    onPrompt: (id, text) => { prompts.push({ id, text }); return ok(undefined); },
    getSessionDetails: id => ({ conversationId: id, status: null, output: `BODY-${id}`, error: null }),
  });
  const render = async () => {
    for (let index = 0; index < 12; index++) await Promise.resolve();
    await app.renderOnce(); await app.renderOnce();
  };
  await render();
  const input = app.renderer.root.findDescendantById("session-prompt");
  if (!(input instanceof PromptInput)) throw new Error("Missing session prompt");
  return { ...app, selection, view, input, creations, prompts, render,
    leader(key: string) { app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey(key); },
    async created(index: number, sessionId: string) {
      const request = creations[index];
      if (!request) throw new Error("Missing session creation request");
      selection.replaceSnapshot(selection.snapshot.map(repo => ({ ...repo, worktrees: repo.worktrees.map(tree => tree.id !== request.worktreeId ? tree : {
        ...tree, sessions: [...tree.sessions, { id: sessionId, name: "New session", status: null, subagents: [] }],
      }) })));
      request.onCreated?.(sessionId);
      await render();
    },
    async close() { view.dispose(); await app.dispose(); },
  };
}

test.each(["prompt", "session-strip"] as const)("Creating sessions from %s selects new tabs and input while preserving existing drafts", async source => {
  // Both creation entry points must target the new conversation, not the previous draft.
  const app = await mount();
  try {
    if (source === "session-strip") app.renderer.root.findDescendantById("agent-session-list")!.focus();

    // Creation is asynchronous, so edits made before it finishes must remain in the old session.
    app.leader("c");
    expect(app.creations.map(request => request.worktreeId)).toEqual(["demo:main"]);
    expect(app.selection.sessionId).toBe("a1");
    app.input.value = "Edited while creating";
    await app.created(0, "created");

    // The new session is immediately ready for typing, without an extra focus shortcut.
    expect(app.selection.sessionId).toBe("created");
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    expect(app.input.value).toBe("");
    expect(app.view.promptDrafts.a1).toBe("Edited while creating");
    expect(app.view.promptDrafts.a2).toBe("Second draft");
    expect(app.captureCharFrame()).toContain("BODY-created");
    await app.mockInput.typeText("New prompt"); app.mockInput.pressEnter(); await app.render();
    expect(app.prompts).toEqual([{ id: "created", text: "New prompt" }]);
  } finally { await app.close(); }
});

test("Prompt Ctrl+N neither creates sessions nor clears existing drafts", async () => {
  // Only leader sequences own creation; never intercept input editing keys.
  const app = await mount();
  try {
    // Deliver Ctrl+N to an in-progress prompt.
    app.mockInput.pressKey("n", { ctrl: true }); await app.render();

    // Preserve input and selection without creation requests.
    expect(app.creations).toEqual([]); expect(app.selection.sessionId).toBe("a1");
    expect(app.input.value).toBe("Original draft"); expect(app.renderer.currentFocusedRenderable).toBe(app.input);
  } finally { await app.close(); }
});

test("First-session creation in empty worktrees focuses input even after snapshot auto-selection", async () => {
  // An empty worktree initially has only the session strip as an Agent focus target.
  const app = await mount();
  try {
    app.selection.selectWorktree("demo:empty"); app.leader("a"); await app.render();
    expect(app.selection.sessionId).toBeNull();
    expect(app.captureCharFrame()).toContain("No AI sessions");
    expect(app.captureCharFrame()).toContain("<leader>c");

    // The snapshot arrives before the creation callback and already exposes the first session.
    app.leader("c"); await app.created(0, "first");

    // Initial snapshot selection must not be mistaken for navigation away from the request.
    expect(app.selection.sessionId).toBe("first");
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    expect(app.captureCharFrame()).toContain("BODY-first");
  } finally { await app.close(); }
});

test.each(["session", "worktree", "editor", "popup", "focus", "tab-roundtrip"] as const)("Moving to %s while creating sessions prevents late creation from stealing selection or focus", async target => {
  // The creation request belongs to the original view and keyboard owner.
  const app = await mount();
  try {
    app.leader("c");
    switch (target) {
      case "session": app.selection.selectSession("demo:main", "a2"); break;
      case "tab-roundtrip": app.leader("n"); app.leader("p"); break;
      case "worktree": app.selection.selectWorktree("demo:feature"); break;
      case "editor": app.leader("e"); break;
      case "popup": app.leader("b"); break;
      case "focus": app.renderer.root.findDescendantById("agent-session-list")!.focus(); break;
    }
    await app.render();
    const selected = app.selection.sessionId, tree = app.selection.worktree?.id;
    const focused = app.renderer.currentFocusedRenderable, draft = app.input.value;
    const views = app.view.workViewPreferences.active;

    // A successful background creation still adds its tab, but cannot restore its old UI context.
    await app.created(0, "background");

    expect(app.selection.snapshot.flatMap(repo => repo.worktrees).find(item => item.id === "demo:main")?.sessions.some(session => session.id === "background")).toBe(true);
    expect(app.selection.sessionId).toBe(selected); expect(app.selection.worktree?.id).toBe(tree);
    expect(app.renderer.currentFocusedRenderable).toBe(focused); expect(app.input.value).toBe(draft);
    expect(app.view.workViewPreferences.active).toEqual(views); expect(app.prompts).toEqual([]);
  } finally { await app.close(); }
});

test("Consecutive creations select the latest request's new session, not the first completed response", async () => {
  // Repeated shortcuts can leave multiple independent runtime creations in flight.
  const app = await mount();
  try {
    app.leader("c"); app.leader("c");

    // The earlier request completes first, before the latest request has its session ID.
    await app.created(0, "earlier");
    expect(app.selection.sessionId).toBe("a1");
    await app.created(1, "latest");

    // Only the most recent explicit creation owns the eventual focus handoff.
    expect(app.selection.sessionId).toBe("latest");
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    expect(app.selection.worktree?.sessions.map(session => session.id)).toEqual(["a1", "a2", "a3", "earlier", "latest"]);
  } finally { await app.close(); }
});
