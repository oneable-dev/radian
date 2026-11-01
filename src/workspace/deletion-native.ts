import { dlopen, FFIType, ptr, read } from "bun:ffi";
import { closeSync, constants, fstatSync, openSync, readlinkSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { CapabilityError, knownError, StorageError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

/** Kernel identity of a directory inode; birth time distinguishes reused inode numbers. */
export type DirectoryIdentity = {
  readonly device: string;
  readonly inode: string;
  readonly birth: string;
};

/**
 * Sticky facts reported by the kernel for one held directory descriptor.
 * Only `unlinked` is positive deletion evidence, and only while the others are false.
 */
export type DirectorySignals = {
  readonly unlinked: boolean;
  readonly renamed: boolean;
  readonly revoked: boolean;
  readonly failed: boolean;
};

/** A directory descriptor held open so later events refer to this exact inode. */
export interface HeldDirectory {
  readonly path: string;
  readonly identity: DirectoryIdentity;
  signals(): DirectorySignals;
  release(): void;
}

/** Platform-specific source of positive unlink evidence for held directories. */
export interface DirectoryMonitor {
  hold(path: string): Result<HeldDirectory, ExpectedError>;
  // Non-blocking: reads only what the kernel already queued, never waits or polls.
  collect(): Result<void, ExpectedError>;
  close(): void;
}

export function sameIdentity(a: DirectoryIdentity, b: DirectoryIdentity): boolean {
  return a.device === b.device && a.inode === b.inode && a.birth === b.birth;
}

function identityOf(info: { dev: bigint; ino: bigint; birthtimeNs: bigint }): DirectoryIdentity {
  return { device: String(info.dev), inode: String(info.ino), birth: String(info.birthtimeNs) };
}

/** The identity of whatever directory `path` resolves to now. */
export function pathIdentity(path: string): Result<DirectoryIdentity, ExpectedError> {
  try {
    const info = statSync(path, { bigint: true });
    if (!info.isDirectory()) {
      return err(new StorageError("Path is not a directory.", "ENOTDIR"));
    }

    return ok(identityOf(info));
  } catch (error) {
    return expected(error);
  }
}

function expected(error: unknown): Result<never, ExpectedError> {
  const known = knownError(error);
  if (known) {
    return err(known);
  }

  throw error;
}

export const REPLACED_DURING_REGISTRATION = "RADIAN_DIRECTORY_REPLACED";

function openDirectory(path: string, extraFlags: number): Result<number, ExpectedError> {
  try {
    // libuv adds O_CLOEXEC, so child processes never inherit these descriptors.
    return ok(openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | extraFlags));
  } catch (error) {
    return expected(error);
  }
}

// Registration races: the path may have been replaced between discovery and open. Only a
// descriptor whose inode still matches the path after registration describes that scope.
function verifyHeld(path: string, fd: number): Result<DirectoryIdentity, ExpectedError> {
  let identity: DirectoryIdentity;
  try {
    identity = identityOf(fstatSync(fd, { bigint: true }));
  } catch (error) {
    return expected(error);
  }

  const current = pathIdentity(path);
  if (!current.ok) {
    return current;
  }
  if (!sameIdentity(identity, current.value)) {
    return err(
      new StorageError(
        "Directory changed while it was being registered.",
        REPLACED_DURING_REGISTRATION,
      ),
    );
  }

  return ok(identity);
}

// --- Darwin: kqueue EVFILT_VNODE ---------------------------------------------------------

const EVFILT_VNODE = -4;
const EV_ADD = 0x0001;
const EV_CLEAR = 0x0020;
const EV_RECEIPT = 0x0040;
const EV_ERROR = 0x4000;
const NOTE_DELETE = 0x0001;
const NOTE_RENAME = 0x0020;
const NOTE_REVOKE = 0x0040;
const O_EVTONLY = 0x8000; // Does not block unmounting the volume.
const KEVENT64_SIZE = 48;
const DRAIN_BATCH = 64;

type DarwinNative = ReturnType<typeof openDarwinNative>;

function openDarwinNative() {
  return dlopen("/usr/lib/libSystem.B.dylib", {
    kqueue: { args: [], returns: FFIType.i32 },
    kevent64: {
      args: [
        FFIType.i32,
        FFIType.ptr,
        FFIType.i32,
        FFIType.ptr,
        FFIType.i32,
        FFIType.u32,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
    __error: { args: [], returns: FFIType.ptr },
  });
}

let darwinNative: DarwinNative | undefined;

function errnoOf(native: DarwinNative): number {
  const location = native.symbols.__error();

  return location ? read.i32(location, 0) : 0;
}

type MutableSignals = { -readonly [K in keyof DirectorySignals]: DirectorySignals[K] };

class DarwinDirectory implements HeldDirectory {
  readonly state: MutableSignals = {
    unlinked: false,
    renamed: false,
    revoked: false,
    failed: false,
  };
  released = false;

  constructor(
    readonly path: string,
    readonly identity: DirectoryIdentity,
    readonly fd: number,
    private readonly owner: DarwinMonitor,
  ) {}

  signals(): DirectorySignals {
    return { ...this.state };
  }

  release(): void {
    this.owner.release(this);
  }
}

class DarwinMonitor implements DirectoryMonitor {
  private queue: number | undefined;
  private readonly held = new Map<number, DarwinDirectory>();
  private closed = false;

  private native(): Result<{ native: DarwinNative; queue: number }, ExpectedError> {
    if (this.closed) {
      return err(new CapabilityError("Deletion monitor is closed."));
    }

    try {
      darwinNative ??= openDarwinNative();
    } catch (error) {
      // dlopen failures are capability failures, never evidence of anything.
      if (error instanceof Error) {
        return err(new CapabilityError(`kqueue is unavailable: ${error.message}`));
      }

      throw error;
    }

    if (this.queue === undefined) {
      const queue = darwinNative.symbols.kqueue();
      if (queue < 0) {
        return err(
          new StorageError("kqueue could not be created.", `errno:${errnoOf(darwinNative)}`),
        );
      }

      this.queue = queue;
    }

    return ok({ native: darwinNative, queue: this.queue });
  }

  hold(path: string): Result<HeldDirectory, ExpectedError> {
    const native = this.native();
    if (!native.ok) {
      return native;
    }

    const opened = openDirectory(path, O_EVTONLY);
    if (!opened.ok) {
      return opened;
    }

    const fd = opened.value;
    const registered = this.register(native.value.native, native.value.queue, fd);
    const verified = registered.ok ? verifyHeld(path, fd) : registered;
    if (!verified.ok) {
      closeSync(fd);

      return verified;
    }

    const directory = new DarwinDirectory(path, verified.value, fd, this);
    this.held.set(fd, directory);

    return ok(directory);
  }

  private register(native: DarwinNative, queue: number, fd: number): Result<void, ExpectedError> {
    const change = Buffer.alloc(KEVENT64_SIZE);
    change.writeBigUInt64LE(BigInt(fd), 0);
    change.writeInt16LE(EVFILT_VNODE, 8);
    change.writeUInt16LE(EV_ADD | EV_CLEAR | EV_RECEIPT, 10);
    change.writeUInt32LE(NOTE_DELETE | NOTE_RENAME | NOTE_REVOKE, 12);

    // EV_RECEIPT reports the registration outcome in `data` without dequeuing pending events.
    const receipt = Buffer.alloc(KEVENT64_SIZE);
    const timeout = Buffer.alloc(16);
    const count = native.symbols.kevent64(queue, ptr(change), 1, ptr(receipt), 1, 0, ptr(timeout));
    if (count < 0) {
      return err(new StorageError("kqueue registration failed.", `errno:${errnoOf(native)}`));
    }

    const flags = receipt.readUInt16LE(10);
    const code = Number(receipt.readBigInt64LE(16));
    if (count !== 1 || (flags & EV_ERROR) === 0 || code !== 0) {
      return err(new StorageError("kqueue registration was rejected.", `errno:${code}`));
    }

    return ok(undefined);
  }

  collect(): Result<void, ExpectedError> {
    if (this.queue === undefined || this.closed) {
      return ok(undefined);
    }

    const native = darwinNative!;
    const events = Buffer.alloc(KEVENT64_SIZE * DRAIN_BATCH);
    const timeout = Buffer.alloc(16); // Zero timespec: never blocks.
    while (true) {
      const count = native.symbols.kevent64(
        this.queue,
        null,
        0,
        ptr(events),
        DRAIN_BATCH,
        0,
        ptr(timeout),
      );
      if (count < 0) {
        const errno = errnoOf(native);
        // EINTR only interrupted the read; nothing was lost.
        if (errno === 4) {
          continue;
        }

        this.markAllFailed();

        return err(new StorageError("kqueue events could not be read.", `errno:${errno}`));
      }

      for (let index = 0; index < count; index++) {
        this.apply(events, index * KEVENT64_SIZE);
      }
      if (count < DRAIN_BATCH) {
        return ok(undefined);
      }
    }
  }

  private apply(events: Buffer, offset: number): void {
    const fd = Number(events.readBigUInt64LE(offset));
    const directory = this.held.get(fd);
    if (!directory) {
      return;
    }

    const flags = events.readUInt16LE(offset + 10);
    const fflags = events.readUInt32LE(offset + 12);
    if (flags & EV_ERROR) {
      directory.state.failed = true;

      return;
    }
    if (fflags & NOTE_DELETE) {
      directory.state.unlinked = true;
    }
    if (fflags & NOTE_RENAME) {
      directory.state.renamed = true;
    }
    if (fflags & NOTE_REVOKE) {
      directory.state.revoked = true;
    }
  }

  private markAllFailed(): void {
    for (const directory of this.held.values()) {
      directory.state.failed = true;
    }
  }

  release(directory: DarwinDirectory): void {
    if (directory.released) {
      return;
    }

    directory.released = true;
    // Closing the descriptor also removes its kqueue registration.
    if (this.held.get(directory.fd) === directory) {
      this.held.delete(directory.fd);
    }

    closeSync(directory.fd);
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    for (const directory of this.held.values()) {
      this.release(directory);
    }
    if (this.queue !== undefined) {
      closeSync(this.queue);
      this.queue = undefined;
    }
  }
}

// --- Linux: unlinked descriptors plus their kernel-reported original location ---------------

class LinuxDirectory implements HeldDirectory {
  private state: MutableSignals = {
    unlinked: false,
    renamed: false,
    revoked: false,
    failed: false,
  };
  private released = false;

  constructor(
    readonly path: string,
    readonly identity: DirectoryIdentity,
    private readonly fd: number,
    private readonly owner: LinuxMonitor,
  ) {}

  inspect(): void {
    if (this.released || this.state.unlinked || this.state.failed) {
      return;
    }

    try {
      const unlinked = fstatSync(this.fd, { bigint: true }).nlink === 0n;
      const location = readlinkSync(`/proc/self/fd/${this.fd}`);
      const suffix = " (deleted)";
      if (unlinked && !location.endsWith(suffix)) {
        // Without a kernel pathname we cannot distinguish a moved-then-removed directory.
        this.state.failed = true;
        return;
      }
      const currentPath = unlinked ? location.slice(0, -suffix.length) : location;
      if (currentPath !== resolve(this.path)) this.state.renamed = true;
      if (unlinked) this.state.unlinked = true;
    } catch {
      // A held descriptor that cannot be inspected proves nothing.
      this.state.failed = true;
    }
  }

  signals(): DirectorySignals {
    return { ...this.state };
  }

  release(): void {
    if (this.released) {
      return;
    }

    this.released = true;
    this.owner.forget(this);
    closeSync(this.fd);
  }
}

class LinuxMonitor implements DirectoryMonitor {
  private readonly held = new Set<LinuxDirectory>();

  hold(path: string): Result<HeldDirectory, ExpectedError> {
    const opened = openDirectory(path, 0);
    if (!opened.ok) {
      return opened;
    }

    const verified = verifyHeld(path, opened.value);
    if (!verified.ok) {
      closeSync(opened.value);

      return verified;
    }

    const directory = new LinuxDirectory(path, verified.value, opened.value, this);
    this.held.add(directory);

    return ok(directory);
  }

  collect(): Result<void, ExpectedError> {
    for (const directory of this.held) {
      directory.inspect();
    }

    return ok(undefined);
  }

  forget(directory: LinuxDirectory): void {
    this.held.delete(directory);
  }

  close(): void {
    for (const directory of this.held) {
      directory.release();
    }
  }
}

class UnsupportedMonitor implements DirectoryMonitor {
  hold(): Result<HeldDirectory, ExpectedError> {
    return err(
      new CapabilityError(
        `Positive directory deletion evidence is unsupported on ${process.platform}.`,
      ),
    );
  }

  collect(): Result<void, ExpectedError> {
    return ok(undefined);
  }

  close(): void {}
}

/** Evidence source name recorded in receipts. */
export type EvidenceSource = "darwin-kqueue-note-delete" | "linux-unlinked-descriptor";

export function createDirectoryMonitor(): {
  monitor: DirectoryMonitor;
  source: EvidenceSource | null;
} {
  if (process.platform === "darwin") {
    return { monitor: new DarwinMonitor(), source: "darwin-kqueue-note-delete" };
  } else if (process.platform === "linux") {
    return { monitor: new LinuxMonitor(), source: "linux-unlinked-descriptor" };
  }

  return { monitor: new UnsupportedMonitor(), source: null };
}
