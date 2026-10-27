import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  CancelledError,
  GitError,
  StorageError,
  capture,
  knownError,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { filterCompletions, type CompletionResult } from "./completion.ts";

// Used only to initialize/reconcile the UI index, never for each cached query.
export function completionGit(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
  input?: string,
  allowNoMatch = false,
): Promise<Result<string, ExpectedError>> {
  if (signal?.aborted) return Promise.resolve(err(new CancelledError()));
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["--no-pager", "-c", "core.fsmonitor=false", "-C", cwd, ...args],
      {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 5000,
        signal,
        env: {
          ...process.env,
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          GIT_INDEX_FILE: undefined,
          GIT_COMMON_DIR: undefined,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout) => {
        if (signal?.aborted) {
          resolve(err(new CancelledError()));
          return;
        }
        if (error && !(allowNoMatch && error.code === 1)) {
          if (
            error.killed ||
            typeof error.code === "number" ||
            error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          ) {
            resolve(
              err(
                new GitError(
                  "GIT_QUERY_FAILED",
                  "File discovery failed or exceeded its 5-second/4 MiB limit; no partial list was used.",
                  { cause: error },
                ),
              ),
            );
            return;
          }
          const expected = knownError(error);
          if (expected) resolve(err(expected));
          else reject(error);
          return;
        }
        resolve(ok(stdout));
      },
    );
    if (input !== undefined) {
      child.stdin?.on("error", (error: unknown) => {
        // Git's exit callback owns a closed stdin; unrelated failures keep their original stack.
        if (!(error instanceof Error && "code" in error && error.code === "EPIPE")) reject(error);
      });
      child.stdin?.end(input);
    }
  });
}

async function fileNames(
  cwd: string,
  signal?: AbortSignal,
): Promise<Result<readonly string[], ExpectedError>> {
  const result = await completionGit(
    cwd,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    signal,
  );
  return result.ok ? ok([...new Set(result.value.split("\0").filter(Boolean))]) : result;
}

export async function listCompletionFiles(
  cwd: string,
  signal?: AbortSignal,
): Promise<Result<readonly string[], ExpectedError>> {
  const listed = await fileNames(cwd, signal);
  if (!listed.ok) return listed;
  const present = new Set<string>();
  let cursor = 0,
    failure: ExpectedError | undefined;
  await Promise.all(
    Array.from({ length: Math.min(16, listed.value.length) }, async () => {
      while (cursor < listed.value.length && !signal?.aborted && !failure) {
        const path = listed.value[cursor++]!;
        const info = await capture(() => lstat(join(cwd, path)));
        if (!info.ok) {
          if (
            !(
              info.error instanceof StorageError &&
              ["ENOENT", "ENOTDIR"].includes(info.error.systemCode ?? "")
            )
          )
            failure = info.error;
        } else if (info.value.isFile() || info.value.isSymbolicLink()) present.add(path);
      }
    }),
  );
  return signal?.aborted
    ? err(new CancelledError())
    : failure
      ? err(failure)
      : ok([...present].sort());
}

export async function completeFiles(
  cwd: string,
  query: string,
  signal?: AbortSignal,
): Promise<Result<CompletionResult, ExpectedError>> {
  const listed = await fileNames(cwd, signal);
  if (!listed.ok) return listed;
  const result = filterCompletions(
    listed.value.map((value) => ({ kind: "file", value, description: "Worktree file" })),
    query.replace(/^\.\//u, ""),
  );
  // Check only the bounded candidate page; deleted index paths and gitlink directories are not files to mention.
  const checked = await Promise.all(
    result.items.map(async (item) => {
      const info = await capture(() => lstat(join(cwd, item.value)));
      if (!info.ok)
        return info.error instanceof StorageError &&
          ["ENOENT", "ENOTDIR"].includes(info.error.systemCode ?? "")
          ? ok(null)
          : info;
      return ok(info.value.isFile() || info.value.isSymbolicLink() ? item : null);
    }),
  );
  if (signal?.aborted) return err(new CancelledError());
  const items = [];
  for (const candidate of checked) {
    if (!candidate.ok) return candidate;
    if (candidate.value) items.push(candidate.value);
  }
  return ok({ items, truncated: result.truncated });
}
