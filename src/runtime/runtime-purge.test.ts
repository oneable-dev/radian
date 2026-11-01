import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
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
import type { CleanupReceipt } from "./daemon-protocol.ts";
import { emptyPreferences, type RuntimeManifest } from "./protocol.ts";
import {
  appendRuntimeCleanupCandidates,
  fenceRuntimeScope,
  fenceRuntimeWrites,
  inspectRuntimeCleanup,
  privateDirectory,
  purgeRuntimeScope,
  reopenRuntimeScope,
  runtimePaths,
  RuntimeStore,
  ScopeDeletedError,
} from "./storage.ts";

const plan = {
  schemaVersion: 1,
  goal: "Ship",
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  tasks: [
    {
      id: "one",
      title: "Do",
      agent: "implementer",
      dependsOn: [],
      inputs: [],
      outputs: ["Done"],
      acceptanceCriteria: ["Works"],
      files: ["a.ts"],
    },
  ],
};
const review = { summary: "Reviewed", warnings: [] };
const stopped = { writersStopped: true } as const;

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "radian-purge-")));
  const repositoryId = join(root, "repo", ".git");
  const paths = runtimePaths(repositoryId, true, join(root, "state"));
  await privateDirectory(paths.directory);
  const sdk = join(paths.directory, "sdk-sessions");
  await privateDirectory(sdk);
  const external = join(root, "external");
  await mkdir(external, { mode: 0o700 });
  const trees = {
    main: { id: join(root, "repo"), path: join(root, "repo") },
    linked: { id: join(root, "linked"), path: join(root, "linked") },
  };
  for (const tree of Object.values(trees)) await mkdir(tree.path, { recursive: true });

  const sdkFile = async (directory: string, id: string, cwd: string) => {
    const file = join(directory, `2026-01-01_${id}.jsonl`);
    await writeFile(file, JSON.stringify({ type: "session", version: 3, id, cwd }) + "\n", {
      mode: 0o600,
    });

    return file;
  };
  const record = (
    id: string,
    tree: { id: string; path: string },
    sessionFile?: string,
    lifecycle: "open" | "closed" = "open",
  ): SessionRecord => ({
    id: `tab-${id}`,
    name: `Private ${id}`,
    worktreeId: tree.id,
    cwd: tree.path,
    ...(sessionFile ? { sessionFile } : {}),
    lifecycle,
    managed: true,
    closedAt: lifecycle === "closed" ? 1 : null,
    updatedAt: 1,
    state: { conversationId: id, status: "complete", output: `Secret ${id}`, error: null },
    subagents: [],
  });
  const manifest = (records: readonly SessionRecord[]): RuntimeManifest => ({
    version: 1,
    repositoryId,
    repositories: [
      {
        id: repositoryId,
        name: "repo",
        worktrees: Object.values(trees).map((tree) => ({
          ...tree,
          name: tree.id,
          branch: null,
          sessions: [],
        })),
      },
    ],
    preferences: {
      ...structuredClone(emptyPreferences),
      selection: {
        worktreeId: trees.linked.id,
        sessions: { [trees.main.id]: "tab-a", [trees.linked.id]: "tab-b" },
      },
      drafts: { "tab-a": "keep", "tab-b": "secret draft" },
    },
    records,
  });
  const receipt = (
    token: string,
    kind: "repository" | "worktrees",
    worktrees: { id: string; path: string }[],
  ): CleanupReceipt => ({
    token,
    repositoryId,
    kind,
    worktrees,
    sessionIds: [],
    revision: 1,
    state: "fenced",
    updatedAt: 1,
  });

  return {
    root,
    repositoryId,
    paths,
    sdk,
    external,
    trees,
    sdkFile,
    record,
    manifest,
    receipt,
    exists: (path: string) =>
      stat(path).then(
        () => true,
        () => false,
      ),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("A symbolic SDK directory never authorizes deleting its external session originals", async () => {
  const app = await fixture();
  try {
    // A cold host can encounter a replaced storage directory before any SDK validates it.
    const outside = await app.sdkFile(app.external, "foreign", app.trees.linked.path);
    const original = await readFile(outside, "utf8");
    await rm(app.sdk, { recursive: true });
    await symlink(app.external, app.sdk, "dir");
    const receipt = app.receipt("symbolic-sdk-cleanup", "worktrees", [app.trees.linked]);
    expectOk(await fenceRuntimeScope(app.paths, app.repositoryId, receipt));

    const purged = await purgeRuntimeScope(app.paths, app.repositoryId, receipt.token, stopped);

    expect(await app.exists(outside)).toBe(true);
    expect(await readFile(outside, "utf8")).toBe(original);
    if (purged.ok) expect(purged.value.complete).toBe(false);
    else expect(purged.error.code).toBe("STORAGE_FAILED");
  } finally {
    await app.close();
  }
});

test("An external session known only to a legacy manifest copy still loses its owned plan sidecar", async () => {
  const app = await fixture();
  try {
    // Legacy crash metadata may be the only remaining ownership record of an imported session.
    const sibling = await app.sdkFile(app.sdk, "a", app.trees.main.path);
    const outside = await app.sdkFile(app.external, "copy-only", app.trees.linked.path);
    const original = await readFile(outside, "utf8");
    expectOk(
      await saveTaskPlan(
        outside,
        { conversationId: "copy-only", cwd: app.trees.linked.path },
        plan,
        review,
      ),
    );
    expectOk(
      await new RuntimeStore(app.paths).save(
        app.manifest([app.record("a", app.trees.main, sibling)]),
      ),
    );
    const copy = `${app.paths.manifest}.${crypto.randomUUID()}.tmp`;
    await writeFile(
      copy,
      JSON.stringify(app.manifest([app.record("copy-only", app.trees.linked, outside, "closed")])),
      { mode: 0o600 },
    );
    const receipt = app.receipt("legacy-copy-plan", "worktrees", [app.trees.linked]);
    expectOk(await fenceRuntimeScope(app.paths, app.repositoryId, receipt));

    // Preserve the only reference if sidecar ownership cannot yet be verified.
    await chmod(planFilePath(outside), 0o644);
    const incomplete = expectOk(
      await purgeRuntimeScope(app.paths, app.repositoryId, receipt.token, stopped),
    );
    expect(incomplete.complete).toBe(false);
    expect(JSON.parse(await readFile(copy, "utf8")).records).toHaveLength(1);
    await chmod(planFilePath(outside), 0o600);
    const result = expectOk(
      await purgeRuntimeScope(app.paths, app.repositoryId, receipt.token, stopped),
    );

    expect(result.complete).toBe(true);
    expect(await readFile(outside, "utf8")).toBe(original);
    expect(await app.exists(planFilePath(outside))).toBe(false);
    expect(JSON.parse(await readFile(copy, "utf8")).records).toEqual([]);
  } finally {
    await app.close();
  }
});

test("A worktree purge removes owned state of that worktree and preserves siblings and external originals", async () => {
  const app = await fixture();
  try {
    const a = await app.sdkFile(app.sdk, "a", app.trees.main.path);
    const b = await app.sdkFile(app.sdk, "b", app.trees.linked.path);
    const outside = await app.sdkFile(app.external, "c", app.trees.linked.path);
    const unreferenced = await app.sdkFile(app.sdk, "late", app.trees.linked.path);
    expectOk(
      await saveTaskPlan(b, { conversationId: "b", cwd: app.trees.linked.path }, plan, review),
    );
    expectOk(
      await saveTaskPlan(
        outside,
        { conversationId: "c", cwd: app.trees.linked.path },
        plan,
        review,
      ),
    );
    const store = new RuntimeStore(app.paths);
    expectOk(await store.load(app.repositoryId));
    expectOk(
      await store.save(
        app.manifest([
          app.record("a", app.trees.main, a),
          app.record("b", app.trees.linked, b),
          app.record("c", app.trees.linked, outside, "closed"),
        ]),
      ),
    );

    const token = "token-worktree-1";
    expectOk(
      await fenceRuntimeScope(
        app.paths,
        app.repositoryId,
        app.receipt(token, "worktrees", [app.trees.linked]),
      ),
    );
    const report = expectOk(await purgeRuntimeScope(app.paths, app.repositoryId, token, stopped));

    expect(report.complete).toBe(true);
    expect(report.residuals).toEqual([]);
    expect(await app.exists(b)).toBe(false);
    expect(await app.exists(planFilePath(b))).toBe(false);
    expect(await app.exists(unreferenced)).toBe(false);
    // External original stays; its verified Radian sidecar does not.
    expect(await app.exists(outside)).toBe(true);
    expect(await app.exists(planFilePath(outside))).toBe(false);
    expect(report.preserved.map((item) => item.path)).toContain(outside);
    // Sibling worktree untouched.
    expect(await app.exists(a)).toBe(true);
    const index = JSON.parse(await readFile(app.paths.manifest, "utf8"));
    expect(index.records.map((entry: { worktreeId: string }) => entry.worktreeId)).toEqual([
      app.trees.main.id,
    ]);
    expect(index.preferences.drafts).toEqual({ "tab-a": "keep" });
    expect(index.preferences.selection.worktreeId).toBeNull();
    expect(JSON.stringify(index)).not.toContain("secret draft");
    expect((await readdir(join(app.paths.directory, "sessions"))).length).toBe(1);

    // Retry after completion is idempotent.
    const again = expectOk(await purgeRuntimeScope(app.paths, app.repositoryId, token, stopped));
    expect(again.complete).toBe(true);
    expect(again.removed).toEqual([]);
  } finally {
    await app.close();
  }
});

test("A stale store's queued checkpoint cannot resurrect a purged worktree", async () => {
  // Two RuntimeStore instances share one directory (cold host and active runtime).
  const app = await fixture();
  try {
    const b = await app.sdkFile(app.sdk, "b", app.trees.linked.path);
    const host = new RuntimeStore(app.paths);
    const runtime = new RuntimeStore(app.paths);
    expectOk(await host.load(app.repositoryId));
    expectOk(await runtime.load(app.repositoryId));
    const full = app.manifest([app.record("b", app.trees.linked, b)]);
    expectOk(await runtime.save(full));

    const token = "token-stale-1";
    expectOk(
      await fenceRuntimeScope(
        app.paths,
        app.repositoryId,
        app.receipt(token, "worktrees", [app.trees.linked]),
      ),
    );
    expect(
      expectOk(await purgeRuntimeScope(app.paths, app.repositoryId, token, stopped)).complete,
    ).toBe(true);
    // Late writes from both instances, including after reopen.
    expectOk(await host.save(full));
    expectOk(await reopenRuntimeScope(app.paths, app.repositoryId, token));
    expectOk(await runtime.save(full));

    const index = JSON.parse(await readFile(app.paths.manifest, "utf8"));
    expect(index.records).toEqual([]);
    expect(JSON.stringify(index)).not.toContain("secret draft");
    expect(await app.exists(b)).toBe(false);

    // A fresh store of the new generation persists the recreated worktree again.
    const fresh = new RuntimeStore(app.paths);
    expectOk(await fresh.load(app.repositoryId));
    const b2 = await app.sdkFile(app.sdk, "b2", app.trees.linked.path);
    expectOk(await fresh.save(app.manifest([app.record("b2", app.trees.linked, b2)])));
    const reopened = JSON.parse(await readFile(app.paths.manifest, "utf8"));
    expect(reopened.records.map((entry: { id: string }) => entry.id)).toEqual(["tab-b2"]);

    // An old store that adopts the reopened scope may persist the new generation too.
    expectOk(await runtime.adoptCleanup());
    expectOk(await runtime.save(app.manifest([app.record("b2", app.trees.linked, b2)])));
  } finally {
    await app.close();
  }
});

test("A save queued before a synchronous repository fence is rejected, not written", async () => {
  const app = await fixture();
  try {
    const store = new RuntimeStore(app.paths);
    expectOk(await store.load(app.repositoryId));
    const file = await app.sdkFile(app.sdk, "a", app.trees.main.path);
    const queued = store.save(app.manifest([app.record("a", app.trees.main, file)]));
    fenceRuntimeWrites(app.paths, {
      token: "token-sync-1",
      kind: "repository",
      worktreeIds: [],
    });

    const result = expectError(await queued);
    expect(result).toBeInstanceOf(ScopeDeletedError);
    expect(await app.exists(app.paths.manifest)).toBe(false);
    expect(expectError(await store.save(app.manifest([]))).code).toBe("CANCELLED");
  } finally {
    await app.close();
  }
});

test("A repository purge clears owned files, keeps its receipt, and needs a fresh generation", async () => {
  const app = await fixture();
  try {
    const offline = join(app.paths.directory, "offline-agent", "sessions");
    await privateDirectory(offline);
    const a = await app.sdkFile(app.sdk, "a", app.trees.main.path);
    const o = await app.sdkFile(offline, "o", app.trees.linked.path);
    const outside = await app.sdkFile(app.external, "x", app.trees.main.path);
    const store = new RuntimeStore(app.paths);
    expectOk(
      await store.save(
        app.manifest([
          app.record("a", app.trees.main, a),
          app.record("x", app.trees.main, outside),
        ]),
      ),
    );
    await writeFile(app.paths.log, "log");

    const token = "token-repository-1";
    expectOk(
      await fenceRuntimeScope(app.paths, app.repositoryId, app.receipt(token, "repository", [])),
    );
    // Restart: a separate process without in-process fences learns it from the durable ledger.
    const probe = join(app.root, "probe.ts");
    await writeFile(
      probe,
      `import { RuntimeStore } from ${JSON.stringify(join(import.meta.dir, "storage.ts"))};
       const paths = JSON.parse(process.argv[2]);
       const loaded = await new RuntimeStore(paths).load(process.argv[3]);
       const saved = await new RuntimeStore(paths).save({ version: 1, repositoryId: process.argv[3],
         repositories: [], records: [], preferences: { selection: { worktreeId: null, sessions: {} }, drafts: {} } });
       console.log(JSON.stringify([loaded.ok || loaded.error.code, saved.ok || saved.error.code]));`,
    );
    const child = Bun.spawnSync([
      process.execPath,
      probe,
      JSON.stringify(app.paths),
      app.repositoryId,
    ]);
    expect(JSON.parse(child.stdout.toString())).toEqual(["CANCELLED", "CANCELLED"]);
    const report = expectOk(await purgeRuntimeScope(app.paths, app.repositoryId, token, stopped));

    expect(report.residuals).toEqual([]);
    expect(report.complete).toBe(true);
    for (const path of [a, o, app.paths.manifest, app.paths.log, app.sdk]) {
      expect(await app.exists(path)).toBe(false);
    }
    expect(await app.exists(outside)).toBe(true);
    expect(await app.exists(join(app.paths.directory, "cleanup.json"))).toBe(true);
    expect(report.sessionIds.sort()).toEqual(["tab-a", "tab-x"]);

    // The purged-but-not-reopened repository still refuses loads and stale saves.
    expect(expectError(await store.save(app.manifest([]))).code).toBe("CANCELLED");
    expectOk(await reopenRuntimeScope(app.paths, app.repositoryId, token));
    expect(expectError(await store.save(app.manifest([]))).code).toBe("CANCELLED");
    expect(expectError(await store.adoptCleanup()).code).toBe("CANCELLED");
    expect(await app.exists(app.paths.manifest)).toBe(false);

    const fresh = new RuntimeStore(app.paths);
    expect(expectOk(await fresh.load(app.repositoryId))).toBeNull();
    expectOk(await fresh.save(app.manifest([])));
    expect(await app.exists(app.paths.manifest)).toBe(true);
  } finally {
    await app.close();
  }
});

test("Ambiguous or corrupt ownership is reported as residual and retried idempotently", async () => {
  const app = await fixture();
  try {
    const b = await app.sdkFile(app.sdk, "b", app.trees.linked.path);
    const store = new RuntimeStore(app.paths);
    expectOk(await store.save(app.manifest([app.record("b", app.trees.linked, b)])));
    // A hard link makes the owned file ambiguous.
    const alias = join(app.external, "alias.jsonl");
    await Bun.$`ln ${b} ${alias}`.quiet();

    const token = "token-ambiguous-1";
    expectOk(
      await fenceRuntimeScope(
        app.paths,
        app.repositoryId,
        app.receipt(token, "worktrees", [app.trees.linked]),
      ),
    );
    const first = expectOk(await purgeRuntimeScope(app.paths, app.repositoryId, token, stopped));
    expect(first.complete).toBe(false);
    expect(first.residuals.map((item) => item.path)).toContain(b);
    expect(await app.exists(b)).toBe(true);
    // The snapshot is kept for retry while the fence keeps it hidden.
    expect(JSON.parse(await readFile(app.paths.manifest, "utf8")).records.length).toBe(1);
    expect(expectOk(await new RuntimeStore(app.paths).load(app.repositoryId))!.records).toEqual([]);
    expect(
      expectOk(await inspectRuntimeCleanup(app.paths, app.repositoryId)).map(
        (entry) => entry.state,
      ),
    ).toEqual(["fenced"]);
    expect(expectError(await reopenRuntimeScope(app.paths, app.repositoryId, token)).code).toBe(
      "INVALID_INPUT",
    );

    await rm(alias);
    const retry = expectOk(await purgeRuntimeScope(app.paths, app.repositoryId, token, stopped));
    expect(retry.complete).toBe(true);
    expect(await app.exists(b)).toBe(false);
  } finally {
    await app.close();
  }
});

test("Candidates are header-verified; a file of another worktree or outside owned dirs survives", async () => {
  const app = await fixture();
  try {
    const sibling = await app.sdkFile(app.sdk, "sib", app.trees.main.path);
    const child = await app.sdkFile(app.sdk, "sdk-child", app.trees.linked.path);
    const outside = await app.sdkFile(app.external, "ext", app.trees.linked.path);
    const token = "token-candidates-1";
    expectOk(
      await fenceRuntimeScope(
        app.paths,
        app.repositoryId,
        app.receipt(token, "worktrees", [app.trees.linked]),
      ),
    );
    expect(
      expectError(
        await appendRuntimeCleanupCandidates(app.paths, app.repositoryId, token, [
          {
            worktreeId: app.trees.main.id,
            sessionId: "s",
            role: "main",
            conversationId: "sib",
            sessionFile: sibling,
            managed: true,
          },
        ]),
      ).code,
    ).toBe("INVALID_INPUT");
    const status = expectOk(
      await appendRuntimeCleanupCandidates(app.paths, app.repositoryId, token, [
        // A retired child's run ID differs from its SDK conversation ID.
        {
          worktreeId: app.trees.linked.id,
          sessionId: "c",
          role: "subagent",
          conversationId: "run-id",
          sessionFile: child,
          managed: true,
        },
        {
          worktreeId: app.trees.linked.id,
          sessionId: "e",
          role: "main",
          conversationId: "ext",
          sessionFile: outside,
          managed: true,
        },
      ]),
    );
    expect(status.candidates).toBe(2);

    const report = expectOk(await purgeRuntimeScope(app.paths, app.repositoryId, token, stopped));
    expect(report.complete).toBe(true);
    expect(await app.exists(child)).toBe(false);
    expect(await app.exists(outside)).toBe(true);
    expect(await app.exists(sibling)).toBe(true);
    expect(report.sessionIds.sort()).toEqual(["c", "e"]);
    expect(
      expectError(await appendRuntimeCleanupCandidates(app.paths, app.repositoryId, token, []))
        .code,
    ).toBe("INVALID_INPUT");
  } finally {
    await app.close();
  }
});

test("Corrupt manifests and reused tokens fail without deleting anything", async () => {
  const app = await fixture();
  try {
    const b = await app.sdkFile(app.sdk, "b", app.trees.linked.path);
    await writeFile(app.paths.manifest, "{broken", { mode: 0o600 });
    const token = "token-corrupt-1";
    expectOk(
      await fenceRuntimeScope(
        app.paths,
        app.repositoryId,
        app.receipt(token, "worktrees", [app.trees.linked]),
      ),
    );
    expect(
      expectError(
        await fenceRuntimeScope(
          app.paths,
          app.repositoryId,
          app.receipt(token, "worktrees", [app.trees.main]),
        ),
      ).code,
    ).toBe("INVALID_INPUT");

    const report = expectOk(await purgeRuntimeScope(app.paths, app.repositoryId, token, stopped));
    expect(report.complete).toBe(false);
    expect(await readFile(app.paths.manifest, "utf8")).toBe("{broken");
    expect(await app.exists(b)).toBe(true);
  } finally {
    await app.close();
  }
});

const keyOf = (worktreeId: string, conversationId: string) =>
  createHash("sha256")
    .update(JSON.stringify([worktreeId, conversationId]))
    .digest("hex");
const temporary = (path: string) => `${path}.${randomUUID()}.tmp`;
const writePrivate = (path: string, text: string) => writeFile(path, text, { mode: 0o600 });

test("A worktree purge removes crash-left unindexed snapshots and copies of that worktree only", async () => {
  const app = await fixture();
  try {
    const sessions = join(app.paths.directory, "sessions");
    const indexedFile = await app.sdkFile(app.sdk, "b", app.trees.linked.path);
    const store = new RuntimeStore(app.paths);
    expectOk(
      await store.save(
        app.manifest([
          app.record("a", app.trees.main),
          app.record("b", app.trees.linked, indexedFile),
        ]),
      ),
    );
    // Crash after snapshot publish, before index publish: its SDK original is referenced only here.
    const orphanFile = await app.sdkFile(app.sdk, "orphan", app.trees.linked.path);
    const external = await app.sdkFile(app.external, "ext", app.trees.linked.path);
    const orphan = join(sessions, `${keyOf(app.trees.linked.id, "orphan")}.json`);
    await writePrivate(orphan, JSON.stringify(app.record("orphan", app.trees.linked, orphanFile)));
    // Crash during atomicWrite before rename: complete and torn copies.
    const copy = temporary(join(sessions, `${keyOf(app.trees.linked.id, "copy")}.json`));
    await writePrivate(copy, JSON.stringify(app.record("copy", app.trees.linked, external)));
    const torn = temporary(join(sessions, `${keyOf(app.trees.linked.id, "b")}.json`));
    await writePrivate(torn, '{"id":"tab-b","output":"Secret b');
    // Sibling remnants survive.
    const siblingOrphan = join(sessions, `${keyOf(app.trees.main.id, "late")}.json`);
    await writePrivate(siblingOrphan, JSON.stringify(app.record("late", app.trees.main)));
    const siblingTorn = temporary(join(sessions, `${keyOf(app.trees.main.id, "a")}.json`));
    await writePrivate(siblingTorn, "{torn");
    const siblingSnapshot = join(sessions, `${keyOf(app.trees.main.id, "a")}.json`);
    const token = "token-orphans-1";
    expectOk(
      await fenceRuntimeScope(
        app.paths,
        app.repositoryId,
        app.receipt(token, "worktrees", [app.trees.linked]),
      ),
    );

    const report = expectOk(await purgeRuntimeScope(app.paths, app.repositoryId, token, stopped));

    expect(report.residuals).toEqual([]);
    expect(report.complete).toBe(true);
    for (const path of [orphan, orphanFile, copy, torn, indexedFile]) {
      expect(await app.exists(path)).toBe(false);
    }
    expect(await app.exists(external)).toBe(true);
    expect(report.preserved.map((item) => item.path)).toContain(external);
    for (const path of [siblingOrphan, siblingTorn, siblingSnapshot]) {
      expect(await app.exists(path)).toBe(true);
    }
    expect(report.sessionIds.sort()).toEqual(["tab-b", "tab-copy", "tab-orphan"]);
    const again = expectOk(await purgeRuntimeScope(app.paths, app.repositoryId, token, stopped));
    expect(again.complete).toBe(true);
  } finally {
    await app.close();
  }
});

test("An unidentifiable or foreign-looking snapshot remnant keeps a worktree purge incomplete", async () => {
  const app = await fixture();
  try {
    const sessions = join(app.paths.directory, "sessions");
    await privateDirectory(sessions);
    // A copy whose key is not indexed and whose content cannot name its worktree.
    const unknown = temporary(join(sessions, `${"f".repeat(64)}.json`));
    await writePrivate(unknown, "{torn");
    // A world-readable or mismatched-cwd snapshot is never guessed as ours.
    const shared = join(sessions, `${keyOf(app.trees.linked.id, "shared")}.json`);
    await writeFile(shared, JSON.stringify(app.record("shared", app.trees.linked)), {
      mode: 0o644,
    });
    const moved = join(sessions, `${keyOf(app.trees.linked.id, "moved")}.json`);
    await writePrivate(
      moved,
      JSON.stringify({ ...app.record("moved", app.trees.linked), cwd: app.trees.main.path }),
    );
    const token = "token-unknown-remnant-1";
    expectOk(
      await fenceRuntimeScope(
        app.paths,
        app.repositoryId,
        app.receipt(token, "worktrees", [app.trees.linked]),
      ),
    );

    const first = expectOk(await purgeRuntimeScope(app.paths, app.repositoryId, token, stopped));

    expect(first.complete).toBe(false);
    expect(first.residuals.map((item) => item.path).sort()).toEqual(
      [moved, shared, unknown].sort(),
    );
    for (const path of [unknown, shared, moved]) expect(await app.exists(path)).toBe(true);

    await rm(unknown);
    await rm(moved);
    await rm(shared);
    expect(
      expectOk(await purgeRuntimeScope(app.paths, app.repositoryId, token, stopped)).complete,
    ).toBe(true);
  } finally {
    await app.close();
  }
});

for (const kind of ["worktrees", "repository"] as const) {
  test(`A symbolic sessions directory never authorizes removing external files (${kind})`, async () => {
    const app = await fixture();
    try {
      const store = new RuntimeStore(app.paths);
      expectOk(await store.save(app.manifest([app.record("b", app.trees.linked)])));
      const sessions = join(app.paths.directory, "sessions");
      const key = keyOf(app.trees.linked.id, "b");
      const foreign = join(app.external, "sessions");
      await mkdir(foreign, { mode: 0o700 });
      await rm(sessions, { recursive: true });
      // Valid-looking names and schema in the foreign directory are not ownership.
      const victims = [
        join(foreign, `${key}.json`),
        temporary(join(foreign, `${key}.json`)),
        join(foreign, `${keyOf(app.trees.linked.id, "x")}.json`),
      ];
      for (const victim of victims) {
        await writePrivate(victim, JSON.stringify(app.record("b", app.trees.linked)));
      }
      await symlink(foreign, sessions, "dir");
      const receipt = app.receipt(
        `symbolic-sessions-${kind}`,
        kind,
        kind === "worktrees" ? [app.trees.linked] : [],
      );
      expectOk(await fenceRuntimeScope(app.paths, app.repositoryId, receipt));

      const purged = await purgeRuntimeScope(app.paths, app.repositoryId, receipt.token, stopped);

      for (const victim of victims) expect(await app.exists(victim)).toBe(true);
      if (purged.ok) expect(purged.value.complete).toBe(false);
      else expect(purged.error.code).toBe("STORAGE_FAILED");
    } finally {
      await app.close();
    }
  });
}

test("A symbolic offline-agent ancestor never authorizes removing its external session files", async () => {
  const app = await fixture();
  try {
    const foreign = join(app.external, "offline");
    await mkdir(join(foreign, "sessions"), { recursive: true, mode: 0o700 });
    const victim = await app.sdkFile(join(foreign, "sessions"), "o", app.trees.main.path);
    await symlink(foreign, join(app.paths.directory, "offline-agent"), "dir");
    const receipt = app.receipt("symbolic-offline", "repository", []);
    expectOk(await fenceRuntimeScope(app.paths, app.repositoryId, receipt));

    const purged = await purgeRuntimeScope(app.paths, app.repositoryId, receipt.token, stopped);

    expect(await app.exists(victim)).toBe(true);
    if (purged.ok) expect(purged.value.complete).toBe(false);
    else expect(purged.error.code).toBe("STORAGE_FAILED");
  } finally {
    await app.close();
  }
});

test("A worktree purge scrubs its data from unpublished manifest copies without publishing them", async () => {
  const app = await fixture();
  try {
    const store = new RuntimeStore(app.paths);
    expectOk(
      await store.save(
        app.manifest([app.record("a", app.trees.main), app.record("b", app.trees.linked)]),
      ),
    );
    const published = JSON.parse(await readFile(app.paths.manifest, "utf8"));
    // v2 copy: index entries plus drafts; v1 copy: embedded transcripts.
    const indexed = temporary(app.paths.manifest);
    await writePrivate(indexed, JSON.stringify(published));
    const legacy = temporary(app.paths.manifest);
    await writePrivate(
      legacy,
      JSON.stringify(
        app.manifest([app.record("a", app.trees.main), app.record("b", app.trees.linked)]),
      ),
    );
    // Copy without scope data stays byte-identical.
    const untouched = temporary(app.paths.manifest);
    const siblingOnly = JSON.stringify({
      ...app.manifest([app.record("a", app.trees.main)]),
      repositories: [],
      preferences: { ...structuredClone(emptyPreferences), drafts: { "tab-a": "keep" } },
    });
    await writePrivate(untouched, siblingOnly);
    const token = "token-manifest-copies-1";
    expectOk(
      await fenceRuntimeScope(
        app.paths,
        app.repositoryId,
        app.receipt(token, "worktrees", [app.trees.linked]),
      ),
    );

    const report = expectOk(await purgeRuntimeScope(app.paths, app.repositoryId, token, stopped));

    expect(report.complete).toBe(true);
    for (const path of [indexed, legacy]) {
      const text = await readFile(path, "utf8");
      expect(text).not.toContain("secret draft");
      expect(text).not.toContain("Secret b");
      expect(text).not.toContain(app.trees.linked.id);
      const value = JSON.parse(text);
      expect(value.records.map((entry: { id: string }) => entry.id)).toEqual(["tab-a"]);
      expect(value.preferences.drafts).toEqual({ "tab-a": "keep" });
    }
    expect(JSON.parse(await readFile(legacy, "utf8")).records[0].state.output).toBe("Secret a");
    expect(await readFile(untouched, "utf8")).toBe(siblingOnly);
    // The canonical manifest is the purge result, never a copy.
    const canonical = JSON.parse(await readFile(app.paths.manifest, "utf8"));
    expect(canonical.records.map((entry: { id: string }) => entry.id)).toEqual(["tab-a"]);
    expect(canonical.storageVersion).toBe(2);
  } finally {
    await app.close();
  }
});

test("An unverifiable manifest copy keeps a worktree purge incomplete and unchanged", async () => {
  const app = await fixture();
  try {
    const store = new RuntimeStore(app.paths);
    expectOk(await store.save(app.manifest([app.record("b", app.trees.linked)])));
    const torn = temporary(app.paths.manifest);
    await writePrivate(torn, '{"records":[{"output":"Secret b');
    const foreign = temporary(app.paths.manifest);
    const other = JSON.stringify({ ...app.manifest([]), repositoryId: "/other/.git" });
    await writePrivate(foreign, other);
    const token = "token-manifest-torn-1";
    expectOk(
      await fenceRuntimeScope(
        app.paths,
        app.repositoryId,
        app.receipt(token, "worktrees", [app.trees.linked]),
      ),
    );

    const report = expectOk(await purgeRuntimeScope(app.paths, app.repositoryId, token, stopped));

    expect(report.complete).toBe(false);
    expect(report.residuals.map((item) => item.path).sort()).toEqual([foreign, torn].sort());
    expect(await readFile(torn, "utf8")).toBe('{"records":[{"output":"Secret b');
    expect(await readFile(foreign, "utf8")).toBe(other);
    expect(
      expectOk(await inspectRuntimeCleanup(app.paths, app.repositoryId)).map(
        (entry) => entry.state,
      ),
    ).toEqual(["fenced"]);
  } finally {
    await app.close();
  }
});

test("Retention never removes snapshots through a symbolic sessions directory", async () => {
  const app = await fixture();
  try {
    const store = new RuntimeStore(app.paths);
    expectOk(await store.load(app.repositoryId));
    const file = await app.sdkFile(app.sdk, "b", app.trees.linked.path);
    await utimes(file, 0, 0);
    expectOk(await store.save(app.manifest([app.record("b", app.trees.linked, file, "closed")])));
    const sessions = join(app.paths.directory, "sessions");
    const foreign = join(app.external, "sessions");
    await mkdir(foreign, { mode: 0o700 });
    const name = `${keyOf(app.trees.linked.id, "b")}.json`;
    const victim = join(foreign, name);
    await writePrivate(victim, await readFile(join(sessions, name), "utf8"));
    await rm(sessions, { recursive: true });
    await symlink(foreign, sessions, "dir");

    // The closed managed conversation is expired; retention removes its owned files.
    const pruned = await store.pruneExpired(1, () => () => {}, Date.now() + 1e12);

    expect(await app.exists(victim)).toBe(true);
    expect(pruned.ok).toBe(false);
  } finally {
    await app.close();
  }
});
