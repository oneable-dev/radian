import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { demoWorkspace } from "../workspace/demo.ts";
import { err, ok } from "../result.ts";
import { AgentRunError, type ExpectedError } from "../errors.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { offlineRuntime, fixtureMessage } from "../testing/offline-runtime.ts";
import {
  SessionRegistry,
  type ExecutionState,
  type SessionContext,
  type SessionExecutor,
  type SessionFactory,
} from "./session-registry.ts";
import {
  createWorkflowDocument,
  type WorkflowDocument,
  type WorkflowTask,
  type WorkflowPolicyResult,
} from "./task-workflow.ts";
import { mutateWorkflow, openWorkflow } from "./task-workflow-store.ts";
import {
  admitRepair,
  recordAnalysis,
  recordFinding,
  recordVerdict,
  submitFix,
} from "./verification-policy.ts";
import { piSessionFactory } from "./pi-session-adapter.ts";
import type { SubagentNotice } from "./subagent-notifications.ts";
import { userCommandProvenance } from "./repair-command.ts";
import type { AgentProfile } from "./agent-profiles.ts";
import type { TaskSpawnBinding } from "./subagent-tools.ts";

const task = (id: string): WorkflowTask => ({
  id,
  title: id,
  kind: "implement",
  scope: "Owned scope",
  dependsOn: [],
  lead: { profile: "lead" },
  implementer: { profile: "engineer" },
  verifier: { profile: "qa" },
  assignmentVersion: 0,
  artifactRevision: 0,
  verification: { state: "unverified" },
  status: "open",
});
const profile = (name: string): AgentProfile => ({
  name,
  description: name,
  path: `/agents/${name}.md`,
  prompt: "Owned role",
  skills: [],
  ...(name === "lead" || name === "delegator" ? { delegation: { enabled: true } } : {}),
});
const bindingFor = (
  doc: WorkflowDocument,
  role: TaskSpawnBinding["role"],
  taskId = "task-main",
) => ({
  workflowId: doc.workflowId,
  taskId,
  role,
  assignmentVersion: doc.tasks[taskId]!.assignmentVersion,
});
type Run = { id: string; repairTarget?: { defectId: string; attemptId: string } };

class Executor implements SessionExecutor {
  state: ExecutionState = { status: null, output: "", error: null };
  readonly done = Promise.withResolvers<void>();
  readonly notices: SubagentNotice[] = [];
  readonly displayed: string[] = [];
  closeError: ExpectedError | undefined;
  constructor(
    readonly context: SessionContext,
    readonly savedSessionId: string,
    readonly sessionFile: string | undefined,
  ) {}
  subscribe() {
    return () => {};
  }
  async prompt() {
    this.state = { ...this.state, status: "working" };
    await this.done.promise;
    return ok(undefined);
  }
  async close() {
    this.done.resolve();
    return this.closeError ? err(this.closeError) : ok(undefined);
  }
  async steer() {
    return ok({ queued: true });
  }
  notifySubagent(event: SubagentNotice, current = () => true, delivered?: () => void) {
    if (current()) {
      this.notices.push(event);
      delivered?.();
    }
  }
  async appendNotice(text: string) {
    this.displayed.push(text);
    return ok(undefined);
  }
}

async function fixture(
  options: {
    cwd?: string;
    factory?: SessionFactory;
    repositories?: ConstructorParameters<typeof SessionRegistry>[0];
  } = {},
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "radian-host-boundary-")));
  const cwd = options.cwd ?? "/demo/radian";
  const sessionFile = join(directory, "root.jsonl");
  const conversationId = crypto.randomUUID();
  await writeFile(sessionFile, JSON.stringify({ type: "session", id: conversationId, cwd }) + "\n");
  const executors: Executor[] = [];
  const contexts: SessionContext[] = [];
  const registry = new SessionRegistry(options.repositories ?? demoWorkspace(), async (context) => {
    contexts.push(context);
    if (context.agent === "engineer" && options.factory) return options.factory(context);
    const executor = new Executor(
      context,
      context.role === "main" ? conversationId : crypto.randomUUID(),
      context.role === "main" ? sessionFile : undefined,
    );
    executors.push(executor);
    return executor;
  });
  const id = expectOk(await registry.create(options.cwd ?? "demo:main", sessionFile));
  const root = executors[0]!;
  const owner = { conversationId, cwd };
  const location = { originSessionFile: sessionFile };
  const doc = createWorkflowDocument({ ...owner, sessionFile }, crypto.randomUUID(), 1);
  doc.tasks["task-main"] = task("task-main");
  doc.tasks["task-other"] = task("task-other");
  doc.tasks["task-child"] = { ...task("task-child"), parentTaskId: "task-main" };
  expectOk(
    await mutateWorkflow(location, owner, () =>
      ok({ doc, effects: [], outcome: { kind: "applied" } }),
    ),
  );
  const read = async () => expectOk(await openWorkflow(sessionFile, owner))!.doc;
  const apply = async (mutate: (doc: WorkflowDocument) => WorkflowPolicyResult) =>
    expectOk(await mutateWorkflow(location, owner, (current) => mutate(current!)));
  const change = async (mutate: (doc: WorkflowDocument) => WorkflowDocument | void) =>
    expectOk(
      await mutateWorkflow(location, owner, (current) => {
        const updated = mutate(current!) ?? current!;
        if (updated.revision === current!.revision) updated.revision++;
        return ok({ doc: updated, effects: [], outcome: { kind: "applied" } });
      }),
    );
  const fail = async (locked = false) => {
    expectOk(
      await mutateWorkflow(location, owner, (current) =>
        recordFinding(current!, {
          binding: bindingFor(current!, "verifier"),
          eventKey: "finding",
          at: 1,
          defectId: "defect-main",
          revision: 0,
          summary: "Regression",
          evidence: "Discovery evidence",
        }),
      ),
    );
    if (locked)
      await change((current) => {
        Object.assign(current.defects["defect-main"]!, {
          locked: true,
          automatedFailures: 3,
          state: "analysis-pending",
        });
        current.tasks["task-main"]!.status = "analysis-pending";
      });
  };
  const spawn = (agent: string, binding?: TaskSpawnBinding, context = root.context) =>
    context.coordinateSubagents!(
      { action: "spawn", agent, task: "Bound work", ...(binding ? { binding } : {}) },
      undefined,
      undefined,
      profile(agent),
    );
  const stop = (run: Run) => root.context.coordinateSubagents!({ action: "stop", id: run.id });
  return {
    registry,
    id,
    root,
    executors,
    contexts,
    read,
    apply,
    change,
    fail,
    spawn,
    stop,
    conversationId,
    sessionFile,
    async cleanup() {
      const runs = expectOk(await root.context.coordinateSubagents!({ action: "status" })) as Run[];
      for (const run of runs) expectOk(await stop(run));
      expectOk(await root.context.coordinateSubagents!({ action: "wait" }));
      expectOk(await registry.shutdown());
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("Q05 host confines bound leads to their task tree and rejects unbound role acquisition", async () => {
  const app = await fixture();
  try {
    // The same profile owns two branches; profile matching must not grant cross-branch control.
    const lead = expectOk(await app.spawn("lead", { id: "task-main", role: "lead" })) as Run;
    const context = app.contexts.at(-1)!;
    for (const [agent, role] of [
      ["engineer", "implementer"],
      ["qa", "verifier"],
      ["engineer", "worker"],
    ] as const)
      expect(expectError(await app.spawn(agent, { id: "task-other", role }, context)).code).toBe(
        "WORKFLOW_NOT_AUTHORIZED",
      );
    expectOk(await app.spawn("engineer", { id: "task-child", role: "worker" }, context));
    for (const [agent, role] of [
      ["engineer", "implementer"],
      ["qa", "verifier"],
      ["engineer", "worker"],
    ] as const) {
      const rootRun = expectOk(await app.spawn(agent, { id: "task-other", role })) as Run;
      expectOk(await app.stop(rootRun));
    }
    expectOk(await app.spawn("delegator"));
    const unbound = app.contexts.at(-1)!;
    expect(
      expectError(await app.spawn("qa", { id: "task-other", role: "verifier" }, unbound)).code,
    ).toBe("WORKFLOW_NOT_AUTHORIZED");
    expectOk(await app.stop(lead));
  } finally {
    await app.cleanup();
  }
});

test("Q04 locked tasks deny writable leads and workers but analysis workers inherit read-only purpose", async () => {
  const app = await fixture();
  try {
    // An already-running lead must not gain a writable worker after the permanent lock.
    expectOk(await app.spawn("lead", { id: "task-main", role: "lead" }));
    const lead = app.contexts.at(-1)!;
    await app.fail(true);
    for (const role of ["lead", "worker"] as const)
      expect(
        expectError(
          await app.spawn(role === "lead" ? "lead" : "engineer", { id: "task-main", role }),
        ).code,
      ).toBe("WORKFLOW_REPAIR_LOCKED");
    expect(
      expectError(await app.spawn("engineer", { id: "task-main", role: "worker" }, lead)).code,
    ).toBe("WORKFLOW_REPAIR_LOCKED");
    expectOk(
      await app.spawn("engineer", { id: "task-main", role: "worker", purpose: "analysis" }, lead),
    );
    const analysis = app.contexts.at(-1)!;
    expect(analysis.purpose).toBe("analysis");
    expect(analysis.binding?.purpose).toBe("analysis");
    expect(expectError(await analysis.authorizeTool!("write")).code).toBe(
      "WORKFLOW_NOT_AUTHORIZED",
    );
    expectOk(await app.spawn("engineer", { id: "task-other", role: "worker" }));
    expectOk(await app.spawn("lead", { id: "task-main", role: "lead", purpose: "analysis" }));
    const analysisLead = app.contexts.at(-1)!;
    expectOk(await app.spawn("engineer", { id: "task-main", role: "worker" }, analysisLead));
    expect(app.contexts.at(-1)!.purpose).toBe("analysis");
    expect(app.contexts.at(-1)!.binding?.purpose).toBe("analysis");
  } finally {
    await app.cleanup();
  }
});

test("Q06 repeated and concurrent repair spawns claim exactly one live run and reuse admission after stop", async () => {
  const app = await fixture();
  try {
    await app.fail();
    // Simultaneous requests share the durable attempt but cannot share its live write authority.
    const results = await Promise.all([
      app.spawn("engineer", { id: "task-main", role: "implementer" }),
      app.spawn("engineer", { id: "task-main", role: "implementer" }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const first = expectOk(results.find((result) => result.ok)!) as Run;
    const conflict = expectError(results.find((result) => !result.ok)!);
    expect(conflict.code).toBe("WORKFLOW_CONFLICT");
    expect(conflict.message).toContain(`already running in run ${first.id}`);
    expect(
      expectError(await app.spawn("engineer", { id: "task-main", role: "implementer" })).code,
    ).toBe("WORKFLOW_CONFLICT");
    expectOk(await app.stop(first));
    const retry = expectOk(
      await app.spawn("engineer", { id: "task-main", role: "implementer" }),
    ) as Run;
    expect(retry.repairTarget).toEqual(first.repairTarget);
    const doc = await app.read();
    expect(doc.defects["defect-main"]!.attempts).toHaveLength(1);
    expect(doc.defects["defect-main"]!.automatedFailures).toBe(0);
  } finally {
    await app.cleanup();
  }
});

test("Q06 capacity rejection releases only the live claim and retains the uncounted admission", async () => {
  const app = await fixture();
  try {
    await app.fail();
    const fillers: Run[] = [];
    for (let index = 0; index < 5; index++)
      fillers.push(expectOk(await app.spawn("qa", { id: "task-other", role: "verifier" })) as Run);
    expect(
      expectError(await app.spawn("engineer", { id: "task-main", role: "implementer" })).code,
    ).toBe("DELEGATION_CAPACITY_EXCEEDED");
    const admitted = (await app.read()).defects["defect-main"]!.attempts[0]!;
    expectOk(await app.stop(fillers[0]!));
    const retry = expectOk(
      await app.spawn("engineer", { id: "task-main", role: "implementer" }),
    ) as Run;
    expect(retry.repairTarget?.attemptId).toBe(admitted.id);
    expect((await app.read()).defects["defect-main"]!.automatedFailures).toBe(0);
  } finally {
    await app.cleanup();
  }
});

test("Q06 failed executor cleanup retains its claim until confirmed closure", async () => {
  const app = await fixture();
  try {
    await app.fail();
    const run = expectOk(
      await app.spawn("engineer", { id: "task-main", role: "implementer" }),
    ) as Run;
    const engineer = app.executors.at(-1)!;
    engineer.closeError = new AgentRunError("Cleanup not confirmed");

    expect((await app.stop(run)).ok).toBe(false);
    expect(
      expectError(await app.spawn("engineer", { id: "task-main", role: "implementer" })).code,
    ).toBe("WORKFLOW_CONFLICT");
    engineer.closeError = undefined;
    expectOk(await app.stop(run));
    const retry = expectOk(
      await app.spawn("engineer", { id: "task-main", role: "implementer" }),
    ) as Run;

    expect(retry.repairTarget).toEqual(run.repairTarget);
  } finally {
    await app.cleanup();
  }
});

test("Q06 failed factory creation releases its live claim without consuming the durable attempt", async () => {
  let failCreation = true;
  const app = await fixture({
    factory: async (context) => {
      if (failCreation) throw new AgentRunError("Factory unavailable");
      return new Executor(context, crypto.randomUUID(), undefined);
    },
  });
  try {
    await app.fail();
    expect(
      expectError(await app.spawn("engineer", { id: "task-main", role: "implementer" })).code,
    ).toBe("AGENT_FAILED");
    const admitted = (await app.read()).defects["defect-main"]!.attempts[0]!;

    failCreation = false;
    const retry = expectOk(
      await app.spawn("engineer", { id: "task-main", role: "implementer" }),
    ) as Run;

    expect(retry.repairTarget?.attemptId).toBe(admitted.id);
    expect((await app.read()).defects["defect-main"]!.automatedFailures).toBe(0);
  } finally {
    await app.cleanup();
  }
});

async function failAttempt(app: Awaited<ReturnType<typeof fixture>>, index: number): Promise<void> {
  const defectId = "defect-main",
    attemptId = `attempt-${index}`;
  await app.apply((doc) =>
    admitRepair(doc, {
      binding: bindingFor(doc, "lead"),
      eventKey: `admit-${index}`,
      at: index,
      defectId,
      attemptId,
    }),
  );
  await app.apply((doc) =>
    submitFix(doc, {
      binding: bindingFor(doc, "implementer"),
      eventKey: `submit-${index}`,
      at: index,
      defectId,
      attemptId,
    }),
  );
  await app.apply((doc) =>
    recordVerdict(doc, {
      binding: bindingFor(doc, "verifier"),
      eventKey: `verdict-${index}`,
      at: index,
      defectId,
      attemptId,
      revision: index,
      verdict: "fail",
      evidence: `QA evidence ${index}`,
    }),
  );
}

test("Q11 Q18 human status and authorized handoff detail expose all attempts, remedies and decisions", async () => {
  const app = await fixture();
  try {
    await app.fail();
    for (let index = 1; index <= 3; index++) await failAttempt(app, index);
    await app.apply((doc) =>
      recordAnalysis(doc, {
        binding: bindingFor(doc, "lead"),
        eventKey: "analysis",
        at: 4,
        defectId: "defect-main",
        analysis: {
          reproduction: "Run reproduction " + "e".repeat(17000),
          attempts: "All three repair references",
          causes: [{ status: "verified", text: "Verified cause" }],
          remedies: ["Replace stale authority"],
          humanDecisions: ["Choose the remediation"],
        },
      }),
    );
    const text = expectOk(
      await app.registry.repair(
        app.id,
        app.conversationId,
        { kind: "status", id: "defect-main" },
        userCommandProvenance(app.conversationId, 5),
      ),
    );
    for (const expected of [
      "QA evidence 1",
      "QA evidence 2",
      "QA evidence 3",
      "All three repair references",
      "Replace stale authority",
      "Choose the remediation",
    ])
      expect(text).toContain(expected);
    expect(text.length).toBeGreaterThan(16000);
    expect(text.length).toBeLessThanOrEqual(60000);
    expect(app.root.displayed.at(-1)).toBe(text);
    const taskStatus = expectOk(
      await app.registry.repair(
        app.id,
        app.conversationId,
        { kind: "status", id: "task-main" },
        userCommandProvenance(app.conversationId, 6),
      ),
    );
    expect(taskStatus).toContain("handoff: /repair status defect-main");
    const full = expectOk(
      await app.root.context.coordinateTask!(
        { action: "status", id: "defect-main", detail: "handoff" },
        "root-detail",
      ),
    );
    expect(full).toBe(text);
    expectOk(await app.spawn("lead", { id: "task-other", role: "lead" }));
    expect(
      expectError(
        await app.contexts.at(-1)!.coordinateTask!(
          { action: "status", id: "defect-main", detail: "handoff" },
          "sibling-detail",
        ),
      ).code,
    ).toBe("WORKFLOW_NOT_AUTHORIZED");
    expectOk(await app.spawn("lead", { id: "task-main", role: "lead", purpose: "analysis" }));
    expect(
      expectOk(
        await app.contexts.at(-1)!.coordinateTask!(
          { action: "status", id: "defect-main", detail: "handoff" },
          "lead-detail",
        ),
      ),
    ).toBe(text);
  } finally {
    await app.cleanup();
  }
});

test("Q15 bound descendants revalidate current assignment, lock and unavailable workflow at every write", async () => {
  const app = await fixture();
  try {
    expectOk(await app.spawn("lead", { id: "task-main", role: "lead" }));
    const lead = app.contexts.at(-1)!;
    expectOk(await app.spawn("delegator", undefined, lead));
    const descendant = app.contexts.at(-1)!;
    expectOk(await descendant.authorizeTool!("bash"));
    await app.fail(true);
    expect(expectError(await descendant.authorizeTool!("write")).code).toBe(
      "WORKFLOW_REPAIR_LOCKED",
    );
    expectOk(await app.spawn("qa", { id: "task-main", role: "verifier" }));
    const qa = app.contexts.at(-1)!;
    // QA may execute tests even while implementation is locked; assignment revocation still applies.
    expectOk(await qa.authorizeTool!("bash"));
    await app.change((doc) => {
      doc.tasks["task-main"]!.assignmentVersion++;
    });
    expect(expectError(await qa.authorizeTool!("bash")).code).toBe("WORKFLOW_NOT_AUTHORIZED");
    const path = `${app.sessionFile}.workflow.json`;
    const savedWorkflow = await Bun.file(path).text();
    await writeFile(path, "{corrupt");
    expect((await descendant.authorizeTool!("write")).ok).toBe(false);
    await writeFile(path, savedWorkflow);
  } finally {
    await app.cleanup();
  }
});

test("Q15 D04 real SDK unbound engineer inherits its bound lead's write lock after three failures", async () => {
  const files = await createWorktreeFixture();
  const options = await offlineRuntime(join(files.directory, "agent"));
  const paused = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const beforeLock = join(files.main, "before-lock.txt");
  const afterLock = join(files.main, "after-lock.txt");
  let call = 0;
  let lateError = "";
  const factory = piSessionFactory({
    ...options,
    defaultPackagePaths: [],
    streamFn(model, context) {
      const stream = createAssistantMessageEventStream();
      const stage = call++;
      if (stage === 2) {
        const result = context.messages.find(
          (message) => message.role === "toolResult" && message.toolCallId === "after-lock",
        );
        if (result?.role === "toolResult" && result.isError)
          lateError = result.content
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("\n");
      }
      void (async () => {
        if (stage === 1) {
          paused.resolve();
          await release.promise;
        }
        const message = fixtureMessage(model.api, model.provider, model.id);
        message.content =
          stage < 2
            ? [
                {
                  type: "toolCall",
                  id: stage === 0 ? "before-lock" : "after-lock",
                  name: "write",
                  arguments: {
                    path: stage === 0 ? beforeLock : afterLock,
                    content: "Inherited write authority",
                  },
                },
              ]
            : [{ type: "text", text: "Done" }];
        message.stopReason = stage < 2 ? "toolUse" : "stop";
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
        if (stage === 2) finished.resolve();
      })();
      return stream;
    },
  });
  const app = await fixture({ cwd: files.main, repositories: [files.repository], factory });
  try {
    // Omit task and defect IDs so the unbound text guard cannot provide the write protection.
    expectOk(await app.spawn("lead", { id: "task-main", role: "lead" }));
    const lead = app.contexts.at(-1)!;
    expectOk(
      await lead.coordinateSubagents!(
        { action: "spawn", agent: "engineer", task: "Write the marker" },
        undefined,
        undefined,
        profile("engineer"),
      ),
    );
    await paused.promise;
    const child = app.contexts.at(-1)!;
    expect(child.binding).toBeUndefined();
    expectOk(await child.authorizeTool!("write"));
    expect(await Bun.file(beforeLock).text()).toBe("Inherited write authority");

    // The same running child must recheck inherited authority after the permanent lock.
    await app.fail();
    for (let index = 1; index <= 3; index++) await failAttempt(app, index);
    const defect = (await app.read()).defects["defect-main"]!;
    expect(defect.automatedFailures).toBe(3);
    expect(defect.locked).toBe(true);
    expect(expectError(await child.authorizeTool!("write")).code).toBe("WORKFLOW_REPAIR_LOCKED");
    release.resolve();
    await finished.promise;

    // The real SDK boundary must reject the write before it reaches the filesystem.
    expect(lateError).toContain("WORKFLOW_REPAIR_LOCKED");
    expect(await Bun.file(afterLock).exists()).toBe(false);
  } finally {
    release.resolve();
    await app.cleanup();
    await files.cleanup();
  }
}, 10000);

test.each([false, true])(
  "Q15 real SDK denies writes after submit with third-failure lock=%s",
  async (locked) => {
    const files = await createWorktreeFixture();
    const options = await offlineRuntime(join(files.directory, "agent"));
    const paused = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      finished = Promise.withResolvers<void>();
    const marker = join(files.main, "after-submit.txt");
    let call = 0;
    let lateError = "";
    const factory = piSessionFactory({
      ...options,
      defaultPackagePaths: [],
      streamFn(model, context) {
        const stream = createAssistantMessageEventStream(),
          stage = call++;
        if (stage === 2) {
          const result = context.messages.find(
            (message) => message.role === "toolResult" && message.toolCallId === "late-write",
          );
          if (result?.role === "toolResult" && result.isError)
            lateError = result.content
              .filter((item) => item.type === "text")
              .map((item) => item.text)
              .join("\n");
        }
        void (async () => {
          if (stage === 1) {
            paused.resolve();
            await release.promise;
          }
          const message = fixtureMessage(model.api, model.provider, model.id);
          message.content =
            stage === 0
              ? [
                  {
                    type: "toolCall",
                    id: "submit",
                    name: "radian-task",
                    arguments: { action: "submit" },
                  },
                ]
              : stage === 1
                ? [
                    {
                      type: "toolCall",
                      id: "late-write",
                      name: "write",
                      arguments: { path: marker, content: "must not be written" },
                    },
                  ]
                : [{ type: "text", text: "Done" }];
          message.stopReason = stage < 2 ? "toolUse" : "stop";
          stream.push({ type: "done", reason: message.stopReason, message });
          stream.end();
          if (stage === 2) finished.resolve();
        })();
        return stream;
      },
    });
    const app = await fixture({ cwd: files.main, repositories: [files.repository], factory });
    try {
      await app.fail();
      await failAttempt(app, 1);
      await failAttempt(app, 2);
      const run = expectOk(
        await app.spawn("engineer", { id: "task-main", role: "implementer" }),
      ) as Run;
      await paused.promise;
      if (locked) {
        expectOk(await app.spawn("qa", { id: "task-main", role: "verifier" }));
        expectOk(
          await app.contexts.at(-1)!.coordinateTask!(
            {
              action: "verdict",
              ...run.repairTarget,
              revision: 3,
              verdict: "fail",
              evidence: "third failure",
            },
            "third-verdict",
          ),
        );
        expect((await app.read()).defects["defect-main"]!.locked).toBe(true);
      }
      release.resolve();
      await finished.promise;
      expect(await Bun.file(marker).exists()).toBe(false);
      expect(lateError).toContain("WORKFLOW_NOT_AUTHORIZED");
      const write = await app.contexts.find((context) => context.agent === "engineer")!
        .authorizeTool!("write");
      expect(expectError(write).code).toBe("WORKFLOW_NOT_AUTHORIZED");
    } finally {
      release.resolve();
      await app.cleanup();
      await files.cleanup();
    }
  },
  10000,
);

test("Q15 real SDK nested executeTool writes are revoked after submit but fresh admitted runs can write", async () => {
  const files = await createWorktreeFixture();
  const options = await offlineRuntime(join(files.directory, "agent"));
  const extensionDirectory = join(files.directory, "agent", "extensions");
  await mkdir(extensionDirectory, { recursive: true });
  const nestedResult = join(files.directory, "nested-result.json");
  // A read-named extension is allowed through the outer policy; its nested write must be checked independently.
  await writeFile(
    join(extensionDirectory, "nested.ts"),
    `import {writeFile} from "node:fs/promises"; export default function(pi) { pi.registerTool({ name: "read", label: "Nested fixture", description: "Nested write probe", parameters: {type:"object",properties:{path:{type:"string"}},required:["path"]}, execute: async (_id,args,_signal,_update,ctx) => { const result = await ctx.executeTool("write", {path:args.path,content:"nested forbidden"}); await writeFile(${JSON.stringify(nestedResult)},JSON.stringify(result)); return {content:[{type:"text",text:JSON.stringify(result)}],details:result}; } }); }`,
  );
  const marker = join(files.main, "nested.txt"),
    fresh = join(files.main, "fresh.txt");
  const finished = Promise.withResolvers<void>(),
    wrote = Promise.withResolvers<void>();
  let call = 0;
  const factory = piSessionFactory({
    ...options,
    defaultPackagePaths: [],
    streamFn(model) {
      const stream = createAssistantMessageEventStream(),
        stage = call++;
      const message = fixtureMessage(model.api, model.provider, model.id);
      message.content =
        stage === 0
          ? [
              {
                type: "toolCall",
                id: "submit",
                name: "radian-task",
                arguments: { action: "submit" },
              },
            ]
          : stage === 1
            ? [{ type: "toolCall", id: "nested", name: "read", arguments: { path: marker } }]
            : stage === 3
              ? [
                  {
                    type: "toolCall",
                    id: "fresh",
                    name: "write",
                    arguments: { path: fresh, content: "fresh authorized write" },
                  },
                ]
              : [{ type: "text", text: "Done" }];
      message.stopReason = [0, 1, 3].includes(stage) ? "toolUse" : "stop";
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
      if (stage === 2) finished.resolve();
      if (stage === 4) wrote.resolve();
      return stream;
    },
  });
  const app = await fixture({ cwd: files.main, repositories: [files.repository], factory });
  try {
    const initial = expectOk(
      await app.spawn("engineer", { id: "task-main", role: "implementer" }),
    ) as Run;
    await finished.promise;
    expect(await Bun.file(marker).exists()).toBe(false);
    const nested: { isError: boolean; result: { content: { type: string; text?: string }[] } } =
      await Bun.file(nestedResult).json();
    expect(nested.isError).toBe(true);
    expect(JSON.stringify(nested.result.content)).toContain("WORKFLOW_NOT_AUTHORIZED");
    expectOk(await app.stop(initial));
    expectOk(await app.spawn("qa", { id: "task-main", role: "verifier" }));
    expectOk(
      await app.contexts.at(-1)!.coordinateTask!(
        {
          action: "finding",
          defectId: "defect-main",
          revision: 1,
          summary: "New failure",
          evidence: "New QA evidence",
        },
        "new-finding",
      ),
    );
    expectOk(await app.spawn("engineer", { id: "task-main", role: "implementer" }));
    await wrote.promise;
    expect(await Bun.file(fresh).text()).toBe("fresh authorized write");
  } finally {
    await app.cleanup();
    await files.cleanup();
  }
}, 10000);
