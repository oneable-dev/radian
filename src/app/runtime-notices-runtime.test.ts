import { expect, test } from "bun:test";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectOk } from "../testing/results.ts";
import { connectRuntime, fetchSnapshot, type RuntimeClient } from "../runtime/client.ts";
import { pidAlive } from "../runtime/storage.ts";

test("Closing a session through the real service never emits shutdown progress notices", async () => {
  // Observe actual bootstrap delivery through a PTY, using scripted responses instead of a model provider.
  const fixture = await createWorktreeFixture(), entry = join(import.meta.dir, "..", "index.ts");
  const stateRoot = join(fixture.directory, "state");
  let client: RuntimeClient | undefined, child: Bun.Subprocess | undefined, raw = "";
  try {
    client = expectOk(await connectRuntime(fixture.repository, fixture.main, { offline: true, stateRoot, entry })) ?? undefined;
    if (!client) throw new Error("Missing offline runtime.");
    const tree = fixture.repository.worktrees.find(tree => tree.path === fixture.main)!;
    const id = expectOk(await client.create(tree.id));
    const ready = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>(), messagesShown = Promise.withResolvers<void>(), decoder = new TextDecoder();
    const observed = Promise.all([ready.promise, closed.promise, messagesShown.promise]);
    const deadline = setTimeout(() => {
      const error = new Error(`Timed out waiting for CLI session closure. Terminal tail:\n${Bun.stripANSI(raw).slice(-2000)}`);
      ready.reject(error); closed.reject(error); messagesShown.reject(error); child?.kill("SIGTERM");
    }, 10000);
    try {
      child = Bun.spawn([process.execPath, entry, "--test-runtime", "--state-dir", stateRoot], {
        cwd: fixture.main, env: { ...process.env, TERM: "xterm-256color", XDG_CONFIG_HOME: join(fixture.directory, "config") },
        terminal: { cols: 120, rows: 24, name: "xterm-256color", data: (_terminal, bytes) => {
          raw += decoder.decode(bytes, { stream: true });
          const screen = Bun.stripANSI(raw);
          if (screen.includes("Ask to do anything") && screen.includes("context")) ready.resolve();
          if (screen.includes("No AI sessions")) closed.resolve();
          if (screen.includes("Messages") && screen.includes("No messages yet")) messagesShown.resolve();
        } },
      });

      // Closing the last tab must update the UI without promoting transient shutdown counts to notices.
      await ready.promise;
      expectOk(await client.closeSession(id));
      await closed.promise;
      expect(Bun.stripANSI(raw)).not.toContain("OFFLINE SDK");
      child.terminal?.write("\x00!");
      await observed;
      child.terminal?.write("\x1b\x00d");
      expect(await child.exited).toBe(0);

      // Shutdown progress and offline startup Info appear in neither toasts nor retained Messages.
      const screen = Bun.stripANSI(raw);
      expect(screen).not.toMatch(/Closing \d/u);
      expect(screen).not.toContain("OFFLINE SDK");
      expect(screen).toContain("No messages yet");
      expect(screen).toContain("Messages");
    } finally {
      clearTimeout(deadline);
      ready.resolve(); closed.resolve(); messagesShown.resolve(); await observed.catch(() => {});
    }
  } finally {
    if (child) { if (child.exitCode === null) child.kill("SIGTERM"); await child.exited; child.terminal?.close(); }
    if (client) {
      const pid = client.snapshot.pid;
      expectOk(await client.stopRuntime()); await client.disconnect();
      const deadline = Date.now() + 10000;
      while (expectOk(await fetchSnapshot(client.paths)) || pidAlive(pid)) {
        if (Date.now() > deadline) throw new Error("Offline runtime did not stop.");
        await new Promise<void>(resolve => setTimeout(resolve, 20));
      }
    }
    await fixture.cleanup();
  }
}, 25000);
