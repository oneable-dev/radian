import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageInfo from "../../package.json";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { defaultPreferences, fetchSnapshot, RuntimeClient } from "../runtime/client.ts";
import { daemonPaths, pidAlive, privateDirectory } from "../runtime/storage.ts";
import { expectOk } from "../testing/results.ts";
import type { RuntimeSnapshot } from "../runtime/protocol.ts";

const entry = join(import.meta.dir, "..", "index.ts");

async function run(args: string[], cwd: string, config: string, state: string) {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: config,
      XDG_CONFIG_HOME: config,
      PI_CODING_AGENT_DIR: join(config, "pi"),
      RADIAN_STATE_DIR: state,
      BUN_OPTIONS: "",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill("SIGTERM"), 10000);
  try {
    const code = await child.exited;

    return { code, stdout: await stdout, stderr: await stderr };
  } finally {
    clearTimeout(timer);
  }
}

test("Real help, version, invalid arguments, and non-TTY startup never read corrupt settings or create runtime state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "radian-cli-entry-"));
  const config = join(directory, "config");
  const state = join(directory, "state");
  try {
    await mkdir(join(config, "radian"), { recursive: true });
    for (const name of ["workspace.json", "keybindings.json", "theme.json"]) {
      await writeFile(join(config, "radian", name), "{broken");
    }

    const help = await run(["--help"], directory, config, state);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: radian");
    expect(help.stderr).toBe("");

    const version = await run(["--version"], directory, config, state);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe(packageInfo.version);

    const invalid = await run(["--unknown"], directory, config, state);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("INVALID_INPUT");

    const pipe = await run(["--demo"], directory, config, state);
    expect(pipe.code).toBe(1);
    expect(pipe.stderr).toContain("requires a TTY");

    // Internal roles reject missing IPC before discovery, settings or SDK initialization.
    const supervisor = await run(["--terminal-supervisor"], directory, config, state);
    expect(supervisor.code).toBe(1);
    expect(supervisor.stderr).toContain(
      "[INVALID_INPUT] Terminal supervisor requires a parent IPC connection.",
    );
    for (const result of [help, version, invalid, pipe, supervisor]) {
      expect(result.stdout + result.stderr).not.toContain("\x1b");
    }

    // Informational output and rejected entry must not create state directories.
    expect(await readdir(directory)).toEqual(["config"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);

test("Shared runtime status and stop work outside Git and TTY without starting absent services", async () => {
  const fixture = await createWorktreeFixture();
  const state = join(fixture.directory, "state");
  const config = join(fixture.directory, "config");
  try {
    await mkdir(join(config, "radian"), { recursive: true });
    await writeFile(join(config, "radian", "workspace.json"), "{broken");
    for (const operation of ["status", "stop"]) {
      const result = await run(
        ["runtime", operation, "--test-runtime", "--state-dir", state],
        fixture.directory,
        config,
        state,
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("No running workspace service.");
      expect(result.stderr).toBe("");
    }

    expect(await readdir(fixture.directory)).not.toContain("state");
  } finally {
    await fixture.cleanup();
  }
}, 20000);

// Preload only the isolated child daemon; lifecycle requests still use the real CLI and server.
const delayedSnapshotPreload = `
import { appendFileSync, existsSync } from "node:fs";
if (process.argv.includes("--runtime-service")) {
  const directory = process.env.RADIAN_RETRY_FIXTURE;
  const mode = process.env.RADIAN_RETRY_DELAY;
  const record = (event) => appendFileSync(directory + "/requests.jsonl", JSON.stringify({ ...event, pid: process.pid }) + "\\n");
  record({ type: "launch" });
  const serve = Bun.serve.bind(Bun);
  let snapshots = 0;
  const delays = new Set();
  const delay = (milliseconds) => new Promise((resolve) => {
    const pending = { resolve, timer: setTimeout(() => { delays.delete(pending); resolve(); }, milliseconds) };
    delays.add(pending);
  });
  Bun.serve = (options) => serve({
    ...options,
    fetch: async (request, server) => {
      const path = new URL(request.url).pathname;
      if (path === "/snapshot") {
        const attempt = ++snapshots;
        record({ type: "snapshot", attempt });
        if (!existsSync(directory + "/no-delay") && (mode !== "first" || attempt === 1)) {
          await delay(mode === "timeout" ? 10000 : 750);
        }
      } else if (request.method === "POST") {
        const body = await request.clone().text();
        record({ type: "mutation", path, body });
        if (path === "/command" && JSON.parse(body).type === "stop") {
          for (const pending of delays) { clearTimeout(pending.timer); pending.resolve(); }
          delays.clear();
        }
      }
      return options.fetch(request, server);
    },
  });
}
`;

type RequestRecord = { type: string; pid: number; body?: string; attempt?: number };

async function retryRecords(directory: string): Promise<RequestRecord[]> {
  return (await readFile(join(directory, "requests.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RequestRecord);
}

for (const mode of ["first", "persistent", "timeout"]) {
  test(`Real restart ${mode} snapshot delays preserve bounded GET retries and single launch`, async () => {
    // Each app has a private home/config/state and never discovers production sessions.
    const directory = await mkdtemp(join(tmpdir(), "radian-cli-retry-"));
    const home = join(directory, "home");
    const state = join(directory, "state");
    const config = join(directory, "config");
    const preload = join(directory, "delay.js");
    await mkdir(home);
    await mkdir(config);
    await writeFile(preload, delayedSnapshotPreload);
    const paths = daemonPaths(true, state);
    let fixturePid: number | undefined;
    async function restart() {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "--config=/dev/null",
          entry,
          "runtime",
          "restart",
          "--test-runtime",
          "--state-dir",
          state,
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            HOME: home,
            XDG_CONFIG_HOME: config,
            PI_CODING_AGENT_DIR: join(home, "pi"),
            RADIAN_STATE_DIR: state,
            RADIAN_RETRY_FIXTURE: directory,
            RADIAN_RETRY_DELAY: mode,
            BUN_OPTIONS: `--preload=${preload}`,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      const started = Date.now();
      const timer = setTimeout(() => child.kill("SIGTERM"), 20000);
      let code: number;
      try {
        code = await child.exited;
      } finally {
        clearTimeout(timer);
      }
      return { code, output: await stdout, error: await stderr, elapsed: Date.now() - started };
    }
    try {
      const { code, output, error, elapsed } = await restart();
      const records = await retryRecords(directory);
      fixturePid = records.find((record) => record.type === "launch")!.pid;

      // Failed reads retry until the deadline, then terminate instead of launching again or
      // reporting a false success.
      const snapshots = records.filter((record) => record.type === "snapshot");
      expect(records.filter((record) => record.type === "launch")).toHaveLength(1);
      expect(records.filter((record) => record.type === "mutation")).toHaveLength(0);
      if (mode === "timeout") expect(snapshots.length).toBeGreaterThan(4);
      else expect(snapshots).toHaveLength(2);
      expect(code).toBe(mode === "timeout" ? 1 : 0);
      expect(elapsed).toBeLessThan(mode === "timeout" ? 18000 : 11000);
      if (mode === "timeout") {
        expect(error).toContain("CONNECTION_TIMEOUT");
        expect(error).toContain("not confirmed");
        expect(output).not.toContain("Shared daemon restarted");
      } else {
        expect(error).toBe("");
        expect(output).toContain("Shared daemon restarted");
      }
      // A failed confirmation does not imply the runtime was rolled back or absent.
      await writeFile(join(directory, "no-delay"), "");
      const ready = expectOk(await fetchSnapshot(paths))!;
      expect(ready.pid).toBe(fixturePid);
      expect(ready.capabilities).not.toContain("daemon-starting");
      expect(pidAlive(fixturePid)).toBe(true);

      if (mode === "persistent") {
        // Exercise the same delay while inspecting and replacing an already running owner.
        await rm(join(directory, "no-delay"));
        const replaced = await restart();
        const after = await retryRecords(directory);
        const launches = after.filter((record) => record.type === "launch");
        const previousPid = fixturePid;
        fixturePid = launches.at(-1)!.pid;

        expect(replaced.code).toBe(0);
        expect(replaced.error).toBe("");
        expect(replaced.output).toContain("Shared daemon restarted");
        expect(launches).toHaveLength(2);
        expect(
          after
            .filter((record) => record.type === "mutation")
            .map((record) => JSON.parse(record.body!)),
        ).toEqual([{ type: "stop" }]);
        expect(fixturePid).not.toBe(previousPid);
        expect(pidAlive(previousPid)).toBe(false);
        await writeFile(join(directory, "no-delay"), "");
        const replacement = expectOk(await fetchSnapshot(paths))!;
        expect(replacement.pid).toBe(fixturePid);
        expect(replacement.instance).not.toBe(ready.instance);
        expect(replacement.capabilities).not.toContain("daemon-starting");
      }
    } finally {
      // Only the process recorded by this fixture may receive a stop command or signal.
      await writeFile(join(directory, "no-delay"), "");
      const records = await retryRecords(directory).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
      });
      fixturePid = records.findLast((record) => record.type === "launch")?.pid ?? fixturePid;
      if (fixturePid !== undefined) {
        expect(Number.isSafeInteger(fixturePid)).toBe(true);
        expect(fixturePid).toBeGreaterThan(1);
        expect(fixturePid).not.toBe(process.pid);
        const snapshot = expectOk(await fetchSnapshot(paths));
        if (snapshot) {
          expect(snapshot.pid).toBe(fixturePid);
          const client = new RuntimeClient(paths, snapshot);
          try {
            expectOk(await client.stopRuntime());
          } finally {
            await client.disconnect();
          }
        }
        const deadline = Date.now() + 5000;
        while (pidAlive(fixturePid) && Date.now() < deadline) await Bun.sleep(20);
        expect(pidAlive(fixturePid)).toBe(false);
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 35000);
}

function administrativeSnapshot(): RuntimeSnapshot {
  return {
    version: 1,
    pid: process.pid,
    instance: "fixture-owner",
    repositoryId: "radian:shared",
    mode: "offline",
    capabilities: ["shared-daemon"],
    repositories: [],
    details: {},
    closingCount: 0,
    preferences: defaultPreferences(),
    notice: "",
  };
}

for (const replacement of [false, true]) {
  test(`Real CLI shutdown observation ${replacement ? "refuses a replacement" : "retries a delayed response"} without resending stop`, async () => {
    // The controlled endpoint retains ownership while shutdown observations are delayed.
    const directory = await mkdtemp(join(tmpdir(), "radian-cli-shutdown-"));
    const state = join(directory, "state");
    const paths = daemonPaths(true, state);
    await privateDirectory(paths.directory);
    const snapshot = administrativeSnapshot();
    let stops = 0;
    let observations = 0;
    let close: ReturnType<typeof setTimeout> | undefined;
    const server = Bun.serve({
      unix: paths.socket,
      fetch: async (request) => {
        if (new URL(request.url).pathname === "/command") {
          expect(await request.json()).toEqual({ type: "stop" });
          expect(request.headers.get("X-Radian-Instance")).toBe(snapshot.instance);
          stops++;
          if (!replacement)
            close = setTimeout(() => {
              void server.stop(true);
            }, 1800);
          return Response.json({ ok: true, value: null });
        }
        if (stops) {
          observations++;
          if (!replacement) await Bun.sleep(750);
        }
        return Response.json({
          ...snapshot,
          instance: replacement && stops ? "replacement-owner" : snapshot.instance,
          capabilities: [...snapshot.capabilities!, ...(stops ? ["daemon-stopping"] : [])],
        });
      },
    });
    try {
      const result = await run(
        ["runtime", replacement ? "restart" : "stop", "--test-runtime", "--state-dir", state],
        directory,
        join(directory, "config"),
        state,
      );

      expect(stops).toBe(1);
      expect(observations).toBeGreaterThanOrEqual(replacement ? 1 : 2);
      expect(result.code).toBe(replacement ? 1 : 0);
      if (replacement) {
        expect(result.stderr).toContain("Another daemon replaced the stopped instance");
        expect(result.stdout).not.toContain("Shared daemon restarted");
      } else {
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("Workspace service stopped");
      }
    } finally {
      if (close) clearTimeout(close);
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 15000);
}
