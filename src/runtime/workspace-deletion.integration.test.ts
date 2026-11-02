import { expect, test } from "bun:test";
import { Value } from "typebox/value";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { fetchSnapshot, RuntimeClient } from "./client.ts";
import { connectRuntime } from "./lifecycle.ts";
import { emptyPreferences, replySchema, type RuntimeSnapshot } from "./protocol.ts";
import { daemonPaths, pidAlive, runtimePaths, RuntimeStore } from "./storage.ts";
import type { SessionRecord } from "../agents/session-registry.ts";
import { planFilePath, saveTaskPlan } from "../agents/task-plan-store.ts";
import { transcriptText } from "../testing/transcript-text.ts";

// Every test owns a temporary repository, state root and daemon; removals target fixtures only.
const entry = join(import.meta.dir, "..", "index.ts");

async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Not observed: ${label}`);
    await Bun.sleep(20);
  }
}

type Manifest = {
  records: { id: string; worktreeId?: string }[];
  preferences: { drafts: Record<string, string> };
};

async function setup() {
  const fixture = await createWorktreeFixture();
  const stateRoot = join(fixture.directory, "state");
  const config = join(fixture.directory, "settings.json");
  const paths = daemonPaths(true, stateRoot);
  const runtime = runtimePaths(fixture.repository.id, true, stateRoot);
  const children: Bun.Subprocess[] = [];
  const clients: RuntimeClient[] = [];
  const configure = (roots: readonly string[]) =>
    writeFile(
      config,
      JSON.stringify({ workspace: { roots, maxDepth: 0 }, sessions: { retentionDays: null } }),
    );
  await configure([fixture.main]);

  const snapshot = async (): Promise<RuntimeSnapshot> => expectOk(await fetchSnapshot(paths))!;
  const worktreeIds = async () =>
    (await snapshot()).repositories.flatMap((repo) => repo.worktrees.map((tree) => tree.id));
  const stop = async () => {
    const current = expectOk(await fetchSnapshot(paths));
    if (!current) return;
    const admin = new RuntimeClient(paths, current);
    try {
      expectOk(await admin.stopRuntime());
      await until(() => !pidAlive(current.pid), "fixture daemon stop");
    } finally {
      await admin.disconnect();
    }
  };

  return {
    ...fixture,
    stateRoot,
    paths,
    runtime,
    configure,
    snapshot,
    worktreeIds,
    stop,
    manifest: async () => JSON.parse(await readFile(runtime.manifest, "utf8")) as Manifest,
    async refresh(cwd = fixture.main) {
      const current = await snapshot();
      const response = await fetch("http://localhost/workspace", {
        unix: paths.socket,
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Radian-Instance": current.instance },
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
      if (!Value.Check(replySchema, reply) || !reply.ok) {
        throw new Error(`Workspace refresh rejected: ${JSON.stringify(reply)}`);
      }
    },
    async launch(cwd = fixture.main) {
      const child = Bun.spawn(
        [
          process.execPath,
          entry,
          "--runtime-service",
          "--test-runtime",
          "--state-dir",
          stateRoot,
          "--config",
          config,
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
      void errors.catch((error) => console.error("Fixture daemon diagnostics failed:", error));
      await until(async () => {
        if (child.exitCode !== null) throw new Error(`Fixture daemon exited: ${await errors}`);
        const current = expectOk(await fetchSnapshot(paths));
        return current !== null && !current.capabilities?.includes("daemon-starting");
      }, "headless startup");
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
    async completed(token?: string) {
      await until(async () => {
        const scopes = (await snapshot()).deletedScopes?.scopes ?? [];
        return scopes.some(
          (scope) => (token === undefined || scope.token === token) && scope.state === "reopened",
        );
      }, "completed deletion cleanup");
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

async function transcripts(directory: string): Promise<string[]> {
  const sessions = join(directory, "offline-agent", "sessions");
  const files = await readdir(sessions).catch(() => [] as string[]);

  return files.filter((file) => file.endsWith(".jsonl")).map((file) => join(sessions, file));
}

async function headerCwd(file: string): Promise<string | undefined> {
  const line = (await readFile(file, "utf8")).split("\n")[0];

  return line ? (JSON.parse(line) as { cwd?: string }).cwd : undefined;
}

test("A cold linked deletion purges closed owned files without activating the repository", async () => {
  // Closed records only: cleanup must not depend on an SDK, and foreign originals stay.
  const app = await setup();
  try {
    const foreignDir = join(app.directory, "foreign-sessions");
    const managedDir = join(app.runtime.directory, "offline-agent", "sessions");
    await mkdir(foreignDir, { recursive: true, mode: 0o700 });
    await mkdir(managedDir, { recursive: true, mode: 0o700 });
    const records: SessionRecord[] = [];
    for (const [directory, managed] of [
      [foreignDir, false],
      [managedDir, true],
    ] as const) {
      const id = crypto.randomUUID();
      const sessionFile = join(directory, `${id}.jsonl`);
      await writeFile(
        sessionFile,
        JSON.stringify({ type: "session", version: 3, id, cwd: app.feature }) + "\n",
        { mode: 0o600 },
      );
      records.push({
        id,
        name: managed ? "Owned" : "Foreign",
        worktreeId: app.feature,
        cwd: app.feature,
        sessionFile,
        managed,
        lifecycle: "closed",
        closedAt: 1,
        updatedAt: 1,
        state: { conversationId: id, status: null, output: "Archived", error: null },
        subagents: [],
      });
    }
    const [foreign, owned] = records as [SessionRecord, SessionRecord];
    const original = await readFile(foreign.sessionFile!, "utf8");
    expectOk(
      await saveTaskPlan(
        foreign.sessionFile!,
        { conversationId: foreign.id, cwd: app.feature },
        {
          schemaVersion: 1,
          goal: "Sidecar",
          assumptions: [],
          openQuestions: [],
          outOfScope: [],
          tasks: [
            {
              id: "t",
              title: "T",
              agent: "main",
              dependsOn: [],
              inputs: [],
              outputs: ["o"],
              acceptanceCriteria: ["a"],
              files: [],
            },
          ],
        },
        { summary: "Sidecar", warnings: [] },
      ),
    );
    const preferences = structuredClone(emptyPreferences);
    preferences.drafts[foreign.id] = "deleted draft";
    preferences.drafts[owned.id] = "deleted draft";
    expectOk(
      await new RuntimeStore(app.runtime).save({
        version: 1,
        repositoryId: app.repository.id,
        repositories: [app.repository],
        records,
        preferences,
      }),
    );
    await app.launch();

    await rm(app.feature, { recursive: true });
    await app.completed();

    expect((await app.snapshot()).capabilities).not.toContain("repository-runtime");
    expect(await readFile(foreign.sessionFile!, "utf8")).toBe(original);
    expect(await Bun.file(planFilePath(foreign.sessionFile!)).exists()).toBe(false);
    expect(await Bun.file(owned.sessionFile!).exists()).toBe(false);
    const saved = await app.manifest();
    expect(saved.records).toEqual([]);
    expect(saved.preferences.drafts).toEqual({});
    expect(await app.worktreeIds()).toEqual([app.main]);
  } finally {
    await app.cleanup();
  }
}, 40000);

test("Deleting a linked worktree stops its live sessions and terminals but keeps its siblings", async () => {
  // Both worktrees run an Agent; only the deleted checkout may lose processes and data.
  const app = await setup();
  try {
    await app.launch();
    const client = await app.connect();
    const deleted = expectOk(await client.create(app.feature));
    const sibling = expectOk(await client.create(app.main));
    expectOk(await client.prompt(deleted, "read"));
    expectOk(await client.prompt(sibling, "read"));
    await until(
      () =>
        transcriptText(client.snapshot.details[deleted]).includes("feature-worktree-marker") ===
          true &&
        transcriptText(client.snapshot.details[sibling]).includes("main-worktree-marker") === true,
      "both transcripts",
    );
    const terminal = expectOk(await client.createTerminal(app.feature, { cols: 80, rows: 24 }));
    await until(
      () => client.snapshot.terminals?.some((item) => item.id === terminal) === true,
      "scoped terminal",
    );
    const terminalPid = client.snapshot.terminals!.find((item) => item.id === terminal)!.pid;
    const preferences = client.snapshot.preferences;
    preferences.drafts[deleted] = "deleted scope draft";
    preferences.drafts[sibling] = "sibling draft";
    expectOk(await client.savePreferences(preferences));
    expectOk(await client.prompt(deleted, "slow"));
    await until(() => client.snapshot.details[deleted]?.status === "working", "working run");
    const daemonPid = client.snapshot.pid;
    const files = await transcripts(app.runtime.directory);
    const featureFiles: string[] = [];
    for (const file of files) if ((await headerCwd(file)) === app.feature) featureFiles.push(file);
    expect(featureFiles.length).toBeGreaterThan(0);

    await rm(app.feature, { recursive: true });
    await app.completed();

    expect(await app.worktreeIds()).not.toContain(app.feature);
    expect(await app.worktreeIds()).toContain(app.main);
    expect(client.snapshot.details[deleted]).toBeUndefined();
    expect(client.snapshot.details[sibling]?.conversationId).toBeDefined();
    await until(() => !pidAlive(terminalPid), "scoped terminal process exit");
    for (const file of featureFiles) expect(await Bun.file(file).exists()).toBe(false);
    const saved = await app.manifest();
    expect(saved.records.some((record) => record.worktreeId === app.feature)).toBe(false);
    expect(saved.records.some((record) => record.id === sibling)).toBe(true);
    expect(saved.preferences.drafts[deleted]).toBeUndefined();
    expect(saved.preferences.drafts[sibling]).toBe("sibling draft");
    expect((await app.snapshot()).pid).toBe(daemonPid);

    // New work at the deleted path is rejected; the sibling remains usable.
    expectError(await client.create(app.feature));
    expectOk(await client.prompt(sibling, "read"));

    // A stale client cannot restore the deleted draft after cleanup.
    expectOk(await client.savePreferences(preferences));
    await until(async () => {
      const current = await app.manifest();
      return current.preferences.drafts[sibling] === "sibling draft";
    }, "sibling draft after stale save");
    expect((await app.manifest()).preferences.drafts[deleted]).toBeUndefined();
  } finally {
    await app.cleanup();
  }
}, 40000);

test("A worktree recreated at the same path is a fresh generation without old sessions", async () => {
  // Old cleanup authority cannot erase the new checkout, and old data cannot reappear in it.
  const app = await setup();
  try {
    await app.launch();
    const client = await app.connect();
    const old = expectOk(await client.create(app.feature));
    expectOk(await client.prompt(old, "read"));
    await until(
      () =>
        transcriptText(client.snapshot.details[old]).includes("feature-worktree-marker") === true,
      "old transcript",
    );

    await rm(app.feature, { recursive: true });
    await app.completed();
    await app.git(app.main, ["worktree", "prune"]);
    await app.git(app.main, ["worktree", "add", app.feature, "feature/probe"]);
    await app.refresh();
    await until(async () => (await app.worktreeIds()).includes(app.feature), "recreated row");

    const fresh = expectOk(await client.create(app.feature));
    expect(fresh).not.toBe(old);
    expectOk(await client.prompt(fresh, "read"));
    await until(
      () =>
        transcriptText(client.snapshot.details[fresh]).includes("feature-worktree-marker") === true,
      "fresh transcript",
    );
    expect(client.snapshot.details[old]).toBeUndefined();
    await Bun.sleep(300);
    const saved = await app.manifest();
    expect(saved.records.some((record) => record.id === fresh)).toBe(true);
    expect(saved.records.some((record) => record.id === old)).toBe(false);
    expect(await Bun.file(app.feature).exists()).toBe(false);
    expect(await readFile(join(app.feature, "workspace.txt"), "utf8")).toContain("feature");
  } finally {
    await app.cleanup();
  }
}, 40000);

test("Deleting a whole repository removes its owned runtime state but preserves CHAT and others", async () => {
  // The common Git directory and every checkout disappear; another repository stays attached.
  const app = await setup();
  const other = await createWorktreeFixture();
  try {
    await app.configure([app.main, other.main]);
    await app.launch();
    const client = await app.connect();
    const session = expectOk(await client.create(app.feature));
    expectOk(await client.prompt(session, "read"));
    await until(
      () =>
        transcriptText(client.snapshot.details[session]).includes("feature-worktree-marker") ===
        true,
      "transcript",
    );
    await until(
      async () => (await app.snapshot()).repositories.some((r) => r.id === other.repository.id),
      "other repository",
    );
    const owned = await transcripts(app.runtime.directory);
    expect(owned.length).toBeGreaterThan(0);
    const otherRuntime = runtimePaths(other.repository.id, true, app.stateRoot);
    const otherState = (await readdir(otherRuntime.directory)).sort();

    await rm(app.feature, { recursive: true });
    await rm(app.main, { recursive: true });
    await until(async () => {
      const scopes = (await app.snapshot()).deletedScopes?.scopes ?? [];
      return scopes.some((scope) => scope.kind === "repository" && scope.state === "reopened");
    }, "repository cleanup");

    const current = await app.snapshot();
    expect(current.repositories.some((repo) => repo.id === app.repository.id)).toBe(false);
    expect(current.repositories.some((repo) => repo.id === other.repository.id)).toBe(true);
    expect(await Bun.file(app.runtime.manifest).exists()).toBe(false);
    for (const file of owned) expect(await Bun.file(file).exists()).toBe(false);
    expect((await readdir(otherRuntime.directory)).sort()).toEqual(otherState);
    const registry = JSON.parse(await readFile(app.paths.manifest, "utf8")) as {
      repositories: { repositoryId: string }[];
    };
    expect(registry.repositories.some((entry) => entry.repositoryId === app.repository.id)).toBe(
      false,
    );
  } finally {
    await app.cleanup();
    await other.cleanup();
  }
}, 40000);

test("A durable pending cleanup resumes after restart without activating the deleted scope", async () => {
  // The ledger records confirmed evidence; the restarted daemon finishes it cold.
  const app = await setup();
  try {
    await app.launch();
    const client = await app.connect();
    const session = expectOk(await client.create(app.feature));
    expectOk(await client.prompt(session, "read"));
    await until(
      () =>
        transcriptText(client.snapshot.details[session]).includes("feature-worktree-marker") ===
        true,
      "transcript",
    );
    await client.disconnect();
    await app.stop();

    // A fenced master receipt written by an earlier daemon that stopped before its purge.
    const token = "f".repeat(64);
    await mkdir(app.paths.directory, { recursive: true });
    await writeFile(
      join(app.paths.directory, "workspace-cleanup.json"),
      JSON.stringify({
        version: 1,
        revision: 1,
        receipts: [
          {
            token,
            repositoryId: app.repository.id,
            kind: "worktrees",
            worktrees: [{ id: app.feature, path: app.feature }],
            sessionIds: [],
            revision: 1,
            state: "fenced",
            updatedAt: Date.now(),
          },
        ],
      }),
      { mode: 0o600 },
    );
    await rm(app.feature, { recursive: true });
    await app.launch();
    await app.completed(token);

    const saved = await app.manifest();
    expect(saved.records.some((record) => record.worktreeId === app.feature)).toBe(false);
    const current = await app.snapshot();
    expect(
      current.deletedScopes?.scopes.find((scope) => scope.token === token)?.sessionIds,
    ).toEqual(expect.arrayContaining([session]));
    expect(current.repositories.some((repo) => repo.worktrees.some((t) => t.id === app.main))).toBe(
      true,
    );
  } finally {
    await app.cleanup();
  }
}, 40000);

test("Renaming a live worktree still preserves its sessions and records", async () => {
  // A rename produces no unlink evidence, so the existing preservation contract applies.
  const app = await setup();
  const moved = join(app.directory, "moved-feature");
  try {
    await app.launch();
    const client = await app.connect();
    const session = expectOk(await client.create(app.feature));
    expectOk(await client.prompt(session, "read"));
    await until(
      () =>
        transcriptText(client.snapshot.details[session]).includes("feature-worktree-marker") ===
        true,
      "transcript",
    );
    const files = await transcripts(app.runtime.directory);

    await rename(app.feature, moved);
    await app.refresh();
    await Bun.sleep(500);

    expect(client.snapshot.details[session]?.conversationId).toBeDefined();
    expect((await app.snapshot()).deletedScopes?.scopes ?? []).toEqual([]);
    for (const file of files) expect(await Bun.file(file).exists()).toBe(true);
  } finally {
    await app.cleanup();
  }
}, 40000);

test("Deleting the only launch context of an empty-roots workspace leaves no fabricated cwd", async () => {
  // roots=[] membership comes from launch contexts; a deleted cwd cannot be rediscovered.
  const app = await setup();
  try {
    await app.configure([]);
    await app.launch(app.main);
    await until(
      async () => (await app.snapshot()).repositories.some((r) => r.id === app.repository.id),
      "context repository",
    );

    await rm(app.feature, { recursive: true });
    await rm(app.main, { recursive: true });
    await until(async () => {
      const scopes = (await app.snapshot()).deletedScopes?.scopes ?? [];
      return scopes.some((scope) => scope.kind === "repository" && scope.state === "reopened");
    }, "repository cleanup");

    const current = await app.snapshot();
    expect(current.repositories).toEqual([]);
    expect(current.chat).toBeDefined();
    const registry = JSON.parse(await readFile(app.paths.manifest, "utf8")) as {
      source?: { cwd: string; cwdRemoved?: true; contexts?: string[] };
    };
    expect(registry.source?.cwdRemoved).toBe(true);
    expect(registry.source?.contexts ?? []).not.toContain(app.main);
  } finally {
    await app.cleanup();
  }
}, 40000);
