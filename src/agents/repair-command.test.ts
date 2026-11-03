import { expect, test } from "bun:test";
import { expectError, expectOk } from "../testing/results.ts";
import {
  parseRepairCommand,
  repairCommand,
  renderRepairStatus,
  resolveRepairId,
} from "./repair-command.ts";
import { createWorkflowDocument } from "./task-workflow.ts";

test.each([
  ["/repair", { kind: "status" }],
  ["/repair status", { kind: "status" }],
  ["/repair status task-one", { kind: "status", id: "task-one" }],
  ["/repair recheck task-one", { kind: "recheck", id: "task-one" }],
  ["/repair cancel defect-one", { kind: "cancel", id: "defect-one" }],
  [
    "/repair continue 11111111-1111-4111-8111-111111111111",
    { kind: "continue", workflowId: "11111111-1111-4111-8111-111111111111" },
  ],
] as const)("Q14 reserved command %s parses without model dispatch", (input, expected) => {
  // Only exact reserved command syntax should reach the host workflow handler.
  const result = parseRepairCommand(input);

  expect(expectOk(result)).toEqual(expected);
});

test.each([
  "/repair recheck",
  "/repair cancel",
  "/repair continue invalid",
  "/repair reset",
  "/repair status one two",
])("Q14 invalid reserved syntax %s reports usage", (input) => {
  // Invalid reserved commands remain host errors instead of becoming model prompts.
  const result = parseRepairCommand(input);

  expect(expectError(result).code).toBe("INVALID_INPUT");
});

test("Q14 unrelated slash names and ordinary text are not repair commands", () => {
  // Prefix matching must not reserve arbitrary similarly named extension commands.
  const results = ["/repairing", "please /repair", "ordinary text"].map(parseRepairCommand);

  expect(results.map(expectOk)).toEqual([null, null, null]);
  expect(repairCommand.value).toBe("repair");
});

test("Q14 repair IDs accept exact IDs or unambiguous prefixes of at least six characters", () => {
  // IDs may be short in full, but shorthand must be long enough and unique.
  const doc = createWorkflowDocument(
    { conversationId: "origin", cwd: "/work", sessionFile: "/work/session" },
    "11111111-1111-4111-8111-111111111111",
    0,
  );
  const base = {
    title: "Task",
    kind: "implement" as const,
    scope: "Owned",
    dependsOn: [],
    lead: { profile: "lead" },
    assignmentVersion: 0,
    artifactRevision: 0,
    verification: { state: "unverified" as const },
    status: "open" as const,
  };
  for (const id of ["task-alpha", "task-alpine", "tiny"]) doc.tasks[id] = { ...base, id };

  const unique = resolveRepairId(doc, "task-alph");
  const ambiguous = resolveRepairId(doc, "task-al");
  const tooShort = resolveRepairId(doc, "task-");

  expect(expectOk(unique)).toBe("task-alpha");
  expect(expectOk(resolveRepairId(doc, "tiny"))).toBe("tiny");
  expect(expectError(ambiguous).code).toBe("WORKFLOW_CONFLICT");
  expect(expectError(tooShort).code).toBe("WORKFLOW_NOT_FOUND");
});

test("Q18 compact task status links each human-owned defect without expanding its evidence", () => {
  // Humans can discover all handoffs from task status without flooding ordinary status output.
  const doc = createWorkflowDocument(
    { conversationId: "origin", cwd: "/work", sessionFile: "/work/session" },
    "11111111-1111-4111-8111-111111111111",
    0,
  );
  doc.tasks["task-one"] = {
    id: "task-one",
    title: "Task",
    kind: "implement",
    scope: "Owned",
    dependsOn: [],
    lead: { profile: "lead" },
    assignmentVersion: 0,
    artifactRevision: 3,
    verification: { state: "failed", revision: 3 },
    status: "human-required",
  };
  for (const [id, state] of [
    ["defect-analysis", "analysis-pending"],
    ["defect-human", "human-required"],
  ] as const)
    doc.defects[id] = {
      id,
      state,
      responsibleTasks: ["task-one"],
      discoveredAt: { eventKey: "finding", revision: 0 },
      summary: "Failure",
      evidence: "e".repeat(1000) + "Detailed evidence tail",
      automatedFailures: 3,
      locked: true,
      attempts: [],
      analyses: {},
    };

  const status = expectOk(renderRepairStatus(doc, "task-one"));

  expect(status).toContain("handoff: /repair status defect-analysis");
  expect(status).toContain("handoff: /repair status defect-human");
  expect(status).not.toContain("Detailed evidence tail");
  expect(status.length).toBeLessThan(16000);
});

test("Q18 full defect handoff is bounded at 60000 with an explicit durable-evidence pointer", () => {
  // Oversized evidence must remain bounded without silently presenting a partial package as complete.
  const doc = createWorkflowDocument(
    { conversationId: "origin", cwd: "/work", sessionFile: "/work/session" },
    "11111111-1111-4111-8111-111111111111",
    0,
  );
  doc.tasks["task-one"] = {
    id: "task-one",
    title: "Task",
    kind: "implement",
    scope: "Owned",
    dependsOn: [],
    lead: { profile: "lead" },
    assignmentVersion: 0,
    artifactRevision: 3,
    verification: { state: "failed", revision: 3 },
    status: "human-required",
  };
  doc.defects["defect-large"] = {
    id: "defect-large",
    state: "human-required",
    responsibleTasks: ["task-one"],
    discoveredAt: { eventKey: "finding", revision: 0 },
    summary: "Failure",
    evidence: "e".repeat(65536),
    automatedFailures: 3,
    locked: true,
    attempts: [],
    analyses: {},
  };

  const status = expectOk(renderRepairStatus(doc, "defect-large"));

  expect(status.length).toBeLessThanOrEqual(60000);
  expect(status).toContain("[Truncated; complete durable evidence: /work/session.workflow.json]");
});
