import { expect, test } from "bun:test";
import { formatRunCompletion, sameRunCompletion } from "./run-completion.ts";
import { parseRunCompletion, type RunCompletion } from "../run-completion.ts";
import { expectError } from "../../testing/results.ts";

const completion: RunCompletion = {
  startedAt: Date.UTC(2026, 8, 19, 10, 53, 30),
  completedAt: Date.UTC(2026, 8, 19, 10, 55),
  durationMs: 90000,
  outcome: "complete",
};

test.each([
  [0, "<1s"],
  [999, "<1s"],
  [1000, "1s"],
  [59999, "59s"],
  [60000, "1m 0s"],
  [90000, "1m 30s"],
  [3661000, "1h 1m 1s"],
] as const)("Run duration %ims displays in readable units: %s", (durationMs, text) => {
  // Display measured processing time, not execution limits or current time.
  const formatted = formatRunCompletion({ ...completion, durationMs }, "UTC");
  expect(formatted).toBe(`Worked for ${text} • Sep 19 at 10:55 AM`);
});

test.each([
  ["error", "Failed after"],
  ["cancelled", "Cancelled after"],
  ["unfinished", "Stopped after"],
] as const)(
  "Normal completion and other termination outcomes use different wording: %s",
  (outcome, label) => {
    expect(formatRunCompletion({ ...completion, outcome }, "UTC")).toBe(
      `${label} 1m 30s • Sep 19 at 10:55 AM`,
    );
  },
);

test("Identical completion epochs display dates in the UI timezone", () => {
  const late = { ...completion, completedAt: Date.UTC(2026, 8, 19, 23, 55) };
  expect(formatRunCompletion(late, "UTC")).toBe("Worked for 1m 30s • Sep 19 at 11:55 PM");
  expect(formatRunCompletion(late, "Asia/Seoul")).toBe("Worked for 1m 30s • Sep 20 at 8:55 AM");
});

test("Cloned completion values remain equal while outcome and warning changes remain distinct", () => {
  expect(sameRunCompletion(completion, { ...completion })).toBe(true);
  expect(sameRunCompletion(undefined, undefined)).toBe(true);
  expect(sameRunCompletion(completion, undefined)).toBe(false);
  expect(sameRunCompletion(completion, { ...completion, outcome: "error" })).toBe(false);
  expect(sameRunCompletion(completion, { ...completion, warning: "STORAGE_FAILED" })).toBe(false);
});

test.each([
  { durationMs: -1 },
  { durationMs: "90000" },
  { completedAt: 8640000000000001 },
  { outcome: "working" },
  { warning: "x".repeat(513) },
])("Invalid saved completion metadata returns explicit corruption Results: %j", (invalid) => {
  expect(expectError(parseRunCompletion({ ...completion, ...invalid })).code).toBe(
    "HISTORY_CORRUPT",
  );
});
