import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import instructions from "../../resources/skills/graph-plan/SKILL.md" with { type: "text" };
import {
  CancelledError,
  CapabilityError,
  InputError,
  SessionError,
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

const requestMessageType = "radian.task-plan-request";
const resultMessageType = "radian.task-plan";
const contextMessageType = "radian.task-plan-context";

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

/** A conversation-scoped planner, not a task scheduler or an OS sandbox. */
export function taskPlanningExtension(
  recordRequest?: (invocation: string) => void,
): InlineExtension {
  return {
    name: "radian-plan",
    replaceable: true,
    factory: (pi) => {
      let planning = false;
      let submitted = false;

      pi.on("before_agent_start", (event) => {
        planning =
          event.messageType === "custom" && event.message.customType === requestMessageType;
        submitted = false;
      });
      // Rehydrate only the request context; do not append another plan pointer to saved history.
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
        if (!current.value) return;
        return {
          messages: [
            ...event.messages,
            {
              role: "custom" as const,
              customType: contextMessageType,
              content: `The conversation-wide current plan is ${planFilePath(target.value.file)} (SHA-256 ${current.value.hash}). Goal: ${current.value.plan.goal}. Read it with radian-plan before relying on or revising details. Older plan submissions in the transcript do not replace this current file. Its structural validity is not user approval or proof of task completion. Before reporting completion of user-authorized implementation of this plan, compare its applicable acceptance criteria with the actual changes and verification evidence; report unmet or unverified criteria. Do not apply this plan to unrelated requests or execute acceptance commands during /plan.`,
              display: false,
              timestamp: Date.now(),
            },
          ],
        };
      });

      pi.on("tool_call", (event) => {
        if (!planning) return;
        const delegation = ["radian-subagent", "radian_subagent", "subagent"].includes(
          event.toolName,
        );
        if (
          event.toolName === "edit" ||
          event.toolName === "write" ||
          (delegation && (!("action" in event.input) || event.input.action !== "list"))
        ) {
          return {
            block: true,
            reason:
              "/plan only investigates and writes its plan artifact; it does not edit product files or execute delegated work.",
          };
        }
      });
      pi.on("agent_before_settle", (event) => {
        if (planning && !submitted && event.outcome === "completed") {
          return {
            entries: [
              {
                type: "custom_message",
                customType: resultMessageType,
                content:
                  "No new structurally validated plan was saved. Any earlier current plan remains unchanged. Clarify outstanding questions or run /plan again to finish planning.",
                display: true,
              },
            ],
          };
        }
      });
      pi.on("agent_settled", () => {
        planning = false;
      });
      pi.on("session_shutdown", () => {
        planning = false;
      });

      pi.registerTool({
        name: "radian-plan",
        label: "Task plan",
        description:
          "Read the current conversation's authoritative task graph, or submit a complete plan and agent semantic review during /plan. Submission validates structure and atomically replaces one current artifact; it never executes tasks or implies user approval.",
        executionMode: "sequential",
        parameters: Type.Object(
          {
            action: Type.Union([Type.Literal("read"), Type.Literal("submit")]),
            plan: Type.Optional(taskPlanSchema),
            review: Type.Optional(planReviewSchema),
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
          if (!planning) throw new InputError("Start /plan before submitting a task graph.");
          const saved = await saveTaskPlan(file, owner, args.plan, args.review);
          if (!saved.ok) throw saved.error;
          submitted = true;
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
          const input = args.trim();
          recordRequest?.(`/plan${args ? ` ${args}` : ""}`);
          pi.sendMessage(
            {
              customType: requestMessageType,
              content: `${instructions}\n\nUser requirements:\n${input || "Use the requirements already discussed in this conversation. Ask if the goal is not clear."}`,
              display: true,
            },
            { triggerTurn: true },
          );
        },
      });
    },
  };
}
