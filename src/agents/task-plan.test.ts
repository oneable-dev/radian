import { expect, test } from "bun:test";
import { Value } from "typebox/value";
import { InputError } from "../errors.ts";
import { expectOk } from "../testing/results.ts";
import {
  PlanValidationError,
  renderTaskPlan,
  taskPlanSchema,
  validateTaskPlan,
  type TaskPlan,
} from "./task-plan.ts";

function task(id: string, dependsOn: string[] = []): TaskPlan["tasks"][number] {
  return {
    id,
    title: `Implement ${id}`,
    agent: "implementer",
    dependsOn,
    inputs: [],
    outputs: ["Completed change"],
    acceptanceCriteria: ["Tests pass"],
    files: [],
  };
}

function plan(tasks: TaskPlan["tasks"] = [task("draft")]): TaskPlan {
  return {
    schemaVersion: 1,
    goal: "Deliver the feature",
    outOfScope: [],
    assumptions: [],
    openQuestions: [],
    tasks,
  };
}

function failure(value: unknown): PlanValidationError {
  const result = validateTaskPlan(value);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected task plan validation to fail.");
  }
  expect(result.error).toBeInstanceOf(PlanValidationError);
  expect(result.error).toBeInstanceOf(InputError);
  expect(result.error.code).toBe("INVALID_INPUT");
  return result.error;
}

test("A bounded DAG accepts empty optional lists and preserves its input", () => {
  // The first task may have no prerequisites and descriptive lists may be empty.
  const input = plan([task("2_draft"), task("review-1", ["2_draft"])]);
  const original = structuredClone(input);

  // Validation must not normalize or reorder the caller's plan.
  const result = expectOk(validateTaskPlan(input));

  // The public schema and validator agree on this shape without mutating it.
  expect(Value.Check(taskPlanSchema, result)).toBe(true);
  expect(result).toBe(input);
  expect(input).toEqual(original);
});

test.each([
  ["unsupported version", (value: TaskPlan) => ({ ...value, schemaVersion: 2 }), "/schemaVersion"],
  [
    "missing field",
    (value: TaskPlan): unknown => ({ schemaVersion: 1, tasks: value.tasks }),
    "/goal",
  ],
  ["unknown field", (value: TaskPlan) => ({ ...value, extra: true }), "/extra"],
  ["blank goal", (value: TaskPlan) => ({ ...value, goal: " \n\t " }), "/goal"],
  ["oversized goal", (value: TaskPlan) => ({ ...value, goal: "x".repeat(4097) }), "/goal"],
  ["invalid task ID", (value: TaskPlan) => ({ ...value, tasks: [task("bad.id")] }), "/tasks/0/id"],
  [
    "oversized task ID",
    (value: TaskPlan) => ({ ...value, tasks: [task("a".repeat(65))] }),
    "/tasks/0/id",
  ],
  ["empty tasks", (value: TaskPlan) => ({ ...value, tasks: [] }), "/tasks"],
  [
    "too many tasks",
    (value: TaskPlan) => ({
      ...value,
      tasks: Array.from({ length: 129 }, (_, i) => task(`t${i}`)),
    }),
    "/tasks",
  ],
  [
    "missing task field",
    (value: TaskPlan) => ({ ...value, tasks: [{ id: "draft" }] }),
    "/tasks/0/title",
  ],
  [
    "invalid dependency ID",
    (value: TaskPlan) => ({ ...value, tasks: [task("draft", ["not/valid"])] }),
    "/tasks/0/dependsOn/0",
  ],
  [
    "missing output",
    (value: TaskPlan) => ({ ...value, tasks: [{ ...task("draft"), outputs: [] }] }),
    "/tasks/0/outputs",
  ],
  [
    "missing acceptance criterion",
    (value: TaskPlan) => ({ ...value, tasks: [{ ...task("draft"), acceptanceCriteria: [] }] }),
    "/tasks/0/acceptanceCriteria",
  ],
  ["blank list entry", (value: TaskPlan) => ({ ...value, assumptions: ["  "] }), "/assumptions/0"],
  ["nonobject input", (_value: TaskPlan): unknown => null, "/"],
] as const)("%s is rejected as INVALID_SHAPE", (_name, change, path) => {
  // A malformed plan cannot be treated as a valid DAG just because its edges are sound.
  const input = change(plan());

  // Validate the untrusted value at the public boundary.
  const error = failure(input);

  // Structural failures have a stable code and point to the offending field.
  expect(error.issues).toContainEqual(expect.objectContaining({ code: "INVALID_SHAPE", path }));
});

test("Duplicate task IDs and repeated edges are reported before graph traversal", () => {
  // Duplicate identities make graph traversal ambiguous; a repeated edge is independently invalid.
  const input = plan([task("draft", ["review", "review"]), task("review"), task("review")]);
  const original = structuredClone(input);

  // Validate without changing the dependency array or task order.
  const error = failure(input);

  // Both identity and edge diagnostics retain their source positions.
  expect(error.issues).toEqual([
    { code: "DUPLICATE_TASK", path: "/tasks/2/id", message: "Task ID review is duplicated." },
    {
      code: "DUPLICATE_DEPENDENCY",
      path: "/tasks/0/dependsOn/1",
      message: "Task draft repeats dependency review.",
    },
  ]);
  expect(input).toEqual(original);
});

test("Missing and self dependencies are rejected with their edge paths", () => {
  // A prerequisite must refer to another task in the same plan.
  const input = plan([task("draft", ["absent", "draft"])]);

  // Validate each declared edge.
  const error = failure(input);

  // Distinct relationship errors are not hidden behind a generic shape error.
  expect(error.issues.map(({ code, path }) => ({ code, path }))).toEqual([
    { code: "UNKNOWN_DEPENDENCY", path: "/tasks/0/dependsOn/0" },
    { code: "SELF_DEPENDENCY", path: "/tasks/0/dependsOn/1" },
  ]);
});

test("Cycles spanning multiple tasks are rejected deterministically", () => {
  // The graph has valid identities and references but no valid execution order.
  const input = plan([
    task("draft", ["review"]),
    task("review", ["publish"]),
    task("publish", ["draft"]),
  ]);
  const original = structuredClone(input);

  // A second validation of the same input must have the same diagnostic.
  const first = failure(input);
  const second = failure(input);

  // Report the closing edge and its full cycle without changing the input.
  expect(first.issues).toEqual([
    {
      code: "CYCLE",
      path: "/tasks/2/dependsOn/0",
      message: "Dependency cycle: draft -> review -> publish -> draft.",
    },
  ]);
  expect(second.issues).toEqual(first.issues);
  expect(input).toEqual(original);
});

test("Rendering derives graph edges and includes assignments, criteria and review disclaimer", () => {
  // A dependent task must be shown as an edge from its prerequisite, not a separate graph record.
  const input = plan([
    task("draft"),
    {
      ...task("review", ["draft"]),
      title: "Review\nfeature",
      agent: "reviewer",
      inputs: ["Draft patch"],
      outputs: ["Review notes"],
      acceptanceCriteria: ["All issues resolved"],
      files: ["src/agents/task-plan.ts"],
    },
  ]);
  input.assumptions.push("Access is available");
  input.openQuestions.push("Who approves?");
  input.outOfScope.push("Deployment");
  const original = structuredClone(input);

  // Render the plan as deterministic, readable text without altering it.
  const rendered = renderTaskPlan(input);

  // The graph, task details, context and lack of approval are explicit.
  expect(rendered).toContain("Goal: Deliver the feature");
  expect(rendered).toContain("draft (no dependencies)\n  draft -> review");
  expect(rendered).toContain("review: Review feature (agent: reviewer)");
  expect(rendered).toContain("Inputs:\n      - Draft patch");
  expect(rendered).toContain("Outputs:\n      - Review notes");
  expect(rendered).toContain("Acceptance criteria:\n      - All issues resolved");
  expect(rendered).toContain("Files:\n      - src/agents/task-plan.ts");
  expect(rendered).toContain("Assumptions:\n  - Access is available");
  expect(rendered).toContain("Open questions:\n  - Who approves?");
  expect(rendered).toContain("Out of scope:\n  - Deployment");
  expect(rendered).toContain(
    "Structural validity does not establish semantic correctness, approval, or execution.",
  );
  expect(renderTaskPlan(input)).toBe(rendered);
  expect(input).toEqual(original);
});
