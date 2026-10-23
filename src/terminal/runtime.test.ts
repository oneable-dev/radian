import { expect, test } from "bun:test";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectOk } from "../testing/results.ts";
import { connectRuntime, fetchSnapshot, type RuntimeClient } from "../runtime/client.ts";
import type { PtyFrame } from "../runtime/protocol.ts";
import { restoreWorkViews, saveWorkViews } from "../runtime/work-view-preferences.ts";
import { pidAlive } from "../runtime/storage.ts";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Terminal runtime condition timed out."); await Bun.sleep(25); }
}
async function watch(client: RuntimeClient, id: string) {
  let frame: PtyFrame | undefined; const errors: unknown[] = [];
  const connection = expectOk(await client.attachTerminal(id, (value) => { frame = value; }, (error) => errors.push(error)));
  return { connection, errors, get frame() { return frame!; },
    input(text: string) { connection.input(new TextEncoder().encode(text)); },
    async seen(text: string) { await until(() => frame?.ansi.includes(text) ?? false); } };
}
async function setup() {
  const fixture = await createWorktreeFixture();
  const options = { offline: true, stateRoot: join(fixture.directory, "state"), entry: join(import.meta.dir, "..", "index.ts") };
  const clients: RuntimeClient[] = [];
  return { ...fixture,
    async connect() { const client = expectOk(await connectRuntime(fixture.repository, fixture.main, options)); if (!client) throw new Error("Missing runtime"); clients.push(client); return client; },
    async cleanup() {
      await Promise.all(clients.map((client) => client.disconnect()));
      const admin = expectOk(await connectRuntime(fixture.repository, fixture.main, { ...options, start: false }));
      if (admin) {
        const anchors = admin.snapshot.terminals?.map((item) => item.pid) ?? [];
        expectOk(await admin.stopRuntime()); await admin.disconnect();
        await until(async () => !expectOk(await fetchSnapshot(admin.paths)) && anchors.every((pid) => !pidAlive(pid)));
      }
      await fixture.cleanup();
    },
  };
}

test("실제 개발 서버는 UI 분리 중 유지되고 Ctrl+C와 명시적 탭 닫기가 소유 실행에만 작용한다", async () => {
  // Real loopback HTTP servers belong to two different isolated PTY sessions.
  const app = await setup();
  try {
    const serverPath = join(app.directory, "server.ts");
    await Bun.write(serverPath, `import {dlopen,FFIType} from 'bun:ffi'; const lib=dlopen(process.platform==='darwin'?'/usr/lib/libSystem.B.dylib':'libc.so.6',Object.fromEntries(['getsid','getpgid','tcgetsid','tcgetpgrp'].map(name=>[name,{args:[FFIType.i32],returns:FFIType.i32}]))); const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('alive')}); await Bun.write(process.argv[2],JSON.stringify({pid:process.pid,port:server.port,tty:process.stdin.isTTY,sid:lib.symbols.getsid(0),pgrp:lib.symbols.getpgid(0),ttySid:lib.symbols.tcgetsid(0),fg:lib.symbols.tcgetpgrp(0)})); console.log('SERVER_READY'); process.on('SIGINT',()=>{server.stop(true);process.exit(0)});`);
    const client = await app.connect(), [a, b] = app.repository.worktrees;
    const firstId = expectOk(await client.createTerminal(a!.id, { cols: 100, rows: 18 }));
    const secondId = expectOk(await client.createTerminal(b!.id, { cols: 100, rows: 18 }));
    const first = await watch(client, firstId), second = await watch(client, secondId);
    await first.seen("radian$"); await second.seen("radian$");
    const portA = join(app.directory, "a.json"), portB = join(app.directory, "b.json");
    const launch = (path: string) => `${JSON.stringify(process.execPath)} ${JSON.stringify(serverPath)} ${JSON.stringify(path)}`;
    first.input(launch(portA) + "\r"); second.input(launch(portB) + " > background.log 2>&1 &\r");
    await until(async () => await Bun.file(portA).exists() && await Bun.file(portB).exists());
    const firstServer: { pid: number; port: number; tty: boolean; ttySid: number; fg: number } = await Bun.file(portA).json();
    const secondServer: { pid: number; port: number } = await Bun.file(portB).json();
    const alive = async (port: number) => (await fetch(`http://127.0.0.1:${port}`)).text();
    expect(await alive(firstServer.port)).toBe("alive"); expect(await alive(secondServer.port)).toBe("alive");
    expect(firstServer.tty).toBe(true);
    expect(firstServer.ttySid).toBe(client.snapshot.terminals!.find((item) => item.id === firstId)!.pid);
    expect(firstServer.fg).toBe(firstServer.pid); // Real foreground job control, not just a painted ^C.

    // Ctrl+C interrupts the foreground server, not its shell or the unrelated background server.
    first.input("\x03");
    try { await until(() => !pidAlive(firstServer.pid)); }
    catch (error) {
      const info = client.snapshot.terminals!.find((item) => item.id === firstId)!;
      const ps = Bun.spawn(["ps", "-o", "pid=,ppid=,pgid=,stat=,comm=", "-p", [info.pid, info.shellPid, firstServer.pid].join(",")]);
      console.error(firstServer, await new Response(ps.stdout).text(), first.frame.ansi);
      throw error;
    }
    expect(client.snapshot.terminals!.find((item) => item.id === firstId)!.exited).toBe(false);
    expect(await alive(secondServer.port)).toBe("alive");
    first.input(launch(portA) + "\r");
    await until(async () => (await Bun.file(portA).json()).pid !== firstServer.pid);
    const restarted: { pid: number; port: number } = await Bun.file(portA).json();
    const ownerPid = client.snapshot.terminals!.find((item) => item.id === firstId)!.pid;
    const preferences = structuredClone(client.snapshot.preferences);
    saveWorkViews(preferences, { active: { [a!.id]: "terminal", [b!.id]: "git" }, agentScroll: {}, terminalSelection: { [a!.id]: firstId, [b!.id]: secondId } });
    expectOk(await client.savePreferences(preferences)); await client.disconnect();
    expect(await alive(restarted.port)).toBe("alive"); expect(await alive(secondServer.port)).toBe("alive");

    const next = await app.connect();
    expect(next.snapshot.terminals!.find((item) => item.id === firstId)!.pid).toBe(ownerPid);
    expect(restoreWorkViews(next.snapshot.preferences).active[a!.id]).toBe("terminal");
    expect(restoreWorkViews(next.snapshot.preferences).terminalSelection?.[b!.id]).toBe(secondId);
    expect(next.snapshot.preferences.workViews!.active[a!.id]).not.toBe("terminal");
    const closing = next.closeTerminal(firstId);
    expect(next.snapshot.terminals!.map((item) => item.id)).not.toContain(firstId);
    expectOk(await closing);
    await until(() => !pidAlive(restarted.pid) && !pidAlive(ownerPid) && !next.snapshot.terminalClosingCount);
    expect(await alive(secondServer.port)).toBe("alive");
    expectOk(await next.closeTerminal(secondId));
    await until(() => !pidAlive(secondServer.pid) && !next.snapshot.terminalClosingCount);
    expect(first.errors).toEqual([]); expect(second.errors).toEqual([]);
  } finally { await app.cleanup(); }
}, 30000);

test("TUI가 분리된 동안 shell exit도 탭과 supervisor를 자동 정리한다", async () => {
  // UI가 없어도 종료 처리를 런타임이 소유해야 재접속에 빈 종료 탭이 남지 않는다.
  const app = await setup();
  try {
    const client = await app.connect(), tree = app.repository.worktrees[0]!;
    const id = expectOk(await client.createTerminal(tree.id, { cols: 80, rows: 12 }));
    const terminal = await watch(client, id); await terminal.seen("radian$");
    const anchor = client.snapshot.terminals!.find((item) => item.id === id)!.pid;
    const sentinel = join(app.directory, "allow-exit");
    terminal.input(`while [ ! -f ${JSON.stringify(sentinel)} ]; do sleep 0.05; done; exit 0\r`);
    await client.disconnect();

    // 입력 drain이 끝난 뒤 파일로 종료를 허용해 실제 분리 상태에서 exit하게 한다.
    await Bun.write(sentinel, "exit");
    await until(async () => {
      const snapshot = expectOk(await fetchSnapshot(client.paths));
      return !!snapshot && !snapshot.terminals?.some((item) => item.id === id) && !snapshot.terminalClosingCount && !pidAlive(anchor);
    });
    const next = await app.connect();

    expect(next.snapshot.terminals).toEqual([]);
    expect(next.snapshot.terminalClosingCount).toBe(0);
    expect(pidAlive(anchor)).toBe(false);
  } finally { await app.cleanup(); }
}, 20000);

test("Prior logs and scroll restore after reconnect and input returns to live screens", async () => {
  const app = await setup();
  try {
    const client = await app.connect();
    const id = expectOk(await client.createTerminal(app.repository.worktrees[0]!.id, { cols: 80, rows: 8 }));
    const first = await watch(client, id); await first.seen("radian$");
    first.input("i=0; while [ \"$i\" -lt 5200 ]; do printf 'log-%04d\\n' \"$i\"; i=$((i+1)); done\r");
    await first.seen("log-5199");
    first.connection.scroll(-40); await until(() => first.frame.scrollback?.offset === 40);
    const historical = first.frame.ansi;
    expect(first.frame.scrollback!.available).toBe(5000);
    expect(historical).not.toContain("log-5199");
    // Copy mode reads the bounded full buffer without scrolling the live attachment.
    const text = expectOk(await first.connection.read());
    expect(text.text).toContain("log-5199"); expect(text.text).not.toContain("log-0000");
    expect(first.frame.scrollback?.offset).toBe(40);
    await client.disconnect();

    const next = await app.connect(), restored = await watch(next, id);
    expect(restored.frame.scrollback?.offset).toBe(40); expect(restored.frame.ansi).toBe(historical);
    restored.input("printf 'back-to-live\\n'\r"); await restored.seen("back-to-live");
    expect(restored.frame.scrollback?.offset).toBe(0);
    expect(text.text).not.toContain("back-to-live");
    expect(expectOk(await restored.connection.read()).text).toContain("back-to-live");
  } finally { await app.cleanup(); }
}, 20000);

test("서비스 재시작은 탭 선택만 복원하고 쉘이나 이전 명령을 자동 재실행하지 않는다", async () => {
  const app = await setup();
  try {
    const client = await app.connect(), tree = app.repository.worktrees[0]!;
    const id = expectOk(await client.createTerminal(tree.id, { cols: 80, rows: 12 }));
    const terminal = await watch(client, id); await terminal.seen("radian$");
    terminal.input("printf 'once\\n' >> terminal-runs.txt\r");
    const file = join(tree.path, "terminal-runs.txt");
    // BunFile caches its observed size; use fresh reads while the shell is writing.
    await until(async () => await Bun.file(file).exists() && await Bun.file(file).text() === "once\n");
    const preferences = structuredClone(client.snapshot.preferences);
    saveWorkViews(preferences, { active: { [tree.id]: "terminal" }, agentScroll: {}, terminalSelection: { [tree.id]: id } });
    expectOk(await client.savePreferences(preferences));
    const instance = client.snapshot.instance, anchor = client.snapshot.terminals![0]!.pid;
    await terminal.connection.disconnect(); expectOk(await client.stopRuntime()); await client.disconnect();
    await until(async () => !expectOk(await fetchSnapshot(client.paths)) && !pidAlive(anchor));

    const restarted = await app.connect();
    expect(restarted.snapshot.instance).not.toBe(instance);
    expect(restarted.snapshot.terminals).toEqual([]);
    expect(restoreWorkViews(restarted.snapshot.preferences).active[tree.id]).toBe("terminal");
    expect(await Bun.file(file).text()).toBe("once\n");
  } finally { await app.cleanup(); }
}, 20000);
