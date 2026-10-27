import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "../agents/session-registry.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { emptyPreferences, protocolVersion, type RuntimeManifest } from "./protocol.ts";
import { privateDirectory, RuntimeStore, runtimePaths } from "./storage.ts";

const record = (id: string, conversationId = id, lifecycle: "open" | "closed" = "open"): SessionRecord => ({
  id, name: `Session ${id}`, worktreeId: "tree", cwd: "/fixture", sessionFile: `/fixture/${conversationId}.jsonl`, lifecycle,
  state: { conversationId, status: "complete", output: `Output ${id}`, error: null,
    sections: [{ id: `${conversationId}:a`, kind: "assistant", title: "Agent", text: `SAVED BODY ${id}`, status: "complete" }],
    telemetry: { provider: "fixture", model: "saved-model", effort: "high", fast: true, context: { usedTokens: 72000, maxTokens: 200000 }, weekly: null } },
  subagents: [],
});
const manifest = (records: readonly SessionRecord[]): RuntimeManifest => ({ version: protocolVersion, repositoryId: "repo", repositories: [], preferences: structuredClone(emptyPreferences), records });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "radian-session-snapshots-")), paths = runtimePaths("repo", true, root);
  await privateDirectory(paths.directory);
  return { paths, store: new RuntimeStore(paths),
    record(id: string, conversationId = id, lifecycle: "open" | "closed" = "open"): SessionRecord {
      const sessionFile = join(root, `${conversationId}.jsonl`);
      if (!existsSync(sessionFile)) writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: conversationId, cwd: root }) + "\n");
      return { ...record(id, conversationId, lifecycle), cwd: root, sessionFile };
    },
    async close() { await rm(root, { recursive: true, force: true }); } };
}
async function fileFor(paths: ReturnType<typeof runtimePaths>, conversationId: string): Promise<string> {
  const index = JSON.parse(await readFile(paths.manifest, "utf8"));
  const entry = index.records.find((entry: { conversationId: string }) => entry.conversationId === conversationId);
  if (!entry) throw new Error("Missing snapshot index entry");
  return join(paths.directory, "sessions", `${entry.key}.json`);
}

test("Recovery and History share files while closed conversations stay unrecovered", async () => {
  // Both open and closed conversations carry original status metadata.
  const app = await fixture();
  try {
    expectOk(await app.store.save(manifest([app.record("a"), app.record("b", "b", "closed")])));

    // Reopen storage like a fresh process and read recovery and History separately.
    const restored = new RuntimeStore(app.paths), loaded = expectOk(await restored.load("repo"));
    const closed = expectOk(await restored.readSession("tree", "b"));

    // Recover only open runs while closed bodies and telemetry remain in the same files.
    expect(loaded?.records.map(record => record.id)).toEqual(["a"]);
    expect(restored.listSessions("tree")).toHaveLength(2); expect(closed?.lifecycle).toBe("closed");
    expect(closed?.state).toEqual(app.record("b").state);
    expect(expectOk(await restored.readSession("other-tree", "b"))).toBeNull();
    const index = await readFile(app.paths.manifest, "utf8");
    expect(index).not.toContain("SAVED BODY"); expect(index).not.toContain("usedTokens");
    expect((await stat(await fileFor(app.paths, "b"))).mode & 0o777).toBe(0o600);
  } finally { await app.close(); }
});

test("Reopening SDK conversations in other tabs avoids duplicate saves and preserves closed history", async () => {
  // Persistence identities are SDK conversation IDs, not UI tab IDs.
  const app = await fixture();
  try {
    expectOk(await app.store.save(manifest([app.record("old-tab", "conversation", "closed")])));

    // Resume marks the same snapshot open; explicit closure marks it closed again.
    expectOk(await app.store.save(manifest([app.record("new-tab", "conversation")])));
    expectOk(await app.store.save(manifest([])));

    // Keep final tab metadata without automatically reopening in new runtimes.
    const store = new RuntimeStore(app.paths);
    expect(expectOk(await store.load("repo"))?.records).toEqual([]);
    expect(store.listSessions("tree")).toHaveLength(1);
    expect(expectOk(await store.readSession("tree", "conversation"))).toMatchObject({ id: "new-tab", lifecycle: "closed" });
    expect(await readdir(join(app.paths.directory, "sessions"))).toHaveLength(1);
  } finally { await app.close(); }
});

test("Updating open conversations never rewrites historical closed bodies", async () => {
  // Accumulated closed bodies must not add ordinary checkpoint write costs.
  const app = await fixture();
  try {
    expectOk(await app.store.save(manifest([app.record("active"), app.record("closed", "closed", "closed")])));
    const path = await fileFor(app.paths, "closed"), before = await stat(path), bytes = await readFile(path, "utf8");

    // Change output only on active sessions.
    const changed = app.record("active");
    expectOk(await app.store.save(manifest([{ ...changed, state: { ...changed.state, output: "New active output" } }])));

    // Atomic replacements change inodes, exposing unnecessary rewrites.
    expect((await stat(path)).ino).toBe(before.ino); expect(await readFile(path, "utf8")).toBe(bytes);
    expect(app.store.listSessions("tree")).toHaveLength(2);
  } finally { await app.close(); }
});

test("Legacy manifests migrate to per-session files while preserving open/closed state", async () => {
  // Records without lifecycle metadata remain open as before.
  const app = await fixture();
  try {
    const { lifecycle: _lifecycle, ...legacy } = app.record("legacy");
    const original = JSON.stringify(manifest([legacy, app.record("closed", "closed", "closed")]));
    await writeFile(app.paths.manifest, original);

    // Reads preserve source; migrate only on subsequent checkpoints.
    const restored = expectOk(await app.store.load("repo"));
    expect(restored?.records.map(record => record.id)).toEqual(["legacy"]);
    expect(await readFile(app.paths.manifest, "utf8")).toBe(original);
    if (!restored) throw new Error("Missing legacy manifest");
    expectOk(await app.store.save(restored));

    // New stores retain identical recovery lists and closed status metadata.
    const store = new RuntimeStore(app.paths);
    expect(expectOk(await store.load("repo"))?.records.map(record => record.id)).toEqual(["legacy"]);
    expect(expectOk(await store.readSession("tree", "closed"))?.state.telemetry?.fast).toBe(true);
    expect(JSON.parse(await readFile(app.paths.manifest, "utf8")).storageVersion).toBe(2);
    expect(await readdir(join(app.paths.directory, "sessions"))).toHaveLength(2);
  } finally { await app.close(); }
});

test("Legacy snapshots without conversation IDs merge with SDK-recovered file identities", async () => {
  // Retaining old tab IDs as separate History conversations would duplicate source records.
  const app = await fixture();
  try {
    const current = app.record("tab", "sdk-conversation"), { conversationId: _conversationId, ...state } = current.state;
    await writeFile(app.paths.manifest, JSON.stringify(manifest([{ ...current, state }])));
    expectOk(await app.store.load("repo"));

    // Checkpoint identical tabs/files using actual SDK conversation IDs.
    expectOk(await app.store.save(manifest([current])));

    // Remove only aliases without creating sessions or discarding historical data.
    expect(app.store.listSessions("tree")).toHaveLength(1);
    expect(app.store.listSessions("tree")[0]?.conversationId).toBe("sdk-conversation");
    expect(expectOk(await app.store.readSession("tree", "sdk-conversation"))?.state.sections).toEqual(current.state.sections);
  } finally { await app.close(); }
});

test("Corrupt closed snapshots never block open recovery but fail explicitly in History", async () => {
  // Startup skips bodies unnecessary for recovery.
  const app = await fixture();
  try {
    expectOk(await app.store.save(manifest([app.record("a"), app.record("b", "b", "closed")])));
    await writeFile(await fileFor(app.paths, "b"), "broken JSON");

    // Load only open sessions; read corrupt closed conversations when selected.
    const store = new RuntimeStore(app.paths), loaded = expectOk(await store.load("repo"));
    const failure = expectError(await store.readSession("tree", "b"));

    // Never hide corruption through empty previews or JSONL fallback.
    expect(loaded?.records.map(record => record.id)).toEqual(["a"]); expect(failure.code).toBe("STORAGE_FAILED");
    expect(await readFile(await fileFor(app.paths, "b"), "utf8")).toBe("broken JSON");
  } finally { await app.close(); }
});

test("Index failures after closed-body persistence never reopen conversations on recovery", async () => {
  // Post-acceptance persistence failures must not imply closure rollback.
  const app = await fixture();
  try {
    expectOk(await app.store.save(manifest([app.record("a")])));
    await rename(app.paths.manifest, app.paths.manifest + ".backup"); await mkdir(app.paths.manifest);

    // Close session bodies but fail only workspace-index replacement.
    const failure = expectError(await app.store.save(manifest([app.record("a", "a", "closed")])));
    await rm(app.paths.manifest, { recursive: true }); await rename(app.paths.manifest + ".backup", app.paths.manifest);
    const store = new RuntimeStore(app.paths), loaded = expectOk(await store.load("repo"));

    // Prefer actual closed bodies over stale open indexes and repair on the next checkpoint.
    expect(failure.code).toBe("STORAGE_FAILED"); expect(loaded?.records).toEqual([]);
    if (!loaded) throw new Error("Missing manifest");
    expectOk(await store.save(loaded)); expect(store.listSessions("tree")[0]?.lifecycle).toBe("closed");
  } finally { await app.close(); }
});
