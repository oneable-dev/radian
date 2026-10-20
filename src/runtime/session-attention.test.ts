import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { connectRuntime, fetchSnapshot, type RuntimeClient } from "./client.ts";
import { pidAlive } from "./storage.ts";
import { emptyPreferences, parseCommand, parseSnapshot, type RuntimeManifest, type RuntimeSnapshot } from "./protocol.ts";
import { expectError, expectOk } from "../testing/results.ts";

function observed(client: RuntimeClient, predicate: (snapshot: RuntimeSnapshot) => boolean): Promise<void> {
  if (predicate(client.snapshot)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("Attention snapshot timed out")); }, 10000);
    const unsubscribe = client.subscribe(() => { if (predicate(client.snapshot)) { clearTimeout(timer); unsubscribe(); resolve(); } });
  });
}
async function fixture() {
  const app = await createWorktreeFixture(), clients: RuntimeClient[] = [];
  const options = { offline: true, stateRoot: join(app.directory, "state"), entry: join(import.meta.dir, "..", "index.ts") };
  const connect = async () => {
    const client = expectOk(await connectRuntime(app.repository, app.main, options));
    if (!client) throw new Error("Missing test runtime"); clients.push(client); return client;
  };
  const stopped = async (client: RuntimeClient) => {
    const deadline = Date.now() + 10000;
    while (expectOk(await fetchSnapshot(client.paths)) || pidAlive(client.snapshot.pid)) {
      if (Date.now() > deadline) throw new Error("Test runtime did not stop");
      await Bun.sleep(20);
    }
  };
  return { ...app, connect, stopped,
    async cleanup() {
      const running = expectOk(await connectRuntime(app.repository, app.main, { ...options, start: false }));
      if (running) { expectOk(await running.stopRuntime()); await running.disconnect(); await stopped(running); }
      await Promise.all(clients.map(client => client.disconnect())); await app.cleanup();
    } };
}

test("실제 런타임은 TUI 없이 완료된 결과를 저장하고 모든 연결에서 같은 결과를 확인한다", async () => {
  // 실제 Git·SDK·IPC를 사용하되 모델은 격리된 offline fixture다.
  const app = await fixture();
  try {
    const first = await app.connect(), tree = app.repository.worktrees.find(tree => tree.path === app.main)!;
    const id = expectOk(await first.create(tree.id));
    expect(first.snapshot.capabilities).toContain("session-attention");
    expectOk(await first.prompt(id, "read")); await observed(first, state => !!state.details[id]?.attention);
    const attention = first.snapshot.details[id]!.attention!, conversation = first.snapshot.details[id]!.conversationId!;
    const second = await app.connect();
    expect(second.snapshot.details[id]?.attention?.id).toBe(attention.id);

    // 오래된 결과나 대화의 확인 요청이 최신 결과를 지우면 안 된다.
    expect(expectError(await second.acknowledge(id, "outgoing", attention.id)).code).toBe("SESSION_CONFLICT");
    expectOk(await second.acknowledge(id, conversation, "outdated-result"));
    expect(second.snapshot.details[id]?.attention?.id).toBe(attention.id);
    expectOk(await second.acknowledge(id, conversation, attention.id));
    await observed(first, state => !state.details[id]?.attention);
    await observed(second, state => !state.details[id]?.attention);

    const saved: RuntimeManifest = JSON.parse(await readFile(first.paths.manifest, "utf8"));
    expect(saved.records.find(record => record.id === id)?.state.attention).toBeUndefined();
    expect(first.snapshot.details[id]?.result?.id).toBe(attention.id);
    expect(first.snapshot.details[id]?.status).toBe("complete");
  } finally { await app.cleanup(); }
}, 25000);

test("서비스 재시작은 미확인을 복원하고 사용자 취소는 이전 알림을 덮어쓰지 않는다", async () => {
  // 읽음 상태는 TUI의 임시 캐시나 과거 대화 재생에 의존하지 않는다.
  const app = await fixture();
  try {
    const first = await app.connect(), tree = app.repository.worktrees.find(tree => tree.path === app.main)!;
    const id = expectOk(await first.create(tree.id));
    expectOk(await first.prompt(id, "read")); await observed(first, state => !!state.details[id]?.attention);
    const resultId = first.snapshot.details[id]!.attention!.id;
    expectOk(await first.stopRuntime()); await first.disconnect(); await app.stopped(first);

    const restored = await app.connect();
    expect(restored.snapshot.details[id]?.attention?.id).toBe(resultId);
    expectOk(await restored.prompt(id, "slow"));
    await observed(restored, state => state.details[id]?.status === "working");
    expectOk(await restored.interrupt(id));
    await observed(restored, state => state.details[id]?.result?.outcome === "cancelled");

    expect(restored.snapshot.details[id]?.result?.cancellation).toBe("user");
    expect(restored.snapshot.details[id]?.attention?.id).toBe(resultId);
    expectOk(await restored.acknowledge(id, restored.snapshot.details[id]!.conversationId!, resultId));
    await observed(restored, state => !state.details[id]?.attention);
    expectOk(await restored.prompt(id, "/clear"));
    await observed(restored, state => !state.details[id]?.result && !state.details[id]?.attention);
  } finally { await app.cleanup(); }
}, 25000);

test("읽음 메타데이터는 기존 snapshot과 호환되고 잘못된 결과·확인 명령은 경계에서 거부한다", () => {
  // 필드가 없는 구형 서비스는 읽음 상태를 추측하지 않고 그대로 연결할 수 있다.
  const legacy = { version: 1, pid: 1, instance: "legacy", mode: "offline", repositoryId: "repo", repositories: [], details: { tab: { status: null, output: "", error: null } }, closingCount: 0, preferences: emptyPreferences, notice: "" };

  expect(expectOk(parseSnapshot(legacy)).details.tab?.attention).toBeUndefined();
  expect(expectError(parseSnapshot({ ...legacy, details: { tab: { ...legacy.details.tab, attention: { id: "result", outcome: "idle", completedAt: 1 } } } })).code).toBe("PROTOCOL_ERROR");
  expect(expectError(parseCommand(JSON.stringify({ type: "acknowledge", sessionId: "tab", conversationId: "conversation" }))).code).toBe("INVALID_INPUT");
});
