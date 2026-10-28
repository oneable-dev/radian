import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, renameSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "../agents/session-registry.ts";
import { loadSessionSettings } from "../app/settings.ts";
import { InputError } from "../errors.ts";
import { err, ok } from "../result.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { emptyPreferences, type RuntimeManifest } from "./protocol.ts";
import { privateDirectory, runtimePaths, RuntimeStore } from "./storage.ts";
import {
  RetentionScheduler,
  retentionDayMs,
  retentionSweepIntervalMs,
} from "./session-retention.ts";

const now = 1800000000000;
const release = () => () => {};

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "radian-retention-")));
  const cwd = join(root, "worktree");

  await mkdir(cwd);

  const paths = runtimePaths("repo", true, join(root, "state"));
  await privateDirectory(paths.directory);

  const store = new RuntimeStore(paths);
  const manifest = (records: readonly SessionRecord[]): RuntimeManifest => ({
    version: 1,
    repositoryId: "repo",
    repositories: [],
    preferences: structuredClone(emptyPreferences),
    records,
  });

  return {
    root,
    cwd,
    paths,
    store,
    manifest,
    async record(id: string, age = 31, managed = true): Promise<SessionRecord> {
      const closedAt = now - age * retentionDayMs;
      const sessionFile = join(root, `${id}.jsonl`);

      await writeFile(sessionFile, JSON.stringify({ type: "session", version: 3, id, cwd }) + "\n");
      await utimes(sessionFile, closedAt / 1000, closedAt / 1000);

      return {
        id,
        name: `Private title ${id}`,
        worktreeId: "tree",
        cwd,
        sessionFile,
        lifecycle: "closed",
        managed,
        closedAt,
        updatedAt: closedAt + 1000,
        state: {
          conversationId: id,
          status: "complete",
          output: "Private transcript",
          error: null,
        },
        subagents: [],
      };
    },
    async snapshotFile(id: string) {
      const index = JSON.parse(await readFile(paths.manifest, "utf8"));

      return join(
        paths.directory,
        "sessions",
        `${index.records.find((entry: { conversationId: string }) => entry.conversationId === id).key}.json`,
      );
    },
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("Only owned sessions closed for 30 days lose both JSONL and snapshots", async () => {
  // Protect open, external, and recently closed sessions despite old records.
  const app = await fixture();
  try {
    const expired = await app.record("expired");
    const open = { ...(await app.record("open")), lifecycle: "open" as const, closedAt: null };
    const external = await app.record("external", 31, false);
    const recent = await app.record("recent", 29);

    expectOk(await app.store.save(app.manifest([expired, open, external, recent])));

    // Verify default retention against actual temporary files only.
    expect(expectOk(await app.store.pruneExpired(30, release, now))).toBe(1);

    // Remove expired bodies but retain small identifiers preventing stale-response resurrection.
    expect(await Bun.file(expired.sessionFile!).exists()).toBe(false);
    expect(app.store.isExpired("tree", "expired")).toBe(true);
    expect(app.store.listSessions("tree")).toHaveLength(3);
    expect(expectOk(await app.store.readSession("tree", "expired"))).toBeNull();
    for (const record of [open, external, recent]) {
      expect(await Bun.file(record.sessionFile!).exists()).toBe(true);
    }

    expect(await readdir(join(app.paths.directory, "sessions"))).toHaveLength(3);
    expect(await readFile(app.paths.manifest, "utf8")).not.toContain("Private title expired");
    expectOk(await app.store.save(app.manifest([expired, open])));
    expect(app.store.isExpired("tree", "expired")).toBe(true);
    expect(await readdir(join(app.paths.directory, "sessions"))).toHaveLength(3);
  } finally {
    await app.close();
  }
});

test("Resume clears expiry and reclosing restarts retention from the new close date", async () => {
  // Creation and checkpoint dates must not substitute for close dates.
  const app = await fixture();
  try {
    const old = await app.record("again");
    expectOk(await app.store.save(app.manifest([old])));

    // Protect resumed sessions and prevent ordinary saves from extending reclosed expiry.
    expectOk(await app.store.save(app.manifest([{ ...old, lifecycle: "open", closedAt: null }])));
    expect(expectOk(await app.store.pruneExpired(30, release, now))).toBe(0);

    const closed = { ...old, closedAt: now, updatedAt: now };
    expectOk(await app.store.save(app.manifest([closed])));
    expectOk(
      await app.store.save(
        app.manifest([
          {
            ...closed,
            updatedAt: now + 20 * retentionDayMs,
            state: { ...closed.state, output: "Checkpoint changed" },
          },
        ]),
      ),
    );

    // Retain immediately before the boundary and clean at exactly 30 days after closing.
    expect(app.store.listSessions("tree")[0]?.closedAt).toBe(now);
    expect(expectOk(await app.store.pruneExpired(30, release, now + 30 * retentionDayMs - 1))).toBe(
      0,
    );
    expect(expectOk(await app.store.pruneExpired(30, release, now + 30 * retentionDayMs))).toBe(1);
  } finally {
    await app.close();
  }
});

test("Unlimited retention and rejected active-session cleanup reservations leave files unchanged", async () => {
  // Policy and execution ownership prevent deletion markers as well as deletion.
  const app = await fixture();
  try {
    const record = await app.record("protected");
    expectOk(await app.store.save(app.manifest([record])));

    // Apply unlimited policy and active ownership separately to the same expired record.
    expect(expectOk(await app.store.pruneExpired(null, release, now))).toBe(0);
    expect(expectOk(await app.store.pruneExpired(30, () => null, now))).toBe(0);

    // Preserve original state for JSONL fallback and resume.
    expect(app.store.isExpired("tree", "protected")).toBe(false);
    expect(await Bun.file(record.sessionFile!).exists()).toBe(true);
    expect(expectOk(await app.store.readSession("tree", "protected"))).not.toBeNull();
  } finally {
    await app.close();
  }
});

test("Legacy close dates receive grace and unknown-origin JSONL never deletes automatically", async () => {
  // Older snapshots may lack closedAt and Radian ownership metadata.
  const app = await fixture();
  try {
    const { managed: _managed, closedAt: _closedAt, ...legacy } = await app.record("legacy", 100);
    expectOk(await app.store.save(app.manifest([{ ...legacy, updatedAt: 0 }])));

    // Reread old files under the new default policy.
    const store = new RuntimeStore(app.paths);
    expectOk(await store.load("repo"));
    expect(expectOk(await store.pruneExpired(30, release, Date.now() + 100 * retentionDayMs))).toBe(
      0,
    );

    // Never delete immediately from old updatedAt or infer ownership of external files.
    expect(store.listSessions("tree")[0]?.closedAt).toBeGreaterThan(0);
    expect(store.listSessions("tree")[0]?.managed).toBe(false);
    expect(await Bun.file(legacy.sessionFile!).exists()).toBe(true);
  } finally {
    await app.close();
  }
});

test("Externally modified SDK files never expire from stale snapshots", async () => {
  // Other tools' appended conversations must not be deleted from old Radian snapshots.
  const app = await fixture();
  try {
    const record = await app.record("changed");
    expectOk(await app.store.save(app.manifest([record])));
    await utimes(record.sessionFile!, now / 1000, now / 1000);

    // Check actual file modification times before cleanup.
    expect(expectOk(await app.store.pruneExpired(30, release, now))).toBe(0);

    // Preserve both fresh files and original snapshots.
    expect(app.store.isExpired("tree", "changed")).toBe(false);
    expect(await Bun.file(record.sessionFile!).exists()).toBe(true);
  } finally {
    await app.close();
  }
});

test.each(["identity", "worktree", "symlink"])(
  "Failed SDK file %s validation prevents deletion despite ownership flags",
  async (kind) => {
    // Revalidate at destructive boundaries so stored paths cannot delete arbitrary files.
    const app = await fixture();
    try {
      const record = await app.record("unverified");
      if (kind === "symlink") {
        const target = join(app.root, "target.jsonl");
        await writeFile(target, "Preserve target");
        await rm(record.sessionFile!);
        await symlink(target, record.sessionFile!);
      } else {
        await writeFile(
          record.sessionFile!,
          JSON.stringify({
            type: "session",
            id: kind === "identity" ? "other" : "unverified",
            cwd: kind === "worktree" ? app.root : app.cwd,
          }) + "\n",
        );
        await utimes(record.sessionFile!, record.closedAt! / 1000, record.closedAt! / 1000);
      }

      expectOk(await app.store.save(app.manifest([record])));

      // Report validation failures without starting file deletion.
      const error = expectError(await app.store.pruneExpired(30, release, now));

      expect(error.code).toBe("CLEANUP_FAILED");
      expect(await Bun.file(record.sessionFile!).exists()).toBe(true);
      expect(app.store.isExpired("tree", "unverified")).toBe(false);
    } finally {
      await app.close();
    }
  },
);

test("SDK changes immediately before deletion abort cleanup and undo expiry markers", async () => {
  // Other programs may write between inspection and unlink.
  const app = await fixture();
  try {
    const record = await app.record("race");
    expectOk(await app.store.save(app.manifest([record])));

    // Modify SDK files immediately after reservation to test final fingerprint checks.
    const error = expectError(
      await app.store.pruneExpired(
        30,
        () => {
          appendFileSync(record.sessionFile!, "NEW DATA\n");

          return () => {};
        },
        now,
      ),
    );

    // No SDK data was deleted, so retain visible original history.
    expect(error.code).toBe("CLEANUP_FAILED");
    expect(await readFile(record.sessionFile!, "utf8")).toContain("NEW DATA");
    expect(app.store.isExpired("tree", "race")).toBe(false);
  } finally {
    await app.close();
  }
});

test("Restart after partial deletion finishes cleanup without JSONL fallback resurrection", async () => {
  // Reproduce post-SDK-deletion snapshot failures only inside temporary directories.
  const app = await fixture();
  try {
    const record = await app.record("partial");
    expectOk(await app.store.save(app.manifest([record])));

    const path = await app.snapshotFile("partial");

    // Replace read snapshots with directories so only final removal fails.
    const error = expectError(
      await app.store.pruneExpired(
        30,
        () => {
          renameSync(path, path + ".backup");
          mkdirSync(path);

          return () => {};
        },
        now,
      ),
    );
    const restored = new RuntimeStore(app.paths);

    expectOk(await restored.load("repo"));

    // Persist deletion intent so already-started cleanup completes even if policy is disabled.
    expect(error.code).toBe("CLEANUP_FAILED");
    expect(await Bun.file(record.sessionFile!).exists()).toBe(false);
    expect(restored.isExpired("tree", "partial")).toBe(true);
    expect(restored.listSessions("tree")).toEqual([]);
    await rm(path, { recursive: true });
    expect(expectOk(await restored.pruneExpired(null, release, now))).toBe(1);
    expect(restored.isExpired("tree", "partial")).toBe(true);
  } finally {
    await app.close();
  }
});

test.each(["missing", "unassigned"])(
  "Checkpoints discard closed snapshots with %s SDK files but preserve open recovery",
  async (kind) => {
    // Empty or deleted conversations must not become permanent preview-only archives.
    const app = await fixture();
    try {
      const closed = await app.record("closed");
      const open = { ...(await app.record("open")), lifecycle: "open" as const, closedAt: null };

      await rm(closed.sessionFile!);
      await rm(open.sessionFile!);

      const { sessionFile: _source, ...withoutFile } = closed;

      // A closed record needs an original conversation; an open record still carries recovery intent.
      expectOk(
        await app.store.save(app.manifest([kind === "unassigned" ? withoutFile : closed, open])),
      );

      const restored = new RuntimeStore(app.paths);
      const loaded = expectOk(await restored.load("repo"));

      // Remove closed bodies and index entries without losing the open session's last state.
      expect(app.store.listSessions("tree").map((record) => record.id)).toEqual(["open"]);
      expect(expectOk(await app.store.readSession("tree", "closed"))).toBeNull();
      expect(loaded?.records.map((record) => record.id)).toEqual(["open"]);
      expect(await readdir(join(app.paths.directory, "sessions"))).toHaveLength(1);
      expect(await readFile(app.paths.manifest, "utf8")).not.toContain("Private title closed");
    } finally {
      await app.close();
    }
  },
);

test("Closing an open recovery snapshot without an original removes its stored body and identity", async () => {
  // An unused tab still needs recovery until the user explicitly closes it.
  const app = await fixture();
  try {
    const open = { ...(await app.record("empty")), lifecycle: "open" as const, closedAt: null };
    await rm(open.sessionFile!);
    expectOk(await app.store.save(app.manifest([open])));

    const path = await app.snapshotFile("empty");

    // A checkpoint without that open tab records explicit closed intent.
    expectOk(await app.store.save(app.manifest([])));

    // No closed snapshot-only archive remains, including after restarting storage.
    const restored = new RuntimeStore(app.paths);
    expect(expectOk(await restored.load("repo"))?.records).toEqual([]);
    expect(restored.listSessions("tree")).toEqual([]);
    expect(await Bun.file(path).exists()).toBe(false);
  } finally {
    await app.close();
  }
});

test("Maintenance preserves snapshots when permissions prevent checking their SDK originals", async () => {
  // An inaccessible original is not proof that the conversation no longer exists.
  const app = await fixture();
  const blocked = join(app.root, "blocked");
  try {
    const record = await app.record("inaccessible");
    await mkdir(blocked);

    const sessionFile = join(blocked, "original.jsonl");
    renameSync(record.sessionFile!, sessionFile);
    expectOk(await app.store.save(app.manifest([{ ...record, sessionFile }])));
    await chmod(blocked, 0);

    // Report the I/O failure rather than authorizing destructive snapshot cleanup.
    const failure = expectError(await app.store.pruneExpired(null, release, now));

    expect(failure.code).toBe("CLEANUP_FAILED");
    expect(expectOk(await app.store.readSession("tree", "inaccessible"))).not.toBeNull();
  } finally {
    await chmod(blocked, 0o700);
    await app.close();
  }
});

test("Maintenance removes orphaned closed snapshots even with unlimited retention and unknown provenance", async () => {
  // Existing archives may outlive originals deleted by an external application.
  const app = await fixture();
  try {
    const orphan = await app.record("orphan", 1, false);
    const saved = await app.record("saved", 1, false);

    expectOk(await app.store.save(app.manifest([orphan, saved])));

    const path = await app.snapshotFile("orphan");
    await rm(orphan.sessionFile!);

    // Missing-original cleanup is independent of age-based SDK deletion policy.
    const removed = expectOk(await app.store.pruneExpired(null, release, now));

    // Drop only Radian's unusable snapshot; the external SDK conversation remains unchanged.
    expect(removed).toBe(1);
    expect(await Bun.file(path).exists()).toBe(false);
    expect(app.store.listSessions("tree").map((record) => record.id)).toEqual(["saved"]);
    expect(await Bun.file(saved.sessionFile!).exists()).toBe(true);
  } finally {
    await app.close();
  }
});

test("Active ownership protects orphaned snapshots until cleanup can reserve them", async () => {
  // A stale closed index must not override a live runtime's ownership.
  const app = await fixture();
  try {
    const record = await app.record("reserved");
    expectOk(await app.store.save(app.manifest([record])));
    await rm(record.sessionFile!);

    // Keep the record while another owner blocks maintenance.
    expect(expectOk(await app.store.pruneExpired(null, () => null, now))).toBe(0);
    expect(expectOk(await app.store.readSession("tree", "reserved"))).not.toBeNull();

    // Once ownership is released, no missing-original record needs to survive.
    expect(expectOk(await app.store.pruneExpired(null, release, now))).toBe(1);
    expect(app.store.listSessions("tree")).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Interrupted orphan cleanup retries after its snapshot was removed but index publication failed", async () => {
  // A failed index replacement must not strand old closed entries permanently.
  const app = await fixture();
  try {
    const record = await app.record("interrupted");
    expectOk(await app.store.save(app.manifest([record])));

    const path = await app.snapshotFile("interrupted");
    await rm(record.sessionFile!);
    renameSync(app.paths.manifest, app.paths.manifest + ".backup");
    await mkdir(app.paths.manifest);

    // The old closed index stays authoritative until a replacement can be published.
    const failure = expectError(await app.store.pruneExpired(null, release, now));
    await rm(app.paths.manifest, { recursive: true });
    renameSync(app.paths.manifest + ".backup", app.paths.manifest);

    const restored = new RuntimeStore(app.paths);
    expectOk(await restored.load("repo"));

    // Missing snapshot bodies do not prevent retrying missing-original cleanup.
    expect(failure.code).toBe("CLEANUP_FAILED");
    expect(await Bun.file(path).exists()).toBe(false);
    expect(expectOk(await restored.pruneExpired(null, release, now))).toBe(1);
    expect(restored.listSessions("tree")).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Scheduled cleanup runs once at startup and hourly without overlapping work", async () => {
  // Verify scheduling and deduplication without waiting a real hour.
  let tick: (() => void) | undefined;
  let interval = 0;
  let canceled = 0;
  let calls = 0;
  const pending = Promise.withResolvers<ReturnType<typeof ok<number>>>();
  const scheduler = new RetentionScheduler(
    () => (++calls === 1 ? Promise.resolve(ok(0)) : pending.promise),
    () => {},
    (error) => {
      throw error;
    },
    (callback, ms) => {
      tick = callback;
      interval = ms;

      return () => {
        canceled++;
      };
    },
  );

  await scheduler.start();
  expect(calls).toBe(1);
  expect(interval).toBe(retentionSweepIntervalMs);

  // Extra ticks share long-running scans and shutdown waits for cleanup.
  tick!();

  const active = scheduler.run();
  tick!();
  await Promise.resolve();

  const stopped = scheduler.stop();
  pending.resolve(ok(1));
  await Promise.all([active, stopped]);
  tick!();

  // Schedule without UI and prevent late shutdown ticks from starting work.
  expect(calls).toBe(2);
  expect(canceled).toBe(1);
});

test("Runtime rereads policy changes for unlimited, corrupt, and revised retention settings", async () => {
  // Reread each cleanup cycle so policies change without runtime restart.
  const app = await fixture();
  const config = join(app.root, "settings.json");
  const outcomes: string[] = [];
  const scheduler = new RetentionScheduler(
    async () => {
      const settings = await loadSessionSettings(config);
      if (!settings.ok) {
        return settings;
      }

      return app.store.pruneExpired(settings.value.retentionDays, release, now);
    },
    (result) => outcomes.push(result.ok ? `removed:${result.value}` : result.error.code),
    (error) => {
      throw error;
    },
    () => () => {},
  );
  try {
    const record = await app.record("reloaded", 10);
    expectOk(await app.store.save(app.manifest([record])));
    await writeFile(config, JSON.stringify({ sessions: { retentionDays: null } }));

    // Invalid intermediate edits pause cleanup until the next valid policy.
    await scheduler.start();
    await writeFile(config, "{broken");
    await scheduler.run();
    expect(await Bun.file(record.sessionFile!).exists()).toBe(true);
    await writeFile(config, JSON.stringify({ sessions: { retentionDays: 7 } }));
    await scheduler.run();

    expect(outcomes).toEqual(["removed:0", "INVALID_INPUT", "removed:1"]);
    expect(await Bun.file(record.sessionFile!).exists()).toBe(false);
  } finally {
    await scheduler.stop();
    await app.close();
  }
});

test("Invalid policies report scan failures and later valid checks recover", async () => {
  // Never turn configuration errors into destructive 30-day defaults.
  let valid = false;
  const outcomes: string[] = [];
  const scheduler = new RetentionScheduler(
    async () => (valid ? ok(0) : err(new InputError("Invalid retention policy"))),
    (result) => outcomes.push(result.ok ? "ok" : result.error.code),
    (error) => {
      throw error;
    },
    () => () => {},
  );

  // Resume checking after policy repair within the same runtime.
  await scheduler.start();
  valid = true;
  await scheduler.run();
  await scheduler.stop();

  expect(outcomes).toEqual(["INVALID_INPUT", "ok"]);
});
