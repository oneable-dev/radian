import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { StorageError } from "../errors.ts";
import { err, ok } from "../result.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { emptyPreferences } from "./protocol.ts";
import { RepositoryHost } from "./repository-host.ts";
import * as service from "./service.ts";
import { runtimePaths } from "./storage.ts";

test("A deleted host retains failed writers until a later shutdown retry confirms termination", async () => {
  const fixture = await createWorktreeFixture();
  let host: RepositoryHost | undefined;
  let attempts = 0;
  // The SDK boundary fails once without releasing ownership, then confirms a successful retry.
  const runtime = {
    retainsResources: true,
    repositoryMissing: false,
    onStop: () => {},
    setExcluded: () => {},
    setObserved: () => {},
    subscribe: () => () => {},
    fenceScope: () => {},
    async destroy() {
      if (++attempts === 1) return err(new StorageError("Fixture writer is still stopping."));
      runtime.retainsResources = false;
      return ok([]);
    },
    snapshot: {
      version: 1,
      pid: process.pid,
      instance: "fixture",
      repositoryId: fixture.repository.id,
      repositories: [fixture.repository],
      details: {},
      closingCount: 0,
      preferences: structuredClone(emptyPreferences),
      notice: "",
      editors: [],
      terminals: [],
    },
  };
  const open = spyOn(service, "openRepositoryRuntime").mockResolvedValue(
    ok(runtime as unknown as service.WorkspaceRuntime),
  );
  try {
    const stateRoot = join(fixture.directory, "state");
    host = expectOk(
      await RepositoryHost.open(
        fixture.repository,
        runtimePaths(fixture.repository.id, true, stateRoot),
        true,
        stateRoot,
        undefined,
        () => {},
        async () => ok(undefined),
      ),
    );
    expectOk(await host.activate());
    const scope = new Set(fixture.repository.worktrees.map((tree) => tree.id));

    expect(expectError(await host.stopScope("repository", scope)).code).toBe("STORAGE_FAILED");
    expect(host.active).toBe(true);
    expect(host.retainsResources).toBe(true);
    expectOk(await host.stopScope("repository", scope));

    expect(attempts).toBe(2);
    expect(host.active).toBe(false);
    expect(host.retainsResources).toBe(false);
  } finally {
    open.mockRestore();
    if (host) expectOk(await host.stop());
    await fixture.cleanup();
  }
});
