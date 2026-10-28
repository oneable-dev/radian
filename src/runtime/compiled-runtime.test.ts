import { expect, test } from "bun:test";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectOk } from "../testing/results.ts";
import type { RuntimeClient } from "./client.ts";
import { connectRuntime } from "./lifecycle.ts";
import { daemonPaths, pidAlive } from "./storage.ts";
import packageInfo from "../../package.json";

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Compiled runtime observation timed out.");
    await Bun.sleep(25);
  }
}

test("Standalone executables manage offline sessions and terminal supervisors outside the source checkout", async () => {
  // Build into a private directory without node_modules and never address a user runtime.
  const fixture = await createWorktreeFixture();
  const entry = join(import.meta.dir, "..", "index.ts");
  const binary = join(fixture.directory, "radian");
  const stateRoot = join(fixture.directory, "state");
  const env = { ...process.env, XDG_CONFIG_HOME: join(fixture.directory, "config") };
  let client: RuntimeClient | undefined;
  const run = async (args: string[]) => {
    const child = Bun.spawn([binary, ...args], {
      cwd: fixture.directory,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  };
  const administrative = (command: string) =>
    run(["runtime", command, "--test-runtime", "--state-dir", stateRoot]);
  try {
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        entry,
        "--outfile",
        binary,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
      build.exited,
    ]);
    expect({ stdout, stderr, code }).toMatchObject({ code: 0 });
    const preloadMarker = join(fixture.directory, "unexpected-preload");
    await Bun.write(join(fixture.directory, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    await Bun.write(
      join(fixture.directory, "preload.ts"),
      `await Bun.write(${JSON.stringify(preloadMarker)}, "unexpected");`,
    );
    await Bun.write(join(fixture.directory, ".env"), "RADIAN_COMPILED_SENTINEL=from-project\n");

    // Basic CLI operations stay independent of discovery and do not start a daemon.
    expect(await run(["--version"])).toEqual({
      stdout: packageInfo.version + "\n",
      stderr: "",
      code: 0,
    });
    expect((await run(["--help"])).stdout).toContain("Usage: radian");
    expect(await administrative("status")).toEqual({
      stdout: "No running workspace service.\n",
      stderr: "",
      code: 0,
    });
    expect(await Bun.file(daemonPaths(true, stateRoot).log).exists()).toBe(false);

    // Native rendering and embedded parser assets must also work away from node_modules.
    let frame = "";
    let detached = false;
    const demo = Bun.spawn([binary, "--demo"], {
      cwd: fixture.directory,
      env: { ...env, TERM: "xterm-256color" },
      terminal: {
        cols: 120,
        rows: 24,
        name: "xterm-256color",
        data(terminal, bytes) {
          frame += new TextDecoder().decode(bytes);
          if (!detached && frame.includes("Workspace")) {
            detached = true;
            terminal.write("\x00d");
          }
        },
      },
    });
    const timeout = setTimeout(() => demo.kill("SIGTERM"), 10000);
    try {
      expect(await demo.exited).toBe(0);
      expect(detached).toBe(true);
    } finally {
      clearTimeout(timeout);
      demo.terminal?.close();
    }

    // The compiled application must relaunch itself without a virtual source-path argument.
    expect(await administrative("restart")).toMatchObject({ code: 0 });
    client =
      expectOk(
        await connectRuntime(fixture.repository, fixture.main, { offline: true, stateRoot }),
      ) ?? undefined;
    if (!client) throw new Error("Compiled daemon did not register the fixture repository.");
    const daemonPid = client.snapshot.pid;
    const tree = fixture.repository.worktrees.find((item) => item.path === fixture.main)!;
    const session = expectOk(await client.create(tree.id));
    expectOk(await client.prompt(session, "read"));
    await until(
      () => client!.snapshot.details[session]?.output.includes("main-worktree-marker") === true,
    );

    const terminal = expectOk(await client.createTerminal(tree.id, { cols: 80, rows: 16 }));
    const failures: unknown[] = [];
    const connection = expectOk(
      await client.attachTerminal(
        terminal,
        () => {},
        (error) => failures.push(error),
      ),
    );
    connection.input(
      Buffer.from(
        'printf "compiled-terminal:%s" "${RADIAN_COMPILED_SENTINEL-unset}" > compiled-marker.txt\r',
      ),
    );
    await until(() => Bun.file(join(fixture.main, "compiled-marker.txt")).exists());
    expect(await Bun.file(join(fixture.main, "compiled-marker.txt")).text()).toBe(
      "compiled-terminal:unset",
    );
    expect(await Bun.file(preloadMarker).exists()).toBe(false);
    const terminalInfo = client.snapshot.terminals!.find((item) => item.id === terminal)!;
    expect(terminalInfo.pid).not.toBe(terminalInfo.shellPid);
    expect(pidAlive(terminalInfo.pid)).toBe(true);

    // Detaching preserves both the owner and its terminal; an explicit stop collects them.
    await connection.disconnect();
    await client.disconnect();
    expect(pidAlive(daemonPid)).toBe(true);
    expect(pidAlive(terminalInfo.shellPid)).toBe(true);
    expect(failures).toEqual([]);
    expect(await administrative("stop")).toMatchObject({ code: 0 });
    await until(
      () => !pidAlive(daemonPid) && !pidAlive(terminalInfo.pid) && !pidAlive(terminalInfo.shellPid),
    );
  } finally {
    await client?.disconnect();
    if (await Bun.file(binary).exists()) {
      const stopped = await administrative("stop");
      expect(stopped.code).toBe(0);
    }
    await fixture.cleanup();
  }
}, 60000);
