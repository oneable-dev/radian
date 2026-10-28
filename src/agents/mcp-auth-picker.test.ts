import { expect, test } from "bun:test";
import { McpAuthPicker } from "./mcp-auth-picker.ts";
import { expectError, expectOk } from "../testing/results.ts";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const channel = "pi-mcp-adapter/status/v1";
const server = (name: string, status = "cached", disabled = false) => ({ name, status, disabled });

// Only the selector and notification boundary is used by this controller.
function ui(select: ExtensionUIContext["select"], notify: ExtensionUIContext["notify"] = () => {}) {
  return { select, notify };
}

test("MCP authentication lists enabled servers with those needing authentication first", async () => {
  // Disabled and trust-blocked servers must never become authentication targets.
  const picker = new McpAuthPicker();
  picker.eventBus.emit(channel, {
    version: 1,
    servers: [
      server("zebra"),
      server("vercel", "needs-auth"),
      server("alpha"),
      server("disabled", "disabled"),
      server("blocked", "blocked"),
      server("flagged", "cached", true),
    ],
  });

  let options: string[] = [];

  const chosen = await picker.select(
    ui(async (_title, candidates) => {
      options = candidates;

      return "vercel";
    }),
  );

  expect(expectOk(chosen)).toBe("vercel");
  expect(options).toEqual(["vercel", "alpha", "zebra"]);
  picker.dispose();
});

test("MCP authentication cancellation does not choose the highlighted server", async () => {
  // Previewing a choice is not authorization to run its authentication command.
  const picker = new McpAuthPicker();
  picker.eventBus.emit(channel, { version: 1, servers: [server("vercel")] });

  const chosen = await picker.select(ui(async () => undefined));

  expect(expectOk(chosen)).toBeUndefined();
  picker.dispose();
});

test("MCP authentication rejects servers disabled while the selector is open", async () => {
  // A runtime update can revoke availability before explicit activation.
  const picker = new McpAuthPicker();
  picker.eventBus.emit(channel, { version: 1, servers: [server("vercel")] });

  const chosen = await picker.select(
    ui(async () => {
      picker.eventBus.emit(channel, { version: 1, servers: [server("vercel", "disabled", true)] });

      return "vercel";
    }),
  );

  expect(expectError(chosen).code).toBe("SESSION_CONFLICT");
  picker.dispose();
});

test("MCP authentication reports an empty enabled list without opening a selector", async () => {
  // An initialized empty catalog differs from an unavailable integration contract.
  const picker = new McpAuthPicker();
  picker.eventBus.emit(channel, { version: 1, servers: [] });

  let message = "";
  let selections = 0;

  const chosen = await picker.select(
    ui(
      async () => {
        selections++;

        return undefined;
      },
      (text) => {
        message = text;
      },
    ),
  );

  expect(expectOk(chosen)).toBeUndefined();
  expect(selections).toBe(0);
  expect(message).toBe("No enabled MCP servers are available for authentication.");
  picker.dispose();
});

test.each([
  { version: 2, servers: [] },
  { version: 1, servers: [server("vercel", "unknown")] },
  { version: 1, servers: [{ name: "vercel" }] },
])(
  "Malformed MCP snapshots fail explicitly instead of retaining stale choices: %j",
  async (snapshot) => {
    // A previous valid event must not mask a later incompatible contract.
    const picker = new McpAuthPicker();
    picker.eventBus.emit(channel, { version: 1, servers: [server("vercel")] });

    picker.eventBus.emit(channel, snapshot);

    const chosen = await picker.select(
      ui(async () => {
        throw new Error("Invalid snapshots must not open a selector");
      }),
    );

    expect(expectError(chosen).code).toBe("PROTOCOL_ERROR");
    picker.dispose();
  },
);

test("MCP reload resets the catalog and disposal stops status observation", async () => {
  // A new extension runtime must publish its own server list rather than inherit the old one.
  const picker = new McpAuthPicker();
  picker.eventBus.emit(channel, { version: 1, servers: [server("vercel")] });

  picker.reset();

  const chosen = await picker.select(
    ui(async () => {
      throw new Error("Missing catalogs must not open a selector");
    }),
  );
  picker.dispose();
  picker.eventBus.emit(channel, { version: 1, servers: [server("stale")] });

  expect(expectError(chosen).code).toBe("UNSUPPORTED_CAPABILITY");

  const disposed = await picker.select(
    ui(async () => {
      throw new Error("Disposed pickers must not observe new catalogs");
    }),
  );
  expect(expectError(disposed).code).toBe("UNSUPPORTED_CAPABILITY");
});
