import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDashboardHistory } from "./dashboard-history.ts";
import { SessionHistory } from "./history.ts";
import { SessionRegistry } from "./session-registry.ts";
import { runCompletionEntryType } from "./run-completion.ts";
import { expectError, expectOk } from "../testing/results.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "radian-dashboard-"));
  const cwd = join(directory, "project"), other = join(directory, "other"), sessions = join(directory, "sessions");
  await Promise.all([mkdir(cwd), mkdir(other), mkdir(sessions)]);
  const now = Date.now() - 1000, timestamp = new Date(now).toISOString();
  const entries = (id: string, path = cwd) => [
    { type: "session", version: 3, id, cwd: path, timestamp },
    { type: "message", id: `${id}-q`, parentId: null, timestamp, message: { role: "user", content: "Question", timestamp: now } },
    { type: "message", id: `${id}-a`, parentId: `${id}-q`, timestamp, message: { role: "assistant", provider: "test", model: "large", content: [{ type: "text", text: "Answer" }],
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 }, stopReason: "stop", timestamp: now } },
    { type: "custom", id: `${id}-done`, parentId: `${id}-a`, timestamp, customType: runCompletionEntryType,
      data: { startedAt: now - 2000, completedAt: now, durationMs: 2000, outcome: "complete" } },
  ];
  const save = async (id: string, path = cwd) => { const file = join(sessions, `${id}.jsonl`); await writeFile(file, entries(id, path).map(entry => JSON.stringify(entry)).join("\n") + "\n"); return file; };
  return { directory, cwd, other, sessions, now, save, entries, async cleanup() { await rm(directory, { recursive: true, force: true }); } };
}

test("저장 기록의 전체 소비량을 읽기만 하고 다른 워크스페이스와 취소된 조회는 거절한다", async () => {
  // 쓰기 권한이나 SDK 실행기 없이도 통계를 읽을 수 있는 저장 파일을 준비한다.
  const app = await fixture();
  try {
    const path = await app.save("saved"), before = await readFile(path, "utf8");

    // 실제 파일 경계에서 스코프·취소·집계를 확인한다.
    const summary = expectOk(await readDashboardHistory(path, app.cwd, 7, Date.now(), new Set()));
    const mismatch = expectError(await readDashboardHistory(path, app.other, 7, Date.now(), new Set()));
    const cancelled = expectError(await readDashboardHistory(path, app.cwd, 7, Date.now(), new Set(), AbortSignal.abort()));

    // 모델을 실행하거나 파일을 마이그레이션하지 않는다.
    expect(summary.snapshot.totals).toEqual({ tokens: 120, runs: 1, durationMs: 2000 });
    expect(mismatch.code).toBe("HISTORY_UNAVAILABLE"); expect(cancelled.code).toBe("CANCELLED"); expect(await readFile(path, "utf8")).toBe(before);
  } finally { await app.cleanup(); }
});

test("공유 SDK 디렉터리는 프로젝트로 한정하고 손상된 대화는 부분 집계 경고로 표시한다", async () => {
  // 다른 cwd의 SDK 파일과 손상된 파일이 같은 디렉터리에 있어도 정상 통계는 읽을 수 있어야 한다.
  const app = await fixture(); let executions = 0;
  const repositories = [{ id: "repo", name: "Project", worktrees: [{ id: "tree", path: app.cwd, name: "main", branch: "main", sessions: [] }] }];
  const registry = new SessionRegistry(repositories, async () => { executions++; throw new Error("Dashboard must not start an executor"); });
  try {
    await app.save("valid"); await app.save("foreign", app.other);
    const corrupt = await app.save("corrupt"); await writeFile(corrupt, (await readFile(corrupt, "utf8")) + "{invalid-json}\n");
    const history = new SessionHistory(repositories, registry, app.sessions);

    // 실제 SDK 검색을 통해 구성원의 경로만 집계한다.
    const result = expectOk(await history.dashboard(7));

    // 다른 프로젝트의 토큰과 실패한 파일의 부분 결과를 정상 합계에 섞지 않는다.
    expect(result.totals).toEqual({ tokens: 120, runs: 1, durationMs: 2000 }); expect(result.warnings).toEqual(["A conversation was excluded [HISTORY_CORRUPT]. Refresh to retry."]);
    expect(executions).toBe(0); expect(registry.records).toEqual([]);
  } finally { await registry.shutdown(); await app.cleanup(); }
});

test("저장 기록의 포크 공통 조상은 대화 파일 간에 중복 집계하지 않는다", async () => {
  // 원본과 포크에 동일한 과거 엔트리가 들어 있는 실제 JSONL 파일을 만든다.
  const app = await fixture();
  const repositories = [{ id: "repo", name: "Project", worktrees: [{ id: "tree", path: app.cwd, name: "main", branch: "main", sessions: [] }] }];
  const registry = new SessionRegistry(repositories, async () => { throw new Error("No executor allowed"); });
  try {
    await app.save("original");
    const fork = app.entries("original"); fork[0] = { ...fork[0]!, id: "fork" };
    await writeFile(join(app.sessions, "fork.jsonl"), fork.map(entry => JSON.stringify(entry)).join("\n") + "\n");

    // 파일 수가 아니라 실제 고유 실행과 모델 응답을 집계한다.
    const result = expectOk(await new SessionHistory(repositories, registry, app.sessions).dashboard(7));

    // 포크는 기존 토큰과 실행 시간을 다시 소비하지 않았다.
    expect(result.totals).toEqual({ tokens: 120, runs: 1, durationMs: 2000 });
  } finally { await registry.shutdown(); await app.cleanup(); }
});
