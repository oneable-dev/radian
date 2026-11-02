import { expect, setSystemTime, spyOn, test } from "bun:test";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { parseCli } from "../app/cli.ts";
import { defaultPreferences } from "./client.ts";
import { ensureSharedDaemon } from "./lifecycle.ts";
import { daemonPaths, privateDirectory } from "./storage.ts";
import { ConnectionError } from "../errors.ts";
import type { RuntimeSnapshot } from "./protocol.ts";

test("TUI startup policy intent is restricted to the internal daemon role", () => {
  // This internal flag carries transaction intent, not a new user-facing workspace command.
  const parsed = expectOk(parseCli(["--runtime-service", "--runtime-attach-chat"]));
  if (parsed.kind !== "run") throw new Error("Expected internal execution options.");

  expect(parsed.options.runtimeAttachChat).toBe(true);
  expect(expectError(parseCli(["--runtime-attach-chat"])).code).toBe("INVALID_INPUT");
});

test("Readiness timeouts retry until the shared deadline without launching a replacement", async () => {
  // Timeout failures must not become absence and launch a replacement owner.
  // A frozen clock jumps per request, so the 15-second budget elapses without waiting for it.
  let attempts = 0;
  setSystemTime(new Date(1_000_000));
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        attempts++;
        setSystemTime(new Date(Date.now() + 2000));
        throw Object.assign(new Error("fixture timeout"), { name: "TimeoutError" });
      },
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    const failure = expectError(
      await ensureSharedDaemon({
        offline: true,
        stateRoot: "/tmp/radian-readiness-exhaustion-unit",
      }),
    );

    expect(failure).toBeInstanceOf(ConnectionError);
    expect(failure.message).toContain("No lifecycle command was replayed");
    expect(attempts).toBe(8);
  } finally {
    fetchMock.mockRestore();
    setSystemTime();
  }
});

test("Shared identity mismatch is terminal after one successful transport observation", async () => {
  // A responsive endpoint is not necessarily the requested shared offline daemon.
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () =>
        Response.json({
          version: 1,
          pid: process.pid,
          instance: "foreign-owner",
          repositoryId: "another-repository",
          mode: "offline",
          capabilities: ["shared-daemon"],
          repositories: [],
          details: {},
          closingCount: 0,
          preferences: defaultPreferences(),
          notice: "",
        }),
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    const failure = expectError(
      await ensureSharedDaemon({ offline: true, stateRoot: "/tmp/radian-readiness-identity-unit" }),
    );

    expect(failure.code).toBe("PROTOCOL_ERROR");
    expect(failure.message).toContain("identity or mode");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    fetchMock.mockRestore();
  }
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
        capabilities: [...snapshot.capabilities!, ...(probes++ < 5 ? ["daemon-starting"] : [])],
      }),
  });
  try {
    // A connector must obtain the subsequent ready snapshot, without starting or stopping another owner.
    const ready = expectOk(await ensureSharedDaemon({ offline: true, stateRoot }));

    expect(ready.instance).toBe(snapshot.instance);
    expect(ready.pid).toBe(process.pid);
    expect(ready.capabilities).not.toContain("daemon-starting");
    expect(probes).toBe(6);
  } finally {
    await server.stop(true);
    await fixture.cleanup();
  }
});
