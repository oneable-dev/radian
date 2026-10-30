import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_SCOPE_ID } from "../agents/session-scope.ts";
import { expectOk } from "../testing/results.ts";
import { RuntimeClient, fetchSnapshot } from "./client.ts";
import { connectChatRuntime, connectRuntime } from "./lifecycle.ts";
import { daemonPaths, pidAlive } from "./storage.ts";
import { WorkspaceClient } from "./workspace-client.ts";

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("CHAT state did not arrive in time.");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

test("No-repository clients share CHAT execution across detach and reconnect without prompt replay", async () => {
  // A fresh state root contains no repository registration and no fabricated worktree.
  const directory = await mkdtemp(join(tmpdir(), "radian-chat-integration-"));
  const options = { offline: true, stateRoot: directory };
  let first: WorkspaceClient | undefined;
  let second: WorkspaceClient | undefined;
  try {
    first = expectOk(await WorkspaceClient.open([], homedir(), options, connectRuntime));
    second = expectOk(await WorkspaceClient.open([], homedir(), options, connectRuntime));
    const id = expectOk(await first.create(CHAT_SCOPE_ID));
    expect(first.snapshot.repositories).toEqual([]);
    expect(first.snapshot.chat?.sessions.map((session) => session.id)).toEqual([id]);
    await until(
      () => second!.snapshot.chat?.sessions.some((session) => session.id === id) === true,
    );
    expectOk(await second.prompt(id, "hello"));
    await first.disconnect();
    first = undefined;
    await until(() => second!.snapshot.chat?.details[id]?.status === "complete");
    expect(second.snapshot.chat?.details[id]?.output).toContain("Offline SDK fixture");
    expect(second.snapshot.chat?.sessions).toHaveLength(1);
    const history = expectOk(await second.listChatHistory());
    expect(history.find((item) => item.openSessionId === id)).toBeTruthy();
    const configMismatch = await connectChatRuntime({
      ...options,
      config: join(directory, "other.json"),
    });
    expect(configMismatch.ok).toBe(false);
    if (!configMismatch.ok) expect(configMismatch.error.code).toBe("INVALID_INPUT");
    expect(expectOk(await fetchSnapshot(daemonPaths(true, directory)))!.repositories).toEqual([]);
  } finally {
    await first?.disconnect();
    await second?.disconnect();
    const paths = daemonPaths(true, directory);
    const snapshot = expectOk(await fetchSnapshot(paths));
    if (snapshot) {
      const control = new RuntimeClient(paths, snapshot);
      expectOk(await control.stopRuntime());
      await until(() => !pidAlive(snapshot.pid));
      await control.disconnect();
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
