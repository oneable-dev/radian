import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "typebox/value";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectOk } from "../testing/results.ts";
import { RuntimeClient } from "./client.ts";
import { emptyPreferences, replySchema, type RuntimeCommand, type RuntimeManifest } from "./protocol.ts";
import { RepositoryHost } from "./repository-host.ts";
import { openRepositoryRuntime, type WorkspaceRuntime } from "./service.ts";
import { privateDirectory, runtimePaths, RuntimeStore } from "./storage.ts";
import { ok } from "../result.ts";

async function setup() {
  const fixture = await createWorktreeFixture();
  const stateRoot = join(fixture.directory, "state"), paths = runtimePaths(fixture.repository.id, true, stateRoot);
  let runtime: WorkspaceRuntime | undefined;
  return { ...fixture, paths, stateRoot,
    async open() {
      if (runtime) expectOk(await runtime.stop());
      runtime = expectOk(await openRepositoryRuntime(fixture.repository.id, true, crypto.randomUUID(), stateRoot));
      return runtime;
    },
    async manifest(): Promise<RuntimeManifest> {
      const saved = expectOk(await new RuntimeStore(paths).load(fixture.repository.id));
      if (!saved) throw new Error("Missing runtime manifest");
      return saved;
    },
    async cleanup() {
      try { if (runtime) expectOk(await runtime.stop()); }
      finally { await fixture.cleanup(); }
    },
  };
}
async function command(runtime: WorkspaceRuntime, command: RuntimeCommand): Promise<string | null> {
  const response = await runtime.fetch(new Request("http://localhost/command", { method: "POST",
    headers: { "X-Radian-Instance": runtime.instance, "Content-Type": "application/json" }, body: JSON.stringify(command) }));
  const body: unknown = await response.json();
  if (!Value.Check(replySchema, body)) throw new Error("Malformed runtime reply");
  expect(body.ok).toBe(true);
  if (!body.ok) throw new Error(JSON.stringify(body.error));
  return body.value;
}
async function create(runtime: WorkspaceRuntime, worktreeId: string): Promise<string> {
  const id = await command(runtime, { type: "create", worktreeId });
  if (!id) throw new Error("Missing session ID");
  return id;
}
function observed(runtime: WorkspaceRuntime, predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("Runtime condition timed out")); }, 5000);
    const unsubscribe = runtime.subscribe(() => {
      if (!predicate()) return;
      clearTimeout(timer); unsubscribe(); resolve();
    });
  });
}
function order(runtime: WorkspaceRuntime, worktreeId: string): readonly string[] {
  return runtime.snapshot.repositories.flatMap(repo => repo.worktrees).find(tree => tree.id === worktreeId)!.sessions.map(session => session.id);
}
function savedOrder(manifest: RuntimeManifest, worktreeId: string): readonly string[] {
  return manifest.repositories.flatMap(repo => repo.worktrees).find(tree => tree.id === worktreeId)!.sessions.map(session => session.id);
}

test("clear retains replaced-conversation tab positions across restart", async () => {
  // Clearing changes the conversation identity, not the tab identity or its position.
  const app = await setup();
  try {
    const runtime = await app.open(), tree = app.repository.worktrees[0]!.id;
    const a = await create(runtime, tree), b = await create(runtime, tree), c = await create(runtime, tree);
    const previous = runtime.snapshot.details[a]!.conversationId!;

    await command(runtime, { type: "session-control", sessionId: a, conversationId: previous, action: "clear" });
    await observed(runtime, () => runtime.snapshot.details[a]?.conversationId !== previous);
    await command(runtime, { type: "prompt", sessionId: a, text: "read" });
    await observed(runtime, () => runtime.snapshot.details[a]?.status === "complete");
    const conversation = runtime.snapshot.details[a]!.conversationId;
    const restored = await app.open();

    // The same tab and persisted replacement conversation return without replaying a prompt.
    expect(order(restored, tree)).toEqual([a, b, c]);
    expect(restored.snapshot.details[a]?.conversationId).toBe(conversation);
    expect(restored.snapshot.details[a]?.sections?.filter(section => section.kind === "user").map(section => section.text)).toEqual(["read"]);
  } finally { await app.cleanup(); }
});

test("History conversations reopened last remain final tabs after restart", async () => {
  // A historical conversation keeps its old storage index but receives a new tab ID.
  const app = await setup();
  try {
    const runtime = await app.open(), tree = app.repository.worktrees[0]!.id;
    const a = await create(runtime, tree), b = await create(runtime, tree);
    await command(runtime, { type: "prompt", sessionId: a, text: "read" });
    await observed(runtime, () => runtime.snapshot.details[a]?.status === "complete");
    const conversation = runtime.snapshot.details[a]!.conversationId!;
    await command(runtime, { type: "close", sessionId: a });
    await observed(runtime, () => runtime.snapshot.closingCount === 0 && !runtime.snapshot.details[a]);

    const reopened = await command(runtime, { type: "resume", worktreeId: tree, savedId: conversation });
    if (!reopened) throw new Error("Missing reopened session ID");
    const restored = await app.open();

    // Restoration follows the visible tab order rather than the conversation's age.
    expect(reopened).not.toBe(a);
    expect(order(restored, tree)).toEqual([b, reopened]);
    expect(restored.snapshot.details[reopened]?.conversationId).toBe(conversation);
    expect(restored.snapshot.details[reopened]?.output).toContain("main-worktree-marker");
  } finally { await app.cleanup(); }
});

test("Failed middle-tab recovery and new creation preserve UI, checkpoint, and shutdown order", async () => {
  // A broken SDK file must remain an error tab, not move behind healthy or new tabs.
  const app = await setup();
  try {
    const runtime = await app.open(), tree = app.repository.worktrees[0]!.id;
    const a = await create(runtime, tree), b = await create(runtime, tree), c = await create(runtime, tree);
    await command(runtime, { type: "prompt", sessionId: b, text: "read" });
    await observed(runtime, () => runtime.snapshot.details[b]?.status === "complete");
    expectOk(await runtime.stop());
    const file = (await app.manifest()).records.find(record => record.id === b)!.sessionFile!;
    await writeFile(file, "corrupt conversation\n");

    const restored = await app.open();
    expect(order(restored, tree)).toEqual([a, b, c]);
    const d = await create(restored, tree);
    await command(restored, { type: "preferences", preferences: restored.snapshot.preferences });

    // Failed tabs participate in both the visible order and every durable checkpoint.
    expect(order(restored, tree)).toEqual([a, b, c, d]);
    expect(savedOrder(await app.manifest(), tree)).toEqual([a, b, c, d]);
    expect(restored.snapshot.details[b]?.status).toBe("failure");
    expect(restored.snapshot.details[b]?.error).toContain("Could not restore");
    expect(restored.snapshot.details[b]?.output).toContain("main-worktree-marker");
    const restarted = await app.open();
    expect(order(restarted, tree)).toEqual([a, b, c, d]);
    expect(await readFile(file, "utf8")).toBe("corrupt conversation\n");
    await command(restarted, { type: "close", sessionId: b });
    expect(order(restarted, tree)).toEqual([a, c, d]);
  } finally { await app.cleanup(); }
});

test("Inactive-repository preference saves and shutdown never clear stored tab order", async () => {
  // A cold host has an empty live catalog but still owns the previous session metadata.
  const app = await setup();
  let host: RepositoryHost | undefined, client: RuntimeClient | undefined;
  try {
    const runtime = await app.open(), tree = app.repository.worktrees[0]!.id;
    const a = await create(runtime, tree), b = await create(runtime, tree);
    await command(runtime, { type: "session-control", sessionId: a, conversationId: runtime.snapshot.details[a]!.conversationId!, action: "clear" });
    await observed(runtime, () => runtime.snapshot.details[a]?.status === null);
    expectOk(await runtime.stop());
    await privateDirectory(app.paths.directory);
    host = expectOk(await RepositoryHost.open(app.repository, app.paths, true, app.stateRoot, undefined, () => {}, async () => ok(undefined)));
    client = new RuntimeClient(app.paths, host.snapshot);

    expectOk(await client.savePreferences({ ...structuredClone(emptyPreferences), drafts: { [a]: "unsent draft" } }));
    expect(host.active).toBe(false);
    expect(savedOrder(await app.manifest(), tree)).toEqual([a, b]);
    await client.disconnect(); client = undefined;
    expectOk(await host.stop()); host = undefined;
    const restored = await app.open();

    // Preference persistence must not allocate an SDK or discard the previous order.
    expect(order(restored, tree)).toEqual([a, b]);
    expect(restored.snapshot.preferences.drafts[a]).toBe("unsent draft");
  } finally {
    await client?.disconnect(); if (host) expectOk(await host.stop()); await app.cleanup();
  }
});

test.each(["legacy", "indexed"] as const)("%s persisted data without order metadata retains existing open-record order", async format => {
  // Older manifests and already-cleared metadata must not lose open sessions.
  const app = await setup();
  try {
    const runtime = await app.open(), tree = app.repository.worktrees[0]!.id;
    const a = await create(runtime, tree), b = await create(runtime, tree);
    expectOk(await runtime.stop());
    const manifest = await app.manifest();
    const withoutOrder = { ...manifest, repositories: manifest.repositories.map(repo => ({ ...repo,
      worktrees: repo.worktrees.map(tree => ({ ...tree, sessions: [] })) })) };
    if (format === "legacy") await writeFile(app.paths.manifest, JSON.stringify(withoutOrder));
    else expectOk(await new RuntimeStore(app.paths).save(withoutOrder));

    const restored = await app.open();

    // An absent order is a compatibility fallback, not an empty recovery list.
    expect(order(restored, tree)).toEqual([a, b]);
  } finally { await app.cleanup(); }
});

test("Partial orders apply per worktree, ignore duplicates/closed entries, and append missing open tabs", async () => {
  // Stale order metadata is only an ordering hint, never authority to reopen a conversation.
  const app = await setup();
  try {
    const runtime = await app.open(), tree = app.repository.worktrees[0]!.id, otherTree = app.repository.worktrees[1]!.id;
    const a = await create(runtime, tree), b = await create(runtime, tree), c = await create(runtime, tree);
    const closed = await create(runtime, tree), other = await create(runtime, otherTree);
    await command(runtime, { type: "close", sessionId: closed });
    await observed(runtime, () => runtime.snapshot.closingCount === 0);
    expectOk(await runtime.stop());
    const manifest = await app.manifest();
    const session = (id: string) => ({ id, name: id, status: null, subagents: [] });
    const repositories = manifest.repositories.map(repo => ({ ...repo, worktrees: repo.worktrees.map(item => ({ ...item,
      sessions: item.id === tree ? [session(c), session(c), session(closed), session(other)] : [session(b), session(other)],
    })) }));
    expectOk(await new RuntimeStore(app.paths).save({ ...manifest, repositories }));

    const restored = await app.open();

    // Valid saved positions win; omitted tabs keep their relative record order at the end.
    expect(order(restored, tree)).toEqual([c, a, b]);
    expect(order(restored, otherTree)).toEqual([other]);
    expect(restored.snapshot.details[closed]).toBeUndefined();
  } finally { await app.cleanup(); }
});
