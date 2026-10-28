import { expect, test } from "bun:test";
import { demoWorkspace } from "../workspace/demo.ts";
import {
  SessionRegistry,
  type SessionExecutor,
  type SessionContext,
  type ExecutionState,
} from "./session-registry.ts";
import { StorageError } from "../errors.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { ok } from "../result.ts";

function executor(
  status: ExecutionState["status"] = "working",
): SessionExecutor & { closes: number } {
  const conversationId = crypto.randomUUID();

  return {
    savedSessionId: conversationId,
    sessionFile: undefined,
    state: { conversationId, status, output: "original work", error: null },
    closes: 0,
    subscribe: () => () => {},
    prompt: async () => ok(undefined),
    async close() {
      this.closes++;

      return ok(undefined);
    },
  };
}

test.each([null, "complete", "failure", "working"] as const)(
  "clear preparation preserves %s state without creating command-induced working activity",
  async (status) => {
    // Slow replacement must not confuse command processing with actual model execution.
    const original = executor(status);
    const next = executor(null);
    const prepared = Promise.withResolvers<SessionExecutor>();
    const creating = Promise.withResolvers<void>();
    let calls = 0;
    let replacement: ReturnType<SessionRegistry["clearSession"]> | undefined;
    const registry = new SessionRegistry(demoWorkspace(), async () => {
      if (++calls === 1) {
        return original;
      }

      creating.resolve();

      return prepared.promise;
    });
    try {
      const id = expectOk(await registry.create("demo:main"));

      // Delay new-conversation preparation to observe transient spinner states.
      replacement = registry.clearSession(id);
      await creating.promise;

      // Only existing runs remain active while duplicate-request guards stay effective.
      expect(registry.details(id)?.status).toBe(status);
      expect(registry.snapshot[0]?.worktrees[0]?.sessions[0]?.status).toBe(status);
      expect(registry.records[0]?.state.status).toBe(status);
      expect(expectError(await registry.prompt(id, "wait for replacement")).code).toBe(
        "SESSION_BUSY",
      );
      prepared.resolve(next);
      expectOk(await replacement);
      expect(registry.details(id)?.status).toBeNull();
      expect(original.closes).toBe(1);
    } finally {
      prepared.resolve(next);
      if (replacement) {
        await replacement;
      }

      expectOk(await registry.shutdown());
    }
  },
);

test("Failed SDK preparation neither interrupts the original run nor removes its tab", async () => {
  // Only the second factory call fails, before ownership is transferred or abort is requested.
  const original = executor();
  let calls = 0;
  const registry = new SessionRegistry(demoWorkspace(), async () => {
    if (++calls === 2) {
      throw new StorageError("Replacement fixture is unavailable", "EIO");
    }

    return original;
  });
  try {
    const id = expectOk(await registry.create("demo:main"));
    let accepted = false;

    const result = await registry.clearSession(id, () => {
      accepted = true;
    });

    expect(expectError(result).code).toBe("STORAGE_FAILED");
    expect(accepted).toBe(false);
    expect(original.closes).toBe(0);
    expect(registry.details(id)?.conversationId).toBe(original.savedSessionId);
    expect(registry.snapshot[0]?.worktrees[0]?.sessions.map((session) => session.id)).toEqual([id]);
    expectOk(await registry.prompt(id, "continue original"));
  } finally {
    expectOk(await registry.shutdown());
  }
});

test("Callbacks retained by replaced conversations cannot create work in the new conversation", async () => {
  const contexts: SessionContext[] = [];
  const registry = new SessionRegistry(demoWorkspace(), async (context) => {
    contexts.push(context);

    return executor();
  });
  try {
    const id = expectOk(await registry.create("demo:main"));
    expectOk(await registry.clearSession(id));

    const stale = await contexts[0]!.spawnSubagent("late child", "old task");

    expect(expectError(stale).code).toBe("SESSION_CONFLICT");
    expect(contexts).toHaveLength(2);
    expect(registry.records[0]?.subagents).toEqual([]);
  } finally {
    expectOk(await registry.shutdown());
  }
});

test("clear rejects concurrent commands and input while shutdown also cleans prepared handles", async () => {
  const original = executor();
  const next = executor();
  const prepared = Promise.withResolvers<SessionExecutor>();
  const creating = Promise.withResolvers<void>();
  let calls = 0;
  const registry = new SessionRegistry(demoWorkspace(), async () => {
    if (++calls === 1) {
      return original;
    }

    creating.resolve();

    return prepared.promise;
  });
  const id = expectOk(await registry.create("demo:main"));
  const replacement = registry.clearSession(id);

  await creating.promise;
  expect(expectError(await registry.clearSession(id)).code).toBe("SESSION_BUSY");
  expect(expectError(await registry.newTab(id)).code).toBe("SESSION_BUSY");
  expect(expectError(await registry.prompt(id, "do not overtake replacement")).code).toBe(
    "SESSION_BUSY",
  );
  expect(original.closes).toBe(0);

  // Shutdown races with preparation, but must not leak the new SDK conversation.
  const stopping = registry.shutdown();
  prepared.resolve(next);
  expect(expectError(await replacement).code).toBe("CANCELLED");
  expectOk(await stopping);

  expect(original.closes).toBe(1);
  expect(next.closes).toBe(1);
  expect(registry.snapshot[0]?.worktrees[0]?.sessions).toEqual([]);
});
