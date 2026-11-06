import { createHash } from "node:crypto";
import { WorkflowError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { UserCommandProvenance } from "./repair-command.ts";
import type { WorkflowDocument } from "./task-workflow.ts";
import type { EffectiveProfileSnapshot } from "./effective-profile.ts";
import type { WorkflowApproval, WorkflowConsent } from "./workflow-consent-schema.ts";
import { validateTaskPlan } from "./task-plan.ts";
import { planReviewSchema } from "./task-plan-store.ts";
import { Value } from "typebox/value";

const conflict = (message: string) => err(new WorkflowError("WORKFLOW_CONFLICT", message));

/** Approval covers a dependency-closed, explicit set of assigned implementation tasks. */
export function executionScope(
  doc: WorkflowDocument,
  requested: readonly string[],
): Result<string[], WorkflowError> {
  const roots =
    requested.length === 1 && requested[0] === "all"
      ? Object.values(doc.tasks)
          .filter((task) => task.kind === "implement" && task.status !== "cancelled")
          .map((task) => task.id)
      : [...requested];
  if (!roots.length)
    return conflict(
      "No implementation tasks are declared. Declare assignments before /workflow start.",
    );
  const ordered: string[] = [];
  const active = new Set<string>();
  const seen = new Set<string>();
  const visit = (id: string): Result<void, WorkflowError> => {
    const task = doc.tasks[id];
    if (!task || task.status === "cancelled")
      return conflict(`Task ${id} is missing or cancelled.`);
    if (active.has(id)) return conflict(`Dependency cycle at ${id}.`);
    if (seen.has(id)) return ok(undefined);
    active.add(id);
    if (task.kind === "plan") {
      const latest = task.planArtifact
        ? doc.artifacts[task.planArtifact]?.revisions.at(-1)
        : undefined;
      if (
        !latest ||
        latest.docRevision === undefined ||
        latest.docRevision <= (task.declaredRevision ?? doc.manifest?.declaredRevision ?? 0)
      )
        return conflict(`Planning input ${id} has no current publication.`);
      const body = latest.body as { plan?: unknown; review?: unknown };
      const plan = validateTaskPlan(body?.plan);
      if (
        !plan.ok ||
        !Value.Check(planReviewSchema, body?.review) ||
        plan.value.openQuestions.length
      )
        return conflict(`Planning input ${id} is invalid or has unresolved questions.`);
      if (
        task.dependsOn.some((dependencyId) => {
          const dependency = doc.tasks[dependencyId];
          const current = dependency?.planArtifact
            ? doc.artifacts[dependency.planArtifact]?.revisions.at(-1)
            : undefined;
          return (
            !current ||
            !latest.dependencies?.some(
              (item) =>
                item.artifactId === dependency!.planArtifact && item.revision === current.revision,
            )
          );
        })
      )
        return conflict(`Planning input ${id} has obsolete dependency coverage.`);
    } else if (
      !task.implementer ||
      !task.verifier ||
      task.implementer.profile === task.verifier.profile
    ) {
      return conflict(`Task ${id} requires distinct implementer and verifier profiles.`);
    }
    for (const dependency of task.dependsOn) {
      const result = visit(dependency);
      if (!result.ok) return result;
    }
    active.delete(id);
    seen.add(id);
    if (task.kind === "implement") ordered.push(id);
    return ok(undefined);
  };
  for (const id of roots) {
    const result = visit(id);
    if (!result.ok) return result;
  }
  return ordered.length <= 128 ? ok(ordered) : conflict("Execution scope exceeds 128 tasks.");
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sorted(item)]),
  );
}

/** Output revisions are not approval inputs: submitting work must not revoke its own receipt. */
export function consentFacts(
  doc: WorkflowDocument,
  taskIds: readonly string[],
  worktree: string,
  profiles: Readonly<Record<string, EffectiveProfileSnapshot>>,
): Result<
  {
    fingerprint: string;
    artifactRefs: string[];
    approvalFacts: Omit<WorkflowApproval, "provenance">;
  },
  WorkflowError
> {
  const scope = executionScope(doc, taskIds);
  if (!scope.ok) return scope;
  if (JSON.stringify(scope.value) !== JSON.stringify(taskIds))
    return conflict("Execution dependencies changed; request approval again.");
  const references = new Set<string>();
  const visited = new Set<string>();
  const collect = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const task = doc.tasks[id]!;
    if (task.planArtifact) {
      const latest = doc.artifacts[task.planArtifact]?.revisions.at(-1);
      if (latest) references.add(`${task.planArtifact}@${latest.revision}`);
    }
    for (const dependency of task.dependsOn) collect(dependency);
  };
  const tasks = [];
  for (const id of taskIds) {
    collect(id);
    const task = doc.tasks[id]!;
    const assigned = [task.lead.profile, task.implementer!.profile, task.verifier!.profile];
    if (assigned.some((name) => !profiles[name]))
      return conflict(`An assigned profile for ${id} is unavailable.`);
    tasks.push({
      id,
      kind: task.kind,
      scope: task.scope,
      dependsOn: task.dependsOn,
      lead: task.lead,
      implementer: task.implementer!,
      verifier: task.verifier!,
      assignmentVersion: task.assignmentVersion,
      profiles: assigned.map((name) => profiles[name]),
    });
  }
  // Include owning branch plans even when implementation dependencies are only sibling tasks.
  for (const id of doc.manifest?.branches ?? []) {
    const scope = executionScope(doc, [id]);
    if (!scope.ok) return scope;
    collect(id);
  }
  const artifactRefs = [...references].sort();
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        sorted({
          workflowId: doc.workflowId,
          declaredRevision: doc.manifest?.declaredRevision,
          worktree,
          taskIds,
          tasks,
          artifactRefs,
        }),
      ),
    )
    .digest("hex");
  const profileNames = new Set(
    tasks.flatMap((task) => [task.lead.profile, task.implementer.profile, task.verifier.profile]),
  );
  const approvalFacts: Omit<WorkflowApproval, "provenance"> = {
    tasks: taskIds.map((taskId) => {
      const task = doc.tasks[taskId]!;
      return {
        taskId,
        scope: task.scope,
        dependsOn: [...task.dependsOn],
        assignmentVersion: task.assignmentVersion,
        lead: task.lead.profile,
        implementer: task.implementer!.profile,
        verifier: task.verifier!.profile,
      };
    }),
    profiles: structuredClone(
      Object.fromEntries([...profileNames].map((name) => [name, profiles[name]!])),
    ),
  };
  return ok({ fingerprint, artifactRefs, approvalFacts });
}

export function previewExecution(
  doc: WorkflowDocument,
  requested: readonly string[],
  worktree: string,
  profiles: Readonly<Record<string, EffectiveProfileSnapshot>>,
  provenance: UserCommandProvenance,
  autoRepair: boolean,
  id: string,
): Result<WorkflowConsent, WorkflowError> {
  if (
    provenance.kind !== "user-command" ||
    !doc.members.some((member) => member.conversationId === provenance.conversationId)
  )
    return err(
      new WorkflowError(
        "WORKFLOW_NOT_AUTHORIZED",
        "Execution requires direct member user-command provenance.",
      ),
    );
  const scope = executionScope(doc, requested);
  if (!scope.ok) return scope;
  const facts = consentFacts(doc, scope.value, worktree, profiles);
  if (!facts.ok) return facts;
  return ok({
    id,
    workflowId: doc.workflowId,
    conversationId: provenance.conversationId,
    worktree,
    taskIds: scope.value,
    fingerprint: facts.value.fingerprint,
    artifactRefs: facts.value.artifactRefs,
    approval: {
      ...facts.value.approvalFacts,
      provenance: {
        kind: "user-command",
        conversationId: provenance.conversationId,
        receivedAt: provenance.receivedAt,
      },
    },
    autoRepair,
    state: "preview",
    createdAt: provenance.receivedAt,
  });
}

export function validateExecutionConsent(
  doc: WorkflowDocument,
  receipt: WorkflowConsent,
  worktree: string,
  profiles: Readonly<Record<string, EffectiveProfileSnapshot>>,
): Result<void, WorkflowError> {
  if (
    receipt.workflowId !== doc.workflowId ||
    receipt.worktree !== worktree ||
    receipt.state === "revoked"
  )
    return conflict("Execution approval is revoked or belongs to another workflow/worktree.");
  const current = consentFacts(doc, receipt.taskIds, worktree, profiles);
  if (!current.ok) return current;
  if (receipt.approval) {
    const { provenance, ...frozen } = receipt.approval;
    if (
      provenance.conversationId !== receipt.conversationId ||
      provenance.receivedAt !== receipt.createdAt ||
      JSON.stringify(sorted(frozen)) !== JSON.stringify(sorted(current.value.approvalFacts))
    )
      return conflict(
        "Stored approval details do not match the approved scope, profiles or user command.",
      );
  }
  return current.value.fingerprint === receipt.fingerprint
    ? ok(undefined)
    : conflict(
        "Scope, assignments, profiles or plan revisions changed; /workflow start requires new approval.",
      );
}

export function renderConsent(
  receipt: WorkflowConsent,
  doc: WorkflowDocument,
  profiles: Readonly<Record<string, EffectiveProfileSnapshot>>,
): Result<string, WorkflowError> {
  const valid = validateExecutionConsent(doc, receipt, receipt.worktree, profiles);
  if (!valid.ok) return valid;
  const approvedProfiles = receipt.approval?.profiles ?? profiles;
  const details = receipt.taskIds.flatMap((id) => {
    const task = doc.tasks[id]!;
    const roles = ["lead", "implementer", "verifier"] as const;
    return [
      `${id}: ${task.implementer!.profile} -> independent ${task.verifier!.profile}; scope: ${task.scope}`,
      ...roles.flatMap((role) => {
        const name = task[role]!.profile;
        const profile = approvedProfiles[name]!;
        return [
          `  ${role}: ${name}${role === "lead" ? " (read-only locked-defect analysis only)" : ""}`,
          `    Model: ${profile.model ?? "inherited (not resolved in profile snapshot)"}; effort: ${profile.thinking ?? "inherited (not resolved in profile snapshot)"}`,
          `    Profile: ${profile.id}@${profile.descriptorVersion}; instructions: ${profile.promptHash}`,
          `    Tool ceiling: ${profile.toolCeiling.join(", ") || "none"}`,
          `    Verification tools: ${profile.verificationTools.join(", ") || "none declared"}`,
          `    Delegation: ${profile.delegation.enabled ? "profile-enabled, subject to host role/ownership checks" : "disabled"}; skills: ${profile.skills.map((skill) => skill.name).join(", ") || "none"}`,
          ...(profile.overlays.length
            ? [
                `    Overlays: ${profile.overlays.map((overlay) => `${overlay.source}:${overlay.path}#${overlay.hash}`).join(", ")}`,
              ]
            : []),
        ];
      }),
    ];
  });
  return ok(
    [
      `Execution preview ${receipt.id} (NOT started)`,
      `Worktree: ${receipt.worktree}`,
      `Plan inputs: ${receipt.artifactRefs.join(", ") || "none"}`,
      `Automatic repair: ${receipt.autoRepair ? "explicitly enabled (three-failure permanent lock)" : "off"}`,
      "Same-worktree implementation and verification run serially; no isolated worktree is created.",
      ...details,
      "Read-only analysis further restricts tools to read/grep/find/ls and host protocol calls. Tool ceilings do not bypass role, binding or repair checks.",
      "Scope is instructional, not an OS path restriction. Bash/MCP are not an OS sandbox. Cancellation retains accepted changes and artifacts.",
      `Approve exactly this scope: /workflow confirm ${receipt.id}`,
    ].join("\n"),
  );
}
