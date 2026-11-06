import { expect } from "bun:test";
import { migrateWorkflowToV2 } from "../agents/task-workflow-store.ts";
import { validateWorkflowDocument, type WorkflowDocument } from "../agents/task-workflow.ts";
import { expectOk } from "./results.ts";

/** Compare every durable field, not only selected counters, on existing v1 fixtures. */
export function expectWorkflowMigrationRoundTrip(doc: WorkflowDocument): void {
  const before = structuredClone(doc);
  const migrated = migrateWorkflowToV2(doc);
  const reopened = expectOk(validateWorkflowDocument(JSON.parse(JSON.stringify(migrated))));

  expect(reopened).toEqual({ ...before, version: 2 });
  expect(doc).toEqual(before);
  expect(migrateWorkflowToV2(migrated)).toEqual(migrated);
}
