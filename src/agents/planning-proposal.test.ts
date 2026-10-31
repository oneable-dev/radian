import { expect, test } from "bun:test";
import { validatePlanningProposal } from "./planning-proposal.ts";
import { expectError, expectOk } from "../testing/results.ts";
import type { TaskPlan } from "./task-plan.ts";

function proposal() {
  const plan: TaskPlan = {
    schemaVersion: 1,
    goal: "A complete proposal",
    outOfScope: [],
    assumptions: [],
    openQuestions: [],
    tasks: [
      {
        id: "inspect",
        title: "Inspect requirements",
        agent: "main",
        dependsOn: [],
        inputs: [],
        outputs: ["Contract"],
        acceptanceCriteria: ["Coverage reviewed"],
        files: [],
      },
    ],
  };
  return { plan, review: { summary: "Reviewed dependencies and coverage", warnings: [] } };
}

test("Complete proposals larger than the status display limit are preserved", () => {
  // Long valid graphs must travel through the structured channel without truncation.
  const value = proposal();
  value.plan.tasks = Array.from({ length: 50 }, (_, i) => ({
    ...value.plan.tasks[0]!,
    id: `task${i}`,
    outputs: ["x".repeat(512)],
  }));
  expect(JSON.stringify(value).length).toBeGreaterThan(16384);
  expect(expectOk(validatePlanningProposal(value))).toEqual(value);
});

test.each(["cycle", "dangling"])(
  "Structurally invalid %s graphs cannot become proposals",
  (kind) => {
    // The shared graph validator remains authoritative even before parent persistence.
    const value = proposal();
    value.plan.tasks[0]!.dependsOn = [kind === "cycle" ? "inspect" : "missing"];
    expect(expectError(validatePlanningProposal(value)).code).toBe("INVALID_INPUT");
  },
);

test("Oversized and incomplete results are explicit errors rather than partial plans", () => {
  // A bounded full proposal is safer than accepting a sliced status transcript.
  const value = proposal();
  value.plan.tasks = Array.from({ length: 100 }, (_, i) => ({
    ...value.plan.tasks[0]!,
    id: `task${i}`,
    outputs: Array(64).fill("x".repeat(200)),
  }));
  expect(expectError(validatePlanningProposal(value)).message).toContain("size limit");
  expect(expectError(validatePlanningProposal({ plan: proposal().plan })).code).toBe(
    "INVALID_INPUT",
  );
});
