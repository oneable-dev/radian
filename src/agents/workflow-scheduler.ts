import { Value } from "typebox/value";
import { WorkflowError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { AgentProfile } from "./agent-profiles.ts";
import {
  profileHash,
  strictEffectiveProfileSnapshotSchema,
  type EffectiveProfileSnapshot,
} from "./effective-profile.ts";
import {
  MAX_PROCESSED_EVENTS,
  type WorkflowDocument,
  type WorkflowDocumentV2,
  type WorkflowAdmissionState,
  type WorkflowScheduleState,
} from "./task-workflow.ts";
import {
  canCreateSchedule,
  canTransition,
  canTransitionAdmission,
  type WorkflowTransitionCause,
} from "./workflow-schedule-state.ts";

export type FrozenPlanInputs = {
  boundRevision: number;
  dependencies: { artifactId: string; revision: number }[];
  missing: string[];
};

/** Shared with manual launch: only accepted artifacts from the current declaration qualify. */
export function capturePlanInputs(doc: WorkflowDocument, taskId: string): FrozenPlanInputs {
  const dependencies: FrozenPlanInputs["dependencies"] = [];
  const missing: string[] = [];
  for (const id of doc.tasks[taskId]!.dependsOn) {
    const artifactId = doc.tasks[id]?.planArtifact;
    const latest = artifactId ? doc.artifacts[artifactId]?.revisions.at(-1) : undefined;
    if (
      artifactId &&
      latest?.docRevision !== undefined &&
      doc.manifest?.declaredRevision !== undefined &&
      latest.docRevision > doc.manifest.declaredRevision
    ) {
      dependencies.push({ artifactId, revision: latest.revision });
    } else missing.push(id);
  }
  return { boundRevision: doc.revision, dependencies, missing };
}

export function workflowSchedulerEnabled(settings: unknown): Result<boolean, WorkflowError> {
  if (!settings || typeof settings !== "object" || !("radian" in settings)) return ok(false);
  const config = settings.radian;
  if (!config || typeof config !== "object" || Array.isArray(config))
    return err(
      new WorkflowError(
        "WORKFLOW_CONFLICT",
        "radian must be an extension settings object; workflow scheduler disabled.",
      ),
    );
  if (!("workflowScheduler" in config) || config.workflowScheduler === "off") return ok(false);
  return config.workflowScheduler === "on"
    ? ok(true)
    : err(
        new WorkflowError(
          "WORKFLOW_CONFLICT",
          "radian.workflowScheduler must be on or off; workflow scheduler disabled.",
        ),
      );
}

/** Custom profiles need the same durable, strict admission record as built-ins. */
export function planningProfileSnapshot(profile: AgentProfile): EffectiveProfileSnapshot {
  return {
    ...(profile.effectiveProfile ?? {
      id: profile.name,
      descriptorVersion: 1,
      promptHash: profileHash(profile.prompt),
      overlays: [],
      ...(profile.model ? { model: profile.model } : {}),
      ...(profile.thinking ? { thinking: profile.thinking } : {}),
      skills: profile.skills.map((name) => ({ name })),
      toolCeiling: profile.tools ?? ["*"],
      verificationTools: [],
      delegation: { enabled: profile.delegation?.enabled === true },
      outputContractVersions: ["plan-v1"],
    }),
    purpose: "planning",
  };
}

export type SchedulerRun = {
  id: string;
  operationId?: string;
  /** Initializing and cleanup-uncertain handles remain active. */
  active: boolean;
};
export type SchedulerIntent = { kind: "launch" | "stop"; operationId: string };
export type SchedulerEvent = {
  id: string;
  at: number;
  invocationId: string;
  profiles?: Readonly<Record<string, EffectiveProfileSnapshot>>;
  capacity?: number;
  retainedCapacity?: number;
} & (
  | { kind: "started"; baselineRevision: number }
  | {
      kind:
        | "declared"
        | "published"
        | "capacity-freed"
        | "paused"
        | "resumed"
        | "cancelled"
        | "restarted";
    }
  | { kind: "launching" | "cleanup-uncertain" | "capacity-deferred"; operationId: string }
  | { kind: "run-started"; operationId: string; runId: string }
  | {
      kind: "run-settled";
      operationId: string;
      runId?: string;
      outcome: "completed" | "failed" | "interrupted" | "cancelled";
    }
  | { kind: "question-opened" | "question-answered"; operationId: string; questionId: string }
);
export type SchedulerAdmission = NonNullable<WorkflowDocumentV2["scheduler"]>["admissions"][string];
export const activeAdmission = (state: WorkflowAdmissionState) =>
  ["reserved", "launching", "running"].includes(state);

function artifactHasQuestions(body: unknown): boolean {
  if (!body || typeof body !== "object" || !("plan" in body)) return false;
  const plan = body.plan;
  return (
    !!plan &&
    typeof plan === "object" &&
    "openQuestions" in plan &&
    Array.isArray(plan.openQuestions) &&
    plan.openQuestions.length > 0
  );
}

/** Accepted coverage is transitive; a stale intermediate publication is not a ready input. */
function acceptedCoverage(
  doc: WorkflowDocumentV2,
  taskId: string,
  visiting = new Set<string>(),
): boolean {
  if (visiting.has(taskId)) return false;
  const task = doc.tasks[taskId];
  const artifact = task?.planArtifact
    ? doc.artifacts[task.planArtifact]?.revisions.at(-1)
    : undefined;
  if (
    !task ||
    artifact?.docRevision === undefined ||
    artifact.docRevision <=
      (task.declaredRevision ?? doc.manifest?.declaredRevision ?? Number.MAX_SAFE_INTEGER) ||
    artifactHasQuestions(artifact.body)
  )
    return false;
  if (
    Object.values(doc.scheduler?.admissions ?? {}).some(
      (item) =>
        item.taskId === taskId &&
        activeAdmission(item.state) &&
        (item.questions?.length || item.stopReason),
    )
  )
    return false;
  const path = new Set(visiting).add(taskId);
  return task.dependsOn.every((id) => {
    const dependency = doc.tasks[id];
    const latest = dependency?.planArtifact
      ? doc.artifacts[dependency.planArtifact]?.revisions.at(-1)
      : undefined;
    return (
      !!latest &&
      artifact.dependencies?.some(
        (input) =>
          input.artifactId === dependency!.planArtifact && input.revision === latest.revision,
      ) === true &&
      acceptedCoverage(doc, id, path)
    );
  });
}

/** Pure committed-event reducer. It never launches work or migrates a document. */
export function schedule(
  document: WorkflowDocument,
  runs: readonly SchedulerRun[],
  event: SchedulerEvent,
): Result<{ doc: WorkflowDocumentV2; intents: SchedulerIntent[] }, WorkflowError> {
  if (document.version !== 2)
    return err(
      new WorkflowError("WORKFLOW_CONFLICT", "Scheduler writes require explicit v2 migration."),
    );
  if (document.processed[event.id]) return ok({ doc: document, intents: [] });
  if (Object.keys(document.processed).length >= MAX_PROCESSED_EVENTS)
    return err(new WorkflowError("WORKFLOW_CONFLICT", "Workflow safety ledger is full."));
  const doc = structuredClone(document);
  const scheduler = (doc.scheduler ??= { invocations: [], admissions: {}, consents: {} });
  const activeKeys = new Set<string>();
  for (const admission of Object.values(scheduler.admissions)) {
    if (!activeAdmission(admission.state)) continue;
    const key = JSON.stringify([admission.taskId, admission.role, admission.assignmentVersion]);
    if (activeKeys.has(key))
      return err(new WorkflowError("WORKFLOW_CONFLICT", "Duplicate active task-role admission."));
    activeKeys.add(key);
  }
  let invocation = scheduler.invocations.find((item) => item.id === event.invocationId);
  if (!invocation && event.kind === "started") {
    invocation = {
      id: event.invocationId,
      kind: "plan",
      state: "active",
      createdAt: event.at,
      baselineRevision: event.baselineRevision,
      invalidations: {},
    };
    scheduler.invocations.push(invocation);
  }
  if (!invocation || invocation.kind !== "plan")
    return err(
      new WorkflowError(
        "WORKFLOW_NOT_AUTHORIZED",
        "Planning scheduler requires a plan invocation.",
      ),
    );
  const intents: SchedulerIntent[] = [];
  let transitionError: WorkflowError | undefined;
  const transition = (
    taskId: string,
    state: WorkflowScheduleState,
    cause: WorkflowTransitionCause,
    reason?: string,
  ) => {
    const task = doc.tasks[taskId]!;
    if (task.schedule?.state === state) {
      if (reason) task.schedule.reason = reason;
      return;
    }
    if (task.schedule) {
      const allowed = canTransition(task.schedule.state, state, cause);
      if (!allowed.ok) {
        transitionError ??= allowed.error;
        return;
      }
    } else {
      const allowed = canCreateSchedule(state, reason ?? "");
      if (!allowed.ok) {
        transitionError ??= allowed.error;
        return;
      }
    }
    task.schedule = {
      state,
      since: event.at,
      invocationId: invocation!.id,
      ...(reason ? { reason } : {}),
    };
  };
  const admissionTransition = (admission: SchedulerAdmission, state: WorkflowAdmissionState) => {
    if (admission.state === state || !activeAdmission(admission.state)) return;
    const allowed = canTransitionAdmission(admission.state, state);
    if (!allowed.ok) {
      transitionError ??= allowed.error;
      return;
    }
    admission.state = state;
  };
  if (event.kind === "paused") invocation.state = "paused";
  if (event.kind === "resumed" && invocation.state === "paused") invocation.state = "active";
  if (event.kind === "cancelled") invocation.state = "cancelled";
  const admissions = Object.entries(scheduler.admissions).filter(
    ([, item]) => item.invocationId === invocation.id,
  );
  if (
    admissions.some(
      ([, item]) => item.role !== "lead" || item.effectiveProfile.purpose !== "planning",
    )
  )
    return err(
      new WorkflowError(
        "WORKFLOW_NOT_AUTHORIZED",
        "Plan invocations cannot admit implementers or non-planning runs.",
      ),
    );
  if ("operationId" in event) {
    const admission = scheduler.admissions[event.operationId];
    if (admission?.invocationId === invocation.id && activeAdmission(admission.state)) {
      if ("runId" in event && event.runId) {
        if (admission.runId && admission.runId !== event.runId)
          return err(
            new WorkflowError("WORKFLOW_CONFLICT", "An operation cannot acquire a second run."),
          );
        admission.runId = event.runId;
      }
      if (event.kind === "launching") admissionTransition(admission, "launching");
      if (event.kind === "capacity-deferred") {
        admissionTransition(admission, "interrupted");
        transition(admission.taskId, "queued", "retry", "capacity");
      }
      if (event.kind === "run-started") {
        admissionTransition(admission, "running");
        if (!admission.stopReason && doc.tasks[admission.taskId]!.schedule?.state === "admitting")
          transition(admission.taskId, "running", "launch");
        if (
          admission.questions?.length &&
          doc.tasks[admission.taskId]!.schedule?.state === "running"
        )
          transition(admission.taskId, "awaiting-answer", "ask");
      }
      if (event.kind === "run-settled") {
        if (event.outcome === "completed" && admission.state === "launching")
          admissionTransition(admission, "running");
        admissionTransition(admission, event.outcome);
        if (admission.stopReason) {
          const reason = admission.stopReason;
          transition(
            admission.taskId,
            reason === "cancelled" ? "cancelled" : reason === "paused" ? "paused" : "blocked",
            reason === "cancelled" ? "cancel" : reason === "paused" ? "pause" : "block",
            reason === "obsolete" ? "obsolete-inputs" : undefined,
          );
        } else {
          const state = doc.tasks[admission.taskId]!.schedule?.state;
          if (event.outcome === "completed" && state === "admitting")
            transition(admission.taskId, "running", "launch");
          if (event.outcome === "completed") {
            if (doc.tasks[admission.taskId]!.schedule?.state === "awaiting-answer")
              transition(admission.taskId, "running", "answer");
            transition(admission.taskId, "ready-for-review", "complete");
          } else transition(admission.taskId, "blocked", "block", `run-${event.outcome}`);
        }
      }
      if (event.kind === "cleanup-uncertain")
        doc.tasks[admission.taskId]!.schedule!.reason = "cleanup-uncertain";
      if (event.kind === "question-opened") {
        admission.questions = [...new Set([...(admission.questions ?? []), event.questionId])];
        if (doc.tasks[admission.taskId]!.schedule?.state === "running")
          transition(admission.taskId, "awaiting-answer", "ask");
      }
      if (event.kind === "question-answered") {
        admission.questions = (admission.questions ?? []).filter((id) => id !== event.questionId);
        if (
          !admission.questions.length &&
          doc.tasks[admission.taskId]!.schedule?.state === "awaiting-answer"
        )
          transition(admission.taskId, "running", "answer");
      }
    }
  }
  if (event.kind === "restarted") {
    if (invocation.state !== "cancelled" && invocation.state !== "completed")
      invocation.state = "paused";
    for (const [, admission] of admissions)
      if (activeAdmission(admission.state)) {
        admissionTransition(admission, "interrupted");
        const state = doc.tasks[admission.taskId]!.schedule?.state;
        if (state && ["admitting", "running", "awaiting-answer"].includes(state))
          transition(admission.taskId, "interrupted", "restart");
      }
  }
  const branches = doc.manifest?.branches ?? [];
  for (const [operationId, admission] of admissions) {
    if (!activeAdmission(admission.state) && admission.state !== "completed") continue;
    const task = doc.tasks[admission.taskId]!;
    const inputs = capturePlanInputs(doc, task.id);
    const refs = inputs.dependencies.map((input) => `${input.artifactId}@${input.revision}`);
    const obsolete =
      !branches.includes(task.id) ||
      admission.assignmentVersion !== task.assignmentVersion ||
      admission.declaredRevision !== task.declaredRevision ||
      inputs.missing.length > 0 ||
      !task.dependsOn.every((id) => acceptedCoverage(doc, id)) ||
      JSON.stringify(refs) !== JSON.stringify(admission.frozenInputs);
    if (
      !admission.stopReason &&
      (obsolete || invocation.state === "cancelled" || invocation.state === "paused")
    ) {
      admission.stopReason =
        invocation.state === "cancelled"
          ? "cancelled"
          : invocation.state === "paused"
            ? "paused"
            : "obsolete";
      if (obsolete) {
        invocation.invalidations ??= {};
        invocation.invalidations[task.id] = (invocation.invalidations[task.id] ?? 0) + 1;
      }
    }
    if (admission.stopReason && activeAdmission(admission.state)) {
      if (event.kind !== "restarted") intents.push({ kind: "stop", operationId });
    }
  }
  let occupied =
    runs.filter((run) => run.active).length +
    Object.entries(scheduler.admissions).filter(
      ([id, admission]) =>
        activeAdmission(admission.state) &&
        !runs.some((run) => run.operationId === id && run.active),
    ).length;
  let retained =
    runs.length +
    Object.entries(scheduler.admissions).filter(
      ([id, admission]) =>
        activeAdmission(admission.state) && !runs.some((run) => run.operationId === id),
    ).length;
  for (const taskId of branches) {
    const task = doc.tasks[taskId];
    if (!task) continue;
    if (task.kind !== "plan")
      return err(
        new WorkflowError(
          "WORKFLOW_NOT_AUTHORIZED",
          "Plan invocations cannot admit implementation tasks.",
        ),
      );
    if (task.schedule?.invocationId !== invocation.id) {
      if (task.schedule?.invocationId) {
        const previous = scheduler.invocations.find(
          (item) => item.id === task.schedule!.invocationId,
        );
        if (previous) {
          previous.schedules ??= {};
          previous.schedules[taskId] = structuredClone(task.schedule);
        }
      }
      delete task.schedule;
    }
    if (!task.schedule) transition(taskId, "queued", "schedule", "dependencies");
    const currentAdmissions = Object.entries(scheduler.admissions).filter(
      ([, item]) =>
        item.taskId === taskId &&
        item.role === "lead" &&
        item.assignmentVersion === task.assignmentVersion,
    );
    const active = Object.entries(scheduler.admissions).find(
      ([, item]) => item.taskId === taskId && item.role === "lead" && activeAdmission(item.state),
    );
    if (active) {
      if (!active[1].stopReason && ["reserved", "launching"].includes(active[1].state))
        intents.push({ kind: "launch", operationId: active[0] });
      continue;
    }
    if (invocation.state === "cancelled") {
      transition(taskId, "cancelled", "cancel");
      continue;
    }
    if (invocation.state === "completed") continue;
    if (invocation.state === "paused") {
      if (task.schedule!.state !== "interrupted" && task.schedule!.state !== "cancelled")
        transition(taskId, "paused", "pause");
      continue;
    }
    if (["paused", "interrupted"].includes(task.schedule!.state))
      transition(taskId, "queued", "resume", "dependencies");
    if (task.schedule!.state === "cancelled" || task.status === "cancelled") continue;
    // Launch-state commits are admission-local. Their intents are not a new scheduling tick.
    if (event.kind === "launching") continue;
    if ((invocation.invalidations?.[taskId] ?? 0) >= 3) {
      transition(taskId, "blocked", "block", "invalidation-limit");
      continue;
    }
    const inputs = capturePlanInputs(doc, taskId);
    const refs = inputs.dependencies.map((input) => `${input.artifactId}@${input.revision}`);
    const artifact = task.planArtifact
      ? doc.artifacts[task.planArtifact]?.revisions.at(-1)
      : undefined;
    const fresh =
      artifact?.docRevision !== undefined &&
      task.declaredRevision !== undefined &&
      artifact.docRevision > task.declaredRevision;
    const covered =
      fresh &&
      refs.every((ref) =>
        artifact.dependencies?.some((input) => `${input.artifactId}@${input.revision}` === ref),
      );
    if (
      covered &&
      !inputs.missing.length &&
      task.dependsOn.every((id) => acceptedCoverage(doc, id))
    )
      continue;
    const completed = currentAdmissions.find(
      ([, item]) =>
        item.invocationId === invocation.id && item.state === "completed" && !item.stopReason,
    );
    if (completed && !fresh) {
      if (task.schedule!.state === "ready-for-review")
        transition(taskId, "queued", "schedule", "dependencies");
      transition(taskId, "blocked", "block", "missing-publication");
      continue;
    }
    if (task.schedule!.state === "ready-for-review")
      transition(taskId, "queued", "schedule", "dependencies");
    if (task.schedule!.state === "blocked") {
      // Failed runs and exhausted budgets require a new invocation, never an automatic retry loop.
      if (
        ["invalidation-limit", "profile-unavailable"].includes(task.schedule!.reason ?? "") ||
        task.schedule!.reason?.startsWith("run-")
      )
        continue;
      transition(taskId, "queued", "unblock", "dependencies");
    }
    if (
      inputs.missing.length ||
      !task.dependsOn.every((id) => acceptedCoverage(doc, id)) ||
      doc.manifest?.diagnostics.length ||
      (doc.manifest?.declaredRevision ?? 0) <= (invocation.baselineRevision ?? 0)
    ) {
      task.schedule!.reason = "dependencies";
      continue;
    }
    if (occupied >= (event.capacity ?? 5)) {
      task.schedule!.reason = "capacity";
      continue;
    }
    if (retained >= (event.retainedCapacity ?? 128)) {
      transition(taskId, "blocked", "block", "retention-limit");
      continue;
    }
    const snapshot = event.profiles?.[task.lead.profile];
    if (
      !snapshot ||
      !Value.Check(strictEffectiveProfileSnapshotSchema, snapshot) ||
      snapshot.purpose !== "planning"
    ) {
      transition(taskId, "blocked", "block", "profile-unavailable");
      continue;
    }
    const operationId = `${invocation.id}:${taskId}:${Object.values(scheduler.admissions).filter((item) => item.taskId === taskId).length}`;
    scheduler.admissions[operationId] = {
      invocationId: invocation.id,
      taskId,
      role: "lead",
      assignmentVersion: task.assignmentVersion,
      ...(task.declaredRevision !== undefined ? { declaredRevision: task.declaredRevision } : {}),
      boundRevision: doc.revision,
      frozenInputs: refs,
      effectiveProfile: structuredClone(snapshot),
      state: "reserved",
    };
    transition(taskId, "admitting", "admit");
    intents.push({ kind: "launch", operationId });
    occupied++;
    retained++;
  }
  if (transitionError) return err(transitionError);
  invocation.schedules ??= {};
  for (const [id, task] of Object.entries(doc.tasks))
    if (task.schedule?.invocationId === invocation.id)
      invocation.schedules[id] = structuredClone(task.schedule);
  doc.revision++;
  doc.processed[event.id] = { docRevision: doc.revision, outcome: { kind: "applied" } };
  return ok({ doc, intents });
}
