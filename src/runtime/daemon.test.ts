import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "typebox/value";
import { replySchema, type RuntimeSnapshot } from "./protocol.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { WorkspaceClient } from "./workspace-client.ts";
import { defaultPreferences, fetchSnapshot, RuntimeClient } from "./client.ts";
import { connectRuntime, ensureSharedDaemon } from "./lifecycle.ts";
import {
  acquireRuntime,
  daemonPaths,
  pidAlive,
  privateDirectory,
  runtimePaths,
  RuntimeStore,
} from "./storage.ts";

const entry = join(import.meta.dir, "..", "index.ts");

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error("Shared daemon observation timed out.");
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function stop(stateRoot: string): Promise<void> {
  const paths = daemonPaths(true, stateRoot);
  const snapshot = expectOk(await fetchSnapshot(paths));
  if (!snapshot) {
    return;
  }

  const client = new RuntimeClient(paths, snapshot);
  try {
    expectOk(await client.stopRuntime());
    await until(() => !pidAlive(snapshot.pid));
  } finally {
    await client.disconnect();
  }
}

test("Concurrent registrations across repositories share one process with isolated storage and instances", async () => {
  // Connect two independent repositories concurrently to one state root.
  const a = await createWorktreeFixture();
  const b = await createWorktreeFixture();
  const stateRoot = join(a.directory, "state");
  const options = { offline: true, stateRoot, start: false, register: true };
  const clients: RuntimeClient[] = [];
  try {
    // Competing startup requests converge on per-repository channels in one daemon.
    for (const client of await Promise.all(
      [a, b, a, b].map((fixture) => connectRuntime(fixture.repository, fixture.main, options)),
    )) {
      const connected = expectOk(client);
      if (!connected) {
        throw new Error("Missing catalog client.");
      }

      clients.push(connected);
    }

    const daemon = expectOk(await fetchSnapshot(daemonPaths(true, stateRoot)))!;

    // Shared management PID still preserves storage, instance, and SDK lifetimes.
    expect(new Set(clients.map((client) => client.snapshot.pid))).toEqual(new Set([daemon.pid]));
    expect(clients[0]!.snapshot.instance).not.toBe(clients[1]!.snapshot.instance);
    expect(runtimePaths(a.repository.id, true, stateRoot).directory).not.toBe(
      runtimePaths(b.repository.id, true, stateRoot).directory,
    );
    expect(daemon.repositories).toHaveLength(2);
    for (const client of clients) {
      expect(client.snapshot.capabilities).toContain("repository-catalog");
    }

    expect(daemon.details).toEqual({});
    expect(daemon.editors).toEqual([]);
    expect(daemon.terminals).toEqual([]);

    // Process counters are available even while repositories remain SDK-free catalogs.
    for (const client of clients) {
      const resources = expectOk(await client.resources());
      expect(resources.pid).toBe(daemon.pid);
      expect(resources.rssBytes).toBeGreaterThan(0);
      expect(resources.cpuMicros).toBeGreaterThanOrEqual(0);

      const unchanged = expectOk(
        await fetchSnapshot(runtimePaths(client.snapshot.repositoryId, true, stateRoot)),
      )!;
      expect(unchanged.capabilities).toContain("repository-catalog");
      expect(unchanged.capabilities).not.toContain("agent-dashboard");
      expect(unchanged.details).toEqual({});
    }

    const unfenced = await fetch("http://localhost/resources", {
      unix: runtimePaths(a.repository.id, true, stateRoot).socket,
    });
    expect(unfenced.status).toBe(422);

    // Invalid control instances and repository IDs leave processes and registrations untouched.
    for (const [path, instance, body, code] of [
      ["/command", "stale-owner", { type: "stop" }, "PROTOCOL_ERROR"],
      [
        "/repositories",
        daemon.instance,
        { repositoryId: b.repository.id, cwd: a.main },
        "PROTOCOL_ERROR",
      ],
      ["/repositories", daemon.instance, { cwd: a.main }, "INVALID_INPUT"],
    ] as const) {
      const response = await fetch(`http://localhost${path}`, {
        unix: daemonPaths(true, stateRoot).socket,
        method: "POST",
        headers: { "X-Radian-Instance": instance },
        body: JSON.stringify(body),
      });
      const rejected = await response.json();
      if (
        !Value.Check(replySchema, rejected) ||
        rejected.ok ||
        typeof rejected.error === "string"
      ) {
        throw new Error("Expected a typed registration rejection.");
      }

      expect(rejected.error.code).toBe(code);
    }

    expect(expectOk(await fetchSnapshot(daemonPaths(true, stateRoot)))!.pid).toBe(daemon.pid);
    expect(expectOk(await fetchSnapshot(daemonPaths(true, stateRoot)))!.repositories).toHaveLength(
      2,
    );

    const changedConfig = expectError(
      await connectRuntime(a.repository, a.main, {
        ...options,
        config: join(a.directory, "different-settings.json"),
      }),
    );
    expect(changedConfig.code).toBe("INVALID_INPUT");
  } finally {
    await Promise.all(clients.map((client) => client.disconnect()));
    await stop(stateRoot);
    await a.cleanup();
    await b.cleanup();
  }
}, 20000);

test("Shared daemon catalogs detect worktrees without TUIs and retain drafts through activation", async () => {
  // Register SDK-free repositories and save only UI drafts.
  const fixture = await createWorktreeFixture();
  const stateRoot = join(fixture.directory, "state");
  const options = { offline: true, stateRoot };
  const paths = runtimePaths(fixture.repository.id, true, stateRoot);
  let workspace: WorkspaceClient | undefined;
  try {
    await privateDirectory(paths.directory);

    const saved = defaultPreferences();
    saved.selection.sessions[fixture.main] = "saved";
    saved.drafts.saved = "previous draft";
    expectOk(
      await new RuntimeStore(paths).save({
        version: 1,
        repositoryId: fixture.repository.id,
        repositories: [fixture.repository],
        records: [],
        preferences: saved,
      }),
    );
    workspace = expectOk(
      await WorkspaceClient.open([fixture.repository], fixture.main, options, connectRuntime),
    );

    const preferences = workspace.snapshot.preferences;
    preferences.drafts.saved = "keep cold draft";
    expectOk(await workspace.savePreferences(preferences));

    const catalog = expectOk(await fetchSnapshot(paths))!;
    await workspace.disconnect();
    workspace = undefined;

    // Daemon watchers detect externally created worktrees without UI.
    const added = join(fixture.directory, "daemon-watched");
    await fixture.git(fixture.main, ["worktree", "add", "-b", "daemon-watched", added]);
    await until(async () =>
      expectOk(await fetchSnapshot(paths))!.repositories[0]!.worktrees.some(
        (tree) => tree.path === added,
      ),
    );

    // Activation neither launches new processes nor resets per-repository drafts.
    workspace = expectOk(
      await WorkspaceClient.open([fixture.repository], fixture.main, options, connectRuntime),
    );
    expect(expectOk(await fetchSnapshot(paths))!.capabilities).toContain("repository-catalog");
    expectOk(await workspace.activate(added));

    const active = expectOk(await fetchSnapshot(paths))!;
    expect(active.pid).toBe(catalog.pid);
    expect(active.instance).toBe(catalog.instance);
    expect(active.preferences.drafts.saved).toBe("keep cold draft");
    expect(active.capabilities).toContain("repository-runtime");
  } finally {
    await workspace?.disconnect();
    await stop(stateRoot);
    await fixture.cleanup();
  }
}, 20000);

test("Shared daemons never steal live legacy ownership or overwrite saved files", async () => {
  // Prepare actual lock files representing legacy state ownership.
  const fixture = await createWorktreeFixture();
  const stateRoot = join(fixture.directory, "state");
  const paths = runtimePaths(fixture.repository.id, true, stateRoot);

  await privateDirectory(paths.directory);

  const release = await acquireRuntime(paths);
  if (!release) {
    throw new Error("Missing fixture ownership.");
  }

  const original = "legacy-owned-data";
  await writeFile(paths.manifest, original, { mode: 0o600 });
  try {
    // Refuse runtime registration while existing owners remain alive.
    const result = await connectRuntime(fixture.repository, fixture.main, {
      offline: true,
      stateRoot,
    });

    // Preserve ownership and source data rather than converting errors into empty state.
    expect(expectError(result).code).toBe("CONNECTION_FAILED");
    expect(await readFile(paths.manifest, "utf8")).toBe(original);
    expect(JSON.parse(await readFile(paths.lock, "utf8")).pid).toBe(process.pid);
    expect(pidAlive(process.pid)).toBe(true);
    expect(expectOk(await fetchSnapshot(daemonPaths(true, stateRoot)))!.repositories).toEqual([]);
  } finally {
    await stop(stateRoot);
    await release();
    await fixture.cleanup();
  }
}, 20000);

test("Closing shared owners block registration until sockets/locks release before fresh startup", async () => {
  // Prepare live ownership and management sockets that outlast repository channels.
  const fixture = await createWorktreeFixture();
  const stateRoot = join(fixture.directory, "state");
  const paths = daemonPaths(true, stateRoot);

  await privateDirectory(paths.directory);

  const release = await acquireRuntime(paths);
  if (!release) {
    throw new Error("Missing shutdown fixture ownership.");
  }

  const closing: RuntimeSnapshot = {
    version: 1,
    pid: process.pid,
    instance: "closing-daemon",
    repositoryId: "radian:shared",
    mode: "offline",
    capabilities: ["shared-daemon", "daemon-stopping"],
    repositories: [],
    details: {},
    closingCount: 0,
    preferences: defaultPreferences(),
    notice: "",
  };
  let probes = 0;
  let settled = false;
  let server: Bun.Server<undefined> | undefined = Bun.serve({
    unix: paths.socket,
    fetch: () => {
      probes++;

      return Response.json(closing);
    },
  });
  const starting = ensureSharedDaemon({ offline: true, stateRoot });
  const observed = starting.then((result) => {
    settled = true;

    return result;
  });
  try {
    // Closing markers prevent adopting old processes as ready new owners.
    await until(() => probes >= 2);
    expect(settled).toBe(false);
    await server.stop(true);
    server = undefined;
    await release();

    const started = expectOk(await observed);

    // Successors are fresh live processes and never killed existing owners.
    expect(started.pid).not.toBe(process.pid);
    expect(started.instance).not.toBe(closing.instance);
    expect(started.capabilities).not.toContain("daemon-stopping");
    expect(pidAlive(process.pid)).toBe(true);
  } finally {
    await server?.stop(true);
    await release();
    await observed;
    await stop(stateRoot);
    await fixture.cleanup();
  }
}, 20000);

test("Corrupt shared registrations survive startup failures and cleanup without empty overwrites", async () => {
  // Supply incompatible registration files to real daemon entry points.
  const fixture = await createWorktreeFixture();
  const stateRoot = join(fixture.directory, "state");
  const paths = daemonPaths(true, stateRoot);
  const original = '{"version":99,"repositories":[]}';

  await privateDirectory(paths.directory);
  await writeFile(paths.manifest, original, { mode: 0o600 });
  try {
    // Rejected startup cleanup must not save a fresh empty registry over source files.
    const child = Bun.spawn(
      [process.execPath, entry, "--runtime-service", "--test-runtime", "--state-dir", stateRoot],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    // Report stable storage errors and preserve recovery source.
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("STORAGE_FAILED");
    expect(await readFile(paths.manifest, "utf8")).toBe(original);
    expect(expectOk(await fetchSnapshot(paths))).toBeNull();
  } finally {
    await fixture.cleanup();
  }
}, 20000);

test("runtime restart replaces shared processes outside Git and restores registered catalogs", async () => {
  // Prepare restart commands from cwd unrelated to registered repositories.
  const fixture = await createWorktreeFixture();
  const stateRoot = join(fixture.directory, "state");
  const options = { offline: true, stateRoot, start: false, register: true };
  const client = expectOk(await connectRuntime(fixture.repository, fixture.main, options));
  if (!client) {
    throw new Error("Missing catalog.");
  }

  const before = client.snapshot;
  await client.disconnect();
  try {
    // Locate targets through state roots/modes without Git discovery or UI settings.
    const process = Bun.spawn(
      [Bun.which("bun")!, entry, "runtime", "restart", "--test-runtime", "--state-dir", stateRoot],
      { cwd: fixture.directory, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);

    // New-PID shared daemons restore catalogs and old processes terminate.
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Shared daemon restarted");
    await until(
      async () =>
        expectOk(await fetchSnapshot(runtimePaths(fixture.repository.id, true, stateRoot))) !==
        null,
    );

    const after = expectOk(
      await fetchSnapshot(runtimePaths(fixture.repository.id, true, stateRoot)),
    )!;
    expect(after.pid).not.toBe(before.pid);
    expect(after.instance).not.toBe(before.instance);
    expect(pidAlive(before.pid)).toBe(false);
    expect(after.capabilities).toContain("repository-catalog");
    expect(after.repositories[0]!.id).toBe(fixture.repository.id);
  } finally {
    await stop(stateRoot);
    await fixture.cleanup();
  }
}, 20000);
