import { execFile } from "node:child_process";
import { basename } from "node:path";
import {
  CancelledError,
  CapabilityError,
  knownError,
  PtyError,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { TerminalInfo } from "../runtime/protocol.ts";

type ProcessRow = {
  pid: number;
  parent: number;
  group: number;
  foreground: number;
  command: string;
};
type Inspect = (signal: AbortSignal) => Promise<Result<string, ExpectedError>>;
export type TerminalTitles = Readonly<Record<string, string>>;

function inspectProcesses(signal: AbortSignal): Promise<Result<string, ExpectedError>> {
  if (signal.aborted) return Promise.resolve(err(new CancelledError()));
  if (process.platform !== "darwin" && process.platform !== "linux")
    return Promise.resolve(
      err(new CapabilityError("Process titles require a local POSIX terminal.")),
    );
  return new Promise((resolve, reject) => {
    // Executable names only: never collect command arguments, which can contain credentials.
    execFile(
      "ps",
      ["-ww", "-axo", "pid=,ppid=,pgid=,tpgid=,comm="],
      { encoding: "utf8", signal, timeout: 1000, maxBuffer: 4 * 1024 * 1024 },
      (error, text) => {
        if (!error) {
          resolve(ok(text));
          return;
        }
        if (signal.aborted) {
          resolve(err(new CancelledError()));
          return;
        }
        if (
          error.killed ||
          typeof error.code === "number" ||
          error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
          knownError(error)
        ) {
          resolve(
            err(
              new PtyError(
                "PTY_UNAVAILABLE",
                "Could not read terminal process names; the terminal remains running.",
                { cause: error },
              ),
            ),
          );
          return;
        }
        reject(error);
      },
    );
  });
}

// Local read-only presentation metadata. Works with existing runtime shell/anchor PIDs;
// it does not change PTY ownership, send shell commands or require a daemon restart.
export async function readTerminalProcessTitles(
  items: readonly TerminalInfo[],
  signal: AbortSignal,
  inspect: Inspect = inspectProcesses,
): Promise<Result<TerminalTitles, ExpectedError>> {
  if (signal.aborted) return err(new CancelledError());
  if (!items.length) return ok({});
  const result = await inspect(signal);
  if (!result.ok) return result;
  if (signal.aborted) return err(new CancelledError());
  const rows: ProcessRow[] = [];
  for (const line of result.value.split("\n").filter((line) => line.trim())) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(.+)$/.exec(line);
    if (!match)
      return err(
        new PtyError(
          "PTY_UNAVAILABLE",
          "Unexpected process-name response; existing terminal labels were retained.",
        ),
      );
    rows.push({
      pid: Number(match[1]),
      parent: Number(match[2]),
      group: Number(match[3]),
      foreground: Number(match[4]),
      command: match[5]!.trim(),
    });
  }
  if (!rows.length)
    return err(
      new PtyError(
        "PTY_UNAVAILABLE",
        "Empty process-name response; existing terminal labels were retained.",
      ),
    );
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const titles: Record<string, string> = {};
  for (const item of items) {
    const shell = byPid.get(item.shellPid);
    // Do not label a recycled PID belonging to a different supervisor.
    if (!shell || shell.parent !== item.pid || item.exited || shell.foreground < 2) continue;
    const candidates = rows.filter((row) => row.group === shell.foreground);
    // A freshly launched shell may briefly inherit its supervisor's foreground group.
    const foreground =
      shell.foreground === item.pid
        ? shell
        : (candidates.find((row) => row.pid === shell.foreground) ?? candidates[0]);
    if (!foreground) continue;
    const title = Array.from(
      basename(foreground.command)
        // oxlint-disable-next-line eslint/no-control-regex -- Process names are untrusted terminal labels; keep only printable code points.
        .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
        .trim(),
    )
      .slice(0, 80)
      .join("");
    if (title) titles[item.id] = title;
  }
  return ok(titles);
}
