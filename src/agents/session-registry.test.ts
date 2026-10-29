import { expect, spyOn, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoWorkspace } from "../workspace/demo.ts";
import { WorkspaceSelection } from "../app/workspace-selection.ts";
import {
  SessionRegistry,
  type ExecutionState,
  type SessionContext,
  type SessionExecutor,
} from "./session-registry.ts";
import { expectOk, expectError } from "../testing/results.ts";
import { err, ok, type Result } from "../result.ts";
import { StorageError, type ExpectedError } from "../errors.ts";

class ControlledExecutor implements SessionExecutor {
  readonly savedSessionId = crypto.randomUUID();
  state: ExecutionState = { status: null, output: "", error: null };
  readonly listeners = new Set<() => void>();
  readonly closeStarted = Promise.withResolvers<void>();
  readonly finishClose = Promise.withResolvers<void>();
  closeCalls = 0;
  promptCalls = 0;
  failClose = false;
  readonly sessionFile: string | undefined;

  constructor(sessionFile?: string) {
    this.sessionFile = sessionFile;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  async prompt(): Promise<Result<void, ExpectedError>> {
    this.promptCalls++;
    this.update({ status: "working", output: "running", error: null });

    return ok(undefined);
  }

  update(state: ExecutionState) {
    this.state = state;
    for (const listener of this.listeners) {
      listener();
    }
  }

  async close(): Promise<Result<void, ExpectedError>> {
    this.closeCalls++;
    this.closeStarted.resolve();
    if (this.failClose) {
      return err(new StorageError("controlled cleanup failure"));
    }

    await this.finishClose.promise;

    return ok(undefined);
  }
}

function setup() {
  const executors: ControlledExecutor[] = [];
  const contexts: SessionContext[] = [];
  const repositories = demoWorkspace().map((repo) => ({
    ...repo,
    worktrees: repo.worktrees.map((tree) => ({ ...tree, sessions: [] })),
  }));
  const registry = new SessionRegistry(repositories, async (context) => {
    const executor = new ControlledExecutor(context.sessionFile);
    contexts.push(context);
    executors.push(executor);

    return executor;
  });
  const selection = new WorkspaceSelection(registry.snapshot);
  const unsubscribe = registry.subscribe(() => selection.replaceSnapshot(registry.snapshot));

  return {
    registry,
    selection,
    executors,
    contexts,
    async cleanup() {
      executors.forEach((executor) => {
        executor.failClose = false;
        executor.finishClose.resolve();
      });
      await registry.shutdown();
      unsubscribe();
    },
  };
}

test("Worktree switching and background updates never close or recreate existing run handles", async () => {
  // Registry snapshots, not view selection, own the executor instances.
  const app = setup();
  try {
    const a = expectOk(await app.registry.create("demo:main"));
    const b = expectOk(await app.registry.create("demo:feature"));

    expectOk(await app.registry.prompt(a, "continue"));

    // Leaving A does not unsubscribe A's background events.
    app.selection.selectSession("demo:feature", b);
    app.executors[0]!.update({ status: "complete", output: "background result", error: null });
    app.selection.selectWorktree("demo:main");

    // The original handle, result and per-worktree selection survive.
    expect(app.selection.sessionId).toBe(a);
    expect(app.registry.details(a)?.output).toBe("background result");
    expect(app.executors).toHaveLength(2);
    expect(app.executors.map((executor) => executor.closeCalls)).toEqual([0, 0]);
    expect(app.contexts.map((context) => context.cwd)).toEqual(["/demo/radian", "/demo/radian-ui"]);
  } finally {
    await app.cleanup();
  }
});

test("Closing hides entries immediately, retains handles through cleanup, and coalesces duplicates", async () => {
  // Cleanup is deliberately blocked so optimistic UI behavior is independently observable.
  const app = setup();
  try {
    const a = expectOk(await app.registry.create("demo:main"));
    const b = expectOk(await app.registry.create("demo:main"));

    app.selection.selectSession("demo:main", a);

    // The display changes synchronously, before the executor acknowledges cancellation.
    const closing = app.registry.close(a);
    expect(app.registry.close(a)).toBe(closing);
    expect(app.selection.sessionId).toBe(b);
    expect(app.registry.closingCount).toBe(1);
    await app.executors[0]!.closeStarted.promise;
    app.executors[0]!.update({ status: "working", output: "late event", error: null });
    expect(expectError(await app.registry.prompt(a, "late prompt")).code).toBe("SESSION_NOT_OPEN");
    expect(expectError(await app.contexts[0]!.spawnSubagent("late", "task")).code).toBe(
      "SESSION_NOT_OPEN",
    );

    // Late events cannot resurrect the row or close an unrelated session.
    expect(app.selection.worktree?.sessions.map((session) => session.id)).toEqual([b]);
    expect(app.executors[1]!.closeCalls).toBe(0);
    app.executors[0]!.finishClose.resolve();
    await closing;
    expect(app.registry.closingCount).toBe(0);
    expect(app.executors[0]!.listeners.size).toBe(0);
    expect(app.executors[0]!.closeCalls).toBe(1);
  } finally {
    await app.cleanup();
  }
});

test("Closed snapshots preserve final conversations and pre-close status until persistence acknowledgement", async () => {
  // History retains pre-close presentation even if cleanup clears Fast telemetry.
  const app = setup();
  try {
    const id = expectOk(await app.registry.create("demo:main"));
    const executor = app.executors[0]!;
    const telemetry = {
      provider: "fixture",
      model: "model",
      effort: "high",
      fast: true,
      context: null,
      weekly: null,
    };

    executor.update({ status: "working", output: "Before close", error: null, telemetry });

    // Cleanup produces a newer closed snapshot while the first save is pending.
    const closing = app.registry.close(id);
    const firstCheckpoint = app.registry.checkpointRecords;

    await executor.closeStarted.promise;
    executor.update({ status: "complete", output: "Final settled output", error: null });
    executor.finishClose.resolve();
    expectOk(await closing);
    app.registry.acknowledgeCheckpoint(firstCheckpoint);

    // A late save acknowledgement cannot delete the final snapshot or execute closed conversations.
    const final = app.registry.checkpointRecords;
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({
      lifecycle: "closed",
      state: { output: "Final settled output", telemetry },
    });
    expect(app.registry.sessionSnapshot("demo:main", executor.savedSessionId)).toBe(final[0]);
    expect(app.registry.records).toEqual([]);
    expectOk(await app.registry.restore(final[0]!));
    expect(app.executors).toHaveLength(1);
    app.registry.acknowledgeCheckpoint(final);
    expect(app.registry.checkpointRecords).toEqual([]);
  } finally {
    await app.cleanup();
  }
});

test("Resume clears closedAt, reclosing refreshes it, and cleanup reservations block new SDK writers", async () => {
  // Resuming the same SDK conversation must not reuse creation or previous close times.
  const directory = await mkdtemp(join(tmpdir(), "radian-retention-registry-"));
  const path = join(directory, "saved.jsonl");

  await writeFile(path, JSON.stringify({ type: "session" }) + "\n");

  const file = await realpath(path);
  const repositories = demoWorkspace();
  let time = 1000;
  let factories = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => time);
  const registry = new SessionRegistry(repositories, async () => {
    factories++;

    return {
      savedSessionId: "saved",
      sessionFile: file,
      state: { status: "complete", output: "Saved", error: null },
      subscribe: () => () => {},
      prompt: async () => ok(undefined),
      close: async () => ok(undefined),
    };
  });
  try {
    const first = expectOk(await registry.create("demo:main"));
    expect(registry.records[0]?.managed).toBe(true);
    expectOk(await registry.close(first));

    const old = registry.checkpointRecords[0]!;
    expect(old.closedAt).toBe(1000);

    // Resuming in another tab removes expiry; closing again establishes a new retention origin.
    time = 2000;

    const second = expectOk(
      await registry.create("demo:main", file, { id: "reopened", name: "Saved", managed: true }),
    );
    expect(registry.records[0]?.closedAt).toBeNull();
    time = 3000;
    expectOk(await registry.close(second));

    const closed = registry.checkpointRecords[0]!;
    const info = {
      ...closed,
      lifecycle: "closed" as const,
      conversationId: "saved",
      updatedAt: 3000,
      title: "Saved",
      messageCount: 1,
    };

    // Reject stale deletion candidates and block SDK writers during valid cleanup reservations.
    expect(closed.closedAt).toBe(3000);
    expect(registry.reserveSnapshotCleanup({ ...info, closedAt: 1000 }, file)).toBeNull();

    const release = registry.reserveSnapshotCleanup(info, file);
    if (!release) {
      throw new Error("Missing cleanup reservation");
    }

    expect(expectError(await registry.create("demo:main", file)).code).toBe("SESSION_CONFLICT");
    expect(factories).toBe(2);
    release();
    expectOk(await registry.create("demo:main", file));
    expect(factories).toBe(3);
  } finally {
    clock.mockRestore();
    await registry.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Parent and child cancellation start together to avoid parent-waits-for-child deadlocks", async () => {
  // A child remains owned while its cleanup is blocked.
  const app = setup();
  try {
    const id = expectOk(await app.registry.create("demo:main"));
    const started = Promise.withResolvers<void>();
    const unsubscribe = app.registry.subscribe(() => {
      if (app.registry.snapshot[0]?.worktrees[0]?.sessions[0]?.subagents[0]?.status === "working") {
        started.resolve();
      }
    });
    const child = app.contexts[0]!.spawnSubagent("child", "task");

    // The child prompt finishes but its owned cleanup has not yet completed.
    await started.promise;
    unsubscribe();
    await app.executors[1]!.closeStarted.promise;

    // Parent close must start without first waiting for the child to finish cleanup.
    const closing = app.registry.close(id);
    await app.executors[0]!.closeStarted.promise;
    app.executors[0]!.finishClose.resolve();
    app.executors[1]!.finishClose.resolve();
    await Promise.all([child, closing]);

    // Both owned handles are cleaned once and no hidden execution remains.
    expect(app.executors.map((executor) => executor.closeCalls)).toEqual([1, 1]);
    expect(app.registry.closingCount).toBe(0);
  } finally {
    await app.cleanup();
  }
});

test("Cleanup failures retain hidden handles for retries and never report success", async () => {
  // The first cleanup attempt fails instead of acknowledging termination.
  const app = setup();
  try {
    const id = expectOk(await app.registry.create("demo:main"));
    app.executors[0]!.failClose = true;

    // The row disappears, but the rejected close remains visible to its caller.
    expect(expectError(await app.registry.close(id)).code).toBe("CLEANUP_FAILED");
    expect(app.registry.snapshot[0]!.worktrees[0]!.sessions).toEqual([]);
    expect(app.registry.closingCount).toBe(1);
    app.executors[0]!.failClose = false;
    app.executors[0]!.finishClose.resolve();
    await app.registry.close(id);

    // Retry cleans the retained handle; it does not manufacture a replacement execution.
    expect(app.executors[0]!.closeCalls).toBe(2);
    expect(app.registry.closingCount).toBe(0);
  } finally {
    await app.cleanup();
  }
});

test("Shutdown cleans up late-created runs without resurrecting open entries", async () => {
  // Factory completion is under test control rather than a timing-dependent sleep.
  const ready = Promise.withResolvers<SessionExecutor>();
  const executor = new ControlledExecutor();

  executor.finishClose.resolve();

  const registry = new SessionRegistry(demoWorkspace(), () => ready.promise);
  const creation = registry.create("demo:main");
  const creationOutcome = creation;

  // Shutdown takes ownership before the factory supplies its handle.
  const shutdown = registry.shutdown();

  ready.resolve(executor);

  const [creationResult, shutdownResult] = await Promise.all([creationOutcome, shutdown]);
  expect(expectError(creationResult).code).toBe("CANCELLED");
  expectOk(shutdownResult);

  // No new work can enter and no late factory result is leaked.
  expect(executor.closeCalls).toBe(1);
  expect(registry.snapshot[0]!.worktrees[0]!.sessions).toEqual([]);
  expect(expectError(await registry.create("demo:main")).code).toBe("RUNTIME_STOPPING");
});

test("Late child creation during parent closure is cleaned up without execution", async () => {
  // The parent exists while its child's factory is held at the creation boundary.
  const childReady = Promise.withResolvers<SessionExecutor>();
  const parent = new ControlledExecutor();
  const child = new ControlledExecutor();

  parent.finishClose.resolve();
  child.finishClose.resolve();

  let context: SessionContext | undefined;
  const registry = new SessionRegistry(demoWorkspace(), async (input) => {
    if (input.role === "subagent") {
      return childReady.promise;
    }

    context = input;

    return parent;
  });
  const id = expectOk(await registry.create("demo:main"));
  const spawning = context!.spawnSubagent("pending", "task");
  const spawnOutcome = spawning;

  // Close removes the root immediately, then awaits the pending child's eventual handle.
  const closing = registry.close(id);

  childReady.resolve(child);

  const [closed, spawnResult] = await Promise.all([closing, spawnOutcome]);
  expectOk(closed);
  expect(expectError(spawnResult).code).toBe("SESSION_NOT_OPEN");

  // The child cannot start work after its owner closes.
  expect(child.promptCalls).toBe(0);
  expect(child.closeCalls).toBe(1);
  expect(registry.closingCount).toBe(0);
  await registry.shutdown();
});

test("Duplicate file and symlink opens remain blocked until cleanup completes", async () => {
  // Canonical identity, not UI IDs or spelling of the path, protects a saved history writer.
  const directory = await mkdtemp(join(tmpdir(), "radian-registry-file-"));
  const file = join(directory, "session.jsonl");
  const alias = join(directory, "alias.jsonl");
  const executor = new ControlledExecutor(file);
  const registry = new SessionRegistry(demoWorkspace(), async () => executor);
  try {
    await writeFile(file, "existing history\n");
    await symlink(file, alias);

    const id = expectOk(await registry.create("demo:main", file));

    // A closing row is hidden, but its writer reservation remains until cleanup completes.
    expect(expectError(await registry.create("demo:main", alias)).code).toBe("SESSION_CONFLICT");

    const closing = registry.close(id);
    expect(expectError(await registry.create("demo:main", alias)).code).toBe("SESSION_CONFLICT");
    executor.finishClose.resolve();
    await closing;

    const reopened = expectOk(await registry.create("demo:main", alias));

    // Reopening uses the original file instead of cloning or deleting it.
    expect(registry.sessionFile(reopened)).toBe(file);
    expect(await Bun.file(file).text()).toBe("existing history\n");
  } finally {
    executor.finishClose.resolve();
    await registry.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Runtime recovery recomputes telemetry instead of replaying cached Fast observations and weekly quotas", async () => {
  // A previous process's account allowance and request tier are not current measurements.
  const executor = new ControlledExecutor();
  const fresh: NonNullable<ExecutionState["telemetry"]> = {
    provider: "provider",
    model: "current-model",
    effort: "high",
    fast: null,
    context: { usedTokens: 1000, maxTokens: 200000 },
    weekly: null,
  };

  executor.state = { status: "complete", output: "", error: null, telemetry: fresh };

  const registry = new SessionRegistry(demoWorkspace(), async () => executor);
  try {
    expectOk(
      await registry.restore({
        id: "restored",
        name: "Restored",
        worktreeId: "demo:main",
        subagents: [],
        state: {
          status: "complete",
          output: "",
          error: null,
          telemetry: {
            ...fresh,
            model: "old-model",
            fast: true,
            weekly: { remainingPercent: 82, observedAt: 1800000000000, resetsAt: 1800003600000 },
          },
        },
      }),
    );

    expect(registry.details("restored")?.telemetry).toEqual(fresh);
    expect(registry.records[0]?.state.telemetry?.weekly).toBeNull();
    // Background usage publication must remain live even while the restored transcript is frozen.
    executor.update({
      ...executor.state,
      telemetry: {
        ...fresh,
        usage: {
          provider: "acme",
          status: "ready",
          windows: [{ id: "quota", usedPercent: 10, periodMs: 604800000, resetsAt: 1800003600000 }],
          updatedAt: 1800000000000,
          errorCode: null,
        },
      },
    });
    expect(registry.details("restored")?.telemetry?.usage?.windows[0]?.usedPercent).toBe(10);
  } finally {
    executor.finishClose.resolve();
    await registry.shutdown();
  }
});

test("Creation failure leaves worktrees empty without automatic recreation", async () => {
  // Factory failure is a user-visible failure, not an invented placeholder session.
  let calls = 0;
  const registry = new SessionRegistry(demoWorkspace(), async () => {
    calls++;
    throw new StorageError("factory failed");
  });

  // The explicit creation request is rejected and its reservation is cleaned.
  expect(expectError(await registry.create("demo:main")).code).toBe("STORAGE_FAILED");
  await registry.shutdown();

  // No ghost item or automatic retry changes the user's empty workspace.
  expect(calls).toBe(1);
  expect(registry.snapshot[0]!.worktrees[0]!.sessions).toEqual([]);
  expect(registry.closingCount).toBe(0);
});

test("Observed Pi children never acquire owned handles or return as phantom workers after recovery", async () => {
  // Extension observations may be working even though the main SDK session is settled.
  const app = setup();
  const recovered = setup();
  try {
    const id = expectOk(await app.registry.create("demo:main"));
    app.executors[0]!.update({
      status: "complete",
      output: "",
      error: null,
      externalSubagents: [
        { id: "pi/fixture", name: "Pi reviewer", status: "working", source: "pi" },
      ],
    });

    const record = app.registry.records[0]!;
    expect(app.registry.snapshot[0]!.worktrees[0]!.sessions[0]!.subagents).toHaveLength(1);

    expectOk(await recovered.registry.restore(record));

    // Only a fresh extension snapshot may restore external activity; saved observations are not executors.
    expect(recovered.contexts.map((context) => context.role)).toEqual(["main"]);
    expect(recovered.registry.snapshot[0]!.worktrees[0]!.sessions[0]!.subagents).toEqual([]);
    expect(app.contexts).toHaveLength(1);
    expect(app.registry.details(id)?.status).toBe("complete");
  } finally {
    await Promise.all([app.cleanup(), recovered.cleanup()]);
  }
});

test("Subagent creation failures remain visible in parent snapshots rather than becoming missing or complete", async () => {
  // A child factory failure has no executor state from which to infer its outcome.
  const parent = new ControlledExecutor();
  parent.finishClose.resolve();

  let context: SessionContext | undefined;
  const registry = new SessionRegistry(demoWorkspace(), async (input) => {
    if (input.role === "subagent") {
      throw new StorageError("child setup failed");
    }

    context = input;

    return parent;
  });

  await registry.create("demo:main");

  // Delegation surfaces the setup error and retains a normalized failure outcome.
  expect(expectError(await context!.spawnSubagent("failed child", "task")).code).toBe(
    "STORAGE_FAILED",
  );

  // The failure wins in the existing UI aggregation even though no child handle was created.
  expect(registry.snapshot[0]!.worktrees[0]!.sessions[0]!.subagents[0]?.status).toBe("failure");
  await registry.shutdown();
});
