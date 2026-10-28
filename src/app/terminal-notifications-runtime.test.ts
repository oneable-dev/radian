import { expect, test } from "bun:test";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectOk } from "../testing/results.ts";
import { fetchSnapshot, type RuntimeClient } from "../runtime/client.ts";
import { connectRuntime } from "../runtime/lifecycle.ts";
import { pidAlive } from "../runtime/storage.ts";

// The PTY captures notification bytes rather than displaying OS notifications.
test("Real service completion reaches connected CLI UI and terminal notifications before clean detach", async () => {
  // Connect real Git, SDK, IPC, and TUI; replace only model responses with offline fixtures.
  const fixture = await createWorktreeFixture();
  const entry = join(import.meta.dir, "..", "index.ts");
  const stateRoot = join(fixture.directory, "state");
  let client: RuntimeClient | undefined;
  let child: Bun.Subprocess | undefined;
  let raw = "";
  try {
    client =
      expectOk(
        await connectRuntime(fixture.repository, fixture.main, { offline: true, stateRoot }),
      ) ?? undefined;
    if (!client) {
      throw new Error("Missing offline runtime.");
    }

    const worktree = fixture.repository.worktrees.find((tree) => tree.path === fixture.main)!;
    const id = expectOk(await client.create(worktree.id));
    const ready = Promise.withResolvers<void>();
    const notified = Promise.withResolvers<void>();
    const decoder = new TextDecoder();
    const deadline = setTimeout(() => {
      const error = new Error(
        `Timed out waiting for CLI terminal notification. Terminal tail:\n${Bun.stripANSI(raw).slice(-2000)}`,
      );
      ready.reject(error);
      notified.reject(error);
      child?.kill("SIGTERM");
    }, 10000);
    // Observe both promises immediately, including failures before the UI is ready.
    const observed = Promise.all([ready.promise, notified.promise]);
    try {
      child = Bun.spawn([process.execPath, entry, "--test-runtime", "--state-dir", stateRoot], {
        cwd: fixture.main,
        env: {
          ...process.env,
          TERM: "xterm-ghostty",
          TERM_PROGRAM: "ghostty",
          XDG_CONFIG_HOME: join(fixture.directory, "config"),
        },
        terminal: {
          cols: 120,
          rows: 24,
          name: "xterm-ghostty",
          data: (_terminal, bytes) => {
            raw += decoder.decode(bytes, { stream: true });

            // Detect readiness through app, work-view, and session status, not default shortcut hints.
            const screen = Bun.stripANSI(raw);
            if (screen.includes("AGENT") && screen.includes("context")) {
              ready.resolve();
            }
            if (
              raw.includes("\x1b]777;notify;Radian · Task completed;") &&
              raw.includes("Completed")
            ) {
              notified.resolve();
            }
          },
        },
      });
      // Deliver fresh final service results to a real TUI with unknown focus.
      await ready.promise;
      // Verify actual requests and notifications without restoring hidden newline hints.
      expect(Bun.stripANSI(raw)).not.toContain("New line");
      expectOk(await client.prompt(id, "read"));
      await observed;
      child.terminal?.write("\x00d");

      const code = await child.exited;

      // The real service drives both the in-app card and native delivery without changing detach ownership.
      expect(raw).toContain("Completed");
      // oxlint-disable-next-line eslint/no-control-regex -- Assert the exact OSC notification protocol on the captured PTY.
      expect(raw.match(/\x1b\]777;notify;Radian · Task completed;/gu)).toHaveLength(1);

      const notification = raw.match(
        // oxlint-disable-next-line eslint/no-control-regex -- OSC payloads terminate at ESC or BEL, not arbitrary text boundaries.
        /\x1b\]777;notify;Radian · Task completed;([^\x1b\x07]*)\x1b\\/u,
      );
      expect(notification?.[1]).toMatch(/^read · (?:<1s|(?:\d+h )?(?:\d+m )?\d+s)$/u);
      expect(raw).toContain("\x1b[?1049l");
      expect(code).toBe(0);
    } finally {
      clearTimeout(deadline);
      ready.resolve();
      notified.resolve();
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

    await fixture.cleanup();
  }
}, 25000);
