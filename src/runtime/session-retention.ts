import { lstat, open, realpath, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { SessionSnapshotInfo } from "../agents/session-snapshot.ts";
import {
  capture,
  HistoryError,
  parseJson,
  StorageError,
  withCleanup,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

export const retentionSweepIntervalMs = 60 * 60 * 1000;
export const retentionDayMs = 24 * 60 * 60 * 1000;

export function sessionExpired(
  snapshot: SessionSnapshotInfo,
  days: number | null,
  now: number,
): boolean {
  return (
    days !== null &&
    snapshot.managed === true &&
    snapshot.lifecycle === "closed" &&
    snapshot.closedAt != null &&
    now - snapshot.closedAt >= days * retentionDayMs
  );
}

type Fingerprint = { dev: number; ino: number; size: number; mtimeMs: number };

export type RetainedFile =
  | { kind: "absent" }
  | { kind: "changed" }
  | { kind: "ready"; path: string; fingerprint: Fingerprint };

const sameFile = (a: Fingerprint, b: Fingerprint) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

// Never treat a saved path as deletion authority by itself: verify the regular file,
// SDK identity, original worktree and whether another application has since changed it.
export async function inspectRetainedFile(
  snapshot: SessionSnapshotInfo,
): Promise<Result<RetainedFile, ExpectedError>> {
  const path = snapshot.sessionFile;
  if (!path) {
    return ok({ kind: "absent" });
  }

  const found = await capture(() => lstat(path));
  if (!found.ok) {
    return found.error instanceof StorageError && found.error.systemCode === "ENOENT"
      ? ok({ kind: "absent" })
      : found;
  }
  if (!found.value.isFile() || found.value.isSymbolicLink()) {
    return err(
      new HistoryError("HISTORY_UNAVAILABLE", "Retention refused a non-regular SDK session file."),
    );
  }
  if (Math.floor(found.value.mtimeMs) > snapshot.updatedAt) {
    return ok({ kind: "changed" });
  }

  const canonical = await capture(() => realpath(path));
  if (!canonical.ok) {
    return canonical;
  }
  if (canonical.value !== resolve(path)) {
    return err(
      new HistoryError(
        "HISTORY_UNAVAILABLE",
        "Retention refused a session path with a changed or symbolic location.",
      ),
    );
  }

  const read = await capture(async () => {
    const file = await open(path, "r");

    return withCleanup(
      async () => {
        const stat = await file.stat();
        if (!sameFile(found.value, stat)) {
          return err(
            new HistoryError("HISTORY_UNAVAILABLE", "Session changed during retention inspection."),
          );
        }

        const buffer = Buffer.alloc(65536);
        const bytes = await file.read(buffer, 0, buffer.length, 0);
        const text = buffer
          .subarray(0, bytes.bytesRead)
          .toString("utf8")
          .split(/\r?\n/)
          .find((line) => line.trim());
        const parsed = parseJson(text ?? "", "retained session header");
        if (!parsed.ok) {
          return err(
            new HistoryError(
              "HISTORY_CORRUPT",
              "Retention could not validate the SDK session header.",
              { cause: parsed.error },
            ),
          );
        }

        const header = parsed.value;
        if (
          !header ||
          typeof header !== "object" ||
          !("type" in header) ||
          header.type !== "session" ||
          !("id" in header) ||
          header.id !== snapshot.conversationId ||
          !("cwd" in header) ||
          typeof header.cwd !== "string" ||
          !snapshot.cwd ||
          header.cwd.includes("\0") ||
          resolve(header.cwd) !== resolve(snapshot.cwd)
        ) {
          return err(
            new HistoryError(
              "HISTORY_UNAVAILABLE",
              "Retention refused a mismatched SDK conversation or worktree.",
            ),
          );
        }

        return ok({
          kind: "ready",
          path: canonical.value,
          fingerprint: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs },
        } as const);
      },
      () => file.close(),
    );
  });

  return read.ok ? read.value : read;
}

export async function deleteRetainedFile(file: RetainedFile): Promise<Result<void, ExpectedError>> {
  if (file.kind !== "ready") {
    return ok(undefined);
  }

  const found = await capture(() => lstat(file.path));
  if (!found.ok) {
    return found.error instanceof StorageError && found.error.systemCode === "ENOENT"
      ? ok(undefined)
      : found;
  }
  if (
    !found.value.isFile() ||
    found.value.isSymbolicLink() ||
    !sameFile(file.fingerprint, found.value)
  ) {
    return err(
      new HistoryError(
        "HISTORY_UNAVAILABLE",
        "Session changed before retention deletion; no SDK file was removed.",
      ),
    );
  }

  return removeRetentionFile(file.path);
}

export async function removeRetentionFile(path: string): Promise<Result<void, ExpectedError>> {
  const removed = await capture(() => unlink(path));

  return !removed.ok &&
    removed.error instanceof StorageError &&
    removed.error.systemCode === "ENOENT"
    ? ok(undefined)
    : removed;
}

type Schedule = (tick: () => void, intervalMs: number) => () => void;

const scheduleInterval: Schedule = (tick, intervalMs) => {
  const timer = setInterval(tick, intervalMs);
  timer.unref();

  return () => clearInterval(timer);
};

// The daemon, not the TUI, owns one startup sweep and non-overlapping hourly sweeps.
export class RetentionScheduler {
  private pending: Promise<void> | undefined;
  private cancel: (() => void) | undefined;
  private stopped = false;

  constructor(
    private readonly sweep: () => Promise<Result<number, ExpectedError>>,
    private readonly completed: (result: Result<number, ExpectedError>) => void,
    private readonly unexpected: (error: unknown) => void,
    private readonly schedule: Schedule = scheduleInterval,
  ) {}

  async start(): Promise<void> {
    await this.run();
    if (!this.stopped) {
      this.cancel = this.schedule(() => {
        void this.run().catch(this.unexpected);
      }, retentionSweepIntervalMs);
    }
  }

  run(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    if (this.pending) {
      return this.pending;
    }

    const task = Promise.resolve()
      .then(() => this.sweep())
      .then((result) => this.completed(result))
      .finally(() => {
        if (this.pending === task) {
          this.pending = undefined;
        }
      });
    this.pending = task;

    return task;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancel?.();
    this.cancel = undefined;
    await this.pending;
  }
}
