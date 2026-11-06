import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { demoWorkspace } from "../workspace/demo.ts";
import { err, ok } from "../result.ts";
import { AgentRunError, type ExpectedError } from "../errors.ts";
import { expectError, expectOk } from "../testing/results.ts";
import {
  SessionRegistry,
  type ExecutionState,
  type SessionContext,
  type SessionExecutor,
} from "./session-registry.ts";
import {
  createWorkflowDocument,
  type WorkflowDocument,
  type WorkflowTask,
} from "./task-workflow.ts";
import { mutateWorkflow, openWorkflow } from "./task-workflow-store.ts";
import { recordFinding } from "./verification-policy.ts";
import {
  authorizeTaskBinding,
  resolveTaskBinding,
  TaskRouting,
  type TaskRecipient,
} from "./task-routing.ts";
import { SubagentNotifications, type SubagentNotice } from "./subagent-notifications.ts";
import { taskCommandSchema } from "./task-tool.ts";
import { userCommandProvenance, type UserCommandProvenance } from "./repair-command.ts";
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
  ...(name === "lead" ? { delegation: { enabled: true } } : {}),
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

function routingDocument(): WorkflowDocument {
  const doc = createWorkflowDocument(
    { conversationId: "routing-root", cwd: "/demo/radian", sessionFile: "/demo/root.jsonl" },
    crypto.randomUUID(),
    1,
  );
  doc.tasks["task-main"] = task("task-main");
  doc.tasks["task-other"] = task("task-other");
  doc.tasks["task-child"] = { ...task("task-child"), parentTaskId: "task-main" };
  doc.tasks["task-grandchild"] = { ...task("task-grandchild"), parentTaskId: "task-child" };
  return doc;
}

test("Q05 D02 Only current leads may spawn bound roles within their own task tree", () => {
  const doc = routingDocument();
  const spawner = { kind: "bound" as const, binding: bindingFor(doc, "lead"), profile: "lead" };
  const profiles = { lead: "lead", implementer: "engineer", verifier: "qa", worker: "worker" };

  // Every role is constrained by the spawning lead's ancestry, not only worker roles.
  for (const role of ["lead", "implementer", "verifier", "worker"] as const) {
    for (const id of ["task-main", "task-child", "task-grandchild"])
      expectOk(resolveTaskBinding(doc, { id, role }, profiles[role], spawner));
    expect(
      expectError(resolveTaskBinding(doc, { id: "task-other", role }, profiles[role], spawner))
        .code,
    ).toBe("WORKFLOW_NOT_AUTHORIZED");
    expectOk(resolveTaskBinding(doc, { id: "task-other", role }, profiles[role], { kind: "root" }));
    expect(
      expectError(
        resolveTaskBinding(doc, { id: "task-main", role }, profiles[role], { kind: "unbound" }),
      ).code,
    ).toBe("WORKFLOW_NOT_AUTHORIZED");
  }

  // A matching target profile never grants spawning authority to a non-lead or revoked lead.
  for (const role of ["implementer", "verifier", "worker"] as const)
    expect(
      expectError(
        resolveTaskBinding(doc, { id: "task-main", role: "worker" }, "worker", {
          kind: "bound",
          binding: bindingFor(doc, role),
          profile: profiles[role],
        }),
      ).code,
    ).toBe("WORKFLOW_NOT_AUTHORIZED");
  for (const revoked of [
    { ...spawner, profile: "wrong-lead" },
    { ...spawner, binding: { ...spawner.binding, assignmentVersion: 9 } },
    { ...spawner, binding: { ...spawner.binding, workflowId: crypto.randomUUID() } },
  ])
    expect(
      expectError(resolveTaskBinding(doc, { id: "task-child", role: "worker" }, "worker", revoked))
        .code,
    ).toBe("WORKFLOW_NOT_AUTHORIZED");
});

test.each(["lead", "worker"] as const)(
  "Q04 Q09 D01 Locked %s runs require read-only purpose without blocking unrelated tasks",
  (role) => {
    const doc = routingDocument();
    const finding = expectOk(
      recordFinding(doc, {
        binding: bindingFor(doc, "verifier"),
        eventKey: "locked-finding",
        at: 2,
        defectId: "locked-defect",
        revision: 0,
        summary: "Regression",
        evidence: "Failing check",
      }),
    ).doc;
    finding.defects["locked-defect"]!.locked = true;
    const spawner = {
      kind: "bound" as const,
      binding: bindingFor(finding, "lead"),
      profile: "lead",
    };
    const targetProfile = role === "lead" ? "lead" : "worker";

    // Neither root authority nor delegating a worker bypasses the permanent repair guard.
    for (const authority of [spawner, { kind: "root" as const }]) {
      expect(
        expectError(
          resolveTaskBinding(finding, { id: "task-main", role }, targetProfile, authority),
        ).code,
      ).toBe("WORKFLOW_REPAIR_LOCKED");
      for (const purpose of ["analysis", "planning"] as const)
        expectOk(
          resolveTaskBinding(finding, { id: "task-main", role, purpose }, targetProfile, authority),
        );
    }
    expectOk(
      resolveTaskBinding(finding, { id: "task-other", role }, targetProfile, { kind: "root" }),
    );

    // Task lifecycle guards apply even when no defect record carries a lock yet.
    finding.defects = {};
    for (const status of ["analysis-pending", "human-required"] as const) {
      finding.tasks["task-main"]!.status = status;
      expect(
        expectError(resolveTaskBinding(finding, { id: "task-main", role }, targetProfile, spawner))
          .code,
      ).toBe("WORKFLOW_REPAIR_LOCKED");
    }
  },
);

test.each(["lead", "worker"] as const)(
  "Plan-kind %s bindings derive planning purpose even when omitted or overridden",
  (role) => {
    // The durable task kind is authoritative, not a model-supplied purpose.
    const doc = routingDocument();
    doc.tasks["task-main"]!.kind = "plan";
    for (const purpose of [undefined, "analysis", "planning"] as const) {
      const binding = expectOk(
        resolveTaskBinding(
          doc,
          { id: "task-main", role, ...(purpose ? { purpose } : {}) },
          role === "lead" ? "lead" : "worker",
          { kind: "root" },
        ),
      );

      expect(binding.purpose).toBe("planning");
      expect(Object.isFrozen(binding)).toBe(true);
    }
    expect(
      expectError(
        resolveTaskBinding(doc, { id: "task-main", role: "implementer" }, "engineer", {
          kind: "root",
        }),
      ).code,
    ).toBe("WORKFLOW_NOT_AUTHORIZED");
  },
);

test("A bound planning lead cannot drop its purpose when binding a worker to another task", () => {
  const doc = routingDocument();
  const spawner = {
    kind: "bound" as const,
    binding: { ...bindingFor(doc, "lead"), purpose: "planning" as const },
    profile: "lead",
  };

  for (const purpose of [undefined, "analysis"] as const) {
    const binding = expectOk(
      resolveTaskBinding(
        doc,
        { id: "task-child", role: "worker", ...(purpose ? { purpose } : {}) },
        "worker",
        spawner,
      ),
    );
    expect(binding.purpose).toBe("planning");
  }
});

function routingRecipients(doc: WorkflowDocument, liveLead = true) {
  const rootNotices: SubagentNotice[] = [];
  const leadNotices: SubagentNotice[] = [];
  const recipients: TaskRecipient[] = [
    {
      id: "root",
      root: true,
      workflowId: doc.workflowId,
      current: () => true,
      notify: (notice, _current, delivered) => {
        rootNotices.push(notice);
        delivered();
      },
    },
    {
      id: "lead",
      root: false,
      workflowId: doc.workflowId,
      current: () => liveLead,
      binding: bindingFor(doc, "lead"),
      profile: "lead",
      notify: (notice, _current, delivered) => {
        leadNotices.push(notice);
        delivered();
      },
    },
  ];
  return { recipients, rootNotices, leadNotices };
}

function routingFinding() {
  const doc = routingDocument();
  const finding = expectOk(
    recordFinding(doc, {
      binding: bindingFor(doc, "verifier"),
      eventKey: "routine-finding",
      at: 2,
      defectId: "routine-defect",
      revision: 0,
      summary: "Regression",
      evidence: "QA evidence",
    }),
  );
  return {
    doc: finding.doc,
    effects: [
      {
        kind: "notify-leads" as const,
        defectId: "routine-defect",
        taskIds: ["task-main"],
        profiles: ["lead"],
      },
    ],
  };
}

test.each([true, false])(
  "Q10 D08 Ordinary QA findings wake root only for orphan escalation (live lead: %p)",
  (liveLead) => {
    const { doc, effects } = routingFinding();
    const { recipients, rootNotices, leadNotices } = routingRecipients(doc, liveLead);
    const router = new TaskRouting();

    expectOk(router.deliver(doc, "routine", effects, recipients));
    expectOk(router.deliver(doc, "routine", effects, recipients));

    expect(rootNotices).toHaveLength(liveLead ? 0 : 1);
    expect(leadNotices).toHaveLength(liveLead ? 1 : 0);
    if (!liveLead && rootNotices[0]?.type === "workflow")
      expect(rootNotices[0].message).toContain("/repair status routine-defect");
  },
);

test.each([true, false])(
  "D08 Locked analysis requires a live lead even with live QA (live lead: %p)",
  (liveLead) => {
    // A verifier can observe the lock but cannot publish the required lead analysis.
    const { doc, effects } = routingFinding();
    Object.assign(doc.defects["routine-defect"]!, {
      locked: true,
      automatedFailures: 3,
      state: "analysis-pending",
    });
    doc.tasks["task-main"]!.status = "analysis-pending";
    const { recipients, rootNotices, leadNotices } = routingRecipients(doc, liveLead);
    const qaNotices: SubagentNotice[] = [];
    recipients.push({
      ...recipients[1]!,
      id: "qa",
      binding: bindingFor(doc, "verifier"),
      profile: "qa",
      current: () => true,
      notify: (notice, _current, delivered) => {
        qaNotices.push(notice);
        delivered();
      },
    });

    // Delivery must distinguish observation from the authority to satisfy the effect.
    expectOk(new TaskRouting().deliver(doc, "locked-analysis", effects, recipients));

    // Root receives only the compact handoff when no lead can provide analysis.
    expect(qaNotices).toHaveLength(1);
    expect(leadNotices).toHaveLength(liveLead ? 1 : 0);
    expect(rootNotices).toHaveLength(liveLead ? 0 : 1);
    if (!liveLead) {
      const notice = rootNotices[0]!;
      expect(notice.type).toBe("workflow");
      if (notice.type === "workflow") {
        expect(notice.message).toContain("failures 3/3 | lock LOCKED | analysis-pending");
        expect(notice.message).toContain("/repair status routine-defect");
        expect(notice.message).not.toContain("QA evidence");
        expect(notice.message.length).toBeLessThanOrEqual(2000);
      }
    }
  },
);

test.each([true, false])(
  "D08 Interrupted repair requires a live lead despite a live implementer (live lead: %p)",
  (liveLead) => {
    // An implementer cannot re-admit its own interrupted repair.
    const { doc, effects } = routingFinding();
    const { recipients, rootNotices } = routingRecipients(doc, liveLead);
    recipients.push({
      ...recipients[1]!,
      id: "engineer",
      binding: bindingFor(doc, "implementer"),
      profile: "engineer",
      current: () => true,
    });

    // Recovery attention follows lead availability rather than general task membership.
    expectOk(
      new TaskRouting().deliver(
        doc,
        "interrupted-repair",
        [{ ...effects[0]!, kind: "needs-attention" }],
        recipients,
      ),
    );

    // A missing lead escalates even when an observer remains live.
    expect(rootNotices).toHaveLength(liveLead ? 0 : 1);
  },
);

test.each(["implementer", "verifier", "lead"] as const)(
  "D08 QA notification requires a live verifier or lead, not just a live %s",
  (role) => {
    // All three roles observe task notices, but only QA or a lead can handle this effect.
    const doc = routingDocument();
    doc.tasks["task-main"]!.verification = { state: "awaiting-qa" };
    const { recipients, rootNotices, leadNotices } = routingRecipients(doc);
    recipients[1] = {
      ...recipients[1]!,
      binding: bindingFor(doc, role),
      profile: { implementer: "engineer", verifier: "qa", lead: "lead" }[role],
    };

    // Route an ordinary QA request without changing non-root observation.
    expectOk(
      new TaskRouting().deliver(
        doc,
        "awaiting-qa",
        [{ kind: "notify-qa", taskIds: ["task-main"], profiles: ["qa"] }],
        recipients,
      ),
    );

    // A live implementer alone must not suppress the root wakeup.
    expect(rootNotices).toHaveLength(role === "implementer" ? 1 : 0);
    expect(leadNotices).toHaveLength(1);
  },
);

test.each(["notify-leads", "needs-attention", "notify-qa"] as const)(
  "D08 Every task needs a capable recipient for %s within the same lead chain",
  (kind) => {
    // A child lead covers the grandchild but cannot act for its own parent task.
    const { doc, effects } = routingFinding();
    const { recipients, rootNotices, leadNotices } = routingRecipients(doc);
    recipients[1] = { ...recipients[1]!, binding: bindingFor(doc, "lead", "task-child") };
    const effect = { ...effects[0]!, kind, taskIds: ["task-grandchild", "task-main"] };

    // One covered task must not hide another task's orphaned responsibility.
    expectOk(new TaskRouting().deliver(doc, "partially-covered", [effect], recipients));

    // Same-team escalation is independent of the existing cross-team rule.
    expect(rootNotices).toHaveLength(1);
    expect(leadNotices).toHaveLength(1);
  },
);

test("Q11 D08 Human-required redelivery uses compact root summaries with retrieval commands", () => {
  const { doc } = routingFinding();
  doc.defects["routine-defect"]!.state = "human-required";
  doc.defects["routine-defect"]!.locked = true;
  const { recipients, rootNotices } = routingRecipients(doc);
  const router = new TaskRouting();

  expectOk(router.redeliver(doc, recipients));
  expectOk(router.redeliver(doc, recipients));

  expect(rootNotices).toHaveLength(1);
  const notice = rootNotices[0]!;
  expect(notice.type).toBe("workflow");
  if (notice.type === "workflow") {
    expect(notice.message).toContain("/repair status routine-defect");
    expect(notice.message.length).toBeLessThanOrEqual(2000);
    expect(notice.message).not.toContain("QA evidence");
  }
});

test.each(["task-grandchild", "task-other"])(
  "Q10 D08 Shared defects escalate only across top-level lead chains (%s)",
  (otherTask) => {
    const { doc, effects } = routingFinding();
    doc.defects["routine-defect"]!.responsibleTasks.push(otherTask);
    for (const effect of effects) effect.taskIds.push(otherTask);
    const { recipients, rootNotices, leadNotices } = routingRecipients(doc);

    expectOk(new TaskRouting().deliver(doc, "shared", effects, recipients));

    expect(rootNotices).toHaveLength(otherTask === "task-other" ? 1 : 0);
    expect(leadNotices).toHaveLength(1);
  },
);

class Executor implements SessionExecutor {
  state: ExecutionState = { status: null, output: "", error: null };
  readonly done = Promise.withResolvers<void>();
  readonly started = Promise.withResolvers<void>();
  readonly notices: SubagentNotice[] = [];
  readonly displayed: string[] = [];
  prompts = 0;
  closes = 0;
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
    this.prompts++;
    this.state = { ...this.state, status: "working" };
    this.started.resolve();
    await this.done.promise;
    return ok(undefined);
  }
  async close() {
    this.closes++;
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

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "radian-task-routing-")));
  const sessionFile = join(directory, "root.jsonl");
  const conversationId = crypto.randomUUID();
  await writeFile(
    sessionFile,
    JSON.stringify({ type: "session", id: conversationId, cwd: "/demo/radian" }) + "\n",
  );
  const executors: Executor[] = [];
  const registry = new SessionRegistry(demoWorkspace(), async (context) => {
    const file = context.role === "main" ? (context.sessionFile ?? sessionFile) : undefined;
    const savedId: string = file ? JSON.parse(await Bun.file(file).text()).id : crypto.randomUUID();
    const executor = new Executor(context, savedId, file);
    executors.push(executor);
    return executor;
  });
  const id = expectOk(await registry.create("demo:main", sessionFile));
  const root = executors[0]!;
  const owner = { conversationId, cwd: "/demo/radian" };
  const location = { originSessionFile: sessionFile };
  const doc = createWorkflowDocument({ ...owner, sessionFile }, crypto.randomUUID(), 1);
  doc.tasks["task-main"] = task("task-main");
  doc.tasks["task-other"] = task("task-other");
  await mutateWorkflow(location, owner, () =>
    ok({ doc, effects: [], outcome: { kind: "applied" } }),
  );
  const read = async () => expectOk(await openWorkflow(sessionFile, owner))!.doc;
  const change = async (mutate: (doc: WorkflowDocument) => void) =>
    expectOk(
      await mutateWorkflow(location, owner, (current) => {
        mutate(current!);
        current!.revision++;
        return ok({ doc: current!, effects: [], outcome: { kind: "applied" } });
      }),
    );
  const fail = async (locked = false) => {
    expectOk(
      await mutateWorkflow(location, owner, (current) =>
        recordFinding(current!, {
          binding: bindingFor(current!, "verifier"),
          eventKey: "finding-1",
          at: 1,
          defectId: "defect-main",
          revision: 0,
          summary: "Regression",
          evidence: "Failing check",
        }),
      ),
    );
    if (locked)
      await change((current) => {
        const defect = current.defects["defect-main"]!;
        defect.locked = true;
        defect.automatedFailures = 3;
        defect.state = "analysis-pending";
        current.tasks["task-main"]!.status = "analysis-pending";
      });
  };
  const spawn = (
    agent: string,
    taskText: string,
    binding?: TaskSpawnBinding,
    context = root.context,
  ) =>
    context.coordinateSubagents!(
      { action: "spawn", agent, task: taskText, ...(binding ? { binding } : {}) },
      undefined,
      undefined,
      profile(agent),
    );
  return {
    registry,
    id,
    root,
    executors,
    read,
    change,
    fail,
    spawn,
    sessionFile,
    conversationId,
    directory,
    async cleanup() {
      await registry.shutdown();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("Ordinary host coordination freezes plan purpose through descendants and restart without relaunch", async () => {
  const app = await fixture();
  try {
    await app.change((doc) => {
      doc.tasks["task-main"]!.kind = "plan";
    });

    // No /plan turn or caller-selected purpose is needed for a durable plan-kind binding.
    expectOk(await app.spawn("lead", "read-only lead", { id: "task-main", role: "lead" }));
    const lead = app.executors.at(-1)!;
    await lead.started.promise;
    expect(lead.context.purpose).toBe("planning");
    expect(lead.context.binding?.purpose).toBe("planning");
    expectOk(await app.spawn("worker", "inherited worker", undefined, lead.context));
    const worker = app.executors.at(-1)!;
    await worker.started.promise;
    expect(worker.context.purpose).toBe("planning");
    expect(
      expectError(
        await app.spawn("engineer", "forbidden implementation", {
          id: "task-main",
          role: "implementer",
        }),
      ).code,
    ).toBe("WORKFLOW_NOT_AUTHORIZED");
    const record = app.registry.records[0]!;
    expect(record.ownedSubagents!.map((child) => child.purpose)).toEqual(["planning", "planning"]);
    expect(record.ownedSubagents!.every((child) => child.status === "working")).toBe(true);
    expectOk(await app.registry.close(app.id));
    const restartedContexts: SessionContext[] = [];
    const restarted = new SessionRegistry(demoWorkspace(), async (context) => {
      restartedContexts.push(context);
      return new Executor(context, app.conversationId, app.sessionFile);
    });
    try {
      // A fresh registry reconstructs observations only; no child executor is recreated.
      expectOk(await restarted.restore({ ...record, lifecycle: "open", closedAt: null }));
      expect(restartedContexts).toHaveLength(1);
      expect(restartedContexts[0]!.role).toBe("main");
      const restored = restarted.records[0]!.ownedSubagents!;
      expect(restored.map((child) => child.purpose)).toEqual(["planning", "planning"]);
      expect(restored.map((child) => child.status)).toEqual([null, null]);
      expect(restored.every((child) => child.finishedAt !== undefined)).toBe(true);
      expect(restarted.details(app.id)?.result?.outcome).toBe("unfinished");
      expect(restarted.details(app.id)?.error).toContain("Previous runtime ended");
    } finally {
      expectOk(await restarted.shutdown());
    }
  } finally {
    await app.cleanup();
  }
});

test("Host plan-kind purpose overrides an explicit analysis launch request", async () => {
  const app = await fixture();
  try {
    await app.change((doc) => {
      doc.tasks["task-main"]!.kind = "plan";
    });
    expectOk(
      await app.root.context.coordinateSubagents!(
        {
          action: "spawn",
          agent: "lead",
          task: "planning wins",
          binding: { id: "task-main", role: "lead", purpose: "analysis" },
        },
        undefined,
        "analysis",
        profile("lead"),
      ),
    );
    expect(app.executors.at(-1)!.context.purpose).toBe("planning");
    expect(app.executors.at(-1)!.context.binding?.purpose).toBe("planning");
  } finally {
    await app.cleanup();
  }
});

test("Q04 Admission commits before capacity and reuses the same authorized attempt", async () => {
  // A failed task competes with five unrelated live runs for the same root capacity.
  const app = await fixture();
  try {
    await app.fail();
    const runs: { id: string }[] = [];
    for (let index = 0; index < 5; index++)
      runs.push(expectOk(await app.spawn("worker", `unrelated ${index}`)) as { id: string });

    const overflow = await app.spawn("engineer", "repair", {
      id: "task-main",
      role: "implementer",
    });
    const committed = await app.read();
    expect(expectError(overflow).code).toBe("DELEGATION_CAPACITY_EXCEEDED");
    expect(committed.defects["defect-main"]!.attempts).toHaveLength(1);
    expect(committed.defects["defect-main"]!.attempts[0]!.status).toBe("authorized");
    expect(app.executors).toHaveLength(6);

    // Freeing one slot must launch against that receipt, not count or authorize again.
    expectOk(await app.root.context.coordinateSubagents!({ action: "stop", id: runs[0]!.id }));
    const run = expectOk(
      await app.spawn("engineer", "repair", { id: "task-main", role: "implementer" }),
    ) as { binding: unknown };
    expect(run.binding).toMatchObject({
      taskId: "task-main",
      role: "implementer",
      assignmentVersion: 0,
    });
    expect((await app.read()).defects["defect-main"]!.attempts).toEqual(
      committed.defects["defect-main"]!.attempts,
    );
  } finally {
    await app.cleanup();
  }
});

test("Q04 Q15 A locked task rejects before capacity and holds no live slot", async () => {
  const app = await fixture();
  try {
    await app.fail(true);
    for (let index = 0; index < 5; index++)
      expectOk(await app.spawn("worker", `unrelated ${index}`));

    const denied = await app.spawn("engineer", "repair", { id: "task-main", role: "implementer" });
    const unbound = await app.spawn("worker", "Please repair defect-main");

    expect(expectError(denied).code).toBe("WORKFLOW_REPAIR_LOCKED");
    expect(expectError(unbound).code).toBe("WORKFLOW_REPAIR_LOCKED");
    expect(app.executors).toHaveLength(6);
    expect((await app.read()).defects["defect-main"]!.attempts).toHaveLength(0);
  } finally {
    await app.cleanup();
  }
});

test("Q05 Wrong verifier profiles, revoked assignments and other workflows are refused", async () => {
  const app = await fixture();
  try {
    const initial = await app.read();
    expect(
      expectError(
        resolveTaskBinding(initial, { id: "task-main", role: "verifier" }, "engineer", {
          kind: "root",
        }),
      ).code,
    ).toBe("WORKFLOW_NOT_AUTHORIZED");
    expect(
      expectError(
        authorizeTaskBinding(
          initial,
          { ...bindingFor(initial, "verifier"), workflowId: crypto.randomUUID() },
          "qa",
        ),
      ).code,
    ).toBe("WORKFLOW_NOT_AUTHORIZED");
    expectOk(await app.spawn("qa", "verify", { id: "task-main", role: "verifier" }));
    const qa = app.executors.at(-1)!;

    expectOk(
      await app.root.context.coordinateTask!(
        { action: "reassign", taskId: "task-main", role: "verifier", profile: "qa-next" },
        "reassign",
        undefined,
        ["qa-next"],
      ),
    );
    const finding = await qa.context.coordinateTask!(
      {
        action: "finding",
        defectId: "forged-defect",
        revision: 0,
        summary: "Old QA",
        evidence: "Stale binding",
      },
      "old-finding",
    );

    expect(expectError(finding).code).toBe("WORKFLOW_NOT_AUTHORIZED");
    expect((await app.read()).defects["forged-defect"]).toBeUndefined();
  } finally {
    await app.cleanup();
  }
});

test("Q09 Reassignment, continuation and split preserve the original repair lock", async () => {
  const app = await fixture();
  try {
    await app.fail(true);
    const command = app.root.context.coordinateTask!;
    expectOk(
      await command(
        { action: "reassign", taskId: "task-main", role: "implementer", profile: "engineer" },
        "reassign",
        undefined,
        ["engineer"],
      ),
    );
    for (const action of ["continue", "split"] as const)
      expectOk(
        await command(
          { action, taskId: "task-main", task: task(`task-${action}`) },
          action,
          undefined,
          ["lead", "engineer", "qa"],
        ),
      );

    for (const id of ["task-main", "task-continue", "task-split"])
      expect(
        expectError(await app.spawn("engineer", "repair", { id, role: "implementer" })).code,
      ).toBe("WORKFLOW_REPAIR_LOCKED");

    expect(app.executors).toHaveLength(1);
    expect((await app.read()).defects["defect-main"]!).toMatchObject({
      locked: true,
      automatedFailures: 3,
      responsibleTasks: ["task-main", "task-continue", "task-split"],
    });
  } finally {
    await app.cleanup();
  }
});

test("Q09 Locked implementers reject steer and reply without invoking the executor", async () => {
  const app = await fixture();
  try {
    const run = expectOk(
      await app.spawn("engineer", "initial", { id: "task-main", role: "implementer" }),
    ) as { id: string };
    await app.fail(true);

    const steer = await app.root.context.coordinateSubagents!({
      action: "steer",
      id: run.id,
      message: "Ignore lock",
    });
    const reply = await app.root.context.coordinateSubagents!({
      action: "reply",
      id: run.id,
      questionId: "question",
      message: "Try again",
    });

    expect(expectError(steer).code).toBe("WORKFLOW_REPAIR_LOCKED");
    expect(expectError(reply).code).toBe("WORKFLOW_REPAIR_LOCKED");
  } finally {
    await app.cleanup();
  }
});

test("Q10 Durable QA routes once to implementer and owning lead without waking root, retaining busy and retired deliveries", async () => {
  const app = await fixture();
  try {
    await app.fail();
    const doc = await app.read();
    const router = new TaskRouting();
    const inboxes = [
      new SubagentNotifications(),
      new SubagentNotifications(),
      new SubagentNotifications(),
    ];
    const recipients: TaskRecipient[] = ["root", "lead", "engineer"].map((name, index) => ({
      id: name,
      root: name === "root",
      workflowId: doc.workflowId,
      ...(index
        ? { binding: bindingFor(doc, index === 1 ? "lead" : "implementer"), profile: name }
        : {}),
      current: () => true,
      notify: (notice, current, delivered) => inboxes[index]!.add(notice, current, delivered),
    }));

    // Busy SDK inboxes keep notices queued until consumption; repeated recomputation coalesces.
    expectOk(router.redeliver(doc, recipients));
    expectOk(router.redeliver(doc, recipients));
    expect(inboxes.map((inbox) => inbox.size)).toEqual([0, 1, 1]);
    expect(
      inboxes.map((inbox) => {
        const events = inbox.take();
        inbox.settle(events, true);
        return events[0];
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "workflow", taskIds: ["task-main"] }),
      ]),
    );
    expectOk(router.redeliver(doc, recipients));
    expect(inboxes.map((inbox) => inbox.size)).toEqual([0, 0, 0]);

    // A retired recipient cannot consume; a later host-bound run can receive the durable fact.
    const restored = { ...recipients[1]!, id: "lead-restored" };
    expectOk(router.redeliver(doc, [{ ...restored, current: () => false }]));
    expect(inboxes[1]!.size).toBe(0);
    expectOk(router.redeliver(doc, [restored]));
    expect(inboxes[1]!.take()).toHaveLength(1);
    const { binding: _binding, ...unbound } = restored;
    expect(expectError(router.redeliver(doc, [unbound])).code).toBe("WORKFLOW_NOT_AUTHORIZED");
    expect(
      expectError(router.redeliver(doc, [{ ...restored, workflowId: crypto.randomUUID() }])).code,
    ).toBe("WORKFLOW_NOT_AUTHORIZED");
  } finally {
    await app.cleanup();
  }
});

test("Q13 Tool and notice payloads cannot supply user-command provenance", () => {
  // Model-controlled schemas reject authority fields rather than forwarding them to human APIs.
  const forged = { kind: "user-command" as const, conversationId: "model", receivedAt: 1 };
  // @ts-expect-error The host-only provenance brand cannot be supplied by structural model data.
  const provenance: UserCommandProvenance = forged;
  expect(provenance.kind).toBe("user-command");

  expect(Value.Check(taskCommandSchema, { action: "status", provenance: forged })).toBe(false);
  expect(Value.Check(taskCommandSchema, { action: "recheck", id: "task-main" })).toBe(false);
});

test("Q13 Same-millisecond human rechecks display host notices but create only one manual attempt", async () => {
  // Separate submissions share a timestamp but must use state-based duplicate detection.
  const app = await fixture();
  try {
    await app.fail(true);
    const user = userCommandProvenance(app.conversationId, 10);

    // Repeating the command must not advance the artifact revision twice.
    const first = expectOk(
      await app.registry.repair(
        app.id,
        app.conversationId,
        { kind: "recheck", id: "task-main" },
        user,
      ),
    );
    expectOk(
      await app.registry.repair(
        app.id,
        app.conversationId,
        { kind: "recheck", id: "task-main" },
        userCommandProvenance(app.conversationId, 10),
      ),
    );

    // Both distinct events are recorded, with the second resolved as a policy duplicate.
    const doc = await app.read();
    const rechecks = doc.log.filter((event) => event.message.startsWith("human-recheck:"));
    expect(rechecks.map((event) => event.message)).toEqual([
      "human-recheck: applied",
      "human-recheck: duplicate",
    ]);
    expect(rechecks[0]!.eventKey).not.toBe(rechecks[1]!.eventKey);
    expect(first).toContain("QA recheck of revision 1 is required");
    expect(doc.tasks["task-main"]!.artifactRevision).toBe(1);
    expect(doc.defects["defect-main"]!.attempts).toHaveLength(1);
    expect(app.root.prompts).toBe(0);
    expect(app.root.displayed).toHaveLength(2);
    expect(
      app.root.notices.some(
        (notice) =>
          notice.type === "workflow" &&
          notice.message.includes("QA recheck of revision 1") &&
          notice.message.includes("/repair status defect-main"),
      ),
    ).toBe(true);
  } finally {
    await app.cleanup();
  }
});

test("Q16 Restore interrupts admitted work without replay or failure counting", async () => {
  const app = await fixture();
  try {
    await app.fail();
    expectOk(await app.spawn("engineer", "repair", { id: "task-main", role: "implementer" }));
    await app.registry.shutdown();

    const restored: Executor[] = [];
    const registry = new SessionRegistry(demoWorkspace(), async (context) => {
      const executor = new Executor(context, app.conversationId, app.sessionFile);
      restored.push(executor);
      return executor;
    });
    try {
      expectOk(await registry.create("demo:main", app.sessionFile));
      const doc = await app.read();
      expect(doc.defects["defect-main"]!.attempts).toHaveLength(1);
      expect(doc.defects["defect-main"]!.attempts[0]!.status).toBe("interrupted");
      expect(doc.defects["defect-main"]!.automatedFailures).toBe(0);
      expect(restored).toHaveLength(1);
      expect(restored[0]!.prompts).toBe(0);
      expect(restored[0]!.notices).toHaveLength(1);
      expect(restored[0]!.notices[0]).toMatchObject({
        type: "workflow",
        message: expect.stringContaining("Recovery attention"),
      });
    } finally {
      await registry.shutdown();
    }
  } finally {
    await app.cleanup();
  }
});

test("Q07 Cancel reports accepted with stop failure warnings", async () => {
  // Multiple bound runs need independent cleanup even when some executors cannot stop.
  const app = await fixture();
  try {
    const leadRun = expectOk(
      await app.spawn("lead", "lead", { id: "task-main", role: "lead" }),
    ) as { id: string };
    const lead = app.executors.at(-1)!;
    lead.closeError = new AgentRunError("Lead stop failed.");
    const verifierRun = expectOk(
      await app.spawn("qa", "verify", { id: "task-main", role: "verifier" }),
    ) as { id: string };
    const verifier = app.executors.at(-1)!;
    verifier.closeError = new AgentRunError("Verifier stop failed.");
    expectOk(await app.spawn("engineer", "implement", { id: "task-main", role: "implementer" }));
    const engineer = app.executors.at(-1)!;

    // Durable cancellation is accepted before the executor cleanup failures occur.
    const text = expectOk(
      await app.registry.repair(
        app.id,
        app.conversationId,
        { kind: "cancel", id: "task-main" },
        userCommandProvenance(app.conversationId, 10),
      ),
    );

    // Every run is attempted and the accepted action still reaches the transcript.
    expect(text).toContain("Cancel recorded");
    expect(text).toContain(
      `[AGENT_FAILED] run ${leadRun.id} could not be stopped: Lead stop failed.`,
    );
    expect(text).toContain(
      `[AGENT_FAILED] run ${verifierRun.id} could not be stopped: Verifier stop failed.`,
    );
    expect([lead.closes, verifier.closes, engineer.closes]).toEqual([1, 1, 1]);
    expect((await app.read()).tasks["task-main"]!.status).toBe("cancelled");
    expect(app.root.displayed).toEqual([text]);
  } finally {
    for (const executor of app.executors) executor.closeError = undefined;
    await app.cleanup();
  }
});

test("Q15 Cancel by defect stops only that defect's repair runs", async () => {
  // One task hosts a lead and two separate defects with implementer and verifier runs.
  const app = await fixture();
  try {
    await app.fail();
    await app.change((doc) => {
      doc.defects["defect-second"] = {
        ...structuredClone(doc.defects["defect-main"]!),
        id: "defect-second",
      };
    });
    expectOk(await app.spawn("lead", "lead", { id: "task-main", role: "lead" }));
    const lead = app.executors.at(-1)!;
    expectOk(
      await app.spawn("engineer", "selected repair", {
        id: "task-main",
        role: "implementer",
        defectId: "defect-main",
      }),
    );
    const selectedImplementer = app.executors.at(-1)!;
    expectOk(
      await app.spawn("engineer", "other repair", {
        id: "task-main",
        role: "implementer",
        defectId: "defect-second",
      }),
    );
    const otherImplementer = app.executors.at(-1)!;
    expectOk(
      await selectedImplementer.context.coordinateTask!({ action: "submit" }, "submit-main"),
    );
    expectOk(await otherImplementer.context.coordinateTask!({ action: "submit" }, "submit-second"));
    expectOk(
      await app.spawn("qa", "selected verification", {
        id: "task-main",
        role: "verifier",
        defectId: "defect-main",
      }),
    );
    const selectedVerifier = app.executors.at(-1)!;
    expectOk(
      await app.spawn("qa", "other verification", {
        id: "task-main",
        role: "verifier",
        defectId: "defect-second",
      }),
    );
    const otherVerifier = app.executors.at(-1)!;

    // Selecting a defect must not turn into a cancellation of its entire responsible task.
    expectOk(
      await app.registry.repair(
        app.id,
        app.conversationId,
        { kind: "cancel", id: "defect-main" },
        userCommandProvenance(app.conversationId, 10),
      ),
    );

    // Only the frozen target's implementer and verifier stop; unrelated authority stays live.
    expect([selectedImplementer.closes, selectedVerifier.closes]).toEqual([1, 1]);
    expect([lead.closes, otherImplementer.closes, otherVerifier.closes]).toEqual([0, 0, 0]);
    const doc = await app.read();
    expect(doc.defects["defect-main"]!.state).toBe("cancelled");
    expect(doc.defects["defect-second"]!.state).toBe("awaiting-recheck");
    expect(doc.defects["defect-second"]!.attempts[0]!.status).toBe("submitted");
    expect(doc.tasks["task-main"]!.status).not.toBe("cancelled");
  } finally {
    await app.cleanup();
  }
});

test("Q15 Cancel revokes a lead without stopping its other-task descendants", async () => {
  const app = await fixture();
  try {
    // This child must be inside the spawning lead's tree, not an unrelated sibling task.
    await app.change((doc) => {
      doc.tasks["task-other"]!.parentTaskId = "task-main";
    });
    const leadRun = expectOk(
      await app.spawn("lead", "lead", { id: "task-main", role: "lead" }),
    ) as { id: string };
    const lead = app.executors.at(-1)!;
    expectOk(
      await app.spawn("engineer", "other", { id: "task-other", role: "implementer" }, lead.context),
    );
    const other = app.executors.at(-1)!;
    const command = { kind: "cancel" as const, id: "task-main" };

    const text = expectOk(
      await app.registry.repair(
        app.id,
        app.conversationId,
        command,
        userCommandProvenance(app.conversationId, 10),
      ),
    );
    expectOk(
      await app.registry.repair(
        app.id,
        app.conversationId,
        command,
        userCommandProvenance(app.conversationId, 10),
      ),
    );
    const denied = await lead.context.coordinateTask!(
      { action: "reassign", taskId: "task-main", role: "lead", profile: "lead" },
      "after-cancel",
      undefined,
      ["lead"],
    );

    expect(text).toContain(`Run ${leadRun.id} not stopped`);
    expect([lead.closes, other.closes]).toEqual([0, 0]);
    expect(expectError(denied).code).toBe("WORKFLOW_NOT_AUTHORIZED");
    expect((await app.read()).tasks["task-main"]!.status).toBe("cancelled");
  } finally {
    await app.cleanup();
  }
});

test("Q04 Multiple defects require an explicit target and submit cannot change the frozen attempt", async () => {
  const app = await fixture();
  try {
    await app.fail();
    await app.change((doc) => {
      doc.defects["defect-second"] = {
        ...structuredClone(doc.defects["defect-main"]!),
        id: "defect-second",
      };
    });

    const ambiguous = await app.spawn("engineer", "repair", {
      id: "task-main",
      role: "implementer",
    });
    expect(expectError(ambiguous).code).toBe("WORKFLOW_CONFLICT");
    expect(expectError(ambiguous).message).toContain("defect-second");
    const run = expectOk(
      await app.spawn("engineer", "repair", {
        id: "task-main",
        role: "implementer",
        defectId: "defect-main",
      }),
    ) as { repairTarget: { defectId: string; attemptId: string } };
    const engineer = app.executors.at(-1)!;
    const changedTarget = await engineer.context.coordinateTask!(
      { action: "submit", defectId: "defect-second", attemptId: run.repairTarget.attemptId },
      "wrong-target",
    );
    expect(expectError(changedTarget).code).toBe("WORKFLOW_NOT_AUTHORIZED");
    expectOk(await engineer.context.coordinateTask!({ action: "submit" }, "submit"));

    const doc = await app.read();
    expect(run.repairTarget.defectId).toBe("defect-main");
    expect(doc.defects["defect-main"]!.attempts[0]).toMatchObject({
      id: run.repairTarget.attemptId,
      status: "submitted",
      submittedTaskId: "task-main",
    });
    expect(doc.defects["defect-second"]!.attempts).toHaveLength(0);
  } finally {
    await app.cleanup();
  }
});

test("Q15 Repeated cancellation stops only the selected task's simple run", async () => {
  const app = await fixture();
  try {
    expectOk(await app.spawn("engineer", "selected", { id: "task-main", role: "implementer" }));
    const selected = app.executors.at(-1)!;
    expectOk(await app.spawn("engineer", "other", { id: "task-other", role: "implementer" }));
    const other = app.executors.at(-1)!;
    const provenance = userCommandProvenance(app.conversationId, 10);

    expectOk(
      await app.registry.repair(
        app.id,
        app.conversationId,
        { kind: "cancel", id: "task-main" },
        provenance,
      ),
    );
    expectOk(
      await app.registry.repair(
        app.id,
        app.conversationId,
        { kind: "cancel", id: "task-main" },
        provenance,
      ),
    );

    expect([selected.closes, other.closes]).toEqual([1, 0]);
    expect(
      expectError(
        await app.spawn("engineer", "cancelled", { id: "task-main", role: "implementer" }),
      ).code,
    ).toBe("WORKFLOW_NOT_AUTHORIZED");
  } finally {
    await app.cleanup();
  }
});

test("Q10 Q16 Continuation recovery preserves live member work without waking roots for routine QA", async () => {
  const app = await fixture();
  try {
    await app.fail();
    expectOk(await app.spawn("engineer", "repair", { id: "task-main", role: "implementer" }));
    const engineer = app.executors.at(-1)!;
    const workflow = await app.read();
    const continuationFile = join(app.directory, "continuation.jsonl");
    const continuationId = crypto.randomUUID();
    await writeFile(
      continuationFile,
      JSON.stringify({ type: "session", id: continuationId, cwd: "/demo/radian" }) + "\n",
    );
    const first = expectOk(await app.registry.create("demo:main", continuationFile));
    const provenance = userCommandProvenance(continuationId, 10);
    // A live owning lead handles both durable findings and the upcoming QA request.
    expectOk(await app.spawn("lead", "coordinate QA", { id: "task-main", role: "lead" }));
    expectOk(
      await app.registry.repair(
        first,
        continuationId,
        { kind: "continue", workflowId: workflow.workflowId },
        provenance,
      ),
    );
    expectOk(
      await app.registry.repair(
        first,
        continuationId,
        { kind: "continue", workflowId: workflow.workflowId },
        provenance,
      ),
    );
    expectOk(await app.registry.close(first));

    // Opening a linked member must not interrupt a live origin member's authorized repair.
    expectOk(await app.registry.create("demo:main", continuationFile));
    const continuation = app.executors.at(-1)!;
    expect((await app.read()).defects["defect-main"]!.attempts[0]!.status).toBe("authorized");
    const continuationNotices = continuation.notices.length;
    const originNotices = app.root.notices.length;
    expectOk(await engineer.context.coordinateTask!({ action: "submit" }, "submit-from-origin"));

    expect(continuation.notices).toHaveLength(continuationNotices);
    expect(app.root.notices).toHaveLength(originNotices);
    expect(
      engineer.notices.some(
        (notice) =>
          notice.type === "workflow" && notice.message.includes("QA recheck of revision 1"),
      ),
    ).toBe(true);
    expect((await app.read()).members).toHaveLength(2);
  } finally {
    await app.cleanup();
  }
});
