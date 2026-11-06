import { Type, type Static } from "typebox";
import { InputError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { CompletionItem } from "./completion.ts";
import type { WorkflowDocument } from "./task-workflow.ts";

const id = Type.String({ minLength: 1, maxLength: 256 });
export const workflowCommandSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("status"), id: Type.Optional(id) },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Enum(["pause", "resume", "cancel"]), id: Type.Optional(id) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("start"),
      tasks: Type.Array(id, { minItems: 1, maxItems: 128, uniqueItems: true }),
      autoRepair: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal("confirm"), id }, { additionalProperties: false }),
]);
export type WorkflowCommand = Static<typeof workflowCommandSchema>;
export const workflowCommand: CompletionItem = {
  kind: "command",
  value: "workflow",
  description: "Inspect, pause, resume, cancel or explicitly approve a workflow",
  hasArguments: true,
};
export function workflowSummary(doc: WorkflowDocument): string | undefined {
  if (doc.version !== 2) return undefined;
  const invocation = doc.scheduler?.invocations.findLast((item) =>
    ["active", "paused"].includes(item.state),
  );
  if (!invocation) return undefined;
  const counts = new Map<string, number>();
  for (const task of Object.values(doc.tasks))
    if (task.schedule?.invocationId === invocation.id)
      counts.set(task.schedule.state, (counts.get(task.schedule.state) ?? 0) + 1);
  return `${invocation.kind}:${invocation.state} ${[...counts].map(([state, count]) => `${state}:${count}`).join(" ")}`.trim();
}

export function parseWorkflowCommand(text: string): Result<WorkflowCommand | null, InputError> {
  if (!/^\/workflow(?:\s|$)/u.test(text)) return ok(null);
  const parts = text.trim().split(/\s+/u).slice(1);
  const [kind = "status", id] = parts;
  if (["status", "pause", "resume", "cancel"].includes(kind) && parts.length <= 2)
    return ok({ kind: kind as "status" | "pause" | "resume" | "cancel", ...(id ? { id } : {}) });
  if (kind === "confirm" && parts.length === 2 && id) return ok({ kind, id });
  if (kind === "start") {
    const args = parts.slice(1);
    const autoRepair = args.includes("--auto-repair");
    const tasks = args.filter((arg) => arg !== "--auto-repair").flatMap((arg) => arg.split(","));
    if (
      args.filter((arg) => arg === "--auto-repair").length <= 1 &&
      tasks.length > 0 &&
      tasks.length <= 128 &&
      tasks.every((task) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(task)) &&
      new Set(tasks).size === tasks.length &&
      (!tasks.includes("all") || tasks.length === 1)
    )
      return ok({ kind, tasks, autoRepair });
  }
  return err(
    new InputError(
      "Usage: /workflow [status [id] | pause [id] | resume [id] | cancel [id] | start <all|taskIds> [--auto-repair] | confirm <receiptId>]",
    ),
  );
}
