import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { CancelledError, GitError, StorageError, capture, knownError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { filterCompletions, type CompletionResult } from "./completion.ts";

// Query names only, never file contents. Git supplies the selected worktree's ignore/submodule rules.
function fileNames(cwd: string, signal?: AbortSignal): Promise<Result<readonly string[], ExpectedError>> {
  if (signal?.aborted) return Promise.resolve(err(new CancelledError()));
  return new Promise((resolve, reject) => {
    execFile("git", ["--no-pager", "-c", "core.fsmonitor=false", "-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 5000, signal,
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined,
        GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout) => {
      if (error) {
        if (signal?.aborted) { resolve(err(new CancelledError())); return; }
        if (error.killed || typeof error.code === "number" || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve(err(new GitError("GIT_QUERY_FAILED", "File discovery failed or exceeded its 5-second/4 MiB limit; no partial list was used.", { cause: error }))); return;
        }
        const expected = knownError(error);
        if (expected) resolve(err(expected)); else reject(error);
        return;
      }
      const paths = [...new Set(stdout.split("\0").filter(Boolean))];
      resolve(ok(paths));
    });
  });
}

export async function completeFiles(cwd: string, query: string, signal?: AbortSignal): Promise<Result<CompletionResult, ExpectedError>> {
  const listed = await fileNames(cwd, signal); if (!listed.ok) return listed;
  const result = filterCompletions(listed.value.map((value) => ({ kind: "file", value, description: "Worktree file" })), query.replace(/^\.\//u, ""));
  // Check only the bounded candidate page; deleted index paths and gitlink directories are not files to mention.
  const checked = await Promise.all(result.items.map(async (item) => {
    const info = await capture(() => lstat(join(cwd, item.value)));
    if (!info.ok) return info.error instanceof StorageError && ["ENOENT", "ENOTDIR"].includes(info.error.systemCode ?? "") ? ok(null) : info;
    return ok(info.value.isFile() || info.value.isSymbolicLink() ? item : null);
  }));
  if (signal?.aborted) return err(new CancelledError());
  const items = [];
  for (const candidate of checked) { if (!candidate.ok) return candidate; if (candidate.value) items.push(candidate.value); }
  return ok({ items, truncated: result.truncated });
}
