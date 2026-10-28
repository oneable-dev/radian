import type { Subagent } from "./model.ts";
import { parseJson, ProtocolError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

const prefix = "PI_SUBAGENT_ASYNC_JSON:";
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// Lifecycle state comes only from the bounded RPC snapshot; exact launch metadata enriches display text.
export function piSubagentsFromWidget(
  content: readonly string[] | undefined,
  lookup?: (id: string, parent?: string) => Pick<Subagent, "name" | "request"> | undefined,
): Result<readonly Subagent[], ProtocolError> {
  if (!content) {
    return ok([]);
  }

  const line = content[0];
  if (content.length !== 1 || !line?.startsWith(prefix) || line.length > 131072) {
    return err(new ProtocolError("Invalid Pi subagent status widget."));
  }

  const parsed = parseJson(line.slice(prefix.length), "Pi subagent status");
  if (!parsed.ok) {
    return err(new ProtocolError("Invalid Pi subagent status JSON.", { cause: parsed.error }));
  }

  const snapshot = parsed.value;
  if (
    !record(snapshot) ||
    snapshot.kind !== "pi-subagents.async-status-snapshot" ||
    snapshot.version !== 1 ||
    !timestamp(snapshot.generatedAt) ||
    !Array.isArray(snapshot.runs)
  ) {
    return err(new ProtocolError("Unsupported Pi subagent status snapshot."));
  }

  const generatedAt = snapshot.generatedAt;
  const result: Subagent[] = [];
  const seen = new Set<string>();
  let visited = 0;

  function visit(
    node: unknown,
    path: string,
    depth: number,
    parent?: string,
    inherited?: Pick<Subagent, "name" | "request">,
  ): boolean {
    if (
      ++visited > 256 ||
      depth > 8 ||
      !record(node) ||
      typeof node.id !== "string" ||
      !node.id ||
      node.id.length > 4096 ||
      typeof node.label !== "string" ||
      node.label.length > 4096 ||
      typeof node.state !== "string"
    ) {
      return false;
    }
    if (node.children !== undefined && !Array.isArray(node.children)) {
      return false;
    }

    const children = Array.isArray(node.children) ? node.children : [];
    const nodeId = node.id;
    const id = `${path}/${nodeId}`;
    if (id.length > 4096) {
      return false;
    }
    if (
      node.kind === "host-step" ||
      !["workflow", "subagent", "step"].includes(String(node.kind))
    ) {
      return true;
    }

    const stepWrapper =
      node.kind === "subagent" && children.some((child) => record(child) && child.kind === "step");
    const display = lookup?.(nodeId, parent) ?? inherited;
    if (node.kind !== "workflow" && !stepWrapper) {
      let status: Subagent["status"] = null;
      if (node.state === "running") {
        status = "working";
      } else if (node.state === "complete") {
        status = "complete";
      } else if (["failed", "partial", "rejected"].includes(node.state)) {
        status = "failure";
      }
      const phase =
        node.state === "queued" ||
        node.state === "paused" ||
        node.state === "stopped" ||
        node.state === "rejected" ||
        node.state === "partial"
          ? node.state
          : undefined;
      let end: number | undefined;
      if (node.state === "running") {
        end = generatedAt;
      } else if (timestamp(node.endedAt)) {
        end = node.endedAt;
      }
      if (!seen.has(id)) {
        seen.add(id);
        result.push({
          id,
          name: display?.name ?? node.label,
          status,
          source: "pi",
          ...(phase ? { phase } : {}),
          ...(display?.request ? { request: display.request } : {}),
          ...(timestamp(node.startedAt) && end !== undefined
            ? {
                runTiming: {
                  startedAt: node.startedAt,
                  elapsedMs: Math.max(0, end - node.startedAt),
                },
              }
            : {}),
        });
      }
    }

    return children.every((child) =>
      visit(child, id, depth + 1, nodeId, stepWrapper ? display : undefined),
    );
  }

  if (!snapshot.runs.every((node) => visit(node, "pi", 0))) {
    return err(new ProtocolError("Invalid Pi subagent status node."));
  }

  return ok(result);
}
