import { expect, test } from "bun:test";
import { Terminal } from "@xterm/headless";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectOk } from "../testing/results.ts";
import { fetchSnapshot, type RuntimeClient } from "../runtime/client.ts";
import { connectChatRuntime, connectRuntime } from "../runtime/lifecycle.ts";
import { pidAlive } from "../runtime/storage.ts";

// The PTY captures notification bytes rather than displaying OS notifications.
for (const mode of ["code", "chat"] as const) {
  test(`Real ${mode} service completion reaches connected CLI UI and terminal notifications before clean detach`, async () => {
    // Connect real Git, SDK, IPC, and TUI; replace only model responses with offline fixtures.
    const fixture = await createWorktreeFixture();
    const entry = join(import.meta.dir, "..", "index.ts");
    const stateRoot = join(fixture.directory, "state");
    let client: RuntimeClient | undefined;
    let child: Bun.Subprocess | undefined;
    let raw = "";
    let navigated = false;
    let selectedChat = false;
    const terminalScreen = new Terminal({
      cols: 120,
      rows: 24,
      scrollback: 0,
      allowProposedApi: true,
    });
    const frame = () =>
      Array.from(
        { length: terminalScreen.rows },
        (_, row) => terminalScreen.buffer.active.getLine(row)?.translateToString(true) ?? "",
      ).join("\n");
    try {
      client =
        expectOk(
          await (mode === "chat"
            ? connectChatRuntime({ offline: true, stateRoot })
            : connectRuntime(fixture.repository, fixture.main, { offline: true, stateRoot })),
        ) ?? undefined;
      if (!client) {
        throw new Error("Missing offline runtime.");
      }

      const worktree = fixture.repository.worktrees.find((tree) => tree.path === fixture.main)!;
      const id = expectOk(
        await (mode === "chat" ? client.createChat() : client.create(worktree.id)),
      );
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
          cwd: mode === "chat" ? fixture.directory : fixture.main,
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

              // Repaint patches can reuse existing letters; inspect terminal cells rather than raw prose.
              terminalScreen.write(bytes, () => {
                const screen = frame();
                if (!navigated && screen.includes("CHAT")) {
                  navigated = true;
                  _terminal.write(mode === "code" ? "\x00a" : "\x00h");
                }
                if (
                  mode === "chat" &&
                  !selectedChat &&
                  screen.includes("History") &&
                  screen.includes("1/1")
                ) {
                  selectedChat = true;
                  _terminal.write("\r");
                }
                if (screen.includes(mode.toUpperCase()) && screen.includes("context")) {
                  ready.resolve();
                }
                if (
                  raw.includes("\x1b]777;notify;Radian · Task completed;") &&
                  screen.includes("Completed")
                ) {
                  notified.resolve();
                }
              });
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

      terminalScreen.dispose();
      await fixture.cleanup();
    }
  }, 25000);
}
