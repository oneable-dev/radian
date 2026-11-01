import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import * as adapter from "../agents/pi-session-adapter.ts";
import type {
  SessionContext,
  SessionExecutor,
  SessionFactory,
  SessionRecord,
} from "../agents/session-registry.ts";
import { ok } from "../result.ts";
import { expectOk } from "../testing/results.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { emptyPreferences } from "./protocol.ts";
import { RepositoryHost } from "./repository-host.ts";
import { WorkspaceRuntime } from "./service.ts";
import { privateDirectory, runtimePaths, RuntimeStore } from "./storage.ts";

type Held = {
  context: SessionContext;
  release: () => void;
  fail: (error: Error) => void;
  closed: () => number;
};

// Replaces only the SDK boundary; registry, runtime, store and host stay real.
async function setup(records: (trees: { main: string; feature: string }) => SessionRecord[]) {
  const fixture = await createWorktreeFixture();
  const stateRoot = join(fixture.directory, "state");
  const paths = runtimePaths(fixture.repository.id, true, stateRoot);
  const trees = {
    main: fixture.repository.worktrees.find((tree) => tree.path === fixture.main)!.id,
    feature: fixture.repository.worktrees.find((tree) => tree.path === fixture.feature)!.id,
  };
  await privateDirectory(paths.directory);
  expectOk(
    await new RuntimeStore(paths).save({
      version: 1,
      repositoryId: fixture.repository.id,
      repositories: [fixture.repository],
      records: records(trees),
      preferences: structuredClone(emptyPreferences),
    }),
  );

  const started: SessionContext[] = [];
  const held: Held[] = [];
  let holdFeature = true;
  let heldStarted: () => void = () => {};
  const firstHeld = new Promise<void>((resolve) => (heldStarted = resolve));
  const executor = (closes: { count: number }): SessionExecutor => ({
    savedSessionId: crypto.randomUUID(),
    sessionFile: undefined,
    state: { status: "complete", output: "", error: null },
    subscribe: () => () => {},
    prompt: async () => ok(undefined),
    close: async () => {
      closes.count++;
      return ok(undefined);
    },
  });
  const factory: SessionFactory = (context) => {
    started.push(context);
    const closes = { count: 0 };
    if (!holdFeature || context.worktreeId !== trees.feature) {
      return Promise.resolve(executor(closes));
    }

    holdFeature = false;
    return new Promise((resolve, reject) => {
      held.push({
        context,
        release: () => resolve(executor(closes)),
        fail: reject,
        closed: () => closes.count,
      });
      heldStarted();
    });
  };
  const sdk = spyOn(adapter, "piSessionFactory").mockReturnValue(factory);
  const host = expectOk(
    await RepositoryHost.open(
      fixture.repository,
      paths,
      true,
      stateRoot,
      undefined,
      () => {},
      async () => ok(undefined),
    ),
  );

  return {
    host,
    trees,
    started,
    held,
    firstHeld,
    async cleanup() {
      try {
        expectOk(await host.stop());
      } finally {
        sdk.mockRestore();
        await fixture.cleanup();
      }
    },
  };
}

function openRecord(id: string, worktreeId: string): SessionRecord {
  return {
    id,
    name: `Saved ${id}`,
    worktreeId,
    lifecycle: "open",
    managed: true,
    closedAt: null,
    updatedAt: 1,
    state: { status: "complete", output: "", error: null },
    subagents: [],
  };
}

test("A deletion fenced while the first saved SDK is pending never starts later restores of that scope", async () => {
  const app = await setup((trees) => [
    openRecord("deleted-first", trees.feature),
    openRecord("deleted-second", trees.feature),
    openRecord("sibling", trees.main),
  ]);
  try {
    const activation = app.host.activate();
    await app.firstHeld;
    const scope = new Set([app.trees.feature]);

    // Native deletion confirms while the runtime still awaits its first restore factory.
    const stopping = app.host.stopScope("worktrees", scope);
    app.held[0]!.release();

    expectOk(await activation);
    const candidates = expectOk(await stopping);
    expect(app.started.map((context) => context.worktreeId)).toEqual([
      app.trees.feature,
      app.trees.main,
    ]);
    expect(app.held[0]!.closed()).toBe(1);
    // Executor and failed-restore inventories may both name a session; the purge reads headers.
    expect([...new Set(candidates.map((candidate) => candidate.sessionId))].toSorted()).toEqual([
      "deleted-first",
      "deleted-second",
    ]);
    const worktrees = app.host.snapshot.repositories.flatMap((repo) => repo.worktrees);
    expect(worktrees.map((tree) => tree.id)).toEqual([app.trees.main]);
    expect(worktrees[0]!.sessions.map((session) => session.id)).toEqual(["sibling"]);
  } finally {
    await app.cleanup();
  }
});

test("A failed runtime initialization is stopped once and no longer receives scope fences", async () => {
  const app = await setup((trees) => [openRecord("failing", trees.feature)]);
  const stop = spyOn(WorkspaceRuntime.prototype, "stop");
  const fence = spyOn(WorkspaceRuntime.prototype, "fenceScope");
  try {
    const activation = app.host.activate();
    await app.firstHeld;

    // An unexpected SDK defect aborts initialization after the runtime was prepared.
    app.held[0]!.fail(new Error("Fixture SDK defect"));
    await expect(activation).rejects.toThrow("Fixture SDK defect");

    expect(app.host.active).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
    const fenced = fence.mock.calls.length;
    app.host.fenceScope("worktrees", new Set([app.trees.feature]));
    expect(fence).toHaveBeenCalledTimes(fenced);
  } finally {
    await app.cleanup();
    // Host shutdown must not stop the runtime its opener already stopped.
    expect(stop).toHaveBeenCalledTimes(1);
    stop.mockRestore();
    fence.mockRestore();
  }
});

test("An undeleted activation restores every saved record and becomes active only when ready", async () => {
  const app = await setup((trees) => [
    openRecord("feature-tab", trees.feature),
    openRecord("main-tab", trees.main),
  ]);
  try {
    const activation = app.host.activate();
    await app.firstHeld;

    // The preparing runtime is reachable only for fences, never as the active host runtime.
    expect(app.host.active).toBe(false);
    app.held[0]!.release();
    expectOk(await activation);

    expect(app.host.active).toBe(true);
    expect(app.started.map((context) => context.worktreeId)).toEqual([
      app.trees.feature,
      app.trees.main,
    ]);
    expect(app.held[0]!.closed()).toBe(0);
    const sessions = app.host.snapshot.repositories
      .flatMap((repo) => repo.worktrees)
      .flatMap((tree) => tree.sessions.map((session) => session.id));
    expect(sessions.toSorted()).toEqual(["feature-tab", "main-tab"]);
  } finally {
    await app.cleanup();
  }
});
