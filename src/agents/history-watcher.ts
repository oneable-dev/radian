import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { capture, knownError, StorageError, systemCode, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

// Notifications invalidate history; discovery remains the authority for membership.
export class HistoryWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  constructor(
    private readonly directories: readonly string[],
    private readonly changed: () => void,
    private readonly failed: (error: ExpectedError) => void,
    private readonly unexpected: (error: unknown) => void,
    private readonly ignored: (path: string) => boolean = () => false,
  ) {}

  async start(): Promise<Result<void, ExpectedError>> {
    for (const directory of this.directories) {
      let parent = resolve(directory);
      while (true) {
        const found = await capture(() => stat(parent));
        if (found.ok) break;
        if (!(found.error instanceof StorageError) || found.error.systemCode !== "ENOENT")
          return found;
        const next = dirname(parent);
        if (next === parent) return found;
        parent = next;
      }
      if (this.closed || this.watchers.has(parent)) continue;
      let watcher: FSWatcher;
      try {
        watcher = watch(parent, { recursive: true, persistent: false }, (_event, name) => {
          const path = name ? resolve(parent, name.toString()) : undefined;
          if (path && this.ignored(path)) return;
          if (
            !path ||
            this.directories.some((root) => {
              const target = resolve(root);
              return (
                path === target || path.startsWith(target + sep) || target.startsWith(path + sep)
              );
            })
          )
            this.invalidate();
        });
      } catch (error) {
        const expected = this.watchError(error);
        if (expected) return err(expected);
        throw error;
      }
      if (this.closed) {
        watcher.close();
        continue;
      }
      watcher.on("error", (error: unknown) => {
        if (this.closed) return;
        watcher.close();
        this.watchers.delete(parent);
        const expected = this.watchError(error);
        if (expected) this.failed(expected);
        else this.unexpected(error);
      });
      this.watchers.set(parent, watcher);
    }
    return ok(undefined);
  }

  private watchError(error: unknown): ExpectedError | null {
    const expected = knownError(error);
    if (expected) return expected;
    const code = systemCode(error);
    return code &&
      [
        "ENOSYS",
        "ENOTSUP",
        "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
        "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM_VERSION",
      ].includes(code)
      ? new StorageError(`History watching is unavailable (${code}). Use /reload to retry.`, code, {
          cause: error,
        })
      : null;
  }

  invalidate(): void {
    if (this.closed || this.timer) return;
    // Bound reconciliation during streaming and coalesce lifecycle/checkpoint writes.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.closed) this.changed();
    }, 250);
    this.timer.unref();
  }
  stop(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
}
