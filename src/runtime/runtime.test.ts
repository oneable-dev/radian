import { expect, test } from "bun:test";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { WorkspaceSelection } from "../app/workspace-selection.ts";
import { connectRuntime, fetchSnapshot, RuntimeClient } from "./client.ts";
import { runtimePaths, pidAlive, privateDirectory, RuntimeStore } from "./storage.ts";
import { replySchema, type RuntimeManifest, type RuntimeSnapshot } from "./protocol.ts";
import { Value } from "typebox/value";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expectOk, expectError } from "../testing/results.ts";
import { initialGitState } from "../git/model.ts";

async function until(predicate: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 12000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for observed runtime state.");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}
function observed(client: RuntimeClient, predicate: (snapshot: RuntimeSnapshot) => boolean): Promise<void> {
  if (predicate(client.snapshot)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("Runtime event condition timed out.")); }, 10000);
    const unsubscribe = client.subscribe(() => {
      if (!predicate(client.snapshot)) return;
      clearTimeout(timer); unsubscribe(); resolve();
    });
  });
}
function progress(text = ""): number {
  return Math.max(0, ...[...text.matchAll(/Progress (\d+)\/40/g)].map((match) => Number(match[1])));
}
async function setup() {
  const fixture = await createWorktreeFixture();
  const options = { offline: true, stateRoot: join(fixture.directory, "state"), entry: join(import.meta.dir, "..", "index.ts") };
  const paths = runtimePaths(fixture.repository.id, true, options.stateRoot);
  const clients: RuntimeClient[] = [];
  return { ...fixture, paths, options,
    async connect(cwd = fixture.main) {
      const client = expectOk(await connectRuntime(fixture.repository, cwd, options));
      if (!client) throw new Error("Missing runtime client");
      clients.push(client); return client;
    },
    async stopped(pid: number) { await until(async () => !expectOk(await fetchSnapshot(paths)) && !pidAlive(pid)); },
    async manifest(): Promise<RuntimeManifest> { const manifest = expectOk(await new RuntimeStore(paths).load(fixture.repository.id)); if (!manifest) throw new Error("Missing runtime manifest"); return manifest; },
    async cleanup() {
      const existing = expectOk(await connectRuntime(fixture.repository, fixture.main, { ...options, start: false }));
      if (existing) {
        const pid = existing.snapshot.pid;
        await existing.stopRuntime(); await existing.disconnect(); await this.stopped(pid);
      }
      await Promise.all(clients.map((client) => client.disconnect()));
      await fixture.cleanup();
    },
  };
}

test("Dashboard Unix IPC reads closed SDK runs without conversations or new model execution", async () => {
  // Use only the separate offline daemon owned by this test.
  const app = await setup();
  try {
    const client = await app.connect(), tree = client.snapshot.repositories.flatMap(repo => repo.worktrees).find(tree => tree.path === app.main)!;
    const id = expectOk(await client.create(tree.id));
    expectOk(await client.prompt(id, "read"));
    await observed(client, snapshot => !!snapshot.details[id]?.result);
    expect(expectOk(await client.catalog(id)).items.some(item => item.value === "dashboard")).toBe(true);
    expect(expectOk(await client.listHistory(tree.id))).toEqual([]);
    expect(expectOk(await client.dashboard(7)).totals.runs).toBe(1);
    expectOk(await client.closeSession(id));
    const before = client.snapshot.repositories;

    // Exercise host paths, capabilities, response schemas, and persisted aggregation together.
    const dashboard = expectOk(await client.dashboard(7));

    // Closed runs remain available and statistics reads stay read-only.
    expect(dashboard.totals.runs).toBe(1); expect(dashboard.daily).toHaveLength(7); expect(dashboard.warnings).toEqual([]);
    expect(client.snapshot.repositories).toEqual(before);
  } finally { await app.cleanup(); }
});

test("Interrupt IPC merges queued input into one message while retaining sessions, drafts, and other runs", async () => {
  // This test owns an isolated daemon; interruption never targets a user runtime.
  const app = await setup();
  try {
    const client = await app.connect(), tree = app.repository.worktrees.find((item) => item.path === app.main)!;
    const id = expectOk(await client.create(tree.id)), other = expectOk(await client.create(tree.id));
    expect(client.snapshot.capabilities).toContain("agent-interrupt");
    expectOk(await client.prompt(id, "slow")); expectOk(await client.prompt(other, "slow"));
    expectOk(await client.prompt(id, "Add tests")); expectOk(await client.prompt(id, "Do not edit README"));
    await observed(client, (state) => state.details[id]?.pendingMessages?.length === 2 && state.details[other]?.status === "working");
    const conversation = client.snapshot.details[id]!.conversationId;
    expectOk(await client.savePreferences({ ...client.snapshot.preferences, drafts: { [id]: "Unsent draft" } }));

    // A delayed key intended for a replaced conversation must not interrupt the current one.
    const stale = await fetch("http://localhost/command", { unix: app.paths.socket, method: "POST", headers: { "Content-Type": "application/json", "X-Radian-Instance": client.snapshot.instance! },
      body: JSON.stringify({ type: "interrupt", sessionId: id, conversationId: "old-conversation" }) });
    expect(stale.status).toBe(409);
    expectOk(await client.interrupt(id));
    await observed(client, (state) => state.details[id]?.status === "complete" && !state.details[id]?.pendingMessages?.length);

    expect(client.snapshot.details[id]?.sections?.filter((section) => section.kind === "user").map((section) => section.text)).toEqual(["slow", "Add tests\nDo not edit README"]);
    expect(client.snapshot.details[id]?.conversationId).toBe(conversation);
    expect(client.snapshot.details[other]?.status).toBe("working");
    expect(client.snapshot.preferences.drafts[id]).toBe("Unsent draft");
    expect(client.snapshot.repositories.flatMap((repo) => repo.worktrees.flatMap((worktree) => worktree.sessions))).toHaveLength(2);
  } finally { await app.cleanup(); }
});

test("Completion IPC reads only selected-session SDK commands/worktree files without models", async () => {
  const app = await setup();
  try {
    const extensions = join(app.paths.directory, "offline-agent", "extensions"); await mkdir(extensions, { recursive: true });
    await writeFile(join(extensions, "commands.ts"), `export default function (pi) {
      pi.registerCommand("lookup-probe", { description: "Read-only command catalog probe", handler: async () => {} });
      pi.registerCommand("lookup-broken", { handler: async () => { throw new Error("Fixture command rejected"); } });
    }`);
    await writeFile(join(app.main, "main-only.ts"), "never load this content"); await writeFile(join(app.feature, "feature-only.ts"), "other worktree");
    const client = await app.connect(); const main = app.repository.worktrees.find((tree) => tree.path === app.main)!;
    const id = expectOk(await client.create(main.id));

    expect(client.snapshot.capabilities).toContain("prompt-completion");
    const commands = expectOk(await client.complete(id, { kind: "command", query: "lookup-probe" }));
    expect(commands.items.map((item) => item.value)).toEqual(["lookup-probe"]);
    // IPC and prepared UI catalogs must enforce the same normalized prefix rule.
    expect(expectOk(await client.complete(id, { kind: "command", query: "ＬＯＯＫＵＰ－ＰＲＯＢＥ" })).items.map(item => item.value)).toEqual(["lookup-probe"]);
    expect(expectOk(await client.complete(id, { kind: "command", query: "probe" })).items).toEqual([]);
    const files = expectOk(await client.complete(id, { kind: "file", query: "only.ts" }));
    expect(files.items.map((item) => item.value)).toEqual(["main-only.ts"]);
    expectOk(await client.prompt(id, "/lookup-probe"));
    expect((await app.manifest()).records[0]?.state.output).toBe("");
    const commandError = expectError(await client.prompt(id, "/lookup-broken"));
    expect(commandError.code).toBe("AGENT_FAILED"); expect(commandError).toHaveProperty("outcome", "unknown");
    expect(commandError.message).toContain("may have changed state");

    // The read-only endpoint still validates the instance fence and its wire input.
    for (const [params, instance, code] of [[`sessionId=${id}&kind=wrong&query=`, client.snapshot.instance, "INVALID_INPUT"],
      [`sessionId=${id}&kind=file&query=`, "old-instance", "PROTOCOL_ERROR"]] as const) {
      const response = await fetch(`http://localhost/completions?${params}`, { unix: app.paths.socket, headers: { "X-Radian-Instance": instance } });
      const body = await response.json();
      if (!Value.Check(replySchema, body) || body.ok || typeof body.error === "string") throw new Error("Expected a typed completion rejection.");
      expect(body.error.code).toBe(code);
    }
    expectOk(await client.closeSession(id));
    expect(expectError(await client.complete(id, { kind: "file", query: "" })).code).toBe("SESSION_NOT_OPEN");
  } finally { await app.cleanup(); }
});

test("new IPC adds same-worktree tabs while retaining conversations, queues, and runs", async () => {
  const app = await setup();
  try {
    const client = await app.connect(), tree = app.repository.worktrees.find((item) => item.path === app.main)!;
    const id = expectOk(await client.create(tree.id));
    expectOk(await client.prompt(id, "slow")); expectOk(await client.prompt(id, "Queued for original"));
    await observed(client, (state) => progress(state.details[id]?.output) > 0 && state.details[id]?.pendingMessages?.length === 1);
    const conversation = client.snapshot.details[id]!.conversationId, pid = client.snapshot.pid;
    expectOk(await client.savePreferences({ ...client.snapshot.preferences, drafts: { [id]: "Unsent original draft" } }));

    const added = expectOk(await client.newTab(id));

    expect(client.snapshot.capabilities).toContain("session-tab-commands");
    expect(client.snapshot.pid).toBe(pid); expect(added).not.toBe(id);
    expect(client.snapshot.repositories[0]!.worktrees.find((item) => item.id === tree.id)!.sessions.map((session) => session.id)).toEqual([id, added]);
    expect(client.snapshot.details[id]?.conversationId).toBe(conversation);
    expect(client.snapshot.details[id]?.pendingMessages).toHaveLength(1);
    expect(client.snapshot.details[id]?.status).toBe("working"); expect(client.snapshot.details[added]?.sections).toEqual([]);
    expect(client.snapshot.preferences.drafts[id]).toBe("Unsent original draft");
    expect(expectOk(await client.listHistory(tree.id))).toEqual([]);
    // The text API must dispatch /new as tab creation too, never as a paid model prompt or reset.
    expectOk(await client.prompt(id, "/new"));
    expect(client.snapshot.repositories[0]!.worktrees.find((item) => item.id === tree.id)!.sessions).toHaveLength(3);
    expect(client.snapshot.details[id]?.conversationId).toBe(conversation);
    expect(client.snapshot.details[id]?.sections?.some((section) => section.kind === "user" && section.text === "/new")).toBe(false);
  } finally { await app.cleanup(); }
});

test("clear IPC replaces only current conversations while preserving cancellation, other runs, editors, and shells", async () => {
  // The fixture owns the daemon and native processes; no user runtime is stopped.
  const app = await setup();
  try {
    const client = await app.connect(), tree = app.repository.worktrees.find((item) => item.path === app.main)!;
    const id = expectOk(await client.create(tree.id)), other = expectOk(await client.create(tree.id));
    const terminal = expectOk(await client.createTerminal(tree.id, { cols: 80, rows: 24 }));
    const editor = expectOk(await client.openEditor(tree.id, { cols: 80, rows: 24 }));
    await observed(client, (state) => !!state.terminals?.some((item) => item.id === terminal) && !!state.editors?.some((item) => item.id === editor));
    const terminalPid = client.snapshot.terminals!.find((item) => item.id === terminal)!.pid;
    const editorPid = client.snapshot.editors!.find((item) => item.id === editor)!.pid;
    expectOk(await client.prompt(id, "slow")); expectOk(await client.prompt(other, "slow"));
    await observed(client, (state) => progress(state.details[id]?.output) > 0 && progress(state.details[other]?.output) > 0);
    const previous = client.snapshot.details[id]!.conversationId!, instance = client.snapshot.instance, pid = client.snapshot.pid;

    expectOk(await client.prompt(id, "/clear"));
    await observed(client, (state) => state.details[id]?.conversationId !== previous && state.details[id]?.sections?.length === 0);

    expect(client.snapshot.repositories[0]?.worktrees.find((item) => item.id === tree.id)?.sessions.map((session) => session.id)).toEqual([id, other]);
    expect(client.snapshot.pid).toBe(pid); expect(client.snapshot.instance).toBe(instance);
    expect(client.snapshot.details[other]?.status).toBe("working");
    expect(client.snapshot.terminals?.find((item) => item.id === terminal)?.pid).toBe(terminalPid);
    expect(client.snapshot.editors?.find((item) => item.id === editor)?.pid).toBe(editorPid);
    const history = expectOk(await client.listHistory(tree.id));
    expect(history.find((item) => item.id === previous)?.openSessionId).toBeNull();
    const preview = expectOk(await client.previewHistory(tree.id, previous)); expect(preview.text).toContain("slow");
    expect(preview.snapshot?.lifecycle).toBe("closed"); expect(preview.snapshot?.state.conversationId).toBe(previous);
    await until(async () => (await app.manifest()).records.find((record) => record.id === id)?.state.conversationId === client.snapshot.details[id]?.conversationId);

    // A delayed operation for the old conversation must not run in the replacement.
    for (const command of [{ type: "prompt", sessionId: id, text: "/clear" },
      { type: "prompt", sessionId: id, text: "/new" },
      { type: "prompt", sessionId: id, text: "/exit" },
      { type: "prompt", sessionId: id, conversationId: previous, text: "/exit" },
      { type: "prompt", sessionId: id, conversationId: previous, text: "stale prompt" },
      { type: "session-control", action: "clear", sessionId: id, conversationId: previous },
      { type: "session-control", action: "new-tab", sessionId: id, conversationId: previous },
      { type: "session-control", action: "exit", sessionId: id, conversationId: previous },
      { type: "session-control", action: "new", sessionId: id, conversationId: previous }]) {
      const response = await fetch("http://localhost/command", { unix: app.paths.socket, method: "POST", body: JSON.stringify(command), headers: { "X-Radian-Instance": instance } });
      const body = await response.json();
      if (!Value.Check(replySchema, body) || body.ok || typeof body.error === "string") throw new Error("Expected a typed stale-conversation rejection");
      expect(body.error.code).toBe("SESSION_CONFLICT");
    }
    expect(client.snapshot.details[id]?.sections).toEqual([]);
    // Preserve the old typed wire contract for attached clients compiled before /clear existed.
    const current = client.snapshot.details[id]!.conversationId;
    const legacy = await fetch("http://localhost/command", { unix: app.paths.socket, method: "POST", headers: { "X-Radian-Instance": instance },
      body: JSON.stringify({ type: "session-control", action: "new", sessionId: id, conversationId: current }) });
    expect(legacy.ok).toBe(true);
    await observed(client, (state) => state.details[id]?.conversationId !== current);
    expect(client.snapshot.repositories[0]!.worktrees.find((item) => item.id === tree.id)!.sessions.map((session) => session.id)).toEqual([id, other]);
  } finally { await app.cleanup(); }
});

test("exit IPC rejects arguments/images and keeps services alive after closing final tabs", async () => {
  // Create one empty real-runtime tab and verify pre-close validation.
  const app = await setup();
  try {
    const client = await app.connect(), worktreeId = app.repository.worktrees[0]!.id;
    const id = expectOk(await client.create(worktreeId)), conversationId = client.snapshot.details[id]!.conversationId!;
    const pid = client.snapshot.pid, instance = client.snapshot.instance;
    for (const command of [
      { type: "prompt", sessionId: id, conversationId, text: "/exit later" },
      { type: "prompt", sessionId: id, conversationId, text: "/exit", images: ["/fixture.png"] },
      { type: "session-control", sessionId: id, conversationId, action: "exit", instructions: "later" },
    ]) {
      const response = await fetch("http://localhost/command", { unix: app.paths.socket, method: "POST", headers: { "X-Radian-Instance": instance },
        body: JSON.stringify(command) });
      const body = await response.json();
      if (!Value.Check(replySchema, body) || body.ok || typeof body.error === "string") throw new Error("Expected invalid exit rejection");
      expect(body.error.code).toBe("INVALID_INPUT");
    }
    expect(client.snapshot.repositories[0]!.worktrees[0]!.sessions.map(session => session.id)).toEqual([id]);
    expect(client.snapshot.details[id]?.sections).toEqual([]);

    // Valid exit closes only the final tab.
    expectOk(await client.prompt(id, "/exit"));
    await observed(client, state => !state.details[id] && state.closingCount === 0);

    // Empty views do not exit apps; the same process can create new sessions.
    expect(client.snapshot.repositories[0]!.worktrees[0]!.sessions).toEqual([]);
    const next = expectOk(await client.create(worktreeId));
    expect(next).not.toBe(id); expect(client.snapshot.pid).toBe(pid); expect(client.snapshot.instance).toBe(instance);
  } finally { await app.cleanup(); }
});

test("compact IPC acceptance differs from summary completion and retains conversation/transcript", async () => {
  const app = await setup();
  try {
    const client = await app.connect(), tree = app.repository.worktrees.find((item) => item.path === app.main)!;
    const id = expectOk(await client.create(tree.id));
    expect(expectOk(await client.complete(id, { kind: "command", query: "" })).items.map((item) => item.value)).toEqual(expect.arrayContaining(["new", "clear", "compact"]));
    // Two large turns are eligible under the SDK's default retained-tail policy.
    expectOk(await client.prompt(id, "first ".repeat(16000)));
    await observed(client, (state) => state.details[id]?.status === "complete");
    expectOk(await client.prompt(id, "second ".repeat(16000)));
    await observed(client, (state) => state.details[id]?.sections?.filter((section) => section.kind === "user").length === 2 && state.details[id]?.status === "complete");
    const previous = client.snapshot.details[id]!, conversation = previous.conversationId;

    expectOk(await client.prompt(id, "/compact preserve the current plan"));
    await observed(client, (state) => state.details[id]?.sections?.at(-1)?.title === "Context compacted");

    expect(client.snapshot.details[id]?.conversationId).toBe(conversation);
    expect(client.snapshot.details[id]?.sections?.slice(0, previous.sections!.length)).toEqual([...previous.sections!]);
    expect(client.snapshot.notice).toBe(""); expect(client.snapshot.details[id]?.status).toBe("complete");
  } finally { await app.cleanup(); }
});

test("Separate processes continue agents/subagents while all UIs detach and reconnect to identical runs", async () => {
  // The detached Bun process owns actual SDK instances in two real Git worktrees.
  const app = await setup();
  try {
    const client = await app.connect();
    const main = app.repository.worktrees.find((tree) => tree.path === app.main)!;
    const feature = app.repository.worktrees.find((tree) => tree.path === app.feature)!;
    const a = expectOk(await client.create(main.id)); const b = expectOk(await client.create(feature.id));
    await client.prompt(a, "read");
    await observed(client, (state) => state.details[a]?.status === "complete");
    // SDK metadata survives the real process/IPC boundary without inventing provider quotas.
    expect(client.snapshot.capabilities).toContain("agent-telemetry");
    expect(client.snapshot.details[a]?.telemetry?.model).toBe("fixture");
    expect(client.snapshot.details[a]?.telemetry?.context?.maxTokens).toBe(200000);
    expect(client.snapshot.details[a]?.telemetry?.weekly).toBeNull();
    expect(client.snapshot.details[a]?.telemetry?.fast).toBeNull();
    await client.prompt(a, "slow"); await client.prompt(b, "delegate");
    await observed(client, (state) => progress(state.details[a]?.output) >= 1 && state.repositories[0]?.worktrees[1]?.sessions[0]?.subagents[0]?.status === "working");
    const pid = client.snapshot.pid; const instance = client.snapshot.instance;
    const child = client.snapshot.repositories[0]!.worktrees[1]!.sessions[0]!.subagents[0]!.id;
    const before = progress(client.snapshot.details[a]?.output);
    await client.savePreferences({ selection: { worktreeId: feature.id, sessions: { [main.id]: a, [feature.id]: b } }, drafts: { [a]: "retained draft" } });

    // No streaming UI client is connected while we observe progress through the disk checkpoint.
    await client.disconnect();
    await until(async () => progress((await app.manifest()).records.find((record) => record.id === a)?.state.output) > before);
    const reattached = await app.connect(app.feature);

    // Warm reattach restores the same process, open IDs, child, latest output and selection.
    expect(pid).not.toBe(process.pid);
    expect(reattached.snapshot.pid).toBe(pid);
    expect(reattached.snapshot.instance).toBe(instance);
    expect(reattached.snapshot.details[a]?.status).toBe("working");
    expect(reattached.snapshot.repositories[0]!.worktrees[1]!.sessions[0]!.subagents[0]?.id).toBe(child);
    expect(reattached.snapshot.preferences.drafts[a]).toBe("retained draft");
    const selection = new WorkspaceSelection(reattached.snapshot.repositories);
    selection.restore(reattached.snapshot.preferences.selection);
    expect(selection.sessionId).toBe(b);
    selection.selectWorktree(main.id); expect(selection.sessionId).toBe(a);
    expect((await stat(app.paths.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(app.paths.socket)).mode & 0o777).toBe(0o600);
  } finally { await app.cleanup(); }
}, 20000);

test("Event connections survive 31 idle seconds and retain same-service history/commands", async () => {
  // An isolated SDK service must keep its subscription even when no state changes are emitted.
  const app = await setup();
  try {
    const client = await app.connect();
    const worktree = app.repository.worktrees[0]!.id;
    const id = expectOk(await client.create(worktree));
    expectOk(await client.prompt(id, "read"));
    await observed(client, (state) => state.details[id]?.status === "complete");
    const instance = client.snapshot.instance;
    const notices: string[] = [];
    const unsubscribe = client.subscribe(() => { if (client.snapshot.notice) notices.push(client.snapshot.notice); });

    // Real elapsed time is intentional: mocked timers cannot exercise Bun's native socket idle timeout.
    await Bun.sleep(31000);
    unsubscribe();

    // Reconnection must not mask an incorrectly configured idle stream; no failure should occur at all.
    expect(notices).toEqual([]);
    expect(client.snapshot.notice).toBe("");
    expect(client.snapshot.instance).toBe(instance);
    expect(expectOk(await client.listHistory(worktree))).toEqual([]);
    const next = expectOk(await client.create(worktree));
    await observed(client, (state) => !!state.details[next]);
    expect(client.snapshot.repositories[0]!.worktrees[0]!.sessions.map((session) => session.id)).toEqual([id, next]);
  } finally { await app.cleanup(); }
}, 45000);

test.each(["close", "exit", "raw-exit"] as const)("%s IPC closure cancels only owned children while preserving other sessions and history", async (action) => {
  // Parent/child and an unrelated slow run coexist in one detached SDK service.
  const app = await setup();
  try {
    const client = await app.connect();
    const parent = expectOk(await client.create(app.repository.worktrees[0]!.id));
    const other = expectOk(await client.create(app.repository.worktrees[1]!.id));
    await client.prompt(parent, "delegate"); await client.prompt(other, "slow");
    await observed(client, (state) => !!state.repositories[0]?.worktrees[0]?.sessions[0]?.subagents[0] && progress(state.details[other]?.output) >= 1);
    await until(async () => !!(await app.manifest()).records.find((record) => record.id === parent)?.sessionFile);
    const file = (await app.manifest()).records.find((record) => record.id === parent)!.sessionFile!;
    const conversation = client.snapshot.details[parent]!.conversationId!, pid = client.snapshot.pid, instance = client.snapshot.instance;
    expect(client.snapshot.capabilities).toContain("session-exit");
    expect(expectOk(await client.complete(parent, { kind: "command", query: "exit" })).items.map(item => item.value)).toEqual(["exit"]);

    // Both typed controls and raw prompts reuse the close button's lifecycle.
    if (action === "close") {
      const closing = client.closeSession(parent);
      expect(client.snapshot.repositories[0]!.worktrees[0]!.sessions).toEqual([]);
      expectOk(await closing);
    } else if (action === "exit") expectOk(await client.prompt(parent, "/exit"));
    else {
      const response = await fetch("http://localhost/command", { unix: app.paths.socket, method: "POST", headers: { "X-Radian-Instance": instance },
        body: JSON.stringify({ type: "prompt", sessionId: parent, conversationId: conversation, text: "/exit" }) });
      expect(response.ok).toBe(true);
    }
    await observed(client, (state) => !state.details[parent] && state.closingCount === 0);

    // Explicit close cancels its family, unlike detaching a UI, and does not erase conversation files.
    expect(client.snapshot.details[other]?.status).toBe("working");
    expect(client.snapshot.pid).toBe(pid); expect(client.snapshot.instance).toBe(instance);
    expect(client.snapshot.repositories[0]!.worktrees[0]!.sessions).toEqual([]);
    expect(await Bun.file(file).exists()).toBe(true);
    const worktreeId = app.repository.worktrees[0]!.id;
    expect(expectOk(await client.listHistory(worktreeId)).find(item => item.id === conversation)?.openSessionId).toBeNull();
    expect(expectOk(await client.previewHistory(worktreeId, conversation)).text).not.toContain("/exit");
    expect((await app.manifest()).records.map((record) => record.id)).toEqual([other]);
  } finally { await app.cleanup(); }
}, 20000);

test("Service restart restores open IDs, history, and selections without replaying interrupted runs", async () => {
  // Finalized history, an unused item, and an in-flight response all need different recovery handling.
  const app = await setup();
  try {
    const client = await app.connect();
    const a = expectOk(await client.create(app.repository.worktrees[0]!.id));
    const empty = expectOk(await client.create(app.repository.worktrees[0]!.id));
    const running = expectOk(await client.create(app.repository.worktrees[1]!.id));
    await client.prompt(a, "read"); await observed(client, (state) => state.details[a]?.status === "complete");
    await client.prompt(running, "slow"); await observed(client, (state) => progress(state.details[running]?.output) >= 1);
    await client.savePreferences({ selection: { worktreeId: app.repository.worktrees[1]!.id, sessions: { [app.repository.worktrees[1]!.id]: running } }, drafts: {} });
    const pid = client.snapshot.pid; const instance = client.snapshot.instance;
    const file = (await app.manifest()).records.find((record) => record.id === a)!.sessionFile!;

    // This explicitly stops the service; ordinary TUI Ctrl+C never calls this command.
    await client.stopRuntime(); await client.disconnect(); await app.stopped(pid);
    const restored = await app.connect();

    // A new service restores the same conversations, not forks or automatic model/tool retries.
    expect(restored.snapshot.instance).not.toBe(instance);
    expect(restored.snapshot.repositories.flatMap((repo) => repo.worktrees.flatMap((tree) => tree.sessions.map((session) => session.id)))).toEqual([a, empty, running]);
    expect(restored.snapshot.details[a]?.output).toContain("main-worktree-marker");
    expect(restored.snapshot.details[running]?.status).toBeNull();
    expect(restored.snapshot.details[running]?.error).toContain("Previous runtime ended");
    expect(restored.snapshot.preferences.selection.sessions[app.repository.worktrees[1]!.id]).toBe(running);
    expect((await app.manifest()).records.find((record) => record.id === a)?.sessionFile).toBe(file);
    await restored.prompt(a, "read"); await observed(restored, (state) => state.details[a]?.status === "complete");
  } finally { await app.cleanup(); }
}, 20000);

test("Existing clients reconnect to explicitly replaced services without replaying saved commands", async () => {
  // Only a test-owned daemon is restarted; the first UI client remains mounted throughout.
  const app = await setup();
  try {
    const client = await app.connect();
    const worktree = app.repository.worktrees[0]!.id;
    const id = expectOk(await client.create(worktree));
    expectOk(await client.prompt(id, "read"));
    await observed(client, (state) => state.details[id]?.status === "complete");
    const file = (await app.manifest()).records.find((record) => record.id === id)!.sessionFile!;
    const original = await readFile(file, "utf8");
    const pid = client.snapshot.pid;

    // Service startup is explicit, not something the disconnected subscriber does automatically.
    expectOk(await client.stopRuntime()); await app.stopped(pid);
    await until(() => !client.connected);
    expect(expectError(await client.prompt(id, "must not run")).code).toBe("CONNECTION_FAILED");
    const replacement = await app.connect();
    await observed(client, (state) => client.connected && state.instance === replacement.snapshot.instance);

    // Fresh history/capabilities and the same conversation are available without another UI launch.
    expect(client.snapshot.pid).not.toBe(pid);
    expect(client.snapshot.details[id]?.output).toContain("main-worktree-marker");
    expect(expectOk(await client.listHistory(worktree))).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(original);
    expect(client.snapshot.repositories[0]!.worktrees[0]!.sessions.map((session) => session.id)).toEqual([id]);
  } finally { await app.cleanup(); }
}, 20000);

test("Runtime-only disconnects preserve real shells while closing old PTYs for explicit reattachment", async () => {
  // A test-owned Unix relay ends only /events; it does not restart or stop the daemon/shell.
  const app = await setup();
  const relayPaths = runtimePaths(app.repository.id, true, join(app.directory, "relay"));
  let relay: ReturnType<typeof Bun.serve> | undefined;
  let client: RuntimeClient | undefined;
  let drop: (() => void) | undefined;
  const commands: string[] = [];
  try {
    const owner = await app.connect();
    const id = expectOk(await owner.createTerminal(app.repository.worktrees[0]!.id, { cols: 80, rows: 12 }));
    const shell = owner.snapshot.terminals!.find((item) => item.id === id)!;
    relay = Bun.serve({ unix: relayPaths.socket, async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = request.method === "POST" ? await request.text() : undefined;
      if (body) commands.push((JSON.parse(body) as { type: string }).type);
      const response = await fetch(request.url, { unix: owner.paths.socket, method: request.method, headers: request.headers, signal: request.signal,
        ...(body !== undefined ? { body } : {}) });
      if (path !== "/events" || !response.body) return response;
      const reader = response.body.getReader(); let closed = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          drop = () => { if (!closed) { closed = true; controller.close(); void reader.cancel(); } };
          void (async () => {
            try {
              while (!closed) { const chunk = await reader.read(); if (chunk.done) break; if (!closed) controller.enqueue(chunk.value); }
              if (!closed) { closed = true; controller.close(); }
            } catch (error) { if (!closed) { closed = true; controller.error(error); } }
          })();
        },
        async cancel() { closed = true; await reader.cancel(); },
      });
      return new Response(stream, { headers: response.headers });
    } });
    client = new RuntimeClient(relayPaths, owner.snapshot); expectOk(await client.attach());
    const failures: unknown[] = [];
    const old = expectOk(await client.attachTerminal(id, () => {}, (error) => failures.push(error)));

    drop!(); await until(() => !client!.connected); await until(() => client!.connected);
    await old.closed;
    expect(commands).toEqual([]); expect(failures).toHaveLength(1);
    expect(client.snapshot.terminals!.find((item) => item.id === id)!.shellPid).toBe(shell.shellPid);
    expect(pidAlive(shell.shellPid)).toBe(true);
    const fresh = expectOk(await client.attachTerminal(id, () => {}, () => {}));
    expect(fresh.lease).not.toBe(old.lease);
  } finally { await client?.disconnect(); await relay?.stop(true); await rm(relayPaths.socket, { force: true }); await app.cleanup(); }
}, 20000);

test("Stale-instance commands and PTY attachments fail before execution while legacy clients remain supported", async () => {
  // A replacement endpoint must not accept delayed mutation requests for the previous owner.
  const app = await setup();
  try {
    const client = await app.connect();
    const command = { type: "create", worktreeId: app.repository.worktrees[0]!.id };
    const response = await fetch("http://localhost/command", { unix: client.paths.socket, method: "POST",
      headers: { "X-Radian-Instance": "stale-instance" }, body: JSON.stringify(command) });
    expect(response.status).toBe(422);
    const rejected = await response.json();
    if (!Value.Check(replySchema, rejected) || rejected.ok || typeof rejected.error === "string") throw new Error("Expected a typed rejection.");
    expect(rejected.error.code).toBe("PROTOCOL_ERROR");
    expect(rejected.error.message).toContain("No action was accepted");
    const pty = await fetch("http://localhost/terminal/events?id=missing&lease=stale", { unix: client.paths.socket, headers: { "X-Radian-Instance": "stale-instance" } });
    expect(pty.status).toBe(422);
    expect(expectOk(await fetchSnapshot(client.paths))!.repositories[0]!.worktrees[0]!.sessions).toEqual([]);

    // The optional fencing header does not remove the existing v1 command contract.
    const legacy = await fetch("http://localhost/command", { unix: client.paths.socket, method: "POST", body: JSON.stringify(command) });
    const accepted = await legacy.json();
    expect(legacy.status).toBe(200); expect(Value.Check(replySchema, accepted) && accepted.ok).toBe(true);
  } finally { await app.cleanup(); }
});

test("Concurrent connections start one daemon and reclaim stale endpoints after forced termination", async () => {
  // Simultaneous clients exercise real process/endpoint ownership, not an in-memory singleton.
  const app = await setup();
  try {
    const clients = await Promise.all([app.connect(), app.connect(), app.connect(app.feature)]);
    const pid = clients[0]!.snapshot.pid;
    expect(new Set(clients.map((client) => client.snapshot.pid)).size).toBe(1);
    const id = expectOk(await clients[0]!.create(app.repository.worktrees[0]!.id));
    await clients[0]!.prompt(id, "read"); await observed(clients[0]!, (state) => state.details[id]?.status === "complete");
    await until(async () => (await app.manifest()).records.some((record) => record.id === id));

    // Killing this test-owned idle service leaves a stale socket/lock but no live tool subprocess.
    process.kill(pid, "SIGKILL"); await until(() => !pidAlive(pid));
    await Promise.all(clients.map((client) => client.disconnect()));
    const reconnected = await Promise.all([app.connect(), app.connect(app.feature)]);
    const recovered = reconnected[0]!;
    expect(new Set(reconnected.map((client) => client.snapshot.pid)).size).toBe(1);

    // Dead-owner recovery preserves the saved open item while acquiring a new process owner.
    expect(recovered.snapshot.pid).not.toBe(pid);
    expect(recovered.snapshot.details[id]?.output).toContain("main-worktree-marker");
  } finally { await app.cleanup(); }
}, 20000);

test.each(["close", "exit"] as const)("%s: corrupt history remains unmodified, reports restoration errors, and supports explicit closure", async (action) => {
  // The corrupted file belongs only to this isolated SDK fixture.
  const app = await setup();
  try {
    const client = await app.connect();
    const id = expectOk(await client.create(app.repository.worktrees[0]!.id));
    await client.prompt(id, "read"); await observed(client, (state) => state.details[id]?.status === "complete");
    const file = (await app.manifest()).records.find((record) => record.id === id)!.sessionFile!;
    const pid = client.snapshot.pid;
    await client.stopRuntime(); await client.disconnect(); await app.stopped(pid);
    await writeFile(file, "corrupt conversation\n");

    // Restart reports the failure but retains the open item for an explicit user decision.
    const restored = await app.connect();

    // No empty history, cloned context or automatic prompt replaces the original bytes.
    expect(restored.snapshot.details[id]?.status).toBe("failure");
    expect(restored.snapshot.details[id]?.error).toContain("Could not restore");
    expect(await readFile(file, "utf8")).toBe("corrupt conversation\n");
    expectOk(await (action === "exit" ? restored.prompt(id, "/exit") : restored.closeSession(id)));
    await observed(restored, (state) => !state.details[id]);
    expect(await readFile(file, "utf8")).toBe("corrupt conversation\n");
  } finally { await app.cleanup(); }
}, 20000);

test.each(["inline", "indexed"])("Startup discards %s closed snapshots without SDK originals instead of exposing unavailable History", async format => {
  // An older runtime may have archived a body after its original conversation disappeared.
  const app = await setup();
  try {
    await privateDirectory(app.paths.directory);
    const tree = app.repository.worktrees[0]!;
    const archived = { id: "archived-tab", name: "Archived task", worktreeId: tree.id, cwd: tree.path, lifecycle: "closed" as const,
      sessionFile: join(tree.path, "missing-conversation.jsonl"), updatedAt: 1000,
      state: { conversationId: "archived-conversation", status: "failure" as const, error: "Saved failure", output: "Stored output" }, subagents: [] };
    const manifest: RuntimeManifest = { version: 1, repositoryId: app.repository.id, repositories: [app.repository], records: [archived],
      preferences: { selection: { worktreeId: tree.id, sessions: {} }, drafts: {} } };
    if (format === "inline") await writeFile(app.paths.manifest, JSON.stringify(manifest));
    else {
      await writeFile(archived.sessionFile, JSON.stringify({ type: "session", version: 3, id: archived.state.conversationId, cwd: tree.path }) + "\n");
      expectOk(await new RuntimeStore(app.paths).save(manifest)); await rm(archived.sessionFile);
    }

    // Restore open intent only and let startup maintenance remove unusable closed bodies.
    const client = await app.connect(); await observed(client, state => !!state.sessionRetention);
    const items = expectOk(await client.listHistory(tree.id));

    // Neither a visible row, a preview, nor an internal archived snapshot survives.
    expect(client.snapshot.details).toEqual({}); expect(items).toEqual([]);
    expect(expectError(await client.previewHistory(tree.id, "archived-conversation")).code).toBe("HISTORY_UNAVAILABLE");
    expect(expectError(await client.resume(tree.id, "archived-conversation")).code).toBe("HISTORY_UNAVAILABLE");
    const store = new RuntimeStore(app.paths); expectOk(await store.load(app.repository.id)); expect(store.listSessions(tree.id)).toEqual([]);
    expect(await readFile(app.paths.manifest, "utf8")).not.toContain("Archived task");
    expect(await Bun.file(archived.sessionFile).exists()).toBe(false);
  } finally { await app.cleanup(); }
});

test("External SDK conversations without snapshots build read-only JSONL previews", async () => {
  // Conversations predating shared snapshots remain readable.
  const app = await setup();
  try {
    const client = await app.connect(), tree = app.repository.worktrees[0]!;
    const directory = join(app.paths.directory, "offline-agent", "sessions"), file = join(directory, "external.jsonl");
    await mkdir(directory, { recursive: true });
    const timestamp = new Date().toISOString();
    const bytes = [
      { type: "session", version: 3, id: "external", cwd: tree.path, timestamp },
      { type: "message", id: "q", parentId: null, timestamp, message: { role: "user", content: "External question" } },
      { type: "message", id: "a", parentId: "q", timestamp, message: { role: "assistant", content: [{ type: "text", text: "External answer" }], provider: "radian-offline", model: "fixture" } },
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n";
    await writeFile(file, bytes);

    // Browsing History creates neither SDK executors nor new shared snapshots.
    expect(expectOk(await client.listHistory(tree.id)).map(item => item.id)).toEqual(["external"]);
    const preview = expectOk(await client.previewHistory(tree.id, "external"));

    // Restore only renderer sections without adding conversations or files.
    expect(preview.snapshot).toBeUndefined(); expect(preview.sections?.map(section => section.text)).toEqual(["External question", "External answer"]);
    expect(client.snapshot.details).toEqual({}); expect(await readFile(file, "utf8")).toBe(bytes);
    const store = new RuntimeStore(app.paths); expectOk(await store.load(app.repository.id)); expect(store.listSessions(tree.id)).toEqual([]);
  } finally { await app.cleanup(); }
});

test("Service restart recovers only open sessions while retaining identical closed snapshots in History", async () => {
  // Use a real SDK conversation and another open tab to verify recovery filtering.
  const app = await setup();
  try {
    const client = await app.connect(), tree = app.repository.worktrees[0]!;
    const closed = expectOk(await client.create(tree.id)), open = expectOk(await client.create(tree.id));
    expectOk(await client.prompt(closed, "read")); await observed(client, state => state.details[closed]?.status === "complete");
    const before = client.snapshot.details[closed]!, conversation = before.conversationId!;

    // Fully restart after explicit closed-session persistence completes.
    expectOk(await client.closeSession(closed)); await observed(client, state => !state.details[closed] && state.closingCount === 0);
    const pid = client.snapshot.pid; expectOk(await client.stopRuntime()); await client.disconnect(); await app.stopped(pid);
    const restored = await app.connect(), preview = expectOk(await restored.previewHistory(tree.id, conversation));

    // Closed runs never instantiate; saved status and conversation appear only in previews.
    expect(Object.keys(restored.snapshot.details)).toEqual([open]);
    expect(preview.snapshot?.lifecycle).toBe("closed"); expect(preview.telemetry).toEqual(before.telemetry);
    expect(preview.snapshot?.state.sections).toEqual(before.sections);
    expect(expectOk(await restored.listHistory(tree.id)).find(item => item.id === conversation)?.openSessionId).toBeNull();
    const reopened = expectOk(await restored.resume(tree.id, conversation));
    expect(reopened).not.toBe(closed); expect(restored.snapshot.details[reopened]?.conversationId).toBe(conversation);
    const snapshots = new RuntimeStore(app.paths); expectOk(await snapshots.load(app.repository.id));
    expect(snapshots.listSessions(tree.id).filter(item => item.conversationId === conversation)).toHaveLength(1);
    expect(snapshots.listSessions(tree.id).find(item => item.conversationId === conversation)?.lifecycle).toBe("open");
  } finally { await app.cleanup(); }
});

test("IPC history opens worktree-scoped SDK records and returns existing entries for open saved IDs", async () => {
  // The real daemon discovers saved SDK files in a shared offline history directory.
  const app = await setup();
  try {
    const client = await app.connect();
    const main = app.repository.worktrees[0]!.id; const feature = app.repository.worktrees[1]!.id;
    const a = expectOk(await client.create(main)); const b = expectOk(await client.create(feature));
    await client.prompt(a, "read"); await client.prompt(b, "write");
    await observed(client, (state) => state.details[a]?.status === "complete" && state.details[b]?.status === "complete");
    expect(expectOk(await client.listHistory(main))).toEqual([]);
    const saved = { id: client.snapshot.details[a]!.conversationId! };
    const file = (await app.manifest()).records.find((record) => record.id === a)!.sessionFile!;

    // Preview is a separate read-only, instance-fenced route and must preserve the active runtime/file.
    let bytes = await readFile(file, "utf8"); const count = Object.keys(client.snapshot.details).length;
    const preview = expectOk(await client.previewHistory(main, saved.id));
    expect(preview.sections?.[0]).toMatchObject({ kind: "user", text: "read" });
    expect(preview.sections!.length).toBeLessThanOrEqual(15); expect(preview.text).toContain("read");
    expect(preview.telemetry).toEqual(client.snapshot.details[a]?.telemetry);
    expect(client.snapshot.capabilities).toContain("run-completion");
    expect(preview.sections?.at(-1)?.completion).toEqual(client.snapshot.details[a]?.sections?.at(-1)?.completion);
    expect(preview.sections?.at(-1)?.completion?.outcome).toBe("complete");
    expect(Object.keys(client.snapshot.details)).toHaveLength(count); expect(await readFile(file, "utf8")).toBe(bytes);
    expect(expectError(await client.previewHistory(feature, saved.id)).code).toBe("HISTORY_UNAVAILABLE");
    for (const instance of [undefined, "obsolete"]) {
      const response = await fetch(`http://localhost/history/preview?${new URLSearchParams({ worktreeId: main, savedId: saved.id }).toString()}`, {
        unix: app.paths.socket, ...(instance ? { headers: { "X-Radian-Instance": instance } } : {}),
      });
      expect(response.status).toBe(422); await response.body?.cancel();
    }

    // Existing and closed histories both use the resume boundary, never SDK switch/fork.
    expect(expectOk(await client.resume(main, saved.id))).toBe(a);
    await client.closeSession(a); await observed(client, (state) => state.closingCount === 0 && !state.details[a]);
    // Extend only this closed fixture-owned file; a large SDK custom entry must not disable IPC preview.
    const leaf = JSON.parse(bytes.trimEnd().split("\n").at(-1)!).id;
    await appendFile(file, JSON.stringify({ type: "custom", id: "large-history-preview", parentId: leaf, timestamp: new Date().toISOString(),
      customType: "preview-size-fixture", data: "x".repeat(5 * 1024 * 1024) }) + "\n");
    bytes = await readFile(file, "utf8");
    const largePreview = expectOk(await client.previewHistory(main, saved.id));
    expect(largePreview.text).toContain("read"); expect(largePreview.sections!.length).toBeLessThanOrEqual(15);
    expect(largePreview.sections?.at(-1)?.completion).toEqual(preview.sections?.at(-1)?.completion);
    expect(client.snapshot.details[a]).toBeUndefined(); expect(await readFile(file, "utf8")).toBe(bytes);
    const reopened = expectOk(await client.resume(main, saved.id));

    // The same file/context appears as another open item, and cross-worktree IDs stay rejected.
    expect(reopened).not.toBe(a);
    expect(client.snapshot.details[reopened]?.output).toContain("main-worktree-marker");
    expect((await app.manifest()).records.find((record) => record.id === reopened)?.sessionFile).toBe(file);
    expect(expectOk(await client.listHistory(main))).toEqual([]);
    expect(expectOk(await client.listHistory(feature))).toEqual([]);
    expect(expectError(await client.resume(feature, saved.id)).code).toBe("HISTORY_UNAVAILABLE");
  } finally { await app.cleanup(); }
}, 20000);

test("Active subagent files never execute twice through history", async () => {
  // A child is an owned writer even though its file is a valid SDK saved conversation.
  const app = await setup();
  try {
    const client = await app.connect(); const main = app.repository.worktrees[0]!.id;
    const id = expectOk(await client.create(main)); expectOk(await client.prompt(id, "delegate"));
    await observed(client, (state) => state.repositories[0]?.worktrees[0]?.sessions[0]?.subagents[0]?.status === "working");
    let childId: string | undefined;
    await until(async () => { childId = (await SessionManager.list(app.main, join(app.paths.directory, "offline-agent", "sessions")))
      .find(entry => entry.firstMessage === "slow")?.id; return !!childId; });

    // Active parents and children are hidden, but stale/direct resume still checks writer ownership.
    expect(expectOk(await client.listHistory(main))).toEqual([]);
    expect(expectError(await client.resume(main, childId!)).code).toBe("SESSION_CONFLICT");

    // Parent ownership and the single open-session item are unchanged.
    expect(client.snapshot.repositories[0]!.worktrees[0]!.sessions.map((session) => session.id)).toEqual([id]);
    expectOk(await client.closeSession(id)); await observed(client, state => state.closingCount === 0);
    expect(expectOk(await client.listHistory(main)).some(item => item.id === childId)).toBe(true);
  } finally { await app.cleanup(); }
}, 20000);

test("Git preferences survive real reconnects and legacy preference saves", async () => {
  // The detached runtime owns the warm-reconnect state; UI caches are not enough.
  const app = await setup();
  try {
    const client = await app.connect(), worktreeId = app.repository.worktrees[0]!.id;
    const state = { ...initialGitState(), selected: "a".repeat(40), file: "commit:src/file.ts", diff: true, diffScroll: 42 };

    expectOk(await client.savePreferences({ ...client.snapshot.preferences, gitViews: { [worktreeId]: state } }));
    await observed(client, (snapshot) => snapshot.preferences.gitViews?.[worktreeId]?.diffScroll === 42);
    await client.disconnect();
    const reattached = await app.connect();
    expect(reattached.snapshot.preferences.gitViews?.[worktreeId]).toEqual(state);
    const legacy = { ...reattached.snapshot.preferences }; delete legacy.gitViews;
    expectOk(await reattached.savePreferences(legacy));
    const later = await app.connect();

    expect(later.snapshot.preferences.gitViews?.[worktreeId]).toEqual(state);
    expect((await app.manifest()).preferences.gitViews?.[worktreeId]).toEqual(state);
  } finally { await app.cleanup(); }
}, 20000);

test("Accepted-run checkpoint failures return success with warnings instead of rejection", async () => {
  // Only this fixture's manifest is replaced with an unwritable target; user state is untouched.
  const app = await setup();
  let damaged = false;
  try {
    const client = await app.connect();
    const id = expectOk(await client.create(app.repository.worktrees[0]!.id));
    await rename(app.paths.manifest, app.paths.manifest + ".backup");
    await mkdir(app.paths.manifest); damaged = true;

    // A real SDK stream begins while the following atomic checkpoint encounters EISDIR.
    const response = await fetch("http://localhost/command", { unix: app.paths.socket, method: "POST",
      body: JSON.stringify({ type: "prompt", sessionId: id, text: "slow" }) });
    const reply = await response.json();
    await observed(client, (state) => progress(state.details[id]?.output) >= 1);

    // The caller is not told to retry an already running operation; durability loss is explicit.
    expect(response.status).toBe(200);
    if (!Value.Check(replySchema, reply) || !reply.ok) throw new Error("Expected a valid accepted reply.");
    expect(reply.ok).toBe(true);
    expect(reply.warnings?.[0]?.code).toBe("STORAGE_FAILED");
    expect(client.snapshot.details[id]?.status).toBe("working");
    expect(client.snapshot.notice).toContain("persistence failed");
    // A second submission is accepted into Pi's queue even while the run continues.
    expectOk(await client.prompt(id, "read"));
    expect(client.snapshot.details[id]?.status).toBe("working");
  } finally {
    if (damaged) { await rm(app.paths.manifest, { recursive: true }); await rename(app.paths.manifest + ".backup", app.paths.manifest); }
    await app.cleanup();
  }
}, 20000);
