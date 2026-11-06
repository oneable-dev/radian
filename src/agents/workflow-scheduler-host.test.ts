import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoWorkspace } from "../workspace/demo.ts";
import { err, ok } from "../result.ts";
import { AgentRunError } from "../errors.ts";
import { expectError, expectOk } from "../testing/results.ts";
import {
  SessionRegistry,
  type SessionContext,
  type SessionExecutor,
  type ExecutionState,
} from "./session-registry.ts";
import type { AgentProfile } from "./agent-profiles.ts";
import { openWorkflow } from "./task-workflow-store.ts";
import type { WorkflowDocumentV2 } from "./task-workflow.ts";

const profile: AgentProfile = {
  name: "lead",
  description: "Read-only lead",
  prompt: "Investigate",
  path: "/fixture/lead.md",
  skills: [],
  delegation: { enabled: true },
};
class Executor implements SessionExecutor {
  state: ExecutionState = { status: null, output: "", error: null };
  readonly done = Promise.withResolvers<void>();
  cleanupFails = false;
  cleanupGate?: Promise<void>;
  readonly workflowScheduler: SessionExecutor["workflowScheduler"];
  constructor(
    readonly context: SessionContext,
    readonly savedSessionId: string,
    readonly sessionFile: string | undefined,
    enabled: boolean,
  ) {
    this.workflowScheduler = enabled ? { profiles: () => ok([profile]) } : undefined;
  }
  subscribe() {
    return () => {};
  }
  async prompt() {
    this.state = { status: "working", output: "", error: null };
    await this.done.promise;
    return ok(undefined);
  }
  finish() {
    this.state = { status: "complete", output: "Published", error: null };
    this.done.resolve();
  }
  async close() {
    await this.cleanupGate;
    if (this.cleanupFails) return err(new AgentRunError("Cleanup outcome is uncertain."));
    this.done.resolve();
    return ok(undefined);
  }
}
async function fixture(enabled = true) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "radian-scheduler-host-")));
  const sessionFile = join(directory, "origin.jsonl");
  const owner = { conversationId: crypto.randomUUID(), cwd: "/demo/radian" };
  await writeFile(
    sessionFile,
    JSON.stringify({ type: "session", id: owner.conversationId, cwd: owner.cwd }) + "\n",
  );
  const executors: Executor[] = [];
  const registry = new SessionRegistry(demoWorkspace(), async (context) => {
    const executor = new Executor(
      context,
      context.role === "main" ? owner.conversationId : crypto.randomUUID(),
      context.role === "main" ? sessionFile : undefined,
      enabled && context.role === "main",
    );
    executors.push(executor);
    return executor;
  });
  const id = expectOk(await registry.create("demo:main", sessionFile));
  const root = executors[0]!;
  let call = 0;
  const read = async () => expectOk(await openWorkflow(sessionFile, owner))!.doc;
  const declare = (ids: string[]) =>
    root.context.coordinateTask!(
      {
        action: "declare",
        goal: "Plan branches",
        branches: ids.map((branch) => ({
          id: branch,
          title: branch,
          scope: `Investigate ${branch}`,
          dependsOn: branch === "B" ? ["A"] : [],
          lead: { profile: "lead" },
        })),
      },
      `declare-${call++}`,
      undefined,
      ["lead"],
    );
  const publish = (executor: Executor, artifactId: string) =>
    executor.context.coordinateTask!(
      {
        action: "publish-plan",
        artifactId,
        plan: {
          schemaVersion: 1,
          goal: artifactId,
          outOfScope: [],
          assumptions: [],
          openQuestions: [],
          tasks: [
            {
              id: "task",
              title: "Investigate",
              agent: "main",
              dependsOn: [],
              inputs: [],
              outputs: ["Reviewed plan"],
              acceptanceCriteria: ["Coverage reviewed"],
              files: [],
            },
          ],
        },
        review: { summary: "Reviewed coverage", warnings: [] },
      },
      `publish-${call++}`,
    );
  const until = async (condition: () => boolean | Promise<boolean>) => {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (await condition()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    throw new Error("Offline scheduler trace did not settle.");
  };
  return {
    directory,
    registry,
    root,
    id,
    executors,
    read,
    declare,
    publish,
    until,
    async close() {
      for (const executor of executors) executor.cleanupFails = false;
      expectOk(await registry.shutdown());
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("Host commits planning admissions before launch, admits A/C independently, and enforces exact B input reads", async () => {
  const app = await fixture();
  try {
    expectOk(
      await app.registry.controlPlanningScheduler(app.id, {
        kind: "started",
        invocationId: "plan",
        baselineRevision: 0,
      }),
    );
    expectOk(await app.declare(["A", "B", "C"]));
    await app.until(() => app.executors.length === 3);
    const children = app.executors.slice(1);
    expect(children.map((child) => child.context.binding!.taskId)).toEqual(["A", "C"]);
    for (const child of children) {
      expect(child.context.purpose).toBe("planning");
      expect(child.context.profile!.effectiveProfile!.purpose).toBe("planning");
      const current = (await app.read()) as WorkflowDocumentV2;
      expect(
        Object.values(current.scheduler!.admissions).some(
          (item) => item.taskId === child.context.binding!.taskId,
        ),
      ).toBe(true);
    }
    const a = children[0]!;
    expectOk(await app.publish(a, "A-plan"));
    await app.until(() => app.executors.some((child) => child.context.binding?.taskId === "B"));
    const b = app.executors.find((child) => child.context.binding?.taskId === "B")!;
    expectOk(await app.publish(children[1]!, "C-plan"));
    const body = expectOk(
      await b.context.coordinateTask!({ action: "status", artifact: "A-plan@1" }, "read-frozen"),
    );
    expect(body).toMatchObject({ plan: { goal: "A-plan" } });
    expect(
      expectError(
        await b.context.coordinateTask!({ action: "status", artifact: "A-plan" }, "read-latest"),
      ).code,
    ).toBe("WORKFLOW_NOT_AUTHORIZED");
    expect(
      expectError(
        await b.context.coordinateTask!({ action: "status", artifact: "C-plan@1" }, "read-foreign"),
      ).code,
    ).toBe("WORKFLOW_NOT_AUTHORIZED");
    expectOk(await app.publish(a, "A-plan"));
    await app.until(
      () => app.executors.filter((child) => child.context.binding?.taskId === "B").length === 2,
    );
    const refreshed = app.executors.filter((child) => child.context.binding?.taskId === "B")[1]!;
    expect(
      expectError(
        await refreshed.context.coordinateTask!(
          { action: "status", artifact: "A-plan@1" },
          "read-old",
        ),
      ).code,
    ).toBe("WORKFLOW_NOT_AUTHORIZED");
    expectOk(
      await refreshed.context.coordinateTask!(
        { action: "status", artifact: "A-plan@2" },
        "read-current",
      ),
    );
    const descendant = expectOk(
      await refreshed.context.coordinateSubagents!(
        { action: "spawn", agent: "lead", task: "Read-only investigation" },
        undefined,
        undefined,
        profile,
      ),
    );
    expect(descendant).toBeDefined();
    expect(app.executors.at(-1)!.context.purpose).toBe("planning");
    expect(
      (await readdir(app.directory)).some((file) => file.endsWith("workflow-v1-backup.json")),
    ).toBe(true);
  } finally {
    await app.close();
  }
});

test("Host observes reassignment, confirms obsolete cleanup and freezes replacement inputs within the invalidation bound", async () => {
  const app = await fixture();
  const cleanup = Promise.withResolvers<void>();
  try {
    // B starts with an accepted A input; its old generation cannot release capacity early.
    expectOk(
      await app.registry.controlPlanningScheduler(app.id, {
        kind: "started",
        invocationId: "reassign",
        baselineRevision: 0,
      }),
    );
    expectOk(await app.declare(["A", "B"]));
    await app.until(() => app.executors.length === 2);
    expectOk(await app.publish(app.executors[1]!, "A-plan"));
    await app.until(
      async () =>
        ((await app.read()) as WorkflowDocumentV2).scheduler!.admissions["reassign:B:0"]?.state ===
        "running",
    );
    const stale = app.executors[2]!;
    stale.cleanupGate = cleanup.promise;

    // Reassignment itself must notify admission without a publication or manual stop.
    const reassign = (call: string) =>
      app.root.context.coordinateTask!(
        {
          action: "reassign",
          taskId: "B",
          role: "lead",
          profile: "lead",
        },
        call,
        undefined,
        ["lead"],
      );
    expectOk(await reassign("reassign-first"));
    await app.until(
      async () =>
        ((await app.read()) as WorkflowDocumentV2).scheduler!.admissions["reassign:B:0"]
          ?.stopReason === "obsolete",
    );
    expect(app.executors).toHaveLength(3);
    expect(expectError(await app.publish(stale, "stale-plan")).code).toBe("CANCELLED");
    expectOk(await app.publish(app.executors[1]!, "A-plan"));
    cleanup.resolve();
    await app.until(
      async () =>
        ((await app.read()) as WorkflowDocumentV2).scheduler!.admissions["reassign:B:1"]?.state ===
        "running",
    );

    // Confirmed settlement precedes the replacement, which receives fresh frozen refs.
    const doc = (await app.read()) as WorkflowDocumentV2;
    expect(doc.scheduler!.admissions["reassign:B:0"]).toMatchObject({
      state: "interrupted",
      stopReason: "obsolete",
    });
    expect(doc.scheduler!.admissions["reassign:B:1"]!.frozenInputs).toEqual(["A-plan@2"]);
    const replacement = app.executors[3]!;
    expect(replacement.context.binding!.assignmentVersion).toBe(1);
    expectOk(
      await replacement.context.coordinateTask!(
        { action: "status", artifact: "A-plan@2" },
        "replacement-input",
      ),
    );
    expect(
      expectError(
        await replacement.context.coordinateTask!(
          { action: "status", artifact: "A-plan@1" },
          "replacement-old-input",
        ),
      ).code,
    ).toBe("WORKFLOW_NOT_AUTHORIZED");
    expect(expectError(await app.publish(stale, "settled-stale-plan")).code).toBe("CANCELLED");
    const status = expectOk(
      await app.root.context.coordinateSubagents!({ action: "status" }, undefined, "planning"),
    ) as { binding: { taskId: string; assignmentVersion: number }; status: string }[];
    expect(
      status.find((run) => run.binding.taskId === "B" && run.binding.assignmentVersion === 0)!
        .status,
    ).not.toBe("working");

    // Further reassignment uses the same three-invalidation budget instead of resetting it.
    expectOk(await reassign("reassign-second"));
    await app.until(
      async () =>
        ((await app.read()) as WorkflowDocumentV2).scheduler!.admissions["reassign:B:2"]?.state ===
        "running",
    );
    expectOk(await reassign("reassign-third"));
    await app.until(
      async () =>
        ((await app.read()) as WorkflowDocumentV2).tasks.B!.schedule?.reason ===
        "invalidation-limit",
    );
    const bounded = (await app.read()) as WorkflowDocumentV2;
    expect(bounded.scheduler!.invocations[0]!.invalidations!.B).toBe(3);
    expect(bounded.scheduler!.admissions["reassign:B:3"]).toBeUndefined();
    expect(app.executors).toHaveLength(5);
  } finally {
    cleanup.resolve();
    await app.close();
  }
});

test("Reassignment of a dependency-queued branch launches only the new assignment when its input arrives", async () => {
  const app = await fixture();
  try {
    // B has no admission until A publishes accepted prerequisite coverage.
    expectOk(
      await app.registry.controlPlanningScheduler(app.id, {
        kind: "started",
        invocationId: "queued-dependency",
        baselineRevision: 0,
      }),
    );
    expectOk(await app.declare(["A", "B"]));
    await app.until(() => app.executors.length === 2);
    expect(((await app.read()) as WorkflowDocumentV2).tasks.B!.schedule).toMatchObject({
      state: "queued",
      reason: "dependencies",
    });

    expectOk(
      await app.root.context.coordinateTask!(
        { action: "reassign", taskId: "B", role: "lead", profile: "lead" },
        "reassign-queued-dependency",
        undefined,
        ["lead"],
      ),
    );
    expectOk(await app.publish(app.executors[1]!, "A-plan"));
    await app.until(
      async () =>
        ((await app.read()) as WorkflowDocumentV2).scheduler!.admissions["queued-dependency:B:0"]
          ?.state === "running",
    );

    // Queuing does not create an old-generation run or consume an invalidation.
    const doc = (await app.read()) as WorkflowDocumentV2;
    expect(doc.scheduler!.admissions["queued-dependency:B:0"]).toMatchObject({
      assignmentVersion: 1,
      frozenInputs: ["A-plan@1"],
    });
    expect(doc.scheduler!.invocations[0]!.invalidations!.B).toBeUndefined();
    expect(app.executors.filter((run) => run.context.binding?.taskId === "B")).toHaveLength(1);
    expect(app.executors[2]!.context.binding!.assignmentVersion).toBe(1);
  } finally {
    await app.close();
  }
});

test("Reassignment of a capacity-queued branch preserves the limit and launches only the current assignment", async () => {
  const app = await fixture();
  try {
    // All five slots remain occupied while G waits without a reserved admission.
    expectOk(
      await app.registry.controlPlanningScheduler(app.id, {
        kind: "started",
        invocationId: "queued-capacity",
        baselineRevision: 0,
      }),
    );
    expectOk(await app.declare(["A", "C", "D", "E", "F", "G"]));
    await app.until(() => app.executors.length === 6);
    expectOk(
      await app.root.context.coordinateTask!(
        { action: "reassign", taskId: "G", role: "lead", profile: "lead" },
        "reassign-queued-capacity",
        undefined,
        ["lead"],
      ),
    );
    expect(((await app.read()) as WorkflowDocumentV2).tasks.G!.schedule).toMatchObject({
      state: "queued",
      reason: "capacity",
    });
    expect(app.executors).toHaveLength(6);

    // A completed, published run releases a slot; reassignment alone does not.
    expectOk(await app.publish(app.executors[1]!, "A-plan"));
    app.executors[1]!.finish();
    await app.until(
      async () =>
        ((await app.read()) as WorkflowDocumentV2).scheduler!.admissions["queued-capacity:G:0"]
          ?.state === "running",
    );
    const doc = (await app.read()) as WorkflowDocumentV2;
    expect(doc.scheduler!.admissions["queued-capacity:G:0"]!.assignmentVersion).toBe(1);
    expect(
      Object.values(doc.scheduler!.admissions).filter((item) => item.state === "running"),
    ).toHaveLength(5);
    expect(app.executors.filter((run) => run.context.binding?.taskId === "G")).toHaveLength(1);
    expect(app.executors[6]!.context.binding!.assignmentVersion).toBe(1);
  } finally {
    await app.close();
  }
});

test("Reassignment while awaiting an answer retains uncertain cleanup ownership until the latest generation can launch", async () => {
  const app = await fixture();
  try {
    expectOk(
      await app.registry.controlPlanningScheduler(app.id, {
        kind: "started",
        invocationId: "question-reassign",
        baselineRevision: 0,
      }),
    );
    expectOk(await app.declare(["A"]));
    await app.until(
      async () => ((await app.read()) as WorkflowDocumentV2).tasks.A!.schedule?.state === "running",
    );
    const stale = app.executors[1]!;
    const question = stale.context.contactSupervisor!({ action: "ask", message: "Choose scope" });
    await app.until(
      async () =>
        ((await app.read()) as WorkflowDocumentV2).tasks.A!.schedule?.state === "awaiting-answer",
    );
    stale.cleanupFails = true;
    const reassign = (call: string) =>
      app.root.context.coordinateTask!(
        { action: "reassign", taskId: "A", role: "lead", profile: "lead" },
        call,
        undefined,
        ["lead"],
      );

    // Revocation releases the pending question but cannot claim successful subtree cleanup.
    expectOk(await reassign("reassign-question"));
    expect(expectError(await question).code).toBe("CANCELLED");
    await app.until(
      async () =>
        ((await app.read()) as WorkflowDocumentV2).tasks.A!.schedule?.reason ===
        "cleanup-uncertain",
    );
    expectOk(await reassign("reassign-during-uncertainty"));
    const uncertain = (await app.read()) as WorkflowDocumentV2;
    expect(uncertain.tasks.A!.assignmentVersion).toBe(2);
    expect(uncertain.scheduler!.admissions["question-reassign:A:0"]).toMatchObject({
      state: "running",
      assignmentVersion: 0,
      stopReason: "obsolete",
    });
    expect(app.executors).toHaveLength(2);
    expect(expectError(await app.publish(stale, "stale-question-plan")).code).toBe("CANCELLED");

    // Explicit retry confirms cleanup before a single latest-generation admission is allowed.
    stale.cleanupFails = false;
    expectOk(
      await app.root.context.coordinateSubagents!(
        { action: "stop", id: uncertain.scheduler!.admissions["question-reassign:A:0"]!.runId! },
        undefined,
        "planning",
      ),
    );
    await app.until(
      async () =>
        ((await app.read()) as WorkflowDocumentV2).scheduler!.admissions["question-reassign:A:1"]
          ?.state === "running",
    );
    const settled = (await app.read()) as WorkflowDocumentV2;
    // The old run retains its cleanup failure diagnostic even after cleanup is confirmed.
    expect(settled.scheduler!.admissions["question-reassign:A:0"]).toMatchObject({
      state: "failed",
      stopReason: "obsolete",
    });
    expect(settled.scheduler!.admissions["question-reassign:A:1"]!.assignmentVersion).toBe(2);
    expect(
      Object.values(settled.scheduler!.admissions).filter((item) => item.state === "running"),
    ).toHaveLength(1);
    expect(app.executors).toHaveLength(3);
    expect(app.executors[2]!.context.binding!.assignmentVersion).toBe(2);
    expectOk(await app.publish(app.executors[2]!, "current-question-plan"));
  } finally {
    await app.close();
  }
});

test("Host releases capacity only after cleanup and admits the sixth branch without polling by the model", async () => {
  const app = await fixture();
  try {
    expectOk(
      await app.registry.controlPlanningScheduler(app.id, {
        kind: "started",
        invocationId: "six",
        baselineRevision: 0,
      }),
    );
    expectOk(await app.declare(["A", "C", "D", "E", "F", "G"]));
    await app.until(() => app.executors.length === 6);
    expect(((await app.read()) as WorkflowDocumentV2).tasks.G!.schedule).toMatchObject({
      state: "queued",
      reason: "capacity",
    });
    const a = app.executors[1]!;
    expectOk(await app.publish(a, "A-plan"));
    a.finish();
    await app.until(() => app.executors.length === 7);
    expect(app.executors[6]!.context.binding!.taskId).toBe("G");
  } finally {
    await app.close();
  }
});

test("Host cancellation reports cleanup uncertainty instead of claiming confirmed cancellation", async () => {
  const app = await fixture();
  try {
    expectOk(
      await app.registry.controlPlanningScheduler(app.id, {
        kind: "started",
        invocationId: "cancel",
        baselineRevision: 0,
      }),
    );
    expectOk(await app.declare(["A"]));
    await app.until(() => app.executors.length === 2);
    app.executors[1]!.cleanupFails = true;
    const result = await app.registry.controlPlanningScheduler(app.id, {
      kind: "cancelled",
      invocationId: "cancel",
    });
    expect(expectError(result).code).toBe("AGENT_FAILED");
    const doc = (await app.read()) as WorkflowDocumentV2;
    expect(doc.tasks.A!.schedule).toMatchObject({ reason: "cleanup-uncertain" });
    expect(doc.tasks.A!.schedule!.state).not.toBe("cancelled");
    app.executors[1]!.cleanupFails = false;
    expectOk(
      await app.registry.controlPlanningScheduler(app.id, {
        kind: "cancelled",
        invocationId: "cancel",
      }),
    );
    expect(((await app.read()) as WorkflowDocumentV2).tasks.A!.schedule!.state).toBe("cancelled");
  } finally {
    await app.close();
  }
});

test("Host serializes competing starts and confirms cancellation before declaration without migrating", async () => {
  const app = await fixture();
  try {
    // Concurrent controls cannot replace an accepted owner before a durable workflow exists.
    const [first, second] = await Promise.all(
      ["first", "second"].map((invocationId) =>
        app.registry.controlPlanningScheduler(app.id, {
          kind: "started",
          invocationId,
          baselineRevision: 0,
        }),
      ),
    );
    expectOk(first!);
    expect(expectError(second!).code).toBe("WORKFLOW_CONFLICT");
    expect(app.root.context.planningSchedulerOwnership!()).toEqual({
      invocationId: "first",
      state: "active",
    });

    // An unknown cancel cannot release pending ownership; the matching cancel needs no migration.
    expectOk(
      await app.registry.controlPlanningScheduler(app.id, {
        kind: "cancelled",
        invocationId: "unknown",
      }),
    );
    expect(app.root.context.planningSchedulerOwnership!()?.invocationId).toBe("first");
    expectOk(
      await app.registry.controlPlanningScheduler(app.id, {
        kind: "cancelled",
        invocationId: "first",
      }),
    );
    expect(app.root.context.planningSchedulerOwnership!()).toBeUndefined();
    expectOk(await app.declare(["A"]));
    expect((await app.read()).version).toBe(1);
    expect(app.executors).toHaveLength(1);
    expect((await readdir(app.directory)).some((file) => file.includes("backup"))).toBe(false);
  } finally {
    await app.close();
  }
});

test("Host cancellation releases pending ownership after first-declaration profile discovery fails", async () => {
  const app = await fixture();
  try {
    // Declaration may commit its v1 tasks before the captured profile provider fails to initialize.
    expectOk(
      await app.registry.controlPlanningScheduler(app.id, {
        kind: "started",
        invocationId: "pending-initialization",
        baselineRevision: 0,
      }),
    );
    app.root.workflowScheduler!.profiles = () =>
      err(new AgentRunError("Profile discovery unavailable."));
    expect(expectError(await app.declare(["A"])).code).toBe("AGENT_FAILED");
    expect((await app.read()).version).toBe(1);

    // Matching cancellation must not require profile discovery or launch a lead to establish facts.
    expectOk(
      await app.registry.controlPlanningScheduler(app.id, {
        kind: "cancelled",
        invocationId: "pending-initialization",
      }),
    );
    expect(app.root.context.planningSchedulerOwnership!()).toBeUndefined();
    expect(app.executors).toHaveLength(1);
    expect(((await app.read()) as WorkflowDocumentV2).scheduler!.invocations).toEqual([
      expect.objectContaining({ id: "pending-initialization", state: "cancelled" }),
    ]);
  } finally {
    await app.close();
  }
});

test("Host default-off controls and declarations never migrate or write scheduler facts", async () => {
  const app = await fixture(false);
  try {
    expectOk(
      await app.registry.controlPlanningScheduler(app.id, {
        kind: "started",
        invocationId: "off",
        baselineRevision: 0,
      }),
    );
    expectOk(await app.declare(["A", "C"]));
    const doc = await app.read();
    expect(doc.version).toBe(1);
    expect("scheduler" in doc).toBe(false);
    expect(app.executors).toHaveLength(1);
    expect((await readdir(app.directory)).some((file) => file.includes("backup"))).toBe(false);
  } finally {
    await app.close();
  }
});
