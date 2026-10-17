import { expect, test } from "bun:test";
import { readTerminalProcessTitles } from "./process-titles.ts";
import type { TerminalInfo } from "../runtime/protocol.ts";
import { err, ok } from "../result.ts";
import { PtyError } from "../errors.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { TerminalSessions } from "./sessions.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { join } from "node:path";

const item: TerminalInfo = { id: "tab", worktreeId: "tree", pid: 100, shellPid: 101, title: "Terminal 1 · zsh", exited: false, exitCode: null };
const signal = () => new AbortController().signal;

test("실제 foreground 그룹을 사용하고 background 작업이나 shell argv는 탭 이름으로 고르지 않는다", async () => {
  // Shell foreground group points to nvim, while sleep runs in a separate background group.
  const text = "100 1 100 -1 /bin/bun\n101 100 101 200 /bin/zsh\n200 101 200 200 /usr/local/bin/nvim\n201 101 201 200 /bin/sleep\n";
  const result = await readTerminalProcessTitles([item], signal(), async () => ok(text));
  expect(expectOk(result)).toEqual({ tab: "nvim" });
});

test("foreground 작업이 끝나면 shell 이름으로 돌아가고 재사용된 shell PID는 채택하지 않는다", async () => {
  const text = "100 1 100 -1 /bin/bun\n101 100 101 101 /bin/zsh\n";
  expect(expectOk(await readTerminalProcessTitles([item], signal(), async () => ok(text)))).toEqual({ tab: "zsh" });
  expect(expectOk(await readTerminalProcessTitles([{ ...item, pid: 999 }], signal(), async () => ok(text)))).toEqual({});
});

test("shell 시작 직후의 supervisor 그룹은 내부 bun이 아니라 shell 이름을 표시한다", async () => {
  const text = "100 1 100 100 /bin/bun\n101 100 100 100 /bin/zsh\n";
  expect(expectOk(await readTerminalProcessTitles([item], signal(), async () => ok(text)))).toEqual({ tab: "zsh" });
});

test.each(["", "101 invalid ps response", "101 100 101 101 /bin/zsh\nmalformed row"]) ("손상된 프로세스 응답은 빈 성공이나 부분 결과로 바꾸지 않는다: %j", async (text) => {
  expect(expectError(await readTerminalProcessTitles([item], signal(), async () => ok(text))).code).toBe("PTY_UNAVAILABLE");
});

test("조회 취소와 OS 조회 실패는 Result 오류로 구분한다", async () => {
  const abort = new AbortController(); abort.abort(); let calls = 0;
  expect(expectError(await readTerminalProcessTitles([item], abort.signal, async () => { calls++; return ok(""); })).code).toBe("CANCELLED");
  expect(calls).toBe(0);
  const failure = new PtyError("PTY_UNAVAILABLE", "ps unavailable");
  expect(expectError(await readTerminalProcessTitles([item], signal(), async () => err(failure)))).toBe(failure);
});

test("실제 PTY에서 foreground sleep과 shell 복귀를 읽고 background sleep은 선택하지 않는다", async () => {
  // Only fixture-owned processes are launched; title lookup never sends an input command itself.
  const fixture = await createWorktreeFixture();
  const sessions = new TerminalSessions([fixture.repository], () => {}, fixture.directory, true);
  let disconnect: (() => Promise<void>) | undefined, pump: Promise<void> | undefined;
  const lease = crypto.randomUUID();
  async function untilTitle(id: string, expected?: string) {
    const deadline = Date.now() + 6000;
    while (true) {
      const titles = expectOk(await readTerminalProcessTitles(sessions.infos, signal()));
      if (titles[id] && (!expected || titles[id] === expected)) return titles[id]!;
      if (Date.now() >= deadline) throw new Error(`Expected process title ${expected ?? "shell"}, received ${JSON.stringify(titles)}`);
      await Bun.sleep(30);
    }
  }
  try {
    const id = expectOk(await sessions.create(fixture.repository.worktrees[0]!.id, { cols: 80, rows: 12 }));
    const reader = expectOk(sessions.attach(id, lease)).body!.getReader();
    disconnect = () => reader.cancel();
    pump = (async () => { while (!((await reader.read()).done)) {} })();
    const shell = await untilTitle(id);
    expect(shell).not.toContain("Terminal");
    expectOk(sessions.input(id, lease, new TextEncoder().encode("/bin/sleep 30\r")));
    expect(await untilTitle(id, "sleep")).toBe("sleep");
    expectOk(sessions.input(id, lease, new Uint8Array([3])));
    expect(await untilTitle(id, shell)).toBe(shell);
    const started = join(fixture.repository.worktrees[0]!.path, "background.pid");
    expectOk(sessions.input(id, lease, new TextEncoder().encode(`/bin/sleep 30 & echo $! > ${JSON.stringify(started)}\r`)));
    const deadline = Date.now() + 6000;
    while (!await Bun.file(started).exists()) { if (Date.now() >= deadline) throw new Error("Background fixture did not start."); await Bun.sleep(20); }
    expect(await untilTitle(id, shell)).toBe(shell);
  } finally {
    await disconnect?.(); await pump;
    expectOk(await sessions.stop()); await fixture.cleanup();
  }
}, 15000);
