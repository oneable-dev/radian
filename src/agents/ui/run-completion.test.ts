import { expect, test } from "bun:test";
import { formatRunCompletion, sameRunCompletion } from "./run-completion.ts";
import { parseRunCompletion, type RunCompletion } from "../run-completion.ts";
import { expectError } from "../../testing/results.ts";

const completion: RunCompletion = { startedAt: Date.UTC(2026, 8, 19, 10, 53, 30), completedAt: Date.UTC(2026, 8, 19, 10, 55), durationMs: 90000, outcome: "complete" };

test.each([[0, "<1s"], [999, "<1s"], [1000, "1s"], [59999, "59s"], [60000, "1m 0s"], [90000, "1m 30s"], [3661000, "1h 1m 1s"]] as const)("실행 시간 %ims를 읽을 수 있는 단위로 표시한다: %s", (durationMs, text) => {
  // 실행 제한이나 현재 시각이 아니라 측정된 처리 시간을 표시한다.
  const formatted = formatRunCompletion({ ...completion, durationMs }, "UTC");
  expect(formatted).toBe(`Worked for ${text} • Sep 19 at 10:55 AM`);
});

test.each([["error", "Failed after"], ["cancelled", "Cancelled after"], ["unfinished", "Stopped after"]] as const)("정상 완료와 다른 종료는 다른 문구로 표시한다: %s", (outcome, label) => {
  expect(formatRunCompletion({ ...completion, outcome }, "UTC")).toBe(`${label} 1m 30s • Sep 19 at 10:55 AM`);
});

test("동일한 완료 epoch는 표시하는 UI의 시간대에 맞춰 날짜까지 바뀐다", () => {
  const late = { ...completion, completedAt: Date.UTC(2026, 8, 19, 23, 55) };
  expect(formatRunCompletion(late, "UTC")).toBe("Worked for 1m 30s • Sep 19 at 11:55 PM");
  expect(formatRunCompletion(late, "Asia/Seoul")).toBe("Worked for 1m 30s • Sep 20 at 8:55 AM");
});

test("전송으로 복제된 같은 완료 값은 변경으로 취급하지 않되 결과·경고 변경은 구분한다", () => {
  expect(sameRunCompletion(completion, { ...completion })).toBe(true);
  expect(sameRunCompletion(undefined, undefined)).toBe(true);
  expect(sameRunCompletion(completion, undefined)).toBe(false);
  expect(sameRunCompletion(completion, { ...completion, outcome: "error" })).toBe(false);
  expect(sameRunCompletion(completion, { ...completion, warning: "STORAGE_FAILED" })).toBe(false);
});

test.each([{ durationMs: -1 }, { durationMs: "90000" }, { completedAt: 8640000000000001 }, { outcome: "working" }, { warning: "x".repeat(513) }])("저장 완료 메타데이터의 잘못된 값은 명시적인 손상 Result로 거절한다: %j", (invalid) => {
  expect(expectError(parseRunCompletion({ ...completion, ...invalid })).code).toBe("HISTORY_CORRUPT");
});
