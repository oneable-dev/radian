import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectOk } from "../testing/results.ts";
import { fetchSnapshot, RuntimeClient } from "./client.ts";
import { connectRuntime } from "./lifecycle.ts";
import { daemonPaths, pidAlive, runtimePaths } from "./storage.ts";

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error("Fast restoration observation timed out.");
    }

    await Bun.sleep(20);
  }
}

test("bun run restart preserves explicit Fast choices without replaying requests or enabling new conversations", async () => {
  // Only this fixture's offline daemon, credentials and session storage are used.
  const fixture = await createWorktreeFixture();
  const stateRoot = join(fixture.directory, "state");
  const options = { offline: true, stateRoot };
  const paths = runtimePaths(fixture.repository.id, true, stateRoot);
  const extensions = join(paths.directory, "offline-agent", "extensions");
  const clients: RuntimeClient[] = [];
  try {
    await mkdir(extensions, { recursive: true });
    await writeFile(
      join(extensions, "fast-fixture.ts"),
      `export default function (pi) {
        pi.registerProvider("fast-fixture", {
          api: "openai-codex-responses",
          baseUrl: "http://127.0.0.1:1",
          apiKey: "offline",
          models: [{
            id: "fixture", name: "Fast fixture", reasoning: true, input: ["text"],
            contextWindow: 200000, maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          }]
        });
        pi.on("session_start", async (_event, ctx) => {
          if (!(await pi.setModel(ctx.modelRegistry.find("fast-fixture", "fixture")))) {
            throw new Error("Fixture model selection failed");
          }
        });
      }`,
    );
    const client = expectOk(await connectRuntime(fixture.repository, fixture.main, options));
    if (!client) {
      throw new Error("Missing fixture runtime");
    }
    clients.push(client);
    const tree = fixture.repository.worktrees.find((tree) => tree.path === fixture.main)!;
    const id = expectOk(await client.create(tree.id));
    expectOk(await client.prompt(id, "/fast on"));
    expectOk(await client.prompt(id, "Persist one offline request."));
    await until(() => client.snapshot.details[id]?.status === "complete");
    const before = client.snapshot;
    expect(before.details[id]?.telemetry?.fast).toBe(true);
    const conversation = before.details[id]!.conversationId;
    const output = before.details[id]!.output;
    await client.disconnect();

    // Exercise the actual package script with an isolated mode and state root.
    const child = Bun.spawn(
      [Bun.which("bun")!, "run", "restart", "--test-runtime", "--state-dir", stateRoot],
      { cwd: join(import.meta.dir, "..", ".."), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toMatchObject({ code: 0 });
    expect(stdout).toContain("Shared daemon restarted");
    const restored = expectOk(await connectRuntime(fixture.repository, fixture.main, options));
    if (!restored) {
      throw new Error("Missing restored fixture runtime");
    }
    clients.push(restored);
    await until(() => restored.snapshot.details[id]?.telemetry?.fast === true);
    const fresh = expectOk(await restored.create(tree.id));
    await until(() => restored.snapshot.details[fresh]?.telemetry?.fast === false);

    // A new process restores the same choice and history, not a new request or a global default.
    expect(restored.snapshot.pid).not.toBe(before.pid);
    expect(pidAlive(before.pid)).toBe(false);
    expect(restored.snapshot.details[id]?.conversationId).toBe(conversation);
    expect(restored.snapshot.details[id]?.output).toBe(output);
    expect(restored.snapshot.details[id]?.status).toBe("complete");
    expect(restored.snapshot.details[fresh]?.sections).toEqual([]);
    expect(restored.snapshot.details[fresh]?.telemetry?.fast).toBe(false);
  } finally {
    const paths = daemonPaths(true, stateRoot);
    const snapshot = expectOk(await fetchSnapshot(paths));
    if (snapshot) {
      const client = new RuntimeClient(paths, snapshot);
      try {
        expectOk(await client.stopRuntime());
        await until(() => !pidAlive(snapshot.pid));
      } finally {
        await client.disconnect();
      }
    }

    await Promise.all(clients.map((client) => client.disconnect()));
    await fixture.cleanup();
  }
}, 20000);
