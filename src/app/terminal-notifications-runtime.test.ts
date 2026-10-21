import { expect, test } from "bun:test";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectOk } from "../testing/results.ts";
import { connectRuntime, fetchSnapshot, type RuntimeClient } from "../runtime/client.ts";
import { pidAlive } from "../runtime/storage.ts";

// The PTY captures notification bytes rather than displaying OS notifications.
test("실제 서비스의 완료가 연결된 CLI의 화면·터미널 알림으로 전달되고 정상 detach한다", async () => {
  // 실제 Git·SDK·IPC·TUI를 연결하고 모델 응답만 offline fixture로 대체한다.
  const fixture = await createWorktreeFixture(), entry = join(import.meta.dir, "..", "index.ts");
  const stateRoot = join(fixture.directory, "state");
  let client: RuntimeClient | undefined;
  let child: Bun.Subprocess | undefined;
  let raw = "";
  try {
    client = expectOk(await connectRuntime(fixture.repository, fixture.main, { offline: true, stateRoot, entry })) ?? undefined;
    if (!client) throw new Error("Missing offline runtime.");
    const worktree = fixture.repository.worktrees.find((tree) => tree.path === fixture.main)!;
    const id = expectOk(await client.create(worktree.id));
    const ready = Promise.withResolvers<void>(), notified = Promise.withResolvers<void>();
    const decoder = new TextDecoder();
    const deadline = setTimeout(() => {
      const error = new Error(`Timed out waiting for CLI terminal notification. Terminal tail:\n${Bun.stripANSI(raw).slice(-2000)}`);
      ready.reject(error); notified.reject(error); child?.kill("SIGTERM");
    }, 10000);
    // Observe both promises immediately, including failures before the UI is ready.
    const observed = Promise.all([ready.promise, notified.promise]);
    try {
      child = Bun.spawn([process.execPath, entry, "--test-runtime", "--state-dir", stateRoot], {
        cwd: fixture.main, env: { ...process.env, TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty", XDG_CONFIG_HOME: join(fixture.directory, "config") },
        terminal: { cols: 120, rows: 24, name: "xterm-ghostty", data: (_terminal, bytes) => {
          raw += decoder.decode(bytes, { stream: true });
          // Workspace navigation is now an on-demand popup; the footer and composer prove the TUI is mounted.
          if (raw.includes("New line") && raw.includes("Transcript")) ready.resolve();
          if (raw.includes("\x1b]777;notify;Radian · Task completed;") && raw.includes("Completed")) notified.resolve();
        } },
      });
      // unknown 포커스의 실제 TUI에 서비스의 새 최종 결과를 전달한다.
      await ready.promise;
      expectOk(await client.prompt(id, "read"));
      await observed;
      child.terminal?.write("\x00c");
      const code = await child.exited;

      // The real service drives both the in-app card and native delivery without changing detach ownership.
      expect(raw).toContain("Completed");
      expect(raw.match(/\x1b\]777;notify;Radian · Task completed;/gu)).toHaveLength(1);
      const notification = raw.match(/\x1b\]777;notify;Radian · Task completed;([^\x1b\x07]*)\x1b\\/u);
      expect(notification?.[1]).toMatch(/^read · (?:<1s|(?:\d+h )?(?:\d+m )?\d+s)$/u);
      expect(raw).toContain("\x1b[?1049l"); expect(code).toBe(0);
    } finally {
      clearTimeout(deadline);
      ready.resolve(); notified.resolve(); await observed.catch(() => {});
    }
  } finally {
    if (child) { if (child.exitCode === null) child.kill("SIGTERM"); await child.exited; child.terminal?.close(); }
    if (client) {
      const pid = client.snapshot.pid;
      expectOk(await client.stopRuntime()); await client.disconnect();
      const deadline = Date.now() + 10000;
      while (expectOk(await fetchSnapshot(client.paths)) || pidAlive(pid)) {
        if (Date.now() > deadline) throw new Error("Offline runtime did not stop.");
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    }
    await fixture.cleanup();
  }
}, 25000);
