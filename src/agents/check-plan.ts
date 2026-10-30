import { readFile } from "node:fs/promises";
import { capture, InputError, parseJson, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { parseStoredTaskPlan } from "./task-plan-store.ts";
import {
  PlanValidationError,
  renderTaskPlan,
  validateTaskPlan,
  type TaskPlan,
} from "./task-plan.ts";

/** Validate raw plan JSON or a /plan export without running its acceptance commands. */
export async function checkPlanFile(path: string): Promise<Result<TaskPlan, ExpectedError>> {
  const read = await capture(() => readFile(path, "utf8"));
  if (!read.ok) return read;
  const parsed = parseJson(read.value, "task plan");
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (value !== null && typeof value === "object" && "plan" in value) {
    if (
      !("owner" in value) ||
      value.owner === null ||
      typeof value.owner !== "object" ||
      !("conversationId" in value.owner) ||
      typeof value.owner.conversationId !== "string" ||
      !("cwd" in value.owner) ||
      typeof value.owner.cwd !== "string"
    ) {
      return err(
        new InputError("A saved task plan requires its conversation and workspace identity."),
      );
    }
    const saved = parseStoredTaskPlan(value, {
      conversationId: value.owner.conversationId,
      cwd: value.owner.cwd,
    });
    return saved.ok ? ok(saved.value.plan) : saved;
  }
  return validateTaskPlan(value);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0]) {
    console.error("Usage: bun src/agents/check-plan.ts <plan.json>");
    process.exitCode = 1;
  } else {
    const checked = await checkPlanFile(args[0]);
    if (!checked.ok) {
      console.error(`[${checked.error.code}] ${checked.error.message}`);
      if (checked.error instanceof PlanValidationError) {
        for (const issue of checked.error.issues)
          console.error(`${issue.code} ${issue.path}: ${issue.message}`);
      }
      process.exitCode = 1;
    } else {
      console.log(renderTaskPlan(checked.value));
      console.log("\nStructure: passed. No tasks or acceptance commands were executed.");
    }
  }
}
