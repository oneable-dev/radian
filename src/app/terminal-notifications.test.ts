import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { NativeSession } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { ExecutionState } from "../agents/session-registry.ts";
import type { RunCompletion } from "../agents/run-completion.ts";
import { SessionTranscript } from "../agents/transcript.ts";
import { fixtureMessage } from "../testing/offline-runtime.ts";
import type { WorkspaceSnapshot } from "../runtime/workspace-client.ts";
import { TerminalNotifications } from "./terminal-notifications.ts";

class Source {
  readonly listeners = new Set<() => void>();
  recoveryVersion = 0;
  constructor(public snapshot: WorkspaceSnapshot) {}
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  publish(state: ExecutionState): void {
    this.snapshot = { ...this.snapshot, details: { ...this.snapshot.details, session: state } };
    this.changed();
  }
  changed(): void { for (const listener of this.listeners) listener(); }
}
class Terminal extends EventEmitter {
  isDestroyed = false;
  accepted = true;
  failure: Error | undefined;
  readonly sent: { body: string; title: string | undefined }[] = [];
  triggerNotification(body: string, title?: string): boolean {
    this.sent.push({ body, title });
    if (this.failure) throw this.failure;
    return this.accepted;
  }
  destroy(): void { this.isDestroyed = true; this.emit("destroy"); }
}
function state(completions: readonly RunCompletion[] = [], status: ExecutionState["status"] = "complete"): ExecutionState {
  return { conversationId: "conversation", status, output: "Private response", error: "Private provider error",
    sections: completions.map((completion, index) => ({ id: `answer-${index}`, kind: "assistant", title: "Agent", text: "Private response", status: "complete", completion })) };
}
function snapshot(execution: ExecutionState = state()): WorkspaceSnapshot {
  return { repositories: [{ id: "repo", name: "radian", worktrees: [{ id: "tree", path: "/private/workspace", name: "main", branch: "main",
    sessions: [{ id: "session", name: "Notification work", status: execution.status, subagents: [] }] }] }], details: { session: execution },
    preferences: { selection: { worktreeId: "tree", sessions: {} }, drafts: {} }, closingCount: 0, notice: "" };
}
function completion(outcome: RunCompletion["outcome"] = "complete", startedAt = 1000): RunCompletion {
  return { startedAt, completedAt: startedAt + 42000, durationMs: 42000, outcome };
}
function fixture(initial = state()) {
  const source = new Source(snapshot(initial)), terminal = new Terminal(), errors: unknown[] = [];
  const notifications = new TerminalNotifications(terminal, source, (error) => errors.push(error));
  return { source, terminal, errors, notifications };
}

for (const focus of ["unknown", "blur", "focus"] as const) for (const outcome of ["complete", "error"] as const) {
  test(`포커스 ${focus} 상태의 최종 ${outcome} 결과는 정책에 맞게 한 번만 알린다`, () => {
    // 최초 이벤트가 없으면 unknown이며, OS 대신 터미널 발송 경계만 대체한다.
    const app = fixture();
    if (focus !== "unknown") app.terminal.emit(focus);
    const finished = completion(outcome);
    try {
      // 같은 결과의 heartbeat와 저장 경고는 새 실행이 아니다.
      app.source.publish(state([finished]));
      app.source.publish(state([{ ...finished, warning: "Timing persistence warning" }]));
      app.terminal.emit("blur"); app.source.changed();

      // 포커스 중 소비한 결과는 이후 포커스를 잃어도 재생하지 않는다.
      expect(app.terminal.sent).toEqual(focus === "focus" ? [] : [{
        title: outcome === "complete" ? "Radian · Task completed" : "Radian · Task failed",
        body: "radian / main / Notification work · 42s",
      }]);
      expect(app.errors).toEqual([]);
    } finally { app.notifications.dispose(); }
  });
}

test("연결 전 기록·새로 연 대화·재연결 결과는 재생하지 않고 이후의 실행만 알린다", () => {
  // 연결 당시 이미 완료된 기록은 알림의 시작 기준으로만 사용한다.
  const old = completion(), app = fixture(state([old]));
  try {
    // 같은 탭에서 다른 저장 대화를 열거나 서비스를 복구해도 과거 기록이다.
    app.source.changed();
    app.source.publish({ ...state([old, completion("error", 50000)]), conversationId: "resumed" });
    app.source.recoveryVersion++;
    const restored = [old, completion("error", 50000), completion("complete", 100000)];
    app.source.publish({ ...state(restored), conversationId: "resumed" });
    expect(app.terminal.sent).toHaveLength(0);

    // 새 기준 이후의 완료 결과는 working 스냅샷이 합쳐져 없어져도 감지한다.
    app.source.publish({ ...state([...restored, completion("complete", 150000)]), conversationId: "resumed" });
    expect(app.terminal.sent).toHaveLength(1);
  } finally { app.notifications.dispose(); }
});

test("다른 세션의 저장 기록을 처음 읽을 때는 알리지 않는다", () => {
  // 기존 세션을 관찰하던 중 다른 저장 세션을 추가하는 경우를 준비한다.
  const app = fixture();
  try {
    const repository = app.source.snapshot.repositories[0]!, tree = repository.worktrees[0]!;
    app.source.snapshot = { ...app.source.snapshot,
      repositories: [{ ...repository, worktrees: [{ ...tree, sessions: [...tree.sessions,
        { id: "saved", name: "Saved session", status: "complete", subagents: [] }] }] }],
      details: { ...app.source.snapshot.details, saved: state([completion()]) } };

    // 처음 보이는 완료 내역과 후속 heartbeat는 모두 과거 기록으로 소비한다.
    app.source.changed(); app.source.changed();

    expect(app.terminal.sent).toEqual([]);
  } finally { app.notifications.dispose(); }
});

test("모델 응답과 재시도가 끝나도 settled 전에는 알리지 않는다", () => {
  // 실제 transcript 계약으로 최종 완료와 개별 응답 종료를 구분한다.
  const app = fixture(), transcript = new SessionTranscript([]);
  const assistant = fixtureMessage("openai-responses", "fixture", "fixture");
  assistant.content = [{ type: "text", text: "Private answer" }];
  const publish = () => app.source.publish({ ...state([], "working"), sections: transcript.sections });
  const message = (value: typeof assistant) => {
    transcript.handle({ type: "message_start", message: value });
    transcript.handle({ type: "message_end", message: value });
  };
  try {
    // 재시도 가능한 중간 실패와 다음 응답은 아직 요청 전체의 완료가 아니다.
    transcript.handle({ type: "agent_start" });
    message({ ...assistant, stopReason: "error", errorMessage: "Retryable failure" });
    transcript.handle({ type: "agent_end", messages: [], willRetry: true }); publish();
    transcript.handle({ type: "agent_start" }); message(assistant);
    transcript.handle({ type: "agent_end", messages: [], willRetry: false }); publish();
    expect(app.terminal.sent).toHaveLength(0);

    // 최종 메타데이터가 생성될 때만 한 번 전송한다.
    transcript.handle({ type: "agent_settled", aborted: false });
    app.source.publish({ ...state(), sections: transcript.sections }); app.source.changed();
    expect(app.terminal.sent).toHaveLength(1);
    expect(app.terminal.sent[0]?.title).toBe("Radian · Task completed");
  } finally { app.notifications.dispose(); }
});

test.each(["cancelled", "unfinished"] as const)("%s 종료는 실패·완료 알림을 만들지 않는다", (outcome) => {
  // 취소와 결과 미확정은 실패나 성공으로 분류하지 않는다.
  const app = fixture();
  try {
    app.source.publish(state([completion(outcome)], null)); app.source.changed();

    expect(app.terminal.sent).toEqual([]);
  } finally { app.notifications.dispose(); }
});

test("합쳐진 스냅샷의 여러 최종 실행은 각각 한 번만 알리고 자식 상태는 별도로 알리지 않는다", () => {
  // 자식의 상태 변화는 메인 세션의 별도 완료 결과가 아니다.
  const app = fixture(), repository = app.source.snapshot.repositories[0]!, tree = repository.worktrees[0]!;
  try {
    app.source.snapshot = { ...app.source.snapshot, repositories: [{ ...repository, worktrees: [{ ...tree,
      sessions: [{ ...tree.sessions[0]!, subagents: [{ id: "child", name: "Probe", status: "complete" }] }] }] }] };
    app.source.changed();
    expect(app.terminal.sent).toHaveLength(0);

    // 스트림이 여러 완료를 한 번에 전달해도 결과마다 한 번씩 처리한다.
    app.source.publish(state([completion(), completion("error", 50000)])); app.source.changed();

    expect(app.terminal.sent.map((item) => item.title)).toEqual(["Radian · Task completed", "Radian · Task failed"]);
  } finally { app.notifications.dispose(); }
});

test.each([[0, "<1s"], [90000, "1m 30s"], [3604000, "1h 0m 4s"]] as const)("실행 시간 %dms를 세션 경과 시간이 아닌 %s로 표시한다", (durationMs, expected) => {
  // 저장된 실행 시간만 사용하고 현재 시각이나 세션의 대기 시간을 더하지 않는다.
  const app = fixture();
  try {
    app.source.publish(state([{ ...completion(), durationMs }]));

    expect(app.terminal.sent[0]?.body).toBe(`radian / main / Notification work · ${expected}`);
  } finally { app.notifications.dispose(); }
});

test("짧은 알림에는 식별 정보와 시간만 넣고 제어문자·OSC 구분자를 제거한다", () => {
  // 로컬 이름에도 OSC 종료와 추가 명령을 주입할 수 있는 문자가 있을 수 있다.
  const app = fixture(), repository = app.source.snapshot.repositories[0]!, tree = repository.worktrees[0]!;
  try {
    app.source.snapshot = { ...app.source.snapshot, repositories: [{ ...repository, name: "\x1b[31mradian\x1b[0m;\nrepo\x07",
      worktrees: [{ ...tree, sessions: [{ ...tree.sessions[0]!, name: "작업".repeat(200) + "\x9c" }] }] }] };

    app.source.publish(state([completion("error")]));

    const sent = app.terminal.sent[0]!;
    expect(sent.body).toStartWith("radian, repo / main / ");
    expect(sent.body).not.toMatch(/[\x00-\x1f\x7f-\x9f;]/u);
    expect(Bun.stringWidth(sent.body)).toBeLessThanOrEqual(240);
    expect(sent.body).toEndWith("… · 42s");
    expect(sent.body).not.toContain("Private"); expect(sent.body).not.toContain("/private/workspace");
  } finally { app.notifications.dispose(); }
});

test.each(["dispose", "destroy"] as const)("%s 후에는 구독을 정리하고 새 알림을 보내지 않는다", (action) => {
  // detach와 renderer 종료 모두 알림 소유권을 끝낸다.
  const app = fixture();

  if (action === "dispose") app.notifications.dispose(); else app.terminal.destroy();
  app.notifications.dispose(); app.source.publish(state([completion()]));

  expect(app.source.listeners.size).toBe(0);
  expect(["focus", "blur", "destroy"].map((event) => app.terminal.listenerCount(event))).toEqual([0, 0, 0]);
  expect(app.terminal.sent).toEqual([]);
});

test("터미널이 알림을 지원하지 않아도 재시도하거나 실행 결과를 바꾸지 않는다", () => {
  // false는 터미널 전달 거절이며 OS에 표시됐다는 뜻으로 취급하지 않는다.
  const app = fixture(); app.terminal.accepted = false;
  try {
    app.source.publish(state([completion()])); app.source.changed();

    expect(app.terminal.sent).toHaveLength(1); expect(app.errors).toEqual([]);
    expect(app.source.snapshot.details.session?.status).toBe("complete");
  } finally { app.notifications.dispose(); }
});

test("예상하지 못한 SDK 예외는 원본 그대로 UI 경계에 보고하고 같은 결과를 다시 보내지 않는다", () => {
  // 프로그래밍 오류를 정상적인 지원 불가 결과로 숨기지 않는다.
  const app = fixture(), error = new Error("Unexpected notification failure"); app.terminal.failure = error;
  try {
    app.source.publish(state([completion()])); app.source.changed();

    expect(app.errors).toEqual([error]); expect(app.errors[0]).toBe(error);
    expect(app.terminal.sent).toHaveLength(1);
    expect(app.source.snapshot.details.session?.status).toBe("complete");
  } finally { app.notifications.dispose(); }
});

test("선택되지 않은 다른 저장소의 세션도 해당 저장소와 워크트리 이름으로 알린다", () => {
  // 포커스 정책은 선택한 세션이 아니라 이 TUI 전체의 터미널 포커스에 적용한다.
  const app = fixture();
  const repository = { id: "other-repo", name: "server", worktrees: [{ id: "feature", path: "/private/server", name: "feature/api", branch: "feature/api",
    sessions: [{ id: "other-session", name: "API work", status: "working" as const, subagents: [] }] }] };
  try {
    app.source.snapshot = { ...app.source.snapshot, repositories: [...app.source.snapshot.repositories, repository],
      details: { ...app.source.snapshot.details, "other-session": state([], "working") } };
    app.source.changed();

    // 다른 저장소에서만 완료가 발생해도 메인 세션과 섞이지 않는다.
    app.source.snapshot = { ...app.source.snapshot, details: { ...app.source.snapshot.details, "other-session": state([completion()]) } };
    app.source.changed(); app.source.changed();

    expect(app.terminal.sent).toEqual([{ title: "Radian · Task completed", body: "server / feature/api / API work · 42s" }]);
  } finally { app.notifications.dispose(); }
});

test("Ghostty용 native 출력은 실제 OSC 777 알림을 순서 있는 출력 큐로 전달한다", async () => {
  // OS나 실제 터미널 대신 Writable에 바이트를 수집하되 native 발송기는 대체하지 않는다.
  let raw = "";
  const sink = new Writable({ write(bytes, _encoding, done) { raw += bytes.toString(); done(); } });
  const driver = new NativeSession(sink), source = new Source(snapshot()), errors: unknown[] = [];
  const terminal = Object.assign(new EventEmitter(), { isDestroyed: false,
    triggerNotification: (body: string, title?: string) => driver.triggerNotification(body, title) });
  let notifications: TerminalNotifications | undefined;
  try {
    driver.attachRenderer({ width: 40, height: 8, remote: false, environment: { TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty" } });
    await driver.setupTerminal({ useAlternateScreen: false, mouse: false, kittyKeyboardFlags: 0 });
    // Ghostty가 모드 조회에 지원 여부를 응답하면 OpenTUI가 포커스 추적을 켠다.
    driver.control({ kind: "capability-response", bytes: Buffer.from("\x1b[?1004;2$y") });
    await driver.idle(); expect(raw).toContain("\x1b[?1004h");
    raw = "";
    notifications = new TerminalNotifications(terminal, source, (error) => errors.push(error));

    // 알림은 화면 텍스트가 아니라 Ghostty가 해석하는 OSC 제어 패킷이다.
    source.publish(state([completion()])); await driver.idle();

    expect(raw).toBe("\x1b]777;notify;Radian · Task completed;radian / main / Notification work · 42s\x1b\\");
    expect(errors).toEqual([]);
  } finally { notifications?.dispose(); await driver.close(); }
});

test("실제 OpenTUI 입력 파서의 포커스 신호로 발송 여부를 갱신한다", async () => {
  // 터미널 출력 경계만 대체하고 실제 입력 파서와 renderer 이벤트를 사용한다.
  const app = await createTestRenderer({ width: 40, height: 8 });
  const source = new Source(snapshot()), errors: unknown[] = [];
  const send = spyOn(app.renderer, "triggerNotification").mockReturnValue(true);
  const notifications = new TerminalNotifications(app.renderer, source, (error) => errors.push(error));
  try {
    // 터미널이 포커스를 얻은 상태의 완료는 알리지 않는다.
    app.renderer.stdin.emit("data", Buffer.from("\x1b[I")); await app.renderOnce();
    source.publish(state([completion()]));
    expect(send).not.toHaveBeenCalled();

    // 포커스를 잃은 뒤의 새 결과는 native 출력 API로 한 번만 전달한다.
    app.renderer.stdin.emit("data", Buffer.from("\x1b[O")); await app.renderOnce();
    source.publish(state([completion(), completion("error", 50000)])); source.changed();
    expect(send.mock.calls).toEqual([["radian / main / Notification work · 42s", "Radian · Task failed"]]);
    expect(errors).toEqual([]);
  } finally { notifications.dispose(); send.mockRestore(); await app.dispose(); }
});
