import { openWorkspaceSearch, pressLeader } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { join } from "node:path";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { SessionRegistry } from "../../agents/session-registry.ts";
import { piSessionFactory } from "../../agents/pi-session-adapter.ts";
import { offlineRuntime } from "../../testing/offline-runtime.ts";
import { createWorktreeFixture } from "../../testing/worktree-fixture.ts";
import { Workbench } from "./workbench.ts";
import { icons } from "../../icons.ts";
import { expectOk } from "../../testing/results.ts";
import { ok, type Result } from "../../result.ts";
import type { ExpectedError } from "../../errors.ts";

async function mount() {
  const fixture = await createWorktreeFixture();
  const registry = new SessionRegistry([fixture.repository], piSessionFactory(await offlineRuntime(join(fixture.directory, "agent"))));
  const setup = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
  const selection = new WorkspaceSelection(registry.snapshot);
  const creation: Promise<string>[] = [];
  const prompts: { id: string; text: string; done: Promise<void>; accepted: Promise<Result<void, ExpectedError>> }[] = [];
  const closes: Promise<void>[] = [];
  const view = new Workbench(setup.renderer, selection, {
    onNewSession: (id, onCreated) => { creation.push(registry.create(id).then(result => {
      const sessionId = expectOk(result); onCreated?.(sessionId); return sessionId;
    })); },
    onCloseSession: (_tree, id) => { closes.push(registry.close(id).then(expectOk)); },
    onPrompt: (id, text) => {
      const accepted = Promise.withResolvers<Result<void, ExpectedError>>();
      const run = registry.prompt(id, text, () => accepted.resolve(ok(undefined)));
      prompts.push({ id, text, accepted: accepted.promise, done: run.then((result) => {
        accepted.resolve(result);
        if (!result.ok && result.error.code !== "CANCELLED") expectOk(result);
      }) });
      return accepted.promise;
    },
    getSessionDetails: (id) => registry.details(id),
  });
  const unsubscribe = registry.subscribe(() => selection.replaceSnapshot(registry.snapshot));
  await setup.renderOnce();
  return { ...setup, ...fixture, registry, selection, creation, prompts, closes, view,
    async click(text: string) {
      if (text.startsWith(icons.folder)) { openWorkspaceSearch(setup); setup.mockInput.pressCtrlC(); await setup.renderOnce(); }
      const lines = setup.captureCharFrame().split("\n");
      const y = lines.findIndex((line) => line.includes(text));
      const x = lines[y]?.indexOf(text) ?? -1;
      if (x < 0 || y < 0) throw new Error(`Missing visible text: ${text}\n${setup.captureCharFrame()}`);
      await setup.mockMouse.click(x, y); await setup.renderOnce();
    },
    async newSession() {
      setup.renderer.root.findDescendantById("agent-session-list")!.focus();
      setup.mockInput.pressKey(" ", { ctrl: true }); setup.mockInput.pressKey("c");
      const id = await creation.at(-1)!; await setup.renderOnce(); return id;
    },
    async send(text: string) {
      pressLeader(setup, "a"); await setup.mockInput.typeText(text);
      setup.mockInput.pressEnter(); await prompts.at(-1)!.done; await setup.renderOnce();
    },
    async closeApp() { unsubscribe(); view.dispose(); await registry.shutdown(); await setup.dispose(); await fixture.cleanup(); },
  };
}

test("Adding real SDK sessions focuses new input and preserves previous drafts", async () => {
  // The runtime publishes the new session before handing its ID back to the UI.
  const app = await mount();
  try {
    const original = await app.newSession();
    await app.mockInput.typeText("Keep original draft");

    // Creating another session must make typing target the new SDK session immediately.
    const created = await app.newSession();
    await app.mockInput.typeText("read"); app.mockInput.pressEnter();
    await app.prompts.at(-1)!.done; await app.renderOnce();

    // The old draft remains local to its session, while only the new session receives the prompt.
    expect(app.selection.sessionId).toBe(created);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
    expect(app.prompts.map(prompt => prompt.id)).toEqual([created]);
    expect(app.view.promptDrafts[original]).toBe("Keep original draft");
    expect(app.captureCharFrame()).toContain("main-worktree-marker");
  } finally { await app.closeApp(); }
});

test("Real worktree UI explicitly creates sessions and routes input to each SDK run", async () => {
  // The view, registry, Git discovery and SDK tools are real; only model output is scripted.
  const app = await mount();
  try {
    const main = await app.newSession();

    // Submit a read in main, switch worktrees and submit the same command in feature.
    await app.send("read");
    expect(app.captureCharFrame()).toContain("main-worktree-marker");
    app.mockInput.pressEscape();
    await app.click(`${icons.folder} feature`);
    expect(app.captureCharFrame()).toContain("No AI sessions");
    const feature = await app.newSession();
    await app.send("read");

    // Keyboard input targets the selected runtime, never a global CLI or a new instance.
    expect(app.prompts.map((prompt) => prompt.id)).toEqual([main, feature]);
    expect(app.captureCharFrame()).toContain("feature-worktree-marker");
    expect(app.creation).toHaveLength(2);
  } finally { await app.closeApp(); }
});

test("Per-worktree drafts/focus survive background SDK updates and searches", async () => {
  // Two open sessions each have an independent unfinished input draft.
  const app = await mount();
  try {
    const main = await app.newSession();
    pressLeader(app, "a"); await app.mockInput.typeText("main draft");
    app.mockInput.pressEscape();
    await app.click(`${icons.folder} feature`);
    const feature = await app.newSession();
    pressLeader(app, "a"); await app.mockInput.typeText("feature draft");
    app.mockInput.pressEscape();
    await app.click(`${icons.folder} main`);
    pressLeader(app, "a");
    const input = app.renderer.currentFocusedRenderable;

    // Hidden SDK updates must not reset the selected session's persistent input or cursor.
    await app.registry.prompt(feature, "read");
    app.mockInput.pressBackspace();
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("main draf");
    expect(app.renderer.currentFocusedRenderable).toBe(input);
    openWorkspaceSearch(app); await app.mockInput.typeText("feature/probe");
    await app.renderOnce();

    // Search hides the selected main row but does not retarget its draft or create a run.
    expect(app.selection.sessionId).toBe(main);
    expect(app.view.promptDrafts[main]).toBe("main draf");
    expect(app.prompts).toEqual([]);
    app.mockInput.pressEscape(); await app.renderOnce();
    await app.click(`${icons.folder} feature`);
    expect(app.captureCharFrame()).toContain("feature draft");
  } finally { await app.closeApp(); }
});

test("Closing active runs immediately shows empty UI without recreating final sessions", async () => {
  // An actual SDK child stays active until the user closes its owner.
  const app = await mount();
  try {
    const id = await app.newSession();
    const childStarted = Promise.withResolvers<void>();
    const unsubscribe = app.registry.subscribe(() => {
      if (app.selection.worktree?.sessions[0]?.subagents[0]?.status === "working") childStarted.resolve();
    });
    pressLeader(app, "a"); await app.mockInput.typeText("delegate");
    app.mockInput.pressEnter(); await childStarted.promise; unsubscribe();
    app.mockInput.pressEscape();

    // The explicit close command belongs to the Agents session strip, not Workspace traversal.
    app.renderer.root.findDescendantById("agent-session-list")!.focus();
    app.mockInput.pressKey("x");
    expect(app.selection.sessionId).toBeNull();
    expect(app.registry.details(id)).toBeNull();
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("No AI sessions");
    await Promise.all([...app.closes, ...app.prompts.map((prompt) => prompt.done)]);
    await app.renderOnce();

    // Late SDK events cannot resurrect a row, steal focus or create a replacement session.
    expect(app.creation).toHaveLength(1);
    expect(app.registry.closingCount).toBe(0);
    expect(app.renderer.root.findDescendantById("agent-session-tabs")!.hasFocusedDescendant).toBe(true);
    expect(app.captureCharFrame()).not.toContain("Worktree probe");
  } finally { await app.closeApp(); }
});

test("Active runs accept more input while n/x/q remain prompt characters", async () => {
  // A slow scripted response creates a real active SDK run without a paid model request.
  const app = await mount();
  try {
    const id = await app.newSession();
    pressLeader(app, "a"); await app.mockInput.typeText("slow"); app.mockInput.pressEnter();

    await app.prompts[0]!.accepted;
    // A second Enter admits a steer without interrupting the current response.
    await app.mockInput.typeText("querynx"); app.mockInput.pressEnter(); await app.renderOnce();

    await app.prompts[1]!.accepted;
    await app.renderOnce();
    // Admission clears only accepted input and does not invoke sidebar actions.
    expect(app.prompts).toHaveLength(2);
    expect(app.prompts[1]!.text).toBe("querynx");
    expect(app.captureCharFrame()).not.toContain("already running");
    expect(app.selection.sessionId).toBe(id);
    await app.registry.close(id);
    await app.prompts[0]!.done;
  } finally { await app.closeApp(); }
});

test("Renderer-first shutdown reads drafts and safely handles late SDK updates", async () => {
  // Ctrl+C can destroy native edit buffers before the host's final cleanup executes.
  const app = await mount();
  try {
    const id = await app.newSession();
    pressLeader(app, "a"); await app.mockInput.typeText("persist this draft");

    // Teardown is initiated by the renderer, not the view, while the SDK owner remains alive.
    app.renderer.destroy(); await app.renderer.closed;
    await app.registry.prompt(id, "read");

    // Cached drafts do not access destroyed edit buffers, and background snapshots do not render into them.
    expect(app.view.promptDrafts[id]).toBe("persist this draft");
    expect(app.registry.details(id)?.output).toContain("main-worktree-marker");
  } finally { await app.closeApp(); }
});
