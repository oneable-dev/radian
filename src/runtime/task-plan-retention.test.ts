import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "../agents/session-registry.ts";
import { planFilePath, saveTaskPlan } from "../agents/task-plan-store.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { emptyPreferences, type RuntimeManifest } from "./protocol.ts";
import { retentionDayMs } from "./session-retention.ts";
import { privateDirectory, runtimePaths, RuntimeStore } from "./storage.ts";

const now = 1800000000000;
const plan = {
  schemaVersion: 1,
  goal: "Safely retain the work",
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  tasks: [
    {
      id: "task",
      title: "Implement",
      agent: "implementer",
      dependsOn: [],
      inputs: [],
      outputs: ["Completed work"],
      acceptanceCriteria: ["Verified"],
      files: [],
    },
  ],
};
const review = { summary: "Reviewed", warnings: [] };
const release = () => () => {};

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "radian-plan-retention-")));
  const cwd = join(root, "worktree");
  await mkdir(cwd);
  const paths = runtimePaths("repo", true, join(root, "state"));
  await privateDirectory(paths.directory);
  const store = new RuntimeStore(paths);
  const manifest = (records: SessionRecord[]): RuntimeManifest => ({
    version: 1,
    repositoryId: "repo",
    repositories: [],
    preferences: structuredClone(emptyPreferences),
    records,
  });
  async function record(
    id: string,
    options: { age?: number; managed?: boolean; open?: boolean; updatedAt?: number } = {},
  ): Promise<SessionRecord> {
    const closedAt = now - (options.age ?? 31) * retentionDayMs;
    const sessionFile = join(root, `${id}.jsonl`);
    await writeFile(sessionFile, JSON.stringify({ type: "session", id, cwd }) + "\n");
    await utimes(sessionFile, closedAt / 1000, closedAt / 1000);
    return {
      id,
      name: id,
      worktreeId: "tree",
      cwd,
      sessionFile,
      lifecycle: options.open ? "open" : "closed",
      managed: options.managed ?? true,
      closedAt: options.open ? null : closedAt,
      updatedAt: options.updatedAt ?? closedAt + retentionDayMs,
      state: { conversationId: id, status: "complete", output: "Transcript", error: null },
      subagents: [],
    };
  }
  async function sidecar(record: SessionRecord) {
    return expectOk(
      await saveTaskPlan(
        record.sessionFile!,
        {
          conversationId: record.state.conversationId!,
          cwd,
        },
        plan,
        review,
      ),
    );
  }
  async function snapshot(record: SessionRecord) {
    const index = JSON.parse(await readFile(paths.manifest, "utf8"));
    const key = index.records.find(
      (item: { conversationId: string }) => item.conversationId === record.id,
    ).key;
    return join(paths.directory, "sessions", `${key}.json`);
  }
  return {
    root,
    cwd,
    paths,
    store,
    manifest,
    record,
    sidecar,
    snapshot,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("Only expired closed managed sessions lose their SDK file, snapshot, and plan", async () => {
  // Age policy applies to the entire owned conversation, not an independent plan TTL.
  const app = await fixture();
  try {
    const expired = await app.record("expired");
    const recent = await app.record("recent", { age: 29 });
    const open = await app.record("open", { open: true });
    const external = await app.record("external", { managed: false });
    const records = [expired, recent, open, external];
    expectOk(await app.store.save(app.manifest(records)));
    for (const record of records) await app.sidecar(record);
    const expiredSnapshot = await app.snapshot(expired);

    // Unlimited retention retains all four; a 30-day policy expires only the eligible conversation.
    expect(expectOk(await app.store.pruneExpired(null, release, now))).toBe(0);
    expect(expectOk(await app.store.pruneExpired(30, release, now))).toBe(1);

    // Do not remove plans for active, recent, or externally owned conversations.
    expect(await Bun.file(expired.sessionFile!).exists()).toBe(false);
    expect(await Bun.file(planFilePath(expired.sessionFile!)).exists()).toBe(false);
    expect(await Bun.file(expiredSnapshot).exists()).toBe(false);
    for (const record of [recent, open, external]) {
      expect(await Bun.file(record.sessionFile!).exists()).toBe(true);
      expect(await Bun.file(planFilePath(record.sessionFile!)).exists()).toBe(true);
    }
  } finally {
    await app.close();
  }
});

test.each(["tampered", "mismatch", "symlink"])(
  "Unverified %s sidecars block SDK file deletion and preserve snapshots",
  async (kind) => {
    // A plan must be checked before removing its SDK source.
    const app = await fixture();
    try {
      const record = await app.record("protected");
      expectOk(await app.store.save(app.manifest([record])));
      const saved = await app.sidecar(record);
      const path = planFilePath(record.sessionFile!);
      if (kind === "tampered") {
        await writeFile(
          path,
          JSON.stringify({ ...saved, plan: { ...saved.plan, goal: "Changed" } }),
        );
      } else if (kind === "mismatch") {
        await writeFile(
          path,
          JSON.stringify({ ...saved, owner: { ...saved.owner, conversationId: "other" } }),
        );
      } else {
        const target = join(app.root, "target");
        await writeFile(target, "Do not follow");
        await rm(path);
        await symlink(target, path);
      }

      // Failed ownership or content checks must leave both original and snapshot visible.
      expect(expectError(await app.store.pruneExpired(30, release, now)).code).toBe(
        "CLEANUP_FAILED",
      );
      expect(await Bun.file(record.sessionFile!).exists()).toBe(true);
      expect(await Bun.file(await app.snapshot(record)).exists()).toBe(true);
      expect(app.store.isExpired("tree", record.id)).toBe(false);
    } finally {
      await app.close();
    }
  },
);

test("A plan replaced after reservation cannot trigger SDK deletion or a hidden retention marker", async () => {
  // The reservation callback creates a deterministic change between validation and unlink.
  const app = await fixture();
  try {
    const record = await app.record("race");
    expectOk(await app.store.save(app.manifest([record])));
    const saved = await app.sidecar(record);

    // Simulate another writer replacing a sidecar without changing the original JSONL.
    const failed = await app.store.pruneExpired(
      30,
      () => {
        appendFileSync(planFilePath(record.sessionFile!), "\n");
        return () => {};
      },
      now,
    );

    // Neither SDK file nor its snapshot is lost; retention can retry after repair.
    expect(expectError(failed).code).toBe("CLEANUP_FAILED");
    expect(await Bun.file(record.sessionFile!).exists()).toBe(true);
    expect(await Bun.file(await app.snapshot(record)).exists()).toBe(true);
    expect(app.store.isExpired("tree", record.id)).toBe(false);
    expect(saved.hash).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    await app.close();
  }
});

test("Submillisecond sidecar mtime within the snapshot millisecond permits expiry", async () => {
  // A normal save may acquire a fractional mtime after the integer checkpoint timestamp.
  const app = await fixture();
  try {
    const updatedAt = Date.now() + 2000;
    const record = await app.record("same-tick", { age: 85, updatedAt });
    expectOk(await app.store.save(app.manifest([record])));
    await app.sidecar(record);
    const sidecar = planFilePath(record.sessionFile!);
    await utimes(sidecar, (updatedAt + 0.5) / 1000, (updatedAt + 0.5) / 1000);
    const sidecarStat = await stat(sidecar);
    expect(Math.floor(sidecarStat.mtimeMs)).toBe(updatedAt);
    expect(sidecarStat.mtimeMs).toBeGreaterThan(updatedAt);

    // Compare full milliseconds like SDK retention; only a later integer tick blocks deletion.
    expect(expectOk(await app.store.pruneExpired(30, release, now))).toBe(1);
    expect(await Bun.file(sidecar).exists()).toBe(false);
  } finally {
    await app.close();
  }
});

test("A plan newer than its closed snapshot blocks expiry until the session is checkpointed", async () => {
  // A fresh plan must not be discarded because an older SDK snapshot reached its age limit.
  const app = await fixture();
  try {
    const record = await app.record("newer", { age: 85, updatedAt: Date.now() - 1000 });
    expectOk(await app.store.save(app.manifest([record])));
    await app.sidecar(record);

    // Sidecar updatedAt is newer than the index's last checkpoint.
    expect(expectOk(await app.store.pruneExpired(30, release, now))).toBe(0);
    expect(await Bun.file(record.sessionFile!).exists()).toBe(true);
    expect(await Bun.file(planFilePath(record.sessionFile!)).exists()).toBe(true);
  } finally {
    await app.close();
  }
});

test("Interrupted post-SDK deletion retries sidecar and snapshot cleanup from the durable marker", async () => {
  // Publish deletion intent before unlink so a partial sweep cannot resurrect history.
  const app = await fixture();
  try {
    const record = await app.record("partial");
    expectOk(await app.store.save(app.manifest([record])));
    await app.sidecar(record);
    const snapshot = await app.snapshot(record);

    // Force snapshot deletion to fail only after SDK and sidecar files have been deleted.
    const failed = await app.store.pruneExpired(
      30,
      () => {
        renameSync(snapshot, snapshot + ".backup");
        mkdirSync(snapshot);
        return () => {};
      },
      now,
    );
    expect(expectError(failed).code).toBe("CLEANUP_FAILED");
    expect(await Bun.file(record.sessionFile!).exists()).toBe(false);
    expect(await Bun.file(planFilePath(record.sessionFile!)).exists()).toBe(false);

    // Even if policy becomes unlimited, restart resumes cleanup without reopening the session.
    const restored = new RuntimeStore(app.paths);
    expectOk(await restored.load("repo"));
    expect(restored.isExpired("tree", record.id)).toBe(true);
    await rm(snapshot, { recursive: true });
    expect(expectOk(await restored.pruneExpired(null, release, now))).toBe(1);
    expect(restored.isExpired("tree", record.id)).toBe(true);
  } finally {
    await app.close();
  }
});

test("A new plan after partial cleanup is preserved until its ownership is resolved", async () => {
  // A durable marker describes the old plan, not an arbitrary later file at its path.
  const app = await fixture();
  try {
    const record = await app.record("replacement");
    expectOk(await app.store.save(app.manifest([record])));
    const saved = await app.sidecar(record);
    const snapshot = await app.snapshot(record);

    // Stop cleanup after deleting SDK and sidecar but before removing the snapshot.
    expectError(
      await app.store.pruneExpired(
        30,
        () => {
          renameSync(snapshot, snapshot + ".backup");
          mkdirSync(snapshot);
          return () => {};
        },
        now,
      ),
    );
    await writeFile(planFilePath(record.sessionFile!), JSON.stringify(saved), { mode: 0o600 });
    await rm(snapshot, { recursive: true });

    // Retry cannot treat the new valid file as the deleted plan in its marker.
    expect(expectError(await app.store.pruneExpired(null, release, now)).code).toBe(
      "CLEANUP_FAILED",
    );
    expect(await Bun.file(planFilePath(record.sessionFile!)).exists()).toBe(true);
    expect(app.store.isExpired("tree", record.id)).toBe(true);
  } finally {
    await app.close();
  }
});

test("Orphan snapshot cleanup removes only a verified sidecar after the original is absent", async () => {
  // Even an external SDK original may have a Radian-owned adjacent plan.
  const app = await fixture();
  try {
    const orphan = await app.record("orphan", { managed: false });
    const corrupt = await app.record("corrupt", { managed: false });
    expectOk(await app.store.save(app.manifest([orphan, corrupt])));
    await app.sidecar(orphan);
    const orphanSnapshot = await app.snapshot(orphan);
    const saved = await app.sidecar(corrupt);
    await writeFile(
      planFilePath(corrupt.sessionFile!),
      JSON.stringify({ ...saved, owner: { ...saved.owner, cwd: app.root } }),
    );
    await rm(orphan.sessionFile!);
    await rm(corrupt.sessionFile!);

    // A mismatched sidecar prevents accidental deletion of its index and snapshot.
    expect(expectError(await app.store.pruneExpired(null, release, now)).code).toBe(
      "CLEANUP_FAILED",
    );
    expect(await Bun.file(planFilePath(orphan.sessionFile!)).exists()).toBe(false);
    expect(await Bun.file(orphanSnapshot).exists()).toBe(false);
    expect(await Bun.file(planFilePath(corrupt.sessionFile!)).exists()).toBe(true);
    expect(await Bun.file(await app.snapshot(corrupt)).exists()).toBe(true);
  } finally {
    await app.close();
  }
});

test("A positively missing SDK directory does not strand its closed snapshot", async () => {
  // Removing a whole SDK directory also removes every adjacent plan artifact.
  const app = await fixture();
  try {
    const original = await app.record("removed-directory");
    const directory = join(app.root, "removed-sdk-directory");
    await mkdir(directory);
    const record = { ...original, sessionFile: join(directory, "session.jsonl") };
    await rename(original.sessionFile!, record.sessionFile);
    await app.sidecar(record);
    expectOk(await app.store.save(app.manifest([record])));

    // Orphan cleanup must still work when no parent directory remains, even without age expiry.
    await rm(directory, { recursive: true });
    const removed = expectOk(await app.store.pruneExpired(null, release, now));

    // Definite absence permits snapshot removal without recreating any SDK or plan directory.
    expect(removed).toBe(1);
    expect(app.store.listSessions("tree")).toHaveLength(0);
    expect(await Bun.file(record.sessionFile).exists()).toBe(false);
  } finally {
    await app.close();
  }
});

test("A newly recreated original during orphan reservation preserves its sidecar and snapshot", async () => {
  // Definite absence at initial inspection is not permission to delete a newer JSONL.
  const app = await fixture();
  try {
    const record = await app.record("recreated");
    expectOk(await app.store.save(app.manifest([record])));
    await app.sidecar(record);
    await rm(record.sessionFile!);

    // Recreate the original before cleanup commits.
    expect(
      expectOk(
        await app.store.pruneExpired(
          null,
          () => {
            writeFileSync(
              record.sessionFile!,
              JSON.stringify({ type: "session", id: record.id, cwd: app.cwd }) + "\n",
            );
            return () => {};
          },
          now,
        ),
      ),
    ).toBe(0);

    // The sidecar and its index remain attached to the newly created original.
    expect(await Bun.file(planFilePath(record.sessionFile!)).exists()).toBe(true);
    expect(await Bun.file(await app.snapshot(record)).exists()).toBe(true);
  } finally {
    await app.close();
  }
});
