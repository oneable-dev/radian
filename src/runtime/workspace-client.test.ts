import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionError, InputError, StorageError } from "../errors.ts";
import { ok, err } from "../result.ts";
import { expectError, expectOk } from "../testing/results.ts";
import type { Repository } from "../workspace/model.ts";
import { emptyDashboard } from "../agents/dashboard.ts";
import { defaultPreferences } from "./client.ts";
import type { RuntimePreferences, RuntimeSnapshot } from "./protocol.ts";
import { WorkspaceClient, type RepositoryClient } from "./workspace-client.ts";
import { privateDirectory, RuntimeStore, runtimePaths } from "./storage.ts";

function repo(id: string): Repository {
  return {
    id: `/fixture/${id}/.git`,
    name: id,
    worktrees: [{ id, path: `/fixture/${id}`, name: id, branch: "main", sessions: [] }],
  };
}
function peer(repository: Repository) {
  const id = repository.worktrees[0]!.id;
  let connected = true;
  let state: RuntimeSnapshot = {
    version: 1,
    pid: process.pid,
    instance: id,
    repositoryId: repository.id,
    mode: "offline",
    repositories: [repository],
    details: {},
    preferences: defaultPreferences(),
    closingCount: 0,
    notice: "",
  };
  const listeners = new Set<() => void>(),
    calls: string[] = [],
    saved: RuntimePreferences[] = [];
  let failSave = false;
  let saveGate: Promise<void> = Promise.resolve();
  const call = async <T>(name: string, value: T) => {
    calls.push(name);
    return ok(value);
  };
  const client: RepositoryClient = {
    get snapshot() {
      return state;
    },
    get connected() {
      return connected;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    create: (tree) => call(`create:${tree}`, `${id}-new`),
    newTab: (session) => call(`new-tab:${session}`, `${id}-sibling`),
    resume: (tree) => call(`resume:${tree}`, `${id}-resumed`),
    prompt: (session, text) => call(`prompt:${session}:${text}`, undefined),
    complete: (session) => call(`complete:${session}`, { items: [], truncated: false }),
    interrupt: (session) => call(`interrupt:${session}`, undefined),
    closeSession: (session) => call(`close:${session}`, undefined),
    listHistory: (tree) => call(`history:${tree}`, []),
    previewHistory: (tree, savedId) =>
      call(`preview:${tree}:${savedId}`, {
        id: savedId,
        worktreeId: tree,
        text: "Read-only preview",
        truncated: false,
      }),
    openEditor: (tree) => call(`editor:${tree}`, `${id}-editor`),
    createTerminal: (tree) => call(`terminal:${tree}`, `${id}-terminal`),
    attachEditor: async (pty) => {
      calls.push(`attach-editor:${pty}`);
      return err(new InputError("Fixture has no native editor."));
    },
    attachTerminal: async (pty) => {
      calls.push(`attach-terminal:${pty}`);
      return err(new InputError("Fixture has no native terminal."));
    },
    closeTerminal: (pty) => call(`close-terminal:${pty}`, undefined),
    savePreferences: async (preferences) => {
      saved.push(structuredClone(preferences));
      await saveGate;
      return failSave ? err(new StorageError("Fixture disk is full.", "ENOSPC")) : ok(undefined);
    },
    beginDetach() {
      calls.push("begin-detach");
    },
    async disconnect() {
      calls.push("disconnect");
    },
  };
  return {
    client,
    calls,
    saved,
    failSave() {
      failSave = true;
    },
    gateSaving(promise: Promise<void>) {
      saveGate = promise;
    },
    update(snapshot: RuntimeSnapshot) {
      state = snapshot;
      for (const listener of listeners) listener();
    },
    connection(value: boolean) {
      connected = value;
      for (const listener of listeners) listener();
    },
  };
}

async function isolated(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "radian-workspace-client-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("Extension UI aggregates connected repositories and routes answers only to the owning session", () =>
  isolated(async (stateRoot) => {
    // UI requests are repository-scoped even when the workspace combines multiple services.
    const a = repo("a"),
      b = repo("b"),
      pa = peer(a),
      pb = peer(b),
      answered: string[] = [];
    pa.client.answerExtensionUi = async (id) => {
      answered.push(id);
      return ok(undefined);
    };
    pb.client.answerExtensionUi = async () => {
      throw new Error("Wrong repository received an extension answer");
    };
    const workspace = expectOk(
      await WorkspaceClient.open([a, b], a.worktrees[0]!.path, { stateRoot }, async (repository) =>
        ok(repository.id === a.id ? pa.client : pb.client),
      ),
    );
    try {
      const session = expectOk(await workspace.create("a"));
      pa.update({
        ...pa.client.snapshot,
        extensionUi: [
          {
            sessionId: session,
            conversationId: "conversation",
            notifications: [],
            statuses: {},
            dialog: { id: "request", kind: "input", title: "Callback" },
          },
        ],
      });

      expect(workspace.snapshot.extensionUi?.[0]?.dialog?.id).toBe("request");
      expectOk(
        await workspace.answerExtensionUi(session, "conversation", {
          requestId: "request",
          value: "answer",
        }),
      );
      expect(
        expectError(
          await workspace.answerExtensionUi("foreign-session", "conversation", {
            requestId: "request",
            cancelled: true,
          }),
        ).code,
      ).toBe("SESSION_NOT_OPEN");
      pa.connection(false);

      expect(answered).toEqual([session]);
      expect(workspace.snapshot.extensionUi).toEqual([]);
      expect(pb.calls).toEqual([]);
    } finally {
      await workspace.disconnect();
    }
  }));

test("Resources read the shared daemon once across repositories without activation or duplicate sums", () =>
  isolated(async (stateRoot) => {
    // Multiple repository endpoints represent one Runtime process, not separate resource consumers.
    const a = repo("a"),
      b = repo("b"),
      pa = peer(a),
      pb = peer(b);
    const queried: string[] = [];
    const sample = { pid: process.pid + 1, elapsedMs: 1000, cpuMicros: 1234, rssBytes: 5678 };
    for (const [name, current] of [
      ["a", pa],
      ["b", pb],
    ] as const) {
      current.update({
        ...current.client.snapshot,
        capabilities: ["shared-daemon", "process-resources"],
      });
      current.client.resources = async () => {
        queried.push(name);
        return ok(sample);
      };
    }
    const workspace = expectOk(
      await WorkspaceClient.open(
        [a, b],
        a.worktrees[0]!.path,
        { stateRoot, offline: true },
        async (repository) => ok(repository.id === a.id ? pa.client : pb.client),
      ),
    );
    try {
      const first = expectOk(await workspace.resources());
      pa.connection(false);
      const fallback = expectOk(await workspace.resources());
      expect(expectError(await workspace.resources(AbortSignal.abort())).code).toBe("CANCELLED");
      pb.connection(false);
      const unavailable = expectError(await workspace.resources());

      // Switching channels preserves the same PID; no cold runtime or session is started for metrics.
      expect(first).toEqual(sample);
      expect(fallback).toEqual(sample);
      expect(queried).toEqual(["a", "b"]);
      expect(unavailable.code).toBe("UNSUPPORTED_CAPABILITY");
      expect([...pa.calls, ...pb.calls]).toEqual([]);
    } finally {
      await workspace.disconnect();
    }
  }));

test("Dashboards aggregate all/selected projects and distinguish partial unsupported services from cancellation", () =>
  isolated(async (stateRoot) => {
    // Repository usage can combine, but lookup failures must not become zero.
    const a = repo("a"),
      b = repo("b"),
      pa = peer(a),
      pb = peer(b),
      queried: string[] = [];
    for (const [name, client, tokens] of [
      ["a", pa.client, 100],
      ["b", pb.client, 200],
    ] as const)
      client.dashboard = async (days) => {
        queried.push(name);
        const data = emptyDashboard(days);
        data.totals.tokens = tokens;
        data.daily.at(-1)!.tokens = tokens;
        data.models = [{ name: "test/large", value: tokens }];
        return ok(data);
      };
    const workspace = expectOk(
      await WorkspaceClient.open(
        [a, b],
        a.worktrees[0]!.path,
        { stateRoot, offline: true },
        async (repository) => ok(repository.id === a.id ? pa.client : pb.client),
      ),
    );
    try {
      // Global and selected scopes aggregate identical resources by name.
      const all = expectOk(await workspace.dashboard(7)),
        selected = expectOk(await workspace.dashboard(7, a.id));
      expect(all.totals.tokens).toBe(300);
      expect(all.models).toEqual([{ name: "test/large", value: 300 }]);
      expect(selected.totals.tokens).toBe(100);
      expect(queried).toEqual(["a", "b", "a"]);
      delete pb.client.dashboard;
      const partial = expectOk(await workspace.dashboard(7));

      // Show partial failures and skip cancelled/invalid project lookups.
      expect(partial.totals.tokens).toBe(100);
      expect(partial.warnings).toEqual(["b: excluded [UNSUPPORTED_CAPABILITY]."]);
      const before = queried.length;
      expect(expectError(await workspace.dashboard(7, undefined, AbortSignal.abort())).code).toBe(
        "CANCELLED",
      );
      expect(expectError(await workspace.dashboard(7, "unknown")).code).toBe("INVALID_INPUT");
      expect(queried).toHaveLength(before);
      expect(
        [...pa.calls, ...pb.calls].some(
          (call) => call.startsWith("create:") || call.startsWith("prompt:"),
        ),
      ).toBe(false);
    } finally {
      await workspace.disconnect();
    }
  }));

test("newTab creates only in originating repositories and retains ownership of new IDs", () =>
  isolated(async (stateRoot) => {
    const a = repo("a"),
      b = repo("b"),
      pa = peer(a),
      pb = peer(b);
    const workspace = expectOk(
      await WorkspaceClient.open(
        [a, b],
        b.worktrees[0]!.path,
        { stateRoot, offline: true },
        async (repository) => ok(repository.id === a.id ? pa.client : pb.client),
      ),
    );
    try {
      const original = expectOk(await workspace.create("a"));
      const added = expectOk(await workspace.newTab(original));
      expect(added).toBe("a-sibling");
      expect(pa.calls).toContain(`new-tab:${original}`);
      expect(pb.calls).toEqual([]);
      expectOk(await workspace.closeSession(added));
      expect(pa.calls).toContain("close:a-sibling");
      expect(expectError(await workspace.newTab("missing")).code).toBe("SESSION_NOT_OPEN");
    } finally {
      await workspace.disconnect();
    }
  }));

test("History previews route only to worktree-owning runtimes and never execute when cancelled", () =>
  isolated(async (stateRoot) => {
    // A workspace combines two already-connected peers without merging their saved-session identities.
    const a = repo("a"),
      b = repo("b"),
      pa = peer(a),
      pb = peer(b);
    const workspace = expectOk(
      await WorkspaceClient.open(
        [a, b],
        b.worktrees[0]!.path,
        { stateRoot, offline: true },
        async (repository) => ok(repository.id === a.id ? pa.client : pb.client),
      ),
    );
    try {
      expect(expectOk(await workspace.previewHistory("b", "saved-b")).worktreeId).toBe("b");
      expect(pb.calls).toContain("preview:b:saved-b");
      expect(pa.calls).not.toContain("preview:b:saved-b");
      const abort = new AbortController();
      abort.abort();
      expect(expectError(await workspace.previewHistory("a", "saved-a", abort.signal)).code).toBe(
        "CANCELLED",
      );
      expect(pa.calls.some((call) => call.startsWith("preview:"))).toBe(false);
      expect(expectError(await workspace.previewHistory("unknown", "saved")).code).toBe(
        "INVALID_INPUT",
      );
      expect(
        [...pa.calls, ...pb.calls].some(
          (call) => call.startsWith("create:") || call.startsWith("prompt:"),
        ),
      ).toBe(false);
    } finally {
      await workspace.disconnect();
    }
  }));

test("All repositories display while initial selection/concurrent requests lazily start only owning runtimes", () =>
  isolated(async (stateRoot) => {
    // Discovered repositories are visible before any daemon starts.
    const a = repo("a"),
      b = repo("b"),
      pa = peer(a),
      pb = peer(b);
    const started: string[] = [];
    const ready = Promise.withResolvers<void>();
    const workspace = expectOk(
      await WorkspaceClient.open(
        [a, b],
        b.worktrees[0]!.path,
        { stateRoot, offline: true },
        async (repository, _cwd, options) => {
          if (!options.start) return ok(null);
          started.push(repository.name);
          await ready.promise;
          return ok(repository.id === a.id ? pa.client : pb.client);
        },
      ),
    );
    try {
      expect(workspace.snapshot.repositories).toEqual([a, b]);
      expect(workspace.snapshot.preferences.selection.worktreeId).toBe("b");
      expect(started).toEqual([]);

      // Same-repository selection/creation shares one startup result.
      const selected = workspace.activate("b"),
        created = workspace.create("b");
      ready.resolve();
      expectOk(await selected);
      const session = expectOk(await created);
      expectOk(await workspace.prompt(session, "read"));
      expectOk(await workspace.complete(session, { kind: "file", query: "" }));
      expectOk(await workspace.listHistory("b"));
      const editor = expectOk(await workspace.openEditor("b"));
      const terminal = expectOk(await workspace.createTerminal("b", { cols: 80, rows: 20 }));
      expectError(
        await workspace.attachEditor(
          editor,
          () => {},
          () => {},
        ),
      );
      expectError(
        await workspace.attachTerminal(
          terminal,
          () => {},
          () => {},
        ),
      );
      expectOk(await workspace.closeTerminal(terminal));
      expectOk(await workspace.closeSession(session));

      // New IDs absent from snapshots must not route to other repositories.
      expect(started).toEqual(["b"]);
      expect(pa.calls).toEqual([]);
      expect(pb.calls).toContain("prompt:b-new:read");
      expect(pb.calls).toContain("attach-editor:b-editor");
      expect(pb.calls).toContain("attach-terminal:b-terminal");
      expect(workspace.hasSnapshot("b")).toBe(true);
      expect(workspace.hasSnapshot("a")).toBe(false);
    } finally {
      ready.resolve();
      await workspace.disconnect();
    }
  }));

test("Existing snapshots and reconnections preserve other repository rows and connections", () =>
  isolated(async (stateRoot) => {
    // Two running daemons attach to existing sessions without startup.
    const a = repo("a"),
      b = repo("b"),
      pa = peer(a),
      pb = peer(b);
    const starts: boolean[] = [];
    const workspace = expectOk(
      await WorkspaceClient.open(
        [a, b],
        "/outside",
        { stateRoot },
        async (repository, _cwd, options) => {
          starts.push(options.start ?? true);
          return ok(repository.id === a.id ? pa.client : pb.client);
        },
      ),
    );
    let changes = 0;
    const unsubscribe = workspace.subscribe(() => changes++);
    try {
      const changed = {
        ...a,
        worktrees: a.worktrees.map((tree) => ({
          ...tree,
          branch: "feature/a",
          sessions: [{ id: "saved-a", name: "Saved", status: null, subagents: [] }],
        })),
      };

      pa.update({
        ...pa.client.snapshot,
        repositories: [changed],
        details: { "saved-a": { status: null, output: "A", error: null } },
      });
      pb.connection(false);
      pb.connection(true);
      expectOk(await workspace.prompt("saved-a", "status"));

      // One daemon's events need not include complete snapshots for other repositories.
      expect(workspace.snapshot.repositories).toEqual([changed, b]);
      expect(workspace.snapshot.details["saved-a"]?.output).toBe("A");
      expect(workspace.recoveryVersion).toBe(1);
      expect(changes).toBe(3);
      expect(starts).toEqual([false, false]);
      expect(pa.calls).toContain("prompt:saved-a:status");
      expect(pb.calls).toEqual([]);
    } finally {
      unsubscribe();
      await workspace.disconnect();
    }
  }));

test("Repository connection failures stay isolated and unknown targets never receive commands", () =>
  isolated(async (stateRoot) => {
    // A remains usable while B is offline.
    const a = repo("a"),
      b = repo("b"),
      pa = peer(a);
    const workspace = expectOk(
      await WorkspaceClient.open([a, b], a.worktrees[0]!.path, { stateRoot }, async (repository) =>
        repository.id === a.id
          ? ok(pa.client)
          : err(new ConnectionError("CONNECTION_FAILED", "B unavailable")),
      ),
    );
    try {
      const session = expectOk(await workspace.create("a"));
      expectOk(await workspace.prompt(session, "read"));
      const failure = expectError(await workspace.activate("b"));

      // Failure codes report without retrying against arbitrary default repositories.
      expect(failure.code).toBe("CONNECTION_FAILED");
      expect(workspace.snapshot.notice).toContain("b: B unavailable");
      expect(expectError(await workspace.create("missing")).code).toBe("INVALID_INPUT");
      expect(expectError(await workspace.prompt("missing", "read")).code).toBe("SESSION_NOT_OPEN");
      expect(pa.calls).toEqual(["create:a", "prompt:a-new:read"]);
    } finally {
      await workspace.disconnect();
    }
  }));

test("Detach closes late connections without creation commands or new snapshots", () =>
  isolated(async (stateRoot) => {
    const a = repo("a"),
      pa = peer(a),
      ready = Promise.withResolvers<void>();
    const workspace = expectOk(
      await WorkspaceClient.open(
        [a],
        "/outside",
        { stateRoot },
        async (_repository, _cwd, options) => {
          if (!options.start) return ok(null);
          await ready.promise;
          return ok(pa.client);
        },
      ),
    );
    let changes = 0;
    workspace.subscribe(() => changes++);

    // Detach the TUI while awaiting runtime connection.
    const creating = workspace.create("a");
    workspace.beginDetach();
    ready.resolve();
    const error = expectError(await creating);
    await workspace.disconnect();

    // Clean only this TUI's late connections without stopping daemons.
    expect(error.code).toBe("CANCELLED");
    expect(pa.calls).toEqual(["disconnect"]);
    expect(changes).toBe(0);
    expect(expectError(await workspace.activate("a")).code).toBe("CANCELLED");
  }));

test("Legacy migration hints survive successful preference saves without replacing services", () =>
  isolated(async (stateRoot) => {
    // Retain existing connections lacking shared-daemon capabilities.
    const a = repo("a"),
      pa = peer(a);
    const workspace = expectOk(
      await WorkspaceClient.open([a], "/outside", { stateRoot }, async () => ok(pa.client)),
    );
    try {
      // UI preference persistence implies neither daemon replacement nor migration completion.
      expectOk(await workspace.savePreferences(workspace.snapshot.preferences));

      // Ownership hints survive cleared warnings without process-control requests.
      expect(workspace.snapshot.notice).toContain("legacy repository process");
      expect(workspace.snapshot.notice).toContain("runtime stop --legacy");
      expect(pa.calls).toEqual([]);
    } finally {
      await workspace.disconnect();
    }
  }));

test("Final detach persistence splits by repository and one failure never blocks others", () =>
  isolated(async (stateRoot) => {
    const a = repo("a"),
      b = repo("b"),
      pa = peer(a),
      pb = peer(b);
    const workspace = expectOk(
      await WorkspaceClient.open([a, b], "/outside", { stateRoot }, async (repository) =>
        ok(repository.id === a.id ? pa.client : pb.client),
      ),
    );
    try {
      const aId = expectOk(await workspace.create("a")),
        bId = expectOk(await workspace.create("b"));
      const preferences = workspace.snapshot.preferences;
      preferences.selection = { worktreeId: "b", sessions: { a: aId, b: bId } };
      preferences.drafts = { [aId]: "draft A", [bId]: "draft B" };

      // Healthy final preference writes remain allowed after beginDetach.
      workspace.beginDetach();
      pb.failSave();
      const error = expectError(await workspace.savePreferences(preferences));

      expect(error.code).toBe("CLEANUP_FAILED");
      expect(pa.saved[0]?.drafts).toEqual({ [aId]: "draft A" });
      expect(pb.saved[0]?.drafts).toEqual({ [bId]: "draft B" });
      expect(pa.saved[0]?.selection.sessions).toEqual({ a: aId });
      expect(pb.saved[0]?.selection.sessions).toEqual({ b: bId });
    } finally {
      await workspace.disconnect();
    }
  }));

test("Per-repository writes serialize and never send new state before earlier completion", () =>
  isolated(async (stateRoot) => {
    const a = repo("a"),
      pa = peer(a),
      gate = Promise.withResolvers<void>();
    const workspace = expectOk(
      await WorkspaceClient.open([a], "/outside", { stateRoot }, async () => ok(pa.client)),
    );
    try {
      const id = expectOk(await workspace.create("a"));
      const first = workspace.snapshot.preferences,
        second = workspace.snapshot.preferences;
      first.drafts = { [id]: "old" };
      second.drafts = { [id]: "new" };
      pa.gateSaving(gate.promise);

      // Queue latest drafts and detach behind delayed older writes.
      const oldSave = workspace.savePreferences(first);
      await Promise.resolve();
      const newSave = workspace.savePreferences(second);
      const closing = workspace.disconnect();
      await Promise.resolve();
      expect(pa.saved).toHaveLength(1);
      gate.resolve();
      expectOk(await oldSave);
      expectOk(await newSave);
      await closing;

      // Shutdown must neither interrupt final writes nor persist out of order.
      expect(pa.saved.map((preferences) => preferences.drafts[id])).toEqual(["old", "new"]);
      expect(pa.calls.at(-1)).toBe("disconnect");
    } finally {
      gate.resolve();
      await workspace.disconnect();
    }
  }));

test("Preconnection drafts survive and interim view changes persist after delayed attachment", () =>
  isolated(async (stateRoot) => {
    const b = repo("b"),
      pb = peer(b);
    const previous = defaultPreferences();
    previous.selection = { worktreeId: "b", sessions: { b: "saved-b" } };
    previous.drafts = { "saved-b": "retained" };
    const live = {
      ...b,
      worktrees: b.worktrees.map((tree) => ({
        ...tree,
        sessions: [{ id: "saved-b", name: "Saved", status: null, subagents: [] }],
      })),
    };
    pb.update({ ...pb.client.snapshot, repositories: [live], preferences: previous });
    const paths = runtimePaths(b.id, true, stateRoot);
    await privateDirectory(paths.directory);
    expectOk(
      await new RuntimeStore(paths).save({
        version: 1,
        repositoryId: b.id,
        repositories: [b],
        records: [],
        preferences: previous,
      }),
    );
    const workspace = expectOk(
      await WorkspaceClient.open(
        [b],
        "/outside",
        { stateRoot, offline: true },
        async (_repository, _cwd, options) => (options.start ? ok(pb.client) : ok(null)),
      ),
    );
    try {
      const preferences = workspace.snapshot.preferences;
      preferences.workViews = { active: { b: "git" }, agentScroll: {} };

      // Missing initial session rows must not delete retained drafts.
      expect([...workspace.retainedSessionIds]).toEqual(["saved-b"]);
      expectOk(await workspace.savePreferences(preferences));
      expect(pb.saved).toEqual([]);
      expectOk(await workspace.activate("b"));

      // Persist preclient edits and hand retention ownership to actual session rows.
      expect(pb.saved[0]?.workViews?.active).toEqual({ b: "git" });
      expect(pb.saved[0]?.drafts).toEqual({ "saved-b": "retained" });
      expect([...workspace.retainedSessionIds]).toEqual([]);
    } finally {
      await workspace.disconnect();
    }
  }));

test("Initialization bugs still clean every concurrently arriving repository connection", () =>
  isolated(async (stateRoot) => {
    const a = repo("a"),
      b = repo("b"),
      pb = peer(b),
      bug = new TypeError("Fixture programming defect");
    const entered = Promise.withResolvers<void>(),
      gate = Promise.withResolvers<void>();

    // Interleave A's unexpected exception with B's delayed connection.
    const opening = WorkspaceClient.open([a, b], "/outside", { stateRoot }, async (repository) => {
      if (repository.id === a.id) throw bug;
      entered.resolve();
      await gate.promise;
      return ok(pb.client);
    });
    const failed = opening.then(
      () => undefined,
      (error: unknown) => error,
    );
    await entered.promise;
    gate.resolve();

    // Preserve original bugs while closing successful peers without leaks.
    expect(await failed).toBe(bug);
    expect(pb.calls).toEqual(["begin-detach", "disconnect"]);
  }));

test("Postconnection preference failures show warnings instead of connection rejection", () =>
  isolated(async (stateRoot) => {
    const b = repo("b"),
      pb = peer(b);
    pb.failSave();
    const workspace = expectOk(
      await WorkspaceClient.open(
        [b],
        "/outside",
        { stateRoot },
        async (_repository, _cwd, options) => (options.start ? ok(pb.client) : ok(null)),
      ),
    );
    try {
      // Connection succeeds before only its preference write fails.
      expectOk(await workspace.activate("b"));
      const created = expectOk(await workspace.create("b"));

      // Accepted attachment/creation must not report cancellation or restart.
      expect(created).toBe("b-new");
      expect(workspace.snapshot.notice).toContain(
        "Runtime connected; UI preference persistence failed",
      );
      expect(pb.calls).toEqual(["create:b"]);
    } finally {
      await workspace.disconnect();
    }
  }));
