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

test.each(["agent", "editor", "git", "terminal"] as const)("%s 화면에서도 다른 저장소의 알림을 표시하고 선택·포커스·초안을 보존한다", async workView => {
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

test("팝업을 닫거나 만료시켜도 벨은 유지하고 같은 결과를 다시 표시하지 않는다", async () => {
  // A toast's lifetime must not be confused with the runtime's shared unread state.
  const app = await fixture();
  try {
    app.complete(); await app.render();
    const close = app.toast().findDescendantById('dismiss-toast:["two","two","new-result"]')!;
    await app.mockMouse.click(close.x, close.y); await app.render();
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

test("팝업 클릭은 열린 탐색창을 닫고 해당 세션의 최신 결과로 이동한 뒤 기존 경로로 읽음 처리한다", async () => {
  // The workspace picker may be open when a notification arrives above it.
  const app = await fixture("terminal");
  try {
    app.mockInput.pressKey("f", { ctrl: true }); await app.render();
    expect(app.get("workspace-picker").visible).toBe(true);
    app.complete("unfinished"); await app.render();
    const toast = app.toast(); await app.mockMouse.click(toast.x + 2, toast.y + 2); await app.render();

    expect(app.selection.sessionId).toBe("two"); expect(app.selection.worktree?.id).toBe("two-tree");
    expect(app.get("workspace-picker").visible).toBe(false); expect(app.get("session-notifications").visible).toBe(false);
    expect(app.view.workViewPreferences.active["two-tree"]).toBe("agent"); expect(app.captureCharFrame()).toContain("RESULT_BODY");
    expect(app.acknowledged).toEqual(["new-result"]); expect(app.state("two").attention).toBeUndefined();
    expect(app.state("two").result?.outcome).toBe("unfinished"); expect(app.view.promptDrafts.one).toBe("KEEP_DRAFT");
  } finally { await app.close(); }
});

test("팝업 표시 후 교체된 대화에는 이동하거나 읽음 처리하지 않는다", async () => {
  // A stable tab ID can refer to a new conversation by the time a delayed toast is clicked.
  const app = await fixture();
  try {
    app.complete(); await app.render();
    app.publish("two", { ...app.state("two"), conversationId: "replacement" }); await app.render();
    const toast = app.toast(); await app.mockMouse.click(toast.x + 2, toast.y + 2); await app.render();

    expect(app.selection.sessionId).toBe("one"); expect(app.acknowledged).toEqual([]);
    expect(app.get("session-notifications").visible).toBe(false); expect(app.state("two").attention?.id).toBe("new-result");
  } finally { await app.close(); }
});
