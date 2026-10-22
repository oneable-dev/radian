import { expect, test } from "bun:test";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { WorkspaceSelection } from "../app/workspace-selection.ts";
import { connectRuntime, fetchSnapshot, RuntimeClient } from "./client.ts";
import { runtimePaths, pidAlive, privateDirectory, RuntimeStore } from "./storage.ts";
import { replySchema, type RuntimeManifest, type RuntimeSnapshot } from "./protocol.ts";
import { Value } from "typebox/value";
import { expectOk, expectError } from "../testing/results.ts";
import { initialGitState } from "../git/model.ts";

async function until(predicate: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 12000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for observed runtime state.");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}
function observed(client: RuntimeClient, predicate: (snapshot: RuntimeSnapshot) => boolean): Promise<void> {
  if (predicate(client.snapshot)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("Runtime event condition timed out.")); }, 10000);
    const unsubscribe = client.subscribe(() => {
      if (!predicate(client.snapshot)) return;
      clearTimeout(timer); unsubscribe(); resolve();
    });
  });
}
function progress(text = ""): number {
  return Math.max(0, ...[...text.matchAll(/Progress (\d+)\/40/g)].map((match) => Number(match[1])));
}
async function setup() {
  const fixture = await createWorktreeFixture();
  const options = { offline: true, stateRoot: join(fixture.directory, "state"), entry: join(import.meta.dir, "..", "index.ts") };
  const paths = runtimePaths(fixture.repository.id, true, options.stateRoot);
  const clients: RuntimeClient[] = [];
  return { ...fixture, paths, options,
    async connect(cwd = fixture.main) {
      const client = expectOk(await connectRuntime(fixture.repository, cwd, options));
      if (!client) throw new Error("Missing runtime client");
      clients.push(client); return client;
    },
    async stopped(pid: number) { await until(async () => !expectOk(await fetchSnapshot(paths)) && !pidAlive(pid)); },
    async manifest(): Promise<RuntimeManifest> { const manifest = expectOk(await new RuntimeStore(paths).load(fixture.repository.id)); if (!manifest) throw new Error("Missing runtime manifest"); return manifest; },
    async cleanup() {
      const existing = expectOk(await connectRuntime(fixture.repository, fixture.main, { ...options, start: false }));
      if (existing) {
        const pid = existing.snapshot.pid;
        await existing.stopRuntime(); await existing.disconnect(); await this.stopped(pid);
      }
      await Promise.all(clients.map((client) => client.disconnect()));
      await fixture.cleanup();
    },
  };
}

test("대시보드는 실제 Unix IPC로 닫힌 SDK 실행을 읽고 대화나 새 모델 실행을 만들지 않는다", async () => {
  // 이 테스트가 소유한 별도 offline daemon만 사용한다.
  const app = await setup();
  try {
    const client = await app.connect(), tree = client.snapshot.repositories.flatMap(repo => repo.worktrees).find(tree => tree.path === app.main)!;
    const id = expectOk(await client.create(tree.id));
    expectOk(await client.prompt(id, "read"));
    await observed(client, snapshot => !!snapshot.details[id]?.result);
    expect(expectOk(await client.catalog(id)).items.some(item => item.value === "dashboard")).toBe(true);
    expectOk(await client.closeSession(id));
    const before = client.snapshot.repositories;

    // Host 경로 허용, capability 협상, 응답 스키마와 저장 파일 집계를 함께 통과한다.
    const dashboard = expectOk(await client.dashboard(7));

    // 닫힌 실행도 남고 통계 조회는 읽기 전용이다.
    expect(dashboard.totals.runs).toBe(1); expect(dashboard.daily).toHaveLength(7); expect(dashboard.warnings).toEqual([]);
    expect(client.snapshot.repositories).toEqual(before);
  } finally { await app.cleanup(); }
});

test("중단 IPC는 대기 입력 전체를 한 메시지로 전달하고 세션·초안과 다른 실행을 유지한다", async () => {
  // This test owns an isolated daemon; interruption never targets a user runtime.
  const app = await setup();
  try {
    const client = await app.connect(), tree = app.repository.worktrees.find((item) => item.path === app.main)!;
    const id = expectOk(await client.create(tree.id)), other = expectOk(await client.create(tree.id));
    expect(client.snapshot.capabilities).toContain("agent-interrupt");
    expectOk(await client.prompt(id, "slow")); expectOk(await client.prompt(other, "slow"));
    expectOk(await client.prompt(id, "Add tests")); expectOk(await client.prompt(id, "Do not edit README"));
    await observed(client, (state) => state.details[id]?.pendingMessages?.length === 2 && state.details[other]?.status === "working");
    const conversation = client.snapshot.details[id]!.conversationId;
    expectOk(await client.savePreferences({ ...client.snapshot.preferences, drafts: { [id]: "Unsent draft" } }));

    // A delayed key intended for a replaced conversation must not interrupt the current one.
    const stale = await fetch("http://localhost/command", { unix: app.paths.socket, method: "POST", headers: { "Content-Type": "application/json", "X-Radian-Instance": client.snapshot.instance! },
      body: JSON.stringify({ type: "interrupt", sessionId: id, conversationId: "old-conversation" }) });
    expect(stale.status).toBe(409);
    expectOk(await client.interrupt(id));
    await observed(client, (state) => state.details[id]?.status === "complete" && !state.details[id]?.pendingMessages?.length);

    expect(client.snapshot.details[id]?.sections?.filter((section) => section.kind === "user").map((section) => section.text)).toEqual(["slow", "Add tests\nDo not edit README"]);
    expect(client.snapshot.details[id]?.conversationId).toBe(conversation);
    expect(client.snapshot.details[other]?.status).toBe("working");
    expect(client.snapshot.preferences.drafts[id]).toBe("Unsent draft");
    expect(client.snapshot.repositories.flatMap((repo) => repo.worktrees.flatMap((worktree) => worktree.sessions))).toHaveLength(2);
  } finally { await app.cleanup(); }
});

test("자동완성 IPC는 선택 세션의 SDK 명령과 워크트리 파일만 읽고 모델을 실행하지 않는다", async () => {
  const app = await setup();
  try {
    const extensions = join(app.paths.directory, "offline-agent", "extensions"); await mkdir(extensions, { recursive: true });
    await writeFile(join(extensions, "commands.ts"), `export default function (pi) {
      pi.registerCommand("lookup-probe", { description: "Read-only command catalog probe", handler: async () => {} });
      pi.registerCommand("lookup-broken", { handler: async () => { throw new Error("Fixture command rejected"); } });
    }`);
    await writeFile(join(app.main, "main-only.ts"), "never load this content"); await writeFile(join(app.feature, "feature-only.ts"), "other worktree");
    const client = await app.connect(); const main = app.repository.worktrees.find((tree) => tree.path === app.main)!;
    const id = expectOk(await client.create(main.id));

    expect(client.snapshot.capabilities).toContain("prompt-completion");
    const commands = expectOk(await client.complete(id, { kind: "command", query: "lookup-probe" }));
    expect(commands.items.map((item) => item.value)).toEqual(["lookup-probe"]);
    // IPC and prepared UI catalogs must enforce the same normalized prefix rule.
    expect(expectOk(await client.complete(id, { kind: "command", query: "ＬＯＯＫＵＰ－ＰＲＯＢＥ" })).items.map(item => item.value)).toEqual(["lookup-probe"]);
    expect(expectOk(await client.complete(id, { kind: "command", query: "probe" })).items).toEqual([]);
    const files = expectOk(await client.complete(id, { kind: "file", query: "only.ts" }));
    expect(files.items.map((item) => item.value)).toEqual(["main-only.ts"]);
    expectOk(await client.prompt(id, "/lookup-probe"));
    expect((await app.manifest()).records[0]?.state.output).toBe("");
    const commandError = expectError(await client.prompt(id, "/lookup-broken"));
    expect(commandError.code).toBe("AGENT_FAILED"); expect(commandError).toHaveProperty("outcome", "unknown");
    expect(commandError.message).toContain("may have changed state");

    // The read-only endpoint still validates the instance fence and its wire input.
    for (const [params, instance, code] of [[`sessionId=${id}&kind=wrong&query=`, client.snapshot.instance, "INVALID_INPUT"],
      [`sessionId=${id}&kind=file&query=`, "old-instance", "PROTOCOL_ERROR"]] as const) {
      const response = await fetch(`http://localhost/completions?${params}`, { unix: app.paths.socket, headers: { "X-Radian-Instance": instance } });
      const body = await response.json();
      if (!Value.Check(replySchema, body) || body.ok || typeof body.error === "string") throw new Error("Expected a typed completion rejection.");
      expect(body.error.code).toBe(code);
    }
    expectOk(await client.closeSession(id));
    expect(expectError(await client.complete(id, { kind: "file", query: "" })).code).toBe("SESSION_NOT_OPEN");
  } finally { await app.cleanup(); }
});

test("new IPC는 같은 워크트리에 새 탭을 추가하고 기존 대화·대기 입력·실행을 유지한다", async () => {
  const app = await setup();
  try {
    const client = await app.connect(), tree = app.repository.worktrees.find((item) => item.path === app.main)!;
    const id = expectOk(await client.create(tree.id));
    expectOk(await client.prompt(id, "slow")); expectOk(await client.prompt(id, "Queued for original"));
    await observed(client, (state) => progress(state.details[id]?.output) > 0 && state.details[id]?.pendingMessages?.length === 1);
    const conversation = client.snapshot.details[id]!.conversationId, pid = client.snapshot.pid;
    expectOk(await client.savePreferences({ ...client.snapshot.preferences, drafts: { [id]: "Unsent original draft" } }));

    const added = expectOk(await client.newTab(id));

    expect(client.snapshot.capabilities).toContain("session-tab-commands");
    expect(client.snapshot.pid).toBe(pid); expect(added).not.toBe(id);
    expect(client.snapshot.repositories[0]!.worktrees.find((item) => item.id === tree.id)!.sessions.map((session) => session.id)).toEqual([id, added]);
    expect(client.snapshot.details[id]?.conversationId).toBe(conversation);
    expect(client.snapshot.details[id]?.pendingMessages).toHaveLength(1);
    expect(client.snapshot.details[id]?.status).toBe("working"); expect(client.snapshot.details[added]?.sections).toEqual([]);
    expect(client.snapshot.preferences.drafts[id]).toBe("Unsent original draft");
    expect(expectOk(await client.listHistory(tree.id)).find((item) => item.id === conversation)?.openSessionId).toBe(id);
    // The text API must dispatch /new as tab creation too, never as a paid model prompt or reset.
    expectOk(await client.prompt(id, "/new"));
    expect(client.snapshot.repositories[0]!.worktrees.find((item) => item.id === tree.id)!.sessions).toHaveLength(3);
    expect(client.snapshot.details[id]?.conversationId).toBe(conversation);
    expect(client.snapshot.details[id]?.sections?.some((section) => section.kind === "user" && section.text === "/new")).toBe(false);
  } finally { await app.cleanup(); }
});

test("clear IPC는 현재 탭만 새 대화로 바꾸고 취소 이력·다른 실행·편집기·셸을 보존한다", async () => {
  // The fixture owns the daemon and native processes; no user runtime is stopped.
  const app = await setup();
  try {
    const client = await app.connect(), tree = app.repository.worktrees.find((item) => item.path === app.main)!;
    const id = expectOk(await client.create(tree.id)), other = expectOk(await client.create(tree.id));
    const terminal = expectOk(await client.createTerminal(tree.id, { cols: 80, rows: 24 }));
    const editor = expectOk(await client.openEditor(tree.id, { cols: 80, rows: 24 }));
    await observed(client, (state) => !!state.terminals?.some((item) => item.id === terminal) && !!state.editors?.some((item) => item.id === editor));
    const terminalPid = client.snapshot.terminals!.find((item) => item.id === terminal)!.pid;
    const editorPid = client.snapshot.editors!.find((item) => item.id === editor)!.pid;
    expectOk(await client.prompt(id, "slow")); expectOk(await client.prompt(other, "slow"));
    await observed(client, (state) => progress(state.details[id]?.output) > 0 && progress(state.details[other]?.output) > 0);
    const previous = client.snapshot.details[id]!.conversationId!, instance = client.snapshot.instance, pid = client.snapshot.pid;

    expectOk(await client.prompt(id, "/clear"));
    await observed(client, (state) => state.details[id]?.conversationId !== previous && state.details[id]?.sections?.length === 0);

    expect(client.snapshot.repositories[0]?.worktrees.find((item) => item.id === tree.id)?.sessions.map((session) => session.id)).toEqual([id, other]);
    expect(client.snapshot.pid).toBe(pid); expect(client.snapshot.instance).toBe(instance);
    expect(client.snapshot.details[other]?.status).toBe("working");
    expect(client.snapshot.terminals?.find((item) => item.id === terminal)?.pid).toBe(terminalPid);
    expect(client.snapshot.editors?.find((item) => item.id === editor)?.pid).toBe(editorPid);
    const history = expectOk(await client.listHistory(tree.id));
    expect(history.find((item) => item.id === previous)?.openSessionId).toBeNull();
    const preview = expectOk(await client.previewHistory(tree.id, previous)); expect(preview.text).toContain("slow");
    expect(preview.snapshot?.lifecycle).toBe("closed"); expect(preview.snapshot?.state.conversationId).toBe(previous);
    await until(async () => (await app.manifest()).records.find((record) => record.id === id)?.state.conversationId === client.snapshot.details[id]?.conversationId);

    // A delayed operation for the old conversation must not run in the replacement.
    for (const command of [{ type: "prompt", sessionId: id, text: "/clear" },
      { type: "prompt", sessionId: id, text: "/new" },
      { type: "prompt", sessionId: id, text: "/exit" },
      { type: "prompt", sessionId: id, conversationId: previous, text: "/exit" },
      { type: "prompt", sessionId: id, conversationId: previous, text: "stale prompt" },
      { type: "session-control", action: "clear", sessionId: id, conversationId: previous },
      { type: "session-control", action: "new-tab", sessionId: id, conversationId: previous },
      { type: "session-control", action: "exit", sessionId: id, conversationId: previous },
      { type: "session-control", action: "new", sessionId: id, conversationId: previous }]) {
      const response = await fetch("http://localhost/command", { unix: app.paths.socket, method: "POST", body: JSON.stringify(command), headers: { "X-Radian-Instance": instance } });
      const body = await response.json();
      if (!Value.Check(replySchema, body) || body.ok || typeof body.error === "string") throw new Error("Expected a typed stale-conversation rejection");
      expect(body.error.code).toBe("SESSION_CONFLICT");
    }
    expect(client.snapshot.details[id]?.sections).toEqual([]);
    // Preserve the old typed wire contract for attached clients compiled before /clear existed.
    const current = client.snapshot.details[id]!.conversationId;
    const legacy = await fetch("http://localhost/command", { unix: app.paths.socket, method: "POST", headers: { "X-Radian-Instance": instance },
      body: JSON.stringify({ type: "session-control", action: "new", sessionId: id, conversationId: current }) });
    expect(legacy.ok).toBe(true);
    await observed(client, (state) => state.details[id]?.conversationId !== current);
    expect(client.snapshot.repositories[0]!.worktrees.find((item) => item.id === tree.id)!.sessions.map((session) => session.id)).toEqual([id, other]);
  } finally { await app.cleanup(); }
});

test("exit IPC는 인수·이미지를 거절하고 마지막 탭 종료 후에도 서비스를 유지한다", async () => {
  // 실제 런타임에 하나의 빈 탭만 만들고 종료 전 입력 검증을 확인한다.
  const app = await setup();
  try {
    const client = await app.connect(), worktreeId = app.repository.worktrees[0]!.id;
    const id = expectOk(await client.create(worktreeId)), conversationId = client.snapshot.details[id]!.conversationId!;
    const pid = client.snapshot.pid, instance = client.snapshot.instance;
    for (const command of [
      { type: "prompt", sessionId: id, conversationId, text: "/exit later" },
      { type: "prompt", sessionId: id, conversationId, text: "/exit", images: ["/fixture.png"] },
      { type: "session-control", sessionId: id, conversationId, action: "exit", instructions: "later" },
    ]) {
      const response = await fetch("http://localhost/command", { unix: app.paths.socket, method: "POST", headers: { "X-Radian-Instance": instance },
        body: JSON.stringify(command) });
      const body = await response.json();
      if (!Value.Check(replySchema, body) || body.ok || typeof body.error === "string") throw new Error("Expected invalid exit rejection");
      expect(body.error.code).toBe("INVALID_INPUT");
    }
    expect(client.snapshot.repositories[0]!.worktrees[0]!.sessions.map(session => session.id)).toEqual([id]);
    expect(client.snapshot.details[id]?.sections).toEqual([]);

    // 유효한 종료 명령은 마지막 탭만 닫는다.
    expectOk(await client.prompt(id, "/exit"));
    await observed(client, state => !state.details[id] && state.closingCount === 0);

    // 빈 화면은 앱 종료가 아니며 같은 프로세스에서 새 세션을 만들 수 있다.
    expect(client.snapshot.repositories[0]!.worktrees[0]!.sessions).toEqual([]);
    const next = expectOk(await client.create(worktreeId));
    expect(next).not.toBe(id); expect(client.snapshot.pid).toBe(pid); expect(client.snapshot.instance).toBe(instance);
  } finally { await app.cleanup(); }
});

test("compact IPC의 수락은 요약 완료와 구분되고 같은 대화와 전체 transcript를 유지한다", async () => {
  const app = await setup();
  try {
    const client = await app.connect(), tree = app.repository.worktrees.find((item) => item.path === app.main)!;
    const id = expectOk(await client.create(tree.id));
    expect(expectOk(await client.complete(id, { kind: "command", query: "" })).items.map((item) => item.value)).toEqual(expect.arrayContaining(["new", "clear", "compact"]));
    // Two large turns are eligible under the SDK's default retained-tail policy.
    expectOk(await client.prompt(id, "first ".repeat(16000)));
    await observed(client, (state) => state.details[id]?.status === "complete");
    expectOk(await client.prompt(id, "second ".repeat(16000)));
    await observed(client, (state) => state.details[id]?.sections?.filter((section) => section.kind === "user").length === 2 && state.details[id]?.status === "complete");
    const previous = client.snapshot.details[id]!, conversation = previous.conversationId;

    expectOk(await client.prompt(id, "/compact preserve the current plan"));
    await observed(client, (state) => state.details[id]?.sections?.at(-1)?.title === "Context compacted");

    expect(client.snapshot.details[id]?.conversationId).toBe(conversation);
    expect(client.snapshot.details[id]?.sections?.slice(0, previous.sections!.length)).toEqual([...previous.sections!]);
    expect(client.snapshot.notice).toBe(""); expect(client.snapshot.details[id]?.status).toBe("complete");
  } finally { await app.cleanup(); }
});

test("별도 프로세스는 모든 UI가 분리된 동안에도 agent와 subagent를 진행하고 같은 실행에 재접속한다", async () => {
  // The detached Bun process owns actual SDK instances in two real Git worktrees.
  const app = await setup();
  try {
    const client = await app.connect();
    const main = app.repository.worktrees.find((tree) => tree.path === app.main)!;
    const feature = app.repository.worktrees.find((tree) => tree.path === app.feature)!;
    const a = expectOk(await client.create(main.id)); const b = expectOk(await client.create(feature.id));
    await client.prompt(a, "read");
    await observed(client, (state) => state.details[a]?.status === "complete");
    // SDK metadata survives the real process/IPC boundary without inventing provider quotas.
    expect(client.snapshot.capabilities).toContain("agent-telemetry");
    expect(client.snapshot.details[a]?.telemetry?.model).toBe("fixture");
    expect(client.snapshot.details[a]?.telemetry?.context?.maxTokens).toBe(200000);
    expect(client.snapshot.details[a]?.telemetry?.weekly).toBeNull();
    expect(client.snapshot.details[a]?.telemetry?.fast).toBeNull();
    await client.prompt(a, "slow"); await client.prompt(b, "delegate");
    await observed(client, (state) => progress(state.details[a]?.output) >= 1 && state.repositories[0]?.worktrees[1]?.sessions[0]?.subagents[0]?.status === "working");
    const pid = client.snapshot.pid; const instance = client.snapshot.instance;
    const child = client.snapshot.repositories[0]!.worktrees[1]!.sessions[0]!.subagents[0]!.id;
    const before = progress(client.snapshot.details[a]?.output);
    await client.savePreferences({ selection: { worktreeId: feature.id, sessions: { [main.id]: a, [feature.id]: b } }, drafts: { [a]: "retained draft" } });

    // No streaming UI client is connected while we observe progress through the disk checkpoint.
    await client.disconnect();
    await until(async () => progress((await app.manifest()).records.find((record) => record.id === a)?.state.output) > before);
    const reattached = await app.connect(app.feature);

    // Warm reattach restores the same process, open IDs, child, latest output and selection.
    expect(pid).not.toBe(process.pid);
    expect(reattached.snapshot.pid).toBe(pid);
    expect(reattached.snapshot.instance).toBe(instance);
    expect(reattached.snapshot.details[a]?.status).toBe("working");
    expect(reattached.snapshot.repositories[0]!.worktrees[1]!.sessions[0]!.subagents[0]?.id).toBe(child);
    expect(reattached.snapshot.preferences.drafts[a]).toBe("retained draft");
    const selection = new WorkspaceSelection(reattached.snapshot.repositories);
    selection.restore(reattached.snapshot.preferences.selection);
    expect(selection.sessionId).toBe(b);
    selection.selectWorktree(main.id); expect(selection.sessionId).toBe(a);
    expect((await stat(app.paths.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(app.paths.socket)).mode & 0o777).toBe(0o600);
  } finally { await app.cleanup(); }
}, 20000);

test("31초 유휴 상태에도 이벤트 연결을 유지하고 같은 서비스에서 history와 새 명령을 처리한다", async () => {
  // An isolated SDK service must keep its subscription even when no state changes are emitted.
  const app = await setup();
  try {
    const client = await app.connect();
    const worktree = app.repository.worktrees[0]!.id;
    const id = expectOk(await client.create(worktree));
    expectOk(await client.prompt(id, "read"));
    await observed(client, (state) => state.details[id]?.status === "complete");
    const instance = client.snapshot.instance;
    const notices: string[] = [];
    const unsubscribe = client.subscribe(() => { if (client.snapshot.notice) notices.push(client.snapshot.notice); });

    // Real elapsed time is intentional: mocked timers cannot exercise Bun's native socket idle timeout.
    await Bun.sleep(31000);
    unsubscribe();

    // Reconnection must not mask an incorrectly configured idle stream; no failure should occur at all.
    expect(notices).toEqual([]);
    expect(client.snapshot.notice).toBe("");
    expect(client.snapshot.instance).toBe(instance);
    expect(expectOk(await client.listHistory(worktree))).toHaveLength(1);
    const next = expectOk(await client.create(worktree));
    await observed(client, (state) => !!state.details[next]);
    expect(client.snapshot.repositories[0]!.worktrees[0]!.sessions.map((session) => session.id)).toEqual([id, next]);
  } finally { await app.cleanup(); }
}, 45000);

test.each(["close", "exit", "raw-exit"] as const)("%s IPC 닫기는 소속 자식만 취소하며 다른 세션과 저장 기록은 유지한다", async (action) => {
  // Parent/child and an unrelated slow run coexist in one detached SDK service.
  const app = await setup();
  try {
    const client = await app.connect();
    const parent = expectOk(await client.create(app.repository.worktrees[0]!.id));
    const other = expectOk(await client.create(app.repository.worktrees[1]!.id));
    await client.prompt(parent, "delegate"); await client.prompt(other, "slow");
    await observed(client, (state) => !!state.repositories[0]?.worktrees[0]?.sessions[0]?.subagents[0] && progress(state.details[other]?.output) >= 1);
    await until(async () => !!(await app.manifest()).records.find((record) => record.id === parent)?.sessionFile);
    const file = (await app.manifest()).records.find((record) => record.id === parent)!.sessionFile!;
    const conversation = client.snapshot.details[parent]!.conversationId!, pid = client.snapshot.pid, instance = client.snapshot.instance;
    expect(client.snapshot.capabilities).toContain("session-exit");
    expect(expectOk(await client.complete(parent, { kind: "command", query: "exit" })).items.map(item => item.value)).toEqual(["exit"]);

    // Both typed controls and raw prompts reuse the close button's lifecycle.
    if (action === "close") {
      const closing = client.closeSession(parent);
      expect(client.snapshot.repositories[0]!.worktrees[0]!.sessions).toEqual([]);
      expectOk(await closing);
    } else if (action === "exit") expectOk(await client.prompt(parent, "/exit"));
    else {
      const response = await fetch("http://localhost/command", { unix: app.paths.socket, method: "POST", headers: { "X-Radian-Instance": instance },
        body: JSON.stringify({ type: "prompt", sessionId: parent, conversationId: conversation, text: "/exit" }) });
      expect(response.ok).toBe(true);
    }
    await observed(client, (state) => !state.details[parent] && state.closingCount === 0);

    // Explicit close cancels its family, unlike detaching a UI, and does not erase conversation files.
    expect(client.snapshot.details[other]?.status).toBe("working");
    expect(client.snapshot.pid).toBe(pid); expect(client.snapshot.instance).toBe(instance);
    expect(client.snapshot.repositories[0]!.worktrees[0]!.sessions).toEqual([]);
    expect(await Bun.file(file).exists()).toBe(true);
    const worktreeId = app.repository.worktrees[0]!.id;
    expect(expectOk(await client.listHistory(worktreeId)).find(item => item.id === conversation)?.openSessionId).toBeNull();
    expect(expectOk(await client.previewHistory(worktreeId, conversation)).text).not.toContain("/exit");
    expect((await app.manifest()).records.map((record) => record.id)).toEqual([other]);
  } finally { await app.cleanup(); }
}, 20000);

test("서비스 종료 후 재시작은 열린 ID와 기록·선택을 복원하되 중단된 실행을 자동 재전송하지 않는다", async () => {
  // Finalized history, an unused item, and an in-flight response all need different recovery handling.
  const app = await setup();
  try {
    const client = await app.connect();
    const a = expectOk(await client.create(app.repository.worktrees[0]!.id));
    const empty = expectOk(await client.create(app.repository.worktrees[0]!.id));
    const running = expectOk(await client.create(app.repository.worktrees[1]!.id));
    await client.prompt(a, "read"); await observed(client, (state) => state.details[a]?.status === "complete");
    await client.prompt(running, "slow"); await observed(client, (state) => progress(state.details[running]?.output) >= 1);
    await client.savePreferences({ selection: { worktreeId: app.repository.worktrees[1]!.id, sessions: { [app.repository.worktrees[1]!.id]: running } }, drafts: {} });
    const pid = client.snapshot.pid; const instance = client.snapshot.instance;
    const file = (await app.manifest()).records.find((record) => record.id === a)!.sessionFile!;

    // This explicitly stops the service; ordinary TUI Ctrl+C never calls this command.
    await client.stopRuntime(); await client.disconnect(); await app.stopped(pid);
    const restored = await app.connect();

    // A new service restores the same conversations, not forks or automatic model/tool retries.
    expect(restored.snapshot.instance).not.toBe(instance);
    expect(restored.snapshot.repositories.flatMap((repo) => repo.worktrees.flatMap((tree) => tree.sessions.map((session) => session.id)))).toEqual([a, empty, running]);
    expect(restored.snapshot.details[a]?.output).toContain("main-worktree-marker");
    expect(restored.snapshot.details[running]?.status).toBeNull();
    expect(restored.snapshot.details[running]?.error).toContain("Previous runtime ended");
    expect(restored.snapshot.preferences.selection.sessions[app.repository.worktrees[1]!.id]).toBe(running);
    expect((await app.manifest()).records.find((record) => record.id === a)?.sessionFile).toBe(file);
    await restored.prompt(a, "read"); await observed(restored, (state) => state.details[a]?.status === "complete");
  } finally { await app.cleanup(); }
}, 20000);

test("명시적으로 교체한 서비스에 기존 클라이언트가 재접속하며 저장 대화와 명령을 재실행하지 않는다", async () => {
  // Only a test-owned daemon is restarted; the first UI client remains mounted throughout.
  const app = await setup();
  try {
    const client = await app.connect();
    const worktree = app.repository.worktrees[0]!.id;
    const id = expectOk(await client.create(worktree));
    expectOk(await client.prompt(id, "read"));
    await observed(client, (state) => state.details[id]?.status === "complete");
    const file = (await app.manifest()).records.find((record) => record.id === id)!.sessionFile!;
    const original = await readFile(file, "utf8");
    const pid = client.snapshot.pid;

    // Service startup is explicit, not something the disconnected subscriber does automatically.
    expectOk(await client.stopRuntime()); await app.stopped(pid);
    await until(() => !client.connected);
    expect(expectError(await client.prompt(id, "must not run")).code).toBe("CONNECTION_FAILED");
    const replacement = await app.connect();
    await observed(client, (state) => client.connected && state.instance === replacement.snapshot.instance);

    // Fresh history/capabilities and the same conversation are available without another UI launch.
    expect(client.snapshot.pid).not.toBe(pid);
    expect(client.snapshot.details[id]?.output).toContain("main-worktree-marker");
    expect(expectOk(await client.listHistory(worktree))[0]?.openSessionId).toBe(id);
    expect(await readFile(file, "utf8")).toBe(original);
    expect(client.snapshot.repositories[0]!.worktrees[0]!.sessions.map((session) => session.id)).toEqual([id]);
  } finally { await app.cleanup(); }
}, 20000);

test("runtime 구독만 끊겨도 실제 쉘을 유지하며 이전 PTY를 닫고 명시적으로 다시 연결할 수 있다", async () => {
  // A test-owned Unix relay ends only /events; it does not restart or stop the daemon/shell.
  const app = await setup();
  const relayPaths = runtimePaths(app.repository.id, true, join(app.directory, "relay"));
  let relay: ReturnType<typeof Bun.serve> | undefined;
  let client: RuntimeClient | undefined;
  let drop: (() => void) | undefined;
  const commands: string[] = [];
  try {
    const owner = await app.connect();
    const id = expectOk(await owner.createTerminal(app.repository.worktrees[0]!.id, { cols: 80, rows: 12 }));
    const shell = owner.snapshot.terminals!.find((item) => item.id === id)!;
    relay = Bun.serve({ unix: relayPaths.socket, async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = request.method === "POST" ? await request.text() : undefined;
      if (body) commands.push((JSON.parse(body) as { type: string }).type);
      const response = await fetch(request.url, { unix: owner.paths.socket, method: request.method, headers: request.headers, signal: request.signal,
        ...(body !== undefined ? { body } : {}) });
      if (path !== "/events" || !response.body) return response;
      const reader = response.body.getReader(); let closed = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          drop = () => { if (!closed) { closed = true; controller.close(); void reader.cancel(); } };
          void (async () => {
            try {
              while (!closed) { const chunk = await reader.read(); if (chunk.done) break; if (!closed) controller.enqueue(chunk.value); }
              if (!closed) { closed = true; controller.close(); }
            } catch (error) { if (!closed) { closed = true; controller.error(error); } }
          })();
        },
        async cancel() { closed = true; await reader.cancel(); },
      });
      return new Response(stream, { headers: response.headers });
    } });
    client = new RuntimeClient(relayPaths, owner.snapshot); expectOk(await client.attach());
    const failures: unknown[] = [];
    const old = expectOk(await client.attachTerminal(id, () => {}, (error) => failures.push(error)));

    drop!(); await until(() => !client!.connected); await until(() => client!.connected);
    await old.closed;
    expect(commands).toEqual([]); expect(failures).toHaveLength(1);
    expect(client.snapshot.terminals!.find((item) => item.id === id)!.shellPid).toBe(shell.shellPid);
    expect(pidAlive(shell.shellPid)).toBe(true);
    const fresh = expectOk(await client.attachTerminal(id, () => {}, () => {}));
    expect(fresh.lease).not.toBe(old.lease);
  } finally { await client?.disconnect(); await relay?.stop(true); await rm(relayPaths.socket, { force: true }); await app.cleanup(); }
}, 20000);

test("이전 runtime instance에 대한 명령과 PTY attach는 실행 전에 거절하고 이전 클라이언트는 계속 지원한다", async () => {
  // A replacement endpoint must not accept delayed mutation requests for the previous owner.
  const app = await setup();
  try {
    const client = await app.connect();
    const command = { type: "create", worktreeId: app.repository.worktrees[0]!.id };
    const response = await fetch("http://localhost/command", { unix: client.paths.socket, method: "POST",
      headers: { "X-Radian-Instance": "stale-instance" }, body: JSON.stringify(command) });
    expect(response.status).toBe(422);
    const rejected = await response.json();
    if (!Value.Check(replySchema, rejected) || rejected.ok || typeof rejected.error === "string") throw new Error("Expected a typed rejection.");
    expect(rejected.error.code).toBe("PROTOCOL_ERROR");
    expect(rejected.error.message).toContain("No action was accepted");
    const pty = await fetch("http://localhost/terminal/events?id=missing&lease=stale", { unix: client.paths.socket, headers: { "X-Radian-Instance": "stale-instance" } });
    expect(pty.status).toBe(422);
    expect(expectOk(await fetchSnapshot(client.paths))!.repositories[0]!.worktrees[0]!.sessions).toEqual([]);

    // The optional fencing header does not remove the existing v1 command contract.
    const legacy = await fetch("http://localhost/command", { unix: client.paths.socket, method: "POST", body: JSON.stringify(command) });
    const accepted = await legacy.json();
    expect(legacy.status).toBe(200); expect(Value.Check(replySchema, accepted) && accepted.ok).toBe(true);
  } finally { await app.cleanup(); }
});

test("동시에 접속해도 데몬 하나만 실행되고 강제 종료 후 stale endpoint를 회수한다", async () => {
  // Simultaneous clients exercise real process/endpoint ownership, not an in-memory singleton.
  const app = await setup();
  try {
    const clients = await Promise.all([app.connect(), app.connect(), app.connect(app.feature)]);
    const pid = clients[0]!.snapshot.pid;
    expect(new Set(clients.map((client) => client.snapshot.pid)).size).toBe(1);
    const id = expectOk(await clients[0]!.create(app.repository.worktrees[0]!.id));
    await clients[0]!.prompt(id, "read"); await observed(clients[0]!, (state) => state.details[id]?.status === "complete");
    await until(async () => (await app.manifest()).records.some((record) => record.id === id));

    // Killing this test-owned idle service leaves a stale socket/lock but no live tool subprocess.
    process.kill(pid, "SIGKILL"); await until(() => !pidAlive(pid));
    await Promise.all(clients.map((client) => client.disconnect()));
    const reconnected = await Promise.all([app.connect(), app.connect(app.feature)]);
    const recovered = reconnected[0]!;
    expect(new Set(reconnected.map((client) => client.snapshot.pid)).size).toBe(1);

    // Dead-owner recovery preserves the saved open item while acquiring a new process owner.
    expect(recovered.snapshot.pid).not.toBe(pid);
    expect(recovered.snapshot.details[id]?.output).toContain("main-worktree-marker");
  } finally { await app.cleanup(); }
}, 20000);

test.each(["close", "exit"] as const)("%s: 손상된 저장 기록은 덮어쓰지 않고 복원 오류를 표시하며 명시적으로 닫을 수 있다", async (action) => {
  // The corrupted file belongs only to this isolated SDK fixture.
  const app = await setup();
  try {
    const client = await app.connect();
    const id = expectOk(await client.create(app.repository.worktrees[0]!.id));
    await client.prompt(id, "read"); await observed(client, (state) => state.details[id]?.status === "complete");
    const file = (await app.manifest()).records.find((record) => record.id === id)!.sessionFile!;
    const pid = client.snapshot.pid;
    await client.stopRuntime(); await client.disconnect(); await app.stopped(pid);
    await writeFile(file, "corrupt conversation\n");

    // Restart reports the failure but retains the open item for an explicit user decision.
    const restored = await app.connect();

    // No empty history, cloned context or automatic prompt replaces the original bytes.
    expect(restored.snapshot.details[id]?.status).toBe("failure");
    expect(restored.snapshot.details[id]?.error).toContain("Could not restore");
    expect(await readFile(file, "utf8")).toBe("corrupt conversation\n");
    expectOk(await (action === "exit" ? restored.prompt(id, "/exit") : restored.closeSession(id)));
    await observed(restored, (state) => !state.details[id]);
    expect(await readFile(file, "utf8")).toBe("corrupt conversation\n");
  } finally { await app.cleanup(); }
}, 20000);

test("공유 스냅샷의 닫힌 대화는 SDK 파일 없이도 미리보기만 제공하고 재실행하지 않는다", async () => {
  // 복구와 미리보기가 같은 저장 형식을 읽는지 실제 IPC 경계에서 확인한다.
  const app = await setup();
  try {
    await privateDirectory(app.paths.directory);
    const tree = app.repository.worktrees[0]!, store = new RuntimeStore(app.paths);
    const archived = { id: "archived-tab", name: "Archived task", worktreeId: tree.id, cwd: tree.path, lifecycle: "closed" as const,
      sessionFile: join(tree.path, "missing-conversation.jsonl"), updatedAt: 1000,
      state: { conversationId: "archived-conversation", status: "failure" as const, error: "Saved failure", output: "Stored output",
        sections: Array.from({ length: 20 }, (_, index) => ({ id: `s${index}`, kind: "assistant" as const, title: "Agent", text: `Stored section ${index}`, status: "complete" as const })),
        telemetry: { provider: "fixture", model: "archived-model", effort: "high", fast: true, context: { usedTokens: 72000, maxTokens: 200000 }, weekly: null } }, subagents: [] };
    expectOk(await store.save({ version: 1, repositoryId: app.repository.id, repositories: [app.repository], records: [archived], preferences: { selection: { worktreeId: tree.id, sessions: {} }, drafts: {} } }));

    // 서비스 시작과 History 조회는 닫힌 대화의 executor나 SDK writer를 만들지 않는다.
    const client = await app.connect(), items = expectOk(await client.listHistory(tree.id));
    const preview = expectOk(await client.previewHistory(tree.id, "archived-conversation"));

    // 최근 섹션 제한만 적용하고 저장된 실행 상태와 telemetry는 그대로 전달한다.
    expect(client.snapshot.details).toEqual({}); expect(items.map(item => item.id)).toEqual(["archived-conversation"]);
    expect(preview.snapshot?.lifecycle).toBe("closed"); expect(preview.snapshot?.state.status).toBe("failure");
    expect(preview.snapshot?.state.error).toBe("Saved failure"); expect(preview.telemetry).toEqual(archived.state.telemetry);
    expect(preview.snapshot?.state.sections).toHaveLength(15); expect(preview.snapshot?.state.sections?.[0]?.text).toBe("Stored section 5");
    expect(preview.snapshot?.state.sections?.at(-1)?.text).toBe("Stored section 19");
    expect(expectError(await client.resume(tree.id, "archived-conversation")).code).toBe("HISTORY_UNAVAILABLE");
    expect(await Bun.file(archived.sessionFile).exists()).toBe(false);
  } finally { await app.cleanup(); }
});

test("스냅샷이 없는 외부 SDK 대화만 JSONL로 미리보기를 구성하고 원본은 바꾸지 않는다", async () => {
  // 공유 스냅샷 도입 전에 만들어진 대화도 계속 읽을 수 있어야 한다.
  const app = await setup();
  try {
    const client = await app.connect(), tree = app.repository.worktrees[0]!;
    const directory = join(app.paths.directory, "offline-agent", "sessions"), file = join(directory, "external.jsonl");
    await mkdir(directory, { recursive: true });
    const timestamp = new Date().toISOString();
    const bytes = [
      { type: "session", version: 3, id: "external", cwd: tree.path, timestamp },
      { type: "message", id: "q", parentId: null, timestamp, message: { role: "user", content: "External question" } },
      { type: "message", id: "a", parentId: "q", timestamp, message: { role: "assistant", content: [{ type: "text", text: "External answer" }], provider: "radian-offline", model: "fixture" } },
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n";
    await writeFile(file, bytes);

    // History를 탐색할 뿐 SDK executor나 새로운 공유 스냅샷은 만들지 않는다.
    expect(expectOk(await client.listHistory(tree.id)).map(item => item.id)).toEqual(["external"]);
    const preview = expectOk(await client.previewHistory(tree.id, "external"));

    // 동일 renderer에 전달할 섹션만 복원하고 새 대화나 파일을 추가하지 않는다.
    expect(preview.snapshot).toBeUndefined(); expect(preview.sections?.map(section => section.text)).toEqual(["External question", "External answer"]);
    expect(client.snapshot.details).toEqual({}); expect(await readFile(file, "utf8")).toBe(bytes);
    const store = new RuntimeStore(app.paths); expectOk(await store.load(app.repository.id)); expect(store.listSessions(tree.id)).toEqual([]);
  } finally { await app.cleanup(); }
});

test("서비스 재시작은 열린 세션만 복구하고 닫힌 대화의 같은 스냅샷을 History에 유지한다", async () => {
  // 실제 SDK 대화와 다른 열린 탭을 만들어 복구 대상 필터링을 검증한다.
  const app = await setup();
  try {
    const client = await app.connect(), tree = app.repository.worktrees[0]!;
    const closed = expectOk(await client.create(tree.id)), open = expectOk(await client.create(tree.id));
    expectOk(await client.prompt(closed, "read")); await observed(client, state => state.details[closed]?.status === "complete");
    const before = client.snapshot.details[closed]!, conversation = before.conversationId!;

    // 명시적으로 닫힌 세션의 저장이 끝난 뒤 런타임을 완전히 재시작한다.
    expectOk(await client.closeSession(closed)); await observed(client, state => !state.details[closed] && state.closingCount === 0);
    const pid = client.snapshot.pid; expectOk(await client.stopRuntime()); await client.disconnect(); await app.stopped(pid);
    const restored = await app.connect(), preview = expectOk(await restored.previewHistory(tree.id, conversation));

    // 닫힌 실행은 생성되지 않고 저장된 상태줄과 대화는 preview에서만 읽힌다.
    expect(Object.keys(restored.snapshot.details)).toEqual([open]);
    expect(preview.snapshot?.lifecycle).toBe("closed"); expect(preview.telemetry).toEqual(before.telemetry);
    expect(preview.snapshot?.state.sections).toEqual(before.sections);
    expect(expectOk(await restored.listHistory(tree.id)).find(item => item.id === conversation)?.openSessionId).toBeNull();
    const reopened = expectOk(await restored.resume(tree.id, conversation));
    expect(reopened).not.toBe(closed); expect(restored.snapshot.details[reopened]?.conversationId).toBe(conversation);
    const snapshots = new RuntimeStore(app.paths); expectOk(await snapshots.load(app.repository.id));
    expect(snapshots.listSessions(tree.id).filter(item => item.conversationId === conversation)).toHaveLength(1);
    expect(snapshots.listSessions(tree.id).find(item => item.conversationId === conversation)?.lifecycle).toBe("open");
  } finally { await app.cleanup(); }
});

test("IPC history는 워크트리별 SDK 기록을 열고 이미 열린 saved ID는 기존 항목을 반환한다", async () => {
  // The real daemon discovers saved SDK files in a shared offline history directory.
  const app = await setup();
  try {
    const client = await app.connect();
    const main = app.repository.worktrees[0]!.id; const feature = app.repository.worktrees[1]!.id;
    const a = expectOk(await client.create(main)); const b = expectOk(await client.create(feature));
    await client.prompt(a, "read"); await client.prompt(b, "write");
    await observed(client, (state) => state.details[a]?.status === "complete" && state.details[b]?.status === "complete");
    const saved = expectOk(await client.listHistory(main))[0]!;
    const file = (await app.manifest()).records.find((record) => record.id === a)!.sessionFile!;

    // Preview is a separate read-only, instance-fenced route and must preserve the active runtime/file.
    let bytes = await readFile(file, "utf8"); const count = Object.keys(client.snapshot.details).length;
    const preview = expectOk(await client.previewHistory(main, saved.id));
    expect(preview.sections?.[0]).toMatchObject({ kind: "user", text: "read" });
    expect(preview.sections!.length).toBeLessThanOrEqual(15); expect(preview.text).toContain("read");
    expect(preview.telemetry).toEqual(client.snapshot.details[a]?.telemetry);
    expect(client.snapshot.capabilities).toContain("run-completion");
    expect(preview.sections?.at(-1)?.completion).toEqual(client.snapshot.details[a]?.sections?.at(-1)?.completion);
    expect(preview.sections?.at(-1)?.completion?.outcome).toBe("complete");
    expect(Object.keys(client.snapshot.details)).toHaveLength(count); expect(await readFile(file, "utf8")).toBe(bytes);
    expect(expectError(await client.previewHistory(feature, saved.id)).code).toBe("HISTORY_UNAVAILABLE");
    for (const instance of [undefined, "obsolete"]) {
      const response = await fetch(`http://localhost/history/preview?${new URLSearchParams({ worktreeId: main, savedId: saved.id })}`, {
        unix: app.paths.socket, ...(instance ? { headers: { "X-Radian-Instance": instance } } : {}),
      });
      expect(response.status).toBe(422); await response.body?.cancel();
    }

    // Existing and closed histories both use the resume boundary, never SDK switch/fork.
    expect(expectOk(await client.resume(main, saved.id))).toBe(a);
    await client.closeSession(a); await observed(client, (state) => state.closingCount === 0 && !state.details[a]);
    // Extend only this closed fixture-owned file; a large SDK custom entry must not disable IPC preview.
    const leaf = JSON.parse(bytes.trimEnd().split("\n").at(-1)!).id;
    await appendFile(file, JSON.stringify({ type: "custom", id: "large-history-preview", parentId: leaf, timestamp: new Date().toISOString(),
      customType: "preview-size-fixture", data: "x".repeat(5 * 1024 * 1024) }) + "\n");
    bytes = await readFile(file, "utf8");
    const largePreview = expectOk(await client.previewHistory(main, saved.id));
    expect(largePreview.text).toContain("read"); expect(largePreview.sections!.length).toBeLessThanOrEqual(15);
    expect(largePreview.sections?.at(-1)?.completion).toEqual(preview.sections?.at(-1)?.completion);
    expect(client.snapshot.details[a]).toBeUndefined(); expect(await readFile(file, "utf8")).toBe(bytes);
    const reopened = expectOk(await client.resume(main, saved.id));

    // The same file/context appears as another open item, and cross-worktree IDs stay rejected.
    expect(reopened).not.toBe(a);
    expect(client.snapshot.details[reopened]?.output).toContain("main-worktree-marker");
    expect((await app.manifest()).records.find((record) => record.id === reopened)?.sessionFile).toBe(file);
    expect(expectOk(await client.listHistory(main))).toHaveLength(1);
    expect(expectOk(await client.listHistory(feature))[0]?.title).toBe("write");
    expect(expectError(await client.resume(feature, saved.id)).code).toBe("HISTORY_UNAVAILABLE");
  } finally { await app.cleanup(); }
}, 20000);

test("현재 실행 중인 subagent의 저장 파일은 history로 중복 실행하지 않는다", async () => {
  // A child is an owned writer even though its file is a valid SDK saved conversation.
  const app = await setup();
  try {
    const client = await app.connect(); const main = app.repository.worktrees[0]!.id;
    const id = expectOk(await client.create(main)); expectOk(await client.prompt(id, "delegate"));
    await observed(client, (state) => state.repositories[0]?.worktrees[0]?.sessions[0]?.subagents[0]?.status === "working");
    let childId: string | undefined;
    await until(async () => { childId = expectOk(await client.listHistory(main)).find((entry) => entry.title === "slow")?.id; return !!childId; });

    // A history request cannot turn an active owned child into a second independent writer.
    const item = expectOk(await client.listHistory(main)).find((entry) => entry.id === childId)!;
    expect(expectError(await client.resume(main, childId!)).code).toBe("SESSION_CONFLICT");

    // Parent ownership and the single open-session item are unchanged.
    expect(item.unavailableReason).toContain("active subagent");
    expect(client.snapshot.repositories[0]!.worktrees[0]!.sessions.map((session) => session.id)).toEqual([id]);
  } finally { await app.cleanup(); }
}, 20000);

test("Git preference는 실제 runtime 재접속과 구형 preference 저장에도 보존된다", async () => {
  // The detached runtime owns the warm-reconnect state; UI caches are not enough.
  const app = await setup();
  try {
    const client = await app.connect(), worktreeId = app.repository.worktrees[0]!.id;
    const state = { ...initialGitState(), selected: "a".repeat(40), file: "commit:src/file.ts", diff: true, diffScroll: 42 };

    expectOk(await client.savePreferences({ ...client.snapshot.preferences, gitViews: { [worktreeId]: state } }));
    await observed(client, (snapshot) => snapshot.preferences.gitViews?.[worktreeId]?.diffScroll === 42);
    await client.disconnect();
    const reattached = await app.connect();
    expect(reattached.snapshot.preferences.gitViews?.[worktreeId]).toEqual(state);
    const legacy = { ...reattached.snapshot.preferences }; delete legacy.gitViews;
    expectOk(await reattached.savePreferences(legacy));
    const later = await app.connect();

    expect(later.snapshot.preferences.gitViews?.[worktreeId]).toEqual(state);
    expect((await app.manifest()).preferences.gitViews?.[worktreeId]).toEqual(state);
  } finally { await app.cleanup(); }
}, 20000);

test("실행 수락 후 checkpoint 저장 실패는 거절 응답이 아니라 성공과 저장 경고로 반환한다", async () => {
  // Only this fixture's manifest is replaced with an unwritable target; user state is untouched.
  const app = await setup();
  let damaged = false;
  try {
    const client = await app.connect();
    const id = expectOk(await client.create(app.repository.worktrees[0]!.id));
    await rename(app.paths.manifest, app.paths.manifest + ".backup");
    await mkdir(app.paths.manifest); damaged = true;

    // A real SDK stream begins while the following atomic checkpoint encounters EISDIR.
    const response = await fetch("http://localhost/command", { unix: app.paths.socket, method: "POST",
      body: JSON.stringify({ type: "prompt", sessionId: id, text: "slow" }) });
    const reply = await response.json();
    await observed(client, (state) => progress(state.details[id]?.output) >= 1);

    // The caller is not told to retry an already running operation; durability loss is explicit.
    expect(response.status).toBe(200);
    if (!Value.Check(replySchema, reply) || !reply.ok) throw new Error("Expected a valid accepted reply.");
    expect(reply.ok).toBe(true);
    expect(reply.warnings?.[0]?.code).toBe("STORAGE_FAILED");
    expect(client.snapshot.details[id]?.status).toBe("working");
    expect(client.snapshot.notice).toContain("persistence failed");
    // A second submission is accepted into Pi's queue even while the run continues.
    expectOk(await client.prompt(id, "read"));
    expect(client.snapshot.details[id]?.status).toBe("working");
  } finally {
    if (damaged) { await rm(app.paths.manifest, { recursive: true }); await rename(app.paths.manifest + ".backup", app.paths.manifest); }
    await app.cleanup();
  }
}, 20000);
