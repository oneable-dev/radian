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

test("Legacy dashboard unavailability is explicit without requests or restarts", async () => {
  // Never forcibly replace users' active legacy services.
  const request = mockFetch(async () => { throw new Error("No requests allowed"); }), client = new RuntimeClient(paths, snapshot(false));
  try {
    // Negotiate capabilities before network requests.
    const result = expectError(await client.dashboard(7));

    // Return unsupported errors rather than fabricated zero statistics.
    expect(result.code).toBe("UNSUPPORTED_CAPABILITY"); expect(request).not.toHaveBeenCalled();
  } finally { await client.disconnect(); request.mockRestore(); }
});

test("Dashboard instance-fenced GET validates periods, numbers, and bucket counts", async () => {
  // Validate even socket responses at public IPC boundaries.
  let response: unknown = emptyDashboard(7);
  const request = mockFetch(async (input, options) => {
    const url = new URL(String(input)); expect(url.pathname).toBe("/dashboard"); expect(url.searchParams.get("days")).toBe("7");
    expect(new Headers(options?.headers).get("X-Radian-Instance")).toBe("fixture"); return Response.json(response);
  });
  const client = new RuntimeClient(paths, snapshot());
  try {
    expect(expectOk(await client.dashboard(7)).daily).toHaveLength(7);

    // Reject wrong periods, invalid usage, and duplicate dates.
    for (const invalid of [emptyDashboard(1), { ...emptyDashboard(7), totals: { tokens: -1, runs: 1, durationMs: 0 } },
      { ...emptyDashboard(7), daily: Array(7).fill(emptyDashboard(7).daily[0]) }]) {
      response = invalid; expect(expectError(await client.dashboard(7)).code).toBe("PROTOCOL_ERROR");
    }

    // Cancelled requests never initiate new network calls.
    const calls = request.mock.calls.length;
    expect(expectError(await client.dashboard(7, AbortSignal.abort())).code).toBe("CANCELLED"); expect(request.mock.calls).toHaveLength(calls);
  } finally { await client.disconnect(); request.mockRestore(); }
});

test("Real SDK history remains in dashboards after closure and reads create no files or conversations", async () => {
  // Open real offline SDK runtimes without touching external models or user services.
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

    // Exercise persisted reads and invalid-query guards through actual services.
    const response = await request("/dashboard?days=7"), data = await response.json() as ReturnType<typeof emptyDashboard>;
    const invalid = await request("/dashboard?days=999");
    const unfenced = await runtime.fetch(new Request("http://localhost/dashboard?days=7"));

    // Aggregate closed runs without creating SDK executions or sessions during reads.
    expect(response.status).toBe(200); expect(data.totals.runs).toBe(1); expect(data.warnings).toEqual([]); expect(data.daily).toHaveLength(7);
    expect(invalid.status).toBe(400); expect(unfenced.status).toBe(422);
    expect(runtime.snapshot.repositories.flatMap(repo => repo.worktrees.flatMap(tree => tree.sessions))).toEqual(before);
  } finally { expectOk(await runtime.stop()); await fixture.cleanup(); }
});
