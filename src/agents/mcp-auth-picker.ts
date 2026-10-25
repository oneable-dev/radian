import { createEventBus, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { CapabilityError, ProtocolError, SessionError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

const serverSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 4096, pattern: "^[^\\r\\n]+$" }),
  status: Type.Union(["connected", "cached", "failed", "needs-auth", "not-connected", "blocked", "disabled"].map(value => Type.Literal(value))),
  disabled: Type.Boolean(),
  blockedReason: Type.Optional(Type.String()),
});
const snapshotSchema = Type.Object({ version: Type.Literal(1), servers: Type.Array(serverSchema, { maxItems: 1000 }) });
type Server = Static<typeof serverSchema>;
const enabled = (server: Server) => !server.disabled && server.status !== "disabled" && server.status !== "blocked" && server.blockedReason === undefined;

// Consume the adapter's sanitized runtime contract, never its config or credential files.
export class McpAuthPicker {
  readonly eventBus = createEventBus();
  private snapshot: Result<Server[], ProtocolError> | undefined;
  private readonly unsubscribe = this.eventBus.on("pi-mcp-adapter/status/v1", value => {
    this.snapshot = Value.Check(snapshotSchema, value)
      ? ok(value.servers.map(server => ({ ...server })))
      : err(new ProtocolError("The MCP adapter sent an unsupported server list. Use /mcp-auth <server> or reload the adapter."));
  });

  reset(): void { this.snapshot = undefined; }

  async select(ui: Pick<ExtensionUIContext, "select" | "notify">): Promise<Result<string | undefined, ExpectedError>> {
    if (!this.snapshot) return err(new CapabilityError("The MCP adapter does not provide a server list. Use /mcp-auth <server>."));
    if (!this.snapshot.ok) return this.snapshot;
    const servers = this.snapshot.value.filter(enabled).sort((a, b) => Number(b.status === "needs-auth") - Number(a.status === "needs-auth") || a.name.localeCompare(b.name));
    if (!servers.length) {
      ui.notify("No enabled MCP servers are available for authentication.", "info");
      return ok(undefined);
    }
    const choice = await ui.select("Authenticate MCP server", servers.map(server => server.name));
    if (choice === undefined) return ok(undefined);
    const current = this.snapshot;
    if (!current?.ok || !current.value.some(server => server.name === choice && enabled(server)))
      return err(new SessionError("SESSION_CONFLICT", "This MCP server is no longer available. Reopen /mcp-auth before authenticating."));
    return ok(choice);
  }

  dispose(): void { this.unsubscribe(); this.reset(); }
}
