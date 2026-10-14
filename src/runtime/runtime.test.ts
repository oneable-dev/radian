import { expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { WorkspaceSelection } from "../workspace/selection.ts";
import { connectRuntime, fetchSnapshot, type RuntimeClient } from "./client.ts";
import { runtimePaths, pidAlive } from "./storage.ts";
import type { RuntimeManifest, RuntimeSnapshot } from "./protocol.ts";

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
      const client = await connectRuntime(fixture.repository, cwd, options);
      if (!client) throw new Error("Missing runtime client");
      clients.push(client); return client;
    },
    async stopped(pid: number) { await until(async () => !await fetchSnapshot(paths) && !pidAlive(pid)); },
    async manifest(): Promise<RuntimeManifest> { return JSON.parse(await readFile(paths.manifest, "utf8")); },
    async cleanup() {
      const existing = await connectRuntime(fixture.repository, fixture.main, { ...options, start: false });
      if (existing) {
        const pid = existing.snapshot.pid;
        await existing.stopRuntime(); await existing.disconnect(); await this.stopped(pid);
      }
      await Promise.all(clients.map((client) => client.disconnect()));
      await fixture.cleanup();
    },
  };
}

test("별도 프로세스는 모든 UI가 분리된 동안에도 agent와 subagent를 진행하고 같은 실행에 재접속한다", async () => {
  // The detached Bun process owns actual SDK instances in two real Git worktrees.
  const app = await setup();
  try {
    const client = await app.connect();
    const main = app.repository.worktrees.find((tree) => tree.path === app.main)!;
    const feature = app.repository.worktrees.find((tree) => tree.path === app.feature)!;
    const a = await client.create(main.id); const b = await client.create(feature.id);
    await client.prompt(a, "read");
    await observed(client, (state) => state.details[a]?.status === "complete");
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

test("IPC 닫기는 UI에서 먼저 제거하고 소속 자식만 취소하며 다른 세션과 저장 기록은 유지한다", async () => {
  // Parent/child and an unrelated slow run coexist in one detached SDK service.
  const app = await setup();
  try {
    const client = await app.connect();
    const parent = await client.create(app.repository.worktrees[0]!.id);
    const other = await client.create(app.repository.worktrees[1]!.id);
    await client.prompt(parent, "delegate"); await client.prompt(other, "slow");
    await observed(client, (state) => !!state.repositories[0]?.worktrees[0]?.sessions[0]?.subagents[0] && progress(state.details[other]?.output) >= 1);
    await until(async () => !!(await app.manifest()).records.find((record) => record.id === parent)?.sessionFile);
    const file = (await app.manifest()).records.find((record) => record.id === parent)!.sessionFile!;

    // Client projection changes synchronously, before the service's acknowledgement arrives.
    const closing = client.closeSession(parent);
    expect(client.snapshot.repositories[0]!.worktrees[0]!.sessions).toEqual([]);
    await closing;
    await observed(client, (state) => !state.details[parent] && state.closingCount === 0);

    // Explicit close cancels its family, unlike detaching a UI, and does not erase conversation files.
    expect(client.snapshot.details[other]?.status).toBe("working");
    expect(await Bun.file(file).exists()).toBe(true);
    expect((await app.manifest()).records.map((record) => record.id)).toEqual([other]);
  } finally { await app.cleanup(); }
}, 20000);

test("서비스 종료 후 재시작은 열린 ID와 기록·선택을 복원하되 중단된 실행을 자동 재전송하지 않는다", async () => {
  // Finalized history, an unused item, and an in-flight response all need different recovery handling.
  const app = await setup();
  try {
    const client = await app.connect();
    const a = await client.create(app.repository.worktrees[0]!.id);
    const empty = await client.create(app.repository.worktrees[0]!.id);
    const running = await client.create(app.repository.worktrees[1]!.id);
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

test("동시에 접속해도 데몬 하나만 실행되고 강제 종료 후 stale endpoint를 회수한다", async () => {
  // Simultaneous clients exercise real process/endpoint ownership, not an in-memory singleton.
  const app = await setup();
  try {
    const clients = await Promise.all([app.connect(), app.connect(), app.connect(app.feature)]);
    const pid = clients[0]!.snapshot.pid;
    expect(new Set(clients.map((client) => client.snapshot.pid)).size).toBe(1);
    const id = await clients[0]!.create(app.repository.worktrees[0]!.id);
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

test("손상된 저장 기록은 복원 오류로 표시하고 빈 세션으로 덮어쓰거나 열린 항목을 잃지 않는다", async () => {
  // The corrupted file belongs only to this isolated SDK fixture.
  const app = await setup();
  try {
    const client = await app.connect();
    const id = await client.create(app.repository.worktrees[0]!.id);
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
    await restored.closeSession(id);
    await observed(restored, (state) => !state.details[id]);
    expect(await readFile(file, "utf8")).toBe("corrupt conversation\n");
  } finally { await app.cleanup(); }
}, 20000);

test("IPC history는 워크트리별 SDK 기록을 열고 이미 열린 saved ID는 기존 항목을 반환한다", async () => {
  // The real daemon discovers saved SDK files in a shared offline history directory.
  const app = await setup();
  try {
    const client = await app.connect();
    const main = app.repository.worktrees[0]!.id; const feature = app.repository.worktrees[1]!.id;
    const a = await client.create(main); const b = await client.create(feature);
    await client.prompt(a, "read"); await client.prompt(b, "write");
    await observed(client, (state) => state.details[a]?.status === "complete" && state.details[b]?.status === "complete");
    const saved = (await client.listHistory(main))[0]!;
    const file = (await app.manifest()).records.find((record) => record.id === a)!.sessionFile!;

    // Existing and closed histories both use the resume boundary, never SDK switch/fork.
    expect(await client.resume(main, saved.id)).toBe(a);
    await client.closeSession(a); await observed(client, (state) => state.closingCount === 0 && !state.details[a]);
    const reopened = await client.resume(main, saved.id);

    // The same file/context appears as another open item, and cross-worktree IDs stay rejected.
    expect(reopened).not.toBe(a);
    expect(client.snapshot.details[reopened]?.output).toContain("main-worktree-marker");
    expect((await app.manifest()).records.find((record) => record.id === reopened)?.sessionFile).toBe(file);
    expect(await client.listHistory(main)).toHaveLength(1);
    expect((await client.listHistory(feature))[0]?.title).toBe("write");
    await expect(client.resume(feature, saved.id)).rejects.toThrow("not available");
  } finally { await app.cleanup(); }
}, 20000);

test("현재 실행 중인 subagent의 저장 파일은 history로 중복 실행하지 않는다", async () => {
  // A child is an owned writer even though its file is a valid SDK saved conversation.
  const app = await setup();
  try {
    const client = await app.connect(); const main = app.repository.worktrees[0]!.id;
    const id = await client.create(main); await client.prompt(id, "delegate");
    await observed(client, (state) => state.repositories[0]?.worktrees[0]?.sessions[0]?.subagents[0]?.status === "working");
    let childId: string | undefined;
    await until(async () => { childId = (await client.listHistory(main)).find((entry) => entry.title === "slow")?.id; return !!childId; });

    // A history request cannot turn an active owned child into a second independent writer.
    const item = (await client.listHistory(main)).find((entry) => entry.id === childId)!;
    await expect(client.resume(main, childId!)).rejects.toThrow("active subagent");

    // Parent ownership and the single open-session item are unchanged.
    expect(item.unavailableReason).toContain("active subagent");
    expect(client.snapshot.repositories[0]!.worktrees[0]!.sessions.map((session) => session.id)).toEqual([id]);
  } finally { await app.cleanup(); }
}, 20000);
