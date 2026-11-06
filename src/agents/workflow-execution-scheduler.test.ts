import { expect, test } from "bun:test";
import { expectError, expectOk } from "../testing/results.ts";
import {
  createWorkflowDocument,
  validateWorkflowDocument,
  type WorkflowDocumentV2,
} from "./task-workflow.ts";
import { migrateWorkflowToV2 } from "./task-workflow-store.ts";
import { executionProfileSnapshot, scheduleExecution } from "./workflow-execution-scheduler.ts";
import { executionScope, previewExecution, validateExecutionConsent } from "./workflow-consent.ts";
import { userCommandProvenance } from "./repair-command.ts";
import { recoverWorkflow } from "./verification-policy.ts";
import type { SchedulerEvent, SchedulerRun } from "./workflow-scheduler.ts";

const profiles = Object.fromEntries(
  ["lead", "engineer", "qa"].map((name) => [
    name,
    executionProfileSnapshot({
      name,
      description: name,
      path: `/fixture/${name}.md`,
      prompt: name,
      skills: [],
    }),
  ]),
);
function fixture(autoRepair = false) {
  const doc = migrateWorkflowToV2(
    createWorkflowDocument(
      { conversationId: "root", cwd: "/fixture", sessionFile: "/fixture/root.jsonl" },
      "11111111-1111-4111-8111-111111111111",
      0,
    ),
  );
  for (const id of ["A", "B", "C"])
    doc.tasks[id] = {
      id,
      title: id,
      kind: "implement",
      scope: `Implement ${id}`,
      dependsOn: id === "B" ? ["A"] : [],
      lead: { profile: "lead" },
      implementer: { profile: "engineer" },
      verifier: { profile: "qa" },
      assignmentVersion: 0,
      artifactRevision: 0,
      verification: { state: "unverified" },
      status: "open",
    };
  const receipt = expectOk(
    previewExecution(
      doc,
      ["all"],
      "/fixture",
      profiles,
      userCommandProvenance("root", 1),
      autoRepair,
      "receipt",
    ),
  );
  doc.scheduler = {
    invocations: [],
    admissions: {},
    consents: { receipt: { ...receipt, state: "confirmed", confirmedAt: 2 } },
  };
  return doc;
}
let sequence = 0;
function reduce(
  doc: WorkflowDocumentV2,
  input: Partial<SchedulerEvent> & { kind: SchedulerEvent["kind"] },
  runs: SchedulerRun[] = [],
) {
  const result = expectOk(
    scheduleExecution(
      doc,
      runs,
      {
        id: `event-${sequence++}`,
        at: sequence + 3,
        invocationId: "exec",
        profiles,
        ...input,
      } as SchedulerEvent,
      "receipt",
    ),
  );
  expectOk(validateWorkflowDocument(result.doc));
  return result;
}
function start(doc = fixture()) {
  return reduce(doc, { kind: "started", baselineRevision: doc.revision });
}
function failed(doc: WorkflowDocumentV2, locked = false) {
  const target = doc.tasks.A!;
  target.artifactRevision = 1;
  target.verification = { state: "failed", revision: 1 };
  target.status = locked ? "analysis-pending" : "open";
  doc.defects.defect = {
    id: "defect",
    responsibleTasks: ["A"],
    discoveredAt: { eventKey: "finding", revision: 1 },
    summary: "Failure",
    evidence: "Fixture",
    automatedFailures: locked ? 3 : 0,
    locked,
    state: locked ? "analysis-pending" : "open",
    attempts: [],
    analyses: {},
  };
}

test("approval expands dependencies, preserves profiles and invalidates scope changes", () => {
  const doc = fixture();
  expect(expectOk(executionScope(doc, ["B"]))).toEqual(["A", "B"]);
  const receipt = doc.scheduler!.consents.receipt!;
  expectOk(validateExecutionConsent(doc, receipt, "/fixture", profiles));
  doc.tasks.A!.artifactRevision++;
  expectOk(validateExecutionConsent(doc, receipt, "/fixture", profiles));
  doc.tasks.A!.scope = "Changed scope";
  expect(expectError(validateExecutionConsent(doc, receipt, "/fixture", profiles)).code).toBe(
    "WORKFLOW_CONFLICT",
  );
});

test("approval rejects missing verifiers, cycles and foreign user provenance", () => {
  const doc = fixture();
  delete doc.tasks.A!.verifier;
  expect(executionScope(doc, ["A"]).ok).toBe(false);
  doc.tasks.A!.verifier = { profile: "qa" };
  doc.tasks.A!.dependsOn = ["B"];
  expect(executionScope(doc, ["B"]).ok).toBe(false);
  expect(
    previewExecution(
      fixture(),
      ["A"],
      "/fixture",
      profiles,
      userCommandProvenance("foreign", 1),
      false,
      "x",
    ).ok,
  ).toBe(false);
});

test("implementation, exact-revision QA and dependencies run serially", () => {
  let result = start();
  expect(result.intents).toHaveLength(1);
  const implement = result.intents[0]!.operationId;
  expect(result.doc.scheduler!.admissions[implement]).toMatchObject({
    taskId: "A",
    role: "implementer",
    state: "reserved",
  });
  expect(result.doc.tasks.B!.schedule!.reason).toBe("dependencies");
  expect(result.doc.tasks.C!.schedule!.reason).toBe("worktree");
  result = reduce(result.doc, { kind: "launching", operationId: implement });
  result = reduce(result.doc, { kind: "run-started", operationId: implement, runId: "engineer-A" });
  result.doc.tasks.A!.artifactRevision = 1;
  result.doc.tasks.A!.verification = { state: "awaiting-qa", revision: 1 };
  result = reduce(result.doc, { kind: "published" }, [
    { id: "engineer-A", operationId: implement, active: true },
  ]);
  expect(result.intents).toHaveLength(0);
  result = reduce(result.doc, {
    kind: "run-settled",
    operationId: implement,
    runId: "engineer-A",
    outcome: "completed",
  });
  const verify = result.intents[0]!.operationId;
  expect(result.doc.scheduler!.admissions[verify]).toMatchObject({
    role: "verifier",
    submittedRevision: 1,
  });
  result = reduce(result.doc, { kind: "run-started", operationId: verify, runId: "qa-A" });
  result.doc.tasks.A!.verification = { state: "passed", revision: 1 };
  result.doc.tasks.A!.status = "verified";
  result = reduce(result.doc, { kind: "run-settled", operationId: verify, outcome: "completed" });
  expect(result.doc.scheduler!.admissions[result.intents[0]!.operationId]).toMatchObject({
    taskId: "B",
    role: "implementer",
  });
});

test("a completed agent without accepted submission is blocked, never considered verified", () => {
  const initial = start();
  const operationId = initial.intents[0]!.operationId;
  const result = reduce(initial.doc, { kind: "run-settled", operationId, outcome: "completed" });
  expect(result.doc.tasks.A!.schedule).toMatchObject({
    state: "blocked",
    reason: "run-completed-without-accepted-result",
  });
  expect(result.doc.tasks.A!.status).toBe("open");
  expect(result.doc.tasks.B!.schedule!.reason).toBe("dependencies");
});

test("automatic repair is opt-in and a third failure never admits a fourth implementer", () => {
  const noRepair = fixture();
  failed(noRepair);
  const blocked = start(noRepair);
  expect(blocked.doc.tasks.A!.schedule!.reason).toBe("repair-not-approved");
  const repair = fixture(true);
  failed(repair);
  const allowed = start(repair);
  expect(allowed.doc.scheduler!.admissions[allowed.intents[0]!.operationId]).toMatchObject({
    taskId: "A",
    role: "implementer",
    defectId: "defect",
  });
  const locked = fixture(true);
  failed(locked, true);
  const analysis = start(locked);
  expect(analysis.doc.scheduler!.admissions[analysis.intents[0]!.operationId]).toMatchObject({
    role: "lead",
    defectId: "defect",
    effectiveProfile: { purpose: "analysis" },
  });
  expect(analysis.doc.defects.defect!.automatedFailures).toBe(3);
  expect(analysis.doc.defects.defect!.locked).toBe(true);
});

test("pause fences new work, cancel retains changes, and restart never replays runs", () => {
  const initial = start();
  const op = initial.intents[0]!.operationId;
  const paused = reduce(initial.doc, { kind: "paused" });
  expect(paused.intents.some((intent) => intent.kind === "launch")).toBe(false);
  // An unlaunched reservation is interrupted so resume can obtain a fresh operation.
  expect(paused.doc.scheduler!.admissions[op]!.state).toBe("interrupted");
  const resumed = reduce(paused.doc, { kind: "resumed" });
  expect(resumed.intents).toHaveLength(1);
  expect(resumed.intents[0]!.operationId).not.toBe(op);
  const cancelled = reduce(initial.doc, { kind: "cancelled" });
  expect(cancelled.intents).toEqual([{ kind: "stop", operationId: op }]);
  expect(cancelled.doc.tasks.A!.status).toBe("open");
  const recovery = expectOk(recoverWorkflow(initial.doc, { eventKey: "recovery", at: 99 }))
    .doc as WorkflowDocumentV2;
  expect(recovery.scheduler!.invocations[0]!.state).toBe("paused");
  expect(recovery.scheduler!.admissions[op]!.state).toBe("interrupted");
  expect(recovery.tasks.A!.schedule!.state).toBe("interrupted");
});

test("a stale verified label cannot release dependent implementation", () => {
  const doc = fixture();
  doc.tasks.A!.status = "verified";
  doc.tasks.A!.artifactRevision = 2;
  doc.tasks.A!.verification = { state: "passed", revision: 1 };
  const result = start(doc);
  expect(result.doc.tasks.B!.schedule).toMatchObject({ state: "queued", reason: "dependencies" });
  expect(
    result.intents.every(
      (intent) => result.doc.scheduler!.admissions[intent.operationId]!.taskId !== "B",
    ),
  ).toBe(true);
});

test("cancel settlement with unavailable profiles cannot revive the invocation", () => {
  const initial = start();
  const operationId = initial.intents[0]!.operationId;
  const cancelled = reduce(initial.doc, { kind: "cancelled" });
  const settled = reduce(cancelled.doc, {
    kind: "run-settled",
    operationId,
    outcome: "cancelled",
    profiles: {},
  });
  expect(settled.doc.scheduler!.invocations[0]!.state).toBe("cancelled");
  expect(settled.intents).toEqual([]);
});

test("changed profile and worktree inputs cannot reuse execution approval", () => {
  const doc = fixture();
  const receipt = doc.scheduler!.consents.receipt!;
  const changed = { ...profiles, engineer: { ...profiles.engineer!, promptHash: "changed" } };
  expect(validateExecutionConsent(doc, receipt, "/fixture", changed).ok).toBe(false);
  expect(validateExecutionConsent(doc, receipt, "/another-worktree", profiles).ok).toBe(false);
  const initial = start(doc);
  const revoked = reduce(
    {
      ...initial.doc,
      tasks: { ...initial.doc.tasks, A: { ...initial.doc.tasks.A!, scope: "Different" } },
    },
    { kind: "published" },
  );
  const cancelled = reduce(revoked.doc, { kind: "cancelled" });
  expect(cancelled.doc.scheduler!.invocations[0]!.state).toBe("cancelled");
  expect(cancelled.intents.every((intent) => intent.kind === "stop")).toBe(true);
});

test("durable approval references reject foreign workflow, task and unconfirmed provenance facts", () => {
  const doc = fixture();
  const receipt = doc.scheduler!.consents.receipt!;
  for (const mutation of [
    { workflowId: "foreign" },
    { conversationId: "foreign" },
    { taskIds: ["missing"] },
    { id: "another" },
    { confirmedAt: undefined },
  ]) {
    const candidate = structuredClone(doc);
    candidate.scheduler!.consents.receipt = { ...receipt, ...mutation } as typeof receipt;
    expect(validateWorkflowDocument(candidate).ok).toBe(false);
  }
});

test("duplicate events are idempotent and changed approvals stop live admissions", () => {
  const initial = start();
  const event = {
    id: "duplicate",
    at: 10,
    invocationId: "exec",
    kind: "published",
    profiles,
  } as const;
  const first = expectOk(scheduleExecution(initial.doc, [], event, "receipt"));
  const duplicate = expectOk(scheduleExecution(first.doc, [], event, "receipt"));
  expect(duplicate.doc).toBe(first.doc);
  expect(duplicate.intents).toEqual([]);
  first.doc.tasks.A!.assignmentVersion++;
  const stale = reduce(first.doc, { kind: "published" });
  expect(stale.doc.scheduler!.consents.receipt!.state).toBe("revoked");
  expect(stale.intents.some((intent) => intent.kind === "stop")).toBe(true);
});
