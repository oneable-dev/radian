import { expect, test } from "bun:test";
import { Terminal } from "@xterm/headless";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectOk } from "../testing/results.ts";
import { fetchSnapshot, type RuntimeClient } from "../runtime/client.ts";
import { connectRuntime } from "../runtime/lifecycle.ts";
import { pidAlive } from "../runtime/storage.ts";

test("Closing a session through the real service never emits shutdown progress notices", async () => {
  // Observe actual bootstrap delivery through a PTY, using scripted responses instead of a model provider.
  const fixture = await createWorktreeFixture();
  const entry = join(import.meta.dir, "..", "index.ts");
  const stateRoot = join(fixture.directory, "state");
  let client: RuntimeClient | undefined;
  let child: Bun.Subprocess | undefined;
  let raw = "";
  let messagesFrame = "";
  let selectedCode = false;
  const screen = new Terminal({ cols: 120, rows: 24, scrollback: 0, allowProposedApi: true });
  const frame = () =>
    Array.from(
      { length: screen.rows },
      (_, row) =>
        screen.buffer.active
          .getLine(screen.buffer.active.viewportY + row)
          ?.translateToString(true) ?? "",
    ).join("\n");
  try {
    client =
      expectOk(
        await connectRuntime(fixture.repository, fixture.main, { offline: true, stateRoot }),
      ) ?? undefined;
    if (!client) {
      throw new Error("Missing offline runtime.");
    }

    const tree = fixture.repository.worktrees.find((tree) => tree.path === fixture.main)!;
    const id = expectOk(await client.create(tree.id));
    const ready = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const messagesShown = Promise.withResolvers<void>();
    const decoder = new TextDecoder();
    const observed = Promise.all([ready.promise, closed.promise, messagesShown.promise]);
    const deadline = setTimeout(() => {
      const error = new Error(
        `Timed out waiting for CLI session closure. Terminal tail:\n${Bun.stripANSI(raw).slice(-2000)}`,
      );
      ready.reject(error);
      closed.reject(error);
      messagesShown.reject(error);
      child?.kill("SIGTERM");
    }, 10000);
    try {
      child = Bun.spawn([process.execPath, entry, "--test-runtime", "--state-dir", stateRoot], {
        cwd: fixture.main,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          XDG_CONFIG_HOME: join(fixture.directory, "config"),
        },
        terminal: {
          cols: 120,
          rows: 24,
          name: "xterm-256color",
          data: (_terminal, bytes) => {
            raw += decoder.decode(bytes, { stream: true });
            // Cursor-addressed repaint patches are not contiguous prose; inspect the actual terminal cells.
            screen.write(bytes, () => {
              const text = frame();
              // First launch now opens CHAT; this regression explicitly exercises CODE.
              if (!selectedCode && text.includes("CHAT")) {
                selectedCode = true;
                _terminal.write("\x00a");
              }
              if (
                text.includes("CODE") &&
                text.includes("Ask to do anything") &&
                text.includes("context")
              ) {
                ready.resolve();
              }
              if (text.includes("No AI sessions")) {
                closed.resolve();
              }
              if (
                text.includes(" Messages ") &&
                text.includes("0/0") &&
                text.includes("No messages yet")
              ) {
                messagesFrame = text;
                messagesShown.resolve();
              }
            });
          },
        },
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
      const output = Bun.stripANSI(raw);
      expect(output).not.toMatch(/Closing \d/u);
      expect(output).not.toContain("OFFLINE SDK");
      expect(messagesFrame).toContain("No messages yet");
      expect(messagesFrame).toContain(" Messages ");
      expect(messagesFrame).toContain("0/0");
      expect(messagesFrame).not.toContain("Search messages");
    } finally {
      clearTimeout(deadline);
      ready.resolve();
      closed.resolve();
      messagesShown.resolve();
      await observed.catch(() => {});
    }
  } finally {
    if (child) {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }

      await child.exited;
      child.terminal?.close();
    }
    if (client) {
      const pid = client.snapshot.pid;
      expectOk(await client.stopRuntime());
      await client.disconnect();

      const deadline = Date.now() + 10000;
      while (expectOk(await fetchSnapshot(client.paths)) || pidAlive(pid)) {
        if (Date.now() > deadline) {
          // oxlint-disable-next-line eslint/no-unsafe-finally -- A leaked daemon must fail cleanup even after a test failure.
          throw new Error("Offline runtime did not stop.");
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    }

    screen.dispose();
    await fixture.cleanup();
  }
}, 25000);
