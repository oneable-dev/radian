import { expect, spyOn, test } from "bun:test";
import { capture, CleanupError, collectCleanup, ConnectionError, ExpectedError, HistoryError, InputError, SessionError, StorageError, withCleanup } from "./errors.ts";
import { err, ok } from "./result.ts";
import { expectError, expectOk } from "./testing/results.ts";
import { RuntimeClient, fetchSnapshot } from "./runtime/client.ts";
import { runtimePaths } from "./runtime/storage.ts";
import { emptyPreferences, errorStatus, parseCommand, protocolVersion, type RuntimeSnapshot } from "./runtime/protocol.ts";
import { SessionRegistry } from "./agents/session-registry.ts";
import { demoWorkspace } from "./workspace/demo.ts";

const paths = runtimePaths("/fixture/.git", true, "/tmp/radian-result-unit-test");
const snapshot = (): RuntimeSnapshot => ({ version: protocolVersion, pid: process.pid, instance: "test", repositoryId: "/fixture/.git", mode: "offline",
  repositories: [], details: {}, closingCount: 0, preferences: structuredClone(emptyPreferences), notice: "", capabilities: ["typed-errors", "history"] });

test("예상 파일 오류는 custom error Result에 원인과 코드를 보존한다", async () => {
  // An OS error has a stable code; its human message is not a classification key.
  const original = Object.assign(new Error("permission text may vary"), { code: "EACCES" });

  // Only the OS boundary translates it into a value.
  const error = expectError(await capture(async () => { throw original; }));

  // Callers can branch on the type/code and diagnostics still have the exact cause.
  expect(error).toBeInstanceOf(StorageError);
  expect(error.code).toBe("STORAGE_FAILED");
  expect(error.cause).toBe(original);
});

test("예상하지 못한 TypeError는 Result 실패나 서비스 부재로 숨기지 않는다", async () => {
  // A programming defect is distinct from a missing Unix socket.
  const original = new TypeError("unexpected defect");
  const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(original);
  try {
    // Both external-boundary helpers preserve the exception object.
    await expect(capture(async () => { throw original; })).rejects.toBe(original);
    await expect(fetchSnapshot(paths)).rejects.toBe(original);

    // No replacement error destroys the originating stack.
    expect(original.stack).toContain("unexpected defect");
  } finally { fetchMock.mockRestore(); }
});

for (const [code, expected] of [["ENOENT", null], ["ECONNREFUSED", null], ["EACCES", "CONNECTION_FAILED"], ["ETIMEDOUT", "CONNECTION_TIMEOUT"]] as const) {
  test(`snapshot 조회의 ${code}는 부재와 연결 실패를 구분한다`, async () => {
    // Only absent/refused endpoints authorize bootstrap; permissions/timeouts must not do so.
    const failure = Object.assign(new Error("same message"), { code });
    const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(failure);
    try {
      const result = await fetchSnapshot(paths);

      // Classification follows the stable OS contract, not the shared message text.
      if (expected === null) expect(expectOk(result)).toBeNull();
      else {
        const error = expectError(result);
        expect(error).toBeInstanceOf(ConnectionError);
        expect(error.code).toBe(expected);
        expect(error.cause).toBe(failure);
      }
    } finally { fetchMock.mockRestore(); }
  });
}

test("IPC 오류 코드는 클라이언트까지 보존되고 legacy 문자열은 임의로 분류하지 않는다", async () => {
  // A remote session conflict and an old daemon string error have different guarantees.
  const fetchMock = spyOn(globalThis, "fetch");
  const client = new RuntimeClient(paths, snapshot());
  try {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error: { code: "SESSION_BUSY", message: "localized text", outcome: "rejected" } }, { status: 409 }));
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error: "Session is busy" }, { status: 400 }));

    // Public methods return Result rather than rethrowing a newly constructed generic Error.
    const typed = expectError(await client.prompt("id", "run"));
    const legacy = expectError(await client.prompt("id", "run"));

    expect(typed.code).toBe("SESSION_BUSY");
    expect(legacy.code).toBe("LEGACY_REMOTE_ERROR");
  } finally { fetchMock.mockRestore(); await client.disconnect(); }
});

test("변경 요청 timeout은 작업 취소나 rollback 성공을 뜻하지 않는다", async () => {
  // A request might have been accepted before the acknowledgement was lost.
  const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("expired", "TimeoutError"));
  const client = new RuntimeClient(paths, snapshot());
  try {
    // The caller receives an uncertainty diagnostic and must not retry blindly.
    const error = expectError(await client.prompt("id", "run"));

    expect(error.code).toBe("CONNECTION_TIMEOUT");
    expect(error.message).toContain("outcome is unknown");
  } finally { fetchMock.mockRestore(); await client.disconnect(); }
});

test("저장 경고가 있는 수락 응답은 실패 Result로 바뀌지 않고 사용자 경고를 유지한다", async () => {
  // Persistence failed after execution was accepted; retrying would be unsafe.
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, value: null,
    warnings: [{ code: "STORAGE_FAILED", message: "Checkpoint unavailable", outcome: "rejected" }] }));
  const client = new RuntimeClient(paths, snapshot());
  try {
    expectOk(await client.prompt("id", "run"));

    // Accepted work and durability warning are separate, observable outcomes.
    expect(client.snapshot.notice).toContain("Action accepted");
    expect(client.snapshot.notice).toContain("Checkpoint unavailable");
  } finally { fetchMock.mockRestore(); await client.disconnect(); }
});

test("작업과 정리가 모두 실패하면 원래 오류와 cleanup 오류를 함께 보존한다", async () => {
  // Cleanup cannot replace an unexpected defect's stack with a second generic message.
  const original = new TypeError("original defect"); const cleanup = new StorageError("cleanup failed");

  const failure = await withCleanup(async () => { throw original; }, async () => { throw cleanup; }).then(() => null, (error: unknown) => error);

  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) throw new Error("Missing aggregate");
  expect(failure.errors).toEqual([original, cleanup]);
});

test("여러 예상 종료 실패는 CleanupError Result로 집계하고 내부 버그는 예외로 전파한다", async () => {
  // Every owned cleanup is awaited, regardless of earlier failures.
  const a = new StorageError("a"), b = new SessionError("SESSION_CONFLICT", "b");
  const unexpected = new TypeError("cleanup defect");

  const result = await collectCleanup([Promise.resolve(err(a)), Promise.resolve(err(b)), Promise.resolve(ok(undefined))], "close failed");
  const error = expectError(result);

  expect(error).toBeInstanceOf(CleanupError);
  if (!(error instanceof CleanupError)) throw new Error("Missing cleanup failure");
  expect(error.errors).toEqual([a, b]);
  await expect(collectCleanup([Promise.reject(unexpected)], "close failed")).rejects.toBeInstanceOf(AggregateError);
});

test("파싱·도메인 거절·외부 장애는 서로 다른 오류 코드와 HTTP 상태를 갖는다", () => {
  // Invalid syntax is not the same failure as a busy session or storage outage.
  const parsed = parseCommand("{ invalid");

  // This is a pure contract check; no daemon needs to execute anything.
  const input = expectError(parsed);

  expect(input).toBeInstanceOf(InputError);
  expect(errorStatus(input)).toBe(400);
  expect(errorStatus(new SessionError("SESSION_BUSY", "busy"))).toBe(409);
  expect(errorStatus(new HistoryError("HISTORY_UNAVAILABLE", "missing"))).toBe(404);
  expect(errorStatus(new StorageError("disk"))).toBe(500);
});

test("registry의 예상 실패는 reject하지 않고 typed Result로 호출자가 분기할 수 있다", async () => {
  // A session ID is user/runtime state, so absence is an ordinary domain outcome.
  const registry = new SessionRegistry(demoWorkspace(), async () => { throw new Error("factory must not run"); });

  const result = await registry.prompt("missing", "run");

  expect(expectError(result)).toBeInstanceOf(ExpectedError);
  expect(expectError(result).code).toBe("SESSION_NOT_OPEN");
  expectOk(await registry.shutdown());
});

test("factory 내부 버그는 예상 생성 실패로 바꾸지 않고 동일 예외로 전파한다", async () => {
  // No executor was constructed, so cleanup must release only the reservation.
  const defect = new TypeError("factory defect");
  const registry = new SessionRegistry(demoWorkspace(), async () => { throw defect; });

  // Unexpected bugs remain rejected promises, unlike normal domain Results.
  await expect(registry.create("demo:main")).rejects.toBe(defect);

  // Removing the failed reservation does not swallow the original or create a ghost session.
  expect(registry.closingCount).toBe(0);
  expect(registry.snapshot[0]?.worktrees[0]?.sessions).toEqual([]);
  expectOk(await registry.shutdown());
});
