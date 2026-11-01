import { dlopen, FFIType, read } from "bun:ffi";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { capture, CleanupError, StorageError, type ExpectedError } from "../errors.ts";
import { err, type Result } from "../result.ts";

// flock(2) operations; identical on Darwin and Linux.
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
// Errno values that mean "held by another owner" or "retry": EWOULDBLOCK and EINTR.
const EINTR = 4;
const EWOULDBLOCK = process.platform === "darwin" ? 35 : 11;
const defaultTimeoutMs = 15_000;

let native: ReturnType<typeof openNative> | undefined;

function openNative() {
  const darwin = process.platform === "darwin";

  return dlopen(darwin ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [darwin ? "__error" : "__errno_location"]: { args: [], returns: FFIType.ptr },
  });
}

type FlockResult = "locked" | "busy" | { errno: number };

function flock(fd: number, operation: number): FlockResult {
  native ??= openNative();
  if (native.symbols.flock(fd, operation) === 0) {
    return "locked";
  }

  const location = (native.symbols as unknown as Record<string, () => number | null>)[
    process.platform === "darwin" ? "__error" : "__errno_location"
  ]!();
  const errno = location ? read.i32(location as never, 0) : -1;

  return errno === EWOULDBLOCK || errno === EINTR ? "busy" : { errno };
}

const queues = new Map<string, Promise<void>>();

/**
 * Runs `task` while holding an exclusive advisory lock on `path` across processes.
 *
 * The kernel releases flock(2) locks when the owning descriptor closes, including on a crash,
 * so the lock file is never unlinked: deleting it would let two owners lock different inodes.
 * Callers in the same process are queued first, so they never poll against each other.
 * The task must not acquire the same lock again.
 */
export async function withStateLock<T>(
  path: string,
  task: () => Promise<Result<T, ExpectedError>>,
  options: { timeoutMs?: number } = {},
): Promise<Result<T, ExpectedError>> {
  const previous = queues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mine = previous.then(() => turn);
  queues.set(path, mine);
  await previous;
  try {
    return await locked(path, task, options.timeoutMs ?? defaultTimeoutMs);
  } finally {
    release();
    if (queues.get(path) === mine) {
      queues.delete(path);
    }
  }
}

async function locked<T>(
  path: string,
  task: () => Promise<Result<T, ExpectedError>>,
  timeoutMs: number,
): Promise<Result<T, ExpectedError>> {
  const prepared = await capture(async () => {
    // Callers create and verify the state directory; a lock never creates missing scopes.
    const directory = dirname(path);
    const parent = await lstat(directory);
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (process.getuid && parent.uid !== process.getuid())
    ) {
      throw new StorageError(`State lock directory is not owned by this user: ${directory}`);
    }

    return open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  });
  if (!prepared.ok) {
    return prepared;
  }

  const file = prepared.value;
  const result = await holding(file, path, task, timeoutMs);
  const closed = await capture(() => file.close());
  if (!closed.ok) {
    return result.ok
      ? closed
      : err(new CleanupError("State lock task and close failed.", [result.error, closed.error]));
  }

  return result;
}

async function holding<T>(
  file: FileHandle,
  path: string,
  task: () => Promise<Result<T, ExpectedError>>,
  timeoutMs: number,
): Promise<Result<T, ExpectedError>> {
  try {
    const stat = await capture(() => file.stat());
    if (!stat.ok) {
      return stat;
    }
    if (
      !stat.value.isFile() ||
      stat.value.nlink !== 1 ||
      (process.getuid && stat.value.uid !== process.getuid())
    ) {
      return err(new StorageError(`State lock is not a private regular file: ${path}`));
    }

    const deadline = Date.now() + timeoutMs;
    let delay = 2;
    for (;;) {
      const attempt = flock(file.fd, LOCK_EX | LOCK_NB);
      if (attempt === "locked") {
        break;
      }
      if (attempt !== "busy") {
        return err(new StorageError(`Could not lock state file (errno ${attempt.errno}): ${path}`));
      }
      if (Date.now() >= deadline) {
        return err(new StorageError(`Timed out waiting for state lock: ${path}`));
      }

      await Bun.sleep(delay);
      delay = Math.min(delay * 2, 50);
    }
    try {
      // A replaced lock file would let another owner lock a different inode.
      const current = await capture(() => lstat(path));
      if (!current.ok) {
        return current;
      }
      if (current.value.ino !== stat.value.ino || current.value.dev !== stat.value.dev) {
        return err(new StorageError(`State lock was replaced while waiting: ${path}`));
      }

      return await task();
    } finally {
      // Closing the descriptor below releases the lock even if this explicit unlock fails.
      flock(file.fd, LOCK_UN);
    }
  } catch (error) {
    // An unexpected exception keeps its original identity; a close failure must not mask it.
    await file.close().catch(() => undefined);
    throw error;
  }
}
