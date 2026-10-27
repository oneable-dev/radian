import { watch, type FSWatcher } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  CancelledError,
  capture,
  knownError,
  StorageError,
  systemCode,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { filterCompletions, type CompletionItem, type CompletionResult } from "./completion.ts";
import { completionGit, listCompletionFiles } from "./completion-files.ts";

// Filesystem notifications are invalidations, not a reliable add/unlink log. Reconcile
// structural changes in batches using Git's existing tracked/ignore/submodule policy.
export class CompletionFileIndex {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly abort = new AbortController();
  private readonly names = new Set<string>();
  private items: readonly CompletionItem[] | undefined;
  private failure: ExpectedError | undefined;
  private pending: Promise<Result<void, ExpectedError>> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = true;
  private force = true;
  private closed = false;
  private metadataReady = false;
  private watchRecoveries = 0;

  constructor(
    readonly cwd: string,
    private readonly changed: () => void,
    private readonly unexpected: (error: unknown) => void,
  ) {}

  read(query: string): Result<CompletionResult, ExpectedError> | undefined {
    if (this.closed) return err(new CancelledError("File index is closed."));
    if (this.failure) return err(this.failure);
    return this.items ? ok(filterCompletions(this.items, query.replace(/^\.\//u, ""))) : undefined;
  }

  refresh(): Promise<Result<void, ExpectedError>> {
    if (this.closed) return Promise.resolve(err(new CancelledError("File index is closed.")));
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.dirty = true;
    this.force = true;
    this.watchRecoveries = 0;
    return this.run();
  }

  private run(): Promise<Result<void, ExpectedError>> {
    if (this.pending) return this.pending;
    const task = this.reconcile().finally(() => {
      this.pending = undefined;
      if (this.dirty && !this.closed) this.invalidate(this.force);
    });
    this.pending = task;
    return task;
  }

  private async reconcile(): Promise<Result<void, ExpectedError>> {
    do {
      this.dirty = false;
      const force = this.force;
      this.force = false;
      const names = [...this.names];
      this.names.clear();
      if (this.closed) return err(new CancelledError());
      // Install before discovery; events observed during the scan cause another pass.
      const root = this.watchDirectory(this.cwd, undefined);
      if (!root.ok) return this.failed(root.error);
      if (force || !this.metadataReady) {
        const metadata = await this.watchMetadata();
        if (!metadata.ok) return this.failed(metadata.error);
      } else if (names.length && names.length <= 256) {
        // Prefix protects literal leading-colon names from Git pathspec interpretation.
        const ignored = await completionGit(
          this.cwd,
          ["check-ignore", "--stdin", "-z"],
          this.abort.signal,
          names.map((name) => `./${name}`).join("\0") + "\0",
          true,
        );
        if (!ignored.ok) return this.failed(ignored.error);
        const excluded = new Set(
          ignored.value
            .split("\0")
            .filter(Boolean)
            .map((name) => name.replace(/^\.\//u, "")),
        );
        if (names.every((name) => excluded.has(name))) continue;
      }
      const files = await listCompletionFiles(this.cwd, this.abort.signal);
      if (this.closed) return err(new CancelledError());
      if (!files.ok) return this.failed(files.error);
      if (!this.metadataReady || !this.watchers.has(this.cwd))
        return this.failed(
          this.failure ??
            new StorageError("File watching stopped during discovery. Use /reload to reconnect."),
        );
      const changed =
        !!this.failure ||
        !this.items ||
        this.items.length !== files.value.length ||
        this.items.some((item, i) => item.value !== files.value[i]);
      if (changed)
        this.items = files.value.map((value) => ({
          kind: "file",
          value,
          description: "Worktree file",
        }));
      this.failure = undefined;
      if (changed) this.changed();
    } while (this.dirty && !this.closed);
    return ok(undefined);
  }

  private failed(error: ExpectedError): Result<never, ExpectedError> {
    // Keep the last good index for recovery, but never present a failed refresh as fresh data.
    if (!this.closed) {
      this.failure = error;
      this.changed();
    }
    return err(error);
  }

  private invalidate(force: boolean, name?: string): void {
    if (this.closed) return;
    this.dirty = true;
    this.force ||= force;
    if (name) this.names.add(name);
    if (this.pending) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run().catch((error) => {
        this.unexpected(error);
      });
    }, 200);
    this.timer.unref();
  }

  private watchDirectory(
    path: string,
    accepted: ReadonlySet<string> | undefined,
  ): Result<void, ExpectedError> {
    if (this.watchers.has(path)) return ok(undefined);
    try {
      const watcher = watch(
        path,
        { recursive: accepted === undefined, persistent: false },
        (event, filename) => {
          if (this.closed) return;
          const name = filename?.toString();
          if (accepted) {
            if (!name || accepted.has(name)) this.invalidate(true);
            return;
          }
          if (!name) {
            this.invalidate(true);
            return;
          }
          const absolute = resolve(this.cwd, name),
            local = relative(this.cwd, absolute);
          if (!local || local === ".." || local.startsWith(".." + sep) || local.includes("\0")) {
            this.invalidate(true);
            return;
          }
          const normalized = local.split(sep).join("/");
          if (normalized === ".git" || normalized.startsWith(".git/")) {
            if ([".git", ".git/index", ".git/config", ".git/info/exclude"].includes(normalized))
              this.invalidate(true);
            return;
          }
          if (basename(normalized) === ".gitignore") this.invalidate(true);
          else if (event === "rename") this.invalidate(false, normalized);
          // Ordinary file-content edits cannot change a path-only completion index.
        },
      );
      watcher.on("error", (error: unknown) => {
        if (this.closed || this.watchers.get(path) !== watcher) return;
        watcher.close();
        this.watchers.delete(path);
        this.metadataReady = false;
        const expected = this.watchError(error);
        if (expected) {
          this.failed(expected);
          // Bound automatic recovery; /reload explicitly grants another attempt.
          if (this.watchRecoveries++ === 0) this.invalidate(true);
        } else this.unexpected(error);
      });
      this.watchers.set(path, watcher);
      return ok(undefined);
    } catch (error) {
      const expected = this.watchError(error);
      if (expected) return err(expected);
      throw error;
    }
  }

  private watchError(error: unknown): ExpectedError | null {
    const known = knownError(error);
    if (known) return known;
    const code = systemCode(error);
    return code &&
      [
        "ENOSYS",
        "ENOTSUP",
        "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
        "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM_VERSION",
      ].includes(code)
      ? new StorageError(`File watching is unavailable (${code}). Use /reload to retry.`, code, {
          cause: error,
        })
      : null;
  }

  private async watchMetadata(): Promise<Result<void, ExpectedError>> {
    const dirs: string[] = [];
    for (const args of [
      ["rev-parse", "--absolute-git-dir"],
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ]) {
      const result = await completionGit(this.cwd, args, this.abort.signal);
      if (!result.ok) return result;
      dirs.push(result.value.replace(/\r?\n$/u, ""));
    }
    const excludes = await completionGit(
      this.cwd,
      ["config", "--null", "--path", "--get", "core.excludesfile"],
      this.abort.signal,
      undefined,
      true,
    );
    if (!excludes.ok) return excludes;
    // --name-only avoids reading credential/configuration values into the index.
    const origins = await completionGit(
      this.cwd,
      ["config", "--null", "--show-origin", "--name-only", "--list"],
      this.abort.signal,
    );
    if (!origins.ok) return origins;
    const originParts = origins.value.split("\0"),
      included: string[] = [];
    for (let i = 0; i < originParts.length; i += 2)
      if (originParts[i]?.startsWith("file:")) included.push(originParts[i]!.slice(5));
    const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    const files = [
      ...included,
      process.env.GIT_CONFIG_GLOBAL ?? join(homedir(), ".gitconfig"),
      join(configHome, "git", "config"),
      resolve(this.cwd, excludes.value.split("\0")[0] || join(configHome, "git", "ignore")),
      ...dirs.flatMap((dir) => [
        join(dir, "index"),
        join(dir, "config"),
        join(dir, "info", "exclude"),
      ]),
    ];
    const expanded = new Set<string>();
    for (const file of files.filter(Boolean)) {
      const path = resolve(this.cwd, file),
        info = await capture(() => lstat(path));
      if (
        !info.ok &&
        !(
          info.error instanceof StorageError &&
          ["ENOENT", "ENOTDIR"].includes(info.error.systemCode ?? "")
        )
      )
        return info;
      if (info.ok && !info.value.isFile() && !info.value.isSymbolicLink()) continue; // e.g. GIT_CONFIG_GLOBAL=/dev/null
      expanded.add(path);
      if (info.ok && info.value.isSymbolicLink()) {
        const target = await capture(() => realpath(path));
        if (target.ok) expanded.add(target.value);
        else if (
          !(
            target.error instanceof StorageError &&
            ["ENOENT", "ENOTDIR"].includes(target.error.systemCode ?? "")
          )
        )
          return target;
      }
    }
    const wanted = new Map<string, Set<string>>();
    for (const file of expanded) {
      let parent = dirname(file),
        name = basename(file);
      while (true) {
        const info = await capture(() => stat(parent));
        if (info.ok && info.value.isDirectory()) break;
        if (
          !info.ok &&
          !(
            info.error instanceof StorageError &&
            ["ENOENT", "ENOTDIR"].includes(info.error.systemCode ?? "")
          )
        )
          return info;
        name = basename(parent);
        parent = dirname(parent);
      }
      const names = wanted.get(parent) ?? new Set<string>();
      names.add(name);
      wanted.set(parent, names);
    }
    if (this.closed) return err(new CancelledError());
    for (const [path, watcher] of this.watchers) {
      if (path === this.cwd) continue;
      watcher.close();
      this.watchers.delete(path);
    }
    for (const [path, names] of wanted) {
      const watched = this.watchDirectory(path, names);
      if (!watched.ok) return watched;
    }
    this.metadataReady = true;
    return ok(undefined);
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.names.clear();
  }
}
