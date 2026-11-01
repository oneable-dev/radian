import { expect, test } from "bun:test";
import { Value } from "typebox/value";
import { replySchema } from "./protocol.ts";
import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { fetchSnapshot, RuntimeClient } from "./client.ts";
import { connectRuntime } from "./lifecycle.ts";
import { daemonPaths, pidAlive, runtimePaths } from "./storage.ts";

const entry = join(import.meta.dir, "..", "index.ts");

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Headless workspace state was not observed.");
    await Bun.sleep(20);
  }
}

async function setup() {
  const fixture = await createWorktreeFixture();
  const stateRoot = join(fixture.directory, "state");
  const config = join(fixture.directory, "settings.json");
  const paths = daemonPaths(true, stateRoot);
  const children: Bun.Subprocess[] = [];
  const clients: RuntimeClient[] = [];
  const configure = (roots: readonly string[]) =>
    writeFile(
      config,
      JSON.stringify({ workspace: { roots, maxDepth: 0 }, sessions: { retentionDays: null } }),
    );
  await configure([fixture.main]);

  const stop = async () => {
    const snapshot = expectOk(await fetchSnapshot(paths));
    if (snapshot) {
      const admin = new RuntimeClient(paths, snapshot);
      try {
        expectOk(await admin.stopRuntime());
        await until(() => !pidAlive(snapshot.pid));
      } finally {
        await admin.disconnect();
      }
    }
  };

  return {
    ...fixture,
    stateRoot,
    config,
    paths,
    configure,
    stop,
    async refresh(cwd = fixture.main) {
      const snapshot = expectOk(await fetchSnapshot(paths))!;
      const response = await fetch("http://localhost/workspace", {
        unix: paths.socket,
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Radian-Instance": snapshot.instance },
        body: JSON.stringify({
          source: {
            settings: { path: config, explicit: true },
            workspace: {
              path: join(fixture.directory, "isolated-config", "radian", "workspace.json"),
              explicit: false,
            },
            cwd,
          },
        }),
      });
      const reply: unknown = await response.json();
      if (!Value.Check(replySchema, reply)) throw new Error("Invalid workspace refresh reply.");
      expect(reply.ok).toBe(true);
      if (!reply.ok) throw new Error(`Workspace refresh rejected: ${JSON.stringify(reply.error)}`);
    },
    async launch(explicitConfig = true, cwd = fixture.main) {
      const child = Bun.spawn(
        [
          process.execPath,
          entry,
          "--runtime-service",
          "--test-runtime",
          "--state-dir",
          stateRoot,
          ...(explicitConfig ? ["--config", config] : []),
        ],
        {
          cwd,
          env: { ...process.env, XDG_CONFIG_HOME: join(fixture.directory, "isolated-config") },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      children.push(child);
      const errors = new Response(child.stderr).text();
      // Retain diagnostics without filling the subprocess pipe while tests inspect its HTTP state.
      void errors.catch((error) =>
        console.error("Fixture daemon diagnostic stream failed:", error),
      );
      await until(async () => {
        if (child.exitCode !== null) throw new Error(`Headless daemon exited: ${await errors}`);
        const snapshot = expectOk(await fetchSnapshot(paths));
        return snapshot !== null && !snapshot.capabilities?.includes("daemon-starting");
      });
      return child;
    },
    async connect() {
      const client = expectOk(
        await connectRuntime(fixture.repository, fixture.main, {
          offline: true,
          stateRoot,
          config,
        }),
      );
      if (!client) throw new Error("Expected the discovered repository endpoint.");
      clients.push(client);
      return client;
    },
    async cleanup() {
      try {
        await Promise.all(clients.map((client) => client.disconnect()));
        await stop();
      } finally {
        for (const child of children) {
          if (child.exitCode === null) child.kill("SIGTERM");
          await child.exited;
        }
        await fixture.cleanup();
      }
    },
  };
}

test.each(["editor", "terminal"] as const)(
  "The final %s stays usable after repository removal and releases only its own host",
  async (kind) => {
    // Real PTYs belong solely to this fixture; deleting a catalog member cannot terminate their owners.
    const app = await setup();
    const moved = join(app.directory, "moved-with-live-resource");
    let renamed = false;
    let disconnect: (() => Promise<void>) | undefined;
    try {
      await app.launch();
      const client = await app.connect();
      const id = expectOk(
        await (kind === "editor"
          ? client.openEditor(app.main)
          : client.createTerminal(app.main, { cols: 80, rows: 24 })),
      );
      let ready = false;
      let exited = false;
      const errors: unknown[] = [];
      const connection = expectOk(
        await (kind === "editor"
          ? client.attachEditor(
              id,
              (frame) => {
                ready = frame.ansi.includes("NVIM");
                exited = frame.exited;
              },
              (error) => errors.push(error),
            )
          : client.attachTerminal(
              id,
              () => {
                ready = true;
              },
              (error) => errors.push(error),
            )),
      );
      disconnect = () => connection.disconnect();
      await until(() => ready);
      const resource = (
        kind === "editor" ? client.snapshot.editors : client.snapshot.terminals
      )!.find((item) => item.id === id)!;
      const daemonPid = client.snapshot.pid;

      // A prepared missing catalog still admits attachment/reuse of existing resources, never their replacement.
      await rename(app.main, moved);
      renamed = true;
      await app.refresh();
      expect(pidAlive(resource.pid)).toBe(true);
      expect(errors).toEqual([]);
      if (kind === "editor") {
        expect(expectOk(await client.openEditor(app.main))).toBe(id);
        connection.input(Buffer.from(":qa!\r"));
        await until(() => exited);
        await connection.disconnect();
      } else {
        connection.input(Buffer.from("printf preserved > retained-terminal.txt\r"));
        await until(() => Bun.file(join(moved, "retained-terminal.txt")).exists());
        await connection.disconnect();
        expectOk(await client.closeTerminal(id));
      }

      // The last owned process is released without stopping the shared daemon or deleting restoration metadata.
      await until(
        async () =>
          !expectOk(await fetchSnapshot(app.paths))!.repositories.some(
            (repo) => repo.id === app.repository.id,
          ),
      );
      expect(expectOk(await fetchSnapshot(app.paths))!.pid).toBe(daemonPid);
      expect(pidAlive(resource.pid)).toBe(false);
      expect(
        await Bun.file(runtimePaths(app.repository.id, true, app.stateRoot).manifest).exists(),
      ).toBe(true);
    } finally {
      await disconnect?.();
      if (renamed) await rename(moved, app.main);
      await app.cleanup();
    }
  },
  25000,
);

test("A rejected TUI cannot replace remembered workspace state while starting an absent daemon", async () => {
  // The first source and CHAT binding are durable before a different TUI attempts to start the owner.
  const app = await setup();
  const other = await createWorktreeFixture();
  const { connectChatRuntime } = await import("./lifecycle.ts");
  const { WorkspaceClient } = await import("./workspace-client.ts");
  const { workspaceSource } = await import("../app/settings.ts");
  try {
    await app.launch();
    const chat = expectOk(
      await connectChatRuntime({ offline: true, stateRoot: app.stateRoot, config: app.config }),
    );
    await chat.disconnect();
    await app.stop();
    const alternate = join(other.directory, "alternate.json");
    await writeFile(alternate, JSON.stringify({ workspace: { roots: [other.main], maxDepth: 0 } }));

    // Startup must carry the attachment guard, not commit B before the later HTTP guard rejects it.
    const rejected = await WorkspaceClient.attach(
      workspaceSource({ config: alternate, cwd: other.main }),
      {
        offline: true,
        stateRoot: app.stateRoot,
      },
    );

    expect(expectError(rejected).code).toBe("INVALID_INPUT");
    const current = expectOk(await fetchSnapshot(app.paths))!;
    expect(current.repositories.map((repo) => repo.id)).toEqual([app.repository.id]);
    const saved = JSON.parse(await readFile(app.paths.manifest, "utf8"));
    expect(saved.source.settings.path).toBe(app.config);
    expect(saved.chatConfig).toBe(app.config);
    expect(
      expectOk(await fetchSnapshot(runtimePaths(other.repository.id, true, app.stateRoot))),
    ).toBeNull();
  } finally {
    await app.cleanup();
    await other.cleanup();
  }
}, 25000);

test.each(["ancestor", "depth"] as const)(
  "Uncertain discovery cannot retain repositories excluded by the new %s scope",
  async (kind) => {
    // Rooted scans are descendant/depth bounded, unlike roots=[] discovery from inside a checkout.
    const app = await setup();
    const other = kind === "depth" ? await createWorktreeFixture() : undefined;
    const denied = other?.directory ?? join(app.main, "private-subdirectory");
    if (!other) await mkdir(denied);
    try {
      if (other)
        await writeFile(
          app.config,
          JSON.stringify({ workspace: { roots: [other.directory], maxDepth: 1 } }),
        );
      await app.launch();
      expect(expectOk(await fetchSnapshot(app.paths))!.repositories.length).toBe(1);
      await chmod(denied, 0o000);
      await app.configure([denied]);

      // Permission failure cannot expand the freshly selected depth-zero root to its parent or children.
      await app.refresh();

      const current = expectOk(await fetchSnapshot(app.paths))!;
      expect(current.repositories).toEqual([]);
      expect(current.notice).toContain("STORAGE_FAILED");
    } finally {
      await chmod(denied, 0o755);
      await app.cleanup();
      await other?.cleanup();
    }
  },
  20000,
);

test("Headless source persistence defers CHAT retention until its policy is selected", async () => {
  // A source-only restart must not latch an unrelated default CHAT cleanup policy first.
  const app = await setup();
  const { connectChatRuntime } = await import("./lifecycle.ts");
  let chat: RuntimeClient | undefined;
  try {
    await app.launch();
    await app.stop();
    await mkdir(join(app.directory, "isolated-config", "radian"), { recursive: true });
    await writeFile(
      join(app.directory, "isolated-config", "radian", "settings.json"),
      "{broken-default",
    );
    await app.launch(false, app.directory);

    // The first actual CHAT attachment selects the valid explicit file, not the new process default.
    chat = expectOk(
      await connectChatRuntime({ offline: true, stateRoot: app.stateRoot, config: app.config }),
    );

    expect(chat.snapshot.notice).not.toContain("CHAT retention failed");
    expect(expectOk(await fetchSnapshot(app.paths))!.notice).not.toContain("CHAT retention failed");
    const saved = JSON.parse(await readFile(app.paths.manifest, "utf8"));
    expect(saved.chatConfig).toBe(app.config);
  } finally {
    await chat?.disconnect();
    await app.cleanup();
  }
}, 20000);

test("Failed initial workspace discovery cannot be bypassed through low-level registration", async () => {
  // The selected source exists, but its invalid settings cannot establish authoritative membership.
  const app = await setup();
  try {
    await writeFile(app.config, "{broken");
    await app.launch();

    const rejected = await connectRuntime(app.repository, app.main, {
      offline: true,
      stateRoot: app.stateRoot,
      config: app.config,
      start: false,
      register: true,
    });

    expect(expectError(rejected).code).toBe("INVALID_INPUT");
    expect(expectOk(await fetchSnapshot(app.paths))!.repositories).toEqual([]);
    expect(
      expectOk(await fetchSnapshot(runtimePaths(app.repository.id, true, app.stateRoot))),
    ).toBeNull();
  } finally {
    await app.cleanup();
  }
}, 20000);

test("Rejected CHAT policy attachments do not replace an already prepared workspace", async () => {
  // Two disjoint catalogs would otherwise bypass the per-repository policy conflict guard.
  const app = await setup();
  const other = await createWorktreeFixture();
  const { connectChatRuntime } = await import("./lifecycle.ts");
  let chat: RuntimeClient | undefined;
  try {
    await app.launch();
    chat = expectOk(
      await connectChatRuntime({ offline: true, stateRoot: app.stateRoot, config: app.config }),
    );
    const alternate = join(other.directory, "settings.json");
    await writeFile(alternate, JSON.stringify({ workspace: { roots: [other.main], maxDepth: 0 } }));
    const before = expectOk(await fetchSnapshot(app.paths))!;

    // The existing CHAT guard must reject the attachment before source, catalog or state changes.
    const response = await fetch("http://localhost/workspace", {
      unix: app.paths.socket,
      method: "POST",
      headers: { "X-Radian-Instance": before.instance },
      body: JSON.stringify({
        attachChat: true,
        source: {
          settings: { path: alternate, explicit: true },
          workspace: { path: join(other.directory, "workspace.json"), explicit: false },
          cwd: other.main,
        },
      }),
    });
    const reply: unknown = await response.json();
    if (!Value.Check(replySchema, reply)) throw new Error("Invalid workspace rejection reply.");

    expect(reply.ok).toBe(false);
    const after = expectOk(await fetchSnapshot(app.paths))!;
    expect(after.repositories.map((repo) => repo.id)).toEqual([app.repository.id]);
    expect(after.instance).toBe(before.instance);
    const saved = JSON.parse(await readFile(app.paths.manifest, "utf8"));
    expect(saved.source.settings.path).toBe(app.config);
    expect(saved.chatConfig).toBe(app.config);
  } finally {
    await chat?.disconnect();
    await app.cleanup();
    await other.cleanup();
  }
}, 20000);

test("A failing scan retains its own previous scope but cannot retain an explicitly excluded repository", async () => {
  // An unavailable root is not evidence that another, removed configuration scope remains a member.
  const app = await setup();
  const denied = join(app.directory, "denied-root");
  await mkdir(denied);
  try {
    await app.launch();
    await chmod(app.main, 0o000);
    await app.refresh();
    expect(expectOk(await fetchSnapshot(app.paths))!.repositories.map((repo) => repo.id)).toEqual([
      app.repository.id,
    ]);
    await chmod(app.main, 0o755);
    await chmod(denied, 0o000);
    await app.configure([denied]);

    // Failure in the new unrelated scope must not resurrect the old scope merely because it still exists.
    await app.refresh();

    const snapshot = expectOk(await fetchSnapshot(app.paths))!;
    expect(snapshot.repositories).toEqual([]);
    expect(snapshot.notice).toContain("STORAGE_FAILED");
  } finally {
    await chmod(app.main, 0o755);
    await chmod(denied, 0o755);
    await app.cleanup();
  }
}, 20000);

test("Migrated active repositories retain their explicit per-repository session policy", async () => {
  // Workspace discovery settings need not be the legacy active repository's retention-policy file.
  const app = await setup();
  const policy = join(app.directory, "original-policy.json");
  await writeFile(policy, JSON.stringify({ sessions: { retentionDays: null } }));
  const { privateDirectory } = await import("./storage.ts");
  await privateDirectory(app.paths.directory);
  await writeFile(
    app.paths.manifest,
    JSON.stringify({
      version: 1,
      repositories: [
        { repositoryId: app.repository.id, cwd: app.main, active: true, config: policy },
      ],
    }),
  );
  try {
    await app.launch();
    const paths = runtimePaths(app.repository.id, true, app.stateRoot);
    await until(
      async () => expectOk(await fetchSnapshot(paths))?.sessionRetention?.retentionDays === null,
    );

    // Metadata is applied, not replaced with the discovery configuration's file reference.
    const saved = JSON.parse(await readFile(app.paths.manifest, "utf8"));
    expect(
      saved.repositories.find(
        (repo: { repositoryId: string }) => repo.repositoryId === app.repository.id,
      ).config,
    ).toBe(policy);
  } finally {
    await app.cleanup();
  }
}, 20000);

test("Remembered implicit session policy does not move with the restarting process configuration home", async () => {
  // Only the original implicit file is authoritative; a new default at another XDG location is unrelated.
  const app = await setup();
  const original = join(app.directory, "original-default.json");
  await writeFile(original, JSON.stringify({ sessions: { retentionDays: null } }));
  await mkdir(join(app.directory, "isolated-config", "radian"), { recursive: true });
  await writeFile(
    join(app.directory, "isolated-config", "radian", "settings.json"),
    JSON.stringify({ sessions: { retentionDays: 1 } }),
  );
  const { privateDirectory } = await import("./storage.ts");
  await privateDirectory(app.paths.directory);
  await writeFile(
    app.paths.manifest,
    JSON.stringify({
      version: 2,
      source: {
        settings: { path: original, explicit: false },
        workspace: { path: join(app.directory, "workspace.json"), explicit: false },
        cwd: app.main,
      },
      repositories: [{ repositoryId: app.repository.id, active: true, implicitConfig: original }],
    }),
  );
  try {
    await app.launch(false, app.directory);
    const paths = runtimePaths(app.repository.id, true, app.stateRoot);
    await until(
      async () => expectOk(await fetchSnapshot(paths))?.sessionRetention?.retentionDays === null,
    );

    expect(expectOk(await fetchSnapshot(paths))!.sessionRetention?.retentionDays).toBeNull();
    const saved = JSON.parse(await readFile(app.paths.manifest, "utf8"));
    expect(saved.repositories[0].implicitConfig).toBe(original);
  } finally {
    await app.cleanup();
  }
}, 20000);

test("Live first startup discovers implicit default settings without remembered registration sources", async () => {
  // A fresh native daemon may inspect fixture configuration, but must remain cold and never call a model.
  const fixture = await createWorktreeFixture();
  const stateRoot = join(fixture.directory, "native-state");
  const configHome = join(fixture.directory, "default-config");
  const paths = daemonPaths(false, stateRoot);
  await mkdir(join(configHome, "radian"), { recursive: true });
  await writeFile(
    join(configHome, "radian", "settings.json"),
    JSON.stringify({
      workspace: { roots: [fixture.main], maxDepth: 0 },
      sessions: { retentionDays: null },
    }),
  );
  const child = Bun.spawn(
    [process.execPath, entry, "--runtime-service", "--state-dir", stateRoot],
    {
      cwd: fixture.directory,
      env: { ...process.env, XDG_CONFIG_HOME: configHome },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const errors = new Response(child.stderr).text();
  void errors.catch((error) => console.error("Fixture daemon diagnostic stream failed:", error));
  try {
    // No TUI, source flags, persisted registry or repository registration supplies membership.
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`Default daemon exited: ${await errors}`);
      return (
        expectOk(await fetchSnapshot(paths))?.repositories.some(
          (repo) => repo.id === fixture.repository.id,
        ) === true
      );
    });
    const snapshot = expectOk(await fetchSnapshot(paths))!;
    expect(snapshot.details).toEqual({});
    const cold = expectOk(
      await fetchSnapshot(runtimePaths(fixture.repository.id, false, stateRoot)),
    )!;
    expect(cold.capabilities).toContain("repository-catalog");
  } finally {
    const snapshot = expectOk(await fetchSnapshot(paths));
    if (snapshot) {
      const admin = new RuntimeClient(paths, snapshot);
      try {
        expectOk(await admin.stopRuntime());
      } finally {
        await admin.disconnect();
      }
    }
    let forced = false;
    const timer = setTimeout(() => {
      forced = true;
      child.kill("SIGKILL");
    }, 5000);
    try {
      await child.exited;
    } finally {
      clearTimeout(timer);
      await fixture.cleanup();
    }
    expect(forced).toBe(false);
  }
}, 25000);

test("Headless daemon startup discovers current settings and restores active state before TUI attachment", async () => {
  // The daemon is launched directly: no WorkspaceClient or repository registration supplies its catalog.
  const app = await setup();
  try {
    await app.launch();
    await until(async () =>
      expectOk(await fetchSnapshot(app.paths))!.repositories.some(
        (repo) => repo.id === app.repository.id,
      ),
    );
    const cold = expectOk(
      await fetchSnapshot(runtimePaths(app.repository.id, true, app.stateRoot)),
    )!;
    expect(cold.capabilities).toContain("repository-catalog");
    expect(cold.details).toEqual({});
    const client = await app.connect();
    const id = expectOk(await client.create(app.main));
    expectOk(await client.prompt(id, "read"));
    await until(
      () => client.snapshot.details[id]?.output.includes("main-worktree-marker") === true,
    );
    const conversation = client.snapshot.details[id]!.conversationId;
    expect(typeof conversation).toBe("string");
    const preferences = client.snapshot.preferences;
    preferences.selection = { worktreeId: app.main, sessions: { [app.main]: id } };
    preferences.drafts[id] = "preserved draft";
    expectOk(await client.savePreferences(preferences));
    await client.disconnect();
    await app.stop();

    // A changed config and unrelated restart cwd must use the remembered config source and original roots=[] context.
    await app.configure([]);
    await app.launch(false, app.directory);
    await until(
      async () =>
        expectOk(await fetchSnapshot(app.paths))!.details[id]?.conversationId === conversation,
    );
    const restored = expectOk(
      await fetchSnapshot(runtimePaths(app.repository.id, true, app.stateRoot)),
    )!;

    // Previously active conversations and drafts are ready without any TUI connecting or replaying a prompt.
    expect(restored.capabilities).toContain("repository-runtime");
    expect(restored.details[id]?.output).toContain("main-worktree-marker");
    expect(restored.details[id]?.status).not.toBe("working");
    expect(restored.preferences.drafts[id]).toBe("preserved draft");
    expect(restored.preferences.selection.sessions[app.main]).toBe(id);
  } finally {
    await app.cleanup();
  }
}, 30000);

test("Legacy registrations remain restoration metadata and cannot resurrect deleted or out-of-scope repositories", async () => {
  // A v1 registry contains an absent repository and a valid repository outside the selected config.
  const app = await setup();
  const outside = await createWorktreeFixture();
  const missing = join(app.directory, "deleted", ".git");
  const { privateDirectory } = await import("./storage.ts");
  await privateDirectory(app.paths.directory);
  await writeFile(
    app.paths.manifest,
    JSON.stringify({
      version: 1,
      chatConfig: app.config,
      repositories: [
        { repositoryId: missing, cwd: missing, active: true, config: app.config },
        {
          repositoryId: outside.repository.id,
          cwd: outside.main,
          active: true,
          config: app.config,
        },
      ],
    }),
  );
  try {
    await app.launch();
    await until(async () =>
      expectOk(await fetchSnapshot(app.paths))!.repositories.some(
        (repo) => repo.id === app.repository.id,
      ),
    );
    const snapshot = expectOk(await fetchSnapshot(app.paths))!;
    expect(snapshot.repositories.map((repo) => repo.id)).toEqual([app.repository.id]);
    expect(snapshot.notice).not.toContain("GIT_DISCOVERY_FAILED");
    expect(expectOk(await fetchSnapshot(runtimePaths(missing, true, app.stateRoot)))).toBeNull();
    expect(
      expectOk(await fetchSnapshot(runtimePaths(outside.repository.id, true, app.stateRoot))),
    ).toBeNull();

    // The low-level registration API cannot become a second source of current membership.
    const rejected = await connectRuntime(outside.repository, outside.main, {
      offline: true,
      stateRoot: app.stateRoot,
      config: app.config,
    });
    expect(expectError(rejected).code).toBe("INVALID_INPUT");
    expect(expectOk(await fetchSnapshot(app.paths))!.repositories.map((repo) => repo.id)).toEqual([
      app.repository.id,
    ]);

    // Historical active/config intent survives migration even when no current candidate uses it.
    await app.stop();
    const saved = JSON.parse(await readFile(app.paths.manifest, "utf8"));
    expect(
      saved.repositories.find((repo: { repositoryId: string }) => repo.repositoryId === missing),
    ).toMatchObject({ active: true, config: app.config });
    expect(saved.chatConfig).toBe(app.config);
  } finally {
    await app.cleanup();
    await outside.cleanup();
  }
}, 25000);

test("A daemon-only restart reads changed roots rather than restoring its previous registered catalog", async () => {
  // Both repositories exist, so only the latest config can correctly exclude the old candidate.
  const app = await setup();
  const next = await createWorktreeFixture();
  try {
    await app.launch();
    await until(async () =>
      expectOk(await fetchSnapshot(app.paths))!.repositories.some(
        (repo) => repo.id === app.repository.id,
      ),
    );
    await app.connect();
    await app.stop();
    await app.configure([next.main]);

    // Restart without configuration flags proves that selection references, not resolved roots, were persisted.
    await app.launch(false, app.directory);
    await until(async () =>
      expectOk(await fetchSnapshot(app.paths))!.repositories.some(
        (repo) => repo.id === next.repository.id,
      ),
    );
    const snapshot = expectOk(await fetchSnapshot(app.paths))!;

    expect(snapshot.repositories.map((repo) => repo.id)).toEqual([next.repository.id]);
    expect(
      expectOk(await fetchSnapshot(runtimePaths(app.repository.id, true, app.stateRoot))),
    ).toBeNull();
    const cold = expectOk(
      await fetchSnapshot(runtimePaths(next.repository.id, true, app.stateRoot)),
    )!;
    expect(cold.capabilities).toContain("repository-catalog");
    expect(cold.details).toEqual({});
  } finally {
    await app.cleanup();
    await next.cleanup();
  }
}, 25000);

test("Repository disappearance blocks new work but preserves running sessions and archived transcripts", async () => {
  // Runtime state lives outside the repository that this test temporarily removes from its configured root.
  const app = await setup();
  const moved = join(app.directory, "temporarily-moved");
  let renamed = false;
  try {
    await app.launch();
    await until(async () =>
      expectOk(await fetchSnapshot(app.paths))!.repositories.some(
        (repo) => repo.id === app.repository.id,
      ),
    );
    const client = await app.connect();
    const id = expectOk(await client.create(app.main));
    expectOk(await client.prompt(id, "read"));
    await until(
      () => client.snapshot.details[id]?.output.includes("main-worktree-marker") === true,
    );
    const transcripts = join(
      runtimePaths(app.repository.id, true, app.stateRoot).directory,
      "offline-agent",
      "sessions",
    );
    const beforeFiles = (await readdir(transcripts)).filter((file) => file.endsWith(".jsonl"));
    expect(beforeFiles.length).toBeGreaterThan(0);
    const pid = client.snapshot.pid;
    const conversation = client.snapshot.details[id]!.conversationId;
    const preferences = client.snapshot.preferences;
    preferences.drafts[id] = "draft survives missing repository";
    expectOk(await client.savePreferences(preferences));
    expectOk(await client.prompt(id, "slow"));
    await until(() => client.snapshot.details[id]?.status === "working");

    // A completed explicit refresh establishes absence without depending on watcher scheduling.
    await rename(app.main, moved);
    renamed = true;
    await app.refresh();
    expectError(await client.create(app.main));
    expectError(await client.createTerminal(app.main, { cols: 80, rows: 20 }));
    expect(client.snapshot.details[id]?.conversationId).toBe(conversation);
    expect(client.snapshot.details[id]?.status).toBe("working");
    expect(client.snapshot.preferences.drafts[id]).toBe("draft survives missing repository");
    expect(pidAlive(pid)).toBe(true);

    // Existing ownership controls still work, and releasing the final resource removes only its live row.
    expectOk(await client.interrupt(id));
    expectOk(await client.closeSession(id));
    await until(
      async () =>
        !expectOk(await fetchSnapshot(app.paths))!.repositories.some(
          (repo) => repo.id === app.repository.id,
        ),
    );
    expect(expectOk(await fetchSnapshot(app.paths))!.pid).toBe(pid);
    for (const file of beforeFiles)
      expect(await Bun.file(join(transcripts, file)).exists()).toBe(true);
  } finally {
    if (renamed) await rename(moved, app.main);
    await app.cleanup();
  }
}, 30000);

test("Same-config current-repository launches remember explicit entry contexts without a persisted catalog", async () => {
  // Empty roots mean explicit launch contexts, not a list inferred from old registration metadata.
  const app = await setup();
  const second = await createWorktreeFixture();
  try {
    await app.configure([]);
    await app.launch();
    await until(async () =>
      expectOk(await fetchSnapshot(app.paths))!.repositories.some(
        (repo) => repo.id === app.repository.id,
      ),
    );

    // A second TUI using the same settings can contribute its cwd without invalidating the first one.
    await app.refresh(second.main);
    const expected = [app.repository.id, second.repository.id].sort();
    expect(
      expectOk(await fetchSnapshot(app.paths))!
        .repositories.map((repo) => repo.id)
        .sort(),
    ).toEqual(expected);
    await app.stop();
    await app.launch(false, app.directory);
    await until(async () => expectOk(await fetchSnapshot(app.paths))!.repositories.length === 2);

    expect(
      expectOk(await fetchSnapshot(app.paths))!
        .repositories.map((repo) => repo.id)
        .sort(),
    ).toEqual(expected);
  } finally {
    await app.cleanup();
    await second.cleanup();
  }
}, 30000);
