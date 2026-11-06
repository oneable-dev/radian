import { WorkflowError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import {
  activeAdmission,
  planningProfileSnapshot,
  type SchedulerEvent,
  type SchedulerIntent,
  type SchedulerRun,
} from "./workflow-scheduler.ts";
import type { AgentProfile } from "./agent-profiles.ts";
import { validateExecutionConsent } from "./workflow-consent.ts";
import {
  MAX_PROCESSED_EVENTS,
  hasCurrentResolution,
  type WorkflowDocument,
  type WorkflowDocumentV2,
} from "./task-workflow.ts";

export const executionProfileSnapshot = (profile: AgentProfile) => ({
  ...planningProfileSnapshot(profile),
  purpose: "execution" as const,
});

function currentVerified(doc: WorkflowDocument, taskId: string): boolean {
  const task = doc.tasks[taskId];
  return (
    !!task &&
    task.status === "verified" &&
    task.verification.state === "passed" &&
    task.verification.revision === task.artifactRevision &&
    !Object.values(doc.defects).some(
      (defect) =>
        defect.responsibleTasks.includes(taskId) &&
        defect.state !== "resolved" &&
        defect.state !== "cancelled" &&
        !hasCurrentResolution(doc, defect, taskId),
    )
  );
}

/** Execution decisions use accepted submission/QA facts, never assistant prose or run completion alone. */
export function scheduleExecution(
  document: WorkflowDocument,
  runs: readonly SchedulerRun[],
  event: SchedulerEvent,
  consentId: string,
): Result<{ doc: WorkflowDocumentV2; intents: SchedulerIntent[] }, WorkflowError> {
  if (document.version !== 2 || !document.scheduler)
    return err(new WorkflowError("WORKFLOW_CONFLICT", "Execution requires v2 consent storage."));
  if (document.processed[event.id]) return ok({ doc: document, intents: [] });
  if (Object.keys(document.processed).length >= MAX_PROCESSED_EVENTS)
    return err(new WorkflowError("WORKFLOW_CONFLICT", "Workflow safety ledger is full."));
  const doc = structuredClone(document);
  const scheduler = doc.scheduler!;
  const receipt = scheduler.consents[consentId];
  if (!receipt || receipt.state === "preview")
    return err(new WorkflowError("WORKFLOW_NOT_AUTHORIZED", "No confirmed execution consent."));
  if (receipt.state === "revoked" && ["started", "resumed"].includes(event.kind))
    return err(
      new WorkflowError(
        "WORKFLOW_NOT_AUTHORIZED",
        "Revoked consent cannot start or resume execution.",
      ),
    );
  let invocation = scheduler.invocations.find((item) => item.id === event.invocationId);
  if (!invocation && event.kind === "started") {
    invocation = {
      id: event.invocationId,
      kind: "execute",
      consentId,
      state: "active",
      createdAt: event.at,
    };
    scheduler.invocations.push(invocation);
  }
  if (!invocation || invocation.kind !== "execute" || invocation.consentId !== consentId)
    return err(
      new WorkflowError(
        "WORKFLOW_NOT_AUTHORIZED",
        "Execution invocation does not own this consent.",
      ),
    );
  const intents: SchedulerIntent[] = [];
  const own = Object.entries(scheduler.admissions).filter(
    ([, item]) => item.invocationId === invocation.id,
  );
  const state = (
    taskId: string,
    value:
      | "queued"
      | "admitting"
      | "running"
      | "awaiting-answer"
      | "blocked"
      | "paused"
      | "interrupted"
      | "cancelled"
      | "ready-for-review",
    reason?: string,
  ) => {
    doc.tasks[taskId]!.schedule = {
      state: value,
      since: event.at,
      invocationId: invocation!.id,
      ...(reason ? { reason } : {}),
    };
  };
  if (event.kind === "paused") {
    invocation.state = "paused";
    for (const [operationId, item] of own) {
      if (
        activeAdmission(item.state) &&
        !runs.some((run) => run.operationId === operationId && run.active)
      ) {
        item.state = "interrupted";
        state(item.taskId, "paused", "admission-paused-before-launch");
      }
    }
  }
  if (event.kind === "resumed" && invocation.state === "paused") invocation.state = "active";
  if (event.kind === "cancelled") invocation.state = "cancelled";
  if (event.kind === "restarted") {
    if (invocation.state === "active") invocation.state = "paused";
    for (const [, item] of own)
      if (activeAdmission(item.state)) {
        item.state = "interrupted";
        state(item.taskId, "interrupted", "restart-requires-explicit-resume");
      }
  }
  if ("operationId" in event) {
    const admission = scheduler.admissions[event.operationId];
    if (admission?.invocationId === invocation.id && activeAdmission(admission.state)) {
      if ("runId" in event && event.runId) {
        if (admission.runId && admission.runId !== event.runId)
          return err(
            new WorkflowError("WORKFLOW_CONFLICT", "Execution operation already owns a run."),
          );
        admission.runId = event.runId;
      }
      if (event.kind === "launching") admission.state = "launching";
      if (event.kind === "run-started") {
        admission.state = "running";
        state(admission.taskId, "running", admission.role);
      }
      if (event.kind === "run-settled") {
        admission.state = event.outcome;
        const task = doc.tasks[admission.taskId]!;
        const progress =
          task.status === "verified" ||
          task.verification.state === "awaiting-qa" ||
          task.verification.state === "failed";
        if (!admission.stopReason && (event.outcome !== "completed" || !progress))
          state(task.id, "blocked", `run-${event.outcome}-without-accepted-result`);
      }
      if (event.kind === "capacity-deferred") {
        admission.state = "interrupted";
        state(admission.taskId, "queued", "capacity");
      }
      if (event.kind === "cleanup-uncertain")
        state(admission.taskId, "blocked", "cleanup-uncertain");
      if (event.kind === "question-opened") {
        admission.questions = [...new Set([...(admission.questions ?? []), event.questionId])];
        state(admission.taskId, "awaiting-answer");
      }
      if (event.kind === "question-answered") {
        admission.questions = (admission.questions ?? []).filter((id) => id !== event.questionId);
        if (!admission.questions.length) state(admission.taskId, "running", admission.role);
      }
    }
  }
  // Missing or changed input/profile evidence fences new launches and stops old authority.
  const valid = validateExecutionConsent(doc, receipt, receipt.worktree, event.profiles ?? {});
  if (
    !valid.ok &&
    ["active", "paused"].includes(invocation.state) &&
    !["cancelled", "restarted", "launching"].includes(event.kind)
  ) {
    receipt.state = "revoked";
    invocation.state = "paused";
  }
  for (const [operationId, item] of own) {
    if (!activeAdmission(item.state)) continue;
    const task = doc.tasks[item.taskId]!;
    if (
      invocation.state === "cancelled" ||
      receipt.state === "revoked" ||
      task.assignmentVersion !== item.assignmentVersion ||
      task.status === "cancelled"
    ) {
      item.stopReason = invocation.state === "cancelled" ? "cancelled" : "obsolete";
      intents.push({ kind: "stop", operationId });
    } else if (["reserved", "launching"].includes(item.state) && invocation.state === "active")
      intents.push({ kind: "launch", operationId });
  }
  const active = Object.values(scheduler.admissions).filter((item) => activeAdmission(item.state));
  // Verification can run arbitrary test commands. Serialize it with writes in the same worktree too.
  let occupied =
    runs.filter((run) => run.active).length +
    active.filter(
      (item) =>
        !runs.some(
          (run) => run.operationId && scheduler.admissions[run.operationId] === item && run.active,
        ),
    ).length;
  let worktreeBusy = own.some(([, item]) => activeAdmission(item.state));
  for (const taskId of receipt.taskIds) {
    const task = doc.tasks[taskId]!;
    const activeForTask = own.find(
      ([, item]) => item.taskId === taskId && activeAdmission(item.state),
    );
    if (activeForTask) continue;
    if (invocation.state !== "active") {
      state(
        taskId,
        invocation.state === "cancelled" ? "cancelled" : "paused",
        receipt.state === "revoked" ? "approval-stale" : undefined,
      );
      continue;
    }
    if (task.status === "cancelled") {
      state(taskId, "cancelled");
      continue;
    }
    if (currentVerified(doc, taskId)) {
      state(taskId, "ready-for-review", "current-revision-qa-passed");
      continue;
    }
    if (task.schedule?.reason?.startsWith("run-") || task.schedule?.reason === "cleanup-uncertain")
      continue;
    const defects = Object.values(doc.defects).filter(
      (d) =>
        d.responsibleTasks.includes(taskId) && d.state !== "resolved" && d.state !== "cancelled",
    );
    const locked = defects.find(
      (d) => d.locked || d.automatedFailures >= 3 || d.state === "human-required",
    );
    let role: "implementer" | "verifier" | "lead" =
      task.verification.state === "awaiting-qa" ? "verifier" : "implementer";
    let defectId: string | undefined;
    let attemptId: string | undefined;
    if (locked) {
      if (locked.state === "analysis-pending" && !locked.analyses[taskId]) {
        role = "lead";
        defectId = locked.id;
      } else {
        state(taskId, "blocked", "human-repair-required");
        continue;
      }
    } else if (role === "verifier") {
      const pending = defects.flatMap((d) =>
        d.attempts
          .filter(
            (a) =>
              a.submittedTaskId === taskId &&
              a.status === "submitted" &&
              a.submittedRevision === task.artifactRevision,
          )
          .map((a) => ({ d, a })),
      );
      if (pending.length > 1) {
        state(taskId, "blocked", "multiple-qa-attempts-require-owner");
        continue;
      }
      if (pending[0]) {
        defectId = pending[0].d.id;
        attemptId = pending[0].a.id;
      }
    } else if (defects.length) {
      if (!receipt.autoRepair) {
        state(taskId, "blocked", "repair-not-approved");
        continue;
      }
      defectId = defects[0]!.id;
      if (defects[0]!.attempts.some((a) => a.status === "submitted")) {
        state(taskId, "blocked", "awaiting-defect-verdict");
        continue;
      }
    } else if (task.verification.state !== "unverified") {
      state(taskId, "blocked", "current-qa-required");
      continue;
    }
    if (
      role === "implementer" &&
      task.dependsOn.some((id) => doc.tasks[id]?.kind === "implement" && !currentVerified(doc, id))
    ) {
      state(taskId, "queued", "dependencies");
      continue;
    }
    const completedRole = own.find(
      ([, item]) =>
        item.taskId === taskId &&
        item.role === role &&
        item.state === "completed" &&
        item.submittedRevision === task.artifactRevision &&
        item.defectId === defectId,
    );
    if (completedRole && role !== "implementer") {
      state(taskId, "blocked", role === "lead" ? "analysis-not-published" : "qa-not-recorded");
      continue;
    }
    if (worktreeBusy || runs.some((run) => run.active)) {
      state(taskId, "queued", "worktree");
      continue;
    }
    if (occupied >= (event.capacity ?? 5)) {
      state(taskId, "queued", "capacity");
      continue;
    }
    if (runs.length >= (event.retainedCapacity ?? 128)) {
      state(taskId, "blocked", "retention-limit");
      continue;
    }
    const assigned = task[role];
    const profile = assigned ? event.profiles?.[assigned.profile] : undefined;
    if (!profile) {
      state(taskId, "blocked", "profile-unavailable");
      continue;
    }
    const operationId = `${invocation.id}:${taskId}:${role}:${Object.keys(scheduler.admissions).length}`;
    scheduler.admissions[operationId] = {
      invocationId: invocation.id,
      taskId,
      role,
      assignmentVersion: task.assignmentVersion,
      boundRevision: doc.revision,
      frozenInputs: receipt.artifactRefs,
      effectiveProfile: { ...profile, purpose: role === "lead" ? "analysis" : "execution" },
      state: "reserved",
      submittedRevision: task.artifactRevision,
      ...(defectId ? { defectId } : {}),
      ...(attemptId ? { attemptId } : {}),
    };
    state(taskId, "admitting", role);
    intents.push({ kind: "launch", operationId });
    occupied++;
    worktreeBusy = true;
  }
  if (
    invocation.state === "active" &&
    receipt.taskIds.every((id) => doc.tasks[id]?.schedule?.state === "ready-for-review")
  )
    invocation.state = "completed";
  doc.revision++;
  doc.processed[event.id] = { docRevision: doc.revision, outcome: { kind: "applied" } };
  return ok({ doc, intents });
}
