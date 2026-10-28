import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ProtocolError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

export const mcpStatusChannel = "pi-mcp-adapter/status/v1";
const serverSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 4096, pattern: "^[^\\r\\n]+$" }),
  status: Type.Union(
    ["connected", "cached", "failed", "needs-auth", "not-connected", "blocked", "disabled"].map(
      (value) => Type.Literal(value),
    ),
  ),
  disabled: Type.Boolean(),
  blockedReason: Type.Optional(Type.String()),
});
const snapshotSchema = Type.Object({
  version: Type.Literal(1),
  servers: Type.Array(serverSchema, { maxItems: 1000 }),
});
export type McpServer = Static<typeof serverSchema>;
export const mcpStatusSchema = Type.Object({
  servers: Type.Integer({ minimum: 0, maximum: 1000 }),
  needsAuth: Type.Integer({ minimum: 0, maximum: 1000 }),
  errors: Type.Integer({ minimum: 0, maximum: 1000 }),
});
export type McpStatus = Static<typeof mcpStatusSchema>;
export const enabledMcpServer = (server: McpServer): boolean =>
  !server.disabled &&
  server.status !== "disabled" &&
  server.status !== "blocked" &&
  server.blockedReason === undefined;

// Read only the adapter's sanitized runtime contract, never configuration or credentials.
export function readMcpServers(value: unknown): Result<McpServer[], ProtocolError> {
  return Value.Check(snapshotSchema, value)
    ? ok(value.servers.map((server) => ({ ...server })))
    : err(
        new ProtocolError(
          "The MCP adapter sent an unsupported server list. Use /mcp-auth <server> or reload the adapter.",
        ),
      );
}

export function summarizeMcpServers(servers: readonly McpServer[]): McpStatus {
  const enabled = servers.filter(enabledMcpServer);
  return {
    servers: enabled.length,
    needsAuth: enabled.filter((server) => server.status === "needs-auth").length,
    errors: enabled.filter((server) => server.status === "failed").length,
  };
}
