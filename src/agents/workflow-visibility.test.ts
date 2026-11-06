import { expect, test } from "bun:test";
import { demoWorkspace } from "../workspace/demo.ts";
import { monitoredSessions } from "./session-monitor.ts";
import { workflowSummary } from "./workflow-command.ts";
import { createWorkflowDocument } from "./task-workflow.ts";
import { migrateWorkflowToV2 } from "./task-workflow-store.ts";

test("paused workflows remain searchable in the list-only session monitor without model activity", () => {
  const repositories = demoWorkspace().map((repository) => ({
    ...repository,
    worktrees: repository.worktrees.map((tree) => ({
      ...tree,
      sessions: [] as {
        id: string;
        name: string;
        status: "complete";
        subagents: [];
        workflow: string;
      }[],
    })),
  }));
  repositories[0]!.worktrees[0]!.sessions.push({
    id: "paused",
    name: "Feature work",
    status: "complete",
    subagents: [],
    workflow: "execute:paused queued:2",
  });
  const candidates = monitoredSessions(repositories, "execute:paused");
  expect(candidates).toHaveLength(1);
  expect(candidates[0]!.working).toBe(false);
  expect(candidates[0]!.title).toContain("execute:paused queued:2");
});

test("workflow summaries are absent for legacy or terminal state and report current schedule counts", () => {
  const original = createWorkflowDocument(
    { conversationId: "root", cwd: "/fixture", sessionFile: "/fixture/root.jsonl" },
    "11111111-1111-4111-8111-111111111111",
    0,
  );
  expect(workflowSummary(original)).toBeUndefined();
  const doc = migrateWorkflowToV2(original);
  doc.scheduler = {
    invocations: [{ id: "plan", kind: "plan", state: "paused", createdAt: 1 }],
    admissions: {},
    consents: {},
  };
  doc.tasks.A = {
    id: "A",
    title: "A",
    kind: "plan",
    scope: "Read",
    dependsOn: [],
    lead: { profile: "lead" },
    assignmentVersion: 0,
    artifactRevision: 0,
    verification: { state: "unverified" },
    status: "open",
    schedule: { invocationId: "plan", state: "queued", reason: "capacity", since: 1 },
  };
  expect(workflowSummary(doc)).toBe("plan:paused queued:1");
  doc.scheduler.invocations[0]!.state = "cancelled";
  expect(workflowSummary(doc)).toBeUndefined();
});
