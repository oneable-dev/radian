import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { CapabilityError, type ExpectedError } from "../errors.ts";
import { declareActionTool } from "./tool-protocol.ts";
import type { Result } from "../result.ts";
import { planningProposalSchema } from "./planning-proposal.ts";

const id = Type.String({ minLength: 1, maxLength: 256 });
const message = Type.String({ minLength: 1, maxLength: 16384 });
export const taskSpawnBindingSchema = Type.Object(
  {
    id,
    role: Type.Enum(["lead", "implementer", "verifier", "worker"]),
    purpose: Type.Optional(Type.Literal("analysis")),
    defectId: Type.Optional(id),
    attemptId: Type.Optional(id),
  },
  { additionalProperties: false },
);
export type TaskSpawnBinding = Static<typeof taskSpawnBindingSchema>;
const subagentActions = [
  Type.Object({ action: Type.Literal("list") }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("spawn"),
      agent: id,
      task: message,
      binding: Type.Optional(taskSpawnBindingSchema),
      async: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("status"), id: Type.Optional(id) },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("wait"), id: Type.Optional(id) },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("steer"), id, message }, { additionalProperties: false }),
  Type.Object(
    { action: Type.Literal("reply"), id, questionId: id, message },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("stop"), id }, { additionalProperties: false }),
] as const;
export const subagentProtocol = declareActionTool(subagentActions);
export const subagentCommandSchema = subagentProtocol.parameters;
export type SubagentCommand = Static<(typeof subagentActions)[number]>;
const supervisorActions = [
  Type.Object({ action: Type.Literal("progress"), message }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("ask"), message }, { additionalProperties: false }),
  Type.Object(
    { action: Type.Literal("proposal"), proposal: planningProposalSchema },
    { additionalProperties: false },
  ),
] as const;
export const supervisorProtocol = declareActionTool(supervisorActions);
export const supervisorCommandSchema = supervisorProtocol.parameters;
export type SupervisorCommand = Static<(typeof supervisorActions)[number]>;
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
    ...subagentProtocol,
    execute: async (_id, raw, signal) => {
      const validated = subagentProtocol.validateAction(raw);
      if (!validated.ok) throw validated.error;
      const command = validated.value;
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
  const protocol = planning
    ? supervisorProtocol
    : declareActionTool([supervisorActions[0], supervisorActions[1]]);
  return defineTool({
    name: "radian-supervisor",
    label: "Supervisor",
    description:
      "Contact your owning parent. progress records an update; ask waits for a decision. A planning-only run may submit its complete plan and review with proposal; this never writes a plan file or executes tasks.",
    promptSnippet:
      "Report meaningful progress or ask your parent for a decision with radian-supervisor.",
    ...protocol,
    execute: async (_id, raw, signal) => {
      const validated = protocol.validateAction(raw);
      if (!validated.ok) throw validated.error;
      const command = validated.value;
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
