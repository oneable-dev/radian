import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { InputError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });
const list = (maxLength: number, minItems = 0) =>
  Type.Array(text(maxLength), { minItems, maxItems: 128 });
const taskId = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$",
});

export const taskPlanSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    goal: text(4096),
    outOfScope: list(2048),
    assumptions: list(2048),
    openQuestions: list(2048),
    tasks: Type.Array(
      Type.Object(
        {
          id: taskId,
          title: text(256),
          agent: text(256),
          dependsOn: Type.Array(taskId, { maxItems: 128 }),
          inputs: list(2048),
          outputs: list(2048, 1),
          acceptanceCriteria: list(2048, 1),
          files: list(1024),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 128 },
    ),
  },
  { additionalProperties: false },
);

export type TaskPlan = Static<typeof taskPlanSchema>;

type PlanIssueCode =
  | "INVALID_SHAPE"
  | "DUPLICATE_TASK"
  | "DUPLICATE_DEPENDENCY"
  | "UNKNOWN_DEPENDENCY"
  | "SELF_DEPENDENCY"
  | "CYCLE";

type PlanValidationIssue = {
  readonly code: PlanIssueCode;
  readonly path: string;
  readonly message: string;
};

export class PlanValidationError extends InputError {
  constructor(readonly issues: readonly PlanValidationIssue[]) {
    super(`Invalid task plan: ${issues[0]?.message ?? "no validation issues supplied"}`);
  }
}

export function validateTaskPlan(value: unknown): Result<TaskPlan, PlanValidationError> {
  if (!Value.Check(taskPlanSchema, value)) {
    const issues: PlanValidationIssue[] = [...Value.Errors(taskPlanSchema, value)]
      .filter((failure) => failure.keyword !== "boolean")
      .flatMap((failure): PlanValidationIssue[] => {
        const properties =
          failure.keyword === "required"
            ? failure.params.requiredProperties
            : failure.keyword === "additionalProperties"
              ? failure.params.additionalProperties
              : [];
        if (!properties.length) {
          return [
            { code: "INVALID_SHAPE", path: failure.instancePath || "/", message: failure.message },
          ];
        }
        return properties.map((property) => ({
          code: "INVALID_SHAPE",
          path: `${failure.instancePath}/${property.replaceAll("~", "~0").replaceAll("/", "~1")}`,
          message: failure.message,
        }));
      });
    return err(new PlanValidationError(issues));
  }

  const plan = value;
  const issues: PlanValidationIssue[] = [];
  const taskIndexes = new Map<string, number>();
  for (const [index, task] of plan.tasks.entries()) {
    if (taskIndexes.has(task.id)) {
      issues.push({
        code: "DUPLICATE_TASK",
        path: `/tasks/${index}/id`,
        message: `Task ID ${task.id} is duplicated.`,
      });
    } else {
      taskIndexes.set(task.id, index);
    }
  }

  for (const [index, task] of plan.tasks.entries()) {
    const seen = new Set<string>();
    for (const [dependencyIndex, dependency] of task.dependsOn.entries()) {
      const path = `/tasks/${index}/dependsOn/${dependencyIndex}`;
      if (seen.has(dependency)) {
        issues.push({
          code: "DUPLICATE_DEPENDENCY",
          path,
          message: `Task ${task.id} repeats dependency ${dependency}.`,
        });
      }
      seen.add(dependency);
      if (!taskIndexes.has(dependency)) {
        issues.push({
          code: "UNKNOWN_DEPENDENCY",
          path,
          message: `Task ${task.id} references unknown dependency ${dependency}.`,
        });
      } else if (dependency === task.id) {
        issues.push({
          code: "SELF_DEPENDENCY",
          path,
          message: `Task ${task.id} cannot depend on itself.`,
        });
      }
    }
  }

  if (issues.length) {
    return err(new PlanValidationError(issues));
  }

  const visited = new Set<string>();
  const active = new Map<string, number>();
  const stack: string[] = [];
  function visit(taskId: string): void {
    active.set(taskId, stack.length);
    stack.push(taskId);
    const task = plan.tasks[taskIndexes.get(taskId)!]!;
    for (const [dependencyIndex, dependency] of task.dependsOn.entries()) {
      const cycleStart = active.get(dependency);
      if (cycleStart !== undefined) {
        issues.push({
          code: "CYCLE",
          path: `/tasks/${taskIndexes.get(taskId)}/dependsOn/${dependencyIndex}`,
          message: `Dependency cycle: ${[...stack.slice(cycleStart), dependency].join(" -> ")}.`,
        });
      } else if (!visited.has(dependency)) {
        visit(dependency);
      }
    }
    stack.pop();
    active.delete(taskId);
    visited.add(taskId);
  }

  for (const task of plan.tasks) {
    if (!visited.has(task.id)) {
      visit(task.id);
    }
  }

  return issues.length ? err(new PlanValidationError(issues)) : ok(plan);
}

function display(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function appendList(
  lines: string[],
  heading: string,
  values: readonly string[],
  indent = "",
): void {
  lines.push(`${indent}${heading}:`);
  if (!values.length) {
    lines.push(`${indent}  (none)`);
    return;
  }
  for (const value of values) {
    lines.push(`${indent}  - ${display(value)}`);
  }
}

export function renderTaskPlan(plan: TaskPlan): string {
  const lines = [`Goal: ${display(plan.goal)}`, "", "Dependency graph (prerequisite -> task):"];
  for (const task of plan.tasks) {
    if (!task.dependsOn.length) {
      lines.push(`  ${task.id} (no dependencies)`);
    }
    for (const dependency of task.dependsOn) {
      lines.push(`  ${dependency} -> ${task.id}`);
    }
  }

  lines.push("", "Tasks:");
  for (const task of plan.tasks) {
    lines.push(`  ${task.id}: ${display(task.title)} (agent: ${display(task.agent)})`);
    appendList(lines, "Inputs", task.inputs, "    ");
    appendList(lines, "Outputs", task.outputs, "    ");
    appendList(lines, "Acceptance criteria", task.acceptanceCriteria, "    ");
    appendList(lines, "Files", task.files, "    ");
  }

  lines.push("");
  appendList(lines, "Assumptions", plan.assumptions);
  appendList(lines, "Open questions", plan.openQuestions);
  appendList(lines, "Out of scope", plan.outOfScope);
  lines.push(
    "",
    "Structural validity does not establish semantic correctness, approval, or execution.",
  );
  return lines.join("\n");
}
