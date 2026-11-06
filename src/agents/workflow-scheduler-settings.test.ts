import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { expectError, expectOk } from "../testing/results.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { fixtureMessage, offlineRuntime } from "../testing/offline-runtime.ts";
import { AgentRunError, WorkflowError } from "../errors.ts";
import { err, ok } from "../result.ts";
import { piSessionFactory, type PiSessionOptions } from "./pi-session-adapter.ts";
import type { PlanningSchedulerControl } from "./workflow-scheduler-driver.ts";
import { SessionRegistry, type SessionContext, type SessionExecutor } from "./session-registry.ts";
import { openWorkflow } from "./task-workflow-store.ts";
import type { WorkflowDocumentV2 } from "./task-workflow.ts";

async function registryFixture(holdChildren = false) {
  const files = await createWorktreeFixture();
  const offline = await offlineRuntime(join(files.directory, "agent"));
  await writeFile(
    join(files.directory, "agent/agents/lead.md"),
    "---\nname: lead\ndescription: Offline lead\ntools: [read]\n---\nInvestigate only.\n",
  );
  const settings = {
    radian: { workflowScheduler: "on" as "on" | "off" },
    retry: { enabled: false },
    compaction: { enabled: false },
  };
  const contexts: SessionContext[] = [];
  const executors: SessionExecutor[] = [];
  const requests: { systemPrompt: string }[] = [];
  let cleanupFails = false;
  const createExecutor = async (context: SessionContext) => {
    contexts.push(context);
    const factory = piSessionFactory({
      ...offline,
      settings,
      defaultPackagePaths: [],
      streamFn(model, streamContext, options) {
        if (context.role === "main")
          requests.push({ systemPrompt: getCurrentSystemPrompt(streamContext.messages) });
        return offline.streamFn!(
          model,
          holdChildren && context.role === "subagent"
            ? {
                ...streamContext,
                messages: [{ role: "user", content: "slow", timestamp: Date.now() }],
              }
            : streamContext,
          options,
        );
      },
    });
    const executor = await factory(context);
    if (context.role === "subagent") {
      const close = executor.close.bind(executor);
      executor.close = async (...args) =>
        cleanupFails
          ? err(new AgentRunError("Offline cleanup outcome is uncertain."))
          : close(...args);
    }
    executors.push(executor);
    return executor;
  };
  const registry = new SessionRegistry([files.repository], createExecutor);
  const id = expectOk(await registry.create(files.main));
  const root = executors[0]!;
  const context = contexts[0]!;
  let call = 0;
  const readDocument = async () =>
    expectOk(
      await openWorkflow(root.sessionFile!, {
        cwd: context.cwd,
        conversationId: root.savedSessionId!,
      }),
    )!.doc;
  const read = async () => (await readDocument()) as WorkflowDocumentV2;
  return {
    registry,
    id,
    root,
    context,
    settings,
    executors,
    contexts,
    requests,
    read,
    readDocument,
    async reopen() {
      const reopened = new SessionRegistry([files.repository], createExecutor);
      const index = executors.length;
      const reopenedId = expectOk(await reopened.create(files.main, root.sessionFile));
      return {
        registry: reopened,
        id: reopenedId,
        root: executors[index]!,
        context: contexts[index]!,
      };
    },
    failChildCleanup(fails: boolean) {
      cleanupFails = fails;
    },
    async declare(taskId: string) {
      expectOk(
        await context.coordinateTask!(
          {
            action: "declare",
            goal: taskId,
            branches: [
              {
                id: taskId,
                title: taskId,
                scope: "Investigate",
                dependsOn: [],
                lead: { profile: "lead" },
              },
            ],
          },
          `declare-${call++}`,
          undefined,
          ["lead"],
        ),
      );
    },
    async until(condition: () => boolean | Promise<boolean>) {
      for (let attempt = 0; attempt < 500; attempt++) {
        if (await condition()) return;
        await Bun.sleep(2);
      }
      throw new Error("Offline registry scheduler did not settle.");
    },
    async close() {
      cleanupFails = false;
      expectOk(await registry.shutdown());
      await files.cleanup();
    },
  };
}

test("SDK registry reconciles orphan admissions lazily after reopening while off", async () => {
  const app = await registryFixture(true);
  let reopened: Awaited<ReturnType<typeof app.reopen>> | undefined;
  try {
    // Closing a registry leaves durable scheduler facts without a live driver.
    expectOk(await app.root.prompt("/plan Before restart"));
    await app.until(() => !app.root.busy);
    await app.declare("A");
    await app.until(async () =>
      Object.values((await app.read()).scheduler!.admissions).some(
        (admission) => admission.state === "running",
      ),
    );
    const old = (await app.read()).scheduler!.invocations[0]!;
    expectOk(await app.registry.shutdown());
    const saved = (await app.read()).scheduler;

    // OFF reopen neither reconciles scheduler facts nor replays a child.
    app.settings.radian.workflowScheduler = "off";
    reopened = await app.reopen();
    expect((await app.read()).scheduler).toEqual(saved);
    expect(reopened.context.planningSchedulerOwnership!()).toBeUndefined();
    expect(app.executors).toHaveLength(3);

    // The next ON start interrupts the old admission before admitting the same branch.
    app.settings.radian.workflowScheduler = "on";
    expectOk(
      await reopened.registry.controlPlanningScheduler(reopened.id, {
        kind: "started",
        invocationId: "after-enabling",
        baselineRevision: (await app.read()).revision,
      }),
    );
    expect((await app.read()).scheduler!.invocations[0]).toMatchObject({
      id: old.id,
      state: "paused",
    });
    expect((await app.read()).scheduler!.admissions[`${old.id}:A:0`]!.state).toBe("interrupted");
    expect(app.executors).toHaveLength(3);
    expectOk(
      await reopened.context.coordinateTask!(
        {
          action: "declare",
          goal: "New plan",
          branches: [
            {
              id: "A",
              title: "A",
              scope: "Investigate",
              dependsOn: [],
              lead: { profile: "lead" },
            },
          ],
        },
        "after-restart-declare",
        undefined,
        ["lead"],
      ),
    );
    await app.until(async () =>
      Object.values((await app.read()).scheduler!.admissions).some(
        (admission) => admission.invocationId !== old.id && admission.state === "running",
      ),
    );
    expect(app.executors).toHaveLength(4);
    expect((await app.read()).tasks.A!.schedule!.state).toBe("running");

    // An orphan ID cannot cancel the new live owner or its admission.
    expectOk(
      await reopened.registry.controlPlanningScheduler(reopened.id, {
        kind: "cancelled",
        invocationId: old.id,
      }),
    );
    expect(reopened.context.planningSchedulerOwnership!()?.state).toBe("active");
    expect((await app.read()).tasks.A!.schedule!.state).toBe("running");
  } finally {
    if (reopened) expectOk(await reopened.registry.shutdown());
    await app.close();
  }
});

test("SDK registry finalizes an orphan invocation cancel without a live owner", async () => {
  const app = await registryFixture(true);
  let reopened: Awaited<ReturnType<typeof app.reopen>> | undefined;
  try {
    // Preserve a running admission across an OFF reopen.
    expectOk(await app.root.prompt("/plan Orphan cancellation"));
    await app.until(() => !app.root.busy);
    await app.declare("A");
    await app.until(async () =>
      Object.values((await app.read()).scheduler!.admissions).some(
        (admission) => admission.state === "running",
      ),
    );
    const old = (await app.read()).scheduler!.invocations[0]!;
    expectOk(await app.registry.shutdown());
    app.settings.radian.workflowScheduler = "off";
    reopened = await app.reopen();
    const saved = (await app.read()).scheduler;
    expectOk(
      await reopened.registry.controlPlanningScheduler(reopened.id, {
        kind: "cancelled",
        invocationId: old.id,
      }),
    );
    expect((await app.read()).scheduler).toEqual(saved);

    // Explicit cancellation while enabled first reconciles the orphan, then finalizes it.
    app.settings.radian.workflowScheduler = "on";
    expectOk(
      await reopened.registry.controlPlanningScheduler(reopened.id, {
        kind: "cancelled",
        invocationId: old.id,
      }),
    );
    const scheduler = (await app.read()).scheduler!;
    expect(scheduler.invocations).toEqual([
      expect.objectContaining({ id: old.id, state: "cancelled" }),
    ]);
    expect(scheduler.admissions[`${old.id}:A:0`]!.state).toBe("interrupted");
    expect((await app.read()).tasks.A!.schedule!.state).toBe("cancelled");
    expect(reopened.context.planningSchedulerOwnership!()).toBeUndefined();
    expect(app.executors).toHaveLength(3);
  } finally {
    if (reopened) expectOk(await reopened.registry.shutdown());
    await app.close();
  }
});

test("SDK registry scopes status and wait after confirmed cancellation with a non-planning sibling", async () => {
  const app = await registryFixture(true);
  try {
    // A live non-planning sibling must survive scheduler cancellation but stay out of its reports.
    const sibling = expectOk(
      await app.context.coordinateSubagents!({
        action: "spawn",
        agent: "lead",
        task: "Non-planning sibling",
      }),
    ) as { id: string };
    expectOk(await app.root.prompt("/plan Scoped cancellation"));
    await app.until(() => !app.root.busy);
    await app.declare("A");
    await app.until(async () =>
      Object.values((await app.read()).scheduler!.admissions).some(
        (admission) => admission.state === "running",
      ),
    );
    expectOk(
      await app.registry.controlPlanningScheduler(app.id, {
        kind: "cancelled",
        invocationId: (await app.read()).scheduler!.invocations[0]!.id,
      }),
    );

    // Unspecified IDs filter by purpose even after the scheduler releases its guard.
    expect(app.context.planningSchedulerOwnership!()).toBeUndefined();
    for (const action of ["status", "wait"] as const) {
      const runs = expectOk(
        await app.context.coordinateSubagents!({ action }, undefined, "planning"),
      ) as { id: string }[];
      expect(runs).toHaveLength(1);
      expect(runs[0]!.id).not.toBe(sibling.id);
      expect(
        expectError(
          await app.context.coordinateSubagents!({ action, id: sibling.id }, undefined, "planning"),
        ).code,
      ).toBe("INVALID_INPUT");
    }
    const unscoped = expectOk(
      await app.context.coordinateSubagents!({ action: "status", id: sibling.id }),
    ) as { status: string }[];
    expect(unscoped[0]!.status).toBe("working");
  } finally {
    await app.close();
  }
});

test("SDK registry restores legacy planning after cancellation and starts a fresh schedule when re-enabled", async () => {
  const app = await registryFixture();
  try {
    // Settle a real offline SDK lead before changing scheduler ownership.
    expectOk(await app.root.prompt("/plan First scheduled invocation"));
    await app.until(() => !app.root.busy);
    await app.declare("A");
    await app.until(async () =>
      Object.values((await app.read()).scheduler!.admissions).some(
        (admission) => admission.state === "completed",
      ),
    );
    const first = (await app.read()).scheduler!.invocations[0]!;
    expectOk(
      await app.registry.controlPlanningScheduler(app.id, {
        kind: "cancelled",
        invocationId: first.id,
      }),
    );

    // Opting out must restore model-driven spawn, status and wait without scheduler writes.
    app.settings.radian.workflowScheduler = "off";
    expect(app.root.workflowScheduler).toBeUndefined();
    expectOk(await app.root.prompt("/plan Legacy invocation"));
    await app.until(() => !app.root.busy);
    await app.declare("A");
    const beforeSpawn = await app.read();
    const legacy = expectOk(
      await app.context.coordinateSubagents!(
        {
          action: "spawn",
          agent: "lead",
          task: "Legacy branch",
          binding: { id: "A", role: "lead" },
        },
        undefined,
        "planning",
      ),
    ) as { id: string };
    expectOk(
      await app.context.coordinateSubagents!(
        { action: "wait", id: legacy.id },
        undefined,
        "planning",
      ),
    );
    const status = expectOk(
      await app.context.coordinateSubagents!({ action: "status" }, undefined, "planning"),
    ) as { id: string }[];
    expect(status.some((run) => run.id === legacy.id)).toBe(true);
    expect((await app.read()).scheduler).toEqual(beforeSpawn.scheduler);

    // Re-enabling must create another invocation rather than revive the cancelled one.
    await app.until(() => !app.root.busy);
    app.settings.radian.workflowScheduler = "on";
    const restarted = await app.root.prompt("/plan Fresh scheduled invocation");
    expect(restarted).toEqual(ok(undefined));
    await app.until(() => !app.root.busy);
    await app.declare("B");
    await app.until(async () =>
      Object.values((await app.read()).scheduler!.admissions).some(
        (admission) => admission.taskId === "B" && admission.state === "completed",
      ),
    );
    const scheduler = (await app.read()).scheduler!;
    expect(scheduler.invocations).toHaveLength(2);
    expect(scheduler.invocations[0]).toMatchObject({ id: first.id, state: "cancelled" });
    expect(scheduler.invocations[1]).toMatchObject({ kind: "plan", state: "active" });
    expect(scheduler.invocations[1]!.id).not.toBe(first.id);
    expect(app.executors).toHaveLength(4);
  } finally {
    await app.close();
  }
});

test("SDK registry retains uncertain cancellation ownership when off and releases it after a successful retry", async () => {
  const app = await registryFixture(true);
  try {
    // A non-planning sibling makes scheduler-scoped status filtering observable.
    const sibling = expectOk(
      await app.context.coordinateSubagents!({ action: "spawn", agent: "lead", task: "Sibling" }),
    ) as { id: string };
    expectOk(await app.root.prompt("/plan Uncertain cleanup"));
    await app.until(() => !app.root.busy);
    await app.declare("A");
    await app.until(async () =>
      Object.values((await app.read()).scheduler!.admissions).some(
        (admission) => admission.state === "running",
      ),
    );
    const invocationId = (await app.read()).scheduler!.invocations[0]!.id;
    const cancel = () =>
      app.registry.controlPlanningScheduler(app.id, { kind: "cancelled", invocationId });
    const spawn = () =>
      app.context.coordinateSubagents!(
        {
          action: "spawn",
          agent: "lead",
          task: "Manual branch",
          binding: { id: "A", role: "lead" },
        },
        undefined,
        "planning",
      );
    app.failChildCleanup(true);
    expect(expectError(await cancel()).code).toBe("AGENT_FAILED");
    expect((await app.read()).tasks.A!.schedule).toMatchObject({ reason: "cleanup-uncertain" });

    // Opting out cannot release a handle whose cleanup has not been confirmed.
    app.settings.radian.workflowScheduler = "off";
    const blocked = expectError(await spawn());
    expect(blocked).toBeInstanceOf(WorkflowError);
    expect(blocked.code).toBe("WORKFLOW_NOT_AUTHORIZED");
    expect(blocked.message).toContain("retry cancel");
    const unscoped = await app.context.coordinateSubagents!({
      action: "spawn",
      agent: "lead",
      task: "Duplicate binding without request scope",
      binding: { id: "A", role: "lead" },
    });
    expect(expectError(unscoped).code).toBe("WORKFLOW_CONFLICT");
    const scopedStatus = expectOk(
      await app.context.coordinateSubagents!({ action: "status" }, undefined, "planning"),
    ) as { id: string; binding?: { taskId: string } }[];
    expect(scopedStatus).toHaveLength(1);
    expect(scopedStatus[0]!.binding?.taskId).toBe("A");
    expect(scopedStatus.some((run) => run.id === sibling.id)).toBe(false);
    expect(app.executors).toHaveLength(3);
    expect(expectError(await cancel()).code).toBe("AGENT_FAILED");

    // Retrying cancellation while still OFF must confirm cleanup before legacy admission resumes.
    app.failChildCleanup(false);
    expectOk(await cancel());
    expect((await app.read()).tasks.A!.schedule!.state).toBe("cancelled");
    const legacy = expectOk(await spawn()) as { id: string };
    expect(legacy.id).not.toBe(scopedStatus[0]!.id);
    expect(app.executors).toHaveLength(4);
  } finally {
    await app.close();
  }
});

test("SDK registry rejects root planning spawns while an opted-in scheduler invocation owns admission", async () => {
  const app = await registryFixture();
  try {
    expectOk(await app.root.prompt("/plan Scheduler-owned invocation"));
    await app.until(() => !app.root.busy);
    const spawn = () =>
      app.context.coordinateSubagents!(
        {
          action: "spawn",
          agent: "lead",
          task: "Bypass scheduler",
          binding: { id: "A", role: "lead" },
        },
        undefined,
        "planning",
      );

    // Ownership starts before declaration, not merely when the driver is allocated.
    expect(expectError(await spawn()).code).toBe("WORKFLOW_NOT_AUTHORIZED");
    await app.declare("A");
    expect(expectError(await spawn()).code).toBe("WORKFLOW_NOT_AUTHORIZED");
    await app.until(async () =>
      Object.values((await app.read()).scheduler!.admissions).some(
        (admission) => admission.state === "completed",
      ),
    );
    expect(app.executors).toHaveLength(2);
  } finally {
    await app.close();
  }
});

test("SDK registry keeps a legacy invocation after enabling and starts the next plan with scheduler ownership", async () => {
  const app = await registryFixture();
  try {
    // The setting alone does not claim admission for an existing legacy planning request.
    app.settings.radian.workflowScheduler = "off";
    expectOk(await app.root.prompt("/plan Legacy request before enabling"));
    await app.until(() => !app.root.busy);
    await app.declare("A");
    expect((await app.readDocument()).version).toBe(1);
    expect((await app.read()).scheduler).toBeUndefined();
    app.settings.radian.workflowScheduler = "on";
    expectOk(await app.root.prompt("Observe the existing legacy request"));
    await app.until(() => !app.root.busy);
    expect(app.requests.at(-1)!.systemPrompt).not.toContain(
      "Read-only planning scheduler mode is enabled",
    );
    const manual = expectOk(
      await app.context.coordinateSubagents!(
        {
          action: "spawn",
          agent: "lead",
          task: "Manual plan before scheduler start",
          binding: { id: "A", role: "lead" },
        },
        undefined,
        "planning",
      ),
    ) as { id: string };
    expectOk(
      await app.context.coordinateSubagents!(
        { action: "wait", id: manual.id },
        undefined,
        "planning",
      ),
    );

    expect(app.root.workflowScheduler).toBeDefined();
    expect(app.executors).toHaveLength(2);
    expect((await app.readDocument()).version).toBe(1);
    expect((await app.read()).scheduler).toBeUndefined();

    // Reload must restore the legacy owner rather than adopt the newly enabled setting.
    await app.until(() => !app.root.busy);
    expectOk(await app.root.reload!());
    expectOk(await app.root.prompt("Observe the restored legacy request"));
    await app.until(() => !app.root.busy);
    expect(app.requests.at(-1)!.systemPrompt).not.toContain(
      "Read-only planning scheduler mode is enabled",
    );
    expectOk(await app.root.prompt("/plan First scheduler-owned invocation"));
    await app.until(() => !app.root.busy);
    await app.declare("B");
    await app.until(async () =>
      Object.values((await app.read()).scheduler!.admissions).some(
        (admission) => admission.taskId === "B" && admission.state === "completed",
      ),
    );
    expect((await app.read()).scheduler!.invocations).toEqual([
      expect.objectContaining({ kind: "plan", state: "active" }),
    ]);
    expect(app.requests.at(-1)!.systemPrompt).toContain(
      "Read-only planning scheduler mode is enabled",
    );
  } finally {
    await app.close();
  }
});

test("SDK registry cancels a scheduler-owned invocation after disabling before starting legacy planning", async () => {
  const app = await registryFixture(true);
  try {
    // Keep an admitted lead running so the next request must confirm scheduler cleanup.
    expectOk(await app.root.prompt("/plan Scheduler-owned before disabling"));
    await app.until(() => !app.root.busy);
    await app.declare("A");
    await app.until(async () =>
      Object.values((await app.read()).scheduler!.admissions).some(
        (admission) => admission.state === "running",
      ),
    );
    const invocationId = (await app.read()).scheduler!.invocations[0]!.id;
    app.settings.radian.workflowScheduler = "off";
    expectOk(await app.root.prompt("Observe the existing scheduler request while off"));
    await app.until(() => !app.root.busy);
    expect(app.requests.at(-1)!.systemPrompt).toContain(
      "Read-only planning scheduler mode is enabled",
    );

    expectOk(await app.root.prompt("/plan Legacy request after disabling"));
    await app.until(() => !app.root.busy);
    const cancelled = await app.read();
    expect(cancelled.scheduler!.invocations).toEqual([
      expect.objectContaining({ id: invocationId, state: "cancelled" }),
    ]);
    expect(Object.values(cancelled.scheduler!.admissions)).toEqual([
      expect.objectContaining({ invocationId, state: "cancelled", stopReason: "cancelled" }),
    ]);
    expect(app.requests.at(-1)!.systemPrompt).not.toContain(
      "Read-only planning scheduler mode is enabled",
    );

    // Confirmed cleanup releases the same branch binding for legacy model-driven admission.
    await app.declare("A");
    const beforeSpawn = (await app.read()).scheduler;
    const manual = expectOk(
      await app.context.coordinateSubagents!(
        {
          action: "spawn",
          agent: "lead",
          task: "Legacy lead after confirmed scheduler cleanup",
          binding: { id: "A", role: "lead" },
        },
        undefined,
        "planning",
      ),
    ) as { id: string };
    expectOk(
      await app.context.coordinateSubagents!(
        { action: "stop", id: manual.id },
        undefined,
        "planning",
      ),
    );
    expect((await app.read()).scheduler).toEqual(beforeSpawn);
    expect(app.executors).toHaveLength(3);
  } finally {
    await app.close();
  }
});

test("SDK registry ignores unknown cancellation without replacing a scheduler-owned invocation", async () => {
  const app = await registryFixture();
  try {
    expectOk(await app.root.prompt("/plan Preserve scheduler ownership"));
    await app.until(() => !app.root.busy);
    await app.declare("A");
    await app.until(async () =>
      Object.values((await app.read()).scheduler!.admissions).some(
        (admission) => admission.state === "completed",
      ),
    );
    const before = await app.read();

    // An unrelated cancellation must neither allocate a driver nor change its observed invocation.
    expectOk(
      await app.registry.controlPlanningScheduler(app.id, {
        kind: "cancelled",
        invocationId: "unknown-invocation",
      }),
    );
    expect(await app.read()).toEqual(before);
    const blocked = await app.context.coordinateSubagents!(
      {
        action: "spawn",
        agent: "lead",
        task: "Cannot bypass the existing owner",
        binding: { id: "A", role: "lead" },
      },
      undefined,
      "planning",
    );
    expect(expectError(blocked).code).toBe("WORKFLOW_NOT_AUTHORIZED");
    expectOk(await app.root.prompt("/plan Next scheduler request"));
    await app.until(() => !app.root.busy);
    expect((await app.read()).scheduler!.invocations).toEqual([
      expect.objectContaining({ id: before.scheduler!.invocations[0]!.id, state: "cancelled" }),
      expect.objectContaining({ state: "active" }),
    ]);
  } finally {
    await app.close();
  }
});

test("SDK registry starts a fresh invocation after confirmed cancellation while still on", async () => {
  const app = await registryFixture();
  try {
    // Confirmed cancellation releases ownership without requiring a setting toggle.
    expectOk(await app.root.prompt("/plan First invocation while on"));
    await app.until(() => !app.root.busy);
    await app.declare("B");
    await app.until(async () =>
      Object.values((await app.read()).scheduler!.admissions).some(
        (admission) => admission.taskId === "B" && admission.state === "completed",
      ),
    );
    const firstId = (await app.read()).scheduler!.invocations[0]!.id;
    expectOk(
      await app.registry.controlPlanningScheduler(app.id, {
        kind: "cancelled",
        invocationId: firstId,
      }),
    );
    await app.until(() => !app.root.busy);
    expectOk(await app.root.prompt("/plan Fresh invocation while still on"));
    await app.until(() => !app.root.busy);
    await app.declare("C");
    await app.until(async () =>
      Object.values((await app.read()).scheduler!.admissions).some(
        (admission) => admission.taskId === "C" && admission.state === "completed",
      ),
    );
    const invocations = (await app.read()).scheduler!.invocations;
    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toMatchObject({ id: firstId, state: "cancelled" });
    expect(invocations[1]).toMatchObject({ state: "active" });
    expect(invocations[1]!.id).not.toBe(firstId);
  } finally {
    await app.close();
  }
});

test.each([false, true])(
  "SDK registry preserves a newer owner and its schedules after historical cancellation (cleanup uncertain: %s)",
  async (uncertain) => {
    const app = await registryFixture(true);
    try {
      // A confirmed historical cancellation must never become authority over a newer request.
      expectOk(await app.root.prompt("/plan Historical request"));
      await app.until(() => !app.root.busy);
      await app.declare("X");
      await app.until(async () =>
        Object.values((await app.read()).scheduler!.admissions).some(
          (admission) => admission.state === "running",
        ),
      );
      const historicalId = app.context.planningSchedulerOwnership!()!.invocationId;
      expectOk(
        await app.registry.controlPlanningScheduler(app.id, {
          kind: "cancelled",
          invocationId: historicalId,
        }),
      );
      await app.until(() => !app.root.busy);
      expectOk(await app.root.prompt("/plan Current request"));
      await app.until(() => !app.root.busy);
      expectOk(
        await app.context.coordinateTask!(
          {
            action: "declare",
            goal: "Dependent branches",
            branches: ["A", "B"].map((id) => ({
              id,
              title: id,
              scope: "Investigate",
              dependsOn: id === "B" ? ["A"] : [],
              lead: { profile: "lead" },
            })),
          },
          "declare-current",
          undefined,
          ["lead"],
        ),
      );
      await app.until(async () => (await app.read()).tasks.A!.schedule?.state === "running");
      const currentId = app.context.planningSchedulerOwnership!()!.invocationId;
      const cancelCurrent = () =>
        app.registry.controlPlanningScheduler(app.id, {
          kind: "cancelled",
          invocationId: currentId,
        });
      if (uncertain) {
        app.failChildCleanup(true);
        expect(expectError(await cancelCurrent()).code).toBe("AGENT_FAILED");
      }
      const owner = app.context.planningSchedulerOwnership!();
      const before = await app.read();
      app.settings.radian.workflowScheduler = "off";

      // Neither historical nor unknown controls may change ownership, schedules or admissions.
      for (const invocationId of [historicalId, "unknown", "", "__proto__"]) {
        expectOk(
          await app.registry.controlPlanningScheduler(app.id, { kind: "cancelled", invocationId }),
        );
        expect(app.context.planningSchedulerOwnership!()).toEqual(owner);
        const after = await app.read();
        expect(after.scheduler).toEqual(before.scheduler);
        expect(after.tasks.A!.schedule).toEqual(before.tasks.A!.schedule);
        expect(after.tasks.B!.schedule).toEqual(before.tasks.B!.schedule);
      }
      expect(
        expectError(
          await app.context.coordinateSubagents!(
            {
              action: "spawn",
              agent: "lead",
              task: "Cannot bypass the current owner",
              binding: { id: "A", role: "lead" },
            },
            undefined,
            "planning",
          ),
        ).code,
      ).toBe("WORKFLOW_NOT_AUTHORIZED");
      expect(
        expectError(
          await app.registry.controlPlanningScheduler(app.id, {
            kind: "started",
            invocationId: "conflicting-owner",
            baselineRevision: before.revision,
          }),
        ).code,
      ).toBe("WORKFLOW_CONFLICT");

      expect(
        expectError(
          await app.context.coordinateSubagents!({
            action: "spawn",
            agent: "lead",
            task: "Duplicate binding without planning scope",
            binding: { id: "A", role: "lead" },
          }),
        ).code,
      ).toBe("WORKFLOW_CONFLICT");

      // The active driver's publication observation must still admit the dependent branch.
      if (!uncertain) {
        const a = app.contexts.find((context) => context.binding?.taskId === "A")!;
        expectOk(
          await a.coordinateTask!(
            {
              action: "publish-plan",
              artifactId: "A-plan",
              plan: {
                schemaVersion: 1,
                goal: "A plan",
                outOfScope: [],
                assumptions: [],
                openQuestions: [],
                tasks: [
                  {
                    id: "implementation",
                    title: "Implement A",
                    agent: "engineer",
                    dependsOn: [],
                    inputs: [],
                    outputs: ["Implementation"],
                    acceptanceCriteria: ["Contract covered"],
                    files: [],
                  },
                ],
              },
              review: { summary: "Reviewed", warnings: [] },
            },
            "publish-current-A",
          ),
        );
        await app.until(async () => (await app.read()).tasks.B!.schedule?.state === "running");
        expect((await app.read()).tasks.B!.schedule!.invocationId).toBe(currentId);
      }
      app.failChildCleanup(false);
      expectOk(await cancelCurrent());
      expect(app.context.planningSchedulerOwnership!()).toBeUndefined();
    } finally {
      await app.close();
    }
  },
);

test("SDK registry retains invocation ownership when disabled before the first declaration", async () => {
  const app = await registryFixture(true);
  try {
    // Ownership is established by the accepted start, even before there is a workflow document.
    expectOk(await app.root.prompt("/plan Ownership before declaration"));
    await app.until(() => !app.root.busy);
    const owner = app.context.planningSchedulerOwnership!();
    expect(owner).toMatchObject({ state: "active" });
    app.settings.radian.workflowScheduler = "off";
    expect(app.root.workflowScheduler).toBeUndefined();
    expect(
      expectError(
        await app.context.coordinateSubagents!(
          { action: "spawn", agent: "lead", task: "Cannot bypass pending declaration" },
          undefined,
          "planning",
        ),
      ).code,
    ).toBe("WORKFLOW_NOT_AUTHORIZED");
    expect(
      expectError(
        await app.registry.controlPlanningScheduler(app.id, {
          kind: "started",
          invocationId: "second-start-before-declare",
          baselineRevision: 0,
        }),
      ).code,
    ).toBe("WORKFLOW_CONFLICT");

    // First declaration uses the original opt-in and captured profile provider, not the live setting.
    await app.declare("A");
    await app.until(async () => (await app.read()).tasks.A!.schedule?.state === "running");
    expect(app.context.planningSchedulerOwnership!()).toEqual(owner);
    expect((await app.read()).scheduler!.invocations).toEqual([
      expect.objectContaining({ id: owner!.invocationId, state: "active" }),
    ]);
    expect(
      expectError(
        await app.context.coordinateSubagents!(
          {
            action: "spawn",
            agent: "lead",
            task: "Cannot bypass accepted admission",
            binding: { id: "A", role: "lead" },
          },
          undefined,
          "planning",
        ),
      ).code,
    ).toBe("WORKFLOW_NOT_AUTHORIZED");
    expect(app.executors).toHaveLength(2);
    expectOk(
      await app.registry.controlPlanningScheduler(app.id, {
        kind: "cancelled",
        invocationId: owner!.invocationId,
      }),
    );
    expect(app.context.planningSchedulerOwnership!()).toBeUndefined();
  } finally {
    await app.close();
  }
});

// Exercise the same SettingsManager extension settings path as radian.builtInAgents.
test.each([undefined, "off", "on", true])(
  "SDK scheduler setting %s only opts in for the explicit on value",
  async (setting) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "radian-scheduler-settings-")));
    const controls: PlanningSchedulerControl[] = [];
    const requests: string[] = [];
    const requested = Promise.withResolvers<void>();
    const offline = await offlineRuntime(join(directory, "agent"));
    const factory = piSessionFactory({
      ...offline,
      settings: { radian: { workflowScheduler: setting } } as NonNullable<
        PiSessionOptions["settings"]
      >,
      streamFn(model, context) {
        requests.push(JSON.stringify(context.messages));
        requested.resolve();
        const stream = createAssistantMessageEventStream();
        const message = fixtureMessage(model.api, model.provider, model.id);
        message.content = [{ type: "text", text: "Await branch declaration." }];
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
        return stream;
      },
    });
    const executor = await factory({
      cwd: directory,
      role: "main",
      spawnSubagent: async () => ok("unused"),
      coordinateSubagents: async () => ok([]),
      controlPlanningScheduler: async (command) => {
        controls.push(command);
        return ok(undefined);
      },
    });
    try {
      expect(!!executor.workflowScheduler).toBe(setting === "on");
      expectOk(await executor.prompt("/plan Investigate settings isolation"));
      await requested.promise;
      expect(controls.filter((command) => command.kind === "started")).toHaveLength(
        setting === "on" ? 1 : 0,
      );
      expect(requests[0]!.includes("Read-only planning scheduler mode is enabled")).toBe(
        setting === "on",
      );
      if (setting !== "on") expect(requests[0]).toContain("spawn each assigned lead");
    } finally {
      expectOk(await executor.close());
      await rm(directory, { recursive: true, force: true });
    }
  },
);
