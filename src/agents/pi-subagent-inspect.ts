import { ProtocolError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

export type SubagentInspection = { text: string; failed: boolean };

export function readSubagentInspection(
  content: unknown,
): Result<SubagentInspection, ProtocolError> {
  const prefix = "PI_SUBAGENT_INSPECT_JSON:";
  if (
    !Array.isArray(content) ||
    content.length !== 1 ||
    typeof content[0] !== "string" ||
    !content[0].startsWith(prefix) ||
    Buffer.byteLength(content[0]) > 65536 + prefix.length
  ) {
    return err(new ProtocolError("Malformed subagent inspection reply."));
  }
  let value: unknown;
  try {
    value = JSON.parse(content[0].slice(prefix.length));
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    return err(new ProtocolError("Malformed subagent inspection JSON.", { cause }));
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("kind" in value) ||
    value.kind !== "pi-subagents.inspect-reply" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("requestId" in value) ||
    typeof value.requestId !== "string"
  ) {
    return err(new ProtocolError("Unsupported subagent inspection reply."));
  }
  return ok({ text: JSON.stringify(value, null, 2), failed: "error" in value });
}
