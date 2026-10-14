import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Value } from "typebox/value";
import { manifestSchema, type RuntimeManifest } from "./protocol.ts";

export type RuntimePaths = { directory: string; socket: string; lock: string; log: string; manifest: string };

export function runtimePaths(repositoryId: string, offline: boolean, stateRoot = process.env.RADIAN_STATE_DIR ?? join(homedir(), ".radian")): RuntimePaths {
  const key = createHash("sha256").update(`${resolve(stateRoot)}\0${repositoryId}\0${offline}`).digest("hex").slice(0, 32);
  const directory = join(resolve(stateRoot), "workspaces", key);
  // Keep the address below macOS's Unix socket path limit, even with long state-directory names.
  const endpoint = join("/tmp", `radian-${process.getuid?.() ?? "user"}`);
  return { directory, socket: join(endpoint, `${key}.sock`), lock: join(endpoint, `${key}.lock`),
    log: join(directory, "runtime.log"), manifest: join(directory, "workspace.json") };
}

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`Runtime directory is not owned by this user: ${path}`);
  }
  await chmod(path, 0o700);
}

export class RuntimeStore {
  private tail: Promise<void> = Promise.resolve();
  constructor(readonly paths: RuntimePaths) {}

  async load(repositoryId: string): Promise<RuntimeManifest | null> {
    let text: string;
    try { text = await readFile(this.paths.manifest, "utf8"); }
    catch (error) { if (hasCode(error, "ENOENT")) return null; throw error; }
    const value: unknown = JSON.parse(text);
    if (!Value.Check(manifestSchema, value) || value.repositoryId !== repositoryId) throw new Error("Invalid runtime manifest; original file was not replaced.");
    return value;
  }

  save(manifest: RuntimeManifest): Promise<void> {
    const task = this.tail.catch(() => {}).then(async () => {
      const temporary = this.paths.manifest + "." + crypto.randomUUID() + ".tmp";
      try {
        await writeFile(temporary, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.paths.manifest);
      } finally { await rm(temporary, { force: true }); }
    });
    // Callers observe failures; a rejected write must not prevent subsequent recovery writes.
    this.tail = task;
    return task;
  }
}

export async function acquireRuntime(paths: RuntimePaths): Promise<(() => Promise<void>) | null> {
  await privateDirectory(join(paths.socket, ".."));
  const token = crypto.randomUUID();
  const temporary = paths.lock + "." + token;
  const owner = { pid: process.pid, token };
  await writeFile(temporary, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
  try {
    let claimed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { await link(temporary, paths.lock); claimed = true; break; }
      catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        let existing: unknown;
        try { existing = JSON.parse(await readFile(paths.lock, "utf8")); }
        catch (readError) { if (hasCode(readError, "ENOENT")) continue; throw readError; }
        if (!isOwner(existing)) throw new Error("Invalid runtime ownership file; refusing to remove it.");
        if (pidAlive(existing.pid)) return null;
        // Serialize stale-owner recovery so two launchers cannot unlink each other's new lock.
        const recovery = paths.lock + ".recovery";
        try { await link(temporary, recovery); }
        catch (recoveryError) { if (hasCode(recoveryError, "EEXIST")) return null; throw recoveryError; }
        try {
          let current: unknown;
          try { current = JSON.parse(await readFile(paths.lock, "utf8")); }
          catch (readError) { if (!hasCode(readError, "ENOENT")) throw readError; }
          if (isOwner(current) && pidAlive(current.pid)) return null;
          await rm(paths.lock, { force: true });
          try { await link(temporary, paths.lock); }
          catch (claimError) { if (hasCode(claimError, "EEXIST")) return null; throw claimError; }
          claimed = true;
          break;
        } finally { await rm(recovery, { force: true }); }
      }
    }
    if (!claimed) throw new Error("Runtime ownership changed repeatedly; try connecting again.");
    await rm(paths.socket, { force: true });
    return async () => {
      let current: unknown;
      try { current = JSON.parse(await readFile(paths.lock, "utf8")); }
      catch (error) { if (hasCode(error, "ENOENT")) return; throw error; }
      if (isOwner(current) && current.token === token) {
        await rm(paths.socket, { force: true });
        await rm(paths.lock, { force: true });
      }
    };
  } finally { await rm(temporary, { force: true }); }
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (hasCode(error, "ESRCH")) return false; throw error; }
}
function isOwner(value: unknown): value is { pid: number; token: string } {
  return !!value && typeof value === "object" && "pid" in value && Number.isInteger(value.pid) && Number(value.pid) > 0
    && "token" in value && typeof value.token === "string";
}
function hasCode(error: unknown, code: string): boolean { return !!error && typeof error === "object" && "code" in error && error.code === code; }
