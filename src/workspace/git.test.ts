import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRepository, GitDiscoveryError, parseWorktrees } from "./git.ts";

test("NUL 형식은 공백과 개행 경로 및 detached HEAD를 구분한다", () => {
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

test("실제 임시 Git 레포의 linked worktree에서 공통 레포를 찾는다", async () => {
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
    const repository = await discoverRepository(linked);

    // Both worktree branches and their common repository identity are preserved.
    expect(repository.name).toBe("main repository");
    expect(repository.id).toBe(await realpath(join(main, ".git")));
    expect((await discoverRepository(main)).id).toBe(repository.id);
    expect(repository.worktrees.map((tree) => tree.branch)).toEqual(["main", "feature/ui"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Git 레포가 아닌 경로의 오류를 빈 성공 결과로 숨기지 않는다", async () => {
  // This temporary directory is deliberately outside any Git repository.
  const directory = await mkdtemp(join(tmpdir(), "radian-no-git-test-"));
  try {
    // The caller can distinguish discovery failure from a repository without worktrees.
    const result = discoverRepository(directory);

    // The app's error boundary receives the original diagnostic.
    await expect(result).rejects.toBeInstanceOf(GitDiscoveryError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
