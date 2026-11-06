import { expect, test } from "bun:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { expectError, expectOk } from "../testing/results.ts";
import { ok } from "../result.ts";
import { taskProtocol, taskTool } from "./task-tool.ts";
import { splitTask, continueTask } from "./verification-policy.ts";
import {
  effectiveProfileSnapshotSchema,
  resolveEffectiveProfile,
  strictEffectiveProfileSnapshotSchema,
} from "./effective-profile.ts";
import {
  createWorkflowDocument,
  validateWorkflowDocument,
  workflowAdmissionStateSchema,
  workflowScheduleStateSchema,
  type WorkflowAdmissionState,
  type WorkflowDocumentV2,
  type WorkflowScheduleState,
} from "./task-workflow.ts";
import { migrateWorkflowToV2 } from "./task-workflow-store.ts";
import {
  canTransition,
  canTransitionAdmission,
  type WorkflowTransitionCause,
} from "./workflow-schedule-state.ts";

const scheduleStates: WorkflowScheduleState[] = [
  "queued",
  "admitting",
  "running",
  "awaiting-answer",
  "blocked",
  "paused",
  "interrupted",
  "cancelled",
  "ready-for-review",
];

const allowed: [WorkflowScheduleState, WorkflowScheduleState, WorkflowTransitionCause][] = [
  ["queued", "admitting", "admit"],
  ["queued", "blocked", "block"],
  ["queued", "paused", "pause"],
  ["queued", "cancelled", "cancel"],
  ["admitting", "running", "launch"],
  ["admitting", "queued", "retry"],
  ["admitting", "blocked", "block"],
  ["admitting", "paused", "pause"],
  ["admitting", "interrupted", "restart"],
  ["admitting", "cancelled", "cancel"],
  ["running", "awaiting-answer", "ask"],
  ["running", "blocked", "block"],
  ["running", "paused", "pause"],
  ["running", "interrupted", "restart"],
  ["running", "ready-for-review", "complete"],
  ["running", "cancelled", "cancel"],
  ["awaiting-answer", "running", "answer"],
  ["awaiting-answer", "blocked", "block"],
  ["awaiting-answer", "paused", "pause"],
  ["awaiting-answer", "interrupted", "restart"],
  ["awaiting-answer", "cancelled", "cancel"],
  ["blocked", "queued", "unblock"],
  ["blocked", "paused", "pause"],
  ["blocked", "cancelled", "cancel"],
  ["paused", "queued", "resume"],
  ["paused", "admitting", "resume"],
  ["paused", "cancelled", "cancel"],
  ["interrupted", "queued", "resume"],
  ["interrupted", "admitting", "resume"],
  ["interrupted", "running", "resume"],
  ["interrupted", "cancelled", "cancel"],
  ["ready-for-review", "queued", "schedule"],
  ["ready-for-review", "paused", "pause"],
  ["ready-for-review", "cancelled", "cancel"],
];

const causes: WorkflowTransitionCause[] = [
  "admit",
  "launch",
  "retry",
  "ask",
  "answer",
  "block",
  "unblock",
  "pause",
  "resume",
  "restart",
  "cancel",
  "complete",
  "schedule",
];

test.each(allowed)("Schedule %s -> %s requires %s", (from, to, cause) => {
  // A destination alone never grants resume or restart authority.
  expectOk(canTransition(from, to, cause));
  for (const wrong of causes.filter((value) => value !== cause))
    expect(expectError(canTransition(from, to, wrong)).code).toBe("WORKFLOW_TRANSITION_INVALID");
});

test("Unlisted schedule edges, including cancelled revival and self-transitions, are rejected", () => {
  // Check negative edges independently of the production transition table.
  for (const from of scheduleStates) {
    for (const to of scheduleStates) {
      if (allowed.some(([a, b]) => a === from && b === to)) continue;
      for (const cause of causes)
        expect(expectError(canTransition(from, to, cause)).code).toBe(
          "WORKFLOW_TRANSITION_INVALID",
        );
    }
  }
});

test("Admission resume requires a new operation and terminal states never revive", () => {
  const states: WorkflowAdmissionState[] = [
    "reserved",
    "launching",
    "running",
    "completed",
    "interrupted",
    "cancelled",
    "failed",
  ];
  const edges = new Set([
    "reserved:launching",
    "reserved:interrupted",
    "reserved:cancelled",
    "launching:running",
    "launching:interrupted",
    "launching:cancelled",
    "launching:failed",
    "running:completed",
    "running:interrupted",
    "running:cancelled",
    "running:failed",
  ]);

  for (const from of states) {
    for (const to of states) {
      const result = canTransitionAdmission(from, to);
      if (edges.has(`${from}:${to}`)) expectOk(result);
      else expect(expectError(result).code).toBe("WORKFLOW_TRANSITION_INVALID");
    }
  }
  expect(workflowAdmissionStateSchema.enum).toEqual(states);
});

function schedulerFixture(): WorkflowDocumentV2 {
  const doc = migrateWorkflowToV2(
    createWorkflowDocument(
      {
        conversationId: "origin",
        cwd: "/fixture",
        sessionFile: "/fixture/origin.jsonl",
      },
      "11111111-1111-4111-8111-111111111111",
      0,
    ),
  );
  doc.tasks.branch = {
    id: "branch",
    title: "Plan",
    kind: "plan",
    scope: "Read only",
    dependsOn: [],
    lead: { profile: "tech-lead" },
    assignmentVersion: 0,
    artifactRevision: 0,
    verification: { state: "unverified" },
    status: "open",
    schedule: { state: "queued", reason: "dependencies", since: 10 },
  };
  doc.scheduler = {
    invocations: [{ id: "invocation", kind: "plan", state: "active", createdAt: 10 }],
    admissions: {
      operation: {
        taskId: "branch",
        role: "lead",
        assignmentVersion: 0,
        frozenInputs: ["upstream@1"],
        effectiveProfile: expectOk(
          resolveEffectiveProfile("tech-lead", {
            overlays: [],
            projectTrusted: false,
            purpose: "planning",
          }),
        ).effectiveProfile,
        state: "reserved",
      },
    },
    consents: {},
  };
  return doc;
}

test.each(["continue", "split"] as const)(
  "Model %s input cannot forge host-owned schedule state",
  async (action) => {
    const task = schedulerFixture().tasks.branch!;
    const raw = { action, taskId: "branch", task: { ...task, id: "new-task" } };
    const validation = taskProtocol.validateAction(raw);
    expect(expectError(validation).code).toBe("TOOL_ACTION_FIELDS");
    if (validation.ok) throw new Error("Expected schedule input rejection");
    expect(validation.error.paths).toEqual(["/task/schedule"]);
    expect(() => taskProtocol.prepareArguments(raw)).toThrow("TOOL_ACTION_FIELDS");
    let handlerCalls = 0;
    const tool = taskTool(async () => {
      handlerCalls++;
      return ok("Unexpected execution");
    });
    await expect(
      tool.execute("call", raw, undefined, undefined, {} as ExtensionToolContext),
    ).rejects.toMatchObject({
      code: "TOOL_ACTION_FIELDS",
      paths: ["/task/schedule"],
    });
    expect(handlerCalls).toBe(0);
  },
);

test.each([splitTask, continueTask])(
  "Linked tasks never inherit the source task's schedule",
  (link) => {
    // Even a trusted host caller copying a whole stored task cannot copy its admission state.
    const doc = schedulerFixture();
    const copiedTask = { ...structuredClone(doc.tasks.branch!), id: "new-task" };

    const result = expectOk(
      link(doc, {
        eventKey: "link",
        at: 20,
        taskId: "branch",
        task: copiedTask,
      }),
    ).doc;

    expect(result.tasks["new-task"]).not.toHaveProperty("schedule");
    expect(result.tasks.branch).toEqual(doc.tasks.branch);
    expect(copiedTask.schedule).toEqual(doc.tasks.branch!.schedule);
    expectOk(validateWorkflowDocument(result));
  },
);

test("v2 scheduler round-trips the exact state enum and queued reasons without changing v1", () => {
  const doc = schedulerFixture();
  for (const state of scheduleStates) {
    doc.tasks.branch!.schedule = {
      state,
      since: 10,
      ...(state === "queued" ? { reason: "capacity" } : {}),
    };
    expect(expectOk(validateWorkflowDocument(JSON.parse(JSON.stringify(doc))))).toEqual(doc);
  }
  for (const reason of ["dependencies", "capacity", "worktree"]) {
    doc.tasks.branch!.schedule = { state: "queued", reason, since: 10 };
    expectOk(validateWorkflowDocument(doc));
  }
  expect(workflowScheduleStateSchema.enum).toEqual(scheduleStates);
  expect(expectError(validateWorkflowDocument({ ...doc, version: 1 })).code).toBe(
    "WORKFLOW_CONFLICT",
  );
});

test.each([
  [
    "scheduler extra",
    (doc: WorkflowDocumentV2) => ({ ...doc, scheduler: { ...doc.scheduler, extra: true } }),
  ],
  [
    "invocation extra",
    (doc: WorkflowDocumentV2) => ({
      ...doc,
      scheduler: {
        ...doc.scheduler,
        invocations: [{ ...doc.scheduler!.invocations[0], extra: true }],
      },
    }),
  ],
  [
    "admission extra",
    (doc: WorkflowDocumentV2) => ({
      ...doc,
      scheduler: {
        ...doc.scheduler,
        admissions: { operation: { ...doc.scheduler!.admissions.operation, extra: true } },
      },
    }),
  ],
  [
    "invalid input ref",
    (doc: WorkflowDocumentV2) => ({
      ...doc,
      scheduler: {
        ...doc.scheduler,
        admissions: {
          operation: { ...doc.scheduler!.admissions.operation, frozenInputs: ["upstream"] },
        },
      },
    }),
  ],
  [
    "consent not yet supported",
    (doc: WorkflowDocumentV2) => ({
      ...doc,
      scheduler: { ...doc.scheduler, consents: { untrusted: {} } },
    }),
  ],
  [
    "schedule extra",
    (doc: WorkflowDocumentV2) => ({
      ...doc,
      tasks: {
        branch: { ...doc.tasks.branch, schedule: { state: "running", since: 10, extra: true } },
      },
    }),
  ],
  [
    "unknown schedule state",
    (doc: WorkflowDocumentV2) => ({
      ...doc,
      tasks: { branch: { ...doc.tasks.branch, schedule: { state: "queued-capacity", since: 10 } } },
    }),
  ],
  [
    "missing queued reason",
    (doc: WorkflowDocumentV2) => ({
      ...doc,
      tasks: { branch: { ...doc.tasks.branch, schedule: { state: "queued", since: 10 } } },
    }),
  ],
  [
    "unknown queued reason",
    (doc: WorkflowDocumentV2) => ({
      ...doc,
      tasks: {
        branch: {
          ...doc.tasks.branch,
          schedule: { state: "queued", reason: "unknown", since: 10 },
        },
      },
    }),
  ],
] as const)("v2 fails closed for %s", (_name, corrupt) => {
  const doc = schedulerFixture();
  expect(expectError(validateWorkflowDocument(corrupt(doc))).code).toBe("WORKFLOW_CONFLICT");
});

test.each(["snapshot", "overlay", "skill", "delegation"] as const)(
  "Durable %s snapshot is strict while legacy run records stay lenient",
  (target) => {
    const snapshot = {
      ...schedulerFixture().scheduler!.admissions.operation!.effectiveProfile,
      overlays: [{ path: "/fixture/overlay", hash: "hash", source: "personal" }],
      skills: [{ name: "code" }],
      delegation: { enabled: false },
    };
    const extra = { unexpected: true };
    const corrupt = {
      ...snapshot,
      ...(target === "snapshot" ? extra : {}),
      ...(target === "overlay" ? { overlays: [{ ...snapshot.overlays[0], ...extra }] } : {}),
      ...(target === "skill" ? { skills: [{ ...snapshot.skills[0], ...extra }] } : {}),
      ...(target === "delegation" ? { delegation: { ...snapshot.delegation, ...extra } } : {}),
    };

    expect(Value.Check(effectiveProfileSnapshotSchema, corrupt)).toBe(true);
    expect(Value.Check(strictEffectiveProfileSnapshotSchema, corrupt)).toBe(false);
    expect(Value.Check(strictEffectiveProfileSnapshotSchema, snapshot)).toBe(true);
  },
);
