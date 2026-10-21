import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { CancelledError, capture, GitError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { GitCommit, GitComparison, GitDetails, GitFile, GitRef, GitReflog, GitSnapshot, GitSource } from "./model.ts";

const maxOutput = 4 * 1024 * 1024;
export const maxPreviewBytes = 1024 * 1024;
export const maxPreviewLines = 20000;
const protocol = (message: string) => err(new GitError("GIT_PROTOCOL_ERROR", message));
const unavailable = (message: string) => err(new GitError("GIT_PREVIEW_UNAVAILABLE", message));
const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function parseCommits(output: string): Result<GitCommit[], GitError> {
  if (!output) return ok([]);
  const fields = output.split("\0");
  if (fields.pop() !== "" || fields.length % 5) return protocol("Malformed Git log records.");
  const commits: GitCommit[] = [];
  for (let i = 0; i < fields.length; i += 5) {
    const [oid, parents, subject, author, date] = fields.slice(i, i + 5) as [string, string, string, string, string];
    if (!oidPattern.test(oid)) return protocol("Malformed commit identity.");
    commits.push({ oid, parents: parents ? parents.split(" ") : [], subject, author, date });
  }
  return ok(commits);
}

function parseRefs(output: string): Result<GitRef[], GitError> {
  const refs: GitRef[] = [];
  for (const line of output.split("\n").filter(Boolean)) {
    const [ref, direct, peeled] = line.split("\0");
    if (!ref || !direct) return protocol("Malformed Git reference.");
    const kind = ref.startsWith("refs/heads/") ? "local" : ref.startsWith("refs/remotes/") ? "remote" : "tag";
    const name = ref.replace(/^refs\/(heads|remotes|tags)\//, "");
    if (kind === "remote" && name.endsWith("/HEAD")) continue;
    refs.push({ kind, name, ref, oid: peeled || direct });
  }
  return ok(refs);
}

export function parseStatus(output: string): Result<GitFile[], GitError> {
  const records = output.split("\0");
  const files: GitFile[] = [];
  if (records.pop() !== "") return protocol("Unterminated Git status record.");
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.length < 4 || record[2] !== " ") return protocol("Malformed Git status record.");
    const x = record[0]!, y = record[1]!, path = record.slice(3);
    const conflicted = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(x + y);
    let originalPath: string | undefined;
    if (/[RC]/.test(x + y)) { originalPath = records[++i]; if (!originalPath) return protocol("Missing rename source."); }
    if (x === "?") files.push({ kind: "untracked", status: "?", path });
    else {
      if (x !== " ") files.push({ kind: "staged", status: x, path, ...(originalPath ? { originalPath } : {}), ...(conflicted ? { conflicted: true } : {}) });
      if (y !== " ") files.push({ kind: "unstaged", status: y, path, ...(originalPath ? { originalPath } : {}), ...(conflicted ? { conflicted: true } : {}) });
    }
  }
  return ok(files);
}

function parseFiles(output: string, commit: GitCommit): Result<GitFile[], GitError> {
  const fields = output.split("\0");
  if (fields.pop() !== "") return protocol("Unterminated changed-file record.");
  const files: GitFile[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++], first = fields[i++];
    if (!status || !/^[AMDRCTUXB][0-9]*$/.test(status) || !first) return protocol("Malformed changed-file record.");
    const renamed = /^[RC]/.test(status);
    const path = renamed ? fields[i++] : first;
    if (!path) return protocol("Missing changed-file path.");
    files.push({ kind: "commit", status: status[0]!, path, commit, ...(renamed ? { originalPath: first } : {}) });
  }
  return ok(files);
}

export class GitRepository implements GitSource {
  constructor(private readonly cwd: string) {}

  private async run(args: string[], signal: AbortSignal, allowedCodes: readonly number[] = [0]): Promise<Result<string, ExpectedError>> {
    if (signal.aborted) return err(new CancelledError());
    const started = await capture(async () => Bun.spawn(["git", "--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-C", this.cwd, ...args], {
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined,
        GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }, stdout: "pipe", stderr: "pipe", stdin: "ignore",
    }));
    if (!started.ok) return started;
    const child = started.value;
    let failure: ExpectedError | undefined;
    const cancel = () => { failure ??= new CancelledError(); child.kill(); };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const timer = setTimeout(() => { failure ??= new GitError("GIT_QUERY_FAILED", "Git query timed out."); child.kill(); }, 10000);
    const collect = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.byteLength;
        if (size > maxOutput) { failure ??= new GitError("GIT_PREVIEW_UNAVAILABLE", "Git output exceeds the display limit; no partial result was used."); child.kill(); }
        else chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString("utf8");
    };
    try {
      const collected = await capture(async () => Promise.all([collect(child.stdout), collect(child.stderr), child.exited]));
      if (!collected.ok) return collected;
      const [stdout, stderr, code] = collected.value;
      if (failure) return err(failure);
      return allowedCodes.includes(code) ? ok(stdout) : err(new GitError("GIT_QUERY_FAILED", `Git ${args[0]} failed (${code}): ${stderr.trim()}`));
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", cancel);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await child.exited;
    }
  }

  async load(reference: string | null, limit: number, signal: AbortSignal): Promise<Result<GitSnapshot, ExpectedError>> {
    const head = await this.run(["rev-parse", "--verify", "--quiet", "HEAD"], signal, [0, 1]);
    if (!head.ok) return head;
    const headOid = head.value.trim() || null;
    const results = await Promise.all([
      this.run(["log", "-z", "--topo-order", "--no-show-signature", "-n", String(Math.max(1, Math.min(3000, limit))),
        "--format=%H%x00%P%x00%s%x00%an%x00%aI", ...(reference ? ["--end-of-options", reference] : ["--all"])], signal),
      this.run(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(*objectname)", "refs/heads", "refs/remotes", "refs/tags"], signal),
      this.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal),
      headOid ? this.run(["reflog", "show", "-z", "-n", "100", "--format=%H%x00%gd%x00%gs%x00%ci"], signal) : Promise.resolve(ok("")),
      this.run(["symbolic-ref", "--quiet", "--short", "HEAD"], signal, [0, 1]),
    ]);
    for (const result of results) if (!result.ok) return result;
    const [log, references, status, events, branch] = results.map((result) => result.ok ? result.value : "");
    const commits = parseCommits(log!); if (!commits.ok) return commits;
    const files = parseStatus(status!); if (!files.ok) return files;
    const refs = parseRefs(references!); if (!refs.ok) return refs;
    const reflog: GitReflog[] = [];
    if (events) {
      const fields = events.split("\0");
      if (fields.pop() !== "" || fields.length % 4) return protocol("Malformed reflog records.");
      for (let i = 0; i < fields.length; i += 4) reflog.push({ oid: fields[i]!, selector: fields[i + 1]!, subject: fields[i + 2]!, date: fields[i + 3]! });
    }
    return ok({ commits: commits.value, refs: refs.value, files: files.value, reflog, head: branch!.trim(), headOid });
  }

  async details(commit: GitCommit, signal: AbortSignal): Promise<Result<GitDetails, ExpectedError>> {
    if (!oidPattern.test(commit.oid)) return protocol("Invalid commit identity.");
    const [message, names, references] = await Promise.all([
      this.run(["show", "--no-show-signature", "-s", "--format=%B", commit.oid], signal),
      this.run(commit.parents[0] ? ["diff", "--no-ext-diff", "--name-status", "-z", "--find-renames", commit.parents[0], commit.oid, "--"]
        : ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", "--find-renames", commit.oid, "--"], signal),
      this.run(["for-each-ref", `--contains=${commit.oid}`, "--format=%(refname)%00%(objectname)%00%(*objectname)", "refs/heads", "refs/remotes"], signal),
    ]);
    if (!message.ok) return message; if (!names.ok) return names; if (!references.ok) return references;
    const files = parseFiles(names.value, commit); if (!files.ok) return files;
    const branches = parseRefs(references.value); if (!branches.ok) return branches;
    return ok({ commit, message: message.value, files: files.value, branches: branches.value });
  }

  async compare(file: GitFile, signal: AbortSignal): Promise<Result<GitComparison, ExpectedError>> {
    if (file.conflicted || /[U]/.test(file.status)) return unavailable("Unmerged file: three-way conflict resolution is not supported.");
    const added = file.status === "A" || file.kind === "untracked";
    const deleted = file.status === "D";
    const base = file.kind === "commit" ? file.commit?.parents[0] ?? "empty" : file.kind === "staged" ? "HEAD" : "";
    const next = file.kind === "commit" ? file.commit?.oid : file.kind === "staged" ? "" : "worktree";
    if (next === undefined) return protocol("Missing comparison commit.");
    // A staged rename followed by an unstaged edit compares index:new, not index:old.
    const oldPath = file.kind === "unstaged" && !/[RC]/.test(file.status) ? file.path : file.originalPath ?? file.path;
    const beforeRevision = added ? "empty" : base;
    const afterRevision = deleted ? "empty" : next;
    const [before, after] = await Promise.all([
      this.content(beforeRevision, oldPath, signal), this.content(afterRevision, file.path, signal),
    ]);
    if (!before.ok) return before; if (!after.ok) return after;
    if ((before.value.match(/\n/g)?.length ?? 0) + (after.value.match(/\n/g)?.length ?? 0) > maxPreviewLines) return unavailable(`File exceeds the ${maxPreviewLines}-line comparison limit; no partial file was displayed.`);
    if (before.value.includes("\0") || after.value.includes("\0")) return unavailable("Binary file: text comparison unavailable.");
    return ok({ before: before.value, after: after.value,
      beforeLabel: `${beforeRevision || "index"}:${oldPath}`, afterLabel: `${afterRevision || "index"}:${file.path}` });
  }

  private async content(revision: string, path: string, signal: AbortSignal): Promise<Result<string, ExpectedError>> {
    if (!path || isAbsolute(path) || path.split("/").includes("..") || path.includes("\0")) return protocol("Unsafe file path.");
    if (revision === "empty") return ok("");
    if (signal.aborted) return err(new CancelledError());
    if (revision === "worktree") {
      return capture(async () => {
        const location = join(this.cwd, path);
        const info = await lstat(location);
        if (info.isSymbolicLink()) return readlink(location);
        if (!info.isFile()) throw new GitError("GIT_PREVIEW_UNAVAILABLE", "Non-file change: text comparison unavailable.");
        const handle = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const buffer = Buffer.alloc(maxPreviewBytes + 1);
          let size = 0;
          while (size < buffer.length) {
            if (signal.aborted) throw new CancelledError();
            const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
            if (!bytesRead) break;
            size += bytesRead;
          }
          if (size > maxPreviewBytes) throw new GitError("GIT_PREVIEW_UNAVAILABLE", "File exceeds the 1 MiB preview limit; no partial file was displayed.");
          return buffer.subarray(0, size).toString("utf8");
        } finally { await handle.close(); }
      });
    }
    const spec = `${revision}:${path}`;
    const size = await this.run(["cat-file", "-s", spec], signal); if (!size.ok) return size;
    const bytes = Number(size.value.trim());
    if (!Number.isSafeInteger(bytes) || bytes < 0) return protocol("Malformed Git blob size.");
    if (bytes > maxPreviewBytes) return unavailable("File exceeds the 1 MiB preview limit; no partial file was displayed.");
    const type = await this.run(["cat-file", "-t", spec], signal); if (!type.ok) return type;
    if (type.value.trim() !== "blob") return unavailable("Non-blob change (for example a gitlink): text comparison unavailable.");
    return this.run(["show", "--no-ext-diff", "--no-textconv", spec], signal);
  }
}
