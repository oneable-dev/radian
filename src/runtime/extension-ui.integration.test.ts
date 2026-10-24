import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { connectRuntime, type RuntimeClient } from "./client.ts";
import { daemonPaths, pidAlive, RuntimeStore, runtimePaths } from "./storage.ts";

function observed(client: RuntimeClient, predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("Runtime UI condition timed out")); }, 5000);
    const unsubscribe = client.subscribe(() => { if (predicate()) { clearTimeout(timer); unsubscribe(); resolve(); } });
  });
}

test("Unix IPC delivers extension UI independently from command admission and never persists callback answers", async () => {
  // All processes, extension files and authentication-like data belong to this isolated offline runtime.
  const fixture = await createWorktreeFixture(), stateRoot = join(fixture.directory, "state");
  const paths = runtimePaths(fixture.repository.id, true, stateRoot), extensions = join(paths.directory, "offline-agent", "extensions");
  await mkdir(extensions, { recursive: true });
  await writeFile(join(extensions, "ui.ts"), `export default function(pi) {
    pi.registerCommand("ui-fixture", { handler: async (_args, ctx) => {
      const answer = await ctx.ui.input("Callback https://example.test/private-auth-link");
      if (answer !== undefined) ctx.ui.notify(answer === "private-ipc-callback" ? "Callback received" : "Wrong callback");
    } });
  }`);
  const options = { offline: true, stateRoot, entry: join(import.meta.dir, "..", "index.ts") };
  const client = expectOk(await connectRuntime(fixture.repository, fixture.main, options));
  if (!client) throw new Error("Missing fixture runtime");
  let reconnect: RuntimeClient | null = null;
  try {
    const id = expectOk(await client.create(fixture.repository.worktrees[0]!.id));
    expectOk(await client.prompt(id, "read")); await observed(client, () => !!client.snapshot.details[id]?.result);
    const conversation = client.snapshot.details[id]!.conversationId!;
    const current = () => client.snapshot.extensionUi?.find(state => state.sessionId === id);
    const before = client.snapshot.details[id]?.sections;

    // Admission must complete while the handler is still waiting for its UI response.
    expectOk(await client.prompt(id, "/ui-fixture"));
    await observed(client, () => !!current()?.dialog);
    const requestId = current()!.dialog!.id;
    expect(client.snapshot.capabilities).toContain("extension-ui");
    expect(expectError(await client.answerExtensionUi(id, "old-conversation", { requestId, value: "private-ipc-callback" })).code).toBe("PROTOCOL_ERROR");
    for (const instance of [undefined, "old-instance"]) {
      const response = await fetch("http://localhost/command", { unix: paths.socket, method: "POST",
        headers: { "Content-Type": "application/json", ...(instance ? { "X-Radian-Instance": instance } : {}) },
        body: JSON.stringify({ type: "extension-ui-response", sessionId: id, conversationId: conversation, response: { requestId, value: "private-ipc-callback" } }) });
      expect(response.status).toBe(422);
    }
    expectOk(await client.answerExtensionUi(id, conversation, { requestId, value: "private-ipc-callback" }));
    await observed(client, () => current()?.notifications.some(notification => notification.message === "Callback received") ?? false);
    expect(expectError(await client.answerExtensionUi(id, conversation, { requestId, value: "private-ipc-callback" })).code).toBe("SESSION_CONFLICT");

    // Force a checkpoint and inspect both storage layers and the actual daemon log.
    expectOk(await client.savePreferences(client.snapshot.preferences));
    const manifest = expectOk(await new RuntimeStore(paths).load(fixture.repository.id))!;
    const record = manifest.records.find(record => record.id === id)!;
    const sdk = await readFile(record.sessionFile!, "utf8"), log = await readFile(daemonPaths(true, stateRoot).log, "utf8");
    for (const content of [JSON.stringify(manifest), sdk, log]) {
      expect(content).not.toContain("private-ipc-callback"); expect(content).not.toContain("private-auth-link");
    }
    expect(client.snapshot.details[id]?.sections).toEqual(before);

    // Losing the last client cancels the pending request; reattachment must not resurrect it.
    expectOk(await client.prompt(id, "/ui-fixture")); await observed(client, () => !!current()?.dialog);
    await client.disconnect();
    reconnect = expectOk(await connectRuntime(fixture.repository, fixture.main, options));
    if (!reconnect) throw new Error("Missing reconnected fixture runtime");
    await observed(reconnect, () => !reconnect!.snapshot.extensionUi?.some(state => state.dialog));
    expect(reconnect.snapshot.details[id]?.conversationId).toBe(conversation);
  } finally {
    const owner = reconnect ?? client, pid = owner.snapshot.pid;
    if (owner.connected) expectOk(await owner.stopRuntime());
    await owner.disconnect(); await client.disconnect();
    const deadline = Date.now() + 8000;
    while (pidAlive(pid) && Date.now() < deadline) await Bun.sleep(20);
    expect(pidAlive(pid)).toBe(false); await fixture.cleanup();
  }
}, 20000);
