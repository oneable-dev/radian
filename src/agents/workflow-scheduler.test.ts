import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { expectError, expectOk } from "../testing/results.ts";
import {
  createWorkflowDocument,
  validateWorkflowDocument,
  type WorkflowDocumentV2,
} from "./task-workflow.ts";
import { migrateWorkflowToV2 } from "./task-workflow-store.ts";
import { declareScope, publishPlanArtifact } from "./verification-policy.ts";
import {
  schedule,
  planningProfileSnapshot,
  workflowSchedulerEnabled,
  type SchedulerEvent,
  type SchedulerRun,
} from "./workflow-scheduler.ts";
import type { AgentProfile } from "./agent-profiles.ts";
import { canCreateSchedule, canTransition } from "./workflow-schedule-state.ts";
import { legacyPlanningInstructions } from "./task-planning.ts";

export const schedulerProfile: AgentProfile = {
  name: "lead",
  description: "Plan lead",
  path: "/fixture/lead.md",
  prompt: "Read only",
  skills: [],
  delegation: { enabled: true },
};
const profiles = { lead: planningProfileSnapshot(schedulerProfile) };

function fixture(ids = ["A", "B", "C"]): WorkflowDocumentV2 {
  const origin = { conversationId: "origin", cwd: "/fixture", sessionFile: "/fixture/root.jsonl" };
  return migrateWorkflowToV2(
    expectOk(
      declareScope(createWorkflowDocument(origin, "11111111-1111-4111-8111-111111111111", 0), {
        eventKey: "declare",
        at: 1,
        goal: "Read-only trace",
        knownProfiles: ["lead"],
        branches: ids.map((id) => ({
          id,
          title: id,
          scope: `Investigate ${id}`,
          dependsOn: id === "B" ? ["A"] : [],
          lead: { profile: "lead" },
        })),
      }),
    ).doc,
  );
}
let sequence = 0;
function reduce(
  doc: WorkflowDocumentV2,
  input: Partial<SchedulerEvent> & { kind: SchedulerEvent["kind"] },
  runs: SchedulerRun[] = [],
) {
  const result = expectOk(
    schedule(doc, runs, {
      id: `event-${sequence++}`,
      at: 10 + sequence,
      invocationId: "invocation",
      profiles,
      ...input,
    } as SchedulerEvent),
  );
  expectOk(validateWorkflowDocument(result.doc));
  return result;
}
function start(doc = fixture()) {
  return reduce(doc, { kind: "started", baselineRevision: 0 });
}
function publish(
  doc: WorkflowDocumentV2,
  taskId: string,
  dependencies: { artifactId: string; revision: number }[] = [],
) {
  return expectOk(
    publishPlanArtifact(doc, {
      eventKey: `publish-${sequence++}`,
      at: 30 + sequence,
      binding: {
        workflowId: doc.workflowId,
        taskId,
        role: "lead",
        assignmentVersion: 0,
        purpose: "planning",
      },
      artifactId: `${taskId}-plan`,
      author: { runId: taskId, profile: "lead", role: "lead" },
      reviewedDependencies: dependencies,
      plan: {
        schemaVersion: 1,
        goal: taskId,
        outOfScope: [],
        assumptions: [],
        openQuestions: [],
        tasks: [
          {
            id: "investigate",
            title: "Investigate",
            agent: "main",
            dependsOn: [],
            inputs: [],
            outputs: ["Plan"],
            acceptanceCriteria: ["Reviewed"],
            files: [],
          },
        ],
      },
      review: { summary: "Reviewed", warnings: [] },
    }),
  ).doc as WorkflowDocumentV2;
}

// Declarations and accepted publications, not notifications, determine dependency readiness.
test("Scheduler admits independent A and C, then freezes B to accepted A@1", () => {
  const original = fixture();
  const initial = start(original);
  expect(initial.intents.map((intent) => intent.operationId)).toEqual([
    "invocation:A:0",
    "invocation:C:0",
  ]);
  expect(original.scheduler).toBeUndefined();
  expect(initial.doc.tasks.B!.schedule).toMatchObject({ state: "queued", reason: "dependencies" });

  const published = publish(initial.doc, "A");
  const next = reduce(published, { kind: "published" });

  expect(next.doc.scheduler!.admissions["invocation:B:0"]).toMatchObject({
    frozenInputs: ["A-plan@1"],
    effectiveProfile: { purpose: "planning" },
  });
  expect(next.doc.tasks.B!.schedule!.state).toBe("admitting");
});

test("Six ready branches reserve five slots and initializing or cleanup handles retain capacity", () => {
  const first = start(fixture(["A", "C", "D", "E", "F", "G"]));
  expect(first.intents).toHaveLength(5);
  expect(first.doc.tasks.G!.schedule).toMatchObject({ state: "queued", reason: "capacity" });
  let doc = reduce(first.doc, { kind: "launching", operationId: "invocation:A:0" }).doc;
  doc = publish(doc, "A");
  doc = reduce(
    doc,
    { kind: "run-settled", operationId: "invocation:A:0", runId: "run-A", outcome: "completed" },
    [{ id: "run-A", operationId: "invocation:A:0", active: true }],
  ).doc;
  expect(doc.tasks.G!.schedule!.state).toBe("queued");

  const released = reduce(doc, { kind: "capacity-freed" }, [
    { id: "run-A", operationId: "invocation:A:0", active: false },
  ]);
  expect(released.doc.tasks.G!.schedule!.state).toBe("admitting");
  expect(
    Object.values(released.doc.scheduler!.admissions).filter((admission) =>
      ["reserved", "launching", "running"].includes(admission.state),
    ),
  ).toHaveLength(5);
});

test("Duplicate and late settled events never create a second operation run", () => {
  let doc = start(fixture(["A"])).doc;
  doc = reduce(doc, { kind: "launching", operationId: "invocation:A:0" }).doc;
  const event: SchedulerEvent = {
    id: "fixed-event",
    at: 3,
    invocationId: "invocation",
    kind: "run-started",
    operationId: "invocation:A:0",
    runId: "run-A",
    profiles,
  };
  const first = expectOk(schedule(doc, [], event));
  const duplicate = expectOk(schedule(first.doc, [], event));
  expect(duplicate.doc).toBe(first.doc);
  expect(duplicate.intents).toEqual([]);
  expect(
    expectError(schedule(first.doc, [], { ...event, id: "foreign-run", runId: "run-other" })).code,
  ).toBe("WORKFLOW_CONFLICT");
  doc = publish(first.doc, "A");
  doc = reduce(doc, {
    kind: "run-settled",
    operationId: "invocation:A:0",
    outcome: "completed",
  }).doc;
  const late = reduce(doc, { kind: "run-started", operationId: "invocation:A:0", runId: "late" });
  expect(late.doc.scheduler!.admissions["invocation:A:0"]!.runId).toBe("run-A");
  expect(late.intents).toEqual([]);
});

test("Upstream republication stops obsolete B before a new frozen admission", () => {
  let doc = start().doc;
  doc = reduce(publish(doc, "A"), { kind: "published" }).doc;
  doc = reduce(doc, { kind: "launching", operationId: "invocation:B:0" }).doc;
  doc = reduce(doc, { kind: "run-started", operationId: "invocation:B:0", runId: "run-B" }).doc;
  const changed = reduce(publish(doc, "A"), { kind: "published" });
  expect(changed.intents).toContainEqual({ kind: "stop", operationId: "invocation:B:0" });
  expect(changed.doc.scheduler!.admissions["invocation:B:1"]).toBeUndefined();
  const refreshed = reduce(changed.doc, {
    kind: "run-settled",
    operationId: "invocation:B:0",
    outcome: "interrupted",
  });
  expect(refreshed.doc.scheduler!.admissions["invocation:B:1"]!.frozenInputs).toEqual(["A-plan@2"]);
  expect(refreshed.doc.scheduler!.invocations[0]!.invalidations).toEqual({ B: 1 });
});

test("Questions block their run while independent branches continue; cancellation retains artifacts", () => {
  let doc = start().doc;
  doc = reduce(doc, { kind: "launching", operationId: "invocation:A:0" }).doc;
  doc = reduce(doc, { kind: "run-started", operationId: "invocation:A:0", runId: "run-A" }).doc;
  doc = reduce(doc, {
    kind: "question-opened",
    operationId: "invocation:A:0",
    questionId: "question",
  }).doc;
  expect(doc.tasks.A!.schedule!.state).toBe("awaiting-answer");
  expect(doc.tasks.C!.schedule!.state).toBe("admitting");
  doc = reduce(doc, {
    kind: "question-answered",
    operationId: "invocation:A:0",
    questionId: "question",
  }).doc;
  expect(doc.tasks.A!.schedule!.state).toBe("running");
  doc = publish(doc, "C");
  const cancelled = reduce(doc, { kind: "cancelled" });
  expect(cancelled.doc.tasks.A!.schedule!.state).toBe("running");
  expect(cancelled.intents.every((intent) => intent.kind === "stop")).toBe(true);
  const uncertain = reduce(cancelled.doc, {
    kind: "cleanup-uncertain",
    operationId: "invocation:A:0",
  });
  expect(uncertain.doc.tasks.A!.schedule).toMatchObject({
    state: "running",
    reason: "cleanup-uncertain",
  });
  const settled = reduce(uncertain.doc, {
    kind: "run-settled",
    operationId: "invocation:A:0",
    outcome: "cancelled",
  });
  expect(settled.doc.tasks.A!.schedule!.state).toBe("cancelled");
  expect(settled.doc.artifacts).toEqual(cancelled.doc.artifacts);
  expect(reduce(settled.doc, { kind: "resumed" }).doc.scheduler!.invocations[0]!.state).toBe(
    "cancelled",
  );
});

test("Restart interrupts active admissions without replay; a new invocation creates a separate schedule", () => {
  const first = start(fixture(["A"]));
  const restarted = reduce(first.doc, { kind: "restarted" });
  expect(restarted.intents).toEqual([]);
  expect(restarted.doc.tasks.A!.schedule!.state).toBe("interrupted");
  expect(restarted.doc.scheduler!.admissions["invocation:A:0"]!.state).toBe("interrupted");
  const cancelled = reduce(restarted.doc, { kind: "cancelled" });
  const next = reduce(cancelled.doc, {
    kind: "started",
    invocationId: "new-invocation",
    baselineRevision: cancelled.doc.revision,
  });
  expect(next.doc.tasks.A!.schedule).toMatchObject({
    state: "queued",
    invocationId: "new-invocation",
  });
  expect(next.doc.scheduler!.invocations[0]!.schedules!.A!.state).toBe("cancelled");
  expect(expectError(canTransition("cancelled", "queued", "resume")).code).toBe(
    "WORKFLOW_TRANSITION_INVALID",
  );
  expectOk(canCreateSchedule("queued", "dependencies"));
  expect(expectError(canCreateSchedule("running", "capacity")).code).toBe(
    "WORKFLOW_TRANSITION_INVALID",
  );
});

test("Planning rejects implementation admissions and malformed strict snapshots", () => {
  const implementation = fixture(["A"]);
  implementation.tasks.A!.kind = "implement";
  expect(
    expectError(
      schedule(implementation, [], {
        kind: "started",
        baselineRevision: 0,
        invocationId: "invocation",
        id: "start",
        at: 1,
        profiles,
      }),
    ).code,
  ).toBe("WORKFLOW_NOT_AUTHORIZED");
  const malformed = start(fixture(["A"])).doc;
  malformed.scheduler!.admissions["invocation:A:0"]!.role = "implementer";
  expect(
    expectError(
      schedule(malformed, [], {
        kind: "capacity-freed",
        invocationId: "invocation",
        id: "tick",
        at: 1,
      }),
    ).code,
  ).toBe("WORKFLOW_NOT_AUTHORIZED");
  const strict = reduce(fixture(["A"]), {
    kind: "started",
    baselineRevision: 0,
    profiles: { lead: { ...profiles.lead, extra: true } },
  } as unknown as SchedulerEvent);
  expect(strict.doc.tasks.A!.schedule!.reason).toBe("profile-unavailable");
});

test("Three dependency invalidations block the invocation without resetting repair facts", () => {
  let doc = start().doc;
  doc.defects.safety = {
    id: "safety",
    responsibleTasks: ["B"],
    discoveredAt: { eventKey: "finding", revision: 0 },
    summary: "Permanent repair lock",
    evidence: "Prior QA",
    automatedFailures: 3,
    locked: true,
    state: "analysis-pending",
    attempts: [],
    analyses: {},
  };
  const repairFacts = structuredClone(doc.defects);
  doc = reduce(publish(doc, "A"), { kind: "published" }).doc;
  for (let revision = 1; revision <= 3; revision++) {
    const operationId = `invocation:B:${revision - 1}`;
    doc = reduce(doc, { kind: "launching", operationId }).doc;
    doc = reduce(doc, { kind: "run-started", operationId, runId: `B-${revision}` }).doc;
    doc = reduce(publish(doc, "A"), { kind: "published" }).doc;
    doc = reduce(doc, { kind: "run-settled", operationId, outcome: "interrupted" }).doc;
  }
  expect(doc.tasks.B!.schedule).toMatchObject({ state: "blocked", reason: "invalidation-limit" });
  expect(doc.scheduler!.invocations[0]!.invalidations!.B).toBe(3);
  expect(doc.scheduler!.admissions["invocation:B:3"]).toBeUndefined();
  expect(doc.defects).toEqual(repairFacts);
});

test("Settling without publication blocks instead of automatically relaunching", () => {
  let doc = start(fixture(["A"])).doc;
  doc = reduce(doc, { kind: "launching", operationId: "invocation:A:0" }).doc;
  const settled = reduce(doc, {
    kind: "run-settled",
    operationId: "invocation:A:0",
    outcome: "completed",
  });
  expect(settled.doc.tasks.A!.schedule).toMatchObject({
    state: "blocked",
    reason: "missing-publication",
  });
  expect(settled.intents).toEqual([]);
  expect(reduce(settled.doc, { kind: "capacity-freed" }).intents).toEqual([]);
});

test("A real launch capacity race returns the task to the queue without a failed-run retry", () => {
  let doc = start(fixture(["A"])).doc;
  doc = reduce(doc, { kind: "launching", operationId: "invocation:A:0" }).doc;
  const deferred = reduce(
    doc,
    { kind: "capacity-deferred", operationId: "invocation:A:0" },
    Array.from({ length: 5 }, (_, id) => ({ id: `investigation-${id}`, active: true })),
  );
  expect(deferred.doc.tasks.A!.schedule).toMatchObject({ state: "queued", reason: "capacity" });
  expect(deferred.doc.scheduler!.admissions["invocation:A:0"]!.state).toBe("interrupted");
  expect(deferred.intents).toEqual([]);
  expect(
    reduce(deferred.doc, { kind: "capacity-freed" }).doc.scheduler!.admissions["invocation:A:1"]!
      .state,
  ).toBe("reserved");
});

test("Resume, declaration and notifications cannot manufacture a new invocation", () => {
  for (const kind of ["resumed", "declared", "published", "capacity-freed"] as const) {
    expect(
      expectError(
        schedule(fixture(), [], { kind, id: kind, at: 1, invocationId: "forged", profiles }),
      ).code,
    ).toBe("WORKFLOW_NOT_AUTHORIZED");
  }
});

test("Default and invalid scheduler settings stay off and legacy injected instructions stay byte-identical", () => {
  expect(expectOk(workflowSchedulerEnabled({}))).toBe(false);
  expect(expectOk(workflowSchedulerEnabled({ radian: { workflowScheduler: "off" } }))).toBe(false);
  expect(expectOk(workflowSchedulerEnabled({ radian: { workflowScheduler: "on" } }))).toBe(true);
  expect(expectError(workflowSchedulerEnabled({ radian: { workflowScheduler: true } })).code).toBe(
    "WORKFLOW_CONFLICT",
  );
  expect(createHash("sha256").update(legacyPlanningInstructions).digest("hex")).toBe(
    "185b67015d0ce49b720d661c1af7f048db4bfb00530b52f3af96b070d047acc0",
  );
});
