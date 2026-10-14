import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { commandSchema, emptyPreferences, parseSnapshot, protocolVersion, type RuntimeManifest } from "./protocol.ts";
import { privateDirectory, runtimePaths, RuntimeStore } from "./storage.ts";
import { RuntimeClient } from "./client.ts";

test("유효하지 않은 프로토콜 명령과 snapshot은 실행 경계에서 거부한다", () => {
  // Local IPC is private but still receives untyped JSON across a process boundary.
  const malformed = [{ type: "prompt", sessionId: "id" }, { type: "close", sessionId: 3 }, { type: "unknown" }];

  // Validate the command shape before it reaches SDK execution.
  const accepted = malformed.map((command) => Value.Check(commandSchema, command));

  // Unknown operations and incompatible snapshots cannot mutate runtime state.
  expect(accepted).toEqual([false, false, false]);
  expect(() => parseSnapshot({ version: 99 })).toThrow("Incompatible");
});

test("live/test 모드와 상태 디렉터리는 다른 endpoint를 사용하고 긴 경로도 socket 제한을 넘지 않는다", () => {
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
});

test("손상된 manifest는 빈 성공으로 바꾸거나 원본 파일을 덮어쓰지 않는다", async () => {
  // Corruption must remain diagnosable instead of silently losing the open-session list.
  const root = await mkdtemp(join(tmpdir(), "radian-store-test-"));
  const paths = runtimePaths("/repo/.git", true, root);
  try {
    await privateDirectory(paths.directory);
    await writeFile(paths.manifest, '{"version":99}', { mode: 0o600 });
    const store = new RuntimeStore(paths);

    // Refuse the incompatible file rather than creating a new empty checkpoint.
    await expect(store.load("/repo/.git")).rejects.toThrow("Invalid runtime manifest");

    // The original input remains available for recovery.
    expect(await readFile(paths.manifest, "utf8")).toBe('{"version":99}');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("manifest는 원자적으로 저장되고 다른 레포의 상태로 복원되지 않는다", async () => {
  // Two queued preference changes must not reorder persisted workspace state.
  const root = await mkdtemp(join(tmpdir(), "radian-store-test-"));
  const paths = runtimePaths("/repo/.git", true, root);
  try {
    await privateDirectory(paths.directory);
    const store = new RuntimeStore(paths);
    const first: RuntimeManifest = { version: protocolVersion, repositoryId: "/repo/.git", repositories: [], records: [], preferences: structuredClone(emptyPreferences) };
    const second = { ...first, preferences: { ...first.preferences, drafts: { id: "latest draft" } } };

    // The write queue preserves invocation order and publishes a complete JSON document.
    await Promise.all([store.save(first), store.save(second)]);

    // Restore returns the last checkpoint only to its matching repository.
    expect((await store.load("/repo/.git"))?.preferences.drafts.id).toBe("latest draft");
    await expect(store.load("/other/.git")).rejects.toThrow("Invalid runtime manifest");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("이전 실행 서비스에는 history 지원 부재를 설명하고 자동으로 종료하거나 교체하지 않는다", async () => {
  // Protocol-v1 services may already own user jobs before the additive history capability ships.
  const client = new RuntimeClient(runtimePaths("/repo/.git", true, "/unused"), {
    version: protocolVersion, pid: process.pid, instance: "legacy", repositoryId: "/repo/.git", mode: "offline",
    repositories: [], details: {}, closingCount: 0, preferences: structuredClone(emptyPreferences), notice: "",
  });

  // The guard rejects locally, without sending a stop or starting a replacement daemon.
  await expect(client.listHistory("worktree")).rejects.toThrow("Finish its jobs");
  await expect(client.resume("worktree", "saved")).rejects.toThrow("predates history support");

  // The original service identity remains intact for ordinary execution and user-directed shutdown.
  expect(client.snapshot.instance).toBe("legacy");
  await client.disconnect();
});
