import { expect, test } from "bun:test";
import { SessionRegistry, type ExecutionState, type SessionExecutor } from "./session-registry.ts";
import type { SessionResult } from "./session-attention.ts";
import { demoWorkspace } from "../workspace/demo.ts";
import { ok } from "../result.ts";
import { expectError, expectOk } from "../testing/results.ts";

class Executor implements SessionExecutor {
  readonly savedSessionId = crypto.randomUUID();
  readonly sessionFile = undefined;
  private value: ExecutionState = { status: null, output: "", error: null };
  private readonly listeners = new Set<() => void>();
  get state(): ExecutionState { return { ...this.value, conversationId: this.savedSessionId }; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  publish(state: ExecutionState) { this.value = state; for (const listener of this.listeners) listener(); }
  async prompt() { return ok(undefined); }
  async close() { return ok(undefined); }
}
const result = (id: string, outcome: SessionResult["outcome"] = "complete", cancellation?: SessionResult["cancellation"]): SessionResult => ({
  id, outcome, completedAt: 1000, ...(cancellation ? { cancellation } : {}), request: { text: `Task ${id}`, images: 0, files: 0 },
});
function fixture(initial?: SessionResult) {
  const executors: Executor[] = [];
  const registry = new SessionRegistry(demoWorkspace(), async () => {
    const executor = new Executor(); executors.push(executor);
    if (initial) executor.publish({ status: "complete", output: "", error: null, result: initial });
    return executor;
  });
  return { registry, executors };
}

test.each(["complete", "error", "unfinished", "cancelled"] as const)("새 %s 결과만 확인 필요로 만들고 반복 갱신으로 읽음을 되돌리지 않는다", async outcome => {
  // 사용자 의도를 모르는 취소도 확인해야 하므로 원인 없는 결과를 준비한다.
  const app = fixture(), id = expectOk(await app.registry.create("demo:main")), executor = app.executors[0]!;
  try {
    executor.publish({ status: outcome === "error" ? "failure" : outcome === "complete" ? "complete" : null, output: "", error: null, result: result("first", outcome) });
    expect(app.registry.details(id)?.attention?.id).toBe("first");

    // 같은 결과에 대한 확인은 실행 결과를 바꾸지 않고 알림만 해제한다.
    expectOk(app.registry.acknowledge(id, executor.savedSessionId, "first"));
    executor.publish(executor.state);
    expect(app.registry.details(id)?.attention).toBeUndefined();
    expect(app.registry.details(id)?.result?.outcome).toBe(outcome);
    expect(app.registry.snapshot[0]?.worktrees[0]?.sessions[0]?.attention).toBeUndefined();
  } finally { expectOk(await app.registry.shutdown()); }
});

test("늦은 읽음 요청과 새 작업 시작은 새 결과나 이전 미확인을 지우지 않는다", async () => {
  // 두 작업의 완료가 확인 요청과 교차하는 상황을 만든다.
  const app = fixture(), id = expectOk(await app.registry.create("demo:main")), executor = app.executors[0]!;
  try {
    executor.publish({ status: "complete", output: "", error: null, result: result("first") });
    executor.publish({ status: "working", output: "", error: null });
    expect(app.registry.details(id)?.attention?.id).toBe("first");
    executor.publish({ status: "complete", output: "", error: null, result: result("second") });

    // 첫 작업 확인이 늦게 와도 두 번째 결과가 남아야 한다.
    expectOk(app.registry.acknowledge(id, executor.savedSessionId, "first"));
    expect(app.registry.details(id)?.attention?.id).toBe("second");
    expect(expectError(app.registry.acknowledge(id, "outgoing-conversation", "second")).code).toBe("SESSION_CONFLICT");
    expect(app.registry.details(id)?.attention?.id).toBe("second");
  } finally { expectOk(await app.registry.shutdown()); }
});

test.each(["user", "lifecycle"] as const)("%s 취소는 새 알림 없이 이전 미확인 결과를 보존한다", async cancellation => {
  // 이미 미확인 결과가 있는 세션을 다음 실행에서 의도적으로 취소한다.
  const app = fixture(), id = expectOk(await app.registry.create("demo:main")), executor = app.executors[0]!;
  try {
    executor.publish({ status: "complete", output: "", error: null, result: result("previous") });
    executor.publish({ status: null, output: "", error: null, result: result("cancelled", "cancelled", cancellation) });

    expect(app.registry.details(id)?.attention?.id).toBe("previous");
    expectOk(app.registry.acknowledge(id, executor.savedSessionId, "previous"));
    executor.publish({ status: null, output: "", error: null, result: result("cancelled-again", "cancelled", cancellation) });
    expect(app.registry.details(id)?.attention).toBeUndefined();
  } finally { expectOk(await app.registry.shutdown()); }
});

test("과거 대화를 열 때는 알림을 재생하지 않고 저장된 미확인만 복원한다", async () => {
  // 과거 결과를 가진 SDK와 런타임 체크포인트의 읽음 상태는 서로 다른 책임이다.
  const app = fixture(result("history")), id = expectOk(await app.registry.create("demo:main"));
  let restored: ReturnType<typeof fixture> | undefined;
  try {
    expect(app.registry.details(id)?.attention).toBeUndefined();
    app.executors[0]!.publish({ status: "complete", output: "", error: null, result: result("unread") });
    const record = app.registry.records[0]!;
    restored = fixture(result("reloaded-sdk-history"));

    expectOk(await restored.registry.restore(record));
    expect(restored.registry.details(id)?.attention?.id).toBe("unread");
    expectOk(restored.registry.acknowledge(id, restored.executors[0]!.savedSessionId, "unread"));
    restored.executors[0]!.publish(restored.executors[0]!.state);
    expect(restored.registry.details(id)?.attention).toBeUndefined();
  } finally { expectOk(await app.registry.shutdown()); if (restored) expectOk(await restored.registry.shutdown()); }
});

test("실행 중 런타임이 종료됐으면 복원 후 Stopped 결과를 확인 필요로 표시한다", async () => {
  // 런타임 종료는 사용자가 실행을 취소한 것과 구분해야 한다.
  const app = fixture(), id = expectOk(await app.registry.create("demo:main"));
  const restored = fixture();
  try {
    app.executors[0]!.publish({ status: "working", output: "", error: null });
    expectOk(await restored.registry.restore(app.registry.records[0]!));

    expect(restored.registry.details(id)?.status).toBeNull();
    expect(restored.registry.details(id)?.result?.outcome).toBe("unfinished");
    expect(restored.registry.details(id)?.attention?.outcome).toBe("unfinished");
  } finally { expectOk(await app.registry.shutdown()); expectOk(await restored.registry.shutdown()); }
});
