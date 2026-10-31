import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { InputError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { taskPlanSchema, validateTaskPlan } from "./task-plan.ts";
import { planReviewSchema } from "./task-plan-store.ts";

// Keep proposals below the sidecar limit, including its owner and metadata.
export const maxPlanningProposalBytes = 1024 * 1024;
export const planningProposalSchema = Type.Object(
  { plan: taskPlanSchema, review: planReviewSchema },
  { additionalProperties: false },
);
export type PlanningProposal = Static<typeof planningProposalSchema>;

export function validatePlanningProposal(value: unknown): Result<PlanningProposal, InputError> {
  if (!Value.Check(planningProposalSchema, value)) {
    return err(
      new InputError("Invalid planning proposal; a complete plan and review are required."),
    );
  }
  if (Buffer.byteLength(JSON.stringify(value)) > maxPlanningProposalBytes) {
    return err(new InputError("Planning proposal exceeds the supported size limit."));
  }
  const plan = validateTaskPlan(value.plan);
  return plan.ok ? ok({ plan: plan.value, review: value.review }) : plan;
}
