import { WorkflowError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { WorkflowAdmissionState, WorkflowScheduleState } from "./task-workflow.ts";

export type WorkflowTransitionCause =
  | "admit"
  | "launch"
  | "retry"
  | "ask"
  | "answer"
  | "block"
  | "unblock"
  | "pause"
  | "resume"
  | "restart"
  | "cancel"
  | "complete"
  | "schedule";

/**
 * Task schedule transition table (destination: required cause).
 * queued: admitting/admit, blocked/block, paused/pause, cancelled/cancel
 * admitting: running/launch, queued/retry, blocked/block, paused/pause,
 *            interrupted/restart, cancelled/cancel
 * running: awaiting-answer/ask, blocked/block, paused/pause, interrupted/restart,
 *          ready-for-review/complete, cancelled/cancel
 * awaiting-answer: running/answer, blocked/block, paused/pause,
 *                 interrupted/restart, cancelled/cancel
 * blocked: queued/unblock, paused/pause, cancelled/cancel
 * paused: queued/resume, admitting/resume, cancelled/cancel
 * interrupted: queued/resume, admitting/resume, running/resume, cancelled/cancel
 * ready-for-review: queued/schedule, paused/pause, cancelled/cancel
 * cancelled: none (terminal, including self-transitions).
 *
 * These guards grant no authority: the host must separately check provenance,
 * dependencies, consent, capacity, assignments and permanent repair locks.
 */
const transitions: Record<
  WorkflowScheduleState,
  Partial<Record<WorkflowScheduleState, WorkflowTransitionCause>>
> = {
  queued: { admitting: "admit", blocked: "block", paused: "pause", cancelled: "cancel" },
  admitting: {
    running: "launch",
    queued: "retry",
    blocked: "block",
    paused: "pause",
    interrupted: "restart",
    cancelled: "cancel",
  },
  running: {
    "awaiting-answer": "ask",
    blocked: "block",
    paused: "pause",
    interrupted: "restart",
    "ready-for-review": "complete",
    cancelled: "cancel",
  },
  "awaiting-answer": {
    running: "answer",
    blocked: "block",
    paused: "pause",
    interrupted: "restart",
    cancelled: "cancel",
  },
  blocked: { queued: "unblock", paused: "pause", cancelled: "cancel" },
  paused: { queued: "resume", admitting: "resume", cancelled: "cancel" },
  interrupted: { queued: "resume", admitting: "resume", running: "resume", cancelled: "cancel" },
  "ready-for-review": { queued: "schedule", paused: "pause", cancelled: "cancel" },
  cancelled: {},
};

/** A new invocation creates a separate schedule; it never revives a terminal schedule. */
export function canCreateSchedule(
  state: WorkflowScheduleState,
  reason: string,
): Result<void, WorkflowError> {
  return state === "queued" && ["dependencies", "capacity"].includes(reason)
    ? ok(undefined)
    : err(
        new WorkflowError(
          "WORKFLOW_TRANSITION_INVALID",
          `Cannot create a schedule in ${state} (${reason}).`,
        ),
      );
}

export function canTransition(
  from: WorkflowScheduleState,
  to: WorkflowScheduleState,
  cause: WorkflowTransitionCause,
): Result<void, WorkflowError> {
  return transitions[from][to] === cause
    ? ok(undefined)
    : err(
        new WorkflowError(
          "WORKFLOW_TRANSITION_INVALID",
          `Cannot transition ${from} -> ${to} via ${cause}.`,
        ),
      );
}

/**
 * Admission table, for one immutable operationId:
 * reserved -> launching | interrupted | cancelled
 * launching -> running | interrupted | cancelled | failed
 * running -> completed | interrupted | cancelled | failed
 * interrupted, completed, cancelled, failed -> none
 *
 * Commit reserved before reserved -> launching; reconcile an uncertain launch
 * by operationId rather than issuing it again. A runId, once recorded, must never
 * change or disappear. Resume after interruption creates a NEW operationId and
 * admission, even when the task schedule returns to running.
 */
const admissionTransitions: Record<WorkflowAdmissionState, readonly WorkflowAdmissionState[]> = {
  reserved: ["launching", "interrupted", "cancelled"],
  launching: ["running", "interrupted", "cancelled", "failed"],
  running: ["completed", "interrupted", "cancelled", "failed"],
  interrupted: [],
  completed: [],
  cancelled: [],
  failed: [],
};

export function canTransitionAdmission(
  from: WorkflowAdmissionState,
  to: WorkflowAdmissionState,
): Result<void, WorkflowError> {
  return admissionTransitions[from].includes(to)
    ? ok(undefined)
    : err(
        new WorkflowError(
          "WORKFLOW_TRANSITION_INVALID",
          `Cannot transition admission ${from} -> ${to}.`,
        ),
      );
}
