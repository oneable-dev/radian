import { expect, test } from "bun:test";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitDiscoveryError, discoverRepository, probeRepository } from "./discovery.ts";
import { RepositoryWatcher, type RepositoryAvailability } from "./repository-watcher.ts";
import { DeletionTracker, type DeletionReceipt } from "./deletion.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectOk } from "../testing/results.ts";
import { err } from "../result.ts";
import { StorageError } from "../errors.ts";

function changes() {
  const values: RepositoryAvailability[] = [];
  const errors: unknown[] = [];
  const listeners = new Set<() => void>();

  return {
    values,
    errors,
    receive(result: RepositoryAvailability) {
      values.push(result);
      for (const listener of listeners) {
        listener();
      }
    },
    unexpected(error: unknown) {
      errors.push(error);
      for (const listener of listeners) {
        listener();
      }
    },
    async until(predicate: () => boolean): Promise<void> {
      if (predicate()) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        const done = () => {
          if (!predicate() && !errors.length) {
            return;
          }

          clearTimeout(timer);
          listeners.delete(done);
          if (errors.length) {
            reject(errors[0]);
          } else {
            resolve();
          }
        };
        const timer = setTimeout(() => {
          listeners.delete(done);
          reject(new Error("Git metadata event was not observed."));
        }, 5000);

        listeners.add(done);
        done();
      });
    },
    includes(path: string) {
      return values.some(
        (result) => result.ok && !!result.value?.worktrees.some((tree) => tree.path === path),
      );
    },
    latest() {
      return values.at(-1);
    },
  };
}

test("Real Git registration/linked HEAD changes detect without depending on deleted startup paths", async () => {
  // Start from a linked checkout; its .git is a file, not the directory being watched.
  const fixture = await createWorktreeFixture();
  const observed = changes();
  const repository = expectOk(await discoverRepository(fixture.feature));
  const watcher = new RepositoryWatcher(repository, observed.receive, observed.unexpected, {
    debounceMs: 10,
  });
  try {
    expectOk(await watcher.start());

    const added = join(fixture.directory, "new checkout");

    // External Git commands, rather than app actions, invalidate the shared catalog.
    await fixture.git(fixture.main, ["worktree", "add", "-b", "feature/new", added]);
    await observed.until(() => observed.includes(added));
    await fixture.git(added, ["switch", "-c", "feature/renamed"]);
    await observed.until(() =>
      observed.values.some(
        (result) =>
          result.ok &&
          !!result.value?.worktrees.some(
            (tree) => tree.path === added && tree.branch === "feature/renamed",
          ),
      ),
    );
    await fixture.git(fixture.main, ["worktree", "remove", "--force", fixture.feature]);
    await observed.until(() =>
      observed.values.some(
        (result) =>
          result.ok &&
          !!result.value &&
          !result.value.worktrees.some((tree) => tree.path === fixture.feature),
      ),
    );

    // The watcher continues reading Git's common directory after the launch checkout disappears.
    expect(observed.errors).toEqual([]);
    expect(observed.values.every((result) => result.ok)).toBe(true);
  } finally {
    await watcher.stop();
    await fixture.cleanup();
  }
});

test("Watchers detect first worktrees and registration-directory recreation when initially absent", async () => {
  const fixture = await createWorktreeFixture();
  const observed = changes();

  await fixture.git(fixture.main, ["worktree", "remove", "--force", fixture.feature]);

  const root = join(fixture.repository.id, "worktrees");
  await rm(root, { recursive: true, force: true });

  const initial = expectOk(await discoverRepository(fixture.main));
  const watcher = new RepositoryWatcher(initial, observed.receive, observed.unexpected, {
    debounceMs: 10,
  });
  try {
    // Only the parent common-directory watch can observe the first registration directory.
    expectOk(await watcher.start());

    const first = join(fixture.directory, "first");
    const second = join(fixture.directory, "second");

    await fixture.git(fixture.main, ["worktree", "add", "-b", "feature/first", first]);
    await observed.until(() => observed.includes(first));

    // Replacing the directory must rebind its watch instead of leaving it on the old inode.
    await rename(root, join(fixture.directory, "old-registration-root"));
    await mkdir(root);
    await fixture.git(fixture.main, ["worktree", "add", "-b", "feature/second", second]);
    await observed.until(() => observed.includes(second));

    expect(observed.errors).toEqual([]);
    expect(observed.values.at(-1)?.ok).toBe(true);
  } finally {
    await watcher.stop();
    await fixture.cleanup();
  }
});

test("Discovery failures never publish empty lists and recover on subsequent Git events", async () => {
  const fixture = await createWorktreeFixture();
  const observed = changes();
  let fail = true;
  const watcher = new RepositoryWatcher(fixture.repository, observed.receive, observed.unexpected, {
    debounceMs: 10,
    probe: (cwd) =>
      fail
        ? Promise.resolve(err(new GitDiscoveryError("Fixture scan failure")))
        : probeRepository(cwd),
  });
  try {
    // A failed scan is observable, without replacing the caller's last valid snapshot.
    expectOk(await watcher.start());
    await observed.until(() => observed.values.some((result) => !result.ok));
    expect(observed.values.filter((result) => result.ok)).toEqual([]);

    fail = false;
    await fixture.git(fixture.main, ["switch", "-c", "recovered"]);
    await observed.until(() =>
      observed.values.some(
        (result) => result.ok && result.value?.worktrees[0]?.branch === "recovered",
      ),
    );

    expect(observed.errors).toEqual([]);
    expect(observed.values.at(-1)?.ok).toBe(true);
  } finally {
    await watcher.stop();
    await fixture.cleanup();
  }
});

test("Events during discovery serialize rescans and disposal suppresses publication", async () => {
  const fixture = await createWorktreeFixture();
  const observed = changes();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const watcher = new RepositoryWatcher(fixture.repository, observed.receive, observed.unexpected, {
    debounceMs: 10,
    probe: async (cwd) => {
      calls++;
      active++;
      maximum = Math.max(maximum, active);
      if (calls === 1) {
        entered.resolve();
        await release.promise;
      }
      try {
        return await probeRepository(cwd);
      } finally {
        active--;
      }
    },
  });
  try {
    // Hold the initial read while several branch changes invalidate it again.
    expectOk(await watcher.start());
    await entered.promise;
    await fixture.git(fixture.main, ["switch", "-c", "during-scan"]);
    release.resolve();
    await observed.until(() =>
      observed.values.some(
        (result) => result.ok && result.value?.worktrees[0]?.branch === "during-scan",
      ),
    );
    await watcher.stop();

    const published = observed.values.length;

    // A closed watcher has no timers or callbacks left that can publish later mutations.
    await writeFile(join(fixture.repository.id, "HEAD"), "ref: refs/heads/main\n");
    expect(maximum).toBe(1);
    expect(observed.values).toHaveLength(published);
    expect(observed.errors).toEqual([]);
  } finally {
    release.resolve();
    await watcher.stop();
    await fixture.cleanup();
  }
});

test("Disposal waits for active Git queries without late updates to closed screens", async () => {
  // The scan has started, but the caller has not yet received its changed metadata.
  const fixture = await createWorktreeFixture();
  const observed = changes();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const watcher = new RepositoryWatcher(fixture.repository, observed.receive, observed.unexpected, {
    debounceMs: 10,
    probe: async (cwd) => {
      entered.resolve();
      await release.promise;

      return probeRepository(cwd);
    },
  });
  try {
    expectOk(await watcher.start());
    await entered.promise;
    await fixture.git(fixture.main, ["switch", "-c", "late-result"]);

    // Closing synchronously removes the native watches; stop also drains the outstanding query.
    const stopped = watcher.stop();
    release.resolve();
    await stopped;

    expect(observed.values).toEqual([]);
    expect(observed.errors).toEqual([]);
  } finally {
    release.resolve();
    await watcher.stop();
    await fixture.cleanup();
  }
});

test("Whole repository deletion publishes confirmed absence and recreation republishes it", async () => {
  const fixture = await createWorktreeFixture();
  const observed = changes();
  const watcher = new RepositoryWatcher(fixture.repository, observed.receive, observed.unexpected, {
    debounceMs: 10,
  });
  const moved = join(fixture.directory, "moved-main");
  try {
    expectOk(await watcher.start());

    // Deleting the checkout that contains the common directory removes the whole repository.
    await rename(fixture.main, moved);
    await observed.until(() => {
      const latest = observed.latest();

      return latest?.ok === true && latest.value === null;
    });

    // Restoring it at the same path is observed through the surviving ancestor watch.
    await rename(moved, fixture.main);
    await observed.until(() => {
      const latest = observed.latest();

      return latest?.ok === true && latest.value?.id === fixture.repository.id;
    });

    // A second deletion after reappearance is still detected by the rebound watches.
    await rm(fixture.main, { recursive: true, force: true });
    await observed.until(() => {
      const latest = observed.latest();

      return latest?.ok === true && latest.value === null;
    });

    expect(observed.errors).toEqual([]);
    expect(observed.values.every((result) => result.ok)).toBe(true);
  } finally {
    await watcher.stop();
    await fixture.cleanup();
  }
});

test("Externally deleted linked checkouts leave the catalog while Git still registers them", async () => {
  const fixture = await createWorktreeFixture();
  const observed = changes();
  const watcher = new RepositoryWatcher(fixture.repository, observed.receive, observed.unexpected, {
    debounceMs: 10,
  });
  try {
    expectOk(await watcher.start());

    // Removing the directory without `git worktree remove` keeps the registration in place.
    await rm(fixture.feature, { recursive: true, force: true });
    await observed.until(() => {
      const latest = observed.latest();

      return (
        latest?.ok === true &&
        !!latest.value &&
        latest.value.worktrees.every((tree) => tree.path !== fixture.feature)
      );
    });

    const latest = observed.latest();
    expect(latest?.ok && latest.value?.worktrees.map((tree) => tree.path)).toEqual([fixture.main]);
    expect(observed.errors).toEqual([]);
  } finally {
    await watcher.stop();
    await fixture.cleanup();
  }
});

test("Permission failures publish typed errors without claiming absence and then recover", async () => {
  const fixture = await createWorktreeFixture();
  const observed = changes();
  const locked = join(fixture.directory, "locked");
  const checkout = join(locked, "checkout");
  await mkdir(locked);
  await fixture.git(fixture.main, ["worktree", "add", "-b", "feature/locked", checkout]);

  const repository = expectOk(await discoverRepository(fixture.main));
  const watcher = new RepositoryWatcher(repository, observed.receive, observed.unexpected, {
    debounceMs: 10,
  });
  try {
    expectOk(await watcher.start());

    // An unsearchable parent makes the checkout uninspectable, which is not proof of deletion.
    await chmod(locked, 0);
    await fixture.git(fixture.main, ["switch", "-c", "while-unreadable"]);
    await observed.until(() => observed.values.some((result) => !result.ok));

    const failure = observed.values.find((result) => !result.ok);
    expect(failure?.ok === false && failure.error).toBeInstanceOf(StorageError);
    expect(failure?.ok === false && (failure.error as StorageError).systemCode).toBe("EACCES");
    expect(observed.values.some((result) => result.ok && result.value === null)).toBe(false);

    await chmod(locked, 0o755);
    await fixture.git(fixture.main, ["switch", "-c", "readable-again"]);
    await observed.until(() => {
      const latest = observed.latest();

      return latest?.ok === true && latest.value?.worktrees[0]?.branch === "readable-again";
    });

    const latest = observed.latest();
    expect(latest?.ok && latest.value?.worktrees.map((tree) => tree.path)).toEqual([
      fixture.main,
      fixture.feature,
      checkout,
    ]);
    expect(observed.errors).toEqual([]);
  } finally {
    await chmod(locked, 0o755);
    await watcher.stop();
    await fixture.cleanup();
  }
});

test("Unexpected probe failures keep their original error instead of availability results", async () => {
  const fixture = await createWorktreeFixture();
  const observed = changes();
  const bug = new Error("Fixture programming error");
  const watcher = new RepositoryWatcher(fixture.repository, observed.receive, observed.unexpected, {
    debounceMs: 10,
    probe: () => Promise.reject(bug),
  });
  try {
    expectOk(await watcher.start());
    // `until` rejects with the first unexpected error reported by the watcher.
    await expect(observed.until(() => false)).rejects.toBe(bug);
    await watcher.stop();

    // Programming errors keep their identity instead of becoming ordinary availability results.
    expect(observed.errors).toEqual([bug]);
    expect(observed.values).toEqual([]);
  } finally {
    await watcher.stop();
    await fixture.cleanup();
  }
});

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "Deletion evidence is drained on invalidation even when Git metadata disappears first",
  async () => {
    const fixture = await createWorktreeFixture();
    const observed = changes();
    const tracker = new DeletionTracker();
    const receipts: DeletionReceipt[] = [];
    tracker.onReceipt((receipt) => receipts.push(receipt));
    const watcher = new RepositoryWatcher(
      fixture.repository,
      observed.receive,
      observed.unexpected,
      {
        debounceMs: 10,
        deletion: tracker,
      },
    );
    try {
      expectOk(await watcher.start());

      // `rm -rf` removes `.git` before the checkout, so Git probes may fail mid-deletion.
      await rm(fixture.main, { recursive: true, force: true });
      await observed.until(() => receipts.length > 0);

      expect(receipts.map((receipt) => receipt.kind)).toEqual(["repository"]);
      expect(receipts[0]?.scopes.map((scope) => scope.worktreeId).sort()).toEqual(
        [fixture.feature, fixture.main].sort(),
      );
      // Availability keeps its own contract; evidence is reported separately.
      await observed.until(() => {
        const latest = observed.latest();

        return latest?.ok === true && latest.value === null;
      });
      expect(observed.errors).toEqual([]);
    } finally {
      await watcher.stop();
      tracker.close();
      await fixture.cleanup();
    }
  },
);

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "Renaming a watched repository away yields absence without deletion evidence",
  async () => {
    const fixture = await createWorktreeFixture();
    const observed = changes();
    const tracker = new DeletionTracker();
    const watcher = new RepositoryWatcher(
      fixture.repository,
      observed.receive,
      observed.unexpected,
      {
        debounceMs: 10,
        deletion: tracker,
      },
    );
    try {
      expectOk(await watcher.start());

      await rename(fixture.main, join(fixture.directory, "moved-main"));
      await observed.until(() => {
        const latest = observed.latest();

        return latest?.ok === true && latest.value === null;
      });
      // Deleting the moved copy is not evidence about the original location either.
      await rm(join(fixture.directory, "moved-main"), { recursive: true, force: true });
      await writeFile(join(fixture.directory, "touch"), "");
      tracker.collect();

      expect(tracker.receipts()).toEqual([]);
      // The watcher leaves the caller-owned tracker open for a later owner.
      expect(tracker.scopeIdentity(fixture.repository.id, fixture.feature)).not.toBeNull();
      await watcher.stop();
      expect(tracker.scopeIdentity(fixture.repository.id, fixture.feature)).not.toBeNull();
    } finally {
      await watcher.stop();
      tracker.close();
      await fixture.cleanup();
    }
  },
);
