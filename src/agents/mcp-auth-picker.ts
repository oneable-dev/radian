import { createEventBus, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { CapabilityError, ProtocolError, SessionError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import {
  enabledMcpServer,
  mcpStatusChannel,
  readMcpServers,
  type McpServer,
} from "./mcp-status.ts";

// Consume the adapter's sanitized runtime contract, never its config or credential files.
export class McpAuthPicker {
  readonly eventBus = createEventBus();
  private snapshot: Result<McpServer[], ProtocolError> | undefined;
  private readonly unsubscribe = this.eventBus.on(mcpStatusChannel, (value) => {
    this.snapshot = readMcpServers(value);
  });

  reset(): void {
    this.snapshot = undefined;
  }

  async select(
    ui: Pick<ExtensionUIContext, "select" | "notify">,
  ): Promise<Result<string | undefined, ExpectedError>> {
    if (!this.snapshot) {
      return err(
        new CapabilityError(
          "The MCP adapter does not provide a server list. Use /mcp-auth <server>.",
        ),
      );
    }
    if (!this.snapshot.ok) {
      return this.snapshot;
    }

    const servers = this.snapshot.value
      .filter(enabledMcpServer)
      .sort(
        (a, b) =>
          Number(b.status === "needs-auth") - Number(a.status === "needs-auth") ||
          a.name.localeCompare(b.name),
      );
    if (!servers.length) {
      ui.notify("No enabled MCP servers are available for authentication.", "info");

      return ok(undefined);
    }

    const choice = await ui.select(
      "MCP authentication",
      servers.map((server) => server.name),
    );
    if (choice === undefined) {
      return ok(undefined);
    }

    const current = this.snapshot;
    if (
      !current?.ok ||
      !current.value.some((server) => server.name === choice && enabledMcpServer(server))
    ) {
      return err(
        new SessionError(
          "SESSION_CONFLICT",
          "This MCP server is no longer available. Reopen /mcp-auth before authenticating.",
        ),
      );
    }

    return ok(choice);
  }

  dispose(): void {
    this.unsubscribe();
    this.reset();
  }
}
