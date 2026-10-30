import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionRegistry, type SessionRecord } from "../agents/session-registry.ts";
import { planFilePath, saveTaskPlan } from "../agents/task-plan-store.ts";
import { RepositoryCatalog } from "../workspace/catalog.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { ChatStore } from "./chat-store.ts";

const retentionPlan = {
  schemaVersion: 1,
  goal: "Delete only owned artifacts",
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  tasks: [
    {
      id: "cleanup",
      title: "Verify cleanup",
      agent: "implementer",
      dependsOn: [],
      inputs: [],
      outputs: ["Safe cleanup"],
      acceptanceCriteria: ["Verify ownership"],
      files: [],
    },
  ],
};
const review = { summary: "Verified fixture", warnings: [] };

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function prepare(role?: "subagent") {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "radian-chat-store-")));
  directories.push(directory);
  const store = new ChatStore(directory);
  const sessionDir = role === "subagent" ? join(store.sessionDir, "subagents") : store.sessionDir;
  await mkdir(sessionDir, { recursive: true });
  const conversationId = crypto.randomUUID();
  const sessionFile = join(sessionDir, `${conversationId}.jsonl`);
  await writeFile(
    sessionFile,
    JSON.stringify({ type: "session", id: conversationId, cwd: homedir() }) + "\n",
  );
  const record: SessionRecord = {
    id: crypto.randomUUID(),
    name: "Archived conversation",
    scope: { kind: "chat" },
    ...(role ? { role } : {}),
    sessionFile,
    cwd: homedir(),
    state: { status: "complete", output: "Done", error: null, conversationId },
    subagents: [],
    lifecycle: "closed",
    closedAt: Date.now() - 40 * 86400000,
    managed: true,
    updatedAt: Date.now(),
  };
  return { store, record, sessionFile };
}

test.each(["mkdir", "chmod"] as const)(
  "CHAT saves retry after expected %s failures",
  async (operation) => {
    // A temporary full disk must reject one checkpoint, not permanently poison the serialization queue.
    const { store, record } = await prepare();
    const failure = spyOn(fs, operation).mockRejectedValueOnce(
      Object.assign(new Error("Fixture disk is full."), { code: "ENOSPC" }),
    );
    try {
      const failure = expectError(await store.save([record]));
      expect(failure.code).toBe("STORAGE_FAILED");
    } finally {
      failure.mockRestore();
    }

    // The same store retries successfully once the filesystem is available again.
    expectOk(await store.save([record]));
    const reloaded = new ChatStore(dirname(store.directory));
    expectOk(await reloaded.load());
    expect(reloaded.listSessions().map((entry) => entry.conversationId)).toEqual([
      record.state.conversationId!,
    ]);
    expect(expectOk(await reloaded.readSession(record.state.conversationId!))?.state.output).toBe(
      "Done",
    );
  },
);

test("CHAT child cleanup metadata stays hidden from conversations and survives restart until retention", async () => {
  // Owned child SDK files use their own subdirectory but share the parent's safe retention policy.
  const { store, record, sessionFile } = await prepare();
  const childDirectory = join(store.sessionDir, "subagents");
  await mkdir(childDirectory);
  const childFile = join(childDirectory, "child.jsonl");
  const childId = crypto.randomUUID();
  await writeFile(
    childFile,
    JSON.stringify({ type: "session", id: childId, cwd: homedir() }) + "\n",
  );
  const child: SessionRecord = {
    ...record,
    id: "child",
    name: "Owned child",
    role: "subagent",
    sessionFile: childFile,
    state: { ...record.state, conversationId: childId },
    updatedAt: Date.now(),
  };
  expectOk(await store.save([{ ...record, lifecycle: "open", closedAt: null }, child]));

  // Restart must neither restore the child as a main nor expose it through history/preview.
  const restored = new ChatStore(dirname(store.directory));
  expect(expectOk(await restored.load()).records.map((entry) => entry.id)).toEqual([record.id]);
  expect(restored.listSessions().map((entry) => entry.conversationId)).toEqual([
    record.state.conversationId!,
  ]);
  expect(expectOk(await restored.readSession(childId))).toBeNull();
  expect(expectOk(await restored.prune(30))).toBe(1);

  expect(await Bun.file(childFile).exists()).toBe(false);
  expect(await Bun.file(sessionFile).exists()).toBe(true);
  expect(restored.isExpired(childId)).toBe(true);
  expectOk(await restored.save([child]));
  expect(await Bun.file(childFile).exists()).toBe(false);
  expect(expectOk(await restored.prune(30))).toBe(0);
});

test("CHAT retention verifies owned SDK identity and tombstones expired conversations", async () => {
  // A managed closed conversation older than policy is eligible; stale checkpoints must not restore it.
  const { store, record, sessionFile } = await prepare();
  expect((await store.save([record])).ok).toBe(true);
  expect(await store.prune(30)).toEqual({ ok: true, value: 1 });
  expect(await Bun.file(sessionFile).exists()).toBe(false);
  expect((await store.save([record])).ok).toBe(true);
  expect(store.listSessions()).toHaveLength(0);
  const restored = new ChatStore(dirname(store.directory));
  const loaded = await restored.load();
  expect(loaded.ok).toBe(true);
  expect(restored.listSessions()).toHaveLength(0);
});

test("CHAT retention cannot delete a conversation reopened by another client", async () => {
  // The registry owns the live writer even when the last stored index still says closed.
  const { store, record, sessionFile } = await prepare();
  expect((await store.save([record])).ok).toBe(true);
  expect(await store.prune(30, () => null)).toEqual({ ok: true, value: 0 });
  expect(await Bun.file(sessionFile).exists()).toBe(true);
  expect(store.listSessions()).toHaveLength(1);
});

test.each(["main", "subagent"] as const)(
  "CHAT retention fences concurrent writers through SDK and plan deletion for %s",
  async (role) => {
    // The index is expired, but opening its SDK writer during either unlink must remain impossible.
    const { store, record, sessionFile } = await prepare(role === "subagent" ? role : undefined);
    const sidecar = planFilePath(sessionFile);
    expectOk(
      await saveTaskPlan(
        sessionFile,
        { conversationId: record.state.conversationId!, cwd: homedir() },
        retentionPlan,
        review,
      ),
    );
    expectOk(await store.save([{ ...record, updatedAt: Date.now() }]));
    let writers = 0;
    const registry = new SessionRegistry(
      new RepositoryCatalog([]),
      async () => {
        writers++;
        throw new Error("Retention allowed a second SDK writer.");
      },
      "chat",
    );
    const deleting = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const deletingPlan = Promise.withResolvers<void>();
    const proceedPlan = Promise.withResolvers<void>();
    const original = fs.unlink;
    const unlink = spyOn(fs, "unlink").mockImplementation(async (path) => {
      if (path === sessionFile) {
        deleting.resolve();
        await proceed.promise;
      } else if (path === sidecar) {
        deletingPlan.resolve();
        await proceedPlan.promise;
      }
      return original(path);
    });
    let pruning: ReturnType<ChatStore["prune"]> | undefined;
    try {
      pruning = store.prune(30, (entry, file) =>
        registry.reserveSnapshotCleanup({ ...entry, scope: { kind: "chat" } }, file),
      );
      await deleting.promise;

      // Pause after the fingerprint check but before the final asynchronous SDK unlink.
      const resumed = await registry.createChat(sessionFile);
      expect(expectError(resumed).code).toBe("SESSION_CONFLICT");
      expect(registry.historyOwnership(sessionFile).unavailableReason).toContain("cleanup");
      expect(writers).toBe(0);
      proceed.resolve();
      await deletingPlan.promise;
      expect(registry.historyOwnership(sessionFile).unavailableReason).toContain("cleanup");
      expect(await Bun.file(sessionFile).exists()).toBe(false);
      expect(await Bun.file(sidecar).exists()).toBe(true);
      proceedPlan.resolve();
      expect(expectOk(await pruning)).toBe(1);

      // A finished sweep releases the fence and retains only the non-resurrectable identity.
      expect(registry.historyOwnership(sessionFile)).toEqual({
        openSessionId: null,
        unavailableReason: null,
      });
      expect(store.isExpired(record.state.conversationId!)).toBe(true);
      expect(await Bun.file(sessionFile).exists()).toBe(false);
      expect(await Bun.file(sidecar).exists()).toBe(false);
    } finally {
      proceed.resolve();
      proceedPlan.resolve();
      await pruning;
      unlink.mockRestore();
      expectOk(await registry.shutdown());
    }
  },
);

test.each(["main", "subagent"] as const)(
  "CHAT retention restores visibility when the SDK fingerprint changes for %s",
  async (role) => {
    // A reservation prevents Radian writers, but external writers still require final fingerprint checks.
    const { store, record, sessionFile } = await prepare(role === "subagent" ? role : undefined);
    expectOk(await store.save([record]));
    let released = 0;

    const result = await store.prune(30, () => {
      appendFileSync(sessionFile, "external update\n");
      return () => {
        released++;
      };
    });

    // No deletion began, so the conversation remains previewable instead of becoming a tombstone.
    expect(expectError(result).code).toBe("CLEANUP_FAILED");
    expect(await Bun.file(sessionFile).text()).toContain("external update");
    expect(store.isExpired(record.state.conversationId!)).toBe(false);
    expect(store.listSessions()).toHaveLength(role === "subagent" ? 0 : 1);
    expect(released).toBe(1);
  },
);

test.each(["main", "subagent"] as const)(
  "CHAT retention preserves SDK and plan files when the sidecar changes for %s",
  async (role) => {
    // A valid owned plan is inspected before the reservation; external changes must still block removal.
    const { store, record, sessionFile } = await prepare(role === "subagent" ? role : undefined);
    const sidecar = planFilePath(sessionFile);
    expectOk(
      await saveTaskPlan(
        sessionFile,
        { conversationId: record.state.conversationId!, cwd: homedir() },
        retentionPlan,
        review,
      ),
    );
    expectOk(await store.save([{ ...record, updatedAt: Date.now() }]));
    let released = 0;

    const pruned = await store.prune(30, () => {
      appendFileSync(sidecar, "\n");
      return () => {
        released++;
      };
    });

    // The SDK remains intact and cleanup can retry later without a hidden pending marker.
    expect(expectError(pruned).code).toBe("CLEANUP_FAILED");
    expect(await Bun.file(sidecar).exists()).toBe(true);
    expect(await Bun.file(sessionFile).exists()).toBe(true);
    expect(store.isExpired(record.state.conversationId!)).toBe(false);
    expect(store.listSessions()).toHaveLength(role === "subagent" ? 0 : 1);
    expect(released).toBe(1);
  },
);

test("CHAT retention preserves externally changed files and refuses non-owned paths", async () => {
  // An SDK original updated after the snapshot must not be deleted by an old cleanup policy.
  const { store, record, sessionFile } = await prepare();
  expect((await store.save([record])).ok).toBe(true);
  const future = new Date(Date.now() + 5000);
  await utimes(sessionFile, future, future);
  expect(await store.prune(30)).toEqual({ ok: true, value: 0 });
  expect(await Bun.file(sessionFile).exists()).toBe(true);

  const other = await prepare();
  const external = join(other.store.directory, "external.jsonl");
  await writeFile(
    external,
    JSON.stringify({ type: "session", id: other.record.state.conversationId, cwd: homedir() }) +
      "\n",
  );
  expect((await other.store.save([{ ...other.record, sessionFile: external }])).ok).toBe(true);
  const rejected = await other.store.prune(30);
  expect(rejected.ok).toBe(false);
  expect(await Bun.file(external).exists()).toBe(true);
});
