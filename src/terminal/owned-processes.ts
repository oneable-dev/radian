import { dlopen, FFIType } from "bun:ffi";
import {
  capture,
  CapabilityError,
  InputError,
  knownError,
  PtyError,
  systemCode,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

type ProcessEntry = { pid: number; zombie: boolean };
export type ProcessAnchor = { pid: number; alive(): boolean };
export type ProcessOperations = {
  sessionId(pid: number): number;
  list(): Promise<Result<readonly ProcessEntry[], ExpectedError>>;
  signal(pid: number, signal: NodeJS.Signals): void;
};
let native: ReturnType<typeof openNative> | undefined;
function openNative() {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new CapabilityError("Owned terminals require POSIX session support.");
  return dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    getsid: { args: [FFIType.i32], returns: FFIType.i32 },
  });
}
function sessionId(pid: number): number {
  native ??= openNative();
  return native.symbols.getsid(pid);
}
async function listProcesses(): Promise<Result<readonly ProcessEntry[], ExpectedError>> {
  const result = await capture(async () => {
    const child = Bun.spawn(["ps", "-axo", "pid=,stat="], { stdout: "pipe", stderr: "pipe" });
    const [text, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0)
      throw new PtyError(
        "PTY_CLEANUP_FAILED",
        `Could not inspect terminal processes (${code}): ${error.trim()}`,
      );
    return text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
        if (!match)
          throw new PtyError(
            "PTY_CLEANUP_FAILED",
            "Unexpected process inspection format; no signals were sent.",
          );
        return { pid: Number(match[1]), zombie: match[2]!.startsWith("Z") };
      });
  });
  return result;
}
const operations: ProcessOperations = {
  sessionId,
  list: listProcesses,
  signal: (pid, signal) => {
    process.kill(pid, signal);
  },
};
const validPid = (pid: number) => Number.isSafeInteger(pid) && pid > 1 && pid <= 2147483647;

// A retained supervisor reserves this kernel session ID until all its children stop.
// Never use macOS `ps sess` (often zero), PID ancestry guesses, or negative/group kills.
export class OwnedProcesses {
  private constructor(
    private readonly anchor: ProcessAnchor,
    private readonly ops: ProcessOperations,
  ) {}
  static capture(
    anchor: ProcessAnchor,
    ops: ProcessOperations = operations,
  ): Result<OwnedProcesses, ExpectedError> {
    if (!validPid(anchor.pid) || anchor.pid === process.pid || anchor.pid === process.ppid)
      return err(new InputError("Invalid terminal ownership anchor."));
    try {
      if (
        !anchor.alive() ||
        ops.sessionId(anchor.pid) !== anchor.pid ||
        ops.sessionId(process.pid) === anchor.pid
      ) {
        return err(
          new PtyError(
            "PTY_OWNERSHIP_LOST",
            "Terminal has no isolated, live ownership anchor. Refusing process control.",
          ),
        );
      }
      return ok(new OwnedProcesses(anchor, ops));
    } catch (error) {
      const known = knownError(error);
      if (known) return err(known);
      throw error;
    }
  }
  private validAnchor(): boolean {
    return this.anchor.alive() && this.ops.sessionId(this.anchor.pid) === this.anchor.pid;
  }
  private owned(pid: number): boolean {
    return (
      validPid(pid) &&
      pid !== this.anchor.pid &&
      pid !== process.pid &&
      pid !== process.ppid &&
      this.ops.sessionId(pid) === this.anchor.pid
    );
  }
  private async members(): Promise<Result<readonly number[], ExpectedError>> {
    if (!this.validAnchor())
      return err(
        new PtyError(
          "PTY_OWNERSHIP_LOST",
          `Terminal ownership anchor ${this.anchor.pid} ended. Refusing unverified cleanup.`,
        ),
      );
    const list = await this.ops.list();
    if (!list.ok) return list;
    return ok(
      list.value
        .filter((entry) => !entry.zombie && this.owned(entry.pid))
        .map((entry) => entry.pid),
    );
  }
  private signal(pid: number, signal: NodeJS.Signals): void {
    if (!this.validAnchor())
      throw new PtyError(
        "PTY_OWNERSHIP_LOST",
        `Terminal ownership anchor ${this.anchor.pid} changed before signaling. Cleanup stopped.`,
      );
    // Recheck identity immediately before every signal. A recycled/unrelated PID is skipped.
    if (!this.owned(pid)) return;
    try {
      this.ops.signal(pid, signal);
    } catch (error) {
      if (systemCode(error) !== "ESRCH") throw error;
    }
  }
  async stopChildren(shellPid?: number): Promise<Result<void, ExpectedError>> {
    return capture(async () => {
      const initial = await this.members();
      if (!initial.ok) throw initial.error;
      // Keep the anchor alive throughout. All signals below target positive, verified PIDs.
      for (const pid of initial.value) {
        this.signal(pid, pid === shellPid ? "SIGHUP" : "SIGTERM");
        this.signal(pid, "SIGCONT"); // Allow suspended jobs to run their termination handlers.
      }
      const deadline = performance.now() + 2000;
      while (true) {
        const members = await this.members();
        if (!members.ok) throw members.error;
        if (!members.value.length) return;
        if (performance.now() >= deadline) break;
        await Bun.sleep(25);
      }
      const killDeadline = performance.now() + 2000;
      while (true) {
        const members = await this.members();
        if (!members.ok) throw members.error;
        if (!members.value.length) return;
        for (const pid of members.value) this.signal(pid, "SIGKILL");
        if (performance.now() >= killDeadline)
          throw new PtyError(
            "PTY_CLEANUP_FAILED",
            `Owned terminal processes have not exited; ownership anchor ${this.anchor.pid} is retained.`,
          );
        await Bun.sleep(25);
      }
    });
  }
}
