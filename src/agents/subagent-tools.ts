import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { CapabilityError, InputError, type ExpectedError } from "../errors.ts";
import { Value } from "typebox/value";
import type { Result } from "../result.ts";
import { planningProposalSchema } from "./planning-proposal.ts";

const id = Type.String({ minLength: 1, maxLength: 256 });
const message = Type.String({ minLength: 1, maxLength: 16384 });
export const subagentCommandSchema = Type.Union([
  Type.Object({ action: Type.Literal("list") }),
  Type.Object({
    action: Type.Literal("spawn"),
    agent: id,
    task: message,
    async: Type.Optional(Type.Boolean()),
  }),
  Type.Object({ action: Type.Literal("status"), id: Type.Optional(id) }),
  Type.Object({ action: Type.Literal("wait"), id: Type.Optional(id) }),
  Type.Object({ action: Type.Literal("steer"), id, message }),
  Type.Object({ action: Type.Literal("reply"), id, questionId: id, message }),
  Type.Object({ action: Type.Literal("stop"), id }),
]);
export type SubagentCommand = Static<typeof subagentCommandSchema>;
export const supervisorCommandSchema = Type.Union([
  Type.Object({ action: Type.Literal("progress"), message }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("ask"), message }, { additionalProperties: false }),
  Type.Object(
    { action: Type.Literal("proposal"), proposal: planningProposalSchema },
    { additionalProperties: false },
  ),
]);
export type SupervisorCommand = Static<typeof supervisorCommandSchema>;
export type SubagentHandler<T> = (
  command: T,
  signal?: AbortSignal,
) => Promise<Result<unknown, ExpectedError>>;

export function subagentTool(handler?: SubagentHandler<SubagentCommand>) {
  return defineTool({
    name: "radian-subagent",
    label: "Subagent",
    description:
      "Run named agent profiles in this worktree. list discovers profiles; spawn is asynchronous by default and returns an id; status reads progress/questions/results; wait returns when work finishes or needs a reply; steer queues guidance; reply answers a specific question; stop cancels owned work. No shared conversation or implicit rollback.",
    promptSnippet: "Delegate to configured agents and coordinate owned runs with radian-subagent.",
    parameters: Type.Object(
      {
        action: Type.Union(
          ["list", "spawn", "status", "wait", "steer", "reply", "stop"].map((action) =>
            Type.Literal(action),
          ),
        ),
        agent: Type.Optional(id),
        task: Type.Optional(message),
        async: Type.Optional(Type.Boolean()),
        id: Type.Optional(id),
        questionId: Type.Optional(id),
        message: Type.Optional(message),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, command, signal) => {
      if (!Value.Check(subagentCommandSchema, command))
        throw new InputError("Missing or invalid fields for this subagent action.");
      if (!handler) throw new CapabilityError("This session does not host subagent coordination.");
      const result = await handler(command, signal);
      if (!result.ok) throw result.error;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.value) }],
        details: result.value,
      };
    },
  });
}

export function supervisorTool(handler?: SubagentHandler<SupervisorCommand>, planning = false) {
  return defineTool({
    name: "radian-supervisor",
    label: "Supervisor",
    description:
      "Contact your owning parent. progress records an update; ask waits for a decision. A planning-only run may submit its complete plan and review with proposal; this never writes a plan file or executes tasks.",
    promptSnippet:
      "Report meaningful progress or ask your parent for a decision with radian-supervisor.",
    parameters: Type.Object(
      {
        action: Type.Union(
          (planning ? ["progress", "ask", "proposal"] : ["progress", "ask"]).map((action) =>
            Type.Literal(action),
          ),
        ),
        message: Type.Optional(message),
        ...(planning ? { proposal: Type.Optional(planningProposalSchema) } : {}),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, command, signal) => {
      if (!Value.Check(supervisorCommandSchema, command))
        throw new InputError("Missing or invalid fields for this supervisor action.");
      if (command.action === "proposal" && !planning)
        throw new CapabilityError("Only a host-designated planning run may submit a proposal.");
      if (!handler) throw new CapabilityError("This session has no owning supervisor.");
      const result = await handler(command, signal);
      if (!result.ok) throw result.error;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.value) }],
        details: result.value,
      };
    },
  });
}
