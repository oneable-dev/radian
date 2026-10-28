import { expect, test } from "bun:test";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectOk } from "../testing/results.ts";
import { PreloadedData } from "../app/preload.ts";
import { WorkspaceClient } from "./workspace-client.ts";
import { connectRuntime } from "./client.ts";
import { daemonPaths, pidAlive, privateDirectory, runtimePaths } from "./storage.ts";

function until(
  subscribe: (listener: () => void) => () => void,
  predicate: () => boolean,
): Promise<void> {
  if (predicate()) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Background history update was not observed"));
    }, 8000);
    const unsubscribe = subscribe(() => {
      if (predicate()) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}

test("Real history and account events refresh preloaded data without opening popups", async () => {
  // All files and daemon state belong to an isolated offline fixture.
  const fixture = await createWorktreeFixture();
  const options = {
    offline: true,
    stateRoot: join(fixture.directory, "preload-state"),
    entry: join(import.meta.dir, "..", "index.ts"),
  };
  const accountDirectory = daemonPaths(true, options.stateRoot).directory;

  await privateDirectory(accountDirectory);
  await writeFile(
    join(accountDirectory, "accounts.json"),
    JSON.stringify({
      version: 1,
      revision: 1,
      selections: {},
      accounts: [
        {
          id: "fixture-account",
          provider: "openai",
          label: "Original label",
          credential: { type: "api_key", key: "private-preload-fixture" },
        },
      ],
    }),
    { mode: 0o600 },
  );

  const workspace = expectOk(
    await WorkspaceClient.open([fixture.repository], fixture.main, options),
  );
  const tree = fixture.repository.worktrees.find((tree) => tree.path === fixture.main)!;
  let data: PreloadedData | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    expectOk(await workspace.activate(tree.id));

    const errors: unknown[] = [];
    data = new PreloadedData(workspace, (error) => errors.push(error));

    const preload = () => {
      data!.preloadAccounts();
      data!.preloadHistory();
    };
    unsubscribe = workspace.subscribe(preload);
    preload();
    await until(
      (listener) => data!.subscribe(listener),
      () => !!data!.cachedHistory(tree.id),
    );
    expect(expectOk(data.cachedHistory(tree.id)!)).toEqual([]);

    const revision = workspace.dataIdentity(tree.id, "history");
    const id = crypto.randomUUID();
    const path = join(
      runtimePaths(fixture.repository.id, true, options.stateRoot).directory,
      "offline-agent",
      "sessions",
      `${id}.jsonl`,
    );
    const header = {
      type: "session",
      version: 3,
      id,
      cwd: tree.path,
      timestamp: new Date().toISOString(),
    };
    const content = (text: string) =>
      JSON.stringify(header) +
      "\n" +
      JSON.stringify({
        type: "message",
        id: "question",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
      }) +
      "\n";

    // An external file appears while History is never mounted.
    await writeFile(path, content("Initial external question"));
    await until(
      (listener) => data!.subscribe(listener),
      () => {
        const result = data!.cachedHistory(tree.id);

        return !!result?.ok && result.value.some((item) => item.id === id);
      },
    );
    await until(
      (listener) => data!.previews.subscribe(listener),
      () => data!.previews.read(tree.id, id)?.kind === "ready",
    );
    expect(workspace.dataIdentity(tree.id, "history")).not.toBe(revision);

    const first = data.previews.read(tree.id, id);
    expect(first?.kind === "ready" && JSON.stringify(first.value)).toContain(
      "Initial external question",
    );

    // Editing the same file invalidates its body rather than requiring a popup refresh.
    await writeFile(path, content("Updated external question with more content"));
    await until(
      (listener) => data!.previews.subscribe(listener),
      () => {
        const state = data!.previews.read(tree.id, id);

        return (
          state?.kind === "ready" &&
          JSON.stringify(state.value).includes("Updated external question")
        );
      },
    );
    await unlink(path);
    await until(
      (listener) => data!.subscribe(listener),
      () => {
        const result = data!.cachedHistory(tree.id);

        return !!result?.ok && !result.value.some((item) => item.id === id);
      },
    );
    expect(data.previews.read(tree.id, id)).toBeUndefined();

    // Account changes from another client publish revisions without opening Accounts.
    await until(
      (listener) => data!.subscribe(listener),
      () => !!data!.cachedAccounts(tree.id)?.ok,
    );

    const catalog = expectOk(data.cachedAccounts(tree.id)!);
    expectOk(
      await workspace.accounts({
        type: "rename",
        worktreeId: tree.id,
        provider: "openai",
        accountId: "fixture-account",
        label: "Updated label",
        revision: catalog.revision,
      }),
    );
    await until(
      (listener) => data!.subscribe(listener),
      () => {
        const next = data!.cachedAccounts(tree.id);

        return !!next?.ok && next.value.accounts[0]?.label === "Updated label";
      },
    );
    expect(JSON.stringify(data.cachedAccounts(tree.id))).not.toContain("private-preload-fixture");
    expect(errors).toEqual([]);
  } finally {
    unsubscribe?.();
    data?.dispose();
    await workspace.disconnect();

    const client = expectOk(
      await connectRuntime(fixture.repository, fixture.main, { ...options, start: false }),
    );
    if (client) {
      const pid = client.snapshot.pid;
      expectOk(await client.stopRuntime());
      await client.disconnect();

      const deadline = Date.now() + 8000;
      while (pidAlive(pid) && Date.now() < deadline) {
        await Bun.sleep(20);
      }

      expect(pidAlive(pid)).toBe(false);
    }

    await fixture.cleanup();
  }
}, 25000);
