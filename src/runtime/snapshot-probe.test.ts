import { expect, test } from "bun:test";
import { CancelledError, ConnectionError, ProtocolError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { expectError, expectOk } from "../testing/results.ts";
import type { RuntimeSnapshot } from "./protocol.ts";
import { probeSnapshot } from "./snapshot-probe.ts";
import { daemonPaths } from "./storage.ts";

const paths = daemonPaths(true, "/tmp/radian-snapshot-probe-unit");
const timeout = new ConnectionError("CONNECTION_TIMEOUT", "fixture timeout");

function fixture(
  observe: (timeoutMs: number) => Promise<Result<RuntimeSnapshot | null, ExpectedError>>,
  random = 0.5,
) {
  let now = 0;
  const attempts: number[] = [];
  const waits: number[] = [];
  return {
    attempts,
    waits,
    elapsed: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    dependencies: {
      now: () => now,
      random: () => random,
      sleep: async (milliseconds: number) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
      fetchSnapshot: async (_paths: typeof paths, timeoutMs = 500) => {
        attempts.push(timeoutMs);
        return observe(timeoutMs);
      },
    },
  };
}

test("A failed observation retries until the deadline without trailing backoff", async () => {
  // A fixed clock and midpoint jitter expose the entire retry schedule; each timeout uses its budget.
  const probe = fixture(async (milliseconds) => {
    probe.advance(milliseconds);
    return err(timeout);
  });

  const failure = expectError(await probeSnapshot(paths, 15000, probe.dependencies));

  // The last timeout and jitter bound repeat; remaining time caps the final request.
  expect(probe.attempts).toEqual([500, 1000, 2000, 2000, 2000, 2000, 2000, 2000, 150]);
  expect(probe.waits).toEqual([50, 100, 200, 200, 200, 200, 200, 200]);
  expect(failure.cause).toBe(timeout);
  expect(failure.message).toContain("not confirmed");
});

for (const random of [0, 0.999999]) {
  test(`Full jitter stays within each retry bound with randomness ${random}`, async () => {
    // Exercise both ends of full jitter without wall-clock waits.
    const probe = fixture(async (milliseconds) => {
      probe.advance(milliseconds);
      return err(timeout);
    }, random);

    await probeSnapshot(paths, 15000, probe.dependencies);

    expect(probe.waits.slice(0, 4)).toEqual(
      random === 0 ? [] : [99.9999, 199.9998, 399.9996, 399.9996],
    );
    expect(probe.waits.every((wait) => wait < 400)).toBe(true);
  });
}

test("Success and runtime absence stop immediately without waiting", async () => {
  // Absence is a successful observation, not a transient connection failure.
  const probe = fixture(async () => ok(null));

  expect(expectOk(await probeSnapshot(paths, 15000, probe.dependencies))).toBeNull();

  expect(probe.attempts).toEqual([500]);
  expect(probe.waits).toEqual([]);
});

test("A successful retry ends the failed sequence", async () => {
  let attempts = 0;
  const probe = fixture(async () => (++attempts === 1 ? err(timeout) : ok(null)));

  expect(expectOk(await probeSnapshot(paths, 15000, probe.dependencies))).toBeNull();

  expect(probe.attempts).toEqual([500, 1000]);
  expect(probe.waits).toEqual([50]);
});

test("Attempt timeouts and backoff share the remaining phase budget", async () => {
  // The first failed request consumes most of a short remaining deadline.
  const probe = fixture(async (milliseconds) => {
    probe.advance(milliseconds);
    return err(timeout);
  });

  await probeSnapshot(paths, 570, probe.dependencies);

  expect(probe.attempts).toEqual([500, 20]);
  expect(probe.waits).toEqual([50]);
});

test("Backoff cannot schedule a request past the deadline", async () => {
  const probe = fixture(async (milliseconds) => {
    probe.advance(milliseconds);
    return err(timeout);
  });

  await probeSnapshot(paths, 520, probe.dependencies);

  expect(probe.attempts).toEqual([500]);
  expect(probe.waits).toEqual([20]);
});

test("An expired phase does not start any HTTP request", async () => {
  const probe = fixture(async () => ok(null));

  expect(expectError(await probeSnapshot(paths, 0, probe.dependencies)).code).toBe(
    "CONNECTION_TIMEOUT",
  );

  expect(probe.attempts).toEqual([]);
  expect(probe.waits).toEqual([]);
});

for (const code of ["ECONNRESET", "EPIPE", "EACCES", "EPERM", "EIO"]) {
  test(`Connection failure classification uses the preserved OS cause ${code}`, async () => {
    const failure = new ConnectionError("CONNECTION_FAILED", "fixture failure", {
      cause: Object.assign(new Error("OS failure"), { code }),
    });
    const probe = fixture(async () => err(failure));

    const observed = expectError(await probeSnapshot(paths, 15000, probe.dependencies));

    const transient = code === "ECONNRESET" || code === "EPIPE";
    if (transient) {
      // Transient failures keep retrying for the whole phase budget.
      expect(probe.elapsed()).toBe(15000);
      expect(observed.cause).toBe(failure);
    } else {
      expect(probe.attempts).toHaveLength(1);
      expect(observed).toBe(failure);
    }
  });
}

for (const failure of [
  new CancelledError(),
  new ProtocolError("identity mismatch"),
  new ConnectionError("CONNECTION_FAILED", "no OS cause"),
]) {
  test(`Terminal ${failure.code} errors retain their original object`, async () => {
    const probe = fixture(async () => err(failure));

    expect(expectError(await probeSnapshot(paths, 15000, probe.dependencies))).toBe(failure);

    expect(probe.attempts).toEqual([500]);
    expect(probe.waits).toEqual([]);
  });
}

test("Unexpected exceptions retain their object and stack without retry", async () => {
  const defect = new TypeError("fixture defect");
  const probe = fixture(async () => {
    throw defect;
  });

  await expect(probeSnapshot(paths, 15000, probe.dependencies)).rejects.toBe(defect);

  expect(probe.attempts).toEqual([500]);
  expect(probe.waits).toEqual([]);
});
