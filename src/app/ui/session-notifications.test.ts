import { openWorkspaceSearch } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import type { ExecutionState } from "../../agents/session-registry.ts";
import type { SessionResult } from "../../agents/session-attention.ts";
import type { WorkView } from "../../runtime/protocol.ts";
import type { WorkspaceSnapshot } from "../../runtime/workspace-client.ts";
import { SessionNotifications } from "../session-notifications.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { Workbench } from "./workbench.ts";
import { ok } from "../../result.ts";
import { icons } from "../../icons.ts";

async function fixture(workView: WorkView = "agent") {
  const clock = new ManualClock(), app = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true, clock });
  let snapshot: WorkspaceSnapshot = { repositories: ["one", "two"].map(id => ({ id, name: id, worktrees: [{ id: `${id}-tree`, path: `/${id}`, name: `${id}-checkout`, branch: `feature/${id}`,
    sessions: [{ id, name: id, status: "working", subagents: [] }] }] })), details: Object.fromEntries(["one", "two"].map(id => [id,
      { conversationId: id, status: "working", output: `Body ${id}`, error: null } satisfies ExecutionState])),
    preferences: { selection: { worktreeId: "one-tree", sessions: {} }, drafts: {} }, closingCount: 0, notice: "" };
  const listeners = new Set<() => void>(), acknowledged: string[] = [], selection = new WorkspaceSelection(snapshot.repositories);
  const publish = (id: string, state: ExecutionState) => {
    snapshot = { ...snapshot, details: { ...snapshot.details, [id]: state }, repositories: snapshot.repositories.map(repo => ({ ...repo, worktrees: repo.worktrees.map(tree => ({ ...tree,
      sessions: tree.sessions.map(session => {
        if (session.id !== id) return session;
        const { result: _result, attention: _attention, ...rest } = session;
        return { ...rest, status: state.status, ...(state.result ? { result: state.result } : {}), ...(state.attention ? { attention: state.attention } : {}) };
      }) })) })) };
    selection.replaceSnapshot(snapshot.repositories);
    for (const listener of listeners) listener();
  };
  const view = new Workbench(app.renderer, selection, { onNewSession() {}, onCloseSession() {}, onPrompt: () => ok(undefined), initialDrafts: { one: "KEEP_DRAFT" },
    initialWorkViews: { active: { "one-tree": workView }, agentScroll: {} }, getSessionDetails: id => snapshot.details[id] ?? null,
    onAcknowledge: async (id, _conversation, resultId) => {
      acknowledged.push(resultId);
      const { attention: _attention, ...read } = snapshot.details[id]!; publish(id, read); return ok(undefined);
    } });
  const notifications = new SessionNotifications({ get snapshot() { return snapshot; }, recoveryVersion: 0,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } }, notification => view.notifySession(notification));
  const complete = (outcome: SessionResult["outcome"] = "complete") => {
    const result: SessionResult = { id: "new-result", outcome, completedAt: 1000, request: { text: "Fix authentication", images: 0, files: 0 } };
    publish("two", { conversationId: "two", status: outcome === "complete" ? "complete" : outcome === "error" ? "failure" : null, output: "RESULT_BODY", error: null,
      result, attention: result, sections: [{ id: "answer", kind: "assistant", title: "Agent", text: "RESULT_BODY", status: "complete" }] });
  };
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  const get = (id: string) => { const node = app.renderer.root.findDescendantById(id); if (!node) throw new Error(`Missing ${id}`); return node; };
  const toast = () => get("session-notifications").getChildren()[0]!;
  await render();
  return { ...app, clock, view, selection, acknowledged, complete, publish, render, get, toast, state: (id: string) => snapshot.details[id]!,
    async close() { notifications.dispose(); view.dispose(); await app.dispose(); } };
}

test.each(["agent", "editor", "git", "terminal"] as const)("%s screens show other-repository notifications while preserving selection, focus, and drafts", async workView => {
  // The other repository finishes while the current work view keeps ownership of input.
  const app = await fixture(workView), owner = app.renderer.currentFocusedRenderable;
  try {
    app.complete(); app.clock.advance(160); await app.render();

    expect(app.captureCharFrame()).toContain("Fix authentication");
    expect(app.captureCharFrame()).toContain(`${icons.folder} two-checkout / ${icons.branch} feature/two`);
    expect(app.selection.sessionId).toBe("one"); expect(app.view.workViewPreferences.active["one-tree"]).toBe(workView);
    expect(app.renderer.currentFocusedRenderable).toBe(owner); expect(app.view.promptDrafts.one).toBe("KEEP_DRAFT");
    expect(app.acknowledged).toEqual([]); expect(app.state("two").attention?.id).toBe("new-result");
  } finally { await app.close(); }
});

test("Button-free popup expiry preserves bells without redisplaying results", async () => {
  // Notification display lifetime is independent of runtime unread-result state.
  const app = await fixture();
  try {
    app.complete(); await app.render();
    expect(app.toast().findDescendantById('dismiss-toast:["two","two","new-result"]')).toBeUndefined();
    app.clock.advance(5000); await app.render();
    app.publish("two", app.state("two")); await app.render();
    expect(app.get("session-notifications").visible).toBe(false); expect(app.acknowledged).toEqual([]);
    expect(app.state("two").attention?.id).toBe("new-result");

    const result: SessionResult = { id: "second", outcome: "error", completedAt: 2000 };
    app.publish("two", { ...app.state("two"), status: "failure", result, attention: result });
    app.clock.advance(8000); await app.render();

    expect(app.get("session-notifications").visible).toBe(false); expect(app.state("two").attention?.id).toBe("second");
    expect(app.acknowledged).toEqual([]); expect(app.view.promptDrafts.one).toBe("KEEP_DRAFT");
  } finally { await app.close(); }
});

test.each(["agent", "editor", "git", "terminal"] as const)("Popup clicks from %s open the latest result with prompt focus and acknowledge through existing paths", async workView => {
  // Notifications can open another session from any work view, even with a workspace picker above it.
  const app = await fixture(workView);
  try {
    openWorkspaceSearch(app); await app.render();
    expect(app.get("workspace-picker").visible).toBe(true);
    app.complete("unfinished"); await app.render();
    const toast = app.toast(); await app.mockMouse.click(toast.x + 2, toast.y + 2); await app.render();

    expect(app.selection.sessionId).toBe("two"); expect(app.selection.worktree?.id).toBe("two-tree");
    expect(app.get("workspace-picker").visible).toBe(false); expect(app.get("session-notifications").visible).toBe(false);
    expect(app.view.workViewPreferences.active["two-tree"]).toBe("agent"); expect(app.captureCharFrame()).toContain("RESULT_BODY");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
    expect(app.acknowledged).toEqual(["new-result"]); expect(app.state("two").attention).toBeUndefined();
    expect(app.state("two").result?.outcome).toBe("unfinished"); expect(app.view.promptDrafts.one).toBe("KEEP_DRAFT");

    // Opening a result should allow a follow-up immediately, without entering transcript navigation.
    await app.mockInput.typeText("Follow-up question"); await app.render();
    expect(app.view.promptDrafts.two).toBe("Follow-up question"); expect(app.view.promptDrafts.one).toBe("KEEP_DRAFT");
  } finally { await app.close(); }
});

test("Replaced conversations are neither navigated to nor acknowledged by stale popups", async () => {
  // A stable tab ID can refer to a new conversation by the time a delayed toast is clicked.
  const app = await fixture();
  try {
    app.complete(); await app.render();
    app.publish("two", { ...app.state("two"), conversationId: "replacement" }); await app.render();
    const toast = app.toast(); await app.mockMouse.click(toast.x + 2, toast.y + 2); await app.render();

    expect(app.selection.sessionId).toBe("one"); expect(app.acknowledged).toEqual([]);
    expect(app.get("session-notifications").visible).toBe(true);
    expect(app.captureCharFrame()).toContain("conversation is no longer"); expect(app.state("two").attention?.id).toBe("new-result");
  } finally { await app.close(); }
});
