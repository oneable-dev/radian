import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
  commandSchema,
  emptyPreferences,
  parseSnapshot,
  protocolVersion,
  type RuntimeManifest,
} from "./protocol.ts";
import { daemonPaths, privateDirectory, runtimePaths, RuntimeStore } from "./storage.ts";
import { RuntimeClient } from "./client.ts";
import { expectOk, expectError } from "../testing/results.ts";

test("Invalid protocol commands and snapshots fail at execution boundaries", () => {
  // Local IPC is private but still receives untyped JSON across a process boundary.
  const malformed = [
    { type: "prompt", sessionId: "id" },
    { type: "close", sessionId: 3 },
    { type: "unknown" },
  ];

  // Validate the command shape before it reaches SDK execution.
  const accepted = malformed.map((command) => Value.Check(commandSchema, command));

  // Unknown operations and incompatible snapshots cannot mutate runtime state.
  expect(accepted).toEqual([false, false, false]);
  expect(expectError(parseSnapshot({ version: 99 })).code).toBe("PROTOCOL_ERROR");
});

test("Live/test modes and state directories use separate endpoints within socket path limits", () => {
  // Separate namespaces prevent a scripted client from attaching to a paid live session.
  const root = "/tmp/" + "long-directory-".repeat(30);

  // Socket placement is independent of the state's filesystem path length.
  const live = runtimePaths("/repo/.git", false, root);
  const offline = runtimePaths("/repo/.git", true, root);
  const other = runtimePaths("/repo/.git", false, root + "other");

  // Identity includes mode/state-root and remains within macOS's address length.
  expect(live.socket).not.toBe(offline.socket);
  expect(live.socket).not.toBe(other.socket);
  expect(Buffer.byteLength(live.socket)).toBeLessThan(100);
  expect(daemonPaths(false, root).socket).not.toBe(daemonPaths(true, root).socket);
  expect(daemonPaths(false, root).socket).not.toBe(daemonPaths(false, root + "other").socket);
  expect(Buffer.byteLength(daemonPaths(false, root).socket)).toBeLessThan(100);
});

test("Corrupt manifests never become empty success or overwritten source", async () => {
  // Corruption must remain diagnosable instead of silently losing the open-session list.
  const root = await mkdtemp(join(tmpdir(), "radian-store-test-"));
  const paths = runtimePaths("/repo/.git", true, root);
  try {
    await privateDirectory(paths.directory);
    await writeFile(paths.manifest, '{"version":99}', { mode: 0o600 });
    const store = new RuntimeStore(paths);

    // Refuse the incompatible file rather than creating a new empty checkpoint.
    expect(expectError(await store.load("/repo/.git")).code).toBe("STORAGE_FAILED");

    // The original input remains available for recovery.
    expect(await readFile(paths.manifest, "utf8")).toBe('{"version":99}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Manifests save atomically and cannot restore another repository's state", async () => {
  // Two queued preference changes must not reorder persisted workspace state.
  const root = await mkdtemp(join(tmpdir(), "radian-store-test-"));
  const paths = runtimePaths("/repo/.git", true, root);
  try {
    await privateDirectory(paths.directory);
    const store = new RuntimeStore(paths);
    const first: RuntimeManifest = {
      version: protocolVersion,
      repositoryId: "/repo/.git",
      repositories: [],
      records: [],
      preferences: structuredClone(emptyPreferences),
    };
    const second = {
      ...first,
      preferences: { ...first.preferences, drafts: { id: "latest draft" } },
    };

    // The write queue preserves invocation order and publishes a complete JSON document.
    await Promise.all([store.save(first), store.save(second)]);

    // Restore returns the last checkpoint only to its matching repository.
    expect(expectOk(await store.load("/repo/.git"))?.preferences.drafts.id).toBe("latest draft");
    expect(expectError(await store.load("/other/.git")).code).toBe("STORAGE_FAILED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Legacy services report missing History support without automatic termination or replacement", async () => {
  // Protocol-v1 services may already own user jobs before the additive history capability ships.
  const client = new RuntimeClient(runtimePaths("/repo/.git", true, "/unused"), {
    version: protocolVersion,
    pid: process.pid,
    instance: "legacy",
    repositoryId: "/repo/.git",
    mode: "offline",
    repositories: [],
    details: {},
    closingCount: 0,
    preferences: structuredClone(emptyPreferences),
    notice: "",
  });

  // The guard rejects locally, without sending a stop or starting a replacement daemon.
  expect(expectError(await client.listHistory("worktree")).code).toBe("UNSUPPORTED_CAPABILITY");
  expect(expectError(await client.resume("worktree", "saved")).code).toBe("UNSUPPORTED_CAPABILITY");

  // The original service identity remains intact for ordinary execution and user-directed shutdown.
  expect(client.snapshot.instance).toBe("legacy");
  await client.disconnect();
});
