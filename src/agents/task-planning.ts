import {
  buildSessionContext,
  type ExtensionContext,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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
import { renderTaskPlan, taskPlanSchema } from "./task-plan.ts";
import {
  planFilePath,
  planReviewSchema,
  readTaskPlan,
  saveTaskPlan,
  type PlanOwner,
  type StoredTaskPlan,
} from "./task-plan-store.ts";
import type { AgentProfile } from "./agent-profiles.ts";
import type { SubagentCommand } from "./subagent-tools.ts";
import {
  planningProposalSchema,
  validatePlanningProposal,
  type PlanningProposal,
} from "./planning-proposal.ts";

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
  coordinate(
    command: SubagentCommand,
    signal?: AbortSignal,
  ): Promise<Result<unknown, ExpectedError>>;
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
    ? ok({ file, owner: { conversationId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd } })
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

/** The parent owns validation and storage; a configured child only drafts. */
export function taskPlanningExtension(
  recordRequest?: (invocation: string) => void,
  host?: PlanningHost,
): InlineExtension {
  return {
    name: "radian-plan",
    replaceable: true,
    factory: (pi) => {
      let planning = false;
      let submitted = false;
      let cancelled = false;
      let invocation = 0;
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

      pi.on("before_agent_start", (event) => {
        planning =
          (event.messageType === "custom" && event.message.customType === requestMessageType) ||
          !!delegation;
        submitted = false;
        cancelled = false;
        if (!planning) requiredAgent = undefined;
      });
      pi.on("context", async (event, ctx) => {
        const target = location(ctx);
        if (!target.ok) return;
        const current = await readTaskPlan(target.value.file, target.value.owner);
        if (!current.ok) {
          ctx.ui.notify(
            `Current task plan could not be read [${current.error.code}]: ${current.error.message}`,
            "warning",
          );
          return;
        }
        const messages = [...event.messages];
        if (current.value)
          messages.push({
            role: "custom" as const,
            customType: contextMessageType,
            content: `The conversation-wide current plan is ${planFilePath(target.value.file)} (SHA-256 ${current.value.hash}). Goal: ${current.value.plan.goal}. Read it with radian-plan before relying on or revising details. Older plan submissions in the transcript do not replace this current file. Its structural validity is not user approval or proof of task completion. Before reporting completion of user-authorized implementation of this plan, compare its applicable acceptance criteria with the actual changes and verification evidence; report unmet or unverified criteria. Do not apply this plan to unrelated requests or execute acceptance commands during /plan.`,
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
      pi.on("tool_call", (event) => {
        if (!planning) return;
        const delegated = ["radian-subagent", "radian_subagent", "subagent"].includes(
          event.toolName,
        );
        if (
          event.toolName === "edit" ||
          event.toolName === "write" ||
          (delegated && (!("action" in event.input) || event.input.action !== "list"))
        ) {
          return {
            block: true,
            reason:
              "/plan only investigates and writes its plan artifact; it does not edit product files or execute delegated work. Configured planning agents are managed exclusively through radian-plan.",
          };
        }
      });
      pi.on("agent_before_settle", (event) => {
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
        planning = false;
        if (event.aborted) {
          const result = await stop(forget());
          if (!result.ok) reportUnexpected(result.error, "planning cancellation");
        }
      });
      pi.on("session_shutdown", async () => {
        planning = false;
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
          "Read or validate the parent conversation's task graph. During /plan, delegate/wait/reply/cancel manage only the configured read-only planner; accept saves its verified proposal. Legacy parent planning uses submit. No action executes plan tasks or implies approval.",
        parameters: Type.Object(
          {
            action: Type.Union(
              ["read", "submit", "delegate", "wait", "reply", "cancel", "accept"].map((action) =>
                Type.Literal(action),
              ),
            ),
            plan: Type.Optional(taskPlanSchema),
            review: Type.Optional(planReviewSchema),
            questionId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
            message: Type.Optional(Type.String({ minLength: 1, maxLength: 16384 })),
          },
          { additionalProperties: false },
        ),
        execute: async (_id, args, signal, _update, ctx) => {
          if (signal?.aborted) throw new CancelledError();
          const target = location(ctx);
          if (!target.ok) throw target.error;
          const { file, owner } = target.value;
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
            if (!planning && !delegation)
              throw new InputError("There is no planning request to cancel.");
            cancelled = true;
            const result = await stop(forget());
            if (!result.ok) throw result.error;
            return {
              content: [{ type: "text", text: "Planning cancelled. Previous plan was retained." }],
              details: null,
            };
          }
          if (cancelled)
            throw new CancelledError(
              "This planning turn was cancelled; previous plan was retained.",
            );
          if (!planning) throw new InputError("Start /plan before submitting a task graph.");
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
            return { content: [{ type: "text", text: JSON.stringify(run) }], details: run };
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
            proposal?.plan ?? args.plan,
            proposal?.review ?? args.review,
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
            details: { hash: saved.value.hash, file: planFilePath(file), structural: "passed" },
          };
        },
      });
      pi.registerCommand("plan", {
        description: "Create, validate and present a task/delegation graph: /plan [requirements]",
        handler: async (args, ctx) => {
          if (!ctx.isIdle())
            throw new SessionError(
              "SESSION_BUSY",
              "Wait for the current run before creating or revising its task plan.",
            );
          invocation++;
          const resolved = host ? await host.resolveAgent() : ok(null);
          if (!resolved.ok) throw resolved.error;
          const previous = await stop(forget());
          if (!previous.ok) throw previous.error;
          requiredAgent = resolved.value ?? undefined;
          if (requiredAgent) {
            const target = location(ctx);
            if (!target.ok) throw target.error;
            const current = await readTaskPlan(target.value.file, target.value.owner);
            if (!current.ok) throw current.error;
            delegation = {
              requestId: crypto.randomUUID(),
              profile: requiredAgent,
              requirements:
                args.trim() ||
                "Use the requirements already discussed; ask about material unknowns.",
              baseline: current.value?.hash ?? null,
            };
          }
          recordRequest?.(`/plan${args ? ` ${args}` : ""}`);
          pi.sendMessage(
            {
              customType: requestMessageType,
              content: `${instructions}\n\n${requiredAgent ? `Host-selected planning agent: ${requiredAgent.name}. Use radian-plan delegate, wait/reply, then accept. Do not draft a replacement in the parent.` : "No planning agent is configured; use the parent planning workflow."}\n\nUser requirements:\n${args.trim() || "Use the requirements already discussed in this conversation. Ask if the goal is not clear."}`,
              display: false,
            },
            { triggerTurn: true },
          );
        },
      });
    },
  };
}
