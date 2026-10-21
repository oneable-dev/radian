import { expect, spyOn, test } from "bun:test";
import { appendFile, chmod, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { offlineRuntime } from "../testing/offline-runtime.ts";
import { piSessionFactory } from "./pi-session-adapter.ts";
import { SessionRegistry } from "./session-registry.ts";
import { SessionHistory } from "./history.ts";
import { expectOk, expectError } from "../testing/results.ts";

async function setup(blockCleanup = false) {
  const fixture = await createWorktreeFixture();
  const options = await offlineRuntime(join(fixture.directory, "agent"));
  const factory = piSessionFactory(options);
  const gate = Promise.withResolvers<void>();
  if (!blockCleanup) gate.resolve();
  const registry = new SessionRegistry([fixture.repository], async (context) => {
    const executor = await factory(context);
    return { savedSessionId: executor.savedSessionId, sessionFile: executor.sessionFile,
      get state() { return executor.state; }, subscribe: (listener: () => void) => executor.subscribe(listener),
      prompt: (text: string) => executor.prompt(text), close: async () => { await gate.promise; return executor.close(); } };
  });
  const history = new SessionHistory([fixture.repository], registry, options.sessionDir);
  const main = fixture.repository.worktrees.find((tree) => tree.path === fixture.main)!;
  const feature = fixture.repository.worktrees.find((tree) => tree.path === fixture.feature)!;
  return { ...fixture, main, feature, registry, history, gate,
    async cleanup() { gate.resolve(); await registry.shutdown(); await fixture.cleanup(); } };
}

test("SDK 저장 기록은 선택 워크트리로 한정하고 제목·활동 시간·열린 ID를 제공한다", async () => {
  // The shared SDK directory contains two different worktree conversations.
  const app = await setup();
  try {
    const main = expectOk(await app.registry.create(app.main.id)); const feature = expectOk(await app.registry.create(app.feature.id));
    await Promise.all([app.registry.prompt(main, "read"), app.registry.prompt(feature, "write")]);

    // History is read-only metadata, not an operation that creates/resumes a session.
    const list = expectOk(await app.history.list(app.main.id));

    // Metadata from another cwd cannot appear under the selected worktree.
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("read");
    expect(list[0]?.worktreeId).toBe(app.main.id);
    expect(list[0]?.openSessionId).toBe(main);
    expect(Number.isNaN(Date.parse(list[0]!.modified))).toBe(false);
    expect(list[0]!.messageCount).toBeGreaterThan(0);
  } finally { await app.cleanup(); }
});

test("미리보기는 열린·닫힌 기록을 읽기만 하고 다른 워크트리 ID는 거절한다", async () => {
  // The offline SDK fixture owns all files; no preview may initialize an executor.
  const app = await setup();
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const saved = expectOk(await app.history.list(app.main.id))[0]!, file = app.registry.sessionFile(id)!;
    const before = await readFile(file, "utf8"), records = app.registry.records;
    expect(expectOk(await app.history.preview(app.main.id, saved.id)).text).toContain("read");
    expect(app.registry.records).toEqual(records); expect(await readFile(file, "utf8")).toBe(before);
    expect(expectError(await app.history.preview(app.feature.id, saved.id)).code).toBe("HISTORY_UNAVAILABLE");
    expect(expectError(await app.history.preview(app.main.id, "unknown")).code).toBe("HISTORY_UNAVAILABLE");
    expectOk(await app.registry.close(id));
    expect(expectOk(await app.history.preview(app.main.id, saved.id)).text).toContain("read");
    expect(app.registry.records).toEqual([]); expect(await readFile(file, "utf8")).toBe(before);
  } finally { await app.cleanup(); }
});

test("실제 SDK 기록이 4MiB를 넘어도 닫힌 세션의 최신 세 섹션을 읽기만 한다", async () => {
  // Close the fixture-owned writer before extending its JSONL, then use real SDK discovery.
  const app = await setup();
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const saved = expectOk(await app.history.list(app.main.id))[0]!, file = app.registry.sessionFile(id)!;
    expectOk(await app.registry.close(id));
    const entries = (await readFile(file, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    const parent = entries.at(-1)!.id;
    const timestamp = new Date().toISOString();
    await appendFile(file, [
      { type: "custom", id: "large-old", parentId: parent, timestamp, customType: "old-fixture-data", data: "x".repeat(5 * 1024 * 1024) },
      { type: "message", id: "recent-q", parentId: "large-old", timestamp, message: { role: "user", content: "LATEST QUESTION", timestamp: Date.now() } },
      { type: "message", id: "recent-a", parentId: "recent-q", timestamp, message: { role: "assistant", content: [{ type: "thinking", thinking: "LATEST PLAN" }, { type: "text", text: "LATEST ANSWER" }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const before = await readFile(file, "utf8");
    const preview = expectOk(await app.history.preview(app.main.id, saved.id));
    expect(preview.sections?.map((section) => section.text)).toEqual(["LATEST QUESTION", "LATEST PLAN", "LATEST ANSWER"]);
    expect(app.registry.records).toEqual([]); expect(await readFile(file, "utf8")).toBe(before);
  } finally { await app.cleanup(); }
});

test("닫은 기록을 resume하면 동일 SDK ID·파일·대화를 사용하고 별도의 열린 UI 항목만 추가한다", async () => {
  // The existing finalized JSONL is authoritative, not copied to a new conversation.
  const app = await setup();
  try {
    const original = expectOk(await app.registry.create(app.main.id));
    await app.registry.prompt(original, "read");
    const file = app.registry.sessionFile(original)!;
    const sdkId = SessionManager.open(file).getSessionId();
    const before = await readFile(file, "utf8");
    await app.registry.close(original);

    // Resume uses the SDK saved ID selected from the worktree's history, not an arbitrary path.
    const reopened = expectOk(await app.history.resume(app.main.id, sdkId));

    // Open identity changes, but persisted identity and the conversation do not fork or restart.
    expect(reopened).not.toBe(original);
    expect(app.registry.sessionFile(reopened)).toBe(file);
    expect(SessionManager.open(file).getSessionId()).toBe(sdkId);
    expect(app.registry.details(reopened)?.output).toContain("main-worktree-marker");
    expect(await readFile(file, "utf8")).toBe(before);
    expect(expectOk(await app.history.resume(app.main.id, sdkId))).toBe(reopened);
    expect(app.registry.snapshot[0]!.worktrees[0]!.sessions).toHaveLength(1);
  } finally { await app.cleanup(); }
});

test("다른 워크트리의 saved ID와 알 수 없는 ID는 resume하지 않는다", async () => {
  // A valid main conversation must not be assigned to the feature worktree by an untyped request.
  const app = await setup();
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const saved = expectOk(await app.history.list(app.main.id))[0]!;

    // Cross-worktree or arbitrary IDs cannot bypass discovery membership.
    expect(expectError(await app.history.resume(app.feature.id, saved.id)).code).toBe("HISTORY_UNAVAILABLE");
    expect(expectError(await app.history.resume(app.main.id, "unknown")).code).toBe("HISTORY_UNAVAILABLE");

    // The valid existing execution and its worktree remain unchanged.
    expect(app.registry.snapshot[0]!.worktrees[0]!.sessions[0]?.id).toBe(id);
    expect(app.registry.snapshot[0]!.worktrees[1]!.sessions).toEqual([]);
  } finally { await app.cleanup(); }
});

test("종료 중인 저장 기록은 history에서 busy로 표시하고 두 번째 writer를 만들지 않는다", async () => {
  // Cleanup acknowledgement is held so the hidden closing writer can be observed.
  const app = await setup(true);
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const savedId = expectOk(await app.history.list(app.main.id))[0]!.id;

    // Closing removes display ownership but keeps the canonical-file reservation.
    const closing = app.registry.close(id);
    const list = expectOk(await app.history.list(app.main.id));
    expect(expectError(await app.history.resume(app.main.id, savedId)).code).toBe("SESSION_CONFLICT");

    // Read-only history does not mistake an in-progress close for a reusable saved context.
    expect(list[0]?.unavailableReason).toContain("still closing");
    expect(list[0]?.openSessionId).toBeNull();
    app.gate.resolve(); await closing;
  } finally { await app.cleanup(); }
});

test("SDK 목록이 일부 손상된 줄을 건너뛰어도 resume은 원본 기록을 덮어쓰지 않는다", async () => {
  // The SDK can list a session with a valid header and malformed trailing JSON.
  const app = await setup();
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const file = app.registry.sessionFile(id)!; const sdkId = SessionManager.open(file).getSessionId();
    await app.registry.close(id);
    const corrupt = (await readFile(file, "utf8")) + "invalid trailing JSON\n";
    await writeFile(file, corrupt);

    // Strict validation happens before the SDK opens a writable session handle.
    expect(expectError(await app.history.resume(app.main.id, sdkId)).code).toBe("HISTORY_CORRUPT");

    // No replacement or repair is silently committed to the saved history.
    expect(await readFile(file, "utf8")).toBe(corrupt);
    expect(app.registry.snapshot[0]!.worktrees[0]!.sessions).toEqual([]);
  } finally { await app.cleanup(); }
});

test("history의 경로 접근 권한 오류는 빈 목록으로 숨기지 않고 StorageError Result로 반환한다", async () => {
  // A saved cwd under a denied directory is different from a deleted historical worktree.
  const app = await setup();
  const blocked = join(app.directory, "blocked");
  let restoreListing: (() => void) | undefined;
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const file = app.registry.sessionFile(id)!; expectOk(await app.registry.close(id));
    await mkdir(join(blocked, "child"), { recursive: true });
    const records = await SessionManager.list(app.main.path, dirname(file));
    const listing = spyOn(SessionManager, "list").mockResolvedValue(records.map((record) => ({ ...record, cwd: join(blocked, "child") })));
    restoreListing = () => listing.mockRestore();
    await chmod(blocked, 0);

    // Discovery can read the JSONL but cannot resolve its cwd.
    const result = await app.history.list(app.main.id);

    // The UI receives a typed failure instead of an apparently empty success.
    expect(expectError(result).code).toBe("STORAGE_FAILED");
  } finally { restoreListing?.(); await chmod(blocked, 0o700).catch(() => {}); await app.cleanup(); }
});

test("목록에서 만든 파일 인덱스를 여러 Preview에 재사용하고 명시적 목록 갱신만 재탐색한다", async () => {
  // 실제 SDK 탐색 호출 수로 반복 전체 목록 I/O가 제거됐는지 검증한다.
  const app = await setup(); let restore: (() => void) | undefined;
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const listing = spyOn(SessionManager, "list"); restore = () => listing.mockRestore();
    const saved = expectOk(await app.history.list(app.main.id))[0]!;
    for (let i = 0; i < 3; i++) expect(expectOk(await app.history.preview(app.main.id, saved.id)).text).toContain("read");
    expect(expectError(await app.history.preview(app.main.id, "unknown")).code).toBe("HISTORY_UNAVAILABLE");
    expect(listing).toHaveBeenCalledTimes(1);

    // Ctrl+R/다음 열기는 목록을 다시 요청하므로 새 디스크 상태를 발견한다.
    expectOk(await app.history.list(app.main.id)); expect(listing).toHaveBeenCalledTimes(2);
    expectOk(await app.history.preview(app.main.id, saved.id)); expect(listing).toHaveBeenCalledTimes(2);
  } finally { restore?.(); await app.cleanup(); }
});

test("목록 요청 없이 직접 Preview해도 한 번만 인덱스를 준비한다", async () => {
  // 기존 read-only endpoint를 직접 사용하는 호출자도 목록 선행 없이 동작해야 한다.
  const app = await setup(); let restore: (() => void) | undefined;
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const savedId = SessionManager.open(app.registry.sessionFile(id)!).getSessionId();
    const listing = spyOn(SessionManager, "list"); restore = () => listing.mockRestore();
    expect(expectOk(await app.history.preview(app.main.id, savedId)).text).toContain("read");
    expectOk(await app.history.preview(app.main.id, savedId)); expect(listing).toHaveBeenCalledTimes(1);
  } finally { restore?.(); await app.cleanup(); }
});

test("완료된 목록 요청의 신호가 나중에 취소되어도 검증된 인덱스는 다시 탐색하지 않는다", async () => {
  // HTTP 요청 수명과 이미 완료된 메타데이터 인덱스의 수명은 다르다.
  const app = await setup(); let restore: (() => void) | undefined;
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const listing = spyOn(SessionManager, "list"); restore = () => listing.mockRestore(); const abort = new AbortController();
    const saved = expectOk(await app.history.list(app.main.id, abort.signal))[0]!; abort.abort();
    expectOk(await app.history.preview(app.main.id, saved.id));
    expect(listing).toHaveBeenCalledTimes(1);
  } finally { restore?.(); await app.cleanup(); }
});

test("캐시된 경로의 파일이 다른 워크트리 기록으로 바뀌면 Preview를 거절한다", async () => {
  // 파일 인덱스를 신뢰하더라도 선택 파일의 현재 헤더와 cwd는 재검증해야 한다.
  const app = await setup();
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const file = app.registry.sessionFile(id)!, saved = expectOk(await app.history.list(app.main.id))[0]!;
    expectOk(await app.registry.close(id));
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n"), header = JSON.parse(lines[0]!);
    lines[0] = JSON.stringify({ ...header, cwd: app.feature.path }); await writeFile(file, lines.join("\n") + "\n");

    expect(expectError(await app.history.preview(app.main.id, saved.id)).code).toBe("HISTORY_UNAVAILABLE");
    expect(app.registry.records).toEqual([]);
  } finally { await app.cleanup(); }
});

test.each(["\0invalid", 42])("캐시된 파일 헤더의 잘못된 cwd %j는 OS 예외 대신 손상 오류로 반환한다", async cwd => {
  // 탐색 이후 변경된 외부 JSON 값은 파일시스템 호출 전에 검증해야 한다.
  const app = await setup();
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const file = app.registry.sessionFile(id)!, saved = expectOk(await app.history.list(app.main.id))[0]!;
    expectOk(await app.registry.close(id));
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n"), header = JSON.parse(lines[0]!);
    lines[0] = JSON.stringify({ ...header, cwd }); await writeFile(file, lines.join("\n") + "\n");

    expect(expectError(await app.history.preview(app.main.id, saved.id)).code).toBe("HISTORY_CORRUPT");
  } finally { await app.cleanup(); }
});

test("캐시된 파일 경로가 심볼릭 링크로 교체되면 대상 파일을 Preview하지 않는다", async () => {
  // 같은 헤더 ID를 복제해도 이전 canonical path 검증을 우회할 수 없어야 한다.
  const app = await setup();
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const file = app.registry.sessionFile(id)!, saved = expectOk(await app.history.list(app.main.id))[0]!;
    expectOk(await app.registry.close(id)); const other = join(app.directory, "replaced.jsonl");
    await writeFile(other, await readFile(file)); await unlink(file); await symlink(other, file);

    expect(expectError(await app.history.preview(app.main.id, saved.id)).code).toBe("HISTORY_UNAVAILABLE");
  } finally { await app.cleanup(); }
});

test("목록 조회 취소 신호를 SDK 탐색까지 전달하고 취소를 빈 성공으로 숨기지 않는다", async () => {
  // SDK 호출 안에서 취소되는 상황을 제어하여 탐색 전후의 신호 확인만으로 통과하지 못하게 한다.
  const app = await setup(); const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const abort = new AbortController(); let restore: (() => void) | undefined, received: AbortSignal | undefined;
  try {
    const listing = spyOn(SessionManager, "list").mockImplementation(async (_cwd, _dir, _progress, signal) => {
      received = signal; started.resolve(); await finish.promise; signal?.throwIfAborted(); return [];
    }); restore = () => listing.mockRestore();
    const result = app.history.list(app.main.id, abort.signal); await started.promise; abort.abort(); finish.resolve();

    expect(received === abort.signal).toBe(true); expect(expectError(await result).code).toBe("CANCELLED");
  } finally { finish.resolve(); restore?.(); await app.cleanup(); }
});
