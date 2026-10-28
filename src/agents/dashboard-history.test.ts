import { expect, spyOn, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
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
  const cwd = join(directory, "project");
  const other = join(directory, "other");
  const sessions = join(directory, "sessions");

  await Promise.all([mkdir(cwd), mkdir(other), mkdir(sessions)]);

  const now = Date.now() - 1000;
  const timestamp = new Date(now).toISOString();
  const entries = (id: string, path = cwd) => [
    { type: "session", version: 3, id, cwd: path, timestamp },
    {
      type: "message",
      id: `${id}-q`,
      parentId: null,
      timestamp,
      message: { role: "user", content: "Question", timestamp: now },
    },
    {
      type: "message",
      id: `${id}-a`,
      parentId: `${id}-q`,
      timestamp,
      message: {
        role: "assistant",
        provider: "test",
        model: "large",
        content: [{ type: "text", text: "Answer" }],
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 },
        stopReason: "stop",
        timestamp: now,
      },
    },
    {
      type: "custom",
      id: `${id}-done`,
      parentId: `${id}-a`,
      timestamp,
      customType: runCompletionEntryType,
      data: { startedAt: now - 2000, completedAt: now, durationMs: 2000, outcome: "complete" },
    },
  ];
  const save = async (id: string, path = cwd) => {
    const file = join(sessions, `${id}.jsonl`);
    await writeFile(
      file,
      entries(id, path)
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    return file;
  };

  return {
    directory,
    cwd,
    other,
    sessions,
    now,
    repositories: [
      {
        id: "repo",
        name: "Project",
        worktrees: [cwd, other].map((path, index) => ({
          id: `tree-${index}`,
          path,
          name: `tree-${index}`,
          branch: "main",
          sessions: [],
        })),
      },
    ],
    save,
    entries,
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("Saved usage is read-only and rejects other workspaces and cancelled lookups", async () => {
  // Prepare readable statistics without write permissions or an SDK runner.
  const app = await fixture();
  try {
    const path = await app.save("saved");
    const before = await readFile(path, "utf8");

    // Verify scope, cancellation, and aggregation at the file boundary.
    const summary = expectOk(await readDashboardHistory(path, app.cwd, 7, Date.now(), new Set()));
    const mismatch = expectError(
      await readDashboardHistory(path, app.other, 7, Date.now(), new Set()),
    );
    const cancelled = expectError(
      await readDashboardHistory(path, app.cwd, 7, Date.now(), new Set(), AbortSignal.abort()),
    );

    // Neither run models nor migrate files.
    expect(summary.snapshot.totals).toEqual({ tokens: 120, runs: 1, durationMs: 2000 });
    expect(mismatch.code).toBe("HISTORY_UNAVAILABLE");
    expect(cancelled.code).toBe("CANCELLED");
    expect(await readFile(path, "utf8")).toBe(before);
  } finally {
    await app.cleanup();
  }
});

test("Shared SDK directories scope by project and warn about partially corrupt conversations", async () => {
  // Valid statistics remain readable beside other projects and corrupt files.
  const app = await fixture();
  let executions = 0;
  const repositories = [
    {
      id: "repo",
      name: "Project",
      worktrees: [{ id: "tree", path: app.cwd, name: "main", branch: "main", sessions: [] }],
    },
  ];
  const registry = new SessionRegistry(repositories, async () => {
    executions++;
    throw new Error("Dashboard must not start an executor");
  });
  try {
    await app.save("valid");
    await app.save("foreign", app.other);

    const corrupt = await app.save("corrupt");
    await writeFile(corrupt, (await readFile(corrupt, "utf8")) + "{invalid-json}\n");

    const history = new SessionHistory(repositories, registry, app.sessions);

    // Aggregate member paths through real SDK discovery.
    const result = expectOk(await history.dashboard(7));

    // Exclude other projects and partial results from failed files.
    expect(result.totals).toEqual({ tokens: 120, runs: 1, durationMs: 2000 });
    expect(result.warnings).toEqual([
      "A conversation was excluded [HISTORY_CORRUPT]. Refresh to retry.",
    ]);
    expect(executions).toBe(0);
    expect(registry.records).toEqual([]);
  } finally {
    await registry.shutdown();
    await app.cleanup();
  }
});

test.each(["same", "different"])(
  "Forked histories count shared ancestors once in the %s worktree",
  async (worktree) => {
    // Original and fork may belong to different worktrees in the same shared directory.
    const app = await fixture();
    const registry = new SessionRegistry(app.repositories, async () => {
      throw new Error("No executor allowed");
    });
    try {
      await app.save("original");

      const fork = app.entries("original", worktree === "different" ? app.other : app.cwd);
      fork[0] = { ...fork[0]!, id: "fork" };
      await writeFile(
        join(app.sessions, "fork.jsonl"),
        fork.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );

      // Count unique runs and model responses across all worktree indexes, not files.
      const result = expectOk(
        await new SessionHistory(app.repositories, registry, app.sessions).dashboard(7),
      );

      // Moving a fork to another worktree must not duplicate inherited usage.
      expect(result.totals).toEqual({ tokens: 120, runs: 1, durationMs: 2000 });
    } finally {
      await registry.shutdown();
      await app.cleanup();
    }
  },
);

test("Dashboard scans a shared SDK directory once per refresh and retains worktree scope", async () => {
  // Two member worktrees share storage with a foreign session outside the repository.
  const app = await fixture();
  const registry = new SessionRegistry(app.repositories, async () => {
    throw new Error("No executor allowed");
  });
  const directoryListing = spyOn(SessionManager, "listAll");
  const worktreeListing = spyOn(SessionManager, "list");
  try {
    await app.save("main");
    await app.save("other", app.other);
    await app.save("foreign", app.directory);
    const history = new SessionHistory(app.repositories, registry, app.sessions);

    // Reuse the directory scan across worktrees, but rediscover new files on the next refresh.
    const first = expectOk(await history.dashboard(7));
    expect(directoryListing).toHaveBeenCalledTimes(1);
    const foreign = expectError(await history.preview("tree-0", "foreign"));
    await app.save("new", app.other);
    const refreshed = expectOk(await history.dashboard(7));

    // Each member file contributes once; foreign metadata never becomes preview membership.
    expect(first.totals).toEqual({ tokens: 240, runs: 2, durationMs: 4000 });
    expect(refreshed.totals).toEqual({ tokens: 360, runs: 3, durationMs: 6000 });
    expect(foreign.code).toBe("HISTORY_UNAVAILABLE");
    expect(directoryListing).toHaveBeenCalledTimes(2);
    expect(directoryListing).toHaveBeenCalledWith(app.sessions, undefined, undefined);
    expect(worktreeListing).not.toHaveBeenCalled();
    expect(registry.records).toEqual([]);
  } finally {
    worktreeListing.mockRestore();
    directoryListing.mockRestore();
    await registry.shutdown();
    await app.cleanup();
  }
});

test("Empty shared directories are scanned once even when several worktrees have no usage", async () => {
  // An empty result is still a completed discovery, not a reason to retry for each worktree.
  const app = await fixture();
  const registry = new SessionRegistry(app.repositories, async () => {
    throw new Error("No executor allowed");
  });
  const directoryListing = spyOn(SessionManager, "listAll");
  const worktreeListing = spyOn(SessionManager, "list");
  try {
    // Aggregate an empty directory through the same public dashboard path.
    const result = expectOk(
      await new SessionHistory(app.repositories, registry, app.sessions).dashboard(7),
    );

    // Zero usage does not require duplicate metadata scans.
    expect(result.totals).toEqual({ tokens: 0, runs: 0, durationMs: 0 });
    expect(directoryListing).toHaveBeenCalledTimes(1);
    expect(worktreeListing).not.toHaveBeenCalled();
  } finally {
    worktreeListing.mockRestore();
    directoryListing.mockRestore();
    await registry.shutdown();
    await app.cleanup();
  }
});

test("Batched dashboard discovery preserves default per-worktree legacy directories", async () => {
  // Dedicated storage contains one session while a legacy directory supplies the other worktree.
  const app = await fixture();
  const registry = new SessionRegistry(app.repositories, async () => {
    throw new Error("No executor allowed");
  });
  const legacyPath = join(app.directory, "legacy.jsonl");
  const timestamp = new Date(app.now);
  const directoryListing = spyOn(SessionManager, "listAll");
  const worktreeListing = spyOn(SessionManager, "list").mockImplementation(async (cwd) =>
    cwd === app.other
      ? [
          {
            id: "legacy",
            path: legacyPath,
            cwd: app.other,
            created: timestamp,
            modified: timestamp,
            messageCount: 2,
            firstMessage: "Question",
            allMessagesText: "Question Answer",
          },
        ]
      : [],
  );
  try {
    await app.save("owned");
    await writeFile(
      legacyPath,
      app
        .entries("legacy", app.other)
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    // Batch only the shared directory; default directories remain scoped to their worktrees.
    const result = expectOk(
      await new SessionHistory(app.repositories, registry, app.sessions, undefined, true).dashboard(
        7,
      ),
    );

    // Both sources contribute without invoking a shared-directory scan per worktree.
    expect(result.totals).toEqual({ tokens: 240, runs: 2, durationMs: 4000 });
    expect(directoryListing).toHaveBeenCalledTimes(1);
    expect(worktreeListing.mock.calls.map(([cwd, directory]) => [cwd, directory])).toEqual([
      [app.cwd, undefined],
      [app.other, undefined],
    ]);
  } finally {
    worktreeListing.mockRestore();
    directoryListing.mockRestore();
    await registry.shutdown();
    await app.cleanup();
  }
});

test("Cancelled shared discovery forwards its signal without poisoning later dashboards", async () => {
  // A cancelled refresh must not leave its shared directory result in a longer-lived cache.
  const app = await fixture();
  const registry = new SessionRegistry(app.repositories, async () => {
    throw new Error("No executor allowed");
  });
  const abort = new AbortController();
  const directoryListing = spyOn(SessionManager, "listAll").mockImplementation(async () => {
    abort.abort();
    abort.signal.throwIfAborted();
    return [];
  });
  try {
    await app.save("saved");
    const history = new SessionHistory(app.repositories, registry, app.sessions);

    // Cancel during SDK discovery rather than only before dashboard entry.
    const cancelled = expectError(await history.dashboard(7, abort.signal));
    expect(directoryListing).toHaveBeenCalledWith(app.sessions, undefined, abort.signal);
    directoryListing.mockRestore();
    const recovered = expectOk(await history.dashboard(7));

    // A new request observes live files instead of reusing the cancelled attempt.
    expect(cancelled.code).toBe("CANCELLED");
    expect(recovered.totals).toEqual({ tokens: 120, runs: 1, durationMs: 2000 });
  } finally {
    directoryListing.mockRestore();
    await registry.shutdown();
    await app.cleanup();
  }
});
