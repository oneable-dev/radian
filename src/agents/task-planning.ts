import {
  buildSessionContext,
  type ExtensionContext,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { declareActionTool } from "./tool-protocol.ts";
import type { PublicationValidation } from "./task-tool.ts";
import type { ToolProtocolError } from "../errors.ts";
import { Value } from "typebox/value";
import instructions from "../../resources/skills/graph-plan/SKILL.md" with { type: "text" };
import {
  CancelledError,
  CapabilityError,
  InputError,
  SessionError,
  reportUnexpected,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { renderTaskPlan, taskPlanSchema, validateTaskPlan } from "./task-plan.ts";
import {
  planFilePath,
  planReviewSchema,
  readTaskPlan,
  saveTaskPlan,
  type PlanOwner,
  type StoredTaskPlan,
} from "./task-plan-store.ts";
import type { AgentProfile } from "./agent-profiles.ts";
import { openWorkflow } from "./task-workflow-store.ts";
import type { WorkflowDocument } from "./task-workflow.ts";
import type { SubagentCommand } from "./subagent-tools.ts";
import type { PlanningSchedulerControl } from "./workflow-scheduler-driver.ts";
import { schedulerInstructions } from "./subagent-instructions.ts";

export const legacyPlanningInstructions = instructions.split(
  "\n<!-- workflow-scheduler-only -->",
)[0]!;
import {
  planningProposalSchema,
  validatePlanningProposal,
  type PlanningProposal,
} from "./planning-proposal.ts";

export const planProtocol = declareActionTool([
  Type.Object({ action: Type.Literal("report") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("read") }, { additionalProperties: false }),
  Type.Object(
    { action: Type.Literal("submit"), plan: taskPlanSchema, review: planReviewSchema },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("delegate") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("wait") }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("reply"),
      questionId: Type.String({ minLength: 1, maxLength: 256 }),
      message: Type.String({ minLength: 1, maxLength: 16384 }),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("cancel") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("accept") }, { additionalProperties: false }),
]);

const invocationEntryType = "radian.task-plan-invocation";
const invocationSchema = Type.Object({
  requestId: Type.String(),
  baselineRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  state: Type.Union([Type.Literal("active"), Type.Literal("cancelled")]),
  schedulerMode: Type.Optional(Type.Boolean()),
});
type PlanInvocation = {
  requestId: string;
  baselineRevision?: number;
  state: "active" | "cancelled";
  schedulerMode?: boolean;
};
const requestMessageType = "radian.task-plan-request";
const resultMessageType = "radian.task-plan";
const contextMessageType = "radian.task-plan-context";
const runSchema = Type.Object({
  id: Type.String(),
  status: Type.String(),
  questions: Type.Array(Type.Object({ id: Type.String(), message: Type.String() })),
  proposal: Type.Optional(planningProposalSchema),
  error: Type.Optional(Type.String()),
});

export type PlanningHost = {
  resolveAgent(): Promise<Result<AgentProfile | null, ExpectedError>>;
  configuredAgent?(): Promise<Result<string | null, ExpectedError>>;
  coordinate(
    command: SubagentCommand,
    signal?: AbortSignal,
  ): Promise<Result<unknown, ExpectedError>>;
  setPlanningMode?(mode: "hierarchical" | "single" | null): void;
  schedulerEnabled?(): Result<boolean, ExpectedError>;
  schedulerOwnership?(): { invocationId: string } | undefined;
  controlScheduler?(command: PlanningSchedulerControl): Promise<Result<void, ExpectedError>>;
  timeoutMs?: number;
  availableAgents?(): Result<readonly Pick<AgentProfile, "name" | "description">[], ExpectedError>;
};
type Delegation = {
  requestId: string;
  profile: AgentProfile;
  requirements: string;
  baseline: string | null;
  runId?: string;
  proposal?: PlanningProposal;
  timer?: ReturnType<typeof setTimeout>;
};

function location(
  ctx: ExtensionContext,
): Result<{ file: string; owner: PlanOwner }, ExpectedError> {
  const file = ctx.sessionManager.getSessionFile();
  return file
    ? ok({
        file,
        owner: {
          conversationId: ctx.sessionManager.getSessionId(),
          cwd: ctx.cwd,
        },
      })
    : err(new CapabilityError("Task plans require a file-backed conversation."));
}

function report(document: StoredTaskPlan, file: string): string {
  return [
    renderTaskPlan(document.plan),
    "",
    "Structure: passed (schema, task references and acyclic dependencies).",
    `Semantic review (agent assessment): ${document.review.summary}`,
    ...document.review.warnings.map((warning) => `Warning: ${warning}`),
    "Approval: not implied. Task execution: not started by /plan.",
    `Plan file: ${planFilePath(file)}`,
    `Content hash: ${document.hash}`,
  ].join("\n");
}

function planningTask(
  ctx: ExtensionContext,
  request: Delegation,
  current: StoredTaskPlan | null,
  agents: readonly Pick<AgentProfile, "name" | "description">[],
): string {
  // Tool payloads, credentials and image bytes do not belong in a child handoff.
  const conversation = buildSessionContext(ctx.sessionManager.getBranch()).messages.flatMap(
    (message) => {
      if (message.role !== "user" && message.role !== "assistant") return [];
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n");
      return content ? [{ role: message.role, text: content }] : [];
    },
  );
  const payload = JSON.stringify({
    requestId: request.requestId,
    cwd: ctx.cwd,
    requirements: request.requirements,
    conversation,
    availableAgents: [{ name: "main", description: "Parent coordinator" }, ...agents],
    currentPlan: current ? { hash: current.hash, plan: current.plan } : null,
  });
  if (Buffer.byteLength(payload) > 1024 * 1024)
    throw new InputError(
      "Planning context exceeds the supported size; narrow the conversation before retrying.",
    );
  return [
    "Investigate and draft a complete reviewed task graph. Do not implement, install, run tests/builds, modify files, or delegate.",
    "The parent owns the authoritative plan. Do not write a plan file or invoke radian-plan. Use radian-supervisor ask for material decisions.",
    "Return the complete result using radian-supervisor action proposal with proposal={plan,review}. A final text summary is not the result transport.",
    "Review coverage, dependencies, role availability, file conflicts, acceptance criteria and open questions. User approval is not implied.",
    "Use the current plan only if relevant to the requested goal. Conversation context contains text only; ask the parent for essential omitted attachments.",
    `Required result schema: ${JSON.stringify(planningProposalSchema)}`,
    `Planning context: ${payload}`,
  ].join("\n\n");
}

const bounded = (text: string, limit = 512) =>
  text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").slice(0, limit);

function workflowUnavailable(error: ExpectedError): string {
  return `Workflow state unavailable [${error.code}]; task status, repair admission and plan readiness cannot be trusted; do not assume an empty or unlocked workflow.`;
}

function unavailableWorkflowReport(error: ExpectedError): string {
  return [
    "Planning: incomplete.",
    "Approval: not implied. Task execution: not started by /plan.",
    workflowUnavailable(error),
    `Reason: [${error.code}] ${bounded(error.message, 1024)}`,
  ].join("\n");
}

const artifactBodySchema = Type.Object({
  plan: taskPlanSchema,
  review: planReviewSchema,
});

/** Derive readiness from current declarations and validated bodies, exposing only bounded facts. */
function workflowReport(
  doc: WorkflowDocument | null,
  questions: string[],
  notice: string,
  invocation?: PlanInvocation,
  legacyRequest = false,
  schedulerMode = false,
): string {
  const manifest = doc?.manifest;
  const branches = manifest?.branches
    ? manifest.branches.flatMap((id) => (doc?.tasks[id] ? [doc.tasks[id]!] : []))
    : Object.values(doc?.tasks ?? {}).filter((task) => task.kind === "plan" && !task.parentTaskId);
  const previousScope =
    invocation !== undefined &&
    (!manifest ||
      manifest.declaredRevision === undefined ||
      (invocation.baselineRevision !== undefined &&
        manifest.declaredRevision <= invocation.baselineRevision));
  const reasons: string[] = [];
  if (previousScope || legacyRequest || (invocation && invocation.baselineRevision === undefined))
    reasons.push("Scope was not declared for the current /plan request");
  if (invocation?.state === "cancelled")
    reasons.push("Planning request was cancelled; artifacts were retained.");
  if (manifest && manifest.declaredRevision === undefined)
    reasons.push("Scope predates request correlation; declare it again.");
  const fresh = (latest: { docRevision?: number } | undefined) =>
    latest?.docRevision !== undefined &&
    manifest?.declaredRevision !== undefined &&
    latest.docRevision > manifest.declaredRevision;
  if (!manifest || !branches.length) reasons.push("No plan branches declared.");
  const warnings: string[] = [];
  const files = new Map<string, Set<string>>();
  let missing = 0;
  let questionCount = questions.length;
  const rows = branches.map((task) => {
    const artifact = task.planArtifact ? doc?.artifacts[task.planArtifact] : undefined;
    const latest = artifact?.revisions.at(-1);
    const stale = latest !== undefined && !fresh(latest);
    if (!latest || stale) {
      missing++;
      reasons.push(
        stale
          ? `Stale branch artifact: ${task.id} predates the current scope.`
          : `Missing branch artifact: ${task.id}`,
      );
    }
    if (latest) {
      if (Value.Check(artifactBodySchema, latest.body) && validateTaskPlan(latest.body.plan).ok) {
        for (const question of latest.body.plan.openQuestions) {
          reasons.push(`Open question (${task.id}): ${question}`);
          questionCount++;
        }
        warnings.push(
          ...latest.body.review.warnings.map(
            (warning) => `Warning (${bounded(task.id)}): ${bounded(warning, 1024)}`,
          ),
        );
        for (const planTask of latest.body.plan.tasks) {
          for (const file of planTask.files) {
            const owners = files.get(file) ?? new Set<string>();
            owners.add(task.id);
            files.set(file, owners);
          }
        }
      } else reasons.push(`Invalid branch artifact body: ${task.id}`);
    }
    for (const dependency of task.dependsOn) {
      const target = doc?.tasks[dependency];
      const dependencyArtifact = target?.planArtifact
        ? doc?.artifacts[target.planArtifact]?.revisions.at(-1)
        : undefined;
      if (!fresh(dependencyArtifact))
        reasons.push(
          `Cross-branch dependency ${task.id} -> ${dependency} has no artifact for the current scope.`,
        );
      else if (fresh(latest)) {
        const receipt = latest!.dependencies?.find(
          (item) => item.artifactId === target!.planArtifact,
        );
        const current = `${target!.planArtifact}@${dependencyArtifact!.revision}`;
        if (!receipt)
          reasons.push(
            `Dependency coverage missing: ${task.id} has no host-captured review of ${current}.`,
          );
        else if (receipt.revision !== dependencyArtifact!.revision)
          reasons.push(
            `Dependency coverage obsolete: ${task.id} reviewed ${receipt.artifactId}@${receipt.revision}; current ${current}.`,
          );
      }
    }
    const taskSchedule =
      schedulerMode && doc?.version === 2 ? doc.tasks[task.id]?.schedule : undefined;
    if (
      taskSchedule &&
      (["blocked", "interrupted", "paused"].includes(taskSchedule.state) ||
        taskSchedule.reason === "cleanup-uncertain")
    )
      reasons.push(
        `Schedule ${task.id}: ${taskSchedule.state}${taskSchedule.reason ? ` (${taskSchedule.reason})` : ""}`,
      );
    const reference = latest
      ? `${bounded(task.planArtifact!)}@${latest.revision}${stale ? " (stale)" : ""}: ${bounded(latest.summary, 1024)}`
      : "missing";
    return `${bounded(task.id)} -> ${bounded(task.lead.profile)} | ${reference}${taskSchedule ? ` | schedule=${taskSchedule.state}${taskSchedule.reason ? `(${bounded(taskSchedule.reason)})` : ""}` : ""}`;
  });
  reasons.push(...questions.map((question) => `Unresolved planner question: ${question}`));
  reasons.push(...(manifest?.diagnostics ?? []));
  const sharedFiles = [...files]
    .filter(([, owners]) => owners.size > 1)
    .map(
      ([file, owners]) =>
        `Diagnostic: shared file ${bounded(file, 1024)} in ${[...owners].map((id) => bounded(id)).join(", ")}`,
    );
  const text = [
    `Planning: ${reasons.length ? "incomplete" : "ready for review"}.`,
    "Approval: not implied. Task execution: not started by /plan.",
    `${previousScope && manifest ? "Previous scope" : "Goal"}: ${bounded(manifest?.goal ?? "Not declared")}`,
    `Branches: ${branches.length}; missing: ${missing}; diagnostics: ${manifest?.diagnostics.length ?? 0}; questions: ${questionCount}.`,
    ...reasons.map((reason) => `Reason: ${bounded(reason, 1024)}`),
    ...(notice ? [notice] : []),
    ...rows,
    ...warnings,
    ...sharedFiles,
    "Retrieve a full body only when needed: radian-task status artifact=<ref@revision> (owning lead/root, or a dependent's frozen input).",
  ].join("\n");
  const marker =
    "\n[Truncated; retrieve complete branch artifacts and workflow diagnostics before review.]";
  return text.length <= 12000 ? text : `${text.slice(0, 12000 - marker.length)}${marker}`;
}

/** One instance belongs to one host-bound lead run, not one model turn or repair attempt. */
export function publicationCorrection(): PublicationValidation & { extension: InlineExtension } {
  const failures = new Map<string, ToolProtocolError>();
  const used = new Set<string>();
  const reported = new Set<string>();
  return {
    failed(raw, error) {
      if (
        raw === null ||
        typeof raw !== "object" ||
        !("action" in raw) ||
        raw.action !== "publish-plan" ||
        !("artifactId" in raw) ||
        typeof raw.artifactId !== "string"
      )
        return;
      failures.set(raw.artifactId, error);
      reported.delete(raw.artifactId);
    },
    published(artifactId) {
      failures.delete(artifactId);
    },
    extension: {
      name: "radian-publication-correction",
      factory(pi) {
        pi.on("agent_before_settle", (event) => {
          if (event.outcome !== "completed") return;
          const pending = [...failures].filter(([id]) => !reported.has(id));
          if (!pending.length) return;
          let continuation = false;
          const content = pending.map(([id, error]) => {
            if (used.has(id)) {
              reported.add(id);
              return `Publication blocked: correction budget exhausted. ${error.message} Last valid artifact retained; no invalid revision was published.`;
            }
            used.add(id);
            continuation = true;
            return `Correct this publish-plan once: ${error.message} Do not edit files or execute tasks. Publish only the corrected plan and review.`;
          });
          return {
            continue: continuation,
            entries: [
              {
                type: "custom_message",
                customType: "radian.publication-correction",
                content: content.join("\n"),
                display: true,
              },
            ],
          };
        });
      },
    },
  };
}

/** Hierarchical leads own artifacts; explicit --single retains parent-owned sidecars. */
export function taskPlanningExtension(
  recordRequest?: (invocation: string) => void,
  host?: PlanningHost,
): InlineExtension {
  return {
    name: "radian-plan",
    replaceable: true,
    factory: (pi) => {
      let planning = false;
      let single = false;
      let hierarchyStarted = false;
      // Persisted invocation provenance controls presentation, never host admission ownership.
      let schedulerMode = false;
      let legacyNotice = "";
      let submitted = false;
      let cancelled = false;
      let invocation = 0;
      let planInvocation: PlanInvocation | undefined;
      let requiredAgent: AgentProfile | undefined;
      let delegation: Delegation | undefined;

      const forget = () => {
        const previous = delegation;
        if (previous?.timer) clearTimeout(previous.timer);
        delegation = undefined;
        return previous;
      };
      const stop = async (
        request: Delegation | undefined,
      ): Promise<Result<unknown, ExpectedError>> => {
        if (!request?.runId || !host) return ok(undefined);
        return host.coordinate({ action: "stop", id: request.runId });
      };
      const currentRequest = () => {
        if (!host || !delegation)
          throw new InputError("There is no active delegated planning request. Start /plan first.");
        return delegation;
      };
      const coordinate = async (
        request: Delegation,
        command: SubagentCommand,
        signal?: AbortSignal,
      ) => {
        const result = await host!.coordinate(command, signal);
        if (command.action === "spawn" && result.ok && Value.Check(runSchema, result.value))
          request.runId = result.value.id;
        if (delegation !== request || signal?.aborted) {
          if (command.action === "spawn") {
            const cleanup = await stop(request);
            if (!cleanup.ok) reportUnexpected(cleanup.error, "superseded planner cleanup");
          }
          throw new CancelledError("Planning request was superseded or cancelled.");
        }
        if (!result.ok) {
          if (command.action === "spawn") forget();
          throw result.error;
        }
        return result.value;
      };
      const observe = (request: Delegation, value: unknown) => {
        if (!Array.isArray(value)) throw new InputError("Invalid planner status response.");
        const run = value.find(
          (entry: unknown) => Value.Check(runSchema, entry) && entry.id === request.runId,
        );
        if (!Value.Check(runSchema, run))
          throw new InputError("Planner status does not match this request.");
        if (run.status === "complete") {
          const proposal = validatePlanningProposal(run.proposal);
          if (!proposal.ok) {
            forget();
            throw proposal.error;
          }
          request.proposal = structuredClone(proposal.value);
          if (request.timer) clearTimeout(request.timer);
        }
        if (run.status === "failure" || run.status === "stopped") {
          forget();
          throw new InputError(
            `Planner did not complete: ${run.error ?? run.status}. Previous plan was retained.`,
          );
        }
        return run;
      };

      const readiness = async (ctx: ExtensionContext) => {
        const target = location(ctx);
        if (!target.ok) throw target.error;
        const workflow = await openWorkflow(target.value.file, target.value.owner);
        if (!workflow.ok) return unavailableWorkflowReport(workflow.error);
        const questions: string[] = [];
        if (host) {
          const runs = await host.coordinate({ action: "status" });
          if (!runs.ok) throw runs.error;
          if (!Array.isArray(runs.value)) throw new InputError("Invalid planning status response.");
          for (const run of runs.value) {
            if (!Value.Check(runSchema, run)) throw new InputError("Invalid planning run.");
            questions.push(
              ...run.questions.map((question) => `${run.id}/${question.id}: ${question.message}`),
            );
          }
        }
        const branch = ctx.sessionManager.getBranch();
        const saved = branch.findLast(
          (entry) => entry.type === "custom" && entry.customType === invocationEntryType,
        );
        const currentInvocation =
          planInvocation ??
          (saved?.type === "custom" && Value.Check(invocationSchema, saved.data)
            ? saved.data
            : undefined);
        const request = branch.findLast(
          (entry) => entry.type === "custom_message" && entry.customType === requestMessageType,
        );
        const legacyRequest =
          request?.type === "custom_message" &&
          (!currentInvocation ||
            !Value.Check(
              Type.Object({ requestId: Type.Literal(currentInvocation.requestId) }),
              request.details,
            ));
        return workflowReport(
          workflow.value?.doc ?? null,
          questions,
          legacyNotice,
          currentInvocation,
          legacyRequest,
          schedulerMode,
        );
      };
      const stopHierarchy = async (shutdown = false) => {
        if (!host || !hierarchyStarted) return;
        const owner = host.schedulerOwnership?.();
        if ((owner || (schedulerMode && planInvocation)) && host.controlScheduler) {
          const stopped = await host.controlScheduler({
            kind: "cancelled",
            invocationId: owner?.invocationId ?? planInvocation!.requestId,
          });
          if (!stopped.ok) {
            if (shutdown && ["SESSION_NOT_OPEN", "RUNTIME_STOPPING"].includes(stopped.error.code))
              return;
            throw stopped.error;
          }
          hierarchyStarted = false;
          return;
        }
        const runs = await host.coordinate({ action: "status" });
        if (!runs.ok) {
          if (shutdown && ["SESSION_NOT_OPEN", "RUNTIME_STOPPING"].includes(runs.error.code))
            return;
          throw runs.error;
        }
        if (!Array.isArray(runs.value)) throw new InputError("Invalid planning status response.");
        for (const run of runs.value) {
          if (!Value.Check(runSchema, run)) throw new InputError("Invalid planning run.");
          const stopped = await host.coordinate({ action: "stop", id: run.id });
          if (!stopped.ok) {
            if (shutdown && ["SESSION_NOT_OPEN", "RUNTIME_STOPPING"].includes(stopped.error.code))
              return;
            throw stopped.error;
          }
        }
        hierarchyStarted = false;
      };

      const restoreInvocation = async (ctx: ExtensionContext) => {
        const saved = ctx.sessionManager
          .getBranch()
          .findLast((entry) => entry.type === "custom" && entry.customType === invocationEntryType);
        planInvocation =
          saved?.type === "custom" && Value.Check(invocationSchema, saved.data)
            ? saved.data
            : undefined;
        hierarchyStarted = !single && planInvocation?.state === "active";
        schedulerMode = !single && planInvocation?.schedulerMode === true;
        if (!single && planInvocation && planInvocation.schedulerMode === undefined) {
          // Older entries lack provenance; infer scheduler presentation from durable facts only.
          const requestId = planInvocation.requestId;
          const target = location(ctx);
          if (!target.ok) throw target.error;
          const workflow = await openWorkflow(target.value.file, target.value.owner);
          if (!workflow.ok) throw workflow.error;
          const doc = workflow.value?.doc;
          schedulerMode =
            doc?.version === 2 &&
            doc.scheduler?.invocations.some(
              (item) => item.id === requestId && item.kind === "plan",
            ) === true;
        }
      };
      pi.on("session_start", async (_event, ctx) => {
        await restoreInvocation(ctx);
        host?.setPlanningMode?.(planInvocation?.state === "active" ? "hierarchical" : null);
      });
      pi.on("before_agent_start", async (event, ctx) => {
        // Turn settlement and extension reload do not close a durable planning invocation.
        await restoreInvocation(ctx);
        planning =
          (event.messageType === "custom" && event.message.customType === requestMessageType) ||
          !!delegation ||
          (!single && planInvocation?.state === "active");
        submitted = false;
        cancelled = false;
        if (!planning) requiredAgent = undefined;
        host?.setPlanningMode?.(planning ? (single ? "single" : "hierarchical") : null);
        if (planning && schedulerMode)
          event.systemPromptOptions.appendSystemPrompt += `\n\n${schedulerInstructions}`;
      });
      pi.on("context", async (event, ctx) => {
        const target = location(ctx);
        if (!target.ok) return;
        const workflow = await openWorkflow(target.value.file, target.value.owner);
        if (!workflow.ok)
          ctx.ui.notify(`[${workflow.error.code}] ${workflow.error.message}`, "warning");
        const current = await readTaskPlan(target.value.file, target.value.owner);
        if (!current.ok) {
          ctx.ui.notify(
            `Current task plan could not be read [${current.error.code}]: ${current.error.message}`,
            "warning",
          );
        }
        const legacy = current.ok ? current.value : null;
        const messages = [...event.messages];
        if (!workflow.ok || workflow.value)
          messages.push({
            role: "custom" as const,
            customType: contextMessageType,
            content: workflow.ok ? await readiness(ctx) : workflowUnavailable(workflow.error),
            display: false,
            timestamp: Date.now(),
          });
        if (legacy)
          messages.push({
            role: "custom" as const,
            customType: contextMessageType,
            content: `The conversation-wide current plan is ${planFilePath(target.value.file)} (SHA-256 ${legacy.hash}). Goal: ${legacy.plan.goal}. Read it with radian-plan before relying on or revising details. Older plan submissions in the transcript do not replace this current file. Its structural validity is not user approval or proof of task completion. Before reporting completion of user-authorized implementation of this plan, compare its applicable acceptance criteria with the actual changes and verification evidence; report unmet or unverified criteria. Do not apply this plan to unrelated requests or execute acceptance commands during /plan.`,
            display: false,
            timestamp: Date.now(),
          });
        if (delegation)
          messages.push({
            role: "custom" as const,
            customType: contextMessageType,
            content: `This planning request uses agent ${delegation.profile.name}${delegation.profile.model ? ` (${delegation.profile.model})` : ""}. Use radian-plan delegate once, then wait. Relay planner questions to the user and use reply with questionId/message to continue. Do not draft or submit your own replacement plan. Inspect the complete returned proposal, then use accept to validate and save it under this parent conversation. cancel ends this workflow without changing the saved plan. Parent model and thinking remain unchanged.`,
            display: false,
            timestamp: Date.now(),
          });
        if (messages.length !== event.messages.length) return { messages };
      });
      pi.on("tool_call", async (event, ctx) => {
        if (!planning) return;
        const delegated = ["radian-subagent", "radian_subagent", "subagent"].includes(
          event.toolName,
        );
        if (delegated && !single && !cancelled) {
          const action = "action" in event.input ? event.input.action : undefined;
          if (["list", "status", "wait", "reply", "stop"].includes(String(action))) return;
          const schedulerOwned = host?.schedulerOwnership
            ? host.schedulerOwnership() !== undefined
            : schedulerMode;
          if (action === "spawn" && !schedulerOwned) {
            const target = location(ctx);
            if (!target.ok) throw target.error;
            const workflow = await openWorkflow(target.value.file, target.value.owner);
            if (!workflow.ok)
              return {
                block: true,
                reason: workflowUnavailable(workflow.error),
              };
            const binding = "binding" in event.input ? event.input.binding : undefined;
            if (binding && typeof binding === "object" && "id" in binding && "role" in binding) {
              const task = workflow.value?.doc.tasks[String(binding.id)];
              if (
                task?.kind === "plan" &&
                !task.parentTaskId &&
                binding.role === "lead" &&
                "agent" in event.input &&
                task.lead.profile === event.input.agent &&
                !("purpose" in binding)
              )
                return;
            }
          }
        }
        if (
          event.toolName === "edit" ||
          event.toolName === "write" ||
          (delegated && (!("action" in event.input) || event.input.action !== "list"))
        ) {
          return {
            block: true,
            reason:
              "/plan only investigates and publishes plan artifacts; it does not edit product files or execute delegated work. Hierarchical spawning requires a declared branch lead binding. Legacy configured planners are managed exclusively through radian-plan.",
          };
        }
      });
      pi.on("agent_before_settle", async (event, ctx) => {
        if (planning && !single)
          return {
            entries: [
              {
                type: "custom_message",
                customType: resultMessageType,
                content: await readiness(ctx),
                display: true,
              },
            ],
          };
        if (planning && !submitted && event.outcome === "completed")
          return {
            entries: [
              {
                type: "custom_message",
                customType: resultMessageType,
                content: delegation
                  ? "The delegated planning request is not accepted yet. The previous current plan remains unchanged. Use radian-plan wait/reply to continue, or cancel to stop it."
                  : "No new structurally validated plan was saved. Any earlier current plan remains unchanged. Clarify outstanding questions or run /plan again to finish planning.",
                display: true,
              },
            ],
          };
      });
      pi.on("agent_settled", async (event) => {
        if (event.aborted) await stopHierarchy();
        planning = false;
        host?.setPlanningMode?.(
          !single && planInvocation?.state === "active" ? "hierarchical" : null,
        );
        if (event.aborted) {
          const result = await stop(forget());
          if (!result.ok) reportUnexpected(result.error, "planning cancellation");
        }
      });
      pi.on("session_shutdown", async () => {
        await stopHierarchy(true);
        planning = false;
        host?.setPlanningMode?.(null);
        const result = await stop(forget());
        if (
          !result.ok &&
          result.error.code !== "SESSION_NOT_OPEN" &&
          result.error.code !== "RUNTIME_STOPPING"
        )
          reportUnexpected(result.error, "planning shutdown");
      });

      pi.registerTool({
        name: "radian-plan",
        label: "Task plan",
        executionMode: "sequential",
        description:
          "Report hierarchical planning readiness from durable branch artifacts, or cancel planning runs without deleting records. read retrieves a legacy .plan.json. Only explicit /plan --single supports delegate/wait/reply/accept or parent submit. No action executes tasks or implies approval.",
        ...planProtocol,
        execute: async (_id, raw, signal, _update, ctx) => {
          const validated = planProtocol.validateAction(raw);
          if (!validated.ok) throw validated.error;
          const args = validated.value;
          if (signal?.aborted) throw new CancelledError();
          const target = location(ctx);
          if (!target.ok) throw target.error;
          const { file, owner } = target.value;
          if (args.action === "report")
            return {
              content: [{ type: "text", text: await readiness(ctx) }],
              details: null,
            };
          if (args.action === "read") {
            const current = await readTaskPlan(file, owner);
            if (!current.ok) throw current.error;
            return {
              content: [
                {
                  type: "text",
                  text: current.value
                    ? report(current.value, file)
                    : "This conversation has no saved task plan.",
                },
              ],
              details: current.value
                ? { hash: current.value.hash, file: planFilePath(file) }
                : null,
            };
          }
          if (args.action === "cancel") {
            if (!planning && !delegation && !hierarchyStarted)
              throw new InputError("There is no planning request to cancel.");
            cancelled = true;
            if (!single && planInvocation) {
              planInvocation = { ...planInvocation, state: "cancelled" };
              pi.appendEntry(invocationEntryType, planInvocation);
            }
            await stopHierarchy();
            const result = await stop(forget());
            if (!result.ok) throw result.error;
            return {
              content: [
                {
                  type: "text",
                  text: "Planning cancelled. Previous plan was retained.",
                },
              ],
              details: null,
            };
          }
          if (cancelled)
            throw new CancelledError(
              "This planning turn was cancelled; previous plan was retained.",
            );
          if (!planning) throw new InputError("Start /plan before submitting a task graph.");
          if (!single)
            throw new InputError(
              "Hierarchical /plan uses radian-task declare and lead publish-plan; use report, not parent submit/accept. Legacy mode requires /plan --single.",
            );
          if (["delegate", "wait", "reply"].includes(args.action)) {
            const request = currentRequest();
            let status: unknown;
            if (args.action === "delegate") {
              if (!request.runId) {
                const current = await readTaskPlan(file, owner);
                if (!current.ok) throw current.error;
                if ((current.value?.hash ?? null) !== request.baseline)
                  throw new SessionError(
                    "SESSION_CONFLICT",
                    "Current plan changed before planner delegation. Start /plan again.",
                  );
                const agents = host?.availableAgents?.() ?? ok([]);
                if (!agents.ok) throw agents.error;
                const started = await coordinate(
                  request,
                  {
                    action: "spawn",
                    agent: request.profile.name,
                    task: planningTask(ctx, request, current.value, agents.value),
                    async: true,
                  },
                  signal,
                );
                if (!Value.Check(runSchema, started))
                  throw new InputError("Invalid planner start response.");
                request.runId = started.id;
                const captured = request;
                request.timer = setTimeout(
                  () => {
                    if (delegation !== captured) return;
                    forget();
                    void stop(captured)
                      .then((result) => {
                        ctx.ui.notify(
                          result.ok
                            ? "Planner timed out; previous plan was retained."
                            : `Planner timed out; cleanup failed [${result.error.code}].`,
                          "warning",
                        );
                      })
                      .catch((error: unknown) => reportUnexpected(error, "planner timeout"));
                  },
                  host?.timeoutMs ?? 10 * 60 * 1000,
                );
                request.timer.unref();
              }
              status = await coordinate(request, { action: "status", id: request.runId }, signal);
            } else {
              if (!request.runId)
                throw new InputError("Delegate the planning request before waiting or replying.");
              if (args.action === "reply") {
                if (!args.questionId || !args.message)
                  throw new InputError("A planner reply requires questionId and message.");
                await coordinate(
                  request,
                  {
                    action: "reply",
                    id: request.runId,
                    questionId: args.questionId,
                    message: args.message,
                  },
                  signal,
                );
              }
              status = await coordinate(request, { action: "wait", id: request.runId }, signal);
            }
            const run = observe(request, status);
            return {
              content: [{ type: "text", text: JSON.stringify(run) }],
              details: run,
            };
          }
          const accepting = delegation;
          const acceptedInvocation = invocation;
          let proposal: PlanningProposal | undefined;
          let expectedHash: string | null | undefined;
          if (args.action === "accept") {
            const request = currentRequest();
            if (!request.runId) throw new InputError("Planner has not started.");
            observe(
              request,
              await coordinate(request, { action: "status", id: request.runId }, signal),
            );
            if (!request.proposal)
              throw new InputError("Planner has not returned a completed proposal.");
            proposal = request.proposal;
            const agents = host?.availableAgents?.();
            if (agents) {
              if (!agents.ok) throw agents.error;
              const names = new Set(["main", ...agents.value.map((agent) => agent.name)]);
              if (proposal.plan.tasks.some((task) => !names.has(task.agent))) {
                forget();
                throw new InputError(
                  "Planner assigned an unavailable agent profile. Previous plan was retained.",
                );
              }
            }
            expectedHash = request.baseline;
          } else if (args.action === "submit") {
            if (requiredAgent)
              throw new InputError(
                "This /plan uses a configured planner. Accept its completed proposal instead of submitting a parent replacement.",
              );
          } else throw new InputError("Invalid planning action.");
          const saved = await saveTaskPlan(
            file,
            owner,
            proposal?.plan ?? (args.action === "submit" ? args.plan : undefined),
            proposal?.review ?? (args.action === "submit" ? args.review : undefined),
            {
              ...(expectedHash === undefined ? {} : { expectedHash }),
              ...(signal ? { signal } : {}),
              isCurrent: () =>
                planning &&
                !cancelled &&
                invocation === acceptedInvocation &&
                delegation === accepting,
            },
          );
          if (!saved.ok) {
            if (saved.error.code === "SESSION_CONFLICT" && delegation === accepting) forget();
            throw saved.error;
          }
          submitted = true;
          if (proposal && delegation === accepting) forget();
          return {
            content: [{ type: "text", text: report(saved.value, file) }],
            details: {
              hash: saved.value.hash,
              file: planFilePath(file),
              structural: "passed",
            },
          };
        },
      });
      pi.registerCommand("plan", {
        description:
          "Plan with branch leads: /plan [requirements]; legacy: /plan --single [requirements]",
        handler: async (args, ctx) => {
          if (!ctx.isIdle())
            throw new SessionError(
              "SESSION_BUSY",
              "Wait for the current run before creating or revising its task plan.",
            );
          invocation++;
          await restoreInvocation(ctx);
          await stopHierarchy();
          single = /^--single(?:\s|$)/.test(args.trim());
          // Explicit legacy mode supersedes an earlier hierarchical invocation, including on reload.
          if (single && planInvocation?.state === "active")
            pi.appendEntry(invocationEntryType, { ...planInvocation, state: "cancelled" });
          planInvocation = undefined;
          if (!single) {
            const target = location(ctx);
            if (!target.ok) throw target.error;
            const workflow = await openWorkflow(target.value.file, target.value.owner);
            planInvocation = {
              requestId: crypto.randomUUID(),
              ...(workflow.ok ? { baselineRevision: workflow.value?.doc.revision ?? 0 } : {}),
              state: "active",
            };
          }
          hierarchyStarted = !single;
          const requirements = single ? args.trim().replace(/^--single\s*/, "") : args.trim();
          const resolved =
            host && (single || !host.configuredAgent) ? await host.resolveAgent() : ok(null);
          if (!resolved.ok) throw resolved.error;
          const configured =
            !single && host?.configuredAgent
              ? await host.configuredAgent()
              : ok(resolved.value?.name ?? null);
          if (!configured.ok) throw configured.error;
          const previous = await stop(forget());
          if (!previous.ok) throw previous.error;
          requiredAgent = single ? (resolved.value ?? undefined) : undefined;
          legacyNotice =
            !single && configured.value
              ? `commandAgents.plan (${configured.value}) is a legacy single-planner binding and is not used by hierarchical /plan; run /plan --single to use it.`
              : "";
          const setting = host?.schedulerEnabled?.();
          schedulerMode = !single && setting?.ok === true && setting.value;
          if (setting && !setting.ok)
            ctx.ui.notify(`[${setting.error.code}] ${setting.error.message}`, "warning");
          if (planInvocation) {
            planInvocation.schedulerMode = schedulerMode;
            pi.appendEntry(invocationEntryType, planInvocation);
          }
          host?.setPlanningMode?.(single ? "single" : "hierarchical");
          if (schedulerMode && planInvocation && host?.controlScheduler) {
            const started = await host.controlScheduler({
              kind: "started",
              invocationId: planInvocation.requestId,
              baselineRevision: planInvocation.baselineRevision ?? 0,
            });
            if (!started.ok) throw started.error;
          }
          if (requiredAgent) {
            const target = location(ctx);
            if (!target.ok) throw target.error;
            const current = await readTaskPlan(target.value.file, target.value.owner);
            if (!current.ok) throw current.error;
            delegation = {
              requestId: crypto.randomUUID(),
              profile: requiredAgent,
              requirements:
                requirements ||
                "Use the requirements already discussed; ask about material unknowns.",
              baseline: current.value?.hash ?? null,
            };
          }
          let modeInstructions = `Hierarchical planning mode. Declare relevant branches with radian-task declare, spawn each assigned lead with binding {id: branchId, role: "lead"}, and ask leads to publish-plan. Never accept/save/rewrite their bodies. Use radian-plan report.\n${legacyNotice}`;
          if (schedulerMode) modeInstructions = `${schedulerInstructions}\n${legacyNotice}`;
          if (single)
            modeInstructions = requiredAgent
              ? `Legacy single-planner mode. Host-selected planning agent: ${requiredAgent.name}. Use radian-plan delegate, wait/reply, then accept. Do not draft a replacement in the parent.`
              : "Legacy single-planner mode without a configured planner: investigate and use radian-plan submit in the parent.";
          recordRequest?.(`/plan${args ? ` ${args}` : ""}`);
          pi.sendMessage(
            {
              customType: requestMessageType,
              ...(!single && planInvocation
                ? { details: { requestId: planInvocation.requestId } }
                : {}),
              content: `${schedulerMode ? instructions : legacyPlanningInstructions}\n\n${modeInstructions}\n\nUser requirements:\n${requirements || "Use the requirements already discussed in this conversation. Ask if the goal is not clear."}`,
              display: false,
            },
            { triggerTurn: true },
          );
        },
      });
    },
  };
}
