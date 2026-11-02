import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "typebox/value";
import { replySchema, type RuntimeSnapshot } from "./protocol.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { WorkspaceClient } from "./workspace-client.ts";
import { defaultPreferences, fetchSnapshot, RuntimeClient } from "./client.ts";
import { connectRuntime, ensureSharedDaemon, prepareWorkspace } from "./lifecycle.ts";
import { workspaceSource } from "../app/settings.ts";
import { CHAT_SCOPE_ID } from "../agents/session-scope.ts";
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
    expect(daemon.capabilities).toContain("recursive-delegation");
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

test("runtime restart replaces shared processes outside Git and rediscovers the remembered workspace", async () => {
  // Prepare restart commands from cwd unrelated to the workspace source.
  const fixture = await createWorktreeFixture();
  const stateRoot = join(fixture.directory, "state");
  const config = join(fixture.directory, "settings.json");
  await writeFile(config, JSON.stringify({ workspace: { roots: [fixture.main], maxDepth: 0 } }));
  expectOk(
    await prepareWorkspace(workspaceSource({ config, cwd: fixture.main }), {
      offline: true,
      stateRoot,
    }),
  );
  const before = expectOk(
    await fetchSnapshot(runtimePaths(fixture.repository.id, true, stateRoot)),
  )!;
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

test("Concurrent TUI attachments share the daemon catalog, and re-entry discovers newly configured repositories", async () => {
  // Two same-config TUIs start concurrently against an absent daemon.
  const a = await createWorktreeFixture();
  const b = await createWorktreeFixture();
  const stateRoot = join(a.directory, "state");
  const config = join(a.directory, "settings.json");
  const options = { offline: true, stateRoot };
  const workspaces: WorkspaceClient[] = [];
  await writeFile(config, JSON.stringify({ workspace: { roots: [a.main], maxDepth: 0 } }));
  try {
    const source = workspaceSource({ config, cwd: a.main });
    for (const opened of await Promise.all([
      WorkspaceClient.attach(source, options),
      WorkspaceClient.attach(source, options),
    ])) {
      workspaces.push(expectOk(opened));
    }

    // Both mirror one daemon-owned membership; no client registered its own list.
    const daemon = expectOk(await fetchSnapshot(daemonPaths(true, stateRoot)))!;
    expect(daemon.repositories.map((repo) => repo.id)).toEqual([a.repository.id]);
    for (const workspace of workspaces) {
      expect(workspace.snapshot.repositories.map((repo) => repo.id)).toEqual([a.repository.id]);
    }

    // Re-entry after a config edit asks the daemon to rediscover; existing TUIs follow its snapshot.
    await writeFile(
      config,
      JSON.stringify({ workspace: { roots: [a.main, b.main], maxDepth: 0 } }),
    );
    workspaces.push(expectOk(await WorkspaceClient.attach(source, options)));
    for (const workspace of workspaces) {
      await until(() =>
        workspace.snapshot.repositories.some((repo) => repo.id === b.repository.id),
      );
    }

    expect(expectOk(await fetchSnapshot(daemonPaths(true, stateRoot)))!.pid).toBe(daemon.pid);
    expect(
      expectOk(await fetchSnapshot(runtimePaths(b.repository.id, true, stateRoot)))!.capabilities,
    ).toContain("repository-catalog");
  } finally {
    await Promise.all(workspaces.map((workspace) => workspace.disconnect()));
    await stop(stateRoot);
    await a.cleanup();
    await b.cleanup();
  }
}, 30000);

test("A conflicting policy refresh is rejected before the remembered source or catalog changes", async () => {
  // A running repository enforces the first settings file's session policy.
  const fixture = await createWorktreeFixture();
  const stateRoot = join(fixture.directory, "state");
  const first = join(fixture.directory, "first.json");
  const second = join(fixture.directory, "second.json");
  const workspace = { workspace: { roots: [fixture.main], maxDepth: 0 } };
  await writeFile(first, JSON.stringify(workspace));
  await writeFile(second, JSON.stringify(workspace));
  const options = { offline: true, stateRoot };
  try {
    const source = workspaceSource({ config: first, cwd: fixture.main });
    expectOk(await prepareWorkspace(source, options));

    // The other file would silently change that running policy, so nothing is adopted.
    const rejected = await prepareWorkspace(
      workspaceSource({ config: second, cwd: fixture.main }),
      options,
    );

    expect(expectError(rejected).code).toBe("INVALID_INPUT");
    const registry = JSON.parse(await readFile(daemonPaths(true, stateRoot).manifest, "utf8"));
    expect(registry.source).toEqual(source);
    expect(
      expectOk(await fetchSnapshot(daemonPaths(true, stateRoot)))!.repositories.map(
        (repo) => repo.id,
      ),
    ).toEqual([fixture.repository.id]);

    // A refresh that excludes the repository is allowed without stopping its live host.
    await writeFile(second, JSON.stringify({ workspace: { roots: [], maxDepth: 0 } }));
    expectOk(
      await prepareWorkspace(workspaceSource({ config: second, cwd: fixture.directory }), options),
    );
    expect(expectOk(await fetchSnapshot(daemonPaths(true, stateRoot)))!.repositories).toEqual([]);
  } finally {
    await stop(stateRoot);
    await fixture.cleanup();
  }
}, 30000);

test("Status and stop never adopt or discover a workspace source", async () => {
  // A daemon without a remembered source has no membership owner and lists nothing.
  const fixture = await createWorktreeFixture();
  const stateRoot = join(fixture.directory, "state");
  try {
    const started = expectOk(await ensureSharedDaemon({ offline: true, stateRoot }));
    expect(started.repositories).toEqual([]);
    expect(started.capabilities).toContain("workspace-source");

    await stop(stateRoot);
    const registry = await readFile(daemonPaths(true, stateRoot).manifest, "utf8").catch(
      () => null,
    );
    expect(registry === null || JSON.parse(registry).source === undefined).toBe(true);
  } finally {
    await stop(stateRoot);
    await fixture.cleanup();
  }
}, 20000);

test("Every attached TUI receives explicit deletion summaries and cannot save deleted drafts back", async () => {
  // Two workspaces share one daemon; one still holds the deleted draft in memory.
  const fixture = await createWorktreeFixture();
  const stateRoot = join(fixture.directory, "state");
  const config = join(fixture.directory, "settings.json");
  const options = { offline: true, stateRoot };
  const workspaces: WorkspaceClient[] = [];
  await writeFile(config, JSON.stringify({ workspace: { roots: [fixture.main], maxDepth: 0 } }));
  try {
    const source = workspaceSource({ config, cwd: fixture.main });
    workspaces.push(expectOk(await WorkspaceClient.attach(source, options)));
    workspaces.push(expectOk(await WorkspaceClient.attach(source, options)));
    const [first, stale] = workspaces as [WorkspaceClient, WorkspaceClient];
    const deleted = expectOk(await first.create(fixture.feature));
    const kept = expectOk(await first.create(fixture.main));
    const drafts = first.snapshot.preferences;
    drafts.drafts[deleted] = "deleted draft";
    drafts.drafts[kept] = "kept draft";
    drafts.selection.worktreeId = fixture.feature;
    expectOk(await first.savePreferences(drafts));
    await until(() => stale.snapshot.details[deleted] !== undefined);
    const stalePreferences = structuredClone(drafts);

    await rm(fixture.feature, { recursive: true });
    for (const workspace of workspaces) {
      await until(
        () =>
          workspace.snapshot.deletedScopes?.scopes.some(
            (scope) => scope.worktreeIds.includes(fixture.feature) && scope.state === "reopened",
          ) === true,
      );
    }

    // Memory is scrubbed from the explicit summary, never inferred from catalog absence.
    expect(stale.snapshot.preferences.drafts[deleted]).toBeUndefined();
    expect(stale.snapshot.preferences.selection.worktreeId).not.toBe(fixture.feature);
    expect(
      stale.snapshot.repositories.flatMap((repo) => repo.worktrees.map((tree) => tree.id)),
    ).not.toContain(fixture.feature);

    expectOk(await stale.savePreferences(stalePreferences));
    const manifest = JSON.parse(
      await readFile(runtimePaths(fixture.repository.id, true, stateRoot).manifest, "utf8"),
    ) as { preferences: { drafts: Record<string, string> } };
    expect(manifest.preferences.drafts[deleted]).toBeUndefined();
    expect(manifest.preferences.drafts[kept]).toBe("kept draft");
    expect(stale.snapshot.preferences.drafts[kept]).toBe("kept draft");
  } finally {
    await Promise.all(workspaces.map((workspace) => workspace.disconnect()));
    await stop(stateRoot);
    await fixture.cleanup();
  }
}, 40000);

test("Snapshots carry session state while event streams deliver only transcript changes", async () => {
  // Lifecycle probes read snapshots; transcripts there grew with every conversation and change.
  const fixture = await createWorktreeFixture();
  const stateRoot = join(fixture.directory, "state");
  const config = join(fixture.directory, "settings.json");
  await writeFile(config, JSON.stringify({ workspace: { roots: [fixture.main], maxDepth: 0 } }));
  let workspace: WorkspaceClient | undefined;
  let cancelEvents: (() => Promise<void>) | undefined;
  try {
    workspace = expectOk(
      await WorkspaceClient.attach(workspaceSource({ config, cwd: fixture.main }), {
        offline: true,
        stateRoot,
      }),
    );
    const repositorySession = expectOk(await workspace.create(fixture.main));
    const chatSession = expectOk(await workspace.create(CHAT_SCOPE_ID));
    expectOk(await workspace.prompt(repositorySession, "hello"));
    expectOk(await workspace.prompt(chatSession, "hello"));
    const completed = (id: string) => workspace!.snapshot.details[id]?.status === "complete";
    await until(() => completed(repositorySession) && completed(chatSession));

    // Snapshots keep session state for stop warnings and command identity only.
    const repositoryPaths = runtimePaths(fixture.repository.id, true, stateRoot);
    const shared = expectOk(await fetchSnapshot(daemonPaths(true, stateRoot)))!;
    const repository = expectOk(await fetchSnapshot(repositoryPaths))!;
    for (const [details, id] of [
      [shared.details, repositorySession],
      [shared.details, chatSession],
      [shared.chat!.details, chatSession],
      [repository.details, repositorySession],
    ] as const) {
      expect(details[id]?.status).toBe("complete");
      expect(details[id]?.conversationId).toBeTruthy();
      expect(details[id]).not.toHaveProperty("sections");
    }

    // TUIs rebuild repository and CHAT transcripts from their event streams.
    const delivered = workspace.snapshot.details[repositorySession]!.sections!;
    expect(delivered.length).toBeGreaterThan(0);
    expect(workspace.snapshot.details[chatSession]?.sections?.length).toBeGreaterThan(0);

    // A later run sends new sections without resending the ones this stream already delivered.
    const response = await fetch("http://localhost/events?transcripts=1", {
      unix: repositoryPaths.socket,
    });
    const events = response.body!.getReader();
    cancelEvents = () => events.cancel();
    const decoder = new TextDecoder();
    let buffered = "";
    const next = async (): Promise<RuntimeSnapshot> => {
      while (!buffered.includes("\n")) {
        const chunk = await events.read();
        if (chunk.done) throw new Error("Event stream ended.");
        buffered += decoder.decode(chunk.value, { stream: true });
      }
      const line = buffered.slice(0, buffered.indexOf("\n"));
      buffered = buffered.slice(line.length + 1);
      return JSON.parse(line) as RuntimeSnapshot;
    };
    const first = await next();
    expect(first.details[repositorySession]).not.toHaveProperty("sections");
    expect(first.transcripts?.[repositorySession]?.ids).toEqual(delivered.map((item) => item.id));

    expectOk(await workspace.prompt(repositorySession, "again"));
    const resent = new Set<string>();
    let order = first.transcripts![repositorySession]!.ids!;
    for (;;) {
      const frame = await next();
      const update = frame.transcripts?.[repositorySession];
      for (const item of update?.sections ?? []) resent.add(item.id);
      order = update?.ids ?? order;
      if (
        order.length > delivered.length &&
        frame.details[repositorySession]?.status === "complete"
      )
        break;
    }
    expect(delivered.filter((item) => resent.has(item.id))).toEqual([]);
    await until(
      () => workspace!.snapshot.details[repositorySession]?.sections?.length === order.length,
    );
  } finally {
    await cancelEvents?.();
    await workspace?.disconnect();
    await stop(stateRoot);
    await fixture.cleanup();
  }
}, 40000);
