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

test("Saved usage is read-only and rejects other workspaces and cancelled lookups", async () => {
  // Prepare readable statistics without write permissions or an SDK runner.
  const app = await fixture();
  try {
    const path = await app.save("saved"), before = await readFile(path, "utf8");

    // Verify scope, cancellation, and aggregation at the file boundary.
    const summary = expectOk(await readDashboardHistory(path, app.cwd, 7, Date.now(), new Set()));
    const mismatch = expectError(await readDashboardHistory(path, app.other, 7, Date.now(), new Set()));
    const cancelled = expectError(await readDashboardHistory(path, app.cwd, 7, Date.now(), new Set(), AbortSignal.abort()));

    // Neither run models nor migrate files.
    expect(summary.snapshot.totals).toEqual({ tokens: 120, runs: 1, durationMs: 2000 });
    expect(mismatch.code).toBe("HISTORY_UNAVAILABLE"); expect(cancelled.code).toBe("CANCELLED"); expect(await readFile(path, "utf8")).toBe(before);
  } finally { await app.cleanup(); }
});

test("Shared SDK directories scope by project and warn about partially corrupt conversations", async () => {
  // Valid statistics remain readable beside other projects and corrupt files.
  const app = await fixture(); let executions = 0;
  const repositories = [{ id: "repo", name: "Project", worktrees: [{ id: "tree", path: app.cwd, name: "main", branch: "main", sessions: [] }] }];
  const registry = new SessionRegistry(repositories, async () => { executions++; throw new Error("Dashboard must not start an executor"); });
  try {
    await app.save("valid"); await app.save("foreign", app.other);
    const corrupt = await app.save("corrupt"); await writeFile(corrupt, (await readFile(corrupt, "utf8")) + "{invalid-json}\n");
    const history = new SessionHistory(repositories, registry, app.sessions);

    // Aggregate member paths through real SDK discovery.
    const result = expectOk(await history.dashboard(7));

    // Exclude other projects and partial results from failed files.
    expect(result.totals).toEqual({ tokens: 120, runs: 1, durationMs: 2000 }); expect(result.warnings).toEqual(["A conversation was excluded [HISTORY_CORRUPT]. Refresh to retry."]);
    expect(executions).toBe(0); expect(registry.records).toEqual([]);
  } finally { await registry.shutdown(); await app.cleanup(); }
});

test("Forked histories count shared ancestors only once across conversation files", async () => {
  // Create real JSONL files with shared historical entries in original and fork.
  const app = await fixture();
  const repositories = [{ id: "repo", name: "Project", worktrees: [{ id: "tree", path: app.cwd, name: "main", branch: "main", sessions: [] }] }];
  const registry = new SessionRegistry(repositories, async () => { throw new Error("No executor allowed"); });
  try {
    await app.save("original");
    const fork = app.entries("original"); fork[0] = { ...fork[0]!, id: "fork" };
    await writeFile(join(app.sessions, "fork.jsonl"), fork.map(entry => JSON.stringify(entry)).join("\n") + "\n");

    // Count unique runs and model responses, not files.
    const result = expectOk(await new SessionHistory(repositories, registry, app.sessions).dashboard(7));

    // Forks did not consume historical tokens or run time again.
    expect(result.totals).toEqual({ tokens: 120, runs: 1, durationMs: 2000 });
  } finally { await registry.shutdown(); await app.cleanup(); }
});
