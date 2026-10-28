import { execFile } from "node:child_process";
import {
  CancelledError,
  CapabilityError,
  ResourceError,
  knownError,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

export type WorkspaceResourceScope = {
  id: string;
  name: string;
  // Null means the owning runtime is disconnected or cannot report process ownership.
  roots: readonly { pid: number; parentPid: number }[] | null;
};

export type WorkspaceProcessSample = {
  pid: number;
  started: string;
  cpuMicros: number;
  rssBytes: number;
};

export type WorkspaceResourceSample = {
  id: string;
  name: string;
  elapsedMs: number;
  processes: readonly WorkspaceProcessSample[] | null;
};

export type WorkspaceResourceLoader = (
  signal: AbortSignal,
) => Promise<Result<readonly WorkspaceResourceSample[], ExpectedError>>;

type Inspect = (signal: AbortSignal) => Promise<Result<string, ExpectedError>>;
type ProcessRow = WorkspaceProcessSample & { parentPid: number };

function inspectProcesses(signal: AbortSignal): Promise<Result<string, ExpectedError>> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return Promise.resolve(
      err(new CapabilityError("Workspace resources require local POSIX processes.")),
    );
  }

  return new Promise((resolve, reject) => {
    // Numeric counters and start identities only; never read command arguments or environments.
    execFile(
      "ps",
      ["-axo", "pid=,ppid=,rss=,time=,lstart="],
      {
        encoding: "utf8",
        signal,
        timeout: 1000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, LC_ALL: "C" },
      },
      (error, text) => {
        if (!error) {
          resolve(ok(text));
        } else if (signal.aborted) {
          resolve(err(new CancelledError()));
        } else if (
          error.killed ||
          typeof error.code === "number" ||
          error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
          knownError(error)
        ) {
          resolve(
            err(new ResourceError("Could not read workspace process resources.", { cause: error })),
          );
        } else {
          reject(error);
        }
      },
    );
  });
}

function cpuTime(value: string): number | undefined {
  // BSD uses cumulative minutes and fractional seconds; Linux also supports hours and days.
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d{2})(?:\.(\d+))?$/.exec(value);
  if (!match || Number(match[4]) >= 60 || (match[2] !== undefined && Number(match[3]) >= 60)) {
    return undefined;
  }

  const seconds =
    Number(match[1] ?? 0) * 86400 +
    Number(match[2] ?? 0) * 3600 +
    Number(match[3]) * 60 +
    Number(match[4]) +
    Number(`0.${match[5] ?? 0}`);
  const micros = Math.round(seconds * 1000000);

  return Number.isSafeInteger(micros) ? micros : undefined;
}

// Read-only attribution follows known editor/terminal roots, never workspace path/name guesses.
// Shared in-process Agent execution stays in the Runtime row rather than being divided arbitrarily.
export async function readWorkspaceResources(
  scopes: readonly WorkspaceResourceScope[],
  signal: AbortSignal,
  inspect: Inspect = inspectProcesses,
): Promise<Result<readonly WorkspaceResourceSample[], ExpectedError>> {
  if (signal.aborted) {
    return err(new CancelledError());
  }

  const rows = new Map<number, ProcessRow>();
  if (scopes.some((scope) => scope.roots?.length)) {
    const result = await inspect(signal);
    if (!result.ok) {
      return result;
    }
    if (signal.aborted) {
      return err(new CancelledError());
    }

    for (const line of result.value.split("\n").filter((line) => line.trim())) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
      const cpuMicros = match ? cpuTime(match[4]!) : undefined;
      if (!match || cpuMicros === undefined) {
        return err(new ResourceError("Malformed workspace process counters."));
      }

      const pid = Number(match[1]);
      const parentPid = Number(match[2]);
      const rssBytes = Number(match[3]) * 1024;
      if (
        !Number.isSafeInteger(pid) ||
        pid < 1 ||
        !Number.isSafeInteger(parentPid) ||
        !Number.isSafeInteger(rssBytes) ||
        rows.has(pid)
      ) {
        return err(new ResourceError("Invalid workspace process identity or memory counter."));
      }

      rows.set(pid, { pid, parentPid, rssBytes, cpuMicros, started: match[5]! });
    }
    if (!rows.size) {
      return err(new ResourceError("Empty workspace process response."));
    }
  }

  const children = new Map<number, number[]>();
  for (const row of rows.values()) {
    const siblings = children.get(row.parentPid) ?? [];
    siblings.push(row.pid);
    children.set(row.parentPid, siblings);
  }

  const elapsedMs = performance.now();
  const samples = scopes.map((scope): WorkspaceResourceSample => {
    const sample = { id: scope.id, name: scope.name, elapsedMs, processes: null };
    if (
      !scope.roots ||
      scope.roots.some((root) => rows.get(root.pid)?.parentPid !== root.parentPid)
    ) {
      return sample;
    }

    const pids = new Set<number>();
    const pending = scope.roots.map((root) => root.pid);
    while (pending.length) {
      const pid = pending.pop()!;
      if (pids.has(pid)) {
        continue;
      }

      pids.add(pid);
      pending.push(...(children.get(pid) ?? []));
    }

    return { ...sample, processes: [...pids].map((pid) => rows.get(pid)!) };
  });

  return ok(samples);
}
