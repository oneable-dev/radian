import { expect, spyOn, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDashboardHistory } from "./dashboard-history.ts";
import { SessionHistory } from "./history.ts";
import { SessionRegistry, type SessionRecord } from "./session-registry.ts";
import type { SessionSnapshotSource } from "./session-snapshot.ts";
import { agentCoverageWarning } from "./dashboard.ts";
import { StorageError } from "../errors.ts";
import { err, ok } from "../result.ts";
import { runCompletionEntryType } from "./run-completion.ts";
import { expectError, expectOk } from "../testing/results.ts";

function snapshotsFor(records: readonly SessionRecord[], now: number): SessionSnapshotSource {
  return {
    listSessions: (worktreeId) =>
      records
        .filter((record) => record.worktreeId === worktreeId)
        .map((record) => ({
          id: record.id,
          name: record.name,
          worktreeId,
          conversationId: record.state.conversationId ?? record.id,
          ...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
          lifecycle: "closed",
          updatedAt: now,
          title: record.name,
          messageCount: 2,
        })),
    readSession: async (_tree, id) =>
      ok(records.find((record) => (record.state.conversationId ?? record.id) === id) ?? null),
  };
}

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
      agentCoverageWarning,
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

test("Durable ownership attributes Main and nested profiles while forks retain source token ownership", async () => {
  // Closed metadata retains hidden and nested children; session titles are not profile names.
  const app = await fixture();
  const registry = new SessionRegistry(app.repositories, async () => {
    throw new Error("No executor allowed");
  });
  try {
    const main = await app.save("main");
    const engineer = await app.save("engineer");
    const qa = await app.save("qa");
    const legacy = await app.save("legacy");
    const fork = join(app.sessions, "fork.jsonl");
    const inherited = app.entries("engineer");
    const extra = app.entries("fork").slice(1);
    await writeFile(
      fork,
      [{ ...inherited[0], id: "fork", parentSession: engineer }, ...inherited.slice(1), ...extra]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const records: SessionRecord[] = [
      {
        id: "root",
        name: "A user title, not an agent",
        worktreeId: "tree-0",
        sessionFile: main,
        state: { conversationId: "main", status: "complete", output: "", error: null },
        subagents: [],
        lifecycle: "closed",
        cwd: app.cwd,
        ownedSubagents: [
          {
            id: "engineer",
            name: "engineer",
            sessionFile: engineer,
            status: "complete",
            output: "",
            hidden: true,
            progress: [],
            ownerId: "root",
            rootId: "root",
            depth: 1,
          },
          {
            id: "qa",
            name: "qa",
            sessionFile: qa,
            status: "complete",
            output: "",
            hidden: true,
            progress: [],
            ownerId: "engineer",
            rootId: "root",
            depth: 2,
          },
        ],
      },
      {
        id: "fork-root",
        name: "Another user title",
        worktreeId: "tree-0",
        sessionFile: fork,
        state: { conversationId: "fork", status: "complete", output: "", error: null },
        subagents: [],
        ownedSubagents: [],
      },
      ...[
        ["engineer", engineer],
        ["qa", qa],
        ["legacy", legacy],
      ].map(([id, sessionFile]): SessionRecord => ({
        // Legacy code children were archived without role or ownedSubagents.
        id: id!,
        name: "A renamed child title",
        worktreeId: "tree-0",
        sessionFile: sessionFile!,
        state: { conversationId: id!, status: "complete", output: "", error: null },
        subagents: [],
      })),
    ];
    const snapshots = snapshotsFor(records, app.now);
    const before = await readFile(engineer, "utf8");

    // SDK discovery supplies lineage; only direct raw usage contributes tokens.
    const result = expectOk(
      await new SessionHistory(app.repositories, registry, app.sessions, snapshots).dashboard(7),
    );

    // Copied engineer responses stay with engineer, never with the newer fork's Main role.
    expect(result.agents).toEqual([
      {
        kind: "main",
        name: "Main",
        value: 240,
        input: 200,
        output: 40,
        cacheRead: 0,
        cacheWrite: 0,
      },
      {
        kind: "profile",
        name: "engineer",
        value: 120,
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
      },
      {
        kind: "profile",
        name: "qa",
        value: 120,
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
      },
      {
        kind: "unattributed",
        name: "Unattributed",
        value: 120,
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
      },
    ]);
    expect(result.totals).toEqual({ tokens: 600, runs: 5, durationMs: 10000 });
    expect(result.warnings).toEqual([agentCoverageWarning]);
    expect(await readFile(engineer, "utf8")).toBe(before);
    expect(registry.records).toEqual([]);
  } finally {
    await registry.shutdown();
    await app.cleanup();
  }
});

test.each(["corrupt", "missing", "cycle"])(
  "Forks with %s source lineage do not guess inherited token ownership",
  async (lineage) => {
    // Even known owner snapshots cannot identify the origin of copied entries after source loss.
    const app = await fixture();
    const registry = new SessionRegistry(app.repositories, async () => {
      throw new Error("No executor allowed");
    });
    try {
      const source = await app.save("source");
      const fork = join(app.sessions, "fork.jsonl");
      const dependent = join(app.sessions, "dependent.jsonl");
      const entries = app.entries("source");
      const forkEntries = [
        { ...entries[0], id: "fork", parentSession: source },
        ...entries.slice(1),
        ...app.entries("fork").slice(1),
      ];
      const save = (path: string, values: readonly unknown[]) =>
        writeFile(path, values.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      await save(fork, forkEntries);
      await save(dependent, [
        { ...entries[0], id: "dependent", parentSession: fork },
        ...forkEntries.slice(1),
        ...app.entries("dependent").slice(1),
      ]);
      if (lineage === "corrupt")
        await writeFile(source, (await readFile(source, "utf8")) + "{broken}\n");
      if (lineage === "missing") await rm(source);
      if (lineage === "cycle")
        await save(source, [{ ...entries[0], parentSession: fork }, ...entries.slice(1)]);
      const records: SessionRecord[] = [
        ["source", source],
        ["fork", fork],
        ["dependent", dependent],
      ].map(([id, sessionFile]) => ({
        id: id!,
        name: "Known owner",
        worktreeId: "tree-0",
        sessionFile: sessionFile!,
        state: { conversationId: id!, status: "complete", output: "", error: null },
        subagents: [],
        ownedSubagents: [],
      }));

      // Carry source uncertainty through multiple forks while preserving global entry deduplication.
      const result = expectOk(
        await new SessionHistory(
          app.repositories,
          registry,
          app.sessions,
          snapshotsFor(records, app.now),
        ).dashboard(7),
      );

      // Valid fork copies still preserve consumption, but never inherit a guessed Main identity.
      expect(result.totals.tokens).toBe(360);
      expect(result.agents).toEqual([
        {
          kind: "unattributed",
          name: "Unattributed",
          value: 360,
          input: 300,
          output: 60,
          cacheRead: 0,
          cacheWrite: 0,
        },
      ]);
      expect(result.warnings).toContain(agentCoverageWarning);
      if (lineage === "corrupt")
        expect(result.warnings).toContain(
          "A conversation was excluded [HISTORY_CORRUPT]. Refresh to retry.",
        );
    } finally {
      await registry.shutdown();
      await app.cleanup();
    }
  },
);

test("Failed ownership metadata preserves usage and duplicate snapshot references are read once", async () => {
  // Identity lookup is advisory: it must neither erase consumption nor retry duplicate references.
  const app = await fixture();
  const registry = new SessionRegistry(app.repositories, async () => {
    throw new Error("No executor allowed");
  });
  try {
    const path = await app.save("saved");
    const record: SessionRecord = {
      id: "saved",
      name: "Not a profile",
      worktreeId: "tree-0",
      sessionFile: path,
      state: { status: "complete", output: "", error: null },
      subagents: [],
      ownedSubagents: [],
    };
    const snapshots = snapshotsFor([record, record], app.now);
    let reads = 0;
    snapshots.readSession = async () => {
      reads++;
      return err(new StorageError("Fixture metadata is unavailable."));
    };

    // An expected snapshot failure does not reject the independently readable raw history.
    const result = expectOk(
      await new SessionHistory(app.repositories, registry, app.sessions, snapshots).dashboard(7),
    );

    // Missing metadata remains explicit and shared references do not trigger duplicate hydration.
    expect(result.agents).toEqual([
      {
        kind: "unattributed",
        name: "Unattributed",
        value: 120,
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
      },
    ]);
    expect(result.warnings).toContain(agentCoverageWarning);
    expect(
      result.warnings.some((warning) => warning.includes("identities could not be read")),
    ).toBe(true);
    expect(reads).toBe(1);
  } finally {
    await registry.shutdown();
    await app.cleanup();
  }
});

test("Conflicting durable child profiles stay unattributed instead of using the last snapshot", async () => {
  // Independent durable owners disagree about the same file's profile identity.
  const app = await fixture();
  const registry = new SessionRegistry(app.repositories, async () => {
    throw new Error("No executor allowed");
  });
  try {
    const path = await app.save("ambiguous");
    const records: SessionRecord[] = ["engineer", "qa"].map((name) => ({
      id: `owner-${name}`,
      name: "Owner",
      worktreeId: "tree-0",
      state: { status: "complete", output: "", error: null },
      subagents: [],
      ownedSubagents: [
        {
          id: "child",
          name,
          sessionFile: path,
          status: "complete",
          output: "",
          hidden: false,
          progress: [],
        },
      ],
    }));

    // Neither snapshot order nor a familiar profile name can resolve contradictory ownership.
    const result = expectOk(
      await new SessionHistory(
        app.repositories,
        registry,
        app.sessions,
        snapshotsFor(records, app.now),
      ).dashboard(7),
    );

    // Keep observed tokens while explicitly declaring identity coverage incomplete.
    expect(result.agents?.map(({ kind, name, value }) => ({ kind, name, value }))).toEqual([
      { kind: "unattributed", name: "Unattributed", value: 120 },
    ]);
    expect(result.warnings).toEqual([agentCoverageWarning]);
  } finally {
    await registry.shutdown();
    await app.cleanup();
  }
});

test.each(["live", "persisted"])(
  "Resuming an archived child as Main leaves mixed-role usage unattributed with %s ownership",
  async (ownership) => {
    // Archived code children have no role; only their original owner's metadata identifies them.
    const app = await fixture();
    const path = join(app.sessions, "child.jsonl");
    const registry = new SessionRegistry(app.repositories, async (context) => {
      expect(context.role).toBe("main");
      expect(context.sessionFile).toBe(await realpath(path));
      return {
        savedSessionId: "child",
        sessionFile: path,
        state: { status: "complete", output: "", error: null },
        subscribe: () => () => {},
        prompt: async () => {
          const entries = app.entries("resumed-main");
          await appendFile(
            path,
            [
              { ...entries[1], parentId: "child-done" },
              {
                ...entries[2],
                message: {
                  ...entries[2]!.message,
                  usage: { input: 30, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 40 },
                },
              },
            ]
              .map((entry) => JSON.stringify(entry))
              .join("\n") + "\n",
          );
          return ok(undefined);
        },
        close: async () => ok(undefined),
      };
    });
    try {
      await app.save("child");
      const child: SessionRecord = {
        id: "child",
        name: "engineer",
        worktreeId: "tree-0",
        sessionFile: path,
        state: { conversationId: "child", status: "complete", output: "", error: null },
        subagents: [],
      };
      const owner: SessionRecord = {
        id: "original-owner",
        name: "Owner",
        worktreeId: "tree-0",
        state: { status: "complete", output: "", error: null },
        subagents: [],
        ownedSubagents: [
          {
            id: "child",
            name: "engineer",
            sessionFile: path,
            status: "complete",
            output: "",
            hidden: true,
            progress: [],
          },
        ],
      };
      let history = new SessionHistory(
        app.repositories,
        registry,
        app.sessions,
        snapshotsFor([owner, child], app.now),
      );
      const original = expectOk(await history.dashboard(7));
      expect(original.agents?.map(({ kind, name, value }) => ({ kind, name, value }))).toEqual([
        { kind: "profile", name: "engineer", value: 120 },
      ]);
      expect(original.warnings).toEqual([]);
      expect(expectOk(await history.list("tree-0")).map((item) => item.id)).toEqual(["child"]);

      // The supported resume path reuses the child JSONL as a Main writer and appends fresh usage.
      const resumed = expectOk(await history.resume("tree-0", "child"));
      expectOk(await registry.prompt(resumed, "Continue as Main"));
      expect(registry.checkpointRecords[0]?.ownedSubagents).toEqual([]);
      if (ownership === "persisted") {
        expectOk(await registry.close(resumed));
        const records = registry.checkpointRecords;
        history = new SessionHistory(
          app.repositories,
          registry,
          app.sessions,
          snapshotsFor([owner, ...records], app.now),
        );
        registry.acknowledgeCheckpoint(records);
        expect(registry.checkpointRecords).toEqual([]);
      }
      const before = await readFile(path, "utf8");
      const result = expectOk(await history.dashboard(7));

      // Per-entry roles are unavailable: neither the old profile nor Main may claim either response.
      expect(result.totals.tokens).toBe(160);
      expect(result.agents).toEqual([
        {
          kind: "unattributed",
          name: "Unattributed",
          value: 160,
          input: 130,
          output: 30,
          cacheRead: 0,
          cacheWrite: 0,
        },
      ]);
      expect(result.warnings).toEqual([agentCoverageWarning]);
      expect(await readFile(path, "utf8")).toBe(before);
    } finally {
      await registry.shutdown();
      await app.cleanup();
    }
  },
);

test("Cancellation during ownership lookup stops before token scans", async () => {
  // Snapshot hydration does not accept a signal, so the caller rechecks it immediately afterward.
  const app = await fixture();
  const registry = new SessionRegistry(app.repositories, async () => {
    throw new Error("No executor allowed");
  });
  const abort = new AbortController();
  try {
    const path = await app.save("saved");
    const record: SessionRecord = {
      id: "saved",
      name: "Owner",
      worktreeId: "tree-0",
      sessionFile: path,
      state: { status: "complete", output: "", error: null },
      subagents: [],
      ownedSubagents: [],
    };
    const snapshots = snapshotsFor([record], app.now);
    snapshots.readSession = async () => {
      abort.abort();
      return ok(record);
    };

    // Stop the request even when the metadata read itself returned a successful Result.
    const result = expectError(
      await new SessionHistory(app.repositories, registry, app.sessions, snapshots).dashboard(
        7,
        abort.signal,
      ),
    );

    // Cancellation must propagate rather than turning into zero or partial statistics.
    expect(result.code).toBe("CANCELLED");
  } finally {
    await registry.shutdown();
    await app.cleanup();
  }
});
