import { fileURLToPath } from "node:url";

export type SelfLaunch =
  | { kind: "source"; executable: string; entrypoint: string }
  | { kind: "binary"; executable: string };

// Resolve the known application entry, never the caller's argv or working directory.
// Entrypoints can supply their own URL; in-process hosts use Radian's canonical entry.
export function selfLaunch(entrypoint = new URL("../index.ts", import.meta.url)): SelfLaunch {
  return Bun.isStandaloneExecutable
    ? { kind: "binary", executable: process.execPath }
    : { kind: "source", executable: process.execPath, entrypoint: fileURLToPath(entrypoint) };
}

export function childCommand(launch: SelfLaunch, args: readonly string[]): [string, ...string[]] {
  if (launch.kind === "binary") {
    return [launch.executable, ...args];
  }

  // Internal children must not execute project preloads or import project dotenv files.
  // Compiled executables apply the equivalent policy at build time.
  return [launch.executable, "--no-env-file", "--config=/dev/null", launch.entrypoint, ...args];
}
