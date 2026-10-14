import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Value } from "typebox/value";
import { manifestSchema, type RuntimeManifest } from "./protocol.ts";
import { capture, parseJson, StorageError, withCleanup, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

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
    throw new StorageError(`Runtime directory is not owned by this user: ${path}`);
  }
  await chmod(path, 0o700);
}

export class RuntimeStore {
  private tail: Promise<Result<void, ExpectedError>> = Promise.resolve(ok(undefined));
  constructor(readonly paths: RuntimePaths) {}

  async load(repositoryId: string): Promise<Result<RuntimeManifest | null, ExpectedError>> {
    const read = await capture(() => readFile(this.paths.manifest, "utf8"));
    if (!read.ok) return read.error instanceof StorageError && read.error.systemCode === "ENOENT" ? ok(null) : read;
    const parsed = parseJson(read.value, "runtime manifest");
    if (!parsed.ok) return err(new StorageError("Invalid runtime manifest; original file was not replaced.", undefined, { cause: parsed.error }));
    const value = parsed.value;
    if (!Value.Check(manifestSchema, value) || value.repositoryId !== repositoryId) return err(new StorageError("Invalid runtime manifest; original file was not replaced."));
    return ok(value);
  }

  save(manifest: RuntimeManifest): Promise<Result<void, ExpectedError>> {
    const task = this.tail.then(() => capture(async () => {
      const temporary = this.paths.manifest + "." + crypto.randomUUID() + ".tmp";
      await withCleanup(async () => {
        await writeFile(temporary, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.paths.manifest);
      }, () => rm(temporary, { force: true }));
    }));
    // Expected failures are values: later writes may recover. Unknown exceptions stay rejected.
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
        try { existing = await readOwner(paths.lock); }
        catch (readError) { if (hasCode(readError, "ENOENT")) continue; throw readError; }
        if (!isOwner(existing)) throw new StorageError("Invalid runtime ownership file; refusing to remove it.");
        if (pidAlive(existing.pid)) return null;
        // Serialize stale-owner recovery so two launchers cannot unlink each other's new lock.
        const recovery = paths.lock + ".recovery";
        try { await link(temporary, recovery); }
        catch (recoveryError) { if (hasCode(recoveryError, "EEXIST")) return null; throw recoveryError; }
        try {
          let current: unknown;
          try { current = await readOwner(paths.lock); }
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
    if (!claimed) throw new StorageError("Runtime ownership changed repeatedly; try connecting again.");
    await rm(paths.socket, { force: true });
    return async () => {
      let current: unknown;
      try { current = await readOwner(paths.lock); }
      catch (error) { if (hasCode(error, "ENOENT")) return; throw error; }
      if (isOwner(current) && current.token === token) {
        await rm(paths.socket, { force: true });
        await rm(paths.lock, { force: true });
      }
    };
  } finally { await rm(temporary, { force: true }); }
}

async function readOwner(path: string): Promise<unknown> {
  const parsed = parseJson(await readFile(path, "utf8"), "runtime ownership");
  if (!parsed.ok) throw new StorageError("Invalid runtime ownership file; refusing to remove it.", undefined, { cause: parsed.error });
  return parsed.value;
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
