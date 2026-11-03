import { InputError, WorkflowError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { CompletionItem } from "./completion.ts";
import {
  renderHumanHandoff,
  renderWorkflowStatus,
  type WorkflowDocument,
} from "./task-workflow.ts";
export { renderWorkflowStatus } from "./task-workflow.ts";

declare const userCommandBrand: unique symbol;
/** Construct only at the host's direct user-input boundary, never from model/tool text. */
export type UserCommandProvenance = {
  readonly kind: "user-command";
  readonly conversationId: string;
  readonly receivedAt: number;
  readonly [userCommandBrand]: true;
};
export type RepairCommand =
  | { kind: "status"; id?: string }
  | { kind: "recheck" | "cancel"; id: string }
  | { kind: "continue"; workflowId: string };
export const repairCommand: CompletionItem = {
  kind: "command",
  value: "repair",
  description: "Inspect workflow status or request human repair/recheck",
  hasArguments: true,
};
export function parseRepairCommand(text: string): Result<RepairCommand | null, InputError> {
  if (!/^\/repair(?:\s|$)/u.test(text)) return ok(null);
  const parts = text.trim().split(/\s+/u).slice(1);
  if (parts.length === 0) return ok({ kind: "status" });
  const [kind, id] = parts;
  if (kind === "status" && parts.length <= 2) return ok({ kind, ...(id ? { id } : {}) });
  if ((kind === "recheck" || kind === "cancel") && parts.length === 2 && id)
    return ok({ kind, id });
  if (
    kind === "continue" &&
    parts.length === 2 &&
    id &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(id)
  )
    return ok({ kind, workflowId: id });
  return err(
    new InputError(
      "Usage: /repair [status [id] | recheck <id> | cancel <id> | continue <workflowId>]",
    ),
  );
}
export function userCommandProvenance(
  conversationId: string,
  receivedAt: number,
): UserCommandProvenance {
  return { kind: "user-command", conversationId, receivedAt } as UserCommandProvenance;
}
export function renderRepairStatus(
  doc: WorkflowDocument,
  id?: string,
): Result<string, WorkflowError> {
  if (id && doc.defects[id]) return renderHumanHandoff(doc, id);
  const status = renderWorkflowStatus(doc, id).slice(0, 16000);
  const displayed = new Set(status.split("\n").map((line) => line.trim()));
  const handoffs = Object.values(doc.defects)
    .filter(
      (defect) =>
        (!id || defect.responsibleTasks.includes(id)) &&
        ["analysis-pending", "human-required"].includes(defect.state),
    )
    .map((defect) => `handoff: /repair status ${defect.id}`)
    .filter((command) => !displayed.has(command));
  return ok([status, ...handoffs].join("\n").slice(0, 60000));
}

export function resolveRepairId(doc: WorkflowDocument, id: string): Result<string, WorkflowError> {
  const ids = [...new Set([...Object.keys(doc.tasks), ...Object.keys(doc.defects)])];
  if (ids.includes(id)) return ok(id);
  const matches = id.length >= 6 ? ids.filter((candidate) => candidate.startsWith(id)) : [];
  if (matches.length === 1) return ok(matches[0]!);
  return err(
    new WorkflowError(
      matches.length ? "WORKFLOW_CONFLICT" : "WORKFLOW_NOT_FOUND",
      matches.length
        ? "Repair ID prefix is ambiguous."
        : "Task or defect ID not found (prefixes require at least six characters).",
    ),
  );
}
