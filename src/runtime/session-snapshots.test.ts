import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "../agents/session-registry.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { emptyPreferences, protocolVersion, type RuntimeManifest } from "./protocol.ts";
import { privateDirectory, RuntimeStore, runtimePaths } from "./storage.ts";

const record = (id: string, conversationId = id, lifecycle: "open" | "closed" = "open"): SessionRecord => ({
  id, name: `Session ${id}`, worktreeId: "tree", cwd: "/fixture", sessionFile: `/fixture/${conversationId}.jsonl`, lifecycle,
  state: { conversationId, status: "complete", output: `Output ${id}`, error: null,
    sections: [{ id: `${conversationId}:a`, kind: "assistant", title: "Agent", text: `SAVED BODY ${id}`, status: "complete" }],
    telemetry: { provider: "fixture", model: "saved-model", effort: "high", fast: true, context: { usedTokens: 72000, maxTokens: 200000 }, weekly: null } },
  subagents: [],
});
const manifest = (records: readonly SessionRecord[]): RuntimeManifest => ({ version: protocolVersion, repositoryId: "repo", repositories: [], preferences: structuredClone(emptyPreferences), records });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "radian-session-snapshots-")), paths = runtimePaths("repo", true, root);
  await privateDirectory(paths.directory);
  return { paths, store: new RuntimeStore(paths), async close() { await rm(root, { recursive: true, force: true }); } };
}
async function fileFor(paths: ReturnType<typeof runtimePaths>, conversationId: string): Promise<string> {
  const index = JSON.parse(await readFile(paths.manifest, "utf8"));
  const entry = index.records.find((entry: { conversationId: string }) => entry.conversationId === conversationId);
  if (!entry) throw new Error("Missing snapshot index entry");
  return join(paths.directory, "sessions", `${entry.key}.json`);
}

test("복구와 History는 같은 세션 파일을 사용하되 닫힌 대화는 복구하지 않는다", async () => {
  // 열린 대화와 닫힌 대화 모두 원래 상태줄 데이터를 가진다.
  const app = await fixture();
  try {
    expectOk(await app.store.save(manifest([record("a"), record("b", "b", "closed")])));

    // 새 프로세스처럼 저장소를 다시 열어 복구 목록과 History 조회를 각각 읽는다.
    const restored = new RuntimeStore(app.paths), loaded = expectOk(await restored.load("repo"));
    const closed = expectOk(await restored.readSession("tree", "b"));

    // 실행은 열린 항목만 복원하고, 닫힌 대화의 본문과 telemetry도 동일 파일에 남긴다.
    expect(loaded?.records.map(record => record.id)).toEqual(["a"]);
    expect(restored.listSessions("tree")).toHaveLength(2); expect(closed?.lifecycle).toBe("closed");
    expect(closed?.state).toEqual(record("b").state);
    expect(expectOk(await restored.readSession("other-tree", "b"))).toBeNull();
    const index = await readFile(app.paths.manifest, "utf8");
    expect(index).not.toContain("SAVED BODY"); expect(index).not.toContain("usedTokens");
    expect((await stat(await fileFor(app.paths, "b"))).mode & 0o777).toBe(0o600);
  } finally { await app.close(); }
});

test("같은 SDK 대화를 다른 탭으로 열어도 중복 저장하지 않고 닫은 기록을 유지한다", async () => {
  // 저장 식별자는 UI 탭 ID가 아니라 SDK 대화 ID다.
  const app = await fixture();
  try {
    expectOk(await app.store.save(manifest([record("old-tab", "conversation", "closed")])));

    // 재개는 같은 스냅샷을 열린 상태로 바꾸고 명시적 닫기는 다시 닫힌 상태로 남긴다.
    expectOk(await app.store.save(manifest([record("new-tab", "conversation")])));
    expectOk(await app.store.save(manifest([])));

    // 마지막 탭 정보만 남고 새 런타임에서 자동으로 열리지는 않는다.
    const store = new RuntimeStore(app.paths);
    expect(expectOk(await store.load("repo"))?.records).toEqual([]);
    expect(store.listSessions("tree")).toHaveLength(1);
    expect(expectOk(await store.readSession("tree", "conversation"))).toMatchObject({ id: "new-tab", lifecycle: "closed" });
    expect(await readdir(join(app.paths.directory, "sessions"))).toHaveLength(1);
  } finally { await app.close(); }
});

test("열린 대화만 갱신할 때 과거의 닫힌 본문 파일은 다시 쓰지 않는다", async () => {
  // 누적된 닫힌 본문은 일반 checkpoint의 쓰기 비용에 포함되지 않아야 한다.
  const app = await fixture();
  try {
    expectOk(await app.store.save(manifest([record("active"), record("closed", "closed", "closed")])));
    const path = await fileFor(app.paths, "closed"), before = await stat(path), bytes = await readFile(path, "utf8");

    // 활성 세션의 출력만 변경한다.
    const changed = record("active");
    expectOk(await app.store.save(manifest([{ ...changed, state: { ...changed.state, output: "New active output" } }])));

    // 원자적 교체가 있었다면 inode도 달라지므로 불필요한 재저장을 검출한다.
    expect((await stat(path)).ino).toBe(before.ino); expect(await readFile(path, "utf8")).toBe(bytes);
    expect(app.store.listSessions("tree")).toHaveLength(2);
  } finally { await app.close(); }
});

test("이전 단일 manifest를 읽은 뒤 열린·닫힌 상태를 보존해 세션별 저장으로 이전한다", async () => {
  // lifecycle이 없던 기록은 기존처럼 열린 세션으로 취급한다.
  const app = await fixture();
  try {
    const { lifecycle: _lifecycle, ...legacy } = record("legacy");
    const original = JSON.stringify(manifest([legacy, record("closed", "closed", "closed")]));
    await writeFile(app.paths.manifest, original);

    // 조회 자체는 원본을 바꾸지 않고 다음 checkpoint에서만 형식을 이전한다.
    const restored = expectOk(await app.store.load("repo"));
    expect(restored?.records.map(record => record.id)).toEqual(["legacy"]);
    expect(await readFile(app.paths.manifest, "utf8")).toBe(original);
    if (!restored) throw new Error("Missing legacy manifest");
    expectOk(await app.store.save(restored));

    // 새 저장소에서도 같은 복구 목록과 닫힌 대화의 상태정보를 읽는다.
    const store = new RuntimeStore(app.paths);
    expect(expectOk(await store.load("repo"))?.records.map(record => record.id)).toEqual(["legacy"]);
    expect(expectOk(await store.readSession("tree", "closed"))?.state.telemetry?.fast).toBe(true);
    expect(JSON.parse(await readFile(app.paths.manifest, "utf8")).storageVersion).toBe(2);
    expect(await readdir(join(app.paths.directory, "sessions"))).toHaveLength(2);
  } finally { await app.close(); }
});

test("대화 ID가 없는 구형 스냅샷은 SDK 복구 뒤 같은 파일의 대화 ID로 합친다", async () => {
  // 구형 manifest의 탭 ID를 별도 History 대화로 남기면 같은 원본이 중복 표시된다.
  const app = await fixture();
  try {
    const current = record("tab", "sdk-conversation"), { conversationId: _conversationId, ...state } = current.state;
    await writeFile(app.paths.manifest, JSON.stringify(manifest([{ ...current, state }])));
    expectOk(await app.store.load("repo"));

    // SDK가 알려준 실제 conversationId를 가진 동일 탭·파일로 checkpoint한다.
    expectOk(await app.store.save(manifest([current])));

    // 같은 대화의 별칭만 정리하고 다른 세션을 만들거나 과거 기록을 버리지 않는다.
    expect(app.store.listSessions("tree")).toHaveLength(1);
    expect(app.store.listSessions("tree")[0]?.conversationId).toBe("sdk-conversation");
    expect(expectOk(await app.store.readSession("tree", "sdk-conversation"))?.state.sections).toEqual(current.state.sections);
  } finally { await app.close(); }
});

test("닫힌 스냅샷의 손상은 열린 세션 복구를 막지 않지만 History 조회에서는 명시한다", async () => {
  // 복구에 필요 없는 대화 본문은 시작 시 읽지 않는다.
  const app = await fixture();
  try {
    expectOk(await app.store.save(manifest([record("a"), record("b", "b", "closed")])));
    await writeFile(await fileFor(app.paths, "b"), "broken JSON");

    // 열린 세션만 로드하고 손상된 닫힌 대화는 사용자가 선택했을 때 읽는다.
    const store = new RuntimeStore(app.paths), loaded = expectOk(await store.load("repo"));
    const failure = expectError(await store.readSession("tree", "b"));

    // 손상을 빈 미리보기나 JSONL fallback으로 숨기지 않는다.
    expect(loaded?.records.map(record => record.id)).toEqual(["a"]); expect(failure.code).toBe("STORAGE_FAILED");
    expect(await readFile(await fileFor(app.paths, "b"), "utf8")).toBe("broken JSON");
  } finally { await app.close(); }
});

test("닫힌 본문 저장 뒤 인덱스 갱신이 실패해도 다음 복구에서 대화를 다시 열지 않는다", async () => {
  // 수락된 닫기 뒤의 저장 실패가 닫힘을 되돌렸다고 해석되면 안 된다.
  const app = await fixture();
  try {
    expectOk(await app.store.save(manifest([record("a")])));
    await rename(app.paths.manifest, app.paths.manifest + ".backup"); await mkdir(app.paths.manifest);

    // 세션 본문은 닫혔지만 workspace 인덱스 교체만 실패하게 한다.
    const failure = expectError(await app.store.save(manifest([record("a", "a", "closed")])));
    await rm(app.paths.manifest, { recursive: true }); await rename(app.paths.manifest + ".backup", app.paths.manifest);
    const store = new RuntimeStore(app.paths), loaded = expectOk(await store.load("repo"));

    // 오래된 열린 인덱스보다 실제 닫힌 세션 본문을 우선하고 다음 checkpoint에서 인덱스를 고친다.
    expect(failure.code).toBe("STORAGE_FAILED"); expect(loaded?.records).toEqual([]);
    if (!loaded) throw new Error("Missing manifest");
    expectOk(await store.save(loaded)); expect(store.listSessions("tree")[0]?.lifecycle).toBe("closed");
  } finally { await app.close(); }
});
