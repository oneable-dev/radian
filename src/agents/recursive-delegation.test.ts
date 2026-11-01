import { expect, test } from "bun:test";
import { demoWorkspace } from "../workspace/demo.ts";
import {
  delegationLimits,
  SessionRegistry,
  type ExecutionState,
  type SessionContext,
  type SessionExecutor,
} from "./session-registry.ts";
import type { AgentProfile } from "./agent-profiles.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { ok, type Result } from "../result.ts";
import type { ExpectedError } from "../errors.ts";
import { sessionRecordSchema } from "../runtime/protocol.ts";
import { Value } from "typebox/value";

type Run = {
  id: string;
  status: string;
  output: string;
  questions: { id: string }[];
};

const profile = (name: string, delegation?: boolean): AgentProfile => ({
  name,
  description: `${name} role`,
  skills: [],
  prompt: "Role.",
  path: `/agents/${name}.md`,
  ...(delegation === undefined ? {} : { delegation: { enabled: delegation } }),
});
const lead = profile("lead", true);
const worker = profile("worker");

/** A child whose model run lasts until the test finishes it or cleanup aborts it. */
class HeldExecutor implements SessionExecutor {
  readonly savedSessionId = crypto.randomUUID();
  readonly sessionFile = undefined;
  state: ExecutionState = { status: null, output: "", error: null };
  readonly listeners = new Set<() => void>();
  readonly started = Promise.withResolvers<void>();
  readonly closingStarted = Promise.withResolvers<void>();
  private readonly run = Promise.withResolvers<void>();
  closeCalls = 0;
  holdClose: Promise<void> | undefined;
  task: string | undefined;

  constructor(
    readonly context: SessionContext,
    private readonly prompted: () => void = () => {},
  ) {}

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(task: string): Promise<Result<void, ExpectedError>> {
    this.task = task;
    this.prompted();
    this.update({ status: "working", output: "running", error: null });
    this.started.resolve();
    await this.run.promise;
    return ok(undefined);
  }

  finish(output = `${this.context.agent} done`) {
    this.update({
      status: "complete",
      output,
      finalOutput: output,
      error: null,
    });
    this.run.resolve();
  }

  update(state: ExecutionState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  async close(): Promise<Result<void, ExpectedError>> {
    this.closeCalls++;
    this.closingStarted.resolve();
    if (this.state.status === "working") this.update({ ...this.state, status: null });
    this.run.resolve();
    await this.holdClose;
    return ok(undefined);
  }
}

async function setup(options: { failFactory?: (context: SessionContext) => boolean } = {}) {
  const executors: HeldExecutor[] = [];
  const notices: unknown[] = [];
  const created = new Set<() => void>();
  const registry = new SessionRegistry(demoWorkspace(), async (context) => {
    if (options.failFactory?.(context)) throw new Error("Unexpected factory defect");
    const executor = new HeldExecutor(context, () => {
      for (const listener of created) listener();
    });
    if (context.role === "main")
      Object.assign(executor, {
        notifySubagent: (event: unknown) => notices.push(event),
      });
    executors.push(executor);
    for (const listener of created) listener();
    return executor;
  });
  const parent = expectOk(await registry.create("demo:main"));
  const root = executors[0]!;
  // Resolves when the child prompted with this task has started its model run.
  const byTask = async (task: string): Promise<HeldExecutor> => {
    for (;;) {
      const found = executors.find((executor) => executor.task === task);
      if (found) {
        await found.started.promise;
        return found;
      }
      const next = Promise.withResolvers<void>();
      created.add(next.resolve);
      await next.promise;
      created.delete(next.resolve);
    }
  };
  const spawn = (
    context: SessionContext,
    target: AgentProfile,
    task: string,
    extra: { async?: boolean } = {},
  ) =>
    context.coordinateSubagents!(
      { action: "spawn", agent: target.name, task, ...extra },
      undefined,
      undefined,
      target,
    );
  return {
    registry,
    parent,
    root,
    executors,
    notices,
    spawn,
    byTask,
    rows: () => registry.snapshot[0]!.worktrees[0]!.sessions[0]!.subagents,
    async cleanup() {
      for (const executor of executors) executor.finish();
      await registry.shutdown();
    },
  };
}

test("Delegation metadata grants a frozen coordinator only to opted-in children", async () => {
  // Capability follows the host-resolved launch profile, not the agent name.
  const app = await setup();
  try {
    expectOk(await app.spawn(app.root.context, lead, "lead-task"));
    expectOk(await app.spawn(app.root.context, worker, "worker-task"));
    const leadRun = await app.byTask("lead-task");
    const workerRun = await app.byTask("worker-task");

    expect(leadRun.context.profile).toEqual(lead);
    expect(leadRun.context.coordinateSubagents).toBeFunction();
    expect(workerRun.context.coordinateSubagents).toBeUndefined();
    expect(expectError(await workerRun.context.spawnSubagent("worker", "x")).code).toBe(
      "UNSUPPORTED_CAPABILITY",
    );
  } finally {
    await app.cleanup();
  }
});

test("Depth is limited to three levels below the root with a typed immediate failure", async () => {
  const app = await setup();
  try {
    expectOk(await app.spawn(app.root.context, lead, "d1"));
    const d1 = await app.byTask("d1");
    expectOk(await app.spawn(d1.context, lead, "d2"));
    const d2 = await app.byTask("d2");
    expectOk(await app.spawn(d2.context, lead, "d3"));
    const d3 = await app.byTask("d3");

    const overflow = await app.spawn(d3.context, worker, "d4");

    expect(expectError(overflow).code).toBe("DELEGATION_DEPTH_EXCEEDED");
    expect(app.rows().map((row) => [row.depth, row.ownerId === app.parent])).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
    expect(new Set(app.rows().map((row) => row.rootId))).toEqual(new Set([app.parent]));
  } finally {
    await app.cleanup();
  }
});

test("Concurrent spawns across the tree never exceed the root-wide active cap", async () => {
  // Reservations happen synchronously before factory creation, so a burst cannot overshoot.
  const app = await setup();
  try {
    expectOk(await app.spawn(app.root.context, lead, "lead"));
    const leadRun = await app.byTask("lead");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        app.spawn(index % 2 ? leadRun.context : app.root.context, worker, `w${index}`),
      ),
    );

    const failures = results.filter((result) => !result.ok);
    expect(results.filter((result) => result.ok)).toHaveLength(
      delegationLimits.activeDescendants - 1,
    );
    expect(failures.map((result) => expectError(result).code)).toEqual(
      Array(8 - (delegationLimits.activeDescendants - 1)).fill("DELEGATION_CAPACITY_EXCEEDED"),
    );
    expect(app.rows().filter((row) => row.status === "working")).toHaveLength(
      delegationLimits.activeDescendants,
    );
  } finally {
    await app.cleanup();
  }
});

test("Slots stay reserved during cleanup and release exactly once afterwards", async () => {
  const app = await setup();
  try {
    const ids: string[] = [];
    for (let index = 0; index < delegationLimits.activeDescendants; index++)
      ids.push((expectOk(await app.spawn(app.root.context, worker, `w${index}`)) as Run).id);
    const first = await app.byTask("w0");
    const release = Promise.withResolvers<void>();
    first.holdClose = release.promise;

    const stopping = app.root.context.coordinateSubagents!({
      action: "stop",
      id: ids[0]!,
    });
    await Promise.resolve();
    expect(expectError(await app.spawn(app.root.context, worker, "blocked")).code).toBe(
      "DELEGATION_CAPACITY_EXCEEDED",
    );
    release.resolve();
    expectOk(await stopping);
    // A repeated stop is idempotent and cannot free a second slot.
    expectOk(
      await app.root.context.coordinateSubagents!({
        action: "stop",
        id: ids[0]!,
      }),
    );

    expectOk(await app.spawn(app.root.context, worker, "admitted"));
    expect(expectError(await app.spawn(app.root.context, worker, "again")).code).toBe(
      "DELEGATION_CAPACITY_EXCEEDED",
    );
  } finally {
    await app.cleanup();
  }
});

test("Unexpected factory defects keep their stack and release the reservation", async () => {
  let fail = true;
  const app = await setup({
    failFactory: (context) => context.agent === "worker" && fail,
  });
  try {
    await expect(app.spawn(app.root.context, worker, "broken")).rejects.toThrow(
      "Unexpected factory defect",
    );
    fail = false;
    for (let index = 0; index < delegationLimits.activeDescendants; index++)
      expectOk(await app.spawn(app.root.context, worker, `w${index}`));
  } finally {
    await app.cleanup();
  }
});

test("Retained runs are capped per root without hidden queueing", async () => {
  const app = await setup();
  try {
    for (let index = 0; index < delegationLimits.retainedRuns; index++) {
      const run = expectOk(await app.spawn(app.root.context, worker, `r${index}`)) as Run;
      expectOk(
        await app.root.context.coordinateSubagents!({
          action: "stop",
          id: run.id,
        }),
      );
    }

    expect(expectError(await app.spawn(app.root.context, worker, "over")).code).toBe(
      "DELEGATION_RETENTION_EXCEEDED",
    );
  } finally {
    await app.cleanup();
  }
});

test("Owners control only their own children; the root cannot reach grandchildren", async () => {
  const app = await setup();
  try {
    const a = expectOk(await app.spawn(app.root.context, lead, "lead-a")) as Run;
    expectOk(await app.spawn(app.root.context, lead, "lead-b"));
    const leadA = await app.byTask("lead-a");
    const leadB = await app.byTask("lead-b");
    const grandchild = expectOk(await app.spawn(leadA.context, worker, "grandchild")) as Run;

    for (const action of ["status", "stop"] as const) {
      expect(
        expectError(
          await app.root.context.coordinateSubagents!({
            action,
            id: grandchild.id,
          }),
        ).code,
      ).toBe("INVALID_INPUT");
      expect(
        expectError(
          await leadB.context.coordinateSubagents!({
            action,
            id: grandchild.id,
          }),
        ).code,
      ).toBe("INVALID_INPUT");
      expect(expectError(await leadA.context.coordinateSubagents!({ action, id: a.id })).code).toBe(
        "INVALID_INPUT",
      );
    }
    const visible = expectOk(await leadA.context.coordinateSubagents!({ action: "status" }));
    expect((visible as Run[]).map((run) => run.id)).toEqual([grandchild.id]);
    // Root UI observes the flattened tree with owner ancestry.
    expect(app.rows().find((row) => row.id === grandchild.id)?.ownerId).toBe(a.id);
  } finally {
    await app.cleanup();
  }
});

test("Questions escalate worker to Lead to root, and wait returns on pending asks", async () => {
  const app = await setup();
  try {
    expectOk(await app.spawn(app.root.context, lead, "lead"));
    const leadRun = await app.byTask("lead");
    const work = expectOk(await app.spawn(leadRun.context, worker, "work")) as Run;
    const workRun = await app.byTask("work");

    const leadWait = leadRun.context.coordinateSubagents!({
      action: "wait",
      id: work.id,
    });
    const workerAnswer = workRun.context.contactSupervisor!({
      action: "ask",
      message: "Keep API?",
    });
    const waited = expectOk(await leadWait) as Run[];
    expect(waited[0]).toMatchObject({ status: "waiting" });
    // Only root-owned runs wake the root conversation.
    expect(app.notices).toEqual([]);

    const rootWait = app.root.context.coordinateSubagents!({ action: "wait" });
    const leadAnswer = leadRun.context.contactSupervisor!({
      action: "ask",
      message: "Escalated: keep API?",
    });
    const pending = (expectOk(await rootWait) as Run[])[0]!;
    expect(pending.questions).toHaveLength(1);
    expectOk(
      await app.root.context.coordinateSubagents!({
        action: "reply",
        id: pending.id,
        questionId: pending.questions[0]!.id,
        message: "Yes",
      }),
    );
    expect(expectOk(await leadAnswer)).toMatchObject({ message: "Yes" });
    expectOk(
      await leadRun.context.coordinateSubagents!({
        action: "reply",
        id: work.id,
        questionId: waited[0]!.questions[0]!.id,
        message: "Yes",
      }),
    );
    expect(expectOk(await workerAnswer)).toMatchObject({ message: "Yes" });
  } finally {
    await app.cleanup();
  }
});

test("A delegator finishing with live children fails as unfinished and cancels its subtree", async () => {
  const app = await setup();
  try {
    const leadRun = expectOk(await app.spawn(app.root.context, lead, "lead")) as Run;
    const leadExecutor = await app.byTask("lead");
    expectOk(await app.spawn(leadExecutor.context, worker, "orphan"));
    const orphan = await app.byTask("orphan");

    leadExecutor.finish("Premature answer");
    const [status] = expectOk(
      await app.root.context.coordinateSubagents!({
        action: "wait",
        id: leadRun.id,
      }),
    ) as (Run & { error: string })[];

    expect(status).toMatchObject({ status: "failure", output: "" });
    expect(status!.error).toContain("still active");
    expect(orphan.closeCalls).toBe(1);
    expect(app.rows().every((row) => row.status !== "working")).toBe(true);
    expect(app.registry.records[0]!.ownedSubagents![0]!.finalOutput).toBeUndefined();
    const archived = app.registry.checkpointRecords.find((record) => record.id === leadRun.id)!;
    expect(archived.state.status).toBe("failure");
    expect(archived.state.finalOutput).toBeUndefined();
    expect(archived.state.result?.outcome).toBe("unfinished");
    expect(archived.state.error).toContain("still active");
  } finally {
    await app.cleanup();
  }
});

test.each([false, true])(
  "A premature Lead final fails while %s nested descendant cleanup is still pending",
  async (nested) => {
    // Model completion is not settlement when a worker's close operation is still blocked.
    const app = await setup();
    const release = Promise.withResolvers<void>();
    try {
      const outer = expectOk(await app.spawn(app.root.context, lead, "outer")) as Run;
      const outerExecutor = await app.byTask("outer");
      let owner = outerExecutor;
      if (nested) {
        expectOk(await app.spawn(outerExecutor.context, lead, "inner"));
        owner = await app.byTask("inner");
      }
      expectOk(await app.spawn(owner.context, worker, "finished-worker"));
      const work = await app.byTask("finished-worker");
      work.holdClose = release.promise;
      work.finish("Worker model finished");
      await work.closingStarted.promise;
      if (nested) {
        owner.finish("Inner final before cleanup");
        await owner.closingStarted.promise;
      }

      outerExecutor.finish("Outer final before cleanup");
      const waiting = app.root.context.coordinateSubagents!({ action: "wait", id: outer.id });
      release.resolve();
      const [status] = expectOk(await waiting) as Run[];

      expect(status).toMatchObject({ status: "failure", output: "" });
      const archived = app.registry.checkpointRecords.find((record) => record.id === outer.id)!;
      expect(archived.state.status).toBe("failure");
      expect(archived.state.finalOutput).toBeUndefined();
    } finally {
      release.resolve();
      await app.cleanup();
    }
  },
);

test("A closing supervisor retains capacity until its descendant cleanup settles", async () => {
  // The supervisor's own handle can close before the worker whose cleanup it still owns.
  const app = await setup();
  const release = Promise.withResolvers<void>();
  try {
    const branch = expectOk(await app.spawn(app.root.context, lead, "branch")) as Run;
    const owner = await app.byTask("branch");
    expectOk(await app.spawn(owner.context, worker, "deep"));
    const deep = await app.byTask("deep");
    deep.holdClose = release.promise;
    for (let index = 0; index < 3; index++)
      expectOk(await app.spawn(app.root.context, worker, `sibling-${index}`));

    const stopping = app.root.context.coordinateSubagents!({ action: "stop", id: branch.id });
    await deep.closingStarted.promise;
    await app.root.context.coordinateSubagents!({ action: "status", id: branch.id });
    const overflow = await app.spawn(app.root.context, worker, "not-yet");

    expect(owner.closeCalls).toBe(1);
    expect(expectError(overflow).code).toBe("DELEGATION_CAPACITY_EXCEEDED");
    release.resolve();
    expectOk(await stopping);
    expectOk(await app.spawn(app.root.context, worker, "now-admitted"));
  } finally {
    release.resolve();
    await app.cleanup();
  }
});

test("Synchronous spawn of a delegating target is rejected", async () => {
  const app = await setup();
  try {
    expect(
      expectError(await app.spawn(app.root.context, lead, "sync", { async: false })).code,
    ).toBe("UNSUPPORTED_CAPABILITY");
    expect(app.executors).toHaveLength(1);
  } finally {
    await app.cleanup();
  }
});

test("Branch stop cancels descendants but not siblings; stale handles cannot resurrect", async () => {
  const app = await setup();
  try {
    const a = expectOk(await app.spawn(app.root.context, lead, "a")) as Run;
    expectOk(await app.spawn(app.root.context, worker, "sibling"));
    const leadA = await app.byTask("a");
    expectOk(await app.spawn(leadA.context, lead, "a1"));
    const a1 = await app.byTask("a1");
    expectOk(await app.spawn(a1.context, worker, "a2"));
    const a2 = await app.byTask("a2");
    const sibling = await app.byTask("sibling");

    expectOk(await app.root.context.coordinateSubagents!({ action: "stop", id: a.id }));

    expect([leadA, a1, a2].map((executor) => executor.closeCalls)).toEqual([1, 1, 1]);
    expect(sibling.closeCalls).toBe(0);
    expect(expectError(await app.spawn(a1.context, worker, "late")).code).toBe("CANCELLED");
    expect(expectError(await a1.context.coordinateSubagents!({ action: "status" })).code).toBe(
      "CANCELLED",
    );
  } finally {
    await app.cleanup();
  }
});

test.each(["close", "interrupt", "clear", "shutdown"])(
  "Root %s cancels every descendant",
  async (operation) => {
    const app = await setup();
    try {
      expectOk(await app.spawn(app.root.context, lead, "lead"));
      const leadRun = await app.byTask("lead");
      expectOk(await app.spawn(leadRun.context, worker, "deep"));
      const deep = await app.byTask("deep");
      Object.assign(app.root, { interrupt: async () => ok(undefined) });

      if (operation === "close") expectOk(await app.registry.close(app.parent));
      else if (operation === "interrupt") expectOk(await app.registry.interrupt(app.parent));
      else if (operation === "clear") expectOk(await app.registry.clearSession(app.parent));
      else expectOk(await app.registry.shutdown());

      expect([leadRun.closeCalls, deep.closeCalls]).toEqual([1, 1]);
      expect(expectError(await app.spawn(leadRun.context, worker, "late")).code).not.toBe(
        undefined,
      );
    } finally {
      await app.cleanup();
    }
  },
);

test("Planning children never receive coordination even with delegation metadata", async () => {
  const app = await setup();
  try {
    expectOk(
      await app.root.context.coordinateSubagents!(
        { action: "spawn", agent: "lead", task: "plan" },
        undefined,
        "planning",
        lead,
      ),
    );
    const planner = await app.byTask("plan");

    expect(planner.context.purpose).toBe("planning");
    expect(planner.context.coordinateSubagents).toBeUndefined();
    // Ordinary delegators cannot forge a planning purpose for their own children.
    expectOk(await app.spawn(app.root.context, lead, "lead"));
    const leadRun = await app.byTask("lead");
    expect(
      expectError(
        await leadRun.context.coordinateSubagents!(
          { action: "spawn", agent: "worker", task: "forged" },
          undefined,
          "planning",
          worker,
        ),
      ).code,
    ).toBe("UNSUPPORTED_CAPABILITY");
    expect(
      expectError(
        await leadRun.context.contactSupervisor!({
          action: "proposal",
          proposal: {} as never,
        }),
      ).code,
    ).toBe("UNSUPPORTED_CAPABILITY");
  } finally {
    await app.cleanup();
  }
});

test("Nested records persist ancestry and legacy records restore as root children", async () => {
  const app = await setup();
  try {
    const leadRun = expectOk(await app.spawn(app.root.context, lead, "lead")) as Run;
    const leadExecutor = await app.byTask("lead");
    expectOk(await app.spawn(leadExecutor.context, worker, "nested"));
    const record = app.registry.records[0]!;
    const owned = record.ownedSubagents!;

    expect(owned.map((child) => [child.depth, child.ownerId])).toEqual([
      [1, app.parent],
      [2, leadRun.id],
    ]);
    expect(Value.Check(sessionRecordSchema, record)).toBe(true);
    const legacy = {
      ...record,
      ownedSubagents: owned.map(({ ownerId: _o, rootId: _r, depth: _d, ...rest }) => rest),
    };
    expect(Value.Check(sessionRecordSchema, legacy)).toBe(true);
    expectOk(await app.registry.close(app.parent));

    const restored = new SessionRegistry(demoWorkspace(), async (context) => {
      const executor = new HeldExecutor(context);
      return executor;
    });
    try {
      expectOk(
        await restored.restore({
          ...record,
          lifecycle: "open",
          closedAt: null,
        }),
      );
      const rows = restored.records[0]!.ownedSubagents!;
      expect(rows.map((row) => [row.depth, row.ownerId])).toEqual([
        [1, record.id],
        [2, leadRun.id],
      ]);
      expect(rows.every((row) => row.status !== "working")).toBe(true);
      expectOk(await restored.close(record.id));
      expectOk(
        await restored.restore({
          ...legacy,
          lifecycle: "open",
          closedAt: null,
        }),
      );
      expect(restored.records[0]!.ownedSubagents!.map((row) => row.depth)).toEqual([1, 1]);
    } finally {
      await restored.shutdown();
    }
  } finally {
    await app.cleanup();
  }
});
