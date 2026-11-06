import { Value } from "typebox/value";
import { WorkflowError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { UserCommandProvenance } from "./repair-command.ts";
import { planReviewSchema } from "./task-plan-store.ts";
import { validateTaskPlan } from "./task-plan.ts";
import {
  workflowAnalysisSchema,
  hasCurrentResolution,
  MAX_PROCESSED_EVENTS,
  type WorkflowAnalysis,
  type WorkflowBinding,
  type WorkflowDefect,
  type WorkflowDocument,
  type WorkflowEffect,
  type WorkflowMutation,
  type WorkflowOrigin,
  type WorkflowOutcome,
  type WorkflowPolicyResult,
  type WorkflowTask,
} from "./task-workflow.ts";

export type WorkflowEvent = { eventKey: string; at: number };
type Bound = WorkflowEvent & { binding: WorkflowBinding };
type Human = WorkflowEvent & { provenance: UserCommandProvenance; id: string };
export type FindingCommand = Bound & {
  defectId: string;
  revision: number;
  summary: string;
  evidence: string;
  responsibleTasks?: string[];
};
export type SubmitCommand = Bound & { defectId?: string; attemptId?: string };
export type VerdictCommand = Bound & {
  defectId?: string;
  attemptId?: string;
  revision: number;
  verdict: "pass" | "fail" | "blocked";
  evidence: string;
};
export type AdmitRepairCommand = Bound & {
  defectId: string;
  attemptId: string;
};
export type AnalysisCommand = Bound & {
  defectId: string;
  analysis: WorkflowAnalysis;
};
export type PlanArtifactCommand = Bound & {
  artifactId: string;
  plan: unknown;
  review: unknown;
  author: { runId: string; profile: string; role: WorkflowBinding["role"] };
  reviewedDependencies?: { artifactId: string; revision: number }[];
};
export type ScopeCommand = WorkflowEvent & {
  goal: string;
  branches: {
    id: string;
    title: string;
    lead: { profile: string };
    scope: string;
    dependsOn: string[];
  }[];
  knownProfiles: string[];
};
export type SubtasksCommand = WorkflowEvent & {
  binding?: WorkflowBinding;
  parentTaskId: string;
  subtasks: {
    id: string;
    title: string;
    kind: "plan" | "implement";
    scope: string;
    dependsOn: string[];
    implementer?: { profile: string };
    verifier?: { profile: string };
    lead?: { profile: string };
  }[];
  knownProfiles: string[];
};
export type ReassignCommand = WorkflowEvent & {
  taskId: string;
  role: "lead" | "implementer" | "verifier";
  profile: string;
};
export type LinkTaskCommand = WorkflowEvent & {
  taskId: string;
  task: WorkflowTask;
};
export type HumanRecheckCommand = Human & {
  attemptId: string;
  worktreeFingerprint?: string;
};
export type ContinuationCommand = WorkflowEvent & {
  provenance: UserCommandProvenance;
  member: WorkflowOrigin;
};

type Action =
  | ({ type: "finding" } & FindingCommand)
  | ({ type: "submit" } & SubmitCommand)
  | ({ type: "verdict" } & VerdictCommand)
  | ({ type: "admit" } & AdmitRepairCommand)
  | ({ type: "analysis" } & AnalysisCommand)
  | ({ type: "plan" } & PlanArtifactCommand)
  | ({ type: "scope" } & ScopeCommand)
  | ({ type: "subtasks" } & SubtasksCommand)
  | ({ type: "reassign" } & ReassignCommand)
  | ({ type: "continue-task" | "split-task" } & LinkTaskCommand)
  | ({ type: "human-recheck" } & HumanRecheckCommand)
  | ({ type: "human-cancel" } & Human)
  | ({ type: "continuation" } & ContinuationCommand)
  | ({ type: "recover" } & WorkflowEvent);

const failure = (code: ConstructorParameters<typeof WorkflowError>[0], message: string) =>
  err(new WorkflowError(code, message));
function authorize(
  doc: WorkflowDocument,
  binding: WorkflowBinding,
  roles: WorkflowBinding["role"][],
): Result<WorkflowTask, WorkflowError> {
  const task = doc.tasks[binding.taskId];
  if (
    binding.workflowId !== doc.workflowId ||
    !task ||
    task.assignmentVersion !== binding.assignmentVersion ||
    !roles.includes(binding.role) ||
    (binding.role === "implementer" && !task.implementer) ||
    (binding.role === "verifier" && !task.verifier)
  )
    return failure(
      "WORKFLOW_NOT_AUTHORIZED",
      "Workflow binding is missing, revoked or not authorized for this operation.",
    );
  return ok(task);
}
/** Current lead bindings cover their own task and its declared descendant chain. */
export function isTaskLead(
  doc: WorkflowDocument,
  binding: WorkflowBinding,
  taskId: string,
): boolean {
  const authorized = authorize(doc, binding, ["lead"]);
  if (!authorized.ok || authorized.value.status === "cancelled") return false;
  const seen = new Set<string>();
  let current = doc.tasks[taskId];
  while (current && !seen.has(current.id)) {
    if (current.id === binding.taskId) return true;
    seen.add(current.id);
    current = current.parentTaskId ? doc.tasks[current.parentTaskId] : undefined;
  }
  return false;
}

function topLevelTask(doc: WorkflowDocument, task: WorkflowTask): WorkflowTask {
  const seen = new Set<string>();
  while (task.parentTaskId && doc.tasks[task.parentTaskId] && !seen.has(task.id)) {
    seen.add(task.id);
    task = doc.tasks[task.parentTaskId]!;
  }
  return task;
}

function dependencyDiagnostics(doc: WorkflowDocument, ids = Object.keys(doc.tasks)): string[] {
  const included = new Set(ids);
  const diagnostics: string[] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  function visit(id: string): void {
    if (active.has(id)) {
      diagnostics.push(`Dependency cycle at ${id}`);
      return;
    }
    if (visited.has(id)) return;
    active.add(id);
    for (const dependency of doc.tasks[id]!.dependsOn) {
      if (!included.has(dependency) || !Object.hasOwn(doc.tasks, dependency))
        diagnostics.push(`Missing dependency: ${id} -> ${dependency}`);
      else visit(dependency);
    }
    active.delete(id);
    visited.add(id);
  }
  for (const id of ids) if (doc.tasks[id]) visit(id);
  return diagnostics;
}

const unresolved = (defect: WorkflowDefect) =>
  defect.state !== "resolved" && defect.state !== "cancelled";
const activeAttempt = (defect: WorkflowDefect) =>
  defect.attempts.find(
    (attempt) => attempt.status === "authorized" || attempt.status === "submitted",
  );
function unresolvedDefectsForTask(doc: WorkflowDocument, taskId: string): WorkflowDefect[] {
  return Object.values(doc.defects).filter(
    (defect) =>
      defect.responsibleTasks.includes(taskId) &&
      unresolved(defect) &&
      !hasCurrentResolution(doc, defect, taskId),
  );
}
function refreshTasks(
  doc: WorkflowDocument,
  responsibility: Pick<WorkflowDefect, "responsibleTasks">,
): void {
  for (const id of responsibility.responsibleTasks) {
    const task = doc.tasks[id]!;
    if (task.status === "cancelled") continue;
    const blockers = unresolvedDefectsForTask(doc, id);
    if (blockers.some((item) => item.state === "analysis-pending"))
      task.status = "analysis-pending";
    else if (blockers.some((item) => item.state === "human-required"))
      task.status = "human-required";
    else
      task.status =
        blockers.length === 0 &&
        task.verification.state === "passed" &&
        task.verification.revision === task.artifactRevision
          ? "verified"
          : "open";
  }
}
/** Older policy versions could persist a current pass alongside an unresolved responsibility. */
function reconcilePassedVerification(doc: WorkflowDocument, task: WorkflowTask): void {
  if (
    task.status !== "cancelled" &&
    task.verification.state === "passed" &&
    task.verification.revision === task.artifactRevision &&
    unresolvedDefectsForTask(doc, task.id).length > 0
  ) {
    task.verification = { state: "failed", revision: task.artifactRevision };
    refreshTasks(doc, { responsibleTasks: [task.id] });
  }
}
function finding(
  doc: WorkflowDocument,
  task: WorkflowTask,
  command: FindingCommand,
): Result<void, WorkflowError> {
  if (doc.defects[command.defectId])
    return failure("WORKFLOW_CONFLICT", "Defect ID already exists.");
  const responsibleTasks = [...new Set([task.id, ...(command.responsibleTasks ?? [])])];
  if (responsibleTasks.some((id) => !doc.tasks[id]))
    return failure("WORKFLOW_NOT_FOUND", "Responsible task does not exist.");
  doc.defects[command.defectId] = {
    id: command.defectId,
    responsibleTasks,
    discoveredAt: { eventKey: command.eventKey, revision: command.revision },
    summary: command.summary,
    evidence: command.evidence,
    automatedFailures: 0,
    locked: false,
    state: "open",
    attempts: [],
    analyses: {},
  };
  for (const id of responsibleTasks) {
    const responsible = doc.tasks[id]!;
    responsible.verification = {
      state: "failed",
      revision: responsible.artifactRevision,
    };
  }
  refreshTasks(doc, doc.defects[command.defectId]!);
  return ok(undefined);
}

/** Recomputable deliveries are state-derived; callers deliver only after durable commit. */
export function pendingDeliveries(doc: WorkflowDocument): WorkflowEffect[] {
  const effects: WorkflowEffect[] = [];
  for (const defect of Object.values(doc.defects)) {
    const taskIds = defect.responsibleTasks;
    const leads = [...new Set(taskIds.map((id) => doc.tasks[id]!.lead.profile))];
    if (defect.state === "analysis-pending")
      effects.push({
        kind: "notify-leads",
        defectId: defect.id,
        taskIds,
        profiles: leads,
      });
    if (defect.state === "human-required")
      effects.push({
        kind: "notify-root",
        defectId: defect.id,
        taskIds,
        profiles: [],
      });
    if (defect.attempts.some((attempt) => attempt.status === "interrupted" && !attempt.terminal))
      effects.push({
        kind: "needs-attention",
        defectId: defect.id,
        taskIds,
        profiles: leads,
      });
  }
  for (const task of Object.values(doc.tasks)) {
    if (task.status !== "cancelled" && task.verification.state === "awaiting-qa")
      effects.push({
        kind: "notify-qa",
        taskIds: [task.id],
        profiles: task.verifier ? [task.verifier.profile] : [],
      });
  }
  return effects;
}

function apply(doc: WorkflowDocument, command: Action): WorkflowPolicyResult {
  let task: WorkflowTask | undefined;
  if ("binding" in command && command.binding) {
    const roles: WorkflowBinding["role"][] =
      command.type === "finding" || command.type === "verdict"
        ? ["verifier"]
        : command.type === "submit"
          ? ["implementer"]
          : command.type === "admit"
            ? ["lead", "implementer"]
            : ["lead"];
    const authorized = authorize(doc, command.binding, roles);
    if (!authorized.ok) return authorized;
    task = authorized.value;
    if (task.status === "cancelled")
      return failure("WORKFLOW_NOT_AUTHORIZED", "Cancelled tasks cannot mutate workflow state.");
    if (command.binding.purpose === "analysis" && command.type !== "analysis")
      return failure("WORKFLOW_NOT_AUTHORIZED", "Analysis bindings can only publish analysis.");
  }
  if (command.type === "verdict" && command.defectId) {
    const defect = doc.defects[command.defectId];
    const attempt = defect?.attempts.find((item) => item.id === command.attemptId);
    if (
      !defect ||
      !attempt ||
      attempt.submittedTaskId !== task!.id ||
      !defect.responsibleTasks.includes(task!.id)
    )
      return failure("WORKFLOW_NOT_AUTHORIZED", "Verdict binding does not own this attempt.");
  }
  if ("provenance" in command) {
    // Continuation is a self-join from direct user input; the host validates matching scope.
    const allowed =
      command.type === "continuation"
        ? command.provenance.conversationId === command.member.conversationId
        : doc.members.some((member) => member.conversationId === command.provenance.conversationId);
    if (command.provenance.kind !== "user-command" || !allowed)
      return failure(
        "WORKFLOW_NOT_AUTHORIZED",
        command.type === "continuation"
          ? "Continuation must be requested directly by the joining conversation's user."
          : "User command must originate in a workflow member conversation.",
      );
  }
  const reserved = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype"]);
  const ids = [
    command.eventKey,
    ...("defectId" in command && command.defectId ? [command.defectId] : []),
    ...("attemptId" in command && command.attemptId ? [command.attemptId] : []),
    ...("artifactId" in command ? [command.artifactId] : []),
    ...(command.type === "scope" ? command.branches.map((branch) => branch.id) : []),
    ...(command.type === "subtasks" ? command.subtasks.map((subtask) => subtask.id) : []),
    ...(command.type === "split-task" || command.type === "continue-task" ? [command.task.id] : []),
  ];
  if (ids.some((id) => !id || reserved.has(id)))
    return failure(
      "WORKFLOW_CONFLICT",
      "Workflow IDs and event keys must be nonempty and cannot name object internals.",
    );
  const previous = Object.hasOwn(doc.processed, command.eventKey)
    ? doc.processed[command.eventKey]
    : undefined;
  if (previous) return ok({ doc, effects: [], outcome: previous.outcome });
  if (Object.keys(doc.processed).length >= MAX_PROCESSED_EVENTS)
    return failure("WORKFLOW_CONFLICT", "Workflow safety ledger is full; refusing mutation.");
  const next = structuredClone(doc);
  task = task ? next.tasks[task.id]! : undefined;
  let outcome: WorkflowOutcome = { kind: "applied" };
  if (
    (command.type === "finding" || command.type === "verdict") &&
    command.revision !== task!.artifactRevision
  ) {
    outcome = { kind: "stale", code: "WORKFLOW_STALE" };
  } else {
    const result = transition(next, task, command);
    if (!result.ok) return result;
    outcome = result.value;
  }
  next.revision++;
  next.processed[command.eventKey] = { docRevision: next.revision, outcome };
  next.log.push({
    at: command.at,
    eventKey: command.eventKey,
    message: `${command.type}: ${outcome.kind}`,
  });
  next.log = next.log.slice(-256);
  return ok({
    doc: next,
    effects: outcome.kind === "applied" ? pendingDeliveries(next) : [],
    outcome,
  });
}

function transition(
  doc: WorkflowDocument,
  task: WorkflowTask | undefined,
  command: Action,
): Result<WorkflowOutcome, WorkflowError> {
  switch (command.type) {
    case "finding": {
      const result = finding(doc, task!, command);
      return result.ok ? ok({ kind: "applied", ref: command.defectId }) : result;
    }
    case "submit": {
      const target = task!;
      const blockers = Object.values(doc.defects).filter(
        (item) => item.responsibleTasks.includes(target.id) && unresolved(item),
      );
      if (command.defectId) {
        const defect = doc.defects[command.defectId];
        const attempt = defect?.attempts.find((item) => item.id === command.attemptId);
        if (
          !defect ||
          !defect.responsibleTasks.includes(target.id) ||
          !attempt ||
          attempt.submittedTaskId !== target.id ||
          attempt.status !== "authorized" ||
          attempt.origin !== "automated"
        )
          return failure(
            "WORKFLOW_NOT_AUTHORIZED",
            "Fix requires a committed authorized automated attempt.",
          );
        if (defect.locked || defect.automatedFailures >= 3 || blockers.some((item) => item.locked))
          return failure("WORKFLOW_REPAIR_LOCKED", "Automated repair is locked.");
        attempt.submittedRevision = target.artifactRevision + 1;
        attempt.status = "submitted";
        defect.state = "awaiting-recheck";
      } else if (blockers.length)
        return failure(
          "WORKFLOW_NOT_AUTHORIZED",
          "Implementation cannot bypass unresolved defects.",
        );
      target.artifactRevision++;
      target.verification = {
        state: "awaiting-qa",
        revision: target.artifactRevision,
      };
      return ok({
        kind: "applied",
        ...(command.attemptId ? { ref: command.attemptId } : {}),
      });
    }
    case "verdict": {
      const target = task!;
      if (!command.defectId) {
        if (
          target.verification.state !== "awaiting-qa" ||
          target.verification.revision !== command.revision
        )
          return failure("WORKFLOW_CONFLICT", "No current implementation awaits QA.");
        if (command.verdict === "blocked") return ok({ kind: "applied" });
        target.verification = {
          state:
            command.verdict === "pass" && unresolvedDefectsForTask(doc, target.id).length === 0
              ? "passed"
              : "failed",
          revision: command.revision,
        };
        if (command.verdict === "fail") {
          const created = finding(doc, target, {
            ...command,
            defectId: `${target.id}-initial-${command.revision}`,
            summary: "Initial implementation QA failed",
            evidence: command.evidence,
          });
          if (!created.ok) return created;
        }
        refreshTasks(doc, { responsibleTasks: [target.id] });
        return ok({ kind: "applied", terminal: command.verdict });
      }
      const defect = doc.defects[command.defectId];
      const attempt = defect?.attempts.find((item) => item.id === command.attemptId);
      if (
        !defect ||
        !defect.responsibleTasks.includes(target.id) ||
        !attempt ||
        attempt.submittedTaskId !== target.id
      )
        return failure(
          "WORKFLOW_NOT_AUTHORIZED",
          "Verdict does not belong to this task or attempt.",
        );
      if (attempt.terminal)
        return ok({
          kind: "terminal",
          terminal: attempt.terminal,
          ref: attempt.id,
        });
      if (
        attempt.status !== "submitted" ||
        attempt.submittedRevision !== command.revision ||
        !unresolved(defect)
      )
        return failure(
          "WORKFLOW_NOT_AUTHORIZED",
          "Attempt is not awaiting a verdict for this revision.",
        );
      attempt.verdicts.push({
        eventKey: command.eventKey,
        verdict: command.verdict,
        revision: command.revision,
        at: command.at,
        evidence: command.evidence,
      });
      if (command.verdict === "blocked") return ok({ kind: "applied", ref: attempt.id });
      attempt.terminal = command.verdict;
      attempt.status = "closed";
      if (command.verdict === "pass") {
        defect.resolutions ??= {};
        defect.resolutions[target.id] = {
          revision: command.revision,
          eventKey: command.eventKey,
          at: command.at,
        };
        defect.state = defect.responsibleTasks.every(
          (id) => doc.tasks[id]!.status === "cancelled" || hasCurrentResolution(doc, defect, id),
        )
          ? "resolved"
          : defect.locked || attempt.origin === "manual" || defect.state === "human-required"
            ? "human-required"
            : "open";
      } else if (attempt.origin === "manual") defect.state = "human-required";
      else {
        defect.automatedFailures++;
        if (defect.automatedFailures >= 3) {
          defect.locked = true;
          defect.state = "analysis-pending";
          defect.analyses = {};
        } else defect.state = "open";
      }
      // Record the receipt first; another unresolved responsibility still requires failed QA.
      target.verification = {
        state:
          command.verdict === "pass" && unresolvedDefectsForTask(doc, target.id).length === 0
            ? "passed"
            : "failed",
        revision: command.revision,
      };
      refreshTasks(doc, defect);
      return ok({
        kind: "applied",
        terminal: command.verdict,
        ref: attempt.id,
      });
    }
    case "admit": {
      const defect = doc.defects[command.defectId];
      if (!defect || !defect.responsibleTasks.includes(task!.id) || !unresolved(defect))
        return failure(
          "WORKFLOW_NOT_AUTHORIZED",
          "Repair defect is not an unresolved task responsibility.",
        );
      if (
        defect.locked ||
        defect.automatedFailures >= 3 ||
        defect.state === "human-required" ||
        Object.values(doc.defects).some(
          (item) => item.responsibleTasks.includes(task!.id) && item.locked && unresolved(item),
        )
      )
        return failure(
          "WORKFLOW_REPAIR_LOCKED",
          "Three automated failures require human intervention.",
        );
      reconcilePassedVerification(doc, task!);
      if (
        activeAttempt(defect) ||
        defect.attempts.some((item) => item.id === command.attemptId) ||
        task!.verification.state !== "failed" ||
        task!.verification.revision !== task!.artifactRevision
      )
        return failure(
          "WORKFLOW_CONFLICT",
          "Repair requires a current failed verdict and no active attempt.",
        );
      defect.attempts.push({
        id: command.attemptId,
        origin: "automated",
        submittedTaskId: task!.id,
        authorizedAtDocRevision: doc.revision + 1,
        status: "authorized",
        verdicts: [],
      });
      defect.authorizedBy = {
        docRevision: doc.revision + 1,
        eventKey: command.eventKey,
      };
      defect.state = "repair-authorized";
      return ok({ kind: "applied", ref: command.attemptId });
    }
    case "analysis": {
      if (!Value.Check(workflowAnalysisSchema, command.analysis))
        return failure("WORKFLOW_CONFLICT", "Invalid analysis document.");
      const defect = doc.defects[command.defectId];
      if (
        !defect ||
        !defect.locked ||
        !defect.responsibleTasks.includes(task!.id) ||
        !["analysis-pending", "human-required"].includes(defect.state)
      )
        return failure(
          "WORKFLOW_NOT_AUTHORIZED",
          "Analysis requires a locked defect and a responsible lead.",
        );
      defect.analyses[task!.id] = structuredClone(command.analysis);
      defect.state = defect.responsibleTasks.every(
        (id) => doc.tasks[id]!.status === "cancelled" || Object.hasOwn(defect.analyses, id),
      )
        ? "human-required"
        : "analysis-pending";
      refreshTasks(doc, defect);
      return ok({ kind: "applied", ref: defect.id });
    }
    case "plan": {
      if (
        task!.kind !== "plan" ||
        command.author.role !== "lead" ||
        command.author.profile !== task!.lead.profile
      )
        return failure(
          "WORKFLOW_NOT_AUTHORIZED",
          "Only the assigned planning lead may publish a plan.",
        );
      if (doc.manifest?.branches && !doc.manifest.branches.includes(topLevelTask(doc, task!).id))
        return failure("WORKFLOW_NOT_AUTHORIZED", "Task is not in the current planning scope.");
      const reviewed = new Set<string>();
      for (const receipt of command.reviewedDependencies ?? []) {
        const upstream = doc.artifacts[receipt.artifactId];
        if (
          reviewed.has(receipt.artifactId) ||
          !upstream ||
          !task!.dependsOn.includes(upstream.taskId) ||
          !upstream.revisions.some((item) => item.revision === receipt.revision)
        )
          return failure("WORKFLOW_CONFLICT", "Invalid reviewed dependency reference.");
        reviewed.add(receipt.artifactId);
      }
      const plan = validateTaskPlan(command.plan);
      if (!plan.ok || !Value.Check(planReviewSchema, command.review))
        return failure("WORKFLOW_CONFLICT", "Invalid task plan or review.");
      const existing = doc.artifacts[command.artifactId];
      if (existing && existing.taskId !== task!.id)
        return failure("WORKFLOW_CONFLICT", "Artifact belongs to another task.");
      const artifact = existing ?? { taskId: task!.id, revisions: [] };
      const revision = (artifact.revisions.at(-1)?.revision ?? 0) + 1;
      const external = [
        ...new Set(
          task!.dependsOn.filter((id) => !plan.value.tasks.some((item) => item.id === id)),
        ),
      ];
      const summary = `Goal: ${plan.value.goal.slice(0, 256)}; tasks: ${plan.value.tasks.length}; external dependencies: ${external.join(", ").slice(0, 256) || "none"}; warnings: ${command.review.warnings.length}`;
      artifact.revisions.push({
        revision,
        author: { ...command.author },
        publishedAt: command.at,
        docRevision: doc.revision + 1,
        ...(command.reviewedDependencies === undefined
          ? {}
          : { dependencies: structuredClone(command.reviewedDependencies) }),
        summary,
        body: { plan: plan.value, review: command.review },
      });
      doc.artifacts[command.artifactId] = artifact;
      task!.planArtifact = command.artifactId;
      return ok({
        kind: "applied",
        ref: `${command.artifactId}@${revision}`,
        summary,
      });
    }
    case "scope": {
      const diagnostics: string[] = [];
      const seen = new Set<string>();
      for (const branch of command.branches) {
        const existing = doc.tasks[branch.id];
        if (
          seen.has(branch.id) ||
          doc.defects[branch.id] ||
          (existing &&
            (existing.kind !== "plan" || existing.parentTaskId || existing.status === "cancelled"))
        ) {
          diagnostics.push(`Duplicate task ID: ${branch.id}`);
          seen.add(branch.id);
          continue;
        }
        seen.add(branch.id);
        if (!command.knownProfiles.includes(branch.lead.profile))
          diagnostics.push(`Unknown profile: ${branch.lead.profile}`);
        if (existing)
          Object.assign(existing, structuredClone(branch), { declaredRevision: doc.revision + 1 });
        else
          doc.tasks[branch.id] = {
            ...structuredClone(branch),
            declaredRevision: doc.revision + 1,
            kind: "plan",
            assignmentVersion: 0,
            artifactRevision: 0,
            verification: { state: "unverified" },
            status: "open",
          };
      }
      diagnostics.push(...dependencyDiagnostics(doc, [...seen]));
      doc.manifest = {
        goal: command.goal,
        updatedAt: command.at,
        declaredAt: command.at,
        declaredRevision: doc.revision + 1,
        branches: [...seen],
        diagnostics,
      };
      return ok({
        kind: "applied",
        summary: diagnostics.join("; ").slice(0, 4096) || "Scope declared",
      });
    }
    case "subtasks": {
      const parent = doc.tasks[command.parentTaskId];
      if (!parent) return failure("WORKFLOW_NOT_FOUND", "Parent task not found.");
      if (command.binding && command.binding.taskId !== parent.id)
        return failure(
          "WORKFLOW_NOT_AUTHORIZED",
          "Only the parent task's current lead may declare its subtasks.",
        );
      const diagnostics: string[] = [];
      for (const subtask of command.subtasks) {
        if (Object.hasOwn(doc.tasks, subtask.id) || Object.hasOwn(doc.defects, subtask.id)) {
          diagnostics.push(`Duplicate task ID: ${subtask.id}`);
          continue;
        }
        const lead = subtask.lead ?? parent.lead;
        for (const assignee of [lead, subtask.implementer, subtask.verifier])
          if (assignee && !command.knownProfiles.includes(assignee.profile))
            diagnostics.push(`Unknown profile: ${assignee.profile}`);
        doc.tasks[subtask.id] = {
          ...structuredClone(subtask),
          lead: { ...lead },
          parentTaskId: parent.id,
          assignmentVersion: 0,
          artifactRevision: 0,
          verification: { state: "unverified" },
          status: "open",
        };
      }
      const currentTasks = doc.manifest?.branches
        ? Object.values(doc.tasks)
            .filter((item) => doc.manifest!.branches!.includes(topLevelTask(doc, item).id))
            .map((item) => item.id)
        : Object.keys(doc.tasks);
      diagnostics.push(...dependencyDiagnostics(doc, currentTasks));
      doc.manifest = {
        ...doc.manifest,
        goal: doc.manifest?.goal ?? parent.title,
        updatedAt: command.at,
        diagnostics: [...(doc.manifest?.diagnostics ?? []), ...diagnostics],
      };
      return ok({
        kind: "applied",
        summary: diagnostics.join("; ").slice(0, 4096) || "Subtasks declared",
      });
    }
    case "reassign": {
      const target = doc.tasks[command.taskId];
      if (!target) return failure("WORKFLOW_NOT_FOUND", "Task not found.");
      target[command.role] = { profile: command.profile };
      target.assignmentVersion++;
      for (const defect of Object.values(doc.defects)) {
        if (!defect.responsibleTasks.includes(target.id)) continue;
        for (const attempt of defect.attempts)
          if (
            command.role !== "verifier" &&
            attempt.origin === "automated" &&
            attempt.status === "authorized"
          )
            attempt.status = "interrupted";
        if (command.role === "lead" && defect.locked && unresolved(defect)) {
          delete defect.analyses[target.id];
          defect.state = "analysis-pending";
        }
        refreshTasks(doc, defect);
      }
      return ok({ kind: "applied", ref: target.id });
    }
    case "continue-task":
    case "split-task": {
      const source = doc.tasks[command.taskId];
      if (!source || doc.tasks[command.task.id])
        return failure("WORKFLOW_CONFLICT", "Source task missing or new task ID already exists.");
      const target = structuredClone(command.task);
      // A linked task receives a fresh host schedule, never the source task's admission state.
      delete target.schedule;
      target[command.type === "continue-task" ? "continues" : "splitFrom"] = source.id;
      target.artifactRevision = source.artifactRevision;
      target.verification = { state: "unverified" };
      target.status = "open";
      doc.tasks[target.id] = target;
      for (const defect of Object.values(doc.defects))
        if (defect.responsibleTasks.includes(source.id)) {
          defect.responsibleTasks.push(target.id);
          if (defect.state !== "cancelled") {
            target.verification = {
              state: "failed",
              revision: target.artifactRevision,
            };
            if (defect.locked) defect.state = "analysis-pending";
            else if (defect.state === "resolved") defect.state = "open";
          }
          refreshTasks(doc, defect);
        }
      return ok({ kind: "applied", ref: target.id });
    }
    case "human-recheck": {
      const selected = doc.defects[command.id];
      if (selected && selected.responsibleTasks.length > 1)
        return failure(
          "WORKFLOW_CONFLICT",
          `Multiple responsible tasks: ${selected.responsibleTasks.join(", ")}. Use /repair recheck <taskId>.`,
        );
      const target = doc.tasks[selected?.responsibleTasks[0] ?? command.id];
      if (!target || target.status === "cancelled")
        return failure("WORKFLOW_NOT_FOUND", "No active task for recheck.");
      const defects = Object.values(doc.defects).filter(
        (item) => item.responsibleTasks.includes(target.id) && unresolved(item),
      );
      if (!defects.length)
        return failure("WORKFLOW_NOT_FOUND", "No unresolved defect for recheck.");
      const pending = defects.map(activeAttempt);
      if (
        pending.every(
          (attempt) =>
            attempt?.origin === "manual" &&
            attempt.status === "submitted" &&
            attempt.submittedTaskId === target.id &&
            attempt.submittedRevision === target.artifactRevision,
        )
      )
        return ok({ kind: "duplicate", ref: pending[0]!.id });
      if (
        pending.some(Boolean) ||
        defects.some((defect) =>
          defect.attempts.some((attempt) => attempt.id === command.attemptId),
        )
      )
        return failure(
          "WORKFLOW_CONFLICT",
          "Another repair attempt is active or this attempt ID was used.",
        );
      const revision = target.artifactRevision + 1;
      for (const defect of defects) {
        defect.attempts.push({
          id: command.attemptId,
          origin: "manual",
          submittedTaskId: target.id,
          authorizedAtDocRevision: doc.revision + 1,
          submittedRevision: revision,
          ...(command.worktreeFingerprint
            ? { worktreeFingerprint: command.worktreeFingerprint }
            : {}),
          status: "submitted",
          verdicts: [],
        });
        defect.authorizedBy = {
          docRevision: doc.revision + 1,
          eventKey: command.eventKey,
        };
        defect.state = "awaiting-recheck";
      }
      target.artifactRevision = revision;
      target.verification = { state: "awaiting-qa", revision };
      target.status = "human-required";
      return ok({ kind: "applied", ref: command.attemptId });
    }
    case "human-cancel": {
      const target = doc.tasks[command.id];
      const selected = doc.defects[command.id];
      if (!target && !selected) return failure("WORKFLOW_NOT_FOUND", "Task or defect not found.");
      if (target) target.status = "cancelled";
      for (const defect of Object.values(doc.defects))
        if (defect === selected || (target && defect.responsibleTasks.includes(target.id))) {
          const remaining = defect.responsibleTasks.filter(
            (id) => doc.tasks[id]!.status !== "cancelled",
          );
          if (defect === selected || remaining.length === 0) defect.state = "cancelled";
          else if (
            unresolved(defect) &&
            remaining.every((id) => hasCurrentResolution(doc, defect, id))
          )
            defect.state = "resolved";
          for (const attempt of defect.attempts)
            if (
              (defect.state === "cancelled" || attempt.submittedTaskId === target?.id) &&
              (attempt.status === "authorized" || attempt.status === "submitted")
            )
              attempt.status = "interrupted";
          refreshTasks(doc, defect);
        }
      return ok({ kind: "applied", ref: command.id });
    }
    case "continuation": {
      const existing = doc.members.find(
        (member) =>
          member.conversationId === command.member.conversationId ||
          member.sessionFile === command.member.sessionFile,
      );
      if (existing)
        return existing.conversationId === command.member.conversationId &&
          existing.cwd === command.member.cwd &&
          existing.sessionFile === command.member.sessionFile
          ? ok({ kind: "duplicate" })
          : failure(
              "WORKFLOW_CONFLICT",
              "Continuation identity already belongs to another member.",
            );
      doc.members.push({
        ...command.member,
        via: "user-continuation",
        addedAt: command.at,
      });
      return ok({ kind: "applied" });
    }
    case "recover": {
      for (const defect of Object.values(doc.defects))
        for (const attempt of defect.attempts)
          if (!attempt.terminal && attempt.status === "authorized") attempt.status = "interrupted";
      for (const target of Object.values(doc.tasks)) reconcilePassedVerification(doc, target);
      if (doc.version === 2 && doc.scheduler) {
        for (const invocation of doc.scheduler.invocations) {
          if (
            invocation.kind !== "execute" ||
            invocation.state === "completed" ||
            invocation.state === "cancelled"
          )
            continue;
          invocation.state = "paused";
          for (const admission of Object.values(doc.scheduler.admissions)) {
            if (
              admission.invocationId !== invocation.id ||
              !["reserved", "launching", "running"].includes(admission.state)
            )
              continue;
            admission.state = "interrupted";
            doc.tasks[admission.taskId]!.schedule = {
              state: "interrupted",
              since: command.at,
              invocationId: invocation.id,
              reason: "restart-requires-explicit-resume",
            };
          }
        }
      }
      return ok({ kind: "applied" });
    }
  }
}

export const recordFinding = (
  doc: WorkflowDocument,
  command: FindingCommand,
): WorkflowPolicyResult => apply(doc, { ...command, type: "finding" });
export const submitImplementation = (
  doc: WorkflowDocument,
  command: SubmitCommand,
): WorkflowPolicyResult => apply(doc, { ...command, type: "submit" });
export const submitFix = submitImplementation;
export const recordVerdict = (
  doc: WorkflowDocument,
  command: VerdictCommand,
): WorkflowPolicyResult => apply(doc, { ...command, type: "verdict" });
export const admitRepair = (
  doc: WorkflowDocument,
  command: AdmitRepairCommand,
): WorkflowPolicyResult => apply(doc, { ...command, type: "admit" });
export const recordAnalysis = (
  doc: WorkflowDocument,
  command: AnalysisCommand,
): WorkflowPolicyResult => apply(doc, { ...command, type: "analysis" });
export const publishPlanArtifact = (
  doc: WorkflowDocument,
  command: PlanArtifactCommand,
): WorkflowPolicyResult => apply(doc, { ...command, type: "plan" });
export const declareScope = (doc: WorkflowDocument, command: ScopeCommand): WorkflowPolicyResult =>
  apply(doc, { ...command, type: "scope" });
export const declareSubtasks = (
  doc: WorkflowDocument,
  command: SubtasksCommand,
): WorkflowPolicyResult => apply(doc, { ...command, type: "subtasks" });
export const reassign = (doc: WorkflowDocument, command: ReassignCommand): WorkflowPolicyResult =>
  apply(doc, { ...command, type: "reassign" });
export const continueTask = (
  doc: WorkflowDocument,
  command: LinkTaskCommand,
): WorkflowPolicyResult => apply(doc, { ...command, type: "continue-task" });
export const splitTask = (doc: WorkflowDocument, command: LinkTaskCommand): WorkflowPolicyResult =>
  apply(doc, { ...command, type: "split-task" });
export const humanRecheck = (
  doc: WorkflowDocument,
  command: HumanRecheckCommand,
): WorkflowPolicyResult => apply(doc, { ...command, type: "human-recheck" });
export const humanCancel = (doc: WorkflowDocument, command: Human): WorkflowPolicyResult =>
  apply(doc, { ...command, type: "human-cancel" });
export const addContinuationMember = (
  doc: WorkflowDocument,
  command: ContinuationCommand,
): WorkflowPolicyResult => apply(doc, { ...command, type: "continuation" });
export const recoverWorkflow = (
  doc: WorkflowDocument,
  command: WorkflowEvent,
): WorkflowPolicyResult => apply(doc, { ...command, type: "recover" });
export function humanStatus(
  doc: WorkflowDocument,
  provenance: UserCommandProvenance,
): Result<WorkflowDocument, WorkflowError> {
  return provenance.kind === "user-command" &&
    doc.members.some((member) => member.conversationId === provenance.conversationId)
    ? ok(doc)
    : failure("WORKFLOW_NOT_AUTHORIZED", "Status requires member user-command provenance.");
}
export type { WorkflowMutation };
