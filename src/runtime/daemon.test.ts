import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "typebox/value";
import { replySchema, type RuntimeSnapshot } from "./protocol.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { WorkspaceClient } from "./workspace-client.ts";
import { connectRuntime, defaultPreferences, ensureSharedDaemon, fetchSnapshot, RuntimeClient } from "./client.ts";
import { acquireRuntime, daemonPaths, pidAlive, privateDirectory, runtimePaths, RuntimeStore } from "./storage.ts";

const entry = join(import.meta.dir, "..", "index.ts");
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Shared daemon observation timed out.");
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
}
async function stop(stateRoot: string): Promise<void> {
  const paths = daemonPaths(true, stateRoot), snapshot = expectOk(await fetchSnapshot(paths));
  if (!snapshot) return;
  const client = new RuntimeClient(paths, snapshot);
  try { expectOk(await client.stopRuntime()); await until(() => !pidAlive(snapshot.pid)); }
  finally { await client.disconnect(); }
}

test("서로 다른 저장소를 동시에 등록해도 공용 프로세스 하나만 사용하고 저장 경로·인스턴스를 분리한다", async () => {
  // 두 독립 저장소가 같은 상태 루트로 동시에 접속한다.
  const a = await createWorktreeFixture(), b = await createWorktreeFixture();
  const stateRoot = join(a.directory, "state"), options = { offline: true, stateRoot, entry, start: false, register: true };
  const clients: RuntimeClient[] = [];
  try {
    // 경쟁하는 시작 요청도 한 데몬의 저장소별 채널로 수렴한다.
    for (const client of await Promise.all([a, b, a, b].map(fixture => connectRuntime(fixture.repository, fixture.main, options)))) {
      const connected = expectOk(client); if (!connected) throw new Error("Missing catalog client."); clients.push(connected);
    }
    const daemon = expectOk(await fetchSnapshot(daemonPaths(true, stateRoot)))!;

    // 관리 PID는 같지만 상태 폴더·인스턴스 경계와 SDK 수명은 서로 다르다.
    expect(new Set(clients.map(client => client.snapshot.pid))).toEqual(new Set([daemon.pid]));
    expect(clients[0]!.snapshot.instance).not.toBe(clients[1]!.snapshot.instance);
    expect(runtimePaths(a.repository.id, true, stateRoot).directory).not.toBe(runtimePaths(b.repository.id, true, stateRoot).directory);
    expect(daemon.repositories).toHaveLength(2);
    for (const client of clients) expect(client.snapshot.capabilities).toContain("repository-catalog");
    expect(daemon.details).toEqual({}); expect(daemon.editors).toEqual([]); expect(daemon.terminals).toEqual([]);

    // 잘못된 제어 인스턴스와 저장소 ID는 기존 프로세스나 등록 목록을 변경하지 않는다.
    for (const [path, instance, body, code] of [
      ["/command", "stale-owner", { type: "stop" }, "PROTOCOL_ERROR"],
      ["/repositories", daemon.instance, { repositoryId: b.repository.id, cwd: a.main }, "PROTOCOL_ERROR"],
      ["/repositories", daemon.instance, { cwd: a.main }, "INVALID_INPUT"],
    ] as const) {
      const response = await fetch(`http://localhost${path}`, { unix: daemonPaths(true, stateRoot).socket, method: "POST",
        headers: { "X-Radian-Instance": instance }, body: JSON.stringify(body) });
      const rejected = await response.json();
      if (!Value.Check(replySchema, rejected) || rejected.ok || typeof rejected.error === "string") throw new Error("Expected a typed registration rejection.");
      expect(rejected.error.code).toBe(code);
    }
    expect(expectOk(await fetchSnapshot(daemonPaths(true, stateRoot)))!.pid).toBe(daemon.pid);
    expect(expectOk(await fetchSnapshot(daemonPaths(true, stateRoot)))!.repositories).toHaveLength(2);

    const changedConfig = expectError(await connectRuntime(a.repository, a.main, { ...options, config: join(a.directory, "different-settings.json") }));
    expect(changedConfig.code).toBe("INVALID_INPUT");
  } finally { await Promise.all(clients.map(client => client.disconnect())); await stop(stateRoot); await a.cleanup(); await b.cleanup(); }
}, 20000);

test("TUI가 없어도 공용 데몬의 카탈로그가 새 워크트리를 감지하고 초안을 활성화까지 유지한다", async () => {
  // SDK를 사용하지 않는 저장소를 등록하고 UI 초안만 저장한다.
  const fixture = await createWorktreeFixture(), stateRoot = join(fixture.directory, "state");
  const options = { offline: true, stateRoot, entry }, paths = runtimePaths(fixture.repository.id, true, stateRoot);
  let workspace: WorkspaceClient | undefined;
  try {
    await privateDirectory(paths.directory);
    const saved = defaultPreferences();
    saved.selection.sessions[fixture.main] = "saved"; saved.drafts.saved = "previous draft";
    expectOk(await new RuntimeStore(paths).save({ version: 1, repositoryId: fixture.repository.id, repositories: [fixture.repository], records: [], preferences: saved }));
    workspace = expectOk(await WorkspaceClient.open([fixture.repository], fixture.main, options));
    const preferences = workspace.snapshot.preferences;
    preferences.drafts.saved = "keep cold draft";
    expectOk(await workspace.savePreferences(preferences));
    const catalog = expectOk(await fetchSnapshot(paths))!;
    await workspace.disconnect(); workspace = undefined;

    // UI 없이 외부에서 만든 워크트리도 데몬의 파일시스템 감시로 갱신된다.
    const added = join(fixture.directory, "daemon-watched");
    await fixture.git(fixture.main, ["worktree", "add", "-b", "daemon-watched", added]);
    await until(async () => expectOk(await fetchSnapshot(paths))!.repositories[0]!.worktrees.some(tree => tree.path === added));

    // 활성화는 새 프로세스를 띄우거나 기존 저장소별 초안을 초기화하지 않는다.
    workspace = expectOk(await WorkspaceClient.open([fixture.repository], fixture.main, options));
    expect(expectOk(await fetchSnapshot(paths))!.capabilities).toContain("repository-catalog");
    expectOk(await workspace.activate(added));
    const active = expectOk(await fetchSnapshot(paths))!;
    expect(active.pid).toBe(catalog.pid); expect(active.instance).toBe(catalog.instance);
    expect(active.preferences.drafts.saved).toBe("keep cold draft");
    expect(active.capabilities).toContain("repository-runtime");
  } finally { await workspace?.disconnect(); await stop(stateRoot); await fixture.cleanup(); }
}, 20000);

test("살아 있는 구형 저장소 소유권은 공용 데몬이 빼앗거나 저장 파일을 덮어쓰지 않는다", async () => {
  // 구형 서비스가 상태를 소유 중인 상황을 실제 잠금 파일로 준비한다.
  const fixture = await createWorktreeFixture(), stateRoot = join(fixture.directory, "state");
  const paths = runtimePaths(fixture.repository.id, true, stateRoot);
  await privateDirectory(paths.directory);
  const release = await acquireRuntime(paths); if (!release) throw new Error("Missing fixture ownership.");
  const original = "legacy-owned-data";
  await writeFile(paths.manifest, original, { mode: 0o600 });
  try {
    // 기존 소유자가 살아 있으면 새 저장소 런타임 등록을 거절한다.
    const result = await connectRuntime(fixture.repository, fixture.main, { offline: true, stateRoot, entry });

    // 오류를 빈 초기 상태로 바꾸지 않고 기존 소유권과 원본 데이터를 보존한다.
    expect(expectError(result).code).toBe("CONNECTION_FAILED");
    expect(await readFile(paths.manifest, "utf8")).toBe(original);
    expect(JSON.parse(await readFile(paths.lock, "utf8")).pid).toBe(process.pid);
    expect(pidAlive(process.pid)).toBe(true);
    expect(expectOk(await fetchSnapshot(daemonPaths(true, stateRoot)))!.repositories).toEqual([]);
  } finally { await stop(stateRoot); await release(); await fixture.cleanup(); }
}, 20000);

test("종료 중인 공용 소유자가 있으면 등록을 보내지 않고 소켓과 잠금 해제 후 새 프로세스를 시작한다", async () => {
  // 저장소 채널보다 늦게 종료되는 관리 소켓과 살아 있는 소유권을 준비한다.
  const fixture = await createWorktreeFixture(), stateRoot = join(fixture.directory, "state"), paths = daemonPaths(true, stateRoot);
  await privateDirectory(paths.directory);
  const release = await acquireRuntime(paths); if (!release) throw new Error("Missing shutdown fixture ownership.");
  const closing: RuntimeSnapshot = { version: 1, pid: process.pid, instance: "closing-daemon", repositoryId: "radian:shared", mode: "offline",
    capabilities: ["shared-daemon", "daemon-stopping"], repositories: [], details: {}, closingCount: 0, preferences: defaultPreferences(), notice: "" };
  let probes = 0, settled = false;
  let server: Bun.Server<undefined> | undefined = Bun.serve({ unix: paths.socket, fetch: () => { probes++; return Response.json(closing); } });
  const starting = ensureSharedDaemon({ offline: true, stateRoot, entry });
  const observed = starting.then(result => { settled = true; return result; });
  try {
    // 종료 표시를 읽은 연결은 기존 프로세스를 준비된 새 소유자로 채택하지 않는다.
    await until(() => probes >= 2);
    expect(settled).toBe(false);
    await server.stop(true); server = undefined; await release();
    const started = expectOk(await observed);

    // 같은 저장 영역의 후속 소유자는 살아 있는 새 프로세스이며 기존 소유자를 종료하지 않았다.
    expect(started.pid).not.toBe(process.pid); expect(started.instance).not.toBe(closing.instance);
    expect(started.capabilities).not.toContain("daemon-stopping"); expect(pidAlive(process.pid)).toBe(true);
  } finally {
    await server?.stop(true); await release(); await observed; await stop(stateRoot); await fixture.cleanup();
  }
}, 20000);

test("손상된 공용 등록 파일은 시작 실패와 정리 과정에서도 빈 데이터로 덮어쓰지 않는다", async () => {
  // 호환되지 않는 등록 파일을 실제 데몬 진입점에 제공한다.
  const fixture = await createWorktreeFixture(), stateRoot = join(fixture.directory, "state"), paths = daemonPaths(true, stateRoot);
  const original = '{"version":99,"repositories":[]}';
  await privateDirectory(paths.directory); await writeFile(paths.manifest, original, { mode: 0o600 });
  try {
    // 시작을 거절해도 종료 정리가 원본을 새 빈 registry로 저장해서는 안 된다.
    const child = Bun.spawn([process.execPath, entry, "--runtime-service", "--test-runtime", "--state-dir", stateRoot], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

    // 안정적인 저장 오류를 보고하고 복구에 필요한 원본을 보존한다.
    expect(code).toBe(1); expect(stdout).toBe(""); expect(stderr).toContain("STORAGE_FAILED");
    expect(await readFile(paths.manifest, "utf8")).toBe(original);
    expect(expectOk(await fetchSnapshot(paths))).toBeNull();
  } finally { await fixture.cleanup(); }
}, 20000);

test("runtime restart는 Git 저장소 밖에서도 공용 프로세스를 교체하고 등록된 카탈로그를 복원한다", async () => {
  // 등록된 저장소와 무관한 cwd에서 실행할 재시작 명령을 준비한다.
  const fixture = await createWorktreeFixture(), stateRoot = join(fixture.directory, "state"), options = { offline: true, stateRoot, entry, start: false, register: true };
  const client = expectOk(await connectRuntime(fixture.repository, fixture.main, options));
  if (!client) throw new Error("Missing catalog.");
  const before = client.snapshot;
  await client.disconnect();
  try {
    // 재시작은 상태 루트와 모드로 대상을 찾으며 cwd의 Git 발견이나 UI 설정을 요구하지 않는다.
    const process = Bun.spawn([Bun.which("bun")!, entry, "runtime", "restart", "--test-runtime", "--state-dir", stateRoot],
      { cwd: fixture.directory, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);

    // 새 PID의 같은 공용 데몬에 기존 카탈로그가 복원되고 이전 프로세스는 종료된다.
    expect(code).toBe(0); expect(stderr).toBe(""); expect(stdout).toContain("Shared daemon restarted");
    await until(async () => expectOk(await fetchSnapshot(runtimePaths(fixture.repository.id, true, stateRoot))) !== null);
    const after = expectOk(await fetchSnapshot(runtimePaths(fixture.repository.id, true, stateRoot)))!;
    expect(after.pid).not.toBe(before.pid); expect(after.instance).not.toBe(before.instance);
    expect(pidAlive(before.pid)).toBe(false);
    expect(after.capabilities).toContain("repository-catalog");
    expect(after.repositories[0]!.id).toBe(fixture.repository.id);
  } finally { await stop(stateRoot); await fixture.cleanup(); }
}, 20000);
