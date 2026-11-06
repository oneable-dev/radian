import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { WorkflowError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { strictEffectiveProfileSnapshotSchema } from "./effective-profile.ts";
import { workflowConsentSchema } from "./workflow-consent-schema.ts";

const text = Type.String({ minLength: 1, maxLength: 65536 });
const integer = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const enumeration = <T extends string>(...values: T[]) => Type.Enum(values);
const profile = Type.Object({ profile: text }, { additionalProperties: false });
export const workflowOwnerSchema = Type.Object(
  { conversationId: text, cwd: text },
  { additionalProperties: false },
);
export type WorkflowOwner = Static<typeof workflowOwnerSchema>;
const originSchema = Type.Object(
  { conversationId: text, cwd: text, sessionFile: text },
  { additionalProperties: false },
);
export type WorkflowOrigin = Static<typeof originSchema>;
export const workflowBindingSchema = Type.Object(
  {
    workflowId: text,
    taskId: text,
    role: enumeration("lead", "implementer", "verifier", "worker"),
    assignmentVersion: integer,
    purpose: Type.Optional(enumeration("planning", "analysis")),
  },
  { additionalProperties: false },
);
export type WorkflowBinding = Static<typeof workflowBindingSchema>;
export const workflowScheduleStateSchema = enumeration(
  "queued",
  "admitting",
  "running",
  "awaiting-answer",
  "blocked",
  "paused",
  "interrupted",
  "cancelled",
  "ready-for-review",
);
export type WorkflowScheduleState = Static<typeof workflowScheduleStateSchema>;
export const workflowScheduleSchema = Type.Object(
  {
    state: workflowScheduleStateSchema,
    invocationId: Type.Optional(text),
    reason: Type.Optional(text),
    since: integer,
  },
  { additionalProperties: false },
);
export const workflowAdmissionStateSchema = enumeration(
  "reserved",
  "launching",
  "running",
  "completed",
  "interrupted",
  "cancelled",
  "failed",
);
export type WorkflowAdmissionState = Static<typeof workflowAdmissionStateSchema>;
export const workflowSchedulerSchema = Type.Object(
  {
    invocations: Type.Array(
      Type.Object(
        {
          id: text,
          kind: enumeration("plan", "execute"),
          state: enumeration("active", "paused", "cancelled", "completed"),
          consentId: Type.Optional(text),
          createdAt: integer,
          baselineRevision: Type.Optional(integer),
          invalidations: Type.Optional(Type.Record(Type.String(), integer)),
          schedules: Type.Optional(Type.Record(Type.String(), workflowScheduleSchema)),
        },
        { additionalProperties: false },
      ),
    ),
    admissions: Type.Record(
      Type.String(),
      Type.Object(
        {
          taskId: text,
          invocationId: Type.Optional(text),
          boundRevision: Type.Optional(integer),
          declaredRevision: Type.Optional(integer),
          questions: Type.Optional(Type.Array(text, { uniqueItems: true })),
          stopReason: Type.Optional(enumeration("obsolete", "cancelled", "paused")),
          submittedRevision: Type.Optional(integer),
          defectId: Type.Optional(text),
          attemptId: Type.Optional(text),
          role: workflowBindingSchema.properties.role,
          assignmentVersion: integer,
          frozenInputs: Type.Array(Type.String({ pattern: "^.+@[0-9]+$" })),
          effectiveProfile: strictEffectiveProfileSnapshotSchema,
          state: workflowAdmissionStateSchema,
          runId: Type.Optional(text),
        },
        { additionalProperties: false },
      ),
      { additionalProperties: false },
    ),
    consents: Type.Record(Type.String(), workflowConsentSchema, { additionalProperties: false }),
  },
  { additionalProperties: false },
);
// Model-authored task declarations cannot set host-owned scheduler state.
export const workflowTaskInputSchema = Type.Object(
  {
    id: text,
    title: text,
    kind: enumeration("plan", "implement"),
    scope: text,
    dependsOn: Type.Array(text),
    parentTaskId: Type.Optional(text),
    splitFrom: Type.Optional(text),
    continues: Type.Optional(text),
    lead: profile,
    implementer: Type.Optional(profile),
    verifier: Type.Optional(profile),
    assignmentVersion: integer,
    artifactRevision: integer,
    declaredRevision: Type.Optional(integer),
    verification: Type.Object(
      {
        state: enumeration("unverified", "awaiting-qa", "passed", "failed"),
        revision: Type.Optional(integer),
      },
      { additionalProperties: false },
    ),
    status: enumeration("open", "analysis-pending", "human-required", "cancelled", "verified"),
    planArtifact: Type.Optional(text),
  },
  { additionalProperties: false },
);
export const workflowTaskSchema = Type.Object(
  { ...workflowTaskInputSchema.properties, schedule: Type.Optional(workflowScheduleSchema) },
  { additionalProperties: false },
);
export type WorkflowTask = Static<typeof workflowTaskSchema>;
export const workflowAnalysisSchema = Type.Object(
  {
    reproduction: text,
    attempts: text,
    causes: Type.Array(
      Type.Object(
        { text, status: enumeration("verified", "hypothesis") },
        { additionalProperties: false },
      ),
    ),
    remedies: Type.Array(text),
    humanDecisions: Type.Array(text),
  },
  { additionalProperties: false },
);
export type WorkflowAnalysis = Static<typeof workflowAnalysisSchema>;
export const workflowAttemptSchema = Type.Object(
  {
    id: text,
    origin: enumeration("automated", "manual"),
    authorizedAtDocRevision: integer,
    submittedTaskId: text,
    submittedRevision: Type.Optional(integer),
    worktreeFingerprint: Type.Optional(text),
    status: enumeration("authorized", "submitted", "interrupted", "closed"),
    verdicts: Type.Array(
      Type.Object(
        {
          eventKey: text,
          verdict: enumeration("pass", "fail", "blocked"),
          revision: integer,
          at: integer,
          evidence: text,
        },
        { additionalProperties: false },
      ),
    ),
    terminal: Type.Optional(enumeration("pass", "fail")),
  },
  { additionalProperties: false },
);
export type WorkflowAttempt = Static<typeof workflowAttemptSchema>;
export const workflowDefectSchema = Type.Object(
  {
    id: text,
    responsibleTasks: Type.Array(text, { minItems: 1, uniqueItems: true }),
    discoveredAt: Type.Object(
      { eventKey: text, revision: integer },
      { additionalProperties: false },
    ),
    summary: text,
    evidence: text,
    automatedFailures: Type.Integer({ minimum: 0, maximum: 3 }),
    locked: Type.Boolean(),
    state: enumeration(
      "open",
      "repair-authorized",
      "awaiting-recheck",
      "resolved",
      "analysis-pending",
      "human-required",
      "cancelled",
    ),
    attempts: Type.Array(workflowAttemptSchema),
    analyses: Type.Record(Type.String(), workflowAnalysisSchema),
    resolutions: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Object(
          { revision: integer, eventKey: text, at: integer },
          { additionalProperties: false },
        ),
      ),
    ),
    authorizedBy: Type.Optional(
      Type.Object({ docRevision: integer, eventKey: text }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
);
export type WorkflowDefect = Static<typeof workflowDefectSchema>;
export const workflowOutcomeSchema = Type.Object(
  {
    kind: enumeration("applied", "duplicate", "stale", "terminal"),
    code: Type.Optional(Type.Literal("WORKFLOW_STALE")),
    ref: Type.Optional(text),
    terminal: Type.Optional(enumeration("pass", "fail")),
    summary: Type.Optional(text),
  },
  { additionalProperties: false },
);
export type WorkflowOutcome = Static<typeof workflowOutcomeSchema>;
export const workflowDocumentV1Schema = Type.Object(
  {
    version: Type.Literal(1),
    workflowId: Type.String({
      pattern: "^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$",
    }),
    revision: integer,
    origin: originSchema,
    members: Type.Array(
      Type.Object(
        {
          conversationId: text,
          cwd: text,
          sessionFile: text,
          addedAt: integer,
          via: enumeration("origin", "user-continuation"),
        },
        { additionalProperties: false },
      ),
    ),
    manifest: Type.Union([
      Type.Null(),
      Type.Object(
        {
          goal: text,
          updatedAt: integer,
          declaredAt: Type.Optional(integer),
          declaredRevision: Type.Optional(integer),
          branches: Type.Optional(Type.Array(text)),
          diagnostics: Type.Array(text),
        },
        { additionalProperties: false },
      ),
    ]),
    tasks: Type.Record(Type.String(), workflowTaskInputSchema),
    defects: Type.Record(Type.String(), workflowDefectSchema),
    artifacts: Type.Record(
      Type.String(),
      Type.Object(
        {
          taskId: text,
          revisions: Type.Array(
            Type.Object(
              {
                revision: integer,
                author: Type.Object(
                  {
                    runId: text,
                    profile: text,
                    role: enumeration("lead", "implementer", "verifier", "worker"),
                  },
                  { additionalProperties: false },
                ),
                publishedAt: integer,
                docRevision: Type.Optional(integer),
                dependencies: Type.Optional(
                  Type.Array(
                    Type.Object(
                      { artifactId: text, revision: integer },
                      { additionalProperties: false },
                    ),
                  ),
                ),
                summary: text,
                body: Type.Unknown(),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    processed: Type.Record(
      Type.String(),
      Type.Object(
        { docRevision: integer, outcome: workflowOutcomeSchema },
        { additionalProperties: false },
      ),
    ),
    log: Type.Array(
      Type.Object({ at: integer, eventKey: text, message: text }, { additionalProperties: false }),
      { maxItems: 256 },
    ),
  },
  { additionalProperties: false },
);
export const workflowDocumentV2Schema = Type.Object(
  {
    ...workflowDocumentV1Schema.properties,
    version: Type.Literal(2),
    tasks: Type.Record(Type.String(), workflowTaskSchema),
    scheduler: Type.Optional(workflowSchedulerSchema),
  },
  { additionalProperties: false },
);
export const workflowDocumentSchema = Type.Union([
  workflowDocumentV1Schema,
  workflowDocumentV2Schema,
]);
export type WorkflowDocumentV1 = Static<typeof workflowDocumentV1Schema>;
export type WorkflowDocumentV2 = Static<typeof workflowDocumentV2Schema>;
export type WorkflowDocument = Static<typeof workflowDocumentSchema>;
export type WorkflowEffect = {
  kind: "notify-root" | "notify-leads" | "notify-qa" | "needs-attention";
  taskIds: string[];
  profiles: string[];
  defectId?: string;
};
export type WorkflowMutation = {
  doc: WorkflowDocument;
  effects: WorkflowEffect[];
  outcome: WorkflowOutcome;
};
export type WorkflowPolicyResult = Result<WorkflowMutation, WorkflowError>;
export const MAX_PROCESSED_EVENTS = 100000;

export function validateWorkflowDocument(value: unknown): Result<WorkflowDocument, WorkflowError> {
  if (!Value.Check(workflowDocumentSchema, value))
    return err(new WorkflowError("WORKFLOW_CONFLICT", "Invalid or unsupported workflow document."));
  const reserved = new Set(Object.getOwnPropertyNames(Object.prototype));
  if (
    [
      value.tasks,
      value.defects,
      value.artifacts,
      value.processed,
      ...(value.version === 2 && value.scheduler
        ? [value.scheduler.admissions, value.scheduler.consents]
        : []),
    ].some((records) => Object.keys(records).some((key) => reserved.has(key)))
  )
    return err(
      new WorkflowError("WORKFLOW_CONFLICT", "Workflow IDs cannot name object internals."),
    );
  if (
    !value.members.some(
      (member) =>
        member.via === "origin" &&
        member.conversationId === value.origin.conversationId &&
        member.cwd === value.origin.cwd &&
        member.sessionFile === value.origin.sessionFile,
    )
  )
    return err(
      new WorkflowError("WORKFLOW_CONFLICT", "Workflow origin must be listed as a member."),
    );
  if (
    Object.entries(value.tasks).some(([id, task]) => id !== task.id) ||
    Object.entries(value.defects).some(
      ([id, defect]) =>
        id !== defect.id ||
        defect.responsibleTasks.some((taskId) => !Object.hasOwn(value.tasks, taskId)) ||
        defect.attempts.some(
          (attempt) => !defect.responsibleTasks.includes(attempt.submittedTaskId),
        ) ||
        Object.keys(defect.resolutions ?? {}).some(
          (taskId) => !defect.responsibleTasks.includes(taskId) || reserved.has(taskId),
        ) ||
        (defect.automatedFailures === 3 && !defect.locked),
    ) ||
    Object.keys(value.processed).length > MAX_PROCESSED_EVENTS
  ) {
    return err(new WorkflowError("WORKFLOW_CONFLICT", "Invalid workflow safety facts."));
  }
  if (
    value.version === 2 &&
    (Object.values(value.tasks).some(
      (task) =>
        task.schedule?.state === "queued" &&
        !["dependencies", "capacity", "worktree"].includes(task.schedule.reason ?? ""),
    ) ||
      (value.scheduler &&
        (new Set(value.scheduler.invocations.map((invocation) => invocation.id)).size !==
          value.scheduler.invocations.length ||
          Object.values(value.scheduler.admissions).some(
            (admission) => !Object.hasOwn(value.tasks, admission.taskId),
          ) ||
          Object.entries(value.scheduler.consents).some(
            ([id, receipt]) =>
              receipt.id !== id ||
              receipt.workflowId !== value.workflowId ||
              !value.members.some((member) => member.conversationId === receipt.conversationId) ||
              receipt.taskIds.some((taskId) => value.tasks[taskId]?.kind !== "implement") ||
              (receipt.approval !== undefined &&
                (receipt.approval.provenance.conversationId !== receipt.conversationId ||
                  receipt.approval.provenance.receivedAt !== receipt.createdAt ||
                  JSON.stringify(receipt.approval.tasks.map((task) => task.taskId)) !==
                    JSON.stringify(receipt.taskIds) ||
                  receipt.approval.tasks.some((task) =>
                    [task.lead, task.implementer, task.verifier].some(
                      (name) => !Object.hasOwn(receipt.approval!.profiles, name),
                    ),
                  ))) ||
              (receipt.state === "confirmed" && receipt.confirmedAt === undefined),
          ) ||
          value.scheduler.invocations.some(
            (invocation) =>
              invocation.kind === "execute" &&
              (!invocation.consentId ||
                !Object.hasOwn(value.scheduler!.consents, invocation.consentId)),
          ))))
  )
    return err(new WorkflowError("WORKFLOW_CONFLICT", "Invalid workflow scheduler facts."));
  return ok(value);
}

export function createWorkflowDocument(
  origin: WorkflowOrigin,
  workflowId: string,
  at: number,
): WorkflowDocument {
  return {
    version: 1,
    workflowId,
    revision: 0,
    origin: { ...origin },
    members: [{ ...origin, addedAt: at, via: "origin" }],
    manifest: null,
    tasks: {},
    defects: {},
    artifacts: {},
    processed: {},
    log: [],
  };
}

const sanitize = (value: string) =>
  value
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
const display = (value: string) => sanitize(value).slice(0, 512);

/** A shared defect can stop blocking one task before all responsibilities are resolved. */
export function hasCurrentResolution(
  doc: WorkflowDocument,
  defect: WorkflowDefect,
  taskId: string,
): boolean {
  const resolution = defect.resolutions?.[taskId];
  return resolution !== undefined && resolution.revision === doc.tasks[taskId]?.artifactRevision;
}

function resolutionStatus(doc: WorkflowDocument, defect: WorkflowDefect, taskId: string): string {
  if (doc.tasks[taskId]?.status === "cancelled") return "cancelled";
  const resolution = defect.resolutions?.[taskId];
  return hasCurrentResolution(doc, defect, taskId)
    ? `passed r${resolution!.revision}`
    : resolution
      ? `stale r${resolution.revision}; needs QA r${doc.tasks[taskId]!.artifactRevision}`
      : `needs QA r${doc.tasks[taskId]!.artifactRevision}`;
}

function boundReport(text: string, limit: number, marker: string): string {
  if (text.length <= limit) return text;
  const boundedMarker = marker.slice(0, limit - 1);
  return `${text.slice(0, limit - boundedMarker.length - 1)}\n${boundedMarker}`;
}

/** Full durable evidence for a direct human status request, not a compact notification. */
export function renderHumanHandoff(
  doc: WorkflowDocument,
  defectId: string,
): Result<string, WorkflowError> {
  const defect = doc.defects[defectId];
  if (!defect) return err(new WorkflowError("WORKFLOW_NOT_FOUND", "Defect not found."));
  const lines = [
    `Workflow ${sanitize(doc.workflowId)} r${doc.revision}`,
    `Defect ${sanitize(defect.id)}: ${sanitize(defect.summary)}`,
    `State: ${defect.state}; lock: ${defect.locked ? "LOCKED" : "unlocked"}; automatedFailures: ${defect.automatedFailures}/3`,
    `Responsible tasks: ${defect.responsibleTasks.map(sanitize).join(", ")}`,
    ...defect.responsibleTasks.map((taskId) => {
      const resolution = defect.resolutions?.[taskId];
      return `Resolution ${sanitize(taskId)}: ${resolutionStatus(doc, defect, taskId)}${resolution ? `; eventKey=${sanitize(resolution.eventKey)} at=${resolution.at}` : ""}`;
    }),
    `Discovery: eventKey=${sanitize(defect.discoveredAt.eventKey)} revision=${defect.discoveredAt.revision}; evidence: ${sanitize(defect.evidence)}`,
    `Attempts: ${defect.attempts.length}`,
  ];
  for (const attempt of defect.attempts) {
    lines.push(
      `Attempt ${sanitize(attempt.id)}: origin=${attempt.origin} task=${sanitize(attempt.submittedTaskId)} status=${attempt.status} submittedRevision=${attempt.submittedRevision ?? "none"} terminal=${attempt.terminal ?? "none"}`,
      ...attempt.verdicts.map(
        (verdict) =>
          `  Verdict eventKey=${sanitize(verdict.eventKey)} verdict=${verdict.verdict} revision=${verdict.revision} at=${verdict.at}; evidence: ${sanitize(verdict.evidence)}`,
      ),
    );
  }
  for (const [taskId, analysis] of Object.entries(defect.analyses)) {
    lines.push(
      `Analysis ${sanitize(taskId)}:`,
      `  Reproduction: ${sanitize(analysis.reproduction)}`,
      `  Attempts: ${sanitize(analysis.attempts)}`,
      ...analysis.causes.map((cause) => `  Cause (${cause.status}): ${sanitize(cause.text)}`),
      ...analysis.remedies.map((remedy) => `  Remedy: ${sanitize(remedy)}`),
      ...analysis.humanDecisions.map((decision) => `  Human decision: ${sanitize(decision)}`),
    );
  }
  lines.push(
    "Direct user commands:",
    ...defect.responsibleTasks.map((taskId) => `/repair recheck ${sanitize(taskId)}`),
    `/repair cancel ${sanitize(defect.id)}`,
  );
  return ok(
    boundReport(
      lines.join("\n"),
      60000,
      `[Truncated; complete durable evidence: ${sanitize(doc.origin.sessionFile)}.workflow.json]`,
    ),
  );
}

/** Parent escalations carry only bounded coordination facts and a detail retrieval command. */
export function renderRootSummary(doc: WorkflowDocument, defectId: string): string {
  const defect = doc.defects[defectId];
  if (!defect) return `Defect ${display(defectId)}: not found`.slice(0, 2000);
  const required = defect.responsibleTasks.filter((id) => doc.tasks[id]?.status !== "cancelled");
  const decisions = Object.values(defect.analyses).reduce(
    (count, analysis) => count + analysis.humanDecisions.length,
    0,
  );
  return boundReport(
    [
      `Defect ${display(defect.id)} | failures ${defect.automatedFailures}/3 | lock ${defect.locked ? "LOCKED" : "unlocked"} | ${defect.state}`,
      `Analyses: ${required.filter((id) => Object.hasOwn(defect.analyses, id)).length}/${required.length}; decisions: ${decisions}`,
      `handoff: /repair status ${display(defect.id)}`,
      `Tasks: ${defect.responsibleTasks.map(display).join(", ")}`,
    ].join("\n"),
    2000,
    "[Truncated; retrieve the handoff above]",
  );
}

export function renderWorkflowStatus(doc: WorkflowDocument, id?: string): string {
  const lines = [
    `Workflow ${doc.workflowId} r${doc.revision}`,
    `Goal: ${display(doc.manifest?.goal ?? "Not declared")}`,
  ];
  const selectedDefect = id ? doc.defects[id] : undefined;
  for (const task of Object.values(doc.tasks)) {
    if (id && task.id !== id && !selectedDefect?.responsibleTasks.includes(task.id)) continue;
    const defects = Object.values(doc.defects).filter((defect) =>
      defect.responsibleTasks.includes(task.id),
    );
    lines.push(
      `${task.id} ${display(task.title)} | ${task.status} | revision ${task.artifactRevision} ${task.verification.state}`,
      `  lead=${display(task.lead.profile)} implementer=${display(task.implementer?.profile ?? "-")} QA=${display(task.verifier?.profile ?? "-")} assignment=${task.assignmentVersion}`,
      `  blockers: ${
        defects
          .filter(
            (defect) =>
              defect.state !== "resolved" &&
              defect.state !== "cancelled" &&
              !hasCurrentResolution(doc, defect, task.id),
          )
          .map((defect) => defect.id)
          .join(", ") || "none"
      }; deps: ${task.dependsOn.join(", ") || "none"}${task.planArtifact ? `; ref: ${task.planArtifact}` : ""}`,
    );
    for (const defect of defects) {
      lines.push(
        `  ${defect.id} failed ${defect.automatedFailures}/3 ${defect.state}${defect.locked ? " LOCKED" : ""}: ${display(defect.summary)}`,
        `    resolution ${task.id}: ${resolutionStatus(doc, defect, task.id)}; attempts: ${defect.attempts.length}; remedies: ${Object.values(defect.analyses).reduce((count, analysis) => count + analysis.remedies.length, 0)}`,
      );
      const latest = defect.attempts.at(-1);
      lines.push(
        `    refs: finding=${display(defect.evidence)}${
          latest
            ? `; attempt=${latest.id} task=${latest.submittedTaskId} QA=${
                latest.verdicts
                  .map((verdict) => `${verdict.eventKey}:${display(verdict.evidence)}`)
                  .join(", ")
                  .slice(0, 512) || "pending"
              }`
            : ""
        }`,
      );
      if (defect.state === "human-required" || defect.state === "analysis-pending") {
        lines.push(`    handoff: /repair status ${display(defect.id)}`);
        for (const [leadTask, analysis] of Object.entries(defect.analyses)) {
          lines.push(
            `    analysis ${leadTask}: ${display(analysis.reproduction)}; ${analysis.causes.map((cause) => `${cause.status}: ${display(cause.text)}`).join("; ")}`,
            `    decisions: ${analysis.humanDecisions.map(display).join("; ") || "none"}`,
          );
        }
      }
    }
  }
  return lines.join("\n");
}
