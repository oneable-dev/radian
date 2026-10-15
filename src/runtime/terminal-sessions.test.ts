import { expect, test } from "bun:test";
import { join } from "node:path";
import { TerminalSessions } from "./terminal-sessions.ts";
import type { PtyFrame } from "./protocol.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectOk } from "../testing/results.ts";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Terminal observation timed out."); await Bun.sleep(20); }
}
async function watch(sessions: TerminalSessions, id: string) {
  const lease = crypto.randomUUID(), response = expectOk(sessions.attach(id, lease));
  const reader = response.body!.getReader(); let frame: PtyFrame | undefined;
  const task = (async () => {
    const decoder = new TextDecoder(); let text = "";
    while (true) {
      const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value, { stream: true });
      let index: number;
      while ((index = text.indexOf("\n")) >= 0) { frame = JSON.parse(text.slice(0, index)); text = text.slice(index + 1); }
    }
  })();
  await until(() => !!frame);
  return { lease, get frame() { return frame!; },
    input(text: string) { expectOk(sessions.input(id, lease, new TextEncoder().encode(text))); },
    async seen(text: string) { await until(() => frame?.ansi.includes(text) ?? false); },
    async disconnect() { await reader.cancel(); await task; sessions.detach(id, lease); },
  };
}

test("동일 워크트리의 쉘은 독립적이며 종료는 다른 터미널과 무관한 프로세스를 보존한다", async () => {
  // Only isolated clean shells and a directly owned unrelated sleep are used.
  const fixture = await createWorktreeFixture(); const sessions = new TerminalSessions([fixture.repository], () => {}, fixture.directory, true);
  const unrelated = Bun.spawn(["/bin/sleep", "30"]);
  const readers: Awaited<ReturnType<typeof watch>>[] = [];
  try {
    const a = expectOk(await sessions.create(fixture.repository.worktrees[0]!.id, { cols: 80, rows: 20 }));
    const b = expectOk(await sessions.create(fixture.repository.worktrees[0]!.id, { cols: 80, rows: 20 }));
    const first = await watch(sessions, a), second = await watch(sessions, b); readers.push(first, second);
    await first.seen("radian$"); await second.seen("radian$");
    first.input("export RADIAN_TEST_VALUE=first\r"); second.input("printf 'second-%s\\n' \"${RADIAN_TEST_VALUE-unset}\"\r");
    await second.seen("second-unset");

    expectOk(await sessions.close(a));
    expect(sessions.infos.map((item) => item.id)).toEqual([b]);
    expect(unrelated.exitCode).toBeNull();
    second.input("printf 'still-alive\\n'\r"); await second.seen("still-alive");
  } finally {
    for (const reader of readers) await reader.disconnect();
    expectOk(await sessions.stop());
    if (unrelated.exitCode === null) unrelated.kill("SIGTERM"); await unrelated.exited;
    await fixture.cleanup();
  }
}, 20000);

test("shell exit 뒤에도 소유권 anchor와 로그를 유지하고 명시적 닫기로 회수한다", async () => {
  const fixture = await createWorktreeFixture(); const sessions = new TerminalSessions([fixture.repository], () => {}, fixture.directory, true);
  let reader: Awaited<ReturnType<typeof watch>> | undefined;
  try {
    const tree = fixture.repository.worktrees.find((item) => item.path === fixture.feature)!;
    const id = expectOk(await sessions.create(tree.id, { cols: 80, rows: 12 })); reader = await watch(sessions, id); await reader.seen("radian$");
    reader.input("pwd > shell-cwd.txt; printf 'shell-done\\n'; exit 7\r");
    await until(() => sessions.infos[0]?.exited === true);
    expect(sessions.infos[0]!.exitCode).toBe(7);
    expect((await Bun.file(join(fixture.feature, "shell-cwd.txt")).text()).trim()).toBe(fixture.feature);
    await reader.seen("shell-done");

    expectOk(await sessions.close(id)); expect(sessions.infos).toEqual([]);
  } finally { await reader?.disconnect(); expectOk(await sessions.stop()); await fixture.cleanup(); }
}, 15000);

test("쉘 소유권 supervisor는 워크트리의 Bun preload와 dotenv를 자동 실행하지 않는다", async () => {
  const fixture = await createWorktreeFixture();
  const sessions = new TerminalSessions([fixture.repository], () => {}, fixture.directory, true);
  const key = `RADIAN_SENTINEL_${crypto.randomUUID().replaceAll("-", "")}`;
  let reader: Awaited<ReturnType<typeof watch>> | undefined;
  try {
    const marker = join(fixture.main, "preload-ran.txt");
    await Bun.write(join(fixture.main, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    await Bun.write(join(fixture.main, "preload.ts"), `await Bun.write(${JSON.stringify(marker)}, 'unexpected');`);
    await Bun.write(join(fixture.main, ".env"), `${key}=from-project\n`);
    const tree = fixture.repository.worktrees.find((item) => item.path === fixture.main)!;

    const id = expectOk(await sessions.create(tree.id, { cols: 80, rows: 12 })); reader = await watch(sessions, id); await reader.seen("radian$");
    reader.input(`printf 'env-%s\\n' \"\${${key}-unset}\"\r`); await reader.seen("env-unset");

    expect(await Bun.file(marker).exists()).toBe(false);
  } finally { await reader?.disconnect(); expectOk(await sessions.stop()); await fixture.cleanup(); }
});
