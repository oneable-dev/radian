import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionError, InputError, StorageError } from "../errors.ts";
import { ok, err } from "../result.ts";
import { expectError, expectOk } from "../testing/results.ts";
import type { Repository } from "../workspace/model.ts";
import { defaultPreferences } from "./client.ts";
import type { RuntimePreferences, RuntimeSnapshot } from "./protocol.ts";
import { WorkspaceClient, type RepositoryClient } from "./workspace-client.ts";
import { privateDirectory, RuntimeStore, runtimePaths } from "./storage.ts";

function repo(id: string): Repository {
  return { id: `/fixture/${id}/.git`, name: id, worktrees: [{ id, path: `/fixture/${id}`, name: id, branch: "main", sessions: [] }] };
}
function peer(repository: Repository) {
  const id = repository.worktrees[0]!.id;
  let connected = true;
  let state: RuntimeSnapshot = { version: 1, pid: process.pid, instance: id, repositoryId: repository.id, mode: "offline", repositories: [repository],
    details: {}, preferences: defaultPreferences(), closingCount: 0, notice: "" };
  const listeners = new Set<() => void>(), calls: string[] = [], saved: RuntimePreferences[] = [];
  let failSave = false;
  let saveGate: Promise<void> = Promise.resolve();
  const call = async <T>(name: string, value: T) => { calls.push(name); return ok(value); };
  const client: RepositoryClient = {
    get snapshot() { return state; }, get connected() { return connected; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    create: (tree) => call(`create:${tree}`, `${id}-new`), newTab: (session) => call(`new-tab:${session}`, `${id}-sibling`),
    resume: (tree) => call(`resume:${tree}`, `${id}-resumed`),
    prompt: (session, text) => call(`prompt:${session}:${text}`, undefined), complete: (session) => call(`complete:${session}`, { items: [], truncated: false }),
    interrupt: (session) => call(`interrupt:${session}`, undefined),
    closeSession: (session) => call(`close:${session}`, undefined), listHistory: (tree) => call(`history:${tree}`, []),
    previewHistory: (tree, savedId) => call(`preview:${tree}:${savedId}`, { id: savedId, worktreeId: tree, text: "Read-only preview", truncated: false }),
    openEditor: (tree) => call(`editor:${tree}`, `${id}-editor`), createTerminal: (tree) => call(`terminal:${tree}`, `${id}-terminal`),
    attachEditor: async (pty) => { calls.push(`attach-editor:${pty}`); return err(new InputError("Fixture has no native editor.")); },
    attachTerminal: async (pty) => { calls.push(`attach-terminal:${pty}`); return err(new InputError("Fixture has no native terminal.")); },
    closeTerminal: (pty) => call(`close-terminal:${pty}`, undefined),
    savePreferences: async (preferences) => { saved.push(structuredClone(preferences)); await saveGate; return failSave ? err(new StorageError("Fixture disk is full.", "ENOSPC")) : ok(undefined); },
    beginDetach() { calls.push("begin-detach"); }, async disconnect() { calls.push("disconnect"); },
  };
  return { client, calls, saved, failSave() { failSave = true; }, gateSaving(promise: Promise<void>) { saveGate = promise; },
    update(snapshot: RuntimeSnapshot) { state = snapshot; for (const listener of listeners) listener(); },
    connection(value: boolean) { connected = value; for (const listener of listeners) listener(); } };
}

async function isolated(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "radian-workspace-client-"));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("newTab은 원래 세션의 레포에만 생성하고 새 ID의 소유권도 보존한다", () => isolated(async (stateRoot) => {
  const a = repo("a"), b = repo("b"), pa = peer(a), pb = peer(b);
  const workspace = expectOk(await WorkspaceClient.open([a, b], b.worktrees[0]!.path, { stateRoot, offline: true }, async (repository) => ok(repository.id === a.id ? pa.client : pb.client)));
  try {
    const original = expectOk(await workspace.create("a"));
    const added = expectOk(await workspace.newTab(original));
    expect(added).toBe("a-sibling"); expect(pa.calls).toContain(`new-tab:${original}`); expect(pb.calls).toEqual([]);
    expectOk(await workspace.closeSession(added)); expect(pa.calls).toContain("close:a-sibling");
    expect(expectError(await workspace.newTab("missing")).code).toBe("SESSION_NOT_OPEN");
  } finally { await workspace.disconnect(); }
}));

test("history 미리보기는 워크트리 소유 런타임으로만 전달하고 취소 시 실행하지 않는다", () => isolated(async (stateRoot) => {
  // A workspace combines two already-connected peers without merging their saved-session identities.
  const a = repo("a"), b = repo("b"), pa = peer(a), pb = peer(b);
  const workspace = expectOk(await WorkspaceClient.open([a, b], b.worktrees[0]!.path, { stateRoot, offline: true }, async (repository) => ok(repository.id === a.id ? pa.client : pb.client)));
  try {
    expect(expectOk(await workspace.previewHistory("b", "saved-b")).worktreeId).toBe("b");
    expect(pb.calls).toContain("preview:b:saved-b"); expect(pa.calls).not.toContain("preview:b:saved-b");
    const abort = new AbortController(); abort.abort();
    expect(expectError(await workspace.previewHistory("a", "saved-a", abort.signal)).code).toBe("CANCELLED");
    expect(pa.calls.some((call) => call.startsWith("preview:"))).toBe(false);
    expect(expectError(await workspace.previewHistory("unknown", "saved")).code).toBe("INVALID_INPUT");
    expect([...pa.calls, ...pb.calls].some((call) => call.startsWith("create:") || call.startsWith("prompt:"))).toBe(false);
  } finally { await workspace.disconnect(); }
}));

test("모든 레포를 표시하되 최초 선택과 동시 작업 요청은 소유 런타임 하나만 지연 시작한다", () => isolated(async (stateRoot) => {
  // 탐색된 레포들은 보이지만 아직 어떤 데몬도 실행되지 않았다.
  const a = repo("a"), b = repo("b"), pa = peer(a), pb = peer(b);
  const started: string[] = [];
  const ready = Promise.withResolvers<void>();
  const workspace = expectOk(await WorkspaceClient.open([a, b], b.worktrees[0]!.path, { stateRoot, offline: true }, async (repository, _cwd, options) => {
    if (!options.start) return ok(null);
    started.push(repository.name); await ready.promise;
    return ok(repository.id === a.id ? pa.client : pb.client);
  }));
  try {
    expect(workspace.snapshot.repositories).toEqual([a, b]);
    expect(workspace.snapshot.preferences.selection.worktreeId).toBe("b");
    expect(started).toEqual([]);

    // 같은 레포의 선택/생성은 하나의 시작 결과를 공유한다.
    const selected = workspace.activate("b"), created = workspace.create("b");
    ready.resolve(); expectOk(await selected);
    const session = expectOk(await created);
    expectOk(await workspace.prompt(session, "read")); expectOk(await workspace.complete(session, { kind: "file", query: "" }));
    expectOk(await workspace.listHistory("b"));
    const editor = expectOk(await workspace.openEditor("b"));
    const terminal = expectOk(await workspace.createTerminal("b", { cols: 80, rows: 20 }));
    expectError(await workspace.attachEditor(editor, () => {}, () => {}));
    expectError(await workspace.attachTerminal(terminal, () => {}, () => {}));
    expectOk(await workspace.closeTerminal(terminal)); expectOk(await workspace.closeSession(session));

    // 아직 snapshot에 없는 생성 ID도 다른 레포로 보내지 않는다.
    expect(started).toEqual(["b"]);
    expect(pa.calls).toEqual([]);
    expect(pb.calls).toContain("prompt:b-new:read");
    expect(pb.calls).toContain("attach-editor:b-editor");
    expect(pb.calls).toContain("attach-terminal:b-terminal");
    expect(workspace.hasSnapshot("b")).toBe(true);
    expect(workspace.hasSnapshot("a")).toBe(false);
  } finally { ready.resolve(); await workspace.disconnect(); }
}));

test("기존 데몬의 snapshot과 재연결은 다른 레포의 행과 연결을 덮어쓰지 않는다", () => isolated(async (stateRoot) => {
  // 이미 실행 중인 두 데몬은 시작 없이 기존 세션에 붙는다.
  const a = repo("a"), b = repo("b"), pa = peer(a), pb = peer(b);
  const starts: boolean[] = [];
  const workspace = expectOk(await WorkspaceClient.open([a, b], "/outside", { stateRoot }, async (repository, _cwd, options) => {
    starts.push(options.start ?? true); return ok(repository.id === a.id ? pa.client : pb.client);
  }));
  let changes = 0; const unsubscribe = workspace.subscribe(() => changes++);
  try {
    const changed = { ...a, worktrees: a.worktrees.map((tree) => ({ ...tree, branch: "feature/a", sessions: [{ id: "saved-a", name: "Saved", status: null, subagents: [] }] })) };

    pa.update({ ...pa.client.snapshot, repositories: [changed], details: { "saved-a": { status: null, output: "A", error: null } } });
    pb.connection(false); pb.connection(true);
    expectOk(await workspace.prompt("saved-a", "status"));

    // 한 데몬의 이벤트에는 다른 레포의 전체 snapshot이 포함될 필요가 없다.
    expect(workspace.snapshot.repositories).toEqual([changed, b]);
    expect(workspace.snapshot.details["saved-a"]?.output).toBe("A");
    expect(workspace.recoveryVersion).toBe(1);
    expect(changes).toBe(3);
    expect(starts).toEqual([false, false]);
    expect(pa.calls).toContain("prompt:saved-a:status");
    expect(pb.calls).toEqual([]);
  } finally { unsubscribe(); await workspace.disconnect(); }
}));

test("일부 레포의 연결 실패는 격리하고 알 수 없는 대상에 명령을 보내지 않는다", () => isolated(async (stateRoot) => {
  // B가 오프라인이어도 A의 세션과 작업은 사용할 수 있다.
  const a = repo("a"), b = repo("b"), pa = peer(a);
  const workspace = expectOk(await WorkspaceClient.open([a, b], a.worktrees[0]!.path, { stateRoot }, async (repository) => repository.id === a.id ? ok(pa.client) : err(new ConnectionError("CONNECTION_FAILED", "B unavailable"))));
  try {
    const session = expectOk(await workspace.create("a"));
    expectOk(await workspace.prompt(session, "read"));
    const failure = expectError(await workspace.activate("b"));

    // 실패 경로는 코드로 보고되고 임의의 기본 레포로 재전송되지 않는다.
    expect(failure.code).toBe("CONNECTION_FAILED");
    expect(workspace.snapshot.notice).toContain("b: B unavailable");
    expect(expectError(await workspace.create("missing")).code).toBe("INVALID_INPUT");
    expect(expectError(await workspace.prompt("missing", "read")).code).toBe("SESSION_NOT_OPEN");
    expect(pa.calls).toEqual(["create:a", "prompt:a-new:read"]);
  } finally { await workspace.disconnect(); }
}));

test("분리 중 늦게 시작된 연결도 닫고 생성 명령이나 새 snapshot을 발행하지 않는다", () => isolated(async (stateRoot) => {
  const a = repo("a"), pa = peer(a), ready = Promise.withResolvers<void>();
  const workspace = expectOk(await WorkspaceClient.open([a], "/outside", { stateRoot }, async (_repository, _cwd, options) => {
    if (!options.start) return ok(null);
    await ready.promise; return ok(pa.client);
  }));
  let changes = 0; workspace.subscribe(() => changes++);

  // 런타임 연결을 기다리는 동안 TUI를 분리한다.
  const creating = workspace.create("a"); workspace.beginDetach(); ready.resolve();
  const error = expectError(await creating); await workspace.disconnect();

  // 데몬을 중지하지 않고 이 TUI의 늦은 연결만 정리한다.
  expect(error.code).toBe("CANCELLED");
  expect(pa.calls).toEqual(["disconnect"]);
  expect(changes).toBe(0);
  expect(expectError(await workspace.activate("a")).code).toBe("CANCELLED");
}));

test("구형 저장소 서비스 전환 안내는 설정 저장이 성공해도 사라지거나 서비스를 교체하지 않는다", () => isolated(async (stateRoot) => {
  // 공용 데몬 capability가 없는 기존 연결을 유지한다.
  const a = repo("a"), pa = peer(a);
  const workspace = expectOk(await WorkspaceClient.open([a], "/outside", { stateRoot }, async () => ok(pa.client)));
  try {
    // UI 설정 저장은 데몬 교체나 전환 완료로 취급하지 않는다.
    expectOk(await workspace.savePreferences(workspace.snapshot.preferences));

    // 저장 경고가 없어져도 구형 소유권 안내는 남고 프로세스 제어 요청은 보내지 않는다.
    expect(workspace.snapshot.notice).toContain("legacy repository process");
    expect(workspace.snapshot.notice).toContain("runtime stop --legacy");
    expect(pa.calls).toEqual([]);
  } finally { await workspace.disconnect(); }
}));

test("분리 전 최종 저장도 레포별로 나누고 한 저장 실패가 다른 레포 저장을 막지 않는다", () => isolated(async (stateRoot) => {
  const a = repo("a"), b = repo("b"), pa = peer(a), pb = peer(b);
  const workspace = expectOk(await WorkspaceClient.open([a, b], "/outside", { stateRoot }, async (repository) => ok(repository.id === a.id ? pa.client : pb.client)));
  try {
    const aId = expectOk(await workspace.create("a")), bId = expectOk(await workspace.create("b"));
    const preferences = workspace.snapshot.preferences;
    preferences.selection = { worktreeId: "b", sessions: { a: aId, b: bId } }; preferences.drafts = { [aId]: "draft A", [bId]: "draft B" };

    // 건강한 연결의 마지막 preference 쓰기는 beginDetach 뒤에도 허용한다.
    workspace.beginDetach(); pb.failSave();
    const error = expectError(await workspace.savePreferences(preferences));

    expect(error.code).toBe("CLEANUP_FAILED");
    expect(pa.saved[0]?.drafts).toEqual({ [aId]: "draft A" });
    expect(pb.saved[0]?.drafts).toEqual({ [bId]: "draft B" });
    expect(pa.saved[0]?.selection.sessions).toEqual({ a: aId });
    expect(pb.saved[0]?.selection.sessions).toEqual({ b: bId });
  } finally { await workspace.disconnect(); }
}));

test("레포별 저장은 순서를 유지하고 이전 저장 완료 전에 새 상태를 보내지 않는다", () => isolated(async (stateRoot) => {
  const a = repo("a"), pa = peer(a), gate = Promise.withResolvers<void>();
  const workspace = expectOk(await WorkspaceClient.open([a], "/outside", { stateRoot }, async () => ok(pa.client)));
  try {
    const id = expectOk(await workspace.create("a"));
    const first = workspace.snapshot.preferences, second = workspace.snapshot.preferences;
    first.drafts = { [id]: "old" }; second.drafts = { [id]: "new" };
    pa.gateSaving(gate.promise);

    // 지연된 이전 쓰기 뒤에 최신 초안 저장과 분리를 연속 요청한다.
    const oldSave = workspace.savePreferences(first); await Promise.resolve();
    const newSave = workspace.savePreferences(second);
    const closing = workspace.disconnect(); await Promise.resolve();
    expect(pa.saved).toHaveLength(1);
    gate.resolve(); expectOk(await oldSave); expectOk(await newSave); await closing;

    // 종료가 마지막 쓰기를 먼저 끊거나 역순으로 저장하지 않는다.
    expect(pa.saved.map((preferences) => preferences.drafts[id])).toEqual(["old", "new"]);
    expect(pa.calls.at(-1)).toBe("disconnect");
  } finally { gate.resolve(); await workspace.disconnect(); }
}));

test("연결 전 보관 초안을 유지하고 그동안 바뀐 뷰 설정을 지연 연결 후 저장한다", () => isolated(async (stateRoot) => {
  const b = repo("b"), pb = peer(b);
  const previous = defaultPreferences();
  previous.selection = { worktreeId: "b", sessions: { b: "saved-b" } }; previous.drafts = { "saved-b": "retained" };
  const live = { ...b, worktrees: b.worktrees.map((tree) => ({ ...tree, sessions: [{ id: "saved-b", name: "Saved", status: null, subagents: [] }] })) };
  pb.update({ ...pb.client.snapshot, repositories: [live], preferences: previous });
  const paths = runtimePaths(b.id, true, stateRoot); await privateDirectory(paths.directory);
  expectOk(await new RuntimeStore(paths).save({ version: 1, repositoryId: b.id, repositories: [b], records: [], preferences: previous }));
  const workspace = expectOk(await WorkspaceClient.open([b], "/outside", { stateRoot, offline: true }, async (_repository, _cwd, options) => options.start ? ok(pb.client) : ok(null)));
  try {
    const preferences = workspace.snapshot.preferences;
    preferences.workViews = { active: { b: "git" }, agentScroll: {} };

    // 초기 화면에서 아직 없는 세션 행 때문에 보관 초안을 삭제하지 않는다.
    expect([...workspace.retainedSessionIds]).toEqual(["saved-b"]);
    expectOk(await workspace.savePreferences(preferences));
    expect(pb.saved).toEqual([]);
    expectOk(await workspace.activate("b"));

    // 클라이언트가 생기기 전의 변경도 저장되고 실제 세션 행이 보관 책임을 넘겨받는다.
    expect(pb.saved[0]?.workViews?.active).toEqual({ b: "git" });
    expect(pb.saved[0]?.drafts).toEqual({ "saved-b": "retained" });
    expect([...workspace.retainedSessionIds]).toEqual([]);
  } finally { await workspace.disconnect(); }
}));

test("초기화 결함이 발생해도 동시에 붙는 다른 레포의 늦은 연결을 모두 정리한다", () => isolated(async (stateRoot) => {
  const a = repo("a"), b = repo("b"), pb = peer(b), bug = new TypeError("Fixture programming defect");
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();

  // A의 예상하지 못한 예외와 B의 늦은 연결이 겹친다.
  const opening = WorkspaceClient.open([a, b], "/outside", { stateRoot }, async (repository) => {
    if (repository.id === a.id) throw bug;
    entered.resolve(); await gate.promise; return ok(pb.client);
  });
  const failed = opening.then(() => undefined, (error: unknown) => error);
  await entered.promise; gate.resolve();

  // 결함을 입력 오류로 바꾸지 않으면서 성공한 다른 연결도 누수 없이 닫는다.
  expect(await failed).toBe(bug);
  expect(pb.calls).toEqual(["begin-detach", "disconnect"]);
}));

test("런타임 연결 뒤 설정 저장 실패는 연결 거부가 아닌 경고로 표시한다", () => isolated(async (stateRoot) => {
  const b = repo("b"), pb = peer(b); pb.failSave();
  const workspace = expectOk(await WorkspaceClient.open([b], "/outside", { stateRoot }, async (_repository, _cwd, options) => options.start ? ok(pb.client) : ok(null)));
  try {
    // 연결은 성공했고 그 뒤의 preference 쓰기만 실패한다.
    expectOk(await workspace.activate("b"));
    const created = expectOk(await workspace.create("b"));

    // 수락한 연결/생성을 취소했다고 보고하거나 다시 시작하지 않는다.
    expect(created).toBe("b-new");
    expect(workspace.snapshot.notice).toContain("Runtime connected; UI preference persistence failed");
    expect(pb.calls).toEqual(["create:b"]);
  } finally { await workspace.disconnect(); }
}));
