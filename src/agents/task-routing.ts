import { WorkflowError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { TaskSpawnBinding } from "./subagent-tools.ts";
import type { SubagentNotice } from "./subagent-notifications.ts";
import {
  renderRootSummary,
  renderWorkflowStatus,
  type WorkflowBinding,
  type WorkflowDocument,
  type WorkflowEffect,
} from "./task-workflow.ts";
import { isTaskLead, pendingDeliveries } from "./verification-policy.ts";

const failure = (message: string) => err(new WorkflowError("WORKFLOW_NOT_AUTHORIZED", message));
export function authorizeTaskBinding(
  doc: WorkflowDocument,
  binding: WorkflowBinding,
  profile: string,
): Result<void, WorkflowError> {
  const task = doc.tasks[binding.taskId];
  if (
    binding.workflowId !== doc.workflowId ||
    !task ||
    task.assignmentVersion !== binding.assignmentVersion ||
    task.status === "cancelled"
  )
    return failure("Workflow binding is missing, revoked or cancelled.");
  if (binding.role !== "worker" && task[binding.role]?.profile !== profile)
    return failure("Profile is not assigned to this task role.");
  return ok(undefined);
}

export type TaskSpawner =
  | { kind: "root" }
  | { kind: "bound"; binding: WorkflowBinding; profile: string }
  | { kind: "unbound" };

export function resolveTaskBinding(
  doc: WorkflowDocument,
  requested: Omit<TaskSpawnBinding, "purpose"> & { purpose?: "planning" | "analysis" },
  profile: string,
  spawner: TaskSpawner,
): Result<WorkflowBinding, WorkflowError> {
  const task = doc.tasks[requested.id];
  if (!task)
    return err(
      new WorkflowError("WORKFLOW_NOT_FOUND", "Task not found in this conversation's workflow."),
    );
  if (spawner.kind === "unbound") return failure("Unbound runs cannot acquire workflow roles.");
  if (spawner.kind === "bound") {
    const allowed = authorizeTaskBinding(doc, spawner.binding, spawner.profile);
    if (!allowed.ok) return allowed;
    if (spawner.binding.role !== "lead" || !isTaskLead(doc, spawner.binding, task.id))
      return failure("Only a current lead may spawn bound runs within its task tree.");
  }
  if (task.kind === "plan" && requested.role === "implementer")
    return failure("Plan-kind tasks are read-only and cannot bind an implementer.");
  let purpose =
    spawner.kind === "bound" ? (spawner.binding.purpose ?? requested.purpose) : requested.purpose;
  if (task.kind === "plan" && (requested.role === "lead" || requested.role === "worker"))
    purpose = "planning";
  if ((requested.role === "worker" || requested.role === "lead") && !purpose) {
    const allowed = guardImplementation(doc, task.id);
    if (!allowed.ok) return allowed;
  }
  if (purpose && requested.role !== "lead" && requested.role !== "worker")
    return failure("Read-only purpose requires a lead or its worker.");
  const binding: WorkflowBinding = {
    workflowId: doc.workflowId,
    taskId: task.id,
    role: requested.role,
    assignmentVersion: task.assignmentVersion,
    ...(purpose ? { purpose } : {}),
  };
  const allowed = authorizeTaskBinding(doc, binding, profile);
  return allowed.ok ? ok(Object.freeze(binding)) : allowed;
}

export function guardImplementation(
  doc: WorkflowDocument,
  taskId: string,
): Result<void, WorkflowError> {
  const task = doc.tasks[taskId];
  if (!task) return err(new WorkflowError("WORKFLOW_NOT_FOUND", "Task not found."));
  if (task.status === "cancelled") return failure("Task is cancelled.");
  if (
    ["analysis-pending", "human-required"].includes(task.status) ||
    Object.values(doc.defects).some(
      (defect) =>
        defect.responsibleTasks.includes(taskId) &&
        defect.state !== "resolved" &&
        defect.state !== "cancelled" &&
        (defect.locked || defect.automatedFailures >= 3),
    )
  )
    return err(
      new WorkflowError(
        "WORKFLOW_REPAIR_LOCKED",
        "Automated repair is locked. Only the user's /repair command authorizes manual handling.",
      ),
    );
  return ok(undefined);
}

/** Text matching is deliberately conservative; aliases and semantic paraphrases are not detectable. */
export function guardUnboundTask(doc: WorkflowDocument, text: string): Result<void, WorkflowError> {
  for (const task of Object.values(doc.tasks)) {
    const defectIds = Object.values(doc.defects)
      .filter((defect) => defect.responsibleTasks.includes(task.id))
      .map((defect) => defect.id);
    if (![task.id, ...defectIds].some((id) => text.includes(id))) continue;
    const allowed = guardImplementation(doc, task.id);
    if (!allowed.ok) return allowed;
  }
  return ok(undefined);
}

export type TaskRecipient = {
  id: string;
  root: boolean;
  workflowId: string;
  binding?: WorkflowBinding;
  profile?: string;
  notify: (
    notice: SubagentNotice,
    current: () => boolean,
    delivered: (accepted?: boolean) => void,
  ) => void;
  current: () => boolean;
};

function isResponsible(
  doc: WorkflowDocument,
  recipient: TaskRecipient,
  taskIds: readonly string[],
): boolean {
  const binding = recipient.binding;
  if (recipient.root || !binding) return false;
  return binding.role === "lead"
    ? taskIds.some((id) => isTaskLead(doc, binding, id))
    : taskIds.includes(binding.taskId) && ["implementer", "verifier"].includes(binding.role);
}

function canHandleEffect(
  doc: WorkflowDocument,
  recipient: TaskRecipient,
  kind: WorkflowEffect["kind"],
  taskId: string,
): boolean {
  const binding = recipient.binding;
  if (recipient.root || !binding) return false;
  return (
    isTaskLead(doc, binding, taskId) ||
    (kind === "notify-qa" && binding.role === "verifier" && binding.taskId === taskId)
  );
}

function topLevelTask(doc: WorkflowDocument, taskId: string): string {
  const visited = new Set<string>();
  let id = taskId;
  while (doc.tasks[id]?.parentTaskId && !visited.has(id)) {
    visited.add(id);
    id = doc.tasks[id]!.parentTaskId!;
  }
  return id;
}

/** Delivery is observation only: recipients never gain ownership or execution rights. */
export class TaskRouting {
  private readonly delivered = new Set<string>();
  private readonly queued = new Set<string>();

  deliver(
    doc: WorkflowDocument,
    eventKey: string,
    effects: readonly WorkflowEffect[],
    recipients: readonly TaskRecipient[],
  ): Result<void, WorkflowError> {
    for (const recipient of recipients) {
      if (recipient.workflowId !== doc.workflowId)
        return failure("Recipient belongs to another workflow.");
      if (!recipient.root) {
        if (!recipient.binding || !recipient.profile)
          return failure("Recipient has no host binding.");
        const allowed = authorizeTaskBinding(doc, recipient.binding, recipient.profile);
        if (!allowed.ok) return allowed;
      }
    }
    const currentRecipients = recipients.filter((recipient) => recipient.current());
    const rootEffects = effects.filter(
      (effect) =>
        effect.kind === "notify-root" ||
        new Set(effect.taskIds.map((id) => topLevelTask(doc, id))).size > 1 ||
        effect.taskIds.some(
          (taskId) =>
            !currentRecipients.some((recipient) =>
              canHandleEffect(doc, recipient, effect.kind, taskId),
            ),
        ),
    );
    for (const recipient of currentRecipients) {
      const recipientEffects = recipient.root ? rootEffects : effects;
      const taskIds = [...new Set(recipientEffects.flatMap((effect) => effect.taskIds))];
      if (recipientEffects.length === 0) continue;
      if (!recipient.root && !isResponsible(doc, recipient, taskIds)) continue;
      const key = `${recipient.id}:${eventKey}`;
      if (this.delivered.has(key) || this.queued.has(key)) continue;
      this.queued.add(key);
      const detail = taskIds
        .map((id) => {
          const lines = [renderWorkflowStatus(doc, id)];
          if (doc.tasks[id]?.verification.state === "awaiting-qa")
            lines.unshift(`QA recheck of revision ${doc.tasks[id]!.artifactRevision} is required.`);
          for (const defect of Object.values(doc.defects).filter((item) =>
            item.responsibleTasks.includes(id),
          )) {
            const evidence = defect.attempts.at(-1)?.verdicts.at(-1)?.evidence ?? defect.evidence;
            lines.push(
              `QA evidence ${defect.id}: ${evidence.replace(/[\p{Cc}\p{Cf}]+/gu, " ").slice(0, 1024)}`,
            );
            if (
              defect.attempts.some(
                (attempt) => attempt.status === "interrupted" && !attempt.terminal,
              )
            )
              lines.push(
                "Recovery attention: an authorized repair was interrupted. No work was replayed and no failure was counted.",
              );
          }
          return lines.join("\n");
        })
        .join("\n")
        .slice(0, 12000);
      const defectIds = [...new Set(recipientEffects.flatMap((effect) => effect.defectId ?? []))];
      const rootActivity: string[] = [];
      if (recipient.root) {
        const awaitingQa = taskIds.find(
          (id) => doc.tasks[id]?.verification.state === "awaiting-qa",
        );
        if (awaitingQa)
          rootActivity.push(
            `QA recheck of revision ${doc.tasks[awaitingQa]!.artifactRevision} is required.`,
          );
        if (
          defectIds.some((id) =>
            doc.defects[id]?.attempts.some(
              (attempt) => attempt.status === "interrupted" && !attempt.terminal,
            ),
          )
        )
          rootActivity.push(
            "Recovery attention: an authorized repair was interrupted. No work was replayed and no failure was counted.",
          );
      }
      const text = recipient.root
        ? [
            ...rootActivity,
            defectIds.length
              ? defectIds.map((id) => renderRootSummary(doc, id)).join("\n")
              : detail,
          ]
            .join("\n")
            .slice(0, 2000)
        : detail;
      recipient.notify(
        {
          type: "workflow",
          id: doc.workflowId,
          agent: "workflow host",
          eventKey,
          taskIds,
          message: text,
        },
        () => recipient.current() && !this.delivered.has(key),
        (accepted = true) => {
          this.queued.delete(key);
          if (accepted) this.delivered.add(key);
        },
      );
    }
    return ok(undefined);
  }

  /** Rebuild notices from durable facts, including QA findings before the failure limit. */
  redeliver(
    doc: WorkflowDocument,
    recipients: readonly TaskRecipient[],
  ): Result<void, WorkflowError> {
    for (const defect of Object.values(doc.defects)) {
      const last = defect.attempts.at(-1);
      const event =
        last?.verdicts.at(-1)?.eventKey ??
        defect.authorizedBy?.eventKey ??
        defect.discoveredAt.eventKey;
      const result = this.deliver(
        doc,
        `${event}:${defect.state}`,
        [
          {
            kind: defect.state === "human-required" ? "notify-root" : "notify-leads",
            taskIds: defect.responsibleTasks,
            profiles: [],
            defectId: defect.id,
          },
        ],
        recipients,
      );
      if (!result.ok) return result;
    }
    for (const effect of pendingDeliveries(doc)) {
      if (
        effect.defectId ||
        (effect.kind === "notify-qa" &&
          effect.taskIds.every((id) =>
            Object.values(doc.defects).some(
              (defect) =>
                defect.responsibleTasks.includes(id) &&
                defect.attempts.some((attempt) => attempt.status === "submitted"),
            ),
          ))
      )
        continue;
      const key = effect.taskIds.map((id) => `${id}@${doc.tasks[id]?.artifactRevision}`).join(",");
      const result = this.deliver(
        doc,
        `${effect.kind}:${effect.defectId ?? key}`,
        [effect],
        recipients,
      );
      if (!result.ok) return result;
    }
    return ok(undefined);
  }
}
