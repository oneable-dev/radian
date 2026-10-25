import type { Subagent } from "./model.ts";
import { parseJson, ProtocolError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

const prefix = "PI_SUBAGENT_ASYNC_JSON:";
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// Consume the extension's bounded RPC snapshot, not Pi terminal text or lifecycle hints.
export function piSubagentsFromWidget(content: readonly string[] | undefined): Result<readonly Subagent[], ProtocolError> {
  if (!content) return ok([]);
  const line = content[0];
  if (content.length !== 1 || !line?.startsWith(prefix) || line.length > 131072)
    return err(new ProtocolError("Invalid Pi subagent status widget."));
  const parsed = parseJson(line.slice(prefix.length), "Pi subagent status");
  if (!parsed.ok) return err(new ProtocolError("Invalid Pi subagent status JSON.", { cause: parsed.error }));
  const snapshot = parsed.value;
  if (!record(snapshot) || snapshot.kind !== "pi-subagents.async-status-snapshot" || snapshot.version !== 1
    || !timestamp(snapshot.generatedAt) || !Array.isArray(snapshot.runs))
    return err(new ProtocolError("Unsupported Pi subagent status snapshot."));
  const generatedAt = snapshot.generatedAt, result: Subagent[] = [], seen = new Set<string>();
  let visited = 0;
  function visit(node: unknown, path: string, depth: number): boolean {
    if (++visited > 256 || depth > 8 || !record(node) || typeof node.id !== "string" || !node.id || node.id.length > 4096
      || typeof node.label !== "string" || node.label.length > 4096 || typeof node.state !== "string") return false;
    if (node.children !== undefined && !Array.isArray(node.children)) return false;
    const children = Array.isArray(node.children) ? node.children : [];
    const id = `${path}/${node.id}`;
    if (id.length > 4096) return false;
    if (node.kind === "host-step" || !["workflow", "subagent", "step"].includes(String(node.kind))) return true;
    const stepWrapper = node.kind === "subagent" && children.some(child => record(child) && child.kind === "step");
    if (node.kind !== "workflow" && !stepWrapper) {
      const status = node.state === "running" ? "working" : node.state === "complete" ? "complete"
        : ["failed", "partial", "rejected"].includes(node.state) ? "failure" : null;
      const phase = node.state === "queued" || node.state === "paused" || node.state === "stopped" || node.state === "rejected" || node.state === "partial" ? node.state : undefined;
      const end = node.state === "running" ? generatedAt : timestamp(node.endedAt) ? node.endedAt : undefined;
      if (!seen.has(id)) {
        seen.add(id);
        result.push({ id, name: node.label, status, source: "pi", ...(phase ? { phase } : {}),
          ...(timestamp(node.startedAt) && end !== undefined ? { runTiming: { startedAt: node.startedAt, elapsedMs: Math.max(0, end - node.startedAt) } } : {}) });
      }
    }
    return children.every(child => visit(child, id, depth + 1));
  }
  if (!snapshot.runs.every(node => visit(node, "pi", 0))) return err(new ProtocolError("Invalid Pi subagent status node."));
  return ok(result);
}
