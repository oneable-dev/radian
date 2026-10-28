import { expect, test } from "bun:test";
import { SessionRegistry, type SessionContext, type SessionExecutor } from "./session-registry.ts";
import { demoWorkspace } from "../workspace/demo.ts";
import { StorageError } from "../errors.ts";
import { ok } from "../result.ts";
import { expectError, expectOk } from "../testing/results.ts";

function execution(id: string): SessionExecutor & { closes: number; switches: number } {
  return {
    savedSessionId: id,
    sessionFile: undefined,
    state: { conversationId: id, status: "working", output: "Retained work", error: null },
    busy: true,
    closes: 0,
    switches: 0,
    subscribe: () => () => {},
    prompt: async () => ok(undefined),
    async beforeNewSession() {
      this.switches++;

      return ok(undefined);
    },
    async close() {
      this.closes++;

      return ok(undefined);
    },
  };
}

test("newTab adds to the original worktree without replacing active runs or child ownership", async () => {
  const contexts: SessionContext[] = [];
  const executions: ReturnType<typeof execution>[] = [];
  const registry = new SessionRegistry(demoWorkspace(), async (context) => {
    contexts.push(context);

    const next = execution(`conversation-${contexts.length}`);
    executions.push(next);

    return next;
  });
  try {
    const original = expectOk(await registry.create("demo:feature"));
    const other = expectOk(await registry.create("demo:main"));
    const before = registry.details(original);

    const added = expectOk(await registry.newTab(original));

    expect(added).not.toBe(original);
    expect(registry.details(original)).toBe(before);
    expect(
      registry.snapshot[0]!.worktrees.find((tree) => tree.id === "demo:feature")!.sessions.map(
        (session) => session.id,
      ),
    ).toEqual([original, added]);
    expect(
      registry.snapshot[0]!.worktrees.find((tree) => tree.id === "demo:main")!.sessions.map(
        (session) => session.id,
      ),
    ).toEqual([other]);
    expect(contexts.map((context) => context.cwd)).toEqual([
      "/demo/radian-ui",
      "/demo/radian",
      "/demo/radian-ui",
    ]);
    expect(executions.map((item) => item.closes)).toEqual([0, 0, 0]);
    expect(executions[0]!.switches).toBe(0);
    // The old generation's callback is still valid because opening a tab never replaces it.
    expectOk(await contexts[0]!.spawnSubagent("Still owned", "Continue original work"));
    expect(registry.records.find((record) => record.id === original)?.subagents).toHaveLength(1);
    expect(registry.records.find((record) => record.id === added)?.subagents).toEqual([]);
  } finally {
    expectOk(await registry.shutdown());
  }
});

test("New-tab failures neither interrupt existing tabs nor clear conversations", async () => {
  const original = execution("original");
  let calls = 0;
  const registry = new SessionRegistry(demoWorkspace(), async () => {
    if (++calls > 1) {
      throw new StorageError("New tab could not be prepared", "EIO");
    }

    return original;
  });
  try {
    const id = expectOk(await registry.create("demo:main"));
    const result = await registry.newTab(id);

    expect(expectError(result).code).toBe("STORAGE_FAILED");
    expect(original.closes).toBe(0);
    expect(original.switches).toBe(0);
    expect(registry.details(id)?.output).toBe("Retained work");
    expect(registry.records.map((record) => record.id)).toEqual([id]);
    expect(expectError(await registry.newTab("not-open")).code).toBe("SESSION_NOT_OPEN");
    expect(calls).toBe(2);
  } finally {
    expectOk(await registry.shutdown());
  }
});
