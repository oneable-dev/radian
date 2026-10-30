import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import instructions from "../../resources/skills/graph-plan/SKILL.md" with { type: "text" };
import {
  CancelledError,
  CapabilityError,
  capture,
  InputError,
  SessionError,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { renderTaskPlan, taskPlanSchema } from "./task-plan.ts";
import {
  clearTaskPlan,
  planFilePath,
  planReviewSchema,
  readTaskPlan,
  saveTaskPlan,
  type PlanOwner,
  type StoredTaskPlan,
} from "./task-plan-store.ts";

const requestMarker = "<radian-graph-plan>";
const messageType = "radian.task-plan";
const subcommands = ["show", "check", "clear", "export"] as const;

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
export function taskPlanningExtension(): InlineExtension {
  return {
    name: "radian-plan",
    replaceable: true,
    factory: (pi) => {
      let planning = false;
      let submitted = false;

      pi.on("before_agent_start", (event) => {
        planning = event.messageType === "user" && event.prompt.startsWith(requestMarker);
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
              customType: "radian.task-plan-context",
              content: `The conversation-wide current plan is ${planFilePath(target.value.file)} (SHA-256 ${current.value.hash}). Goal: ${current.value.plan.goal}. Read it with radian-plan before relying on or revising details. Older plan submissions in the transcript do not replace this current file. Its structural validity is not user approval or proof of task completion.`,
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
                customType: messageType,
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
        description:
          "Create a task/delegation graph without executing it: /plan [requirements] | show | check | clear | export <path>",
        getArgumentCompletions: (prefix) =>
          subcommands
            .filter((value) => value.startsWith(prefix))
            .map((value) => ({ value, label: value })),
        handler: async (args, ctx) => {
          const input = args.trim();
          const [action] = input.split(/\s+/u);
          const control = subcommands.some((name) => name === action);
          if (!ctx.isIdle())
            throw new SessionError(
              "SESSION_BUSY",
              "Wait for the current run before changing or inspecting its task plan.",
            );
          if (!control) {
            pi.sendUserMessage(
              `${requestMarker}\n${instructions}\n\nUser requirements:\n${input || "Use the requirements already discussed in this conversation. Ask if the goal is not clear."}\n</radian-graph-plan>`,
            );
            return;
          }
          const target = location(ctx);
          if (!target.ok) throw target.error;
          const { file, owner } = target.value;
          if (action !== "export" && input !== action)
            throw new InputError(`Usage: /plan ${action}`);
          if (action === "clear") {
            const removed = await clearTaskPlan(file, owner);
            if (!removed.ok) throw removed.error;
            pi.sendMessage({
              customType: messageType,
              content:
                "Current task plan cleared. Conversation history and exported files were not changed.",
              display: true,
            });
            return;
          }
          const current = await readTaskPlan(file, owner);
          if (!current.ok) throw current.error;
          if (!current.value) throw new InputError("This conversation has no saved task plan.");
          if (action === "export") {
            const path = input.slice("export".length).trim();
            if (!path || path.includes("\0")) throw new InputError("Usage: /plan export <path>");
            const destination = resolve(ctx.cwd, path);
            const exported = await capture(() =>
              writeFile(destination, JSON.stringify(current.value, null, 2) + "\n", {
                flag: "wx",
                mode: 0o600,
              }),
            );
            if (!exported.ok) throw exported.error;
            pi.sendMessage({
              customType: messageType,
              content: `Task plan exported to ${destination}. This independent copy is not removed by session retention.`,
              display: true,
            });
            return;
          }
          pi.sendMessage({
            customType: messageType,
            content: report(current.value, file),
            display: true,
          });
        },
      });
    },
  };
}
