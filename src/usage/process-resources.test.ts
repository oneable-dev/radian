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

test("CPU intervals normalize UI and Runtime against whole-machine capacity before summing", () => {
  // Eight logical CPUs provide eight CPU seconds per wall-clock second.
  const history = new ResourceHistory(8);
  const initial = history.add(sample(1, 1000, 100000, 85), sample(2, 9000, 200000, 320), 0);

  // Process-specific clocks and cumulative counters still define independent interval deltas.
  const current = history.add(sample(1, 2000, 350000, 90), sample(2, 10000, 1700000, 330), 1000);

  // Normalize each process once; preserve unknown initial CPU readings and the unchanged RSS sum.
  expect(initial.total).toEqual({ cpuPercent: null, rssBytes: 405 });
  expect(current.ui).toEqual({ cpuPercent: 3.125, rssBytes: 90 });
  expect(current.runtime).toEqual({ cpuPercent: 18.75, rssBytes: 330 });
  expect(current.total).toEqual({ cpuPercent: 21.875, rssBytes: 420 });
  expect(history.recent.at(-1)?.total).toEqual(current.total);
});

test.each([
  { cpuCount: 8, elapsedMs: 1000, cpuMicros: 0, expected: 0 },
  { cpuCount: 8, elapsedMs: 1000, cpuMicros: 1000000, expected: 12.5 },
  { cpuCount: 8, elapsedMs: 250, cpuMicros: 250000, expected: 12.5 },
  { cpuCount: 8, elapsedMs: 1000, cpuMicros: 3000000, expected: 37.5 },
  { cpuCount: 8, elapsedMs: 1000, cpuMicros: 8000000, expected: 100 },
  { cpuCount: 1, elapsedMs: 1000, cpuMicros: 1000000, expected: 100 },
])(
  "$cpuMicros CPU microseconds over $elapsedMs ms on $cpuCount logical CPUs reports $expected percent",
  ({ cpuCount, elapsedMs, cpuMicros, expected }) => {
    // Idle, single-core and multicore work share the same whole-machine denominator.
    const history = new ResourceHistory(cpuCount);
    history.add(sample(1, 1000, 100), sample(2, 1000, 200), 0);

    // Keep UI idle so the Runtime contribution also defines the expected Total.
    const current = history.add(
      sample(1, 1000 + elapsedMs, 100),
      sample(2, 1000 + elapsedMs, 200 + cpuMicros),
      elapsedMs,
    );

    // Interval length must not change the share, and full-machine work must equal 100%.
    expect(current.ui?.cpuPercent).toBe(0);
    expect(current.runtime?.cpuPercent).toBe(expected);
    expect(current.total?.cpuPercent).toBe(expected);
  },
);

test("Unavailable logical CPU counts leave CPU unknown without hiding resident memory", () => {
  // An OS without CPU topology cannot provide a trustworthy whole-machine percentage.
  const history = new ResourceHistory(0);
  history.add(sample(1, 1000, 0), sample(2, 1000, 0), 0);

  // Valid interval counters do not make an unavailable denominator safe to guess.
  const current = history.add(sample(1, 2000, 1000000, 85), sample(2, 2000, 3000000, 320), 1000);

  // Unknown CPU must remain distinct from zero while memory stays available.
  expect(current.ui).toEqual({ cpuPercent: null, rssBytes: 85 });
  expect(current.runtime).toEqual({ cpuPercent: null, rssBytes: 320 });
  expect(current.total).toEqual({ cpuPercent: null, rssBytes: 405 });
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
