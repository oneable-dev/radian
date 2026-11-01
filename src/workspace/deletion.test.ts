import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { chmod, mkdir, rename, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { CapabilityError } from "../errors.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { ok, type Result } from "../result.ts";
import { DeletionTracker, parseDeletionReceipt, type DeletionReceipt } from "./deletion.ts";
import {
  createDirectoryMonitor,
  type DirectoryMonitor,
  type DirectorySignals,
  type HeldDirectory,
} from "./deletion-native.ts";
import { discoverRepository } from "./discovery.ts";

const supported = process.platform === "darwin" || process.platform === "linux";

function openDescriptors(): number {
  return readdirSync("/dev/fd").length;
}

function scopeIds(receipt: DeletionReceipt | undefined): string[] {
  return (receipt?.scopes.map((scope) => scope.worktreeId) ?? []).sort();
}

async function trackedFixture() {
  const fixture = await createWorktreeFixture();
  const tracker = new DeletionTracker();
  expectOk(await tracker.track(fixture.repository));

  return {
    fixture,
    tracker,
    async cleanup() {
      tracker.close();
      await fixture.cleanup();
    },
  };
}

test.skipIf(!supported)("Removing one linked checkout confirms only that scope", async () => {
  const { fixture, tracker, cleanup } = await trackedFixture();
  try {
    const identity = tracker.scopeIdentity(fixture.repository.id, fixture.feature);
    await rm(fixture.feature, { recursive: true, force: true });

    const confirmed = expectOk(tracker.collect());

    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]?.kind).toBe("worktree");
    expect(confirmed[0]?.scopes).toEqual([
      { worktreeId: fixture.feature, path: fixture.feature, identity },
    ]);
    expect(tracker.scopeIdentity(fixture.repository.id, fixture.main)).not.toBeNull();
    // A drained report is not lost: it stays pending until acknowledged.
    expect(expectOk(tracker.collect())).toEqual([]);
    expect(tracker.receipts()).toEqual(confirmed);
  } finally {
    await cleanup();
  }
});

test.skipIf(!supported)(
  "Renames, parent moves and moves outside the workspace are never deletion",
  async () => {
    const { fixture, tracker, cleanup } = await trackedFixture();
    const outside = join(fixture.directory, "outside");
    try {
      await rename(fixture.feature, join(fixture.directory, "feature-renamed"));
      expect(expectOk(tracker.collect())).toEqual([]);

      await mkdir(outside);
      await rename(join(fixture.directory, "feature-renamed"), join(outside, "feature"));
      await rename(fixture.directory, `${fixture.directory}-moved`);
      await rename(`${fixture.directory}-moved`, fixture.directory);
      expect(expectOk(tracker.collect())).toEqual([]);

      // Deleting a moved directory later is not attributable to the old path either.
      await rm(join(outside, "feature"), { recursive: true, force: true });
      expect(expectOk(tracker.collect())).toEqual([]);
      expect(tracker.receipts()).toEqual([]);
    } finally {
      await cleanup();
    }
  },
);

test.skipIf(!supported)(
  "Deleting the main checkout with its common directory covers every associated scope",
  async () => {
    const fixture = await createWorktreeFixture();
    // A linked checkout outside any configured workspace root still belongs to the repository.
    const external = join(fixture.directory, "elsewhere", "linked");
    await fixture.git(fixture.main, ["worktree", "add", "-b", "feature/external", external]);
    const repository = expectOk(await discoverRepository(fixture.main));
    const tracker = new DeletionTracker();
    try {
      expectOk(await tracker.track(repository));

      await rm(fixture.main, { recursive: true, force: true });
      const confirmed = expectOk(tracker.collect());

      expect(confirmed).toHaveLength(1);
      expect(confirmed[0]?.kind).toBe("repository");
      expect(confirmed[0]?.directories.map((directory) => directory.role).sort()).toEqual([
        "common",
        "main",
      ]);
      expect(scopeIds(confirmed[0])).toEqual([external, fixture.feature, fixture.main].sort());
    } finally {
      tracker.close();
      await fixture.cleanup();
    }
  },
);

test.skipIf(!supported)("Losing only Git metadata is corruption, not deletion", async () => {
  const { fixture, tracker, cleanup } = await trackedFixture();
  try {
    await rm(fixture.repository.id, { recursive: true, force: true });

    expect(expectOk(tracker.collect())).toEqual([]);

    // Reinitializing Git there later is a new generation and still not a deletion.
    await fixture.git(fixture.main, ["init", "--initial-branch=main"]);
    const reinitialized = expectOk(await discoverRepository(fixture.main));
    expectOk(await tracker.track(reinitialized));
    expect(expectOk(tracker.collect())).toEqual([]);
    expect(tracker.receipts()).toEqual([]);
  } finally {
    await cleanup();
  }
});

test.skipIf(!supported)(
  "A main checkout removed while its external common directory survives is a single scope",
  async () => {
    const fixture = await createWorktreeFixture();
    const common = join(fixture.directory, "common.git");
    const checkout = join(fixture.directory, "separate");
    const linked = join(fixture.directory, "separate-linked");
    const tracker = new DeletionTracker();
    try {
      await fixture.git(fixture.directory, ["clone", "--bare", fixture.main, common]);
      await fixture.git(common, ["config", "core.bare", "false"]);
      await fixture.git(common, ["worktree", "add", "-b", "feature/separate", linked]);
      await mkdir(checkout);
      await Bun.write(join(checkout, ".git"), `gitdir: ${common}\n`);
      await fixture.git(common, ["config", "core.worktree", checkout]);
      const repository = expectOk(await discoverRepository(linked));
      expectOk(await tracker.track(repository));

      await rm(checkout, { recursive: true, force: true });
      const confirmed = expectOk(tracker.collect());

      // Git reports the common directory as the main entry here, so the checkout is never
      // treated as the repository root or as proof about other scopes.
      expect(confirmed).toEqual([]);
      expect(tracker.scopeIdentity(repository.id, linked)).not.toBeNull();

      // Losing the external common directory too still lacks proof of the repository root.
      await rm(common, { recursive: true, force: true });
      expect(expectOk(tracker.collect())).toEqual([]);
    } finally {
      tracker.close();
      await fixture.cleanup();
    }
  },
);

test.skipIf(!supported)("Deleting a bare repository root covers its linked checkouts", async () => {
  const fixture = await createWorktreeFixture();
  const bare = join(fixture.directory, "bare.git");
  const linked = join(fixture.directory, "bare-linked");
  const tracker = new DeletionTracker();
  try {
    await fixture.git(fixture.directory, ["clone", "--bare", fixture.main, bare]);
    await fixture.git(bare, ["worktree", "add", "-b", "feature/bare", linked]);
    const repository = expectOk(await discoverRepository(bare));
    expectOk(await tracker.track(repository));

    await rm(bare, { recursive: true, force: true });
    const confirmed = expectOk(tracker.collect());

    expect(confirmed.map((receipt) => receipt.kind)).toEqual(["repository"]);
    expect(confirmed[0]?.directories.map((directory) => directory.role)).toEqual(["common"]);
    expect(scopeIds(confirmed[0])).toEqual([linked]);
  } finally {
    tracker.close();
    await fixture.cleanup();
  }
});

test.skipIf(!supported)(
  "Recreation at the same path keeps the old proof and tags the new generation separately",
  async () => {
    const { fixture, tracker, cleanup } = await trackedFixture();
    try {
      const old = tracker.scopeIdentity(fixture.repository.id, fixture.feature);
      await rm(fixture.feature, { recursive: true, force: true });
      await mkdir(fixture.feature);

      // Discovery of the recreated path must not discard the queued unlink report.
      expectOk(await tracker.track(fixture.repository));
      const [receipt] = tracker.receipts();

      expect(receipt?.scopes[0]?.identity).toEqual(old);
      const current = tracker.scopeIdentity(fixture.repository.id, fixture.feature);
      expect(current).not.toBeNull();
      expect(current).not.toEqual(old);

      // The new generation can itself be deleted later with its own receipt.
      await rmdir(fixture.feature);
      expect(expectOk(tracker.collect())[0]?.scopes[0]?.identity).toEqual(current);
      expect(tracker.receipts()).toHaveLength(2);
    } finally {
      await cleanup();
    }
  },
);

test.skipIf(!supported)("A rename followed by restoration re-arms real deletion", async () => {
  const { fixture, tracker, cleanup } = await trackedFixture();
  const moved = join(fixture.directory, "feature-moved");
  try {
    await rename(fixture.feature, moved);
    expect(expectOk(tracker.collect())).toEqual([]);
    await rename(moved, fixture.feature);
    expect(expectOk(tracker.collect())).toEqual([]);

    await rm(fixture.feature, { recursive: true, force: true });

    expect(expectOk(tracker.collect()).map((receipt) => receipt.kind)).toEqual(["worktree"]);
  } finally {
    await cleanup();
  }
});

test.skipIf(!supported)("An inaccessible ancestor keeps captured proof pending", async () => {
  const fixture = await createWorktreeFixture();
  const locked = join(fixture.directory, "locked");
  const checkout = join(locked, "checkout");
  const tracker = new DeletionTracker();
  try {
    await mkdir(locked);
    await fixture.git(fixture.main, ["worktree", "add", "-b", "feature/locked", checkout]);
    expectOk(await tracker.track(expectOk(await discoverRepository(fixture.main))));

    await rm(checkout, { recursive: true, force: true });
    await chmod(locked, 0);
    expect(expectOk(tracker.collect())).toEqual([]);

    await chmod(locked, 0o755);
    expect(scopeIds(expectOk(tracker.collect())[0])).toEqual([checkout]);
  } finally {
    await chmod(locked, 0o755);
    tracker.close();
    await fixture.cleanup();
  }
});

test.skipIf(!supported)(
  "Absence observed without held descriptors, as after a restart, is never confirmed",
  async () => {
    const fixture = await createWorktreeFixture();
    const tracker = new DeletionTracker();
    try {
      await rm(fixture.feature, { recursive: true, force: true });

      expectOk(await tracker.track(fixture.repository));

      expect(expectOk(tracker.collect())).toEqual([]);
      expect(tracker.scopeIdentity(fixture.repository.id, fixture.feature)).toBeNull();
    } finally {
      tracker.close();
      await fixture.cleanup();
    }
  },
);

test.skipIf(!supported)(
  "Receipts persist until acknowledged, notify listeners and survive disposal",
  async () => {
    const { fixture, tracker, cleanup } = await trackedFixture();
    const notified: DeletionReceipt[] = [];
    try {
      tracker.onReceipt((receipt) => notified.push(receipt));
      await rm(fixture.feature, { recursive: true, force: true });
      const [receipt] = expectOk(tracker.collect());

      expect(notified).toEqual([receipt!]);
      expect(expectOk(parseDeletionReceipt(JSON.parse(JSON.stringify(receipt))))).toEqual(receipt!);
      expect(tracker.close()).toEqual([receipt!]);
      expect(tracker.acknowledge(receipt!.id)).toBe(true);
      expect(tracker.receipts()).toEqual([]);
    } finally {
      await cleanup();
    }
  },
);

test.skipIf(!supported)("Tracking and closing release every descriptor", async () => {
  const fixture = await createWorktreeFixture();
  const before = openDescriptors();
  const tracker = new DeletionTracker();
  try {
    expectOk(await tracker.track(fixture.repository));
    expectOk(await tracker.track(fixture.repository));
    expect(openDescriptors()).toBeGreaterThan(before);

    await rm(fixture.feature, { recursive: true, force: true });
    expectOk(tracker.collect());
    tracker.close();

    expect(openDescriptors()).toBe(before);
    // A closed tracker ignores later work instead of reopening descriptors.
    expectOk(await tracker.track(fixture.repository));
    expect(openDescriptors()).toBe(before);
  } finally {
    tracker.close();
    await fixture.cleanup();
  }
});

class FakeDirectory implements HeldDirectory {
  state: DirectorySignals = { unlinked: false, renamed: false, revoked: false, failed: false };
  constructor(
    readonly path: string,
    readonly identity = { device: "1", inode: path, birth: "1" },
  ) {}
  signals() {
    return this.state;
  }
  release() {}
}

class FakeMonitor implements DirectoryMonitor {
  readonly held = new Map<string, FakeDirectory>();
  hold(path: string) {
    // Mirror the real identity so path checks see the held inode as still present.
    const real = createDirectoryMonitor().monitor;
    const opened = real.hold(path);
    real.close();
    if (!opened.ok) {
      return opened;
    }

    const directory = new FakeDirectory(path, opened.value.identity);
    this.held.set(path, directory);

    return ok(directory);
  }
  collect() {
    return ok(undefined);
  }
  close() {}
}

test.skipIf(!supported)("Revocation and registration errors stay non-destructive", async () => {
  const fixture = await createWorktreeFixture();
  const monitor = new FakeMonitor();
  const tracker = new DeletionTracker({
    monitor: { monitor, source: "darwin-kqueue-note-delete" },
  });
  try {
    expectOk(await tracker.track(fixture.repository));
    await rm(fixture.feature, { recursive: true, force: true });
    await rm(fixture.main, { recursive: true, force: true });

    const signals = { unlinked: true, renamed: false, revoked: false, failed: false };
    monitor.held.get(fixture.feature)!.state = { ...signals, revoked: true };
    monitor.held.get(fixture.main)!.state = { ...signals, failed: true };
    monitor.held.get(fixture.repository.id)!.state = { ...signals, renamed: true };

    expect(expectOk(tracker.collect())).toEqual([]);
  } finally {
    tracker.close();
    await fixture.cleanup();
  }
});

test("Unsupported platforms report a capability failure and retain data", async () => {
  const fixture = await createWorktreeFixture();
  const unsupported: DirectoryMonitor = {
    hold: () => ({ ok: false, error: new CapabilityError("unsupported") }),
    collect: () => ok(undefined),
    close: () => {},
  };
  const tracker = new DeletionTracker({ monitor: { monitor: unsupported, source: null } });
  try {
    const error = expectError(await tracker.track(fixture.repository));
    await rm(fixture.feature, { recursive: true, force: true });

    expect(error.code).toBe("UNSUPPORTED_CAPABILITY");
    expect(tracker.lastError()).toBe(error);
    expect(expectOk(tracker.collect())).toEqual([]);
  } finally {
    tracker.close();
    await fixture.cleanup();
  }
});

test("Git failures while reading the repository root leave nothing confirmed", async () => {
  const fixture = await createWorktreeFixture();
  const failure = new CapabilityError("fixture");
  const tracker = new DeletionTracker({
    readMain: (): Promise<Result<never, CapabilityError>> =>
      Promise.resolve({ ok: false, error: failure }),
  });
  try {
    expect(expectError(await tracker.track(fixture.repository))).toBe(failure);
    await rm(fixture.main, { recursive: true, force: true });

    expect(expectOk(tracker.collect())).toEqual([]);
  } finally {
    tracker.close();
    await fixture.cleanup();
  }
});

test("Malformed persisted receipts are rejected", () => {
  const valid = {
    version: 1,
    id: "worktree",
    kind: "worktree",
    repositoryId: "/repo/.git",
    evidence: "linux-unlinked-descriptor",
    directories: [
      { role: "worktree", path: "/wt", identity: { device: "1", inode: "2", birth: "3" } },
    ],
    scopes: [{ worktreeId: "/wt", path: "/wt", identity: null }],
  };

  expect(parseDeletionReceipt(valid).ok).toBe(true);
  expect(parseDeletionReceipt({ ...valid, evidence: "path-missing" }).ok).toBe(false);
  expect(parseDeletionReceipt({ ...valid, directories: [] }).ok).toBe(false);
  expect(parseDeletionReceipt({ ...valid, scopes: [...valid.scopes, ...valid.scopes] }).ok).toBe(
    false,
  );
  expect(parseDeletionReceipt(null).ok).toBe(false);
});
