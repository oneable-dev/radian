import { expect, spyOn, test } from "bun:test";
import {
  capture,
  CleanupError,
  collectCleanup,
  ConnectionError,
  ExpectedError,
  HistoryError,
  InputError,
  SessionError,
  StorageError,
  withCleanup,
} from "./errors.ts";
import { err, ok } from "./result.ts";
import { expectError, expectOk } from "./testing/results.ts";
import { RuntimeClient, fetchSnapshot } from "./runtime/client.ts";
import { runtimePaths } from "./runtime/storage.ts";
import {
  emptyPreferences,
  errorStatus,
  parseCommand,
  protocolVersion,
  type RuntimeSnapshot,
} from "./runtime/protocol.ts";
import { SessionRegistry } from "./agents/session-registry.ts";
import { demoWorkspace } from "./workspace/demo.ts";

const paths = runtimePaths("/fixture/.git", true, "/tmp/radian-result-unit-test");
const snapshot = (): RuntimeSnapshot => ({
  version: protocolVersion,
  pid: process.pid,
  instance: "test",
  repositoryId: "/fixture/.git",
  mode: "offline",
  repositories: [],
  details: {},
  closingCount: 0,
  preferences: structuredClone(emptyPreferences),
  notice: "",
  capabilities: ["typed-errors", "history"],
});

test("Expected file failures retain causes and codes in custom error Results", async () => {
  // An OS error has a stable code; its human message is not a classification key.
  const original = Object.assign(new Error("permission text may vary"), { code: "EACCES" });

  // Only the OS boundary translates it into a value.
  const error = expectError(
    await capture(async () => {
      throw original;
    }),
  );

  // Callers can branch on the type/code and diagnostics still have the exact cause.
  expect(error).toBeInstanceOf(StorageError);
  expect(error.code).toBe("STORAGE_FAILED");
  expect(error.cause).toBe(original);
});

test("Unexpected TypeErrors never become failure Results or service absence", async () => {
  // A programming defect is distinct from a missing Unix socket.
  const original = new TypeError("unexpected defect");
  const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(original);
  try {
    // Both external-boundary helpers preserve the exception object.
    await expect(
      capture(async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    await expect(fetchSnapshot(paths)).rejects.toBe(original);

    // No replacement error destroys the originating stack.
    expect(original.stack).toContain("unexpected defect");
  } finally {
    fetchMock.mockRestore();
  }
});

for (const [code, expected] of [
  ["ENOENT", null],
  ["ECONNREFUSED", null],
  ["EACCES", "CONNECTION_FAILED"],
  ["ETIMEDOUT", "CONNECTION_TIMEOUT"],
] as const) {
  test(`Snapshot lookup ${code} distinguishes absence from connection failure`, async () => {
    // Only absent/refused endpoints authorize bootstrap; permissions/timeouts must not do so.
    const failure = Object.assign(new Error("same message"), { code });
    const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(failure);
    try {
      const result = await fetchSnapshot(paths);

      // Classification follows the stable OS contract, not the shared message text.
      if (expected === null) {
        expect(expectOk(result)).toBeNull();
      } else {
        const error = expectError(result);
        expect(error).toBeInstanceOf(ConnectionError);
        expect(error.code).toBe(expected);
        expect(error.cause).toBe(failure);
      }
    } finally {
      fetchMock.mockRestore();
    }
  });
}

test("IPC codes survive to clients without arbitrary classification of legacy strings", async () => {
  // A remote session conflict and an old daemon string error have different guarantees.
  const fetchMock = spyOn(globalThis, "fetch");
  const client = new RuntimeClient(paths, snapshot());
  try {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          ok: false,
          error: { code: "SESSION_BUSY", message: "localized text", outcome: "rejected" },
        },
        { status: 409 },
      ),
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({ ok: false, error: "Session is busy" }, { status: 400 }),
    );

    // Public methods return Result rather than rethrowing a newly constructed generic Error.
    const typed = expectError(await client.prompt("id", "run"));
    const legacy = expectError(await client.prompt("id", "run"));

    expect(typed.code).toBe("SESSION_BUSY");
    expect(legacy.code).toBe("LEGACY_REMOTE_ERROR");
  } finally {
    fetchMock.mockRestore();
    await client.disconnect();
  }
});

test("Mutation timeouts imply neither cancellation nor successful rollback", async () => {
  // A request might have been accepted before the acknowledgement was lost.
  const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(
    new DOMException("expired", "TimeoutError"),
  );
  const client = new RuntimeClient(paths, snapshot());
  try {
    // The caller receives an uncertainty diagnostic and must not retry blindly.
    const error = expectError(await client.prompt("id", "run"));

    expect(error.code).toBe("CONNECTION_TIMEOUT");
    expect(error.message).toContain("outcome is unknown");
  } finally {
    fetchMock.mockRestore();
    await client.disconnect();
  }
});

test("Accepted responses with persistence warnings stay successful and preserve warnings", async () => {
  // Persistence failed after execution was accepted; retrying would be unsafe.
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      ok: true,
      value: null,
      warnings: [
        { code: "STORAGE_FAILED", message: "Checkpoint unavailable", outcome: "rejected" },
      ],
    }),
  );
  const client = new RuntimeClient(paths, snapshot());
  try {
    expectOk(await client.prompt("id", "run"));

    // Accepted work and durability warning are separate, observable outcomes.
    expect(client.snapshot.notice).toContain("Action accepted");
    expect(client.snapshot.notice).toContain("Checkpoint unavailable");
  } finally {
    fetchMock.mockRestore();
    await client.disconnect();
  }
});

test("Successful operations finish cleanup before returning the original value", async () => {
  // Cleanup belongs to the operation even when no exception needs propagation.
  const value = { saved: true };
  const events: string[] = [];

  // Record both phases through the public cleanup boundary.
  const result = await withCleanup(
    async () => {
      events.push("operation");

      return value;
    },
    async () => {
      events.push("cleanup");
    },
  );

  // The caller receives the exact value only after cleanup has completed.
  expect(result).toBe(value);
  expect(events).toEqual(["operation", "cleanup"]);
});

test.each([new TypeError("original defect"), undefined])(
  "Successful cleanup preserves the original rejection: %s",
  async (original) => {
    // Even an undefined rejection must remain distinct from a successful operation.
    let cleaned = false;

    // A successful cleanup must not replace the original failure.
    const operation = withCleanup(
      async () => {
        throw original;
      },
      async () => {
        cleaned = true;
      },
    );

    // Both the rejection identity and cleanup completion are observable contracts.
    await expect(operation).rejects.toBe(original);
    expect(cleaned).toBe(true);
  },
);

test("Cleanup failures after successful operations preserve the cleanup exception", async () => {
  // There is no original operation failure to aggregate with this cleanup defect.
  const cleanup = new TypeError("cleanup defect");

  const operation = withCleanup(
    async () => "saved",
    async () => {
      throw cleanup;
    },
  );

  // Preserve the original object and stack instead of inventing an aggregate.
  await expect(operation).rejects.toBe(cleanup);
});

test("Operation and cleanup failures preserve both original and cleanup errors", async () => {
  // Cleanup cannot replace an unexpected defect's stack with a second generic message.
  const original = new TypeError("original defect");
  const cleanup = new StorageError("cleanup failed");

  const failure = await withCleanup(
    async () => {
      throw original;
    },
    async () => {
      throw cleanup;
    },
  ).then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) {
    throw new Error("Missing aggregate");
  }

  expect(failure.errors).toEqual([original, cleanup]);
});

test("Expected shutdown failures aggregate into CleanupError Results while bugs remain exceptions", async () => {
  // Every owned cleanup is awaited, regardless of earlier failures.
  const a = new StorageError("a");
  const b = new SessionError("SESSION_CONFLICT", "b");
  const unexpected = new TypeError("cleanup defect");

  const result = await collectCleanup(
    [Promise.resolve(err(a)), Promise.resolve(err(b)), Promise.resolve(ok(undefined))],
    "close failed",
  );
  const error = expectError(result);

  expect(error).toBeInstanceOf(CleanupError);
  if (!(error instanceof CleanupError)) {
    throw new Error("Missing cleanup failure");
  }

  expect(error.errors).toEqual([a, b]);
  await expect(collectCleanup([Promise.reject(unexpected)], "close failed")).rejects.toBeInstanceOf(
    AggregateError,
  );
});

test("Parsing, domain rejection, and external failures have distinct codes and HTTP statuses", () => {
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

test("Expected registry failures return typed Results rather than rejecting", async () => {
  // A session ID is user/runtime state, so absence is an ordinary domain outcome.
  const registry = new SessionRegistry(demoWorkspace(), async () => {
    throw new Error("factory must not run");
  });

  const result = await registry.prompt("missing", "run");

  expect(expectError(result)).toBeInstanceOf(ExpectedError);
  expect(expectError(result).code).toBe("SESSION_NOT_OPEN");
  expectOk(await registry.shutdown());
});

test("Factory bugs propagate identical exceptions instead of becoming expected creation failures", async () => {
  // No executor was constructed, so cleanup must release only the reservation.
  const defect = new TypeError("factory defect");
  const registry = new SessionRegistry(demoWorkspace(), async () => {
    throw defect;
  });

  // Unexpected bugs remain rejected promises, unlike normal domain Results.
  await expect(registry.create("demo:main")).rejects.toBe(defect);

  // Removing the failed reservation does not swallow the original or create a ghost session.
  expect(registry.closingCount).toBe(0);
  expect(registry.snapshot[0]?.worktrees[0]?.sessions).toEqual([]);
  expectOk(await registry.shutdown());
});
