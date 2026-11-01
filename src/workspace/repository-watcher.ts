import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { capture, knownError, StorageError, systemCode, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { DeletionTracker } from "./deletion.ts";
import { isMissingPath, probeRepository } from "./discovery.ts";
import type { Repository } from "./model.ts";

type WatchedDirectory = { watcher: FSWatcher; identity: string };

type Options = {
  debounceMs?: number;
  probe?: typeof probeRepository;
  /**
   * Caller-owned positive deletion evidence. The watcher drains it on every invalidation,
   * before any probe or watch failure can end the refresh, and re-tracks it from each
   * available snapshot. The watcher never closes it, so evidence survives watcher handoff.
   * Its failures stay inside the tracker (`lastError()`) and never change availability.
   */
  deletion?: DeletionTracker;
};

/**
 * Published availability of the watched repository:
 * - `ok(repository)`: available, either changed or recovered/reappeared;
 * - `ok(null)`: confirmed missing from the filesystem;
 * - `err(error)`: a real failure; callers keep their previous contents.
 */
export type RepositoryAvailability = Result<Repository | null, ExpectedError>;

const missing = "missing";

function metadata(repository: Repository | null): string {
  if (!repository) {
    return missing;
  }

  return JSON.stringify([
    repository.id,
    repository.name,
    repository.worktrees.map(({ id, path, name, branch }) => [id, path, name, branch]),
  ]);
}

// Filesystem events invalidate the catalog; only the filesystem and Git determine its contents.
// Besides Git metadata directories, each checkout and the common directory are observed through
// the nearest existing ancestor, filtered to the single child name leading to it. That detects
// repository deletion, reappearance and externally removed linked checkouts without polling or
// recursive watches.
export class RepositoryWatcher {
  private readonly directories = new Map<string, WatchedDirectory>();
  private anchors = new Map<string, ReadonlySet<string>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  private dirty = false;
  private closed = false;
  private failed = false;
  private previous: string;
  // The last available snapshot keeps its checkouts observed while the repository is missing.
  private known: Repository;

  constructor(
    private readonly repository: Repository,
    private readonly receive: (result: RepositoryAvailability) => void,
    private readonly unexpected: (error: unknown) => void,
    private readonly options: Options = {},
  ) {
    this.previous = metadata(repository);
    this.known = repository;
  }

  async start(): Promise<Result<void, ExpectedError>> {
    // Hold scope descriptors before watches exist, so a deletion racing installation is captured.
    await this.options.deletion?.track(this.repository);
    const syncing = this.syncDirectories();
    // Events arriving while the initial watches are installed coalesce into the first refresh.
    this.pending = syncing.then(
      () => undefined,
      () => undefined,
    );

    let watched: Result<void, ExpectedError>;
    try {
      watched = await syncing;
    } finally {
      this.pending = undefined;
    }
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

      this.pending = this.refresh()
        .catch((error: unknown) => {
          this.failed = true;
          if (!this.closed) {
            this.unexpected(error);
          }
        })
        .finally(() => {
          this.pending = undefined;
          if (this.dirty) {
            this.request();
          }
        });
    }, this.options.debounceMs ?? 250);
    this.timer.unref();
  }

  private async refresh(): Promise<void> {
    this.dirty = false;
    // Kernel unlink reports are captured independently of whether metadata can still be read.
    this.options.deletion?.collect();

    const watched = await this.syncDirectories();
    if (this.closed) {
      return;
    }
    if (!watched.ok) {
      this.publish(watched);

      return;
    }

    // The canonical common directory remains usable if the launching linked worktree is removed.
    const probed = await (this.options.probe ?? probeRepository)(this.repository.id);
    if (this.closed) {
      return;
    }
    if (!probed.ok) {
      this.publish(probed);

      return;
    }

    const current = metadata(probed.value);
    if (this.failed || current !== this.previous) {
      this.previous = current;
      this.publish(probed);
    }
    if (!probed.value) {
      return;
    }

    this.known = probed.value;
    await this.options.deletion?.track(probed.value);
    if (this.closed) {
      return;
    }
    // A reappeared repository may report checkouts that the previous sync could not anchor.
    if (this.anchorsOutdated(probed.value)) {
      const resynced = await this.syncDirectories();
      if (!resynced.ok) {
        this.publish(resynced);
      }
    }
  }

  private publish(result: RepositoryAvailability): void {
    if (this.closed) {
      return;
    }

    this.failed = !result.ok;
    this.receive(result);
  }

  private anchorsOutdated(repository: Repository): boolean {
    const anchored = new Set(
      [...this.anchors].flatMap(([path, names]) => [...names].map((name) => join(path, name))),
    );

    return repository.worktrees.some((tree) => !anchored.has(tree.path));
  }

  // Git metadata directories to watch, and linked checkouts registered there.
  private async metadataDirectories(): Promise<
    Result<{ directories: string[]; checkouts: string[] }, ExpectedError>
  > {
    const common = await capture(() => stat(this.repository.id));
    if (!common.ok) {
      return isMissingPath(common.error) ? ok({ directories: [], checkouts: [] }) : common;
    }

    const root = join(this.repository.id, "worktrees");
    const entries = await capture(() => readdir(root, { withFileTypes: true }));
    if (!entries.ok) {
      return isMissingPath(entries.error)
        ? ok({ directories: [this.repository.id], checkouts: [] })
        : entries;
    }

    const registrations = entries.value
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
    const checkouts: string[] = [];
    for (const registration of registrations) {
      // `gitdir` names the checkout's .git file, absolute or relative to the registration.
      const gitdir = await capture(() => readFile(join(registration, "gitdir"), "utf8"));
      if (gitdir.ok) {
        checkouts.push(dirname(resolve(registration, gitdir.value.trim())));
      } else if (!isMissingPath(gitdir.error)) {
        return gitdir;
      }
    }

    return ok({ directories: [this.repository.id, root, ...registrations], checkouts });
  }

  // The nearest existing directory above `target`, plus the child name leading to it.
  private async anchor(
    target: string,
  ): Promise<Result<{ path: string; name: string; identity: string } | null, ExpectedError>> {
    let child = target;
    let parent = dirname(target);
    while (parent !== child) {
      const info = await capture(() => stat(parent));
      if (info.ok && info.value.isDirectory()) {
        return ok({
          path: parent,
          name: basename(child),
          identity: `${info.value.dev}:${info.value.ino}`,
        });
      }
      if (!info.ok && !isMissingPath(info.error)) {
        return info;
      }

      child = parent;
      parent = dirname(parent);
    }

    return ok(null);
  }

  private async syncDirectories(): Promise<Result<void, ExpectedError>> {
    const listed = await this.metadataDirectories();
    if (!listed.ok) {
      return listed;
    }

    const wanted = new Map<string, string>();
    for (const path of listed.value.directories) {
      const info = await capture(() => stat(path));
      if (!info.ok) {
        // Registrations may disappear while Git is removing them. The parent watcher retries.
        if (path !== this.repository.id && isMissingPath(info.error)) {
          continue;
        }
        // The whole common directory may be deleted concurrently; its ancestor anchor retries.
        if (path === this.repository.id && isMissingPath(info.error)) {
          break;
        }

        return info;
      }

      wanted.set(path, `${info.value.dev}:${info.value.ino}`);
    }

    const targets = new Set([
      this.repository.id,
      ...this.known.worktrees.map((tree) => tree.path),
      ...listed.value.checkouts,
    ]);
    const anchors = new Map<string, Set<string>>();
    for (const target of targets) {
      const anchor = await this.anchor(target);
      if (!anchor.ok) {
        return anchor;
      }
      if (!anchor.value) {
        continue;
      }

      const { path, name, identity } = anchor.value;
      const names = anchors.get(path) ?? new Set<string>();
      names.add(name);
      anchors.set(path, names);
      wanted.set(path, identity);
    }
    if (this.closed) {
      return ok(undefined);
    }

    this.anchors = anchors;
    for (const [path, watched] of this.directories) {
      if (wanted.get(path) === watched.identity) {
        continue;
      }

      watched.watcher.close();
      this.directories.delete(path);
    }
    for (const [path, identity] of wanted) {
      if (this.directories.has(path)) {
        continue;
      }

      const watched = this.watchDirectory(path);
      if (!watched.ok) {
        return watched;
      }

      this.directories.set(path, { watcher: watched.value, identity });
    }

    return ok(undefined);
  }

  private relevant(path: string, name: string | undefined): boolean {
    if (!name || this.anchors.get(path)?.has(name)) {
      return true;
    }

    // Ignore index/ref/object churn: only catalog/branch metadata needs rediscovery.
    const root = join(this.repository.id, "worktrees");
    if (path === this.repository.id) {
      return name === "worktrees" || name === "HEAD";
    } else if (path === root) {
      return true;
    } else if (dirname(path) === root) {
      return name === "HEAD" || name === "gitdir" || name === "commondir";
    }

    return false;
  }

  private watchDirectory(path: string): Result<FSWatcher, ExpectedError> {
    try {
      const watcher = watch(path, { persistent: false }, (_event, filename) => {
        if (this.relevant(path, filename?.toString())) {
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
