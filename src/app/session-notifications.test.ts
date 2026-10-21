import { expect, test } from "bun:test";
import type { SessionResult } from "../agents/session-attention.ts";
import type { SessionNotification } from "../agents/session-notification.ts";
import type { ExecutionState } from "../agents/session-registry.ts";
import type { WorkspaceSnapshot } from "../runtime/workspace-client.ts";
import { SessionNotifications } from "./session-notifications.ts";

class Source {
  recoveryVersion = 0;
  readonly listeners = new Set<() => void>();
  snapshot: WorkspaceSnapshot = { repositories: ["one", "two"].map(id => ({ id, name: id, worktrees: [{ id: `${id}-tree`, name: "main", branch: "main", path: `/${id}`,
    sessions: [{ id, name: id, status: "working", subagents: [] }] }] })), details: { one: working(), two: working() },
    preferences: { selection: { worktreeId: "one-tree", sessions: {} }, drafts: {} }, closingCount: 0, notice: "" };
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  changed() { for (const listener of this.listeners) listener(); }
  publish(id: string, state: ExecutionState) {
    this.snapshot = { ...this.snapshot, details: { ...this.snapshot.details, [id]: state },
      repositories: this.snapshot.repositories.map(repo => ({ ...repo, worktrees: repo.worktrees.map(tree => ({ ...tree, sessions: tree.sessions.map(session => {
        if (session.id !== id) return session;
        const { result: _result, attention: _attention, ...rest } = session;
        return { ...rest, status: state.status, ...(state.result ? { result: state.result } : {}), ...(state.attention ? { attention: state.attention } : {}) };
      }) })) })) };
    this.changed();
  }
}
function working(): ExecutionState { return { conversationId: "conversation", status: "working", output: "Private response", error: null }; }
function result(id: string, outcome: SessionResult["outcome"] = "complete", cancellation?: SessionResult["cancellation"]): SessionResult {
  return { id, outcome, completedAt: 43000, request: { text: `Task ${id}`, images: 0, files: 0 }, ...(cancellation ? { cancellation } : {}) };
}
function settled(value: SessionResult): ExecutionState {
  return { ...working(), status: value.outcome === "complete" ? "complete" : value.outcome === "error" ? "failure" : null, result: value, attention: value,
    sections: [{ id: value.id, kind: "assistant", title: "Agent", text: "Private answer", status: "complete",
      completion: { startedAt: 1000, completedAt: 43000, durationMs: 42000, outcome: value.outcome } }] };
}
function fixture(source = new Source()) {
  const sent: SessionNotification[] = [], notifications = new SessionNotifications(source, notification => sent.push(notification));
  return { source, sent, notifications };
}

test.each(["complete", "error", "unfinished", "cancelled"] as const)("다른 저장소의 새 %s 결과를 읽음 여부와 무관하게 한 번만 전달한다", outcome => {
  // The selected repository is unrelated to delivery; the other session already exists at attachment.
  const app = fixture(), finished = settled(result("new", outcome));
  try {
    app.source.publish("two", finished);
    const { attention: _attention, ...read } = finished;
    app.source.publish("two", read); app.source.changed();

    // Removing the bell does not retract or replay a delivery, nor expose response/error text.
    expect(app.sent).toHaveLength(1);
    expect(app.sent[0]).toMatchObject({ sessionId: "two", worktreeId: "two-tree", repository: "two", worktree: "main", durationMs: 42000,
      result: { id: "new", outcome, request: { text: "Task new" } } });
    expect(JSON.stringify(app.sent)).not.toContain("Private");
    expect(app.source.snapshot.details.two?.result?.id).toBe("new");
  } finally { app.notifications.dispose(); }
});

test.each(["user", "lifecycle"] as const)("%s 취소는 기존 벨을 보존하면서 새 팝업을 만들지 않는다", cancellation => {
  // A previous unread result can survive deliberate cancellation of a later run.
  const source = new Source(), old = result("old"); source.publish("two", settled(old));
  const app = fixture(source);
  try {
    source.publish("two", { ...settled(result("cancel", "cancelled", cancellation)), attention: old }); source.changed();

    expect(app.sent).toEqual([]);
    expect(source.snapshot.details.two?.attention?.id).toBe("old");
  } finally { app.notifications.dispose(); }
});

test("벨이 켜진 채 다음 실행이 시작·완료돼도 각 새 결과를 구분한다", () => {
  // Boolean unread transitions would miss the second completion or replay the first on restart.
  const app = fixture(), first = result("first"), second = result("second");
  try {
    app.source.publish("two", settled(first));
    app.source.publish("two", { ...working(), attention: first });
    app.source.publish("two", settled(second)); app.source.changed();

    expect(app.sent.map(item => item.result.id)).toEqual(["first", "second"]);
  } finally { app.notifications.dispose(); }
});

test("다음 실행이 이미 시작된 snapshot에서도 보존된 새 미확인 결과를 전달한다", () => {
  // Full snapshots can coalesce completion with the next agent_start, which clears result.
  const app = fixture();
  try {
    app.source.publish("two", { ...working(), attention: result("retained") }); app.source.changed();

    expect(app.sent.map(item => item.result.id)).toEqual(["retained"]);
    expect(app.sent[0]?.durationMs).toBeUndefined();
  } finally { app.notifications.dispose(); }
});

test("초기 기록·대화 교체·재연결은 팝업을 재생하지 않고 이후 새 결과만 전달한다", () => {
  // A restored bell is persistent unread state, not a fresh transient delivery.
  const source = new Source(); source.publish("two", settled(result("history")));
  const app = fixture(source);
  try {
    source.changed();
    source.publish("two", { ...settled(result("replacement")), conversationId: "replacement" });
    source.recoveryVersion++;
    source.publish("two", { ...settled(result("recovered", "unfinished")), conversationId: "replacement" });
    expect(app.sent).toEqual([]);

    source.publish("two", { ...settled(result("after")), conversationId: "replacement" });

    expect(app.sent.map(item => item.result.id)).toEqual(["after"]);
  } finally { app.notifications.dispose(); }
});

test("개별 메시지·도구·자식 상태 변화와 저장 경고는 새 팝업이 아니다", () => {
  // Only identified main-session results count, not transient failure/status changes.
  const app = fixture();
  try {
    app.source.publish("two", { ...working(), status: "failure", error: "Retrying" });
    app.source.snapshot = { ...app.source.snapshot, repositories: app.source.snapshot.repositories.map(repo => ({ ...repo,
      worktrees: repo.worktrees.map(tree => ({ ...tree, sessions: tree.sessions.map(session => ({ ...session,
        subagents: [{ id: "child", name: "child", status: "complete" as const }] })) })) })) };
    app.source.changed(); expect(app.sent).toEqual([]);
    const finished = settled(result("settled")); app.source.publish("two", finished);
    app.source.publish("two", { ...finished, sections: finished.sections!.map(section => ({ ...section, completion: { ...section.completion!, warning: "Persistence warning" } })) });

    expect(app.sent).toHaveLength(1);
  } finally { app.notifications.dispose(); }
});

test("발송 콜백의 동기 snapshot 갱신과 dispose 뒤에도 같은 결과를 재생하지 않는다", () => {
  // Commit observation before invoking UI callbacks that can publish acknowledgements.
  const source = new Source(), sent: SessionNotification[] = [];
  const notifications = new SessionNotifications(source, notification => { sent.push(notification); source.changed(); });

  source.publish("two", settled(result("first")));
  notifications.dispose(); notifications.dispose(); source.publish("two", settled(result("second")));

  expect(sent.map(item => item.result.id)).toEqual(["first"]); expect(source.listeners.size).toBe(0);
});
