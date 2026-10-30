import { basename, dirname, join, resolve } from "node:path";
import { lstat, realpath, stat } from "node:fs/promises";
import type { Repository, Worktree } from "./model.ts";
import { capture, ExpectedError, StorageError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

export function parseWorktrees(porcelain: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let path: string | null = null;
  let branch: string | null = null;
  let bare = false;

  function finish(): void {
    if (path && !bare) {
      worktrees.push({ id: path, path, name: basename(path), branch, sessions: [] });
    }

    path = null;
    branch = null;
    bare = false;
  }

  for (const field of porcelain.split("\0")) {
    if (field === "") {
      finish();
    } else if (field.startsWith("worktree ")) {
      finish();
      path = field.slice("worktree ".length);
    } else if (field.startsWith("branch ")) {
      branch = field.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (field === "bare") {
      bare = true;
    }
  }

  finish();

  return worktrees;
}

export class GitDiscoveryError extends ExpectedError {
  constructor(message: string) {
    super("GIT_DISCOVERY_FAILED", message);
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const process = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) {
    throw new GitDiscoveryError(`Git discovery failed: ${error.trim()}`);
  }

  return output;
}

// A workspace-free launch is valid. Probe ancestor markers without scanning their
// contents; a present but damaged repository still returns its actual Git error.
export async function discoverOptionalRepository(
  cwd: string,
): Promise<Result<Repository | null, ExpectedError>> {
  if (process.env.GIT_DIR) return discoverRepository(cwd);
  const canonical = await capture(() => realpath(cwd));
  if (!canonical.ok) return canonical;
  let directory = canonical.value;
  while (true) {
    const marker = await capture(() => lstat(join(directory, ".git")));
    if (marker.ok) return discoverRepository(canonical.value);
    if (!(marker.error instanceof StorageError) || marker.error.systemCode !== "ENOENT") {
      return marker;
    }
    // Bare repositories and Git administrative directories have HEAD/objects
    // rather than a .git child, but can still own ordinary linked worktrees.
    const head = await capture(() => lstat(join(directory, "HEAD")));
    if (head.ok && (head.value.isFile() || head.value.isSymbolicLink())) {
      const objects = await capture(() => stat(join(directory, "objects")));
      if (objects.ok && objects.value.isDirectory()) return discoverRepository(canonical.value);
      if (
        !objects.ok &&
        (!(objects.error instanceof StorageError) || objects.error.systemCode !== "ENOENT")
      ) {
        return objects;
      }
    } else if (
      !head.ok &&
      (!(head.error instanceof StorageError) || head.error.systemCode !== "ENOENT")
    ) {
      return head;
    }
    const parent = dirname(directory);
    if (parent === directory) return ok(null);
    directory = parent;
  }
}

export async function discoverRepository(cwd: string): Promise<Result<Repository, ExpectedError>> {
  const discovered = await capture(async () => {
    const commonDir = await realpath(
      resolve(cwd, (await git(cwd, ["rev-parse", "--git-common-dir"])).trim()),
    );
    const worktrees = parseWorktrees(await git(cwd, ["worktree", "list", "--porcelain", "-z"]));
    const mainTree = worktrees[0];

    return { id: commonDir, name: mainTree?.name ?? basename(cwd), worktrees };
  });

  return discovered.ok ? ok(discovered.value) : err(discovered.error);
}
