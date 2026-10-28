import { expect, spyOn, test } from "bun:test";
import { expectError, expectOk } from "../testing/results.ts";
import {
  readProcessResources,
  ResourceHistory,
  type ProcessResourceSample,
} from "./process-resources.ts";

const sample = (
  pid: number,
  elapsedMs: number,
  cpuMicros: number,
  rssBytes = 100,
): ProcessResourceSample => ({ pid, elapsedMs, cpuMicros, rssBytes });

test("Process resources report only the current PID and resident memory", () => {
  // No OS process listing or child traversal is needed to read our own counters.
  const result = expectOk(readProcessResources());

  // CPU counters and the monotonic clock provide an interval baseline, not a lifetime percentage.
  expect(result.pid).toBe(process.pid);
  expect(result.rssBytes).toBeGreaterThan(0);
  expect(result.cpuMicros).toBeGreaterThanOrEqual(0);
  expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
});

test("OS counter failures preserve their cause as typed resource failures", () => {
  // A failed OS boundary must not be rendered as zero usage.
  const cause = new Error("Counter unavailable");
  const cpu = spyOn(process, "cpuUsage").mockImplementation(() => {
    throw cause;
  });
  try {
    const result = expectError(readProcessResources());

    // Keep the failure code stable and the diagnostic cause intact.
    expect(result.code).toBe("RESOURCE_UNAVAILABLE");
    expect(result.cause).toBe(cause);
  } finally {
    cpu.mockRestore();
  }
});

test("CPU intervals sum UI and Runtime using one-core percentages without a 100 percent cap", () => {
  // Different cumulative counters share a one-second sampling interval.
  const history = new ResourceHistory();
  const initial = history.add(sample(1, 1000, 100000, 85), sample(2, 9000, 200000, 320), 0);

  const current = history.add(sample(1, 2000, 350000, 90), sample(2, 10000, 1700000, 330), 1000);

  // The first CPU reading is unknown; subsequent 25% and 150% sum to 175%, not a machine-normalized ratio.
  expect(initial.total).toEqual({ cpuPercent: null, rssBytes: 405 });
  expect(current.ui).toEqual({ cpuPercent: 25, rssBytes: 90 });
  expect(current.runtime).toEqual({ cpuPercent: 150, rssBytes: 330 });
  expect(current.total).toEqual({ cpuPercent: 175, rssBytes: 420 });
});

test("Missing Runtime readings clear totals and require a fresh CPU baseline after recovery", () => {
  // An unavailable Runtime cannot be represented as a successful zero contribution.
  const history = new ResourceHistory();
  history.add(sample(1, 1000, 100), sample(2, 1000, 100), 0);

  const missing = history.add(sample(1, 2000, 200), null, 1000);
  const recovered = history.add(sample(1, 3000, 300), sample(2, 3000, 300), 2000);

  // UI remains observable while totals stay unknown until both CPU intervals are known again.
  expect(missing.ui?.rssBytes).toBe(100);
  expect(missing.runtime).toBeNull();
  expect(missing.total).toBeNull();
  expect(recovered.total).toEqual({ cpuPercent: null, rssBytes: 200 });
});

test("Runtime restarts and invalid intervals never produce negative or lifetime CPU readings", () => {
  // PID changes, clock resets and decreasing counters all invalidate a CPU baseline.
  for (const current of [
    sample(3, 2000, 200),
    sample(2, 500, 200),
    sample(2, 2000, 50),
    sample(2, 1000, 200),
  ]) {
    const history = new ResourceHistory();
    history.add(sample(1, 1000, 100), sample(2, 1000, 100), 0);

    const next = history.add(sample(1, 2000, 200), current, 1000);

    expect(next.runtime?.cpuPercent).toBeNull();
    expect(next.total?.cpuPercent).toBeNull();
  }
});

test("Recent resource samples stay bounded by time and count without double-counting the UI PID", () => {
  // The rolling view is transient and cannot accumulate an unbounded session history.
  const history = new ResourceHistory();
  for (let second = 0; second <= 120; second++) {
    history.add(
      sample(1, second * 1000, second * 100),
      sample(2, second * 1000, second * 200),
      second * 1000,
    );
  }

  history.add(sample(1, 121000, 13000), sample(1, 121000, 13000), 121000);

  // Retain only the last minute and reject an accidental duplicate process instead of summing it twice.
  expect(history.recent).toHaveLength(60);
  expect(history.recent[0]?.at).toBe(62000);
  expect(history.recent.at(-1)?.total).toBeNull();
});
