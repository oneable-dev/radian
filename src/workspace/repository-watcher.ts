import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { capture, knownError, StorageError, systemCode, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { discoverRepository } from "./discovery.ts";
import type { Repository } from "./model.ts";

type WatchedDirectory = { watcher: FSWatcher; identity: string };

type Options = { debounceMs?: number; discover?: typeof discoverRepository };

function metadata(repository: Repository): string {
  return JSON.stringify([
    repository.id,
    repository.name,
    repository.worktrees.map(({ id, path, name, branch }) => [id, path, name, branch]),
  ]);
}

// Filesystem events invalidate the catalog; only Git determines its actual contents.
export class RepositoryWatcher {
  private readonly directories = new Map<string, WatchedDirectory>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  private dirty = false;
  private closed = false;
  private failed = false;
  private previous: string;

  constructor(
    private readonly repository: Repository,
    private readonly receive: (result: Result<Repository, ExpectedError>) => void,
    private readonly unexpected: (error: unknown) => void,
    private readonly options: Options = {},
  ) {
    this.previous = metadata(repository);
  }

  async start(): Promise<Result<void, ExpectedError>> {
    const watched = await this.syncDirectories();
    if (watched.ok) {
      this.request();
    } // Cover changes between initial discovery and watcher installation.
    else {
      this.failed = true;
    }

    return watched;
  }

  private request(): void {
    if (this.closed) {
      return;
    }

    this.dirty = true;
    if (this.pending) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.closed) {
        return;
      }

      this.pending = this.refresh().finally(() => {
        this.pending = undefined;
        if (this.dirty) {
          this.request();
        }
      });
      void this.pending.catch((error: unknown) => {
        this.failed = true;
        this.unexpected(error);
      });
    }, this.options.debounceMs ?? 250);
    this.timer.unref();
  }

  private async refresh(): Promise<void> {
    this.dirty = false;

    const watched = await this.syncDirectories();
    if (this.closed) {
      return;
    }
    if (!watched.ok) {
      this.publish(watched);

      return;
    }

    // The canonical common directory remains usable if the launching linked worktree is removed.
    const discovered = await (this.options.discover ?? discoverRepository)(this.repository.id);
    if (this.closed) {
      return;
    }
    if (!discovered.ok) {
      this.publish(discovered);

      return;
    }

    const current = metadata(discovered.value);
    if (this.failed || current !== this.previous) {
      this.previous = current;
      this.publish(discovered);
    }
  }

  private publish(result: Result<Repository, ExpectedError>): void {
    this.failed = !result.ok;
    this.receive(result);
  }

  private async syncDirectories(): Promise<Result<void, ExpectedError>> {
    const root = join(this.repository.id, "worktrees");
    const entries = await capture(() => readdir(root, { withFileTypes: true }));
    if (
      !entries.ok &&
      !(entries.error instanceof StorageError && entries.error.systemCode === "ENOENT")
    ) {
      return entries;
    }

    const paths = [
      this.repository.id,
      ...(entries.ok
        ? [
            root,
            ...entries.value
              .filter((entry) => entry.isDirectory())
              .map((entry) => join(root, entry.name)),
          ]
        : []),
    ];
    const wanted = new Set(paths);
    for (const [path, watched] of this.directories) {
      if (wanted.has(path)) {
        continue;
      }

      watched.watcher.close();
      this.directories.delete(path);
    }
    for (const path of paths) {
      if (this.closed) {
        return ok(undefined);
      }

      const info = await capture(() => stat(path));
      if (!info.ok) {
        // Worktree registrations may disappear while Git is removing them. The parent watcher retries.
        if (
          path !== this.repository.id &&
          info.error instanceof StorageError &&
          info.error.systemCode === "ENOENT"
        ) {
          this.directories.get(path)?.watcher.close();
          this.directories.delete(path);
          continue;
        }

        return info;
      }
      if (this.closed) {
        return ok(undefined);
      }

      const identity = `${info.value.dev}:${info.value.ino}`;
      const existing = this.directories.get(path);
      if (existing?.identity === identity) {
        continue;
      }

      existing?.watcher.close();
      this.directories.delete(path);

      const watched = this.watchDirectory(path, root);
      if (!watched.ok) {
        return watched;
      }

      this.directories.set(path, { watcher: watched.value, identity });
    }

    return ok(undefined);
  }

  private watchDirectory(path: string, root: string): Result<FSWatcher, ExpectedError> {
    try {
      const watcher = watch(path, { persistent: false }, (_event, filename) => {
        // Ignore index/ref/object churn: only catalog/branch metadata needs rediscovery.
        const name = filename?.toString();
        if (
          !name ||
          path === root ||
          (path === this.repository.id
            ? name === "worktrees" || name === "HEAD"
            : name === "HEAD" || name === "gitdir" || name === "commondir")
        ) {
          this.request();
        }
      });
      watcher.on("error", (error: unknown) => {
        if (this.closed) {
          return;
        }

        watcher.close();
        if (this.directories.get(path)?.watcher === watcher) {
          this.directories.delete(path);
        }

        const expected = this.watchError(error);
        if (expected) {
          this.publish(err(expected));
        } else {
          this.unexpected(error);
        }

        this.request();
      });

      return ok(watcher);
    } catch (error) {
      const expected = this.watchError(error);
      if (expected) {
        return err(expected);
      }

      throw error;
    }
  }

  private watchError(error: unknown): ExpectedError | null {
    const known = knownError(error);
    if (known) {
      return known;
    }

    const code = systemCode(error);

    return code && ["ENOSYS", "ENOTSUP", "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"].includes(code)
      ? new StorageError(`Git metadata watching is unavailable (${code}).`, code, { cause: error })
      : null;
  }

  close(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    for (const { watcher } of this.directories.values()) {
      watcher.close();
    }

    this.directories.clear();
  }

  async stop(): Promise<void> {
    this.close();
    await this.pending;
  }
}
