import { expect, test } from "bun:test";
import { join } from "node:path";
import { TerminalSessions } from "./sessions.ts";
import type { PtyFrame } from "../runtime/protocol.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectOk } from "../testing/results.ts";
import { pidAlive } from "../runtime/storage.ts";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error("Terminal observation timed out.");
    }

    await Bun.sleep(20);
  }
}

async function watch(sessions: TerminalSessions, id: string) {
  const lease = crypto.randomUUID();
  const response = expectOk(sessions.attach(id, lease));
  const reader = response.body!.getReader();
  let frame: PtyFrame | undefined;
  const task = (async () => {
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const part = await reader.read();
      if (part.done) {
        break;
      }

      text += decoder.decode(part.value, { stream: true });

      let index: number;
      while ((index = text.indexOf("\n")) >= 0) {
        frame = JSON.parse(text.slice(0, index));
        text = text.slice(index + 1);
      }
    }
  })();

  await until(() => !!frame);

  return {
    lease,
    get frame() {
      return frame!;
    },
    input(text: string) {
      expectOk(sessions.input(id, lease, new TextEncoder().encode(text)));
    },
    async seen(text: string) {
      await until(() => frame?.ansi.includes(text) ?? false);
    },
    async disconnect() {
      await reader.cancel();
      await task;
      sessions.detach(id, lease);
    },
  };
}

test("Same-worktree shells stay independent and closing preserves other terminals/unrelated processes", async () => {
  // Only isolated clean shells and a directly owned unrelated sleep are used.
  const fixture = await createWorktreeFixture();
  const sessions = new TerminalSessions([fixture.repository], () => {}, fixture.directory, true);
  const unrelated = Bun.spawn(["/bin/sleep", "30"]);
  const readers: Awaited<ReturnType<typeof watch>>[] = [];
  try {
    const a = expectOk(
      await sessions.create(fixture.repository.worktrees[0]!.id, { cols: 80, rows: 20 }),
    );
    const b = expectOk(
      await sessions.create(fixture.repository.worktrees[0]!.id, { cols: 80, rows: 20 }),
    );
    const first = await watch(sessions, a);
    const second = await watch(sessions, b);

    readers.push(first, second);
    await first.seen("radian$");
    await second.seen("radian$");
    first.input("export RADIAN_TEST_VALUE=first\r");
    second.input("printf 'second-%s\\n' \"${RADIAN_TEST_VALUE-unset}\"\r");
    await second.seen("second-unset");

    expectOk(await sessions.close(a));
    expect(sessions.infos.map((item) => item.id)).toEqual([b]);
    expect(unrelated.exitCode).toBeNull();
    second.input("printf 'still-alive\\n'\r");
    await second.seen("still-alive");
  } finally {
    for (const reader of readers) {
      await reader.disconnect();
    }

    expectOk(await sessions.stop());
    if (unrelated.exitCode === null) {
      unrelated.kill("SIGTERM");
    }

    await unrelated.exited;
    await fixture.cleanup();
  }
}, 20000);

test("Shell exit reclaims tabs and owned jobs while preserving other terminals", async () => {
  // Distinguish separate-tab runs from exited-tab background jobs.
  const fixture = await createWorktreeFixture();
  const sessions = new TerminalSessions([fixture.repository], () => {}, fixture.directory, true);
  let reader: Awaited<ReturnType<typeof watch>> | undefined;
  try {
    const tree = fixture.repository.worktrees.find((item) => item.path === fixture.feature)!;
    const id = expectOk(await sessions.create(tree.id, { cols: 80, rows: 12 }));
    const neighbor = expectOk(await sessions.create(tree.id, { cols: 80, rows: 12 }));
    const anchor = sessions.infos.find((item) => item.id === id)!.pid;

    reader = await watch(sessions, id);
    await reader.seen("radian$");

    // Nonzero exits also close tabs without creating replacement shells.
    reader.input("sleep 30 & echo $! > background-pid.txt; pwd > shell-cwd.txt; exit 7\r");
    await until(
      () =>
        !sessions.infos.some((item) => item.id === id) &&
        sessions.closingCount === 0 &&
        !pidAlive(anchor),
    );

    const background = Number(
      (await Bun.file(join(fixture.feature, "background-pid.txt")).text()).trim(),
    );
    expect(pidAlive(background)).toBe(false);
    expect((await Bun.file(join(fixture.feature, "shell-cwd.txt")).text()).trim()).toBe(
      fixture.feature,
    );
    expect(sessions.infos.map((item) => item.id)).toEqual([neighbor]);
    expect(sessions.infos[0]!.exited).toBe(false);
    expectOk(await sessions.close(id)); // Closing already auto-closed tabs remains safe.
  } finally {
    await reader?.disconnect();
    expectOk(await sessions.stop());
    await fixture.cleanup();
  }
}, 15000);

test("Shell ownership supervisors never automatically execute worktree Bun preloads or dotenv", async () => {
  const fixture = await createWorktreeFixture();
  const sessions = new TerminalSessions([fixture.repository], () => {}, fixture.directory, true);
  const key = `RADIAN_SENTINEL_${crypto.randomUUID().replaceAll("-", "")}`;
  let reader: Awaited<ReturnType<typeof watch>> | undefined;
  try {
    const marker = join(fixture.main, "preload-ran.txt");
    await Bun.write(join(fixture.main, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    await Bun.write(
      join(fixture.main, "preload.ts"),
      `await Bun.write(${JSON.stringify(marker)}, 'unexpected');`,
    );
    await Bun.write(join(fixture.main, ".env"), `${key}=from-project\n`);

    const tree = fixture.repository.worktrees.find((item) => item.path === fixture.main)!;

    const id = expectOk(await sessions.create(tree.id, { cols: 80, rows: 12 }));

    reader = await watch(sessions, id);
    await reader.seen("radian$");
    reader.input(`printf 'env-%s\\n' "\${${key}-unset}"\r`);
    await reader.seen("env-unset");

    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await reader?.disconnect();
    expectOk(await sessions.stop());
    await fixture.cleanup();
  }
});
