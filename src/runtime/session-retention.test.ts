import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, renameSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "../agents/session-registry.ts";
import { loadSessionSettings } from "../app/settings.ts";
import { InputError } from "../errors.ts";
import { err, ok } from "../result.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { emptyPreferences, type RuntimeManifest } from "./protocol.ts";
import { privateDirectory, runtimePaths, RuntimeStore } from "./storage.ts";
import { RetentionScheduler, retentionDayMs, retentionSweepIntervalMs } from "./session-retention.ts";

const now = 1800000000000;
const release = () => () => {};
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "radian-retention-"))), cwd = join(root, "worktree");
  await mkdir(cwd); const paths = runtimePaths("repo", true, join(root, "state")); await privateDirectory(paths.directory);
  const store = new RuntimeStore(paths);
  const manifest = (records: readonly SessionRecord[]): RuntimeManifest => ({ version: 1, repositoryId: "repo", repositories: [], preferences: structuredClone(emptyPreferences), records });
  return { root, cwd, paths, store, manifest,
    async record(id: string, age = 31, managed = true): Promise<SessionRecord> {
      const closedAt = now - age * retentionDayMs, sessionFile = join(root, `${id}.jsonl`);
      await writeFile(sessionFile, JSON.stringify({ type: "session", version: 3, id, cwd }) + "\n");
      await utimes(sessionFile, closedAt / 1000, closedAt / 1000);
      return { id, name: `Private title ${id}`, worktreeId: "tree", cwd, sessionFile, lifecycle: "closed", managed, closedAt, updatedAt: closedAt + 1000,
        state: { conversationId: id, status: "complete", output: "Private transcript", error: null }, subagents: [] };
    },
    async snapshotFile(id: string) {
      const index = JSON.parse(await readFile(paths.manifest, "utf8"));
      return join(paths.directory, "sessions", `${index.records.find((entry: { conversationId: string }) => entry.conversationId === id).key}.json`);
    },
    async close() { await rm(root, { recursive: true, force: true }); } };
}

test("30일이 지난 닫힌 소유 세션만 JSONL과 스냅샷을 함께 정리한다", async () => {
  // 오래된 기록이라도 열린 세션, 외부 세션과 최근 닫힌 세션은 보호한다.
  const app = await fixture();
  try {
    const expired = await app.record("expired"), open = { ...await app.record("open"), lifecycle: "open" as const, closedAt: null };
    const external = await app.record("external", 31, false), recent = await app.record("recent", 29);
    expectOk(await app.store.save(app.manifest([expired, open, external, recent])));

    // 실제 임시 파일만 대상으로 기본 보관 기간을 검사한다.
    expect(expectOk(await app.store.pruneExpired(30, release, now))).toBe(1);

    // 만료된 본문은 사라지고 작은 식별자만 남아 오래된 응답의 재생성을 막는다.
    expect(await Bun.file(expired.sessionFile!).exists()).toBe(false); expect(app.store.isExpired("tree", "expired")).toBe(true);
    expect(app.store.listSessions("tree")).toHaveLength(3); expect(expectOk(await app.store.readSession("tree", "expired"))).toBeNull();
    for (const record of [open, external, recent]) expect(await Bun.file(record.sessionFile!).exists()).toBe(true);
    expect(await readdir(join(app.paths.directory, "sessions"))).toHaveLength(3);
    expect(await readFile(app.paths.manifest, "utf8")).not.toContain("Private title expired");
    expectOk(await app.store.save(app.manifest([expired, open])));
    expect(app.store.isExpired("tree", "expired")).toBe(true); expect(await readdir(join(app.paths.directory, "sessions"))).toHaveLength(3);
  } finally { await app.close(); }
});

test("재개하면 만료 기준을 비우고 다시 닫은 날부터 보관 기간을 새로 계산한다", async () => {
  // 생성일이나 checkpoint 갱신일이 닫힌 날짜를 대신하면 안 된다.
  const app = await fixture();
  try {
    const old = await app.record("again"); expectOk(await app.store.save(app.manifest([old])));

    // 재개한 동안 보호하고 재닫힘 뒤 일반 저장으로 만료가 계속 밀리지 않게 한다.
    expectOk(await app.store.save(app.manifest([{ ...old, lifecycle: "open", closedAt: null }])));
    expect(expectOk(await app.store.pruneExpired(30, release, now))).toBe(0);
    const closed = { ...old, closedAt: now, updatedAt: now };
    expectOk(await app.store.save(app.manifest([closed])));
    expectOk(await app.store.save(app.manifest([{ ...closed, updatedAt: now + 20 * retentionDayMs, state: { ...closed.state, output: "Checkpoint changed" } }])));

    // 마지막 닫힘 기준의 경계 직전에는 남고 정확히 30일이면 정리한다.
    expect(app.store.listSessions("tree")[0]?.closedAt).toBe(now);
    expect(expectOk(await app.store.pruneExpired(30, release, now + 30 * retentionDayMs - 1))).toBe(0);
    expect(expectOk(await app.store.pruneExpired(30, release, now + 30 * retentionDayMs))).toBe(1);
  } finally { await app.close(); }
});

test("무기한 보관과 재개 중인 세션의 정리 예약 거절은 파일을 바꾸지 않는다", async () => {
  // 정책이나 실행 소유권이 정리를 막으면 삭제 표식도 만들지 않는다.
  const app = await fixture();
  try {
    const record = await app.record("protected"); expectOk(await app.store.save(app.manifest([record])));

    // 같은 만료 기록에 대해 무기한 정책과 실행 소유권 보호를 각각 적용한다.
    expect(expectOk(await app.store.pruneExpired(null, release, now))).toBe(0);
    expect(expectOk(await app.store.pruneExpired(30, () => null, now))).toBe(0);

    // JSONL fallback과 재개가 가능한 원래 상태 그대로 남는다.
    expect(app.store.isExpired("tree", "protected")).toBe(false); expect(await Bun.file(record.sessionFile!).exists()).toBe(true);
    expect(expectOk(await app.store.readSession("tree", "protected"))).not.toBeNull();
  } finally { await app.close(); }
});

test("이전 기록의 닫힘 날짜는 유예하고 출처가 불명확한 JSONL은 자동 삭제하지 않는다", async () => {
  // 기존 스냅샷에는 closedAt과 Radian 소유 정보가 없을 수 있다.
  const app = await fixture();
  try {
    const { managed: _managed, closedAt: _closedAt, ...legacy } = await app.record("legacy", 100);
    expectOk(await app.store.save(app.manifest([{ ...legacy, updatedAt: 0 }])));

    // 이전 파일을 다시 읽고 새 기본 정책으로 검사한다.
    const store = new RuntimeStore(app.paths); expectOk(await store.load("repo"));
    expect(expectOk(await store.pruneExpired(30, release, Date.now() + 100 * retentionDayMs))).toBe(0);

    // 과거 updatedAt만 보고 즉시 삭제하거나 외부 파일을 소유했다고 추정하지 않는다.
    expect(store.listSessions("tree")[0]?.closedAt).toBeGreaterThan(0);
    expect(store.listSessions("tree")[0]?.managed).toBe(false); expect(await Bun.file(legacy.sessionFile!).exists()).toBe(true);
  } finally { await app.close(); }
});

test("스냅샷 뒤 외부에서 변경한 SDK 파일은 오래된 만료 날짜로 정리하지 않는다", async () => {
  // 다른 도구가 이어 쓴 대화를 Radian의 과거 스냅샷만 보고 삭제하면 안 된다.
  const app = await fixture();
  try {
    const record = await app.record("changed"); expectOk(await app.store.save(app.manifest([record])));
    await utimes(record.sessionFile!, now / 1000, now / 1000);

    // 실제 파일의 마지막 수정 시각도 정리 전에 확인한다.
    expect(expectOk(await app.store.pruneExpired(30, release, now))).toBe(0);

    // 새 파일과 원래 스냅샷을 모두 보존한다.
    expect(app.store.isExpired("tree", "changed")).toBe(false); expect(await Bun.file(record.sessionFile!).exists()).toBe(true);
  } finally { await app.close(); }
});

test.each(["identity", "worktree", "symlink"])("SDK 파일의 %s 검증이 실패하면 소유 플래그가 있어도 삭제하지 않는다", async kind => {
  // 저장된 파일 경로만으로 임의의 파일을 지우지 않도록 파괴적 경계에서 재검증한다.
  const app = await fixture();
  try {
    const record = await app.record("unverified");
    if (kind === "symlink") { const target = join(app.root, "target.jsonl"); await writeFile(target, "Preserve target"); await rm(record.sessionFile!); await symlink(target, record.sessionFile!); }
    else { await writeFile(record.sessionFile!, JSON.stringify({ type: "session", id: kind === "identity" ? "other" : "unverified", cwd: kind === "worktree" ? app.root : app.cwd }) + "\n"); await utimes(record.sessionFile!, record.closedAt! / 1000, record.closedAt! / 1000); }
    expectOk(await app.store.save(app.manifest([record])));

    // 검사 실패는 숨기지 않지만 파일 삭제는 시작하지 않는다.
    const error = expectError(await app.store.pruneExpired(30, release, now));

    expect(error.code).toBe("CLEANUP_FAILED"); expect(await Bun.file(record.sessionFile!).exists()).toBe(true);
    expect(app.store.isExpired("tree", "unverified")).toBe(false);
  } finally { await app.close(); }
});

test("삭제 직전 SDK 파일이 바뀌면 삭제하지 않고 만료 표식을 되돌린다", async () => {
  // 파일 검사와 실제 unlink 사이에도 다른 프로그램이 쓸 수 있다.
  const app = await fixture();
  try {
    const record = await app.record("race"); expectOk(await app.store.save(app.manifest([record])));

    // 정리 예약 직후 SDK 파일을 바꿔 fingerprint의 마지막 검사를 재현한다.
    const error = expectError(await app.store.pruneExpired(30, () => { appendFileSync(record.sessionFile!, "NEW DATA\n"); return () => {}; }, now));

    // 아무 SDK 데이터도 삭제하지 않았으므로 기존 기록을 계속 표시한다.
    expect(error.code).toBe("CLEANUP_FAILED"); expect(await readFile(record.sessionFile!, "utf8")).toContain("NEW DATA");
    expect(app.store.isExpired("tree", "race")).toBe(false);
  } finally { await app.close(); }
});

test("부분 삭제 뒤 재시작해도 JSONL fallback으로 되살리지 않고 남은 정리를 완료한다", async () => {
  // SDK 파일 삭제 후 스냅샷 제거가 실패하는 경우를 임시 디렉터리에서만 재현한다.
  const app = await fixture();
  try {
    const record = await app.record("partial"); expectOk(await app.store.save(app.manifest([record])));
    const path = await app.snapshotFile("partial");

    // snapshot을 읽은 뒤 디렉터리로 바꿔 마지막 파일 제거만 실패하게 한다.
    const error = expectError(await app.store.pruneExpired(30, () => { renameSync(path, path + ".backup"); mkdirSync(path); return () => {}; }, now));
    const restored = new RuntimeStore(app.paths); expectOk(await restored.load("repo"));

    // 삭제 의도를 보존하므로 정책을 꺼도 이미 시작한 정리는 안전하게 마무리한다.
    expect(error.code).toBe("CLEANUP_FAILED"); expect(await Bun.file(record.sessionFile!).exists()).toBe(false);
    expect(restored.isExpired("tree", "partial")).toBe(true); expect(restored.listSessions("tree")).toEqual([]);
    await rm(path, { recursive: true });
    expect(expectOk(await restored.pruneExpired(null, release, now))).toBe(1);
    expect(restored.isExpired("tree", "partial")).toBe(true);
  } finally { await app.close(); }
});

test("주기적 정리는 시작 시 한 번 실행하고 매시간 검사하되 작업을 겹치지 않는다", async () => {
  // 실제로 한 시간을 기다리지 않고 예약 경계와 중복 작업 방지를 검증한다.
  let tick: (() => void) | undefined, interval = 0, canceled = 0, calls = 0;
  const pending = Promise.withResolvers<ReturnType<typeof ok<number>>>();
  const scheduler = new RetentionScheduler(() => ++calls === 1 ? Promise.resolve(ok(0)) : pending.promise, () => {}, error => { throw error; }, (callback, ms) => { tick = callback; interval = ms; return () => { canceled++; }; });
  await scheduler.start(); expect(calls).toBe(1); expect(interval).toBe(retentionSweepIntervalMs);

  // 긴 검사 중 추가 tick은 같은 작업을 공유하고 종료는 정리 완료까지 기다린다.
  tick!(); const active = scheduler.run(); tick!(); await Promise.resolve();
  const stopped = scheduler.stop(); pending.resolve(ok(1)); await Promise.all([active, stopped]); tick!();

  // UI가 없더라도 예약하고, 종료 후의 늦은 tick은 새로운 작업을 만들지 않는다.
  expect(calls).toBe(2); expect(canceled).toBe(1);
});

test("실행 중 설정 파일을 다시 읽어 무기한·손상·변경된 보관 기간을 적용한다", async () => {
  // 정리 주기마다 파일을 다시 읽으므로 런타임 재시작 없이 보관 기간을 바꿀 수 있다.
  const app = await fixture(), config = join(app.root, "settings.json"), outcomes: string[] = [];
  const scheduler = new RetentionScheduler(async () => {
    const settings = await loadSessionSettings(config); if (!settings.ok) return settings;
    return app.store.pruneExpired(settings.value.retentionDays, release, now);
  }, result => outcomes.push(result.ok ? `removed:${result.value}` : result.error.code), error => { throw error; }, () => () => {});
  try {
    const record = await app.record("reloaded", 10); expectOk(await app.store.save(app.manifest([record])));
    await writeFile(config, JSON.stringify({ sessions: { retentionDays: null } }));

    // 잘못된 중간 편집은 정리를 멈추고 다음 유효한 설정을 읽으면 새 기간을 사용한다.
    await scheduler.start(); await writeFile(config, "{broken"); await scheduler.run();
    expect(await Bun.file(record.sessionFile!).exists()).toBe(true);
    await writeFile(config, JSON.stringify({ sessions: { retentionDays: 7 } })); await scheduler.run();

    expect(outcomes).toEqual(["removed:0", "INVALID_INPUT", "removed:1"]);
    expect(await Bun.file(record.sessionFile!).exists()).toBe(false);
  } finally { await scheduler.stop(); await app.close(); }
});

test("잘못된 정책의 검사 실패는 명시적으로 전달하고 다음 유효한 검사에서 회복한다", async () => {
  // 설정 오류를 기본 30일 정책으로 바꿔 삭제하지 않는다.
  let valid = false;
  const outcomes: string[] = [];
  const scheduler = new RetentionScheduler(async () => valid ? ok(0) : err(new InputError("Invalid retention policy")), result => outcomes.push(result.ok ? "ok" : result.error.code), error => { throw error; }, () => () => {});

  // 같은 런타임에서 정책 파일이 고쳐진 다음 검사를 재개할 수 있다.
  await scheduler.start(); valid = true; await scheduler.run(); await scheduler.stop();

  expect(outcomes).toEqual(["INVALID_INPUT", "ok"]);
});
