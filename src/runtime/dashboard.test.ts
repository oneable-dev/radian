import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { emptyDashboard } from "../agents/dashboard.ts";
import { openRepositoryRuntime } from "./service.ts";
import { RuntimeClient } from "./client.ts";
import { emptyPreferences, protocolVersion, type RuntimeSnapshot } from "./protocol.ts";
import { runtimePaths } from "./storage.ts";

const snapshot = (supported = true): RuntimeSnapshot => ({ version: protocolVersion, pid: process.pid, instance: "fixture", repositoryId: "/fixture/.git", mode: "offline",
  repositories: [], details: {}, closingCount: 0, preferences: structuredClone(emptyPreferences), notice: "", capabilities: supported ? ["agent-dashboard"] : [] });
const paths = runtimePaths("/fixture/.git", true, "/tmp/radian-dashboard-client-test");
function mockFetch(implementation: (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(implementation, { preconnect: fetch.preconnect }));
}

test("이전 런타임의 대시보드 미지원은 재시작이나 요청 없이 명시한다", async () => {
  // 사용자의 작업 중인 구버전 서비스를 강제로 교체하면 안 된다.
  const request = mockFetch(async () => { throw new Error("No requests allowed"); }), client = new RuntimeClient(paths, snapshot(false));
  try {
    // 기능 협상은 네트워크 요청보다 먼저 수행한다.
    const result = expectError(await client.dashboard(7));

    // 통계를 0으로 위장하지 않고 명시적인 기능 부족을 반환한다.
    expect(result.code).toBe("UNSUPPORTED_CAPABILITY"); expect(request).not.toHaveBeenCalled();
  } finally { await client.disconnect(); request.mockRestore(); }
});

test("대시보드 응답은 instance-fenced GET이며 기간·숫자·버킷 개수를 검증한다", async () => {
  // 소켓의 응답도 신뢰하지 않고 공개 IPC 경계에서 검증한다.
  let response: unknown = emptyDashboard(7);
  const request = mockFetch(async (input, options) => {
    const url = new URL(String(input)); expect(url.pathname).toBe("/dashboard"); expect(url.searchParams.get("days")).toBe("7");
    expect(new Headers(options?.headers).get("X-Radian-Instance")).toBe("fixture"); return Response.json(response);
  });
  const client = new RuntimeClient(paths, snapshot());
  try {
    expect(expectOk(await client.dashboard(7)).daily).toHaveLength(7);

    // 다른 기간과 잘못된 소비량, 중복 날짜를 거절한다.
    for (const invalid of [emptyDashboard(1), { ...emptyDashboard(7), totals: { tokens: -1, runs: 1, durationMs: 0 } },
      { ...emptyDashboard(7), daily: Array(7).fill(emptyDashboard(7).daily[0]) }]) {
      response = invalid; expect(expectError(await client.dashboard(7)).code).toBe("PROTOCOL_ERROR");
    }

    // 취소된 요청은 새 네트워크 호출을 시작하지 않는다.
    const calls = request.mock.calls.length;
    expect(expectError(await client.dashboard(7, AbortSignal.abort())).code).toBe("CANCELLED"); expect(request.mock.calls).toHaveLength(calls);
  } finally { await client.disconnect(); request.mockRestore(); }
});

test("실제 SDK 실행 기록은 종료 후에도 대시보드에 남고 조회는 대화나 파일을 만들지 않는다", async () => {
  // 외부 모델이나 사용자 서비스를 건드리지 않는 실제 offline SDK 런타임을 연다.
  const fixture = await createWorktreeFixture();
  const runtime = expectOk(await openRepositoryRuntime(fixture.repository.id, true, "dashboard-runtime", join(fixture.directory, "state")));
  const request = (path: string, body?: unknown) => runtime.fetch(new Request(`http://localhost${path}`, {
    headers: { "X-Radian-Instance": runtime.instance, "Content-Type": "application/json" },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  }));
  try {
    const tree = fixture.repository.worktrees.find(tree => tree.path === fixture.main)!;
    const created = await (await request("/command", { type: "create", worktreeId: tree.id })).json() as { ok: boolean; value: string };
    expect(created.ok).toBe(true);
    await request("/command", { type: "prompt", sessionId: created.value, text: "read" });
    await new Promise<void>((resolve, reject) => {
      if (runtime.snapshot.details[created.value]?.result) { resolve(); return; }
      const timer = setTimeout(() => { unsubscribe(); reject(new Error("SDK execution did not settle")); }, 5000);
      const unsubscribe = runtime.subscribe(() => { if (runtime.snapshot.details[created.value]?.result) { clearTimeout(timer); unsubscribe(); resolve(); } });
    });
    await request("/command", { type: "close", sessionId: created.value });
    const before = runtime.snapshot.repositories.flatMap(repo => repo.worktrees.flatMap(tree => tree.sessions));

    // 저장된 기록을 읽는 경로와 잘못된 조회의 경계 검사를 실제 서비스에서 실행한다.
    const response = await request("/dashboard?days=7"), data = await response.json() as ReturnType<typeof emptyDashboard>;
    const invalid = await request("/dashboard?days=999");
    const unfenced = await runtime.fetch(new Request("http://localhost/dashboard?days=7"));

    // 닫힌 실행도 집계하고 조회만으로 SDK 실행이나 세션을 추가하지 않는다.
    expect(response.status).toBe(200); expect(data.totals.runs).toBe(1); expect(data.warnings).toEqual([]); expect(data.daily).toHaveLength(7);
    expect(invalid.status).toBe(400); expect(unfenced.status).toBe(422);
    expect(runtime.snapshot.repositories.flatMap(repo => repo.worktrees.flatMap(tree => tree.sessions))).toEqual(before);
  } finally { expectOk(await runtime.stop()); await fixture.cleanup(); }
});
