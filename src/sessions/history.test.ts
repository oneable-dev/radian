import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { offlineRuntime } from "../testing/offline-runtime.ts";
import { piSessionFactory } from "./pi-session-adapter.ts";
import { SessionRegistry } from "./session-registry.ts";
import { SessionHistory } from "./history.ts";

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
      prompt: (text: string) => executor.prompt(text), close: async () => { await gate.promise; await executor.close(); } };
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
    const main = await app.registry.create(app.main.id); const feature = await app.registry.create(app.feature.id);
    await Promise.all([app.registry.prompt(main, "read"), app.registry.prompt(feature, "write")]);

    // History is read-only metadata, not an operation that creates/resumes a session.
    const list = await app.history.list(app.main.id);

    // Metadata from another cwd cannot appear under the selected worktree.
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("read");
    expect(list[0]?.worktreeId).toBe(app.main.id);
    expect(list[0]?.openSessionId).toBe(main);
    expect(Number.isNaN(Date.parse(list[0]!.modified))).toBe(false);
    expect(list[0]!.messageCount).toBeGreaterThan(0);
  } finally { await app.cleanup(); }
});

test("닫은 기록을 resume하면 동일 SDK ID·파일·대화를 사용하고 별도의 열린 UI 항목만 추가한다", async () => {
  // The existing finalized JSONL is authoritative, not copied to a new conversation.
  const app = await setup();
  try {
    const original = await app.registry.create(app.main.id);
    await app.registry.prompt(original, "read");
    const file = app.registry.sessionFile(original)!;
    const sdkId = SessionManager.open(file).getSessionId();
    const before = await readFile(file, "utf8");
    await app.registry.close(original);

    // Resume uses the SDK saved ID selected from the worktree's history, not an arbitrary path.
    const reopened = await app.history.resume(app.main.id, sdkId);

    // Open identity changes, but persisted identity and the conversation do not fork or restart.
    expect(reopened).not.toBe(original);
    expect(app.registry.sessionFile(reopened)).toBe(file);
    expect(SessionManager.open(file).getSessionId()).toBe(sdkId);
    expect(app.registry.details(reopened)?.output).toContain("main-worktree-marker");
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await app.history.resume(app.main.id, sdkId)).toBe(reopened);
    expect(app.registry.snapshot[0]!.worktrees[0]!.sessions).toHaveLength(1);
  } finally { await app.cleanup(); }
});

test("다른 워크트리의 saved ID와 알 수 없는 ID는 resume하지 않는다", async () => {
  // A valid main conversation must not be assigned to the feature worktree by an untyped request.
  const app = await setup();
  try {
    const id = await app.registry.create(app.main.id); await app.registry.prompt(id, "read");
    const saved = (await app.history.list(app.main.id))[0]!;

    // Cross-worktree or arbitrary IDs cannot bypass discovery membership.
    await expect(app.history.resume(app.feature.id, saved.id)).rejects.toThrow("not available");
    await expect(app.history.resume(app.main.id, "unknown")).rejects.toThrow("not available");

    // The valid existing execution and its worktree remain unchanged.
    expect(app.registry.snapshot[0]!.worktrees[0]!.sessions[0]?.id).toBe(id);
    expect(app.registry.snapshot[0]!.worktrees[1]!.sessions).toEqual([]);
  } finally { await app.cleanup(); }
});

test("종료 중인 저장 기록은 history에서 busy로 표시하고 두 번째 writer를 만들지 않는다", async () => {
  // Cleanup acknowledgement is held so the hidden closing writer can be observed.
  const app = await setup(true);
  try {
    const id = await app.registry.create(app.main.id); await app.registry.prompt(id, "read");
    const savedId = (await app.history.list(app.main.id))[0]!.id;

    // Closing removes display ownership but keeps the canonical-file reservation.
    const closing = app.registry.close(id);
    const list = await app.history.list(app.main.id);
    await expect(app.history.resume(app.main.id, savedId)).rejects.toThrow("still closing");

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
    const id = await app.registry.create(app.main.id); await app.registry.prompt(id, "read");
    const file = app.registry.sessionFile(id)!; const sdkId = SessionManager.open(file).getSessionId();
    await app.registry.close(id);
    const corrupt = (await readFile(file, "utf8")) + "invalid trailing JSON\n";
    await writeFile(file, corrupt);

    // Strict validation happens before the SDK opens a writable session handle.
    await expect(app.history.resume(app.main.id, sdkId)).rejects.toBeInstanceOf(SyntaxError);

    // No replacement or repair is silently committed to the saved history.
    expect(await readFile(file, "utf8")).toBe(corrupt);
    expect(app.registry.snapshot[0]!.worktrees[0]!.sessions).toEqual([]);
  } finally { await app.cleanup(); }
});
