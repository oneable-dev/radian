import { expect, test } from "bun:test";
import { mkdir, realpath, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectOk } from "../testing/results.ts";
import type { SessionRecord } from "../agents/session-registry.ts";
import { connectRuntime, fetchSnapshot, type RuntimeClient } from "./client.ts";
import { privateDirectory, pidAlive, runtimePaths, RuntimeStore } from "./storage.ts";
import { emptyPreferences } from "./protocol.ts";
import { retentionDayMs } from "./session-retention.ts";

test.each([
  { days: "default", policy: {}, age: 31, removed: true },
  { days: 7, policy: { retentionDays: 7 }, age: 10, removed: true },
  { days: "unlimited", policy: { retentionDays: null }, age: 100, removed: false },
])("실제 데몬은 --config의 $days 보관 정책으로 닫힌 소유 기록만 시작 시 정리한다", async ({ policy, age, removed }) => {
  // SDK·IPC는 실제로 사용하되 정책 적용 대상은 새 임시 저장소 안에만 만든다.
  const fixture = await createWorktreeFixture();
  const options = { offline: true, stateRoot: join(fixture.directory, "state"), entry: join(import.meta.dir, "..", "index.ts"), config: join(fixture.directory, "settings.json") };
  const paths = runtimePaths(fixture.repository.id, true, options.stateRoot), tree = fixture.repository.worktrees[0]!;
  let client: RuntimeClient | undefined;
  try {
    await privateDirectory(paths.directory);
    await writeFile(options.config, JSON.stringify({ theme: { accent: "#123456" }, workspace: { roots: [] }, sessions: policy }));
    const directory = join(paths.directory, "offline-agent", "sessions"); await mkdir(directory, { recursive: true });
    const records: SessionRecord[] = [];
    for (const [id, managed, lifecycle, days] of [["owned", true, "closed", age], ["external", false, "closed", 100], ["protected", true, "open", 100]] as const) {
      const closedAt = Date.now() - days * retentionDayMs, file = join(directory, `${id}.jsonl`);
      await writeFile(file, JSON.stringify({ type: "session", version: 3, id, cwd: tree.path, timestamp: new Date(closedAt).toISOString() }) + "\n");
      await utimes(file, closedAt / 1000, closedAt / 1000);
      records.push({ id, name: id, worktreeId: tree.id, cwd: tree.path, sessionFile: await realpath(file), lifecycle, managed,
        closedAt: lifecycle === "closed" ? closedAt : null, updatedAt: closedAt + 1000,
        state: { conversationId: id, status: null, output: "", error: null, sections: [] }, subagents: [] });
    }
    expectOk(await new RuntimeStore(paths).save({ version: 1, repositoryId: fixture.repository.id, repositories: [fixture.repository], records, preferences: structuredClone(emptyPreferences) }));

    // 서로 다른 cwd에서 실행되는 데몬에도 CLI가 선택한 통합 설정 경로가 전달돼야 한다.
    const connected = expectOk(await connectRuntime(fixture.repository, fixture.main, options)); if (!connected) throw new Error("Missing runtime"); client = connected;
    if (!client.snapshot.sessionRetention) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error("Initial retention sweep timed out")); }, 10000);
      const unsubscribe = connected.subscribe(() => { if (connected.snapshot.sessionRetention) { clearTimeout(timer); unsubscribe(); resolve(); } });
    });
    const history = expectOk(await client.listHistory(tree.id));

    // 열린 세션은 재실행만 복구하고 외부 기록은 정리하지 않으며 만료 기록만 보이지 않는다.
    expect(Object.keys(client.snapshot.details)).toEqual(["protected"]);
    expect(client.snapshot.sessionRetention?.retentionDays).toBe("retentionDays" in policy ? policy.retentionDays : 30);
    expect(client.snapshot.sessionRetention?.removed).toBe(removed ? 1 : 0);
    expect(await Bun.file(records[0]!.sessionFile!).exists()).toBe(!removed);
    expect(await Bun.file(records[1]!.sessionFile!).exists()).toBe(true); expect(await Bun.file(records[2]!.sessionFile!).exists()).toBe(true);
    expect(history.some(item => item.id === "owned")).toBe(!removed); expect(history.some(item => item.id === "external")).toBe(true);
    expect(client.snapshot.notice).not.toContain("Session cleanup");
  } finally {
    const running = client ?? expectOk(await connectRuntime(fixture.repository, fixture.main, { ...options, start: false }));
    if (running) {
      const pid = running.snapshot.pid; expectOk(await running.stopRuntime()); await running.disconnect();
      const deadline = Date.now() + 12000;
      while (pidAlive(pid) || expectOk(await fetchSnapshot(paths))) { if (Date.now() > deadline) throw new Error("Runtime stop timed out"); await Bun.sleep(20); }
    }
    await fixture.cleanup();
  }
}, 20000);
