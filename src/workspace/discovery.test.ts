import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRepository, GitDiscoveryError, parseWorktrees } from "./discovery.ts";
import { expectOk, expectError } from "../testing/results.ts";

test("NUL records distinguish spaces, newline paths, and detached HEAD", () => {
  // NUL delimiters preserve paths that line-based parsing would corrupt.
  const data = "worktree /tmp/main tree\0HEAD abc\0branch refs/heads/main\0\0"
    + "worktree /tmp/other\nline\0HEAD def\0detached\0\0"
    + "worktree /tmp/bare\0bare\0\0";

  // Only working directories can become selectable worktree entries.
  const trees = parseWorktrees(data);

  // Bare storage is excluded; a detached tree has no invented branch.
  expect(trees.map((tree) => [tree.path, tree.branch])).toEqual([["/tmp/main tree", "main"], ["/tmp/other\nline", null]]);
  expect(trees.every((tree) => tree.sessions.length === 0)).toBe(true);
});

test("Real temporary linked worktrees discover their common repository", async () => {
  // All Git mutation is confined to a repository owned by this test.
  const directory = await mkdtemp(join(tmpdir(), "radian-git-test-"));
  const main = join(directory, "main repository");
  const linked = join(directory, "linked tree");
  async function git(args: string[]): Promise<void> {
    const process = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
    const error = await new Response(process.stderr).text();
    if (await process.exited !== 0) throw new Error(error);
  }
  try {
    await git(["init", "--initial-branch=main", main]);
    await git(["-C", main, "-c", "user.name=Radian Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
    await git(["-C", main, "worktree", "add", "-b", "feature/ui", linked]);

    // Discovery is read-only and starts from the linked worktree, not the main one.
    const repository = expectOk(await discoverRepository(linked));

    // Both worktree branches and their common repository identity are preserved.
    expect(repository.name).toBe("main repository");
    expect(repository.id).toBe(await realpath(join(main, ".git")));
    expect(expectOk(await discoverRepository(main)).id).toBe(repository.id);
    expect(repository.worktrees.map((tree) => tree.branch)).toEqual(["main", "feature/ui"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Non-Git paths return errors instead of empty success", async () => {
  // This temporary directory is deliberately outside any Git repository.
  const directory = await mkdtemp(join(tmpdir(), "radian-no-git-test-"));
  try {
    // The caller can distinguish discovery failure from a repository without worktrees.
    const result = discoverRepository(directory);

    // The app's error boundary receives the original diagnostic.
    expect(expectError(await result)).toBeInstanceOf(GitDiscoveryError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
