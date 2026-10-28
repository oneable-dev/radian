import { basename, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import type { Repository, Worktree } from "./model.ts";
import { capture, ExpectedError } from "../errors.ts";
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
