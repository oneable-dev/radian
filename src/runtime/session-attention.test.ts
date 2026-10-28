import { expect, test } from "bun:test";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { connectRuntime, fetchSnapshot, type RuntimeClient } from "./client.ts";
import { pidAlive, RuntimeStore } from "./storage.ts";
import { emptyPreferences, parseCommand, parseSnapshot, type RuntimeSnapshot } from "./protocol.ts";
import { expectError, expectOk } from "../testing/results.ts";

function observed(
  client: RuntimeClient,
  predicate: (snapshot: RuntimeSnapshot) => boolean,
): Promise<void> {
  if (predicate(client.snapshot)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Attention snapshot timed out"));
    }, 10000);
    const unsubscribe = client.subscribe(() => {
      if (predicate(client.snapshot)) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}

async function fixture() {
  const app = await createWorktreeFixture();
  const clients: RuntimeClient[] = [];
  const options = {
    offline: true,
    stateRoot: join(app.directory, "state"),
    entry: join(import.meta.dir, "..", "index.ts"),
  };
  const connect = async () => {
    const client = expectOk(await connectRuntime(app.repository, app.main, options));
    if (!client) {
      throw new Error("Missing test runtime");
    }

    clients.push(client);

    return client;
  };
  const stopped = async (client: RuntimeClient) => {
    const deadline = Date.now() + 10000;
    while (expectOk(await fetchSnapshot(client.paths)) || pidAlive(client.snapshot.pid)) {
      if (Date.now() > deadline) {
        throw new Error("Test runtime did not stop");
      }

      await Bun.sleep(20);
    }
  };

  return {
    ...app,
    connect,
    stopped,
    async cleanup() {
      const running = expectOk(
        await connectRuntime(app.repository, app.main, { ...options, start: false }),
      );
      if (running) {
        expectOk(await running.stopRuntime());
        await running.disconnect();
        await stopped(running);
      }

      await Promise.all(clients.map((client) => client.disconnect()));
      await app.cleanup();
    },
  };
}

test("Real runtimes persist completions without TUI and all connections acknowledge identical results", async () => {
  // Use real Git, SDK, and IPC with isolated offline model fixtures.
  const app = await fixture();
  try {
    const first = await app.connect();
    const tree = app.repository.worktrees.find((tree) => tree.path === app.main)!;
    const id = expectOk(await first.create(tree.id));

    expect(first.snapshot.capabilities).toContain("session-attention");
    expectOk(await first.prompt(id, "read"));
    await observed(first, (state) => !!state.details[id]?.attention);

    const attention = first.snapshot.details[id]!.attention!;
    const conversation = first.snapshot.details[id]!.conversationId!;
    const second = await app.connect();

    expect(second.snapshot.details[id]?.attention?.id).toBe(attention.id);

    // Stale result/conversation acknowledgements must not erase latest results.
    expect(expectError(await second.acknowledge(id, "outgoing", attention.id)).code).toBe(
      "SESSION_CONFLICT",
    );
    expectOk(await second.acknowledge(id, conversation, "outdated-result"));
    expect(second.snapshot.details[id]?.attention?.id).toBe(attention.id);
    expectOk(await second.acknowledge(id, conversation, attention.id));
    await observed(first, (state) => !state.details[id]?.attention);
    await observed(second, (state) => !state.details[id]?.attention);

    const saved = expectOk(await new RuntimeStore(first.paths).load(app.repository.id));
    if (!saved) {
      throw new Error("Missing runtime manifest");
    }

    expect(saved.records.find((record) => record.id === id)?.state.attention).toBeUndefined();
    expect(first.snapshot.details[id]?.result?.id).toBe(attention.id);
    expect(first.snapshot.details[id]?.status).toBe("complete");
  } finally {
    await app.cleanup();
  }
}, 25000);

test("Service restart restores unread state and user cancellation never overwrites earlier notifications", async () => {
  // Acknowledgement does not depend on temporary TUI caches or history replay.
  const app = await fixture();
  try {
    const first = await app.connect();
    const tree = app.repository.worktrees.find((tree) => tree.path === app.main)!;
    const id = expectOk(await first.create(tree.id));

    expectOk(await first.prompt(id, "read"));
    await observed(first, (state) => !!state.details[id]?.attention);

    const resultId = first.snapshot.details[id]!.attention!.id;
    expectOk(await first.stopRuntime());
    await first.disconnect();
    await app.stopped(first);

    const restored = await app.connect();
    expect(restored.snapshot.details[id]?.attention?.id).toBe(resultId);
    expectOk(await restored.prompt(id, "slow"));
    await observed(restored, (state) => state.details[id]?.status === "working");
    expectOk(await restored.interrupt(id));
    await observed(restored, (state) => state.details[id]?.result?.outcome === "cancelled");

    expect(restored.snapshot.details[id]?.result?.cancellation).toBe("user");
    expect(restored.snapshot.details[id]?.attention?.id).toBe(resultId);
    expectOk(
      await restored.acknowledge(id, restored.snapshot.details[id]!.conversationId!, resultId),
    );
    await observed(restored, (state) => !state.details[id]?.attention);
    expectOk(await restored.prompt(id, "/clear"));
    await observed(
      restored,
      (state) => !state.details[id]?.result && !state.details[id]?.attention,
    );
  } finally {
    await app.cleanup();
  }
}, 25000);

test("Attention metadata remains snapshot-compatible and rejects invalid results/acknowledgements at boundaries", () => {
  // Legacy services without fields connect without inferred acknowledgement state.
  const legacy = {
    version: 1,
    pid: 1,
    instance: "legacy",
    mode: "offline",
    repositoryId: "repo",
    repositories: [],
    details: { tab: { status: null, output: "", error: null } },
    closingCount: 0,
    preferences: emptyPreferences,
    notice: "",
  };

  expect(expectOk(parseSnapshot(legacy)).details.tab?.attention).toBeUndefined();
  expect(
    expectError(
      parseSnapshot({
        ...legacy,
        details: {
          tab: {
            ...legacy.details.tab,
            attention: { id: "result", outcome: "idle", completedAt: 1 },
          },
        },
      }),
    ).code,
  ).toBe("PROTOCOL_ERROR");
  expect(
    expectError(
      parseCommand(
        JSON.stringify({ type: "acknowledge", sessionId: "tab", conversationId: "conversation" }),
      ),
    ).code,
  ).toBe("INVALID_INPUT");
});
