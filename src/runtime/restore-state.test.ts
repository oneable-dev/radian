import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectError, expectOk } from "../testing/results.ts";
import type { WorkspaceSource } from "./daemon-protocol.ts";
import {
  mergeSource,
  RestoreStateStore,
  sourceContexts,
  withCleanupLock,
  withRepositoryState,
  writeCleanupLedger,
} from "./restore-state.ts";

async function isolated(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "radian-restore-state-"));
  try {
    await run(directory);
  } finally {
    await chmod(directory, 0o700);
    await rm(directory, { recursive: true, force: true });
  }
}

const source = (cwd: string, settings = "/config/settings.json"): WorkspaceSource => ({
  settings: { path: settings, explicit: true },
  workspace: { path: "/config/workspace.json", explicit: false },
  cwd,
});

const v1 = JSON.stringify({
  version: 1,
  chatConfig: "/config/settings.json",
  repositories: [
    {
      repositoryId: "/deleted/.git",
      cwd: "/deleted",
      active: true,
      config: "/config/settings.json",
    },
    { repositoryId: "/cold/.git", cwd: "/cold", active: false },
  ],
});

test("v1 registrations migrate to metadata only, with the original backed up before replacement", () =>
  isolated(async (directory) => {
    // A v1 registry knows paths and policy files but not which workspace configuration produced them.
    const path = join(directory, "repositories.json");
    await writeFile(path, v1);
    const store = new RestoreStateStore(path);

    const registry = expectOk(await store.load())!;

    // No source is guessed from repository paths or policy files, and every entry is preserved.
    expect(registry.version).toBe(2);
    expect(registry.source).toBeUndefined();
    expect(registry.chatConfig).toBe("/config/settings.json");
    expect(registry.repositories).toEqual([
      {
        repositoryId: "/deleted/.git",
        active: true,
        cwd: "/deleted",
        config: "/config/settings.json",
      },
      { repositoryId: "/cold/.git", active: false, cwd: "/cold" },
    ]);
    expect(await readFile(path, "utf8")).toBe(v1);

    // The first replacement keeps the untouched original beside the new file.
    expectOk(await store.save({ ...registry, source: source("/repo") }));
    expect(await readFile(store.backupPath, "utf8")).toBe(v1);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 2,
      source: source("/repo"),
      repositories: registry.repositories,
    });
  }));

test("An interrupted migration never overwrites its earlier backup on retry", () =>
  isolated(async (directory) => {
    // A previous attempt preserved the original before failing to replace the registry.
    const path = join(directory, "repositories.json");
    const store = new RestoreStateStore(path);
    await writeFile(path, v1);
    await writeFile(store.backupPath, v1);

    const registry = expectOk(await store.load())!;
    expectOk(await store.save(registry));
    expectOk(await store.save(registry));

    expect(await readFile(store.backupPath, "utf8")).toBe(v1);
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(2);
  }));

test("A stale migration cannot overwrite a registry replaced after its original was loaded", () =>
  isolated(async (directory) => {
    // Two readers can retain the same v1 original, but only the first replacement remains authoritative.
    const path = join(directory, "repositories.json");
    await writeFile(path, v1);
    const stale = new RestoreStateStore(path);
    const current = new RestoreStateStore(path);
    const old = expectOk(await stale.load())!;
    const initial = expectOk(await current.load())!;
    const newer = { ...initial, source: source("/newer-workspace") };
    expectOk(await current.save(newer));
    const accepted = await readFile(path, "utf8");

    // A verified backup does not authorize replacing a different, more recent manifest.
    expect(expectError(await stale.save(old)).code).toBe("STORAGE_FAILED");

    expect(await readFile(path, "utf8")).toBe(accepted);
    expect(await readFile(stale.backupPath, "utf8")).toBe(v1);
    expect(expectOk(await stale.load())).toEqual(newer);
  }));

test("A partial or unrelated backup blocks migration without changing either recovery source", () =>
  isolated(async (directory) => {
    // A final backup name alone cannot prove that an earlier write completed successfully.
    const path = join(directory, "repositories.json");
    const store = new RestoreStateStore(path);
    await writeFile(path, v1);
    await writeFile(store.backupPath, v1.slice(0, 12));
    const registry = expectOk(await store.load())!;

    // Refuse replacement until the current original has a complete verified backup.
    expect(expectError(await store.save(registry)).code).toBe("STORAGE_FAILED");

    expect(await readFile(path, "utf8")).toBe(v1);
    expect(await readFile(store.backupPath, "utf8")).toBe(v1.slice(0, 12));
  }));

test.each([
  ["unknown version", '{"version":99,"repositories":[]}'],
  ["broken JSON", "{broken"],
  ["unknown field", '{"version":2,"repositories":[],"roots":["/projects"]}'],
])("A corrupt registry (%s) is reported and never replaced", (_name, text) =>
  isolated(async (directory) => {
    const path = join(directory, "repositories.json");
    await writeFile(path, text);

    const loaded = expectError(await new RestoreStateStore(path).load());

    expect(loaded.code).toBe("STORAGE_FAILED");
    expect(await readFile(path, "utf8")).toBe(text);
  }),
);

test("Missing registries are distinguished from empty ones, and failed saves return storage errors", () =>
  isolated(async (directory) => {
    const path = join(directory, "repositories.json");
    const store = new RestoreStateStore(path);
    expect(expectOk(await store.load())).toBeNull();

    // A read-only state directory rejects the atomic temporary file without partial output.
    await chmod(directory, 0o500);
    const saved = await store.save({ version: 2, repositories: [] });

    expect(expectError(saved).code).toBe("STORAGE_FAILED");
    await chmod(directory, 0o700);
    expect(expectOk(await store.load())).toBeNull();
  }));

test("Same-reference sources keep explicit launch contexts; different references replace them", () => {
  // roots=[] launches from two repositories with the same settings remain additive.
  const merged = mergeSource(source("/a"), source("/b"));
  expect(sourceContexts(merged)).toEqual(["/a", "/b"]);
  expect(sourceContexts(mergeSource(merged, source("/a")))).toEqual(["/a", "/b"]);

  // Another settings reference is a different source, not a merge of heterogeneous scopes.
  const replaced = mergeSource(merged, source("/c", "/other/settings.json"));
  expect(replaced).toEqual(source("/c", "/other/settings.json"));
  expect(mergeSource(undefined, source("/a"))).toEqual(source("/a"));
});

test("Repository metadata updates preserve unrelated and unknown-origin entries", () => {
  const registry = {
    version: 2 as const,
    repositories: [
      { repositoryId: "/legacy/.git", active: true, cwd: "/legacy" },
      { repositoryId: "/a/.git", active: false },
    ],
  };

  const updated = withRepositoryState(registry, { repositoryId: "/a/.git", active: true });
  const appended = withRepositoryState(updated, { repositoryId: "/b/.git", active: false });

  expect(appended.repositories).toEqual([
    { repositoryId: "/legacy/.git", active: true, cwd: "/legacy" },
    { repositoryId: "/a/.git", active: true },
    { repositoryId: "/b/.git", active: false },
  ]);
  expect(registry.repositories[1]!.active).toBe(false);
});

const deletedReceipt = (
  kind: "repository" | "worktrees",
  worktrees: { id: string; path: string }[],
  repositoryId = "/deleted/.git",
) => ({
  token: "cleanup-token-1",
  repositoryId,
  kind,
  worktrees,
  sessionIds: [],
  revision: 1,
  state: "fenced" as const,
  updatedAt: 0,
});

test("Purging a deleted repository sanitizes a pending v1 migration and its backup", () =>
  isolated(async (directory) => {
    // A v1 registry loaded before deletion may still be migrated by a stale reader afterward.
    const path = join(directory, "repositories.json");
    await writeFile(path, v1);
    const stale = new RestoreStateStore(path);
    const old = expectOk(await stale.load())!;
    const daemon = new RestoreStateStore(path);
    expectOk(await daemon.load());

    const purged = expectOk(
      await daemon.purge(deletedReceipt("repository", [{ id: "/deleted", path: "/deleted" }])),
    )!;

    // The deleted entry is gone everywhere, unrelated entries and CHAT configuration remain.
    expect(purged.repositories.map((entry) => entry.repositoryId)).toEqual(["/cold/.git"]);
    expect(purged.chatConfig).toBe("/config/settings.json");
    const backup = JSON.parse(await readFile(daemon.backupPath, "utf8"));
    expect(backup.chatConfig).toBe("/config/settings.json");
    expect(backup.repositories.map((entry: { cwd: string }) => entry.cwd)).toEqual(["/cold"]);
    expect(await readFile(path, "utf8")).not.toContain("/deleted");
    // The stale migration no longer matches the original and cannot republish it.
    expect(expectError(await stale.save(old)).code).toBe("STORAGE_FAILED");
    expect(await readFile(path, "utf8")).not.toContain("/deleted");
  }));

test("A deleted worktree keeps source references but stops being a launch context", () =>
  isolated(async (directory) => {
    // roots=[] relaunches discover only from explicit contexts, so a removed one must not return.
    const path = join(directory, "repositories.json");
    const store = new RestoreStateStore(path);
    const launched = mergeSource(source("/deleted/feature"), source("/other"));
    expectOk(
      await store.save({
        version: 2,
        source: launched,
        chatConfig: null,
        repositories: [{ repositoryId: "/deleted/.git", active: true, cwd: "/deleted/feature" }],
      }),
    );

    const purged = expectOk(
      await store.purge(
        deletedReceipt("worktrees", [{ id: "/deleted/feature", path: "/deleted/feature" }]),
      ),
    )!;

    // The historical cwd and settings stay; only the cwd metadata of the entry is removed.
    expect(purged.source).toEqual({
      ...source("/deleted/feature"),
      contexts: ["/other"],
      cwdRemoved: true,
    });
    expect(purged.chatConfig).toBeNull();
    expect(purged.repositories).toEqual([{ repositoryId: "/deleted/.git", active: true }]);
    expect(sourceContexts(purged.source!)).toEqual(["/other"]);
    expect(expectOk(await new RestoreStateStore(path).load())).toEqual(purged);
  }));

test("A removed cwd yields no launch context and returns only when launched explicitly again", () => {
  // Without other contexts, discovery receives nothing rather than a fabricated directory.
  const removed: WorkspaceSource = { ...source("/deleted"), cwdRemoved: true };
  expect(sourceContexts(removed)).toEqual([]);

  // Another launch adds its own context but keeps the removed marker.
  const other = mergeSource(removed, source("/other"));
  expect(other.cwdRemoved).toBe(true);
  expect(sourceContexts(other)).toEqual(["/other"]);

  // Launching from the recreated path is fresh permission to discover it.
  const relaunched = mergeSource(other, source("/deleted"));
  expect(relaunched.cwdRemoved).toBeUndefined();
  expect(sourceContexts(relaunched)).toEqual(["/deleted", "/other"]);
});

test("An excluded scope is dropped from saves until it is released", () =>
  isolated(async (directory) => {
    // Exclusion is immediate and in-process, before any durable receipt exists.
    const path = join(directory, "repositories.json");
    const store = new RestoreStateStore(path);
    const registry = {
      version: 2 as const,
      source: source("/deleted/feature"),
      repositories: [
        { repositoryId: "/deleted/.git", active: true },
        { repositoryId: "/kept/.git", active: false },
      ],
    };
    store.exclude({
      token: "cleanup-token-2",
      repositoryId: "/deleted/.git",
      kind: "repository",
      worktreePaths: ["/deleted/feature"],
    });

    expectOk(await store.save(registry));
    const excluded = JSON.parse(await readFile(path, "utf8"));
    store.release("cleanup-token-2");
    expectOk(await store.save(registry));

    expect(excluded.repositories).toEqual([{ repositoryId: "/kept/.git", active: false }]);
    expect(excluded.source.cwdRemoved).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(registry);
  }));

test("A store that loaded before a purge cannot restore the deleted scope by saving later", () =>
  isolated(async (directory) => {
    // Another daemon instance keeps an old in-memory registry and saves it after the purge.
    const path = join(directory, "repositories.json");
    const original = {
      version: 2 as const,
      source: source("/deleted"),
      repositories: [
        { repositoryId: "/deleted/.git", active: true },
        { repositoryId: "/kept/.git", active: true },
      ],
    };
    expectOk(await new RestoreStateStore(path).save(original));
    const stale = new RestoreStateStore(path);
    const old = expectOk(await stale.load())!;
    const receipt = deletedReceipt("repository", [{ id: "/deleted", path: "/deleted" }]);
    expectOk(
      await withCleanupLock(directory, () =>
        writeCleanupLedger(directory, { version: 1, revision: 1, receipts: [receipt] }),
      ),
    );
    expectOk(await new RestoreStateStore(path).purge(receipt));

    expectOk(await stale.save(old));

    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.repositories).toEqual([{ repositoryId: "/kept/.git", active: true }]);
    expect(saved.source.cwdRemoved).toBe(true);
  }));
