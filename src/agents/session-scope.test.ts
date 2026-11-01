import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "../result.ts";
import { StorageError } from "../errors.ts";
import { demoWorkspace } from "../workspace/demo.ts";
import { RepositoryCatalog } from "../workspace/catalog.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { SessionRegistry, type SessionContext, type SessionExecutor } from "./session-registry.ts";

test("CHAT checkpoints closed managed children without exposing or independently restoring them", async () => {
  // The registry owns a child SDK file, but only its parent is an independent conversation.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "radian-chat-child-")));
  let parent: SessionContext | undefined;
  let factories = 0;
  const registry = new SessionRegistry(
    new RepositoryCatalog([]),
    async (context) => {
      factories++;
      if (context.role === "main") parent = context;
      const conversationId = `${context.role}-conversation`;
      const sessionFile = join(directory, `${conversationId}.jsonl`);
      await writeFile(
        sessionFile,
        JSON.stringify({ type: "session", id: conversationId, cwd: context.cwd }) + "\n",
      );
      return {
        savedSessionId: conversationId,
        sessionFile,
        state: {
          status: "complete",
          output: `${context.role} output`,
          finalOutput: `${context.role} output`,
          error: null,
        },
        subscribe: () => () => {},
        prompt: async () => ok(undefined),
        close: async () => ok(undefined),
      };
    },
    "chat",
  );
  try {
    const main = expectOk(await registry.createChat());

    // Completed child cleanup must produce its own retention record instead of an orphan SDK file.
    expect(expectOk(await parent!.spawnSubagent("fixture", "Complete the child task"))).toBe(
      "subagent output",
    );
    const records = registry.checkpointRecords;
    const child = records.find((record) => record.role === "subagent")!;
    expect(child).toMatchObject({
      scope: { kind: "chat" },
      role: "subagent",
      lifecycle: "closed",
      managed: true,
      cwd: homedir(),
      state: { conversationId: "subagent-conversation" },
    });
    expect(child.closedAt).toBeNumber();
    expect(registry.chatSessions.map((entry) => entry.id)).toEqual([main]);

    // Even stale metadata calling restore directly must never turn a child into a main executor.
    expectOk(await registry.restore({ ...child, lifecycle: "open" }));
    expect(factories).toBe(2);
    expect(registry.chatSessions.map((entry) => entry.id)).toEqual([main]);
    registry.acknowledgeCheckpoint(records);
    expect(registry.checkpointRecords.some((record) => record.role === "subagent")).toBe(false);
  } finally {
    expectOk(await registry.shutdown());
    await rm(directory, { recursive: true, force: true });
  }
});

test("CHAT registry uses homedir for cwd and explicit relative attachments without a worktree", async () => {
  // The factory receives a scope, never a fabricated repository/worktree identity.
  let context: SessionContext | undefined;
  let attachments: readonly string[] | undefined;
  const executor: SessionExecutor = {
    savedSessionId: "conversation",
    sessionFile: undefined,
    acceptsImages: true,
    state: { status: null, output: "", error: null },
    subscribe: () => () => {},
    prompt: async (_text, accepted, paths) => {
      attachments = paths;
      accepted?.();
      return ok(undefined);
    },
    close: async () => ok(undefined),
  };
  const registry = new SessionRegistry(
    new RepositoryCatalog([]),
    async (created) => {
      context = created;
      return executor;
    },
    "chat",
  );
  const created = await registry.createChat();
  expect(created.ok).toBe(true);
  if (!created.ok) throw created.error;
  expect(context?.scope).toEqual({ kind: "chat" });
  expect(context?.worktreeId).toBeUndefined();
  expect(context?.cwd).toBe(homedir());
  expect(
    (await registry.prompt(created.value, "Analyze the image", undefined, ["Pictures/pic.png"])).ok,
  ).toBe(true);
  expect(attachments).toEqual([join(homedir(), "Pictures/pic.png")]);
  expect(registry.snapshot).toEqual([]);
  expect((await registry.shutdown()).ok).toBe(true);
});

function fixtureExecutor(
  conversationId: string = crypto.randomUUID(),
  sessionFile?: string,
): SessionExecutor & {
  closes: number;
} {
  // Runs stay active until close, like an SDK turn that is aborted by shutdown.
  const stopped = Promise.withResolvers<void>();
  return {
    savedSessionId: conversationId,
    sessionFile,
    state: { conversationId, status: "working", output: "unsaved work", error: null },
    closes: 0,
    subscribe: () => () => {},
    prompt: async () => {
      await stopped.promise;
      return ok(undefined);
    },
    async close() {
      this.closes++;
      stopped.resolve();
      return ok(undefined);
    },
  };
}

test("Destroying a worktree stops its sessions and children while preserving siblings", async () => {
  // A running child and an in-flight child factory both belong to the removed scope.
  const executors: (SessionExecutor & { closes: number })[] = [];
  const contexts: SessionContext[] = [];
  const pendingChild = Promise.withResolvers<SessionExecutor>();
  const registry = new SessionRegistry(demoWorkspace(), async (context) => {
    contexts.push(context);
    if (context.role === "subagent" && context.agent === "pending") return pendingChild.promise;
    const created = fixtureExecutor();
    executors.push(created);
    return created;
  });
  try {
    const removed = expectOk(await registry.create("demo:main"));
    const sibling = expectOk(await registry.create("demo:feature"));
    const running = contexts[0]!.coordinateSubagents!({
      action: "spawn",
      agent: "running",
      task: "keep working",
    });
    expectOk(await running);
    void contexts[0]!.spawnSubagent("pending", "never adopted");
    await Bun.sleep(0);

    const destroyed = registry.destroyWorktrees(new Set(["demo:main"]));
    const lateChild = fixtureExecutor();
    pendingChild.resolve(lateChild);
    expectOk(await destroyed);
    expect(lateChild.closes).toBe(1);

    expect(executors[0]!.closes).toBe(1);
    expect(executors[2]!.closes).toBe(1);
    expect(executors[1]!.closes).toBe(0);
    expect(registry.retainedWorktreeIds).toEqual(new Set(["demo:feature"]));
    expect(registry.checkpointRecords.map((record) => record.worktreeId)).toEqual(["demo:feature"]);
    expect(registry.details(sibling)?.status).toBe("working");
    expect(registry.details(removed)).toBeNull();

    // The fence rejects new work, and repeating deletion is a no-op.
    expect(expectError(await registry.create("demo:main")).code).toBe("SESSION_NOT_OPEN");
    expectOk(await registry.destroyWorktrees(new Set(["demo:main"])));
  } finally {
    expectOk(await registry.shutdown());
  }
});

test("A factory completing after deletion is closed and a released scope starts fresh", async () => {
  // A recreated directory gets a new generation; late work from the old one cannot adopt it.
  const late = fixtureExecutor();
  const pending = Promise.withResolvers<SessionExecutor>();
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const registry = new SessionRegistry(demoWorkspace(), async () => {
    if (++calls === 1) {
      started.resolve();
      return pending.promise;
    }
    return fixtureExecutor();
  });
  try {
    const creating = registry.create("demo:main");
    await started.promise;

    // Fencing is synchronous; release is refused until the old operation has drained.
    registry.fenceWorktrees(new Set(["demo:main"]));
    expect(expectError(registry.releaseWorktrees(new Set(["demo:main"]))).code).toBe(
      "SESSION_BUSY",
    );
    const destroyed = registry.destroyWorktrees(new Set(["demo:main"]));
    pending.resolve(late);

    expect(expectError(await creating).code).toBe("CANCELLED");
    expectOk(await destroyed);
    expect(late.closes).toBe(1);

    expectOk(registry.releaseWorktrees(new Set(["demo:main"])));
    const fresh = expectOk(await registry.create("demo:main"));
    expect(registry.records.map((record) => record.id)).toEqual([fresh]);
    expect(registry.checkpointRecords.map((record) => record.id)).toEqual([fresh]);
  } finally {
    expectOk(await registry.shutdown());
  }
});

test("A pending replacement is cancelled and cleaned up by worktree deletion", async () => {
  const original = fixtureExecutor();
  const next = fixtureExecutor();
  const prepared = Promise.withResolvers<SessionExecutor>();
  const preparing = Promise.withResolvers<void>();
  let calls = 0;
  const registry = new SessionRegistry(demoWorkspace(), async () => {
    if (++calls === 1) return original;
    preparing.resolve();
    return prepared.promise;
  });
  try {
    const id = expectOk(await registry.create("demo:main"));
    let accepted = false;
    const replacement = registry.clearSession(id, () => {
      accepted = true;
    });
    await preparing.promise;

    const destroyed = registry.destroyWorktrees(new Set(["demo:main"]));
    prepared.resolve(next);

    expect(expectError(await replacement).code).toBe("CANCELLED");
    const candidates = expectOk(await destroyed);
    expect(accepted).toBe(false);
    expect(original.closes).toBe(1);
    expect(next.closes).toBe(1);
    expect(registry.retainedWorktreeIds.size).toBe(0);
    expect(registry.checkpointRecords).toEqual([]);
    // The unadopted replacement conversation is still inventoried for cleanup.
    expect(candidates.map((candidate) => candidate.conversationId).sort()).toEqual(
      [original.savedSessionId, next.savedSessionId].sort(),
    );
  } finally {
    expectOk(await registry.shutdown());
  }
});

test("Failed scoped cleanup is reported and remains retained for retry", async () => {
  // A timeout or SDK failure never counts as a stopped session.
  let failures = 1;
  const stubborn = fixtureExecutor();
  stubborn.close = async function () {
    if (failures-- > 0) return err(new StorageError("Fixture close failed", "EIO"));
    this.closes++;
    return ok(undefined);
  };
  const registry = new SessionRegistry(demoWorkspace(), async () => stubborn);
  try {
    expectOk(await registry.create("demo:main"));

    expect(expectError(await registry.destroyWorktrees(new Set(["demo:main"]))).code).toBe(
      "CLEANUP_FAILED",
    );
    expect(registry.retainedWorktreeIds.has("demo:main")).toBe(true);
    expect(expectError(registry.releaseWorktrees(new Set(["demo:main"]))).code).toBe(
      "SESSION_BUSY",
    );

    expectOk(await registry.destroyWorktrees(new Set(["demo:main"])));
    expect(stubborn.closes).toBe(1);
    expect(registry.retainedWorktreeIds.size).toBe(0);
  } finally {
    expectOk(await registry.shutdown());
  }
});

test("Deletion inventories SDK files created after the fence without checkpointing them", async () => {
  // The late factory writes a managed SDK file after deletion started; only purge may see it.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "radian-scoped-stop-")));
  const lateFile = join(directory, "late.jsonl");
  const pending = Promise.withResolvers<SessionExecutor>();
  const started = Promise.withResolvers<void>();
  const registry = new SessionRegistry(demoWorkspace(), async () => {
    started.resolve();
    return pending.promise;
  });
  try {
    const creating = registry.create("demo:main");
    await started.promise;

    const destroyed = registry.destroyWorktrees(new Set(["demo:main"]));
    await writeFile(lateFile, JSON.stringify({ type: "session", id: "late" }) + "\n");
    const late = fixtureExecutor("late", lateFile);
    pending.resolve(late);

    expect(expectError(await creating).code).toBe("CANCELLED");
    const candidates = expectOk(await destroyed);
    expect(late.closes).toBe(1);
    expect(candidates).toEqual([
      {
        worktreeId: "demo:main",
        sessionId: expect.any(String),
        role: "main",
        conversationId: "late",
        sessionFile: lateFile,
        managed: true,
      },
    ]);
    expect(registry.checkpointRecords).toEqual([]);

    // Releasing after purge forgets the old generation's inventory.
    expectOk(registry.releaseWorktrees(new Set(["demo:main"])));
    expect(registry.worktreeDeletionCandidates(new Set(["demo:main"]))).toEqual([]);
  } finally {
    expectOk(await registry.shutdown());
    await rm(directory, { recursive: true, force: true });
  }
});

test("A replacement handle that failed to close stays retained until deletion retries it", async () => {
  const original = fixtureExecutor();
  const next = fixtureExecutor();
  // The replacement and deletion's in-pass retry both fail; a later deletion call succeeds.
  let failures = 2;
  next.close = async function () {
    if (failures-- > 0) return err(new StorageError("Fixture close failed", "EIO"));
    this.closes++;
    return ok(undefined);
  };
  const prepared = Promise.withResolvers<SessionExecutor>();
  const preparing = Promise.withResolvers<void>();
  let calls = 0;
  const registry = new SessionRegistry(demoWorkspace(), async () => {
    if (++calls === 1) return original;
    preparing.resolve();
    return prepared.promise;
  });
  try {
    const id = expectOk(await registry.create("demo:main"));
    const replacement = registry.clearSession(id);
    await preparing.promise;

    const destroyed = registry.destroyWorktrees(new Set(["demo:main"]));
    prepared.resolve(next);

    expect(expectError(await replacement).code).toBe("CLEANUP_FAILED");
    expect(expectError(await destroyed).code).toBe("CLEANUP_FAILED");
    expect(registry.retainedWorktreeIds.has("demo:main")).toBe(true);
    expect(
      registry
        .worktreeDeletionCandidates(new Set(["demo:main"]))
        .map((candidate) => candidate.conversationId),
    ).toContain(next.savedSessionId);

    expectOk(await registry.destroyWorktrees(new Set(["demo:main"])));
    expect(next.closes).toBe(1);
    expect(registry.retainedWorktreeIds.size).toBe(0);
  } finally {
    expectOk(await registry.shutdown());
  }
});
