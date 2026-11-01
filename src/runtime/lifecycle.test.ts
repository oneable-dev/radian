import { expect, test } from "bun:test";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { parseCli } from "../app/cli.ts";
import { defaultPreferences } from "./client.ts";
import { ensureSharedDaemon } from "./lifecycle.ts";
import { daemonPaths, privateDirectory } from "./storage.ts";
import type { RuntimeSnapshot } from "./protocol.ts";

test("TUI startup policy intent is restricted to the internal daemon role", () => {
  // This internal flag carries transaction intent, not a new user-facing workspace command.
  const parsed = expectOk(parseCli(["--runtime-service", "--runtime-attach-chat"]));
  if (parsed.kind !== "run") throw new Error("Expected internal execution options.");

  expect(parsed.options.runtimeAttachChat).toBe(true);
  expect(expectError(parseCli(["--runtime-attach-chat"])).code).toBe("INVALID_INPUT");
});

test("Lifecycle connectors wait for discovery and restoration instead of adopting a starting daemon", async () => {
  // The first management response advertises an existing owner whose catalog is not prepared yet.
  const fixture = await createWorktreeFixture();
  const stateRoot = join(fixture.directory, "state");
  const paths = daemonPaths(true, stateRoot);
  await privateDirectory(paths.directory);
  let probes = 0;
  const snapshot: RuntimeSnapshot = {
    version: 1,
    pid: process.pid,
    instance: "fixture-starting-owner",
    repositoryId: "radian:shared",
    mode: "offline",
    capabilities: ["shared-daemon"],
    repositories: [],
    details: {},
    closingCount: 0,
    preferences: defaultPreferences(),
    notice: "",
  };
  const server = Bun.serve({
    unix: paths.socket,
    fetch: () =>
      Response.json({
        ...snapshot,
        capabilities: [...snapshot.capabilities!, ...(probes++ === 0 ? ["daemon-starting"] : [])],
      }),
  });
  try {
    // A connector must obtain the subsequent ready snapshot, without starting or stopping another owner.
    const ready = expectOk(await ensureSharedDaemon({ offline: true, stateRoot }));

    expect(ready.instance).toBe(snapshot.instance);
    expect(ready.pid).toBe(process.pid);
    expect(ready.capabilities).not.toContain("daemon-starting");
    expect(probes).toBe(2);
  } finally {
    await server.stop(true);
    await fixture.cleanup();
  }
});
