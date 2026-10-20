import { expect, test } from "bun:test";
import { demoWorkspace } from "../workspace/demo.ts";
import { SessionRegistry, type SessionExecutor, type SessionContext } from "./session-registry.ts";
import { StorageError } from "../errors.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { ok } from "../result.ts";

function executor(): SessionExecutor & { closes: number } {
  const conversationId = crypto.randomUUID();
  return { savedSessionId: conversationId, sessionFile: undefined,
    state: { conversationId, status: "working", output: "original work", error: null }, closes: 0,
    subscribe: () => () => {}, prompt: async () => ok(undefined),
    async close() { this.closes++; return ok(undefined); },
  };
}

test("새 SDK 세션 준비 실패는 원래 실행을 중단하거나 탭을 없애지 않는다", async () => {
  // Only the second factory call fails, before ownership is transferred or abort is requested.
  const original = executor(); let calls = 0;
  const registry = new SessionRegistry(demoWorkspace(), async () => {
    if (++calls === 2) throw new StorageError("Replacement fixture is unavailable", "EIO");
    return original;
  });
  try {
    const id = expectOk(await registry.create("demo:main")); let accepted = false;

    const result = await registry.clearSession(id, () => { accepted = true; });

    expect(expectError(result).code).toBe("STORAGE_FAILED"); expect(accepted).toBe(false);
    expect(original.closes).toBe(0); expect(registry.details(id)?.conversationId).toBe(original.savedSessionId);
    expect(registry.snapshot[0]?.worktrees[0]?.sessions.map((session) => session.id)).toEqual([id]);
    expectOk(await registry.prompt(id, "continue original"));
  } finally { expectOk(await registry.shutdown()); }
});

test("교체 전 대화가 보관한 하위 작업 콜백은 같은 탭의 새 대화에 작업을 만들 수 없다", async () => {
  const contexts: SessionContext[] = [];
  const registry = new SessionRegistry(demoWorkspace(), async (context) => { contexts.push(context); return executor(); });
  try {
    const id = expectOk(await registry.create("demo:main"));
    expectOk(await registry.clearSession(id));

    const stale = await contexts[0]!.spawnSubagent("late child", "old task");

    expect(expectError(stale).code).toBe("SESSION_CONFLICT"); expect(contexts).toHaveLength(2);
    expect(registry.records[0]?.subagents).toEqual([]);
  } finally { expectOk(await registry.shutdown()); }
});

test("clear 준비 중의 중복 명령과 입력은 거부하고 shutdown은 준비된 새 핸들도 정리한다", async () => {
  const original = executor(), next = executor();
  const prepared = Promise.withResolvers<SessionExecutor>(), creating = Promise.withResolvers<void>(); let calls = 0;
  const registry = new SessionRegistry(demoWorkspace(), async () => {
    if (++calls === 1) return original;
    creating.resolve(); return prepared.promise;
  });
  const id = expectOk(await registry.create("demo:main"));
  const replacement = registry.clearSession(id); await creating.promise;
  expect(expectError(await registry.clearSession(id)).code).toBe("SESSION_BUSY");
  expect(expectError(await registry.newTab(id)).code).toBe("SESSION_BUSY");
  expect(expectError(await registry.prompt(id, "do not overtake replacement")).code).toBe("SESSION_BUSY");
  expect(original.closes).toBe(0);

  // Shutdown races with preparation, but must not leak the new SDK conversation.
  const stopping = registry.shutdown(); prepared.resolve(next);
  expect(expectError(await replacement).code).toBe("CANCELLED"); expectOk(await stopping);

  expect(original.closes).toBe(1); expect(next.closes).toBe(1);
  expect(registry.snapshot[0]?.worktrees[0]?.sessions).toEqual([]);
});
