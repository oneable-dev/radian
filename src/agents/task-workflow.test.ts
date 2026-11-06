import { expect, test } from "bun:test";
import { expectError, expectOk } from "../testing/results.ts";
import { expectWorkflowMigrationRoundTrip } from "../testing/workflow-migration.ts";
import {
  createWorkflowDocument,
  MAX_PROCESSED_EVENTS,
  validateWorkflowDocument,
} from "./task-workflow.ts";
import { declareScope, recordFinding } from "./verification-policy.ts";

const origin = {
  conversationId: "origin",
  cwd: "/work",
  sessionFile: "/work/origin.jsonl",
};
const workflowId = "11111111-1111-4111-8111-111111111111";

test("Q08 workflow schema rejects unknown versions and incomplete safety records", () => {
  // Only a complete supported document may become canonical state.
  const doc = createWorkflowDocument(origin, workflowId, 0);

  const valid = validateWorkflowDocument(doc);
  const unknown = validateWorkflowDocument({ ...doc, version: 3 });
  const incomplete = validateWorkflowDocument({ ...doc, processed: undefined });
  const noOrigin = validateWorkflowDocument({ ...doc, members: [] });

  expect(expectOk(valid)).toEqual(doc);
  expectWorkflowMigrationRoundTrip(doc);
  for (const result of [unknown, incomplete, noOrigin])
    expect(expectError(result).code).toBe("WORKFLOW_CONFLICT");
});

test("Q14 optional resolution receipts validate task responsibility without breaking older documents", () => {
  // Version-one documents without either optional extension remain readable.
  let doc = expectOk(
    declareScope(createWorkflowDocument(origin, workflowId, 0), {
      eventKey: "scope",
      at: 1,
      goal: "Scoped QA",
      knownProfiles: ["lead"],
      branches: [
        {
          id: "branch",
          title: "Branch",
          scope: "Files",
          dependsOn: [],
          lead: { profile: "lead" },
        },
      ],
    }),
  ).doc;
  doc.tasks.branch!.verifier = { profile: "qa" };
  doc = expectOk(
    recordFinding(doc, {
      eventKey: "finding",
      at: 2,
      binding: {
        workflowId,
        taskId: "branch",
        role: "verifier",
        assignmentVersion: 0,
      },
      defectId: "defect",
      revision: 0,
      summary: "Issue",
      evidence: "QA log",
    }),
  ).doc;
  delete doc.manifest!.declaredAt;
  expect(expectOk(validateWorkflowDocument(doc))).toEqual(doc);
  expectWorkflowMigrationRoundTrip(doc);

  // Receipt keys must belong to this defect, and declaration timestamps must be integers.
  doc.defects.defect!.resolutions = {
    branch: { revision: 0, eventKey: "passed", at: 3 },
  };
  expect(expectOk(validateWorkflowDocument(doc))).toEqual(doc);
  expectWorkflowMigrationRoundTrip(doc);
  doc.defects.defect!.resolutions.other = {
    revision: 0,
    eventKey: "forged",
    at: 3,
  };
  expect(expectError(validateWorkflowDocument(doc)).code).toBe("WORKFLOW_CONFLICT");
  delete doc.defects.defect!.resolutions.other;
  doc.manifest!.declaredAt = 1.5;
  expect(expectError(validateWorkflowDocument(doc)).code).toBe("WORKFLOW_CONFLICT");
});

test("Q08 planning correlation metadata is optional in version one and revisions must be integers", () => {
  // Old workflow documents remain readable without gaining fabricated correlation receipts.
  const doc = createWorkflowDocument(origin, workflowId, 0);
  doc.manifest = { goal: "Legacy", updatedAt: 0, diagnostics: [] };
  doc.artifacts.plan = {
    taskId: "branch",
    revisions: [
      {
        revision: 1,
        author: { runId: "run", profile: "lead", role: "lead" },
        publishedAt: 0,
        summary: "Legacy",
        body: {},
      },
    ],
  };
  expect(expectOk(validateWorkflowDocument(doc))).toEqual(doc);

  expectWorkflowMigrationRoundTrip(doc);

  // Metadata extends the existing schema without changing the document version.
  doc.manifest.declaredRevision = 1;
  doc.manifest.branches = ["branch"];
  doc.artifacts.plan.revisions[0]!.docRevision = 2;
  doc.artifacts.plan.revisions[0]!.dependencies = [{ artifactId: "upstream", revision: 1 }];
  expect(expectOk(validateWorkflowDocument(doc))).toEqual(doc);
  expectWorkflowMigrationRoundTrip(doc);
  doc.artifacts.plan.revisions[0]!.docRevision = 1.5;
  expect(expectError(validateWorkflowDocument(doc)).code).toBe("WORKFLOW_CONFLICT");
  doc.artifacts.plan.revisions[0]!.docRevision = 2;
  doc.manifest.declaredRevision = -1;
  expect(expectError(validateWorkflowDocument(doc)).code).toBe("WORKFLOW_CONFLICT");
});

test("Q06 informational logs are bounded without evicting processed safety receipts", () => {
  // Log eviction must never grant an old event permission to execute again.
  const doc = createWorkflowDocument(origin, workflowId, 0);
  doc.processed["old-event"] = { docRevision: 0, outcome: { kind: "applied" } };
  doc.log = Array.from({ length: 256 }, (_, index) => ({
    at: index,
    eventKey: `old-${index}`,
    message: "Informational",
  }));

  const result = expectOk(
    declareScope(doc, {
      eventKey: "new-event",
      at: 1000,
      goal: "Bounded log",
      branches: [],
      knownProfiles: [],
    }),
  ).doc;

  expect(result.log).toHaveLength(256);
  expect(result.log[0]!.eventKey).toBe("old-1");
  expect(Object.keys(result.processed)).toEqual(["old-event", "new-event"]);
  expectWorkflowMigrationRoundTrip(result);
});

test("Q06 reaching the safety ledger cap fails closed instead of resetting receipts", () => {
  // A hard limit is an admission refusal, never a reason to forget safety facts.
  const doc = createWorkflowDocument(origin, workflowId, 0);
  for (let index = 0; index < MAX_PROCESSED_EVENTS; index++)
    doc.processed[`event-${index}`] = {
      docRevision: 0,
      outcome: { kind: "applied" },
    };

  expectWorkflowMigrationRoundTrip(doc);

  const result = declareScope(doc, {
    eventKey: "overflow",
    at: 1000,
    goal: "Must not commit",
    branches: [],
    knownProfiles: [],
  });

  expect(expectError(result).code).toBe("WORKFLOW_CONFLICT");
  expect(doc.revision).toBe(0);
  expect(doc.manifest).toBeNull();
  expect(Object.keys(doc.processed)).toHaveLength(MAX_PROCESSED_EVENTS);
});
