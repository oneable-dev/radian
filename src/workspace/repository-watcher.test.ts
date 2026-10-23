import { expect, test } from "bun:test";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitDiscoveryError, discoverRepository } from "./discovery.ts";
import { RepositoryWatcher } from "./repository-watcher.ts";
import type { Repository } from "./model.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectOk } from "../testing/results.ts";
import { err, type Result } from "../result.ts";
import type { ExpectedError } from "../errors.ts";

function changes() {
  const values: Result<Repository, ExpectedError>[] = [], errors: unknown[] = [];
  const listeners = new Set<() => void>();
  return { values, errors, receive(result: Result<Repository, ExpectedError>) { values.push(result); for (const listener of listeners) listener(); },
    unexpected(error: unknown) { errors.push(error); for (const listener of listeners) listener(); },
    async until(predicate: () => boolean): Promise<void> {
      if (predicate()) return;
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          if (!predicate() && !errors.length) return;
          clearTimeout(timer); listeners.delete(done);
          errors.length ? reject(errors[0]) : resolve();
        };
        const timer = setTimeout(() => { listeners.delete(done); reject(new Error("Git metadata event was not observed.")); }, 5000);
        listeners.add(done); done();
      });
    },
    includes(path: string) { return values.some((result) => result.ok && result.value.worktrees.some((tree) => tree.path === path)); },
  };
}

test("Real Git registration/linked HEAD changes detect without depending on deleted startup paths", async () => {
  // Start from a linked checkout; its .git is a file, not the directory being watched.
  const fixture = await createWorktreeFixture(), observed = changes();
  const repository = expectOk(await discoverRepository(fixture.feature));
  const watcher = new RepositoryWatcher(repository, observed.receive, observed.unexpected, { debounceMs: 10 });
  try {
    expectOk(await watcher.start());
    const added = join(fixture.directory, "new checkout");

    // External Git commands, rather than app actions, invalidate the shared catalog.
    await fixture.git(fixture.main, ["worktree", "add", "-b", "feature/new", added]);
    await observed.until(() => observed.includes(added));
    await fixture.git(added, ["switch", "-c", "feature/renamed"]);
    await observed.until(() => observed.values.some((result) => result.ok && result.value.worktrees.some((tree) => tree.path === added && tree.branch === "feature/renamed")));
    await fixture.git(fixture.main, ["worktree", "remove", "--force", fixture.feature]);
    await observed.until(() => observed.values.some((result) => result.ok && !result.value.worktrees.some((tree) => tree.path === fixture.feature)));

    // The watcher continues reading Git's common directory after the launch checkout disappears.
    expect(observed.errors).toEqual([]);
    expect(observed.values.every((result) => result.ok)).toBe(true);
  } finally { await watcher.stop(); await fixture.cleanup(); }
});

test("Watchers detect first worktrees and registration-directory recreation when initially absent", async () => {
  const fixture = await createWorktreeFixture(), observed = changes();
  await fixture.git(fixture.main, ["worktree", "remove", "--force", fixture.feature]);
  const root = join(fixture.repository.id, "worktrees");
  await rm(root, { recursive: true, force: true });
  const initial = expectOk(await discoverRepository(fixture.main));
  const watcher = new RepositoryWatcher(initial, observed.receive, observed.unexpected, { debounceMs: 10 });
  try {
    // Only the parent common-directory watch can observe the first registration directory.
    expectOk(await watcher.start());
    const first = join(fixture.directory, "first"), second = join(fixture.directory, "second");
    await fixture.git(fixture.main, ["worktree", "add", "-b", "feature/first", first]);
    await observed.until(() => observed.includes(first));

    // Replacing the directory must rebind its watch instead of leaving it on the old inode.
    await rename(root, join(fixture.directory, "old-registration-root"));
    await mkdir(root);
    await fixture.git(fixture.main, ["worktree", "add", "-b", "feature/second", second]);
    await observed.until(() => observed.includes(second));

    expect(observed.errors).toEqual([]);
    expect(observed.values.at(-1)?.ok).toBe(true);
  } finally { await watcher.stop(); await fixture.cleanup(); }
});

test("Discovery failures never publish empty lists and recover on subsequent Git events", async () => {
  const fixture = await createWorktreeFixture(), observed = changes();
  let fail = true;
  const watcher = new RepositoryWatcher(fixture.repository, observed.receive, observed.unexpected, { debounceMs: 10,
    discover: (cwd) => fail ? Promise.resolve(err(new GitDiscoveryError("Fixture scan failure"))) : discoverRepository(cwd) });
  try {
    // A failed scan is observable, without replacing the caller's last valid snapshot.
    expectOk(await watcher.start());
    await observed.until(() => observed.values.some((result) => !result.ok));
    expect(observed.values.filter((result) => result.ok)).toEqual([]);

    fail = false;
    await fixture.git(fixture.main, ["switch", "-c", "recovered"]);
    await observed.until(() => observed.values.some((result) => result.ok && result.value.worktrees[0]?.branch === "recovered"));

    expect(observed.errors).toEqual([]);
    expect(observed.values.at(-1)?.ok).toBe(true);
  } finally { await watcher.stop(); await fixture.cleanup(); }
});

test("Events during discovery serialize rescans and disposal suppresses publication", async () => {
  const fixture = await createWorktreeFixture(), observed = changes();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let calls = 0, active = 0, maximum = 0;
  const watcher = new RepositoryWatcher(fixture.repository, observed.receive, observed.unexpected, { debounceMs: 10,
    discover: async (cwd) => {
      calls++; active++; maximum = Math.max(maximum, active);
      if (calls === 1) { entered.resolve(); await release.promise; }
      try { return await discoverRepository(cwd); }
      finally { active--; }
    } });
  try {
    // Hold the initial read while several branch changes invalidate it again.
    expectOk(await watcher.start()); await entered.promise;
    await fixture.git(fixture.main, ["switch", "-c", "during-scan"]);
    release.resolve();
    await observed.until(() => observed.values.some((result) => result.ok && result.value.worktrees[0]?.branch === "during-scan"));
    await watcher.stop();
    const published = observed.values.length;

    // A closed watcher has no timers or callbacks left that can publish later mutations.
    await writeFile(join(fixture.repository.id, "HEAD"), "ref: refs/heads/main\n");
    expect(maximum).toBe(1);
    expect(observed.values).toHaveLength(published);
    expect(observed.errors).toEqual([]);
  } finally { release.resolve(); await watcher.stop(); await fixture.cleanup(); }
});

test("Disposal waits for active Git queries without late updates to closed screens", async () => {
  // The scan has started, but the caller has not yet received its changed metadata.
  const fixture = await createWorktreeFixture(), observed = changes();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const watcher = new RepositoryWatcher(fixture.repository, observed.receive, observed.unexpected, { debounceMs: 10,
    discover: async (cwd) => { entered.resolve(); await release.promise; return discoverRepository(cwd); } });
  try {
    expectOk(await watcher.start()); await entered.promise;
    await fixture.git(fixture.main, ["switch", "-c", "late-result"]);

    // Closing synchronously removes the native watches; stop also drains the outstanding query.
    const stopped = watcher.stop();
    release.resolve(); await stopped;

    expect(observed.values).toEqual([]);
    expect(observed.errors).toEqual([]);
  } finally { release.resolve(); await watcher.stop(); await fixture.cleanup(); }
});
