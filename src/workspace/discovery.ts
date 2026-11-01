import { basename, dirname, join, resolve } from "node:path";
import { lstat, realpath, stat } from "node:fs/promises";
import type { Repository, Worktree } from "./model.ts";
import { capture, ExpectedError, StorageError, systemCode } from "../errors.ts";
import { ok, type Result } from "../result.ts";

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

/** The first `git worktree list` entry: the main checkout, or the repository itself when bare. */
export type MainWorktree = { readonly path: string; readonly bare: boolean };

export function parseMainWorktree(porcelain: string): MainWorktree | null {
  let path: string | null = null;
  let bare = false;
  for (const field of porcelain.split("\0")) {
    if (field === "") {
      break;
    } else if (field.startsWith("worktree ")) {
      if (path !== null) {
        break;
      }

      path = field.slice("worktree ".length);
    } else if (field === "bare") {
      bare = true;
    }
  }

  return path === null ? null : { path, bare };
}

export class GitDiscoveryError extends ExpectedError<"GIT_DISCOVERY_FAILED"> {
  constructor(message: string, options?: ErrorOptions) {
    super("GIT_DISCOVERY_FAILED", message, options);
  }
}

// Only these codes prove that a path is absent; permission and I/O failures remain errors.
export function isMissingPath(error: ExpectedError): boolean {
  return (
    error instanceof StorageError &&
    (error.systemCode === "ENOENT" || error.systemCode === "ENOTDIR")
  );
}

async function git(cwd: string, args: string[]): Promise<string> {
  let process: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    process = Bun.spawn(["git", "-C", cwd, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    // A missing Git executable must not look like a missing repository path.
    if (systemCode(error)) {
      throw new GitDiscoveryError("Git could not be started.", { cause: error });
    }

    throw error;
  }

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

/**
 * Reads which directory is the repository root besides the common Git directory.
 * Bare repositories report the common directory itself; separate-git-dir checkouts report
 * their external main checkout. Git failures stay errors; they never imply absence.
 */
export async function readMainWorktree(
  commonDir: string,
): Promise<Result<MainWorktree | null, ExpectedError>> {
  return capture(async () =>
    parseMainWorktree(await git(commonDir, ["worktree", "list", "--porcelain", "-z"])),
  );
}

// Git keeps registrations for checkouts deleted outside Git (and also reports inaccessible
// ones as prunable), so presence is decided by the checkout directory itself. The `.git`
// marker is not required: GIT_DIR/core.worktree checkouts legitimately have none.
async function presentWorktrees(
  worktrees: readonly Worktree[],
): Promise<Result<Worktree[], ExpectedError>> {
  const present: Worktree[] = [];
  for (const tree of worktrees) {
    const checkout = await capture(() => stat(tree.path));
    if (checkout.ok) {
      present.push(tree);
    } else if (!isMissingPath(checkout.error)) {
      return checkout;
    }
  }

  return ok(present);
}

export async function discoverRepository(cwd: string): Promise<Result<Repository, ExpectedError>> {
  const discovered = await capture(async () => {
    const commonDir = await realpath(
      resolve(cwd, (await git(cwd, ["rev-parse", "--git-common-dir"])).trim()),
    );
    const worktrees = parseWorktrees(await git(cwd, ["worktree", "list", "--porcelain", "-z"]));
    const mainTree = worktrees[0];

    return { commonDir, name: mainTree?.name ?? basename(cwd), worktrees };
  });
  if (!discovered.ok) {
    return discovered;
  }

  const present = await presentWorktrees(discovered.value.worktrees);
  if (!present.ok) {
    return present;
  }

  const { commonDir, name } = discovered.value;

  return ok({ id: commonDir, name, worktrees: present.value });
}

/**
 * Re-reads a known repository or worktree path from the filesystem and Git.
 *
 * `ok(null)` means the path itself is confirmed absent (ENOENT/ENOTDIR). Permission,
 * I/O and Git failures, including a present but corrupted repository, stay errors so
 * callers can retain their previous state instead of treating the repository as deleted.
 */
export async function probeRepository(
  cwd: string,
): Promise<Result<Repository | null, ExpectedError>> {
  const before = await capture(() => stat(cwd));
  if (!before.ok) {
    return isMissingPath(before.error) ? ok(null) : before;
  }

  const discovered = await discoverRepository(cwd);
  if (discovered.ok) {
    return discovered;
  }

  // Git cannot start in a directory removed during the query; confirm that by path, not message.
  const after = await capture(() => stat(cwd));
  if (!after.ok && isMissingPath(after.error)) {
    return ok(null);
  }

  return discovered;
}
