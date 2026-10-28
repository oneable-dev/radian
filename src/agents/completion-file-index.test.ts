import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as discovery from "./completion-files.ts";
import { mkdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CompletionFileIndex } from "./completion-file-index.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";

async function mount() {
  const fixture = await createWorktreeFixture();
  const listeners = new Set<() => void>();
  const unexpected: unknown[] = [];
  let changes = 0;
  const index = new CompletionFileIndex(
    fixture.main,
    () => {
      changes++;
      for (const listener of listeners) {
        listener();
      }
    },
    (error) => unexpected.push(error),
  );
  const paths = (query = "") => {
    const result = index.read(query);

    return result?.ok ? result.value.items.map((item) => item.value) : [];
  };
  const until = (predicate: () => boolean, label = "file update") =>
    new Promise<void>((resolve, reject) => {
      if (predicate()) {
        resolve();

        return;
      }

      const check = () => {
        if (predicate()) {
          clearTimeout(timer);
          listeners.delete(check);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(
          new Error(
            `File index observation timed out (${label}): ${JSON.stringify(index.read(""))}`,
          ),
        );
      }, 3000);

      listeners.add(check);
    });

  return {
    ...fixture,
    index,
    paths,
    until,
    unexpected,
    changes: () => changes,
    async cleanup() {
      index.dispose();
      listeners.clear();
      await fixture.cleanup();
    },
  };
}

test("File indexes load complete catalogs and search subsequent input without I/O", async () => {
  // Include files beyond the first page and ignored files to detect incomplete caches.
  const app = await mount();
  try {
    await mkdir(join(app.main, "files"));
    await Promise.all(
      Array.from({ length: 160 }, (_, i) =>
        writeFile(join(app.main, "files", `file-${i}.ts`), "fixture"),
      ),
    );
    await writeFile(join(app.main, ".gitignore"), "ignored.ts\n");
    await writeFile(join(app.main, "ignored.ts"), "ignore");

    expectOk(await app.index.refresh());

    const changes = app.changes();
    for (let i = 0; i < 50; i++) {
      expect(app.paths("file-159")).toEqual(["files/file-159.ts"]);
    }

    expect(app.changes()).toBe(changes);
    expect(app.paths("ignored")).toEqual([]);

    const all = app.index.read("");
    if (!all) {
      throw new Error("Index was not initialized");
    }

    expect(expectOk(all).truncated).toBe(true);
    expect(app.unexpected).toEqual([]);
  } finally {
    await app.cleanup();
  }
});

test("File watchers reflect additions, deletions, renames, and directory moves", async () => {
  // Use real OS events without touching UI or user repositories.
  const app = await mount();
  try {
    expectOk(await app.index.refresh());

    // New paths appear; renames and directory moves remove old paths.
    await mkdir(join(app.main, "before"));
    await writeFile(join(app.main, "before", "one.ts"), "one");
    await app.until(() => app.paths("one.ts").includes("before/one.ts"), "create");
    await rename(join(app.main, "before", "one.ts"), join(app.main, "before", "two.ts"));
    await app.until(
      () => app.paths("two.ts").includes("before/two.ts") && !app.paths("one.ts").length,
      "rename file",
    );
    await rename(join(app.main, "before"), join(app.main, "after"));
    await app.until(
      () => app.paths("two.ts").includes("after/two.ts") && !app.paths("before/").length,
      "rename directory",
    );
    await rename(join(app.main, "after", "two.ts"), join(app.feature, "two.ts"));
    await app.until(() => !app.paths("two.ts").length, "move out");
    await rename(join(app.feature, "two.ts"), join(app.main, "returned.ts"));
    await app.until(() => app.paths("returned.ts").includes("returned.ts"), "move in");
    await unlink(join(app.main, "returned.ts"));
    await app.until(() => !app.paths("returned.ts").length, "delete");

    expect(app.paths("workspace.txt")).toEqual(["workspace.txt"]);
    expect(app.unexpected).toEqual([]);
  } finally {
    await app.cleanup();
  }
}, 20000);

test("Ignore and Git index changes resynchronize while retaining tracked ignored files", async () => {
  // Preserve Git tracked/ignore semantics instead of applying naive exclusions.
  const app = await mount();
  try {
    await writeFile(join(app.main, "candidate.ts"), "candidate");
    expectOk(await app.index.refresh());

    // Ignore rules remove candidates, but force-tracked files must reappear.
    await writeFile(join(app.main, ".gitignore"), "candidate.ts\n");
    await app.until(() => !app.paths("candidate.ts").length);
    await app.git(app.main, ["-c", "core.fsmonitor=false", "add", "-f", "candidate.ts"]);
    await app.until(() => app.paths("candidate.ts").includes("candidate.ts"));

    expect(app.unexpected).toEqual([]);
  } finally {
    await app.cleanup();
  }
});

test("Included Git config and symlinked excludes changes trigger resynchronization", async () => {
  // Test the boundary with isolated include files and symlinks, not global user config.
  const app = await mount();
  try {
    const settings = join(app.directory, "included.gitconfig");
    const target = join(app.directory, "actual.ignore");
    const link = join(app.directory, "linked.ignore");

    await writeFile(join(app.main, "conditional.ts"), "file");
    await writeFile(target, "");
    await symlink(target, link);
    await writeFile(settings, `[core]\n\texcludesFile = ${JSON.stringify(link)}\n`);
    await app.git(app.main, ["config", "include.path", settings]);
    expectOk(await app.index.refresh());
    expect(app.paths("conditional.ts")).toEqual(["conditional.ts"]);

    // Detect target content changes even when the symlink name stays unchanged.
    await writeFile(target, "conditional.ts\n");
    await app.until(() => !app.paths("conditional.ts").length, "linked excludes");
    await writeFile(settings, "[core]\n\texcludesFile = /dev/null\n");
    await app.until(
      () => app.paths("conditional.ts").includes("conditional.ts"),
      "included config",
    );

    expect(app.unexpected).toEqual([]);
  } finally {
    await app.cleanup();
  }
});

test("Resynchronization requested during initial scanning runs in the next scan", async () => {
  // Changes arriving after the initial listing must not be lost before completion.
  const app = await mount();
  const scanned = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = discovery.listCompletionFiles;
  let calls = 0;
  const scan = spyOn(discovery, "listCompletionFiles").mockImplementation(async (cwd, signal) => {
    const result = await original(cwd, signal);
    if (++calls === 1) {
      scanned.resolve();
      await release.promise;
    }

    return result;
  });
  try {
    const initial = app.index.refresh();
    await scanned.promise;

    await writeFile(join(app.main, "during-startup.ts"), "new");

    const reload = app.index.refresh();
    release.resolve();
    expectOk(await initial);
    expectOk(await reload);

    expect(app.paths("during-startup")).toEqual(["during-startup.ts"]);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(app.unexpected).toEqual([]);
  } finally {
    release.resolve();
    scan.mockRestore();
    await app.cleanup();
  }
});

test("Watcher errors report failure and recover through reconnection and a full scan", async () => {
  // Inject an OS-boundary error while using real replacement watchers and Git scans.
  const app = await mount();
  const watching = spyOn(fs, "watch");
  try {
    expectOk(await app.index.refresh());

    const root = watching.mock.results[0];
    if (root?.type !== "return") {
      throw new Error("Root watcher was not installed");
    }

    root.value.emit("error", Object.assign(new Error("Fixture watcher failure"), { code: "EIO" }));

    const failed = app.index.read("");
    if (!failed) {
      throw new Error("Watcher failure was hidden as pending");
    }

    expect(expectError(failed).code).toBe("STORAGE_FAILED");
    await app.until(() => app.index.read("")?.ok === true, "watch recovery");

    expect(app.paths("workspace.txt")).toEqual(["workspace.txt"]);
    expect(watching.mock.calls.length).toBeGreaterThan(1);
    expect(app.unexpected).toEqual([]);
  } finally {
    watching.mockRestore();
    await app.cleanup();
  }
});

test("Disposed indexes return cancellation and initial discovery failures remain errors", async () => {
  // Invalid repositories and disposed indexes are not successful empty searches.
  const app = await mount();
  const invalid = new CompletionFileIndex(
    app.directory,
    () => {},
    (error) => app.unexpected.push(error),
  );
  try {
    const failed = await invalid.refresh();
    app.index.dispose();

    expect(expectError(failed).code).toBe("GIT_QUERY_FAILED");

    const result = app.index.read("file");
    if (!result) {
      throw new Error("Closed index returned pending");
    }

    expect(expectError(result).code).toBe("CANCELLED");
    expect(app.unexpected).toEqual([]);
  } finally {
    invalid.dispose();
    await app.cleanup();
  }
});
