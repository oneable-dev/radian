import { expect, test } from "bun:test";
import { emptyPreferences, parseSnapshot } from "../runtime/protocol.ts";
import { expectError, expectOk } from "../testing/results.ts";
import type { SessionTelemetry } from "./telemetry.ts";

const legacy = { version: 1, pid: 123, instance: "instance", mode: "offline", repositoryId: "repo", repositories: [],
  details: { session: { status: null, output: "legacy", error: null } }, closingCount: 0, preferences: emptyPreferences, notice: "" };
const telemetry: SessionTelemetry = { provider: "openai-codex", model: "gpt-5.5", effort: "high", fast: null,
  context: { usedTokens: null, maxTokens: 200000 }, weekly: { remainingPercent: 82, observedAt: 1800000000000, resetsAt: 1800003600000 } };
const snapshot = (value: unknown) => ({ ...legacy, details: { session: { ...legacy.details.session, telemetry: value } } });

test("텔레메트리는 선택적 wire 필드이며 미확정 값과 소수 잔량을 직렬화한다", () => {
  // Old runtimes lack telemetry entirely; a new runtime can report unknown context after compaction.
  const stored = JSON.parse(JSON.stringify(snapshot({ ...telemetry, weekly: { ...telemetry.weekly, remainingPercent: 82.5 } })));

  const old = expectOk(parseSnapshot(legacy));
  const fresh = expectOk(parseSnapshot(stored));

  expect(old.details.session?.telemetry).toBeUndefined();
  expect(fresh.details.session?.telemetry?.context?.usedTokens).toBeNull();
  expect(fresh.details.session?.telemetry?.fast).toBeNull();
  expect(fresh.details.session?.telemetry?.weekly?.remainingPercent).toBe(82.5);
});

test("잘못된 잔량·토큰·타임스탬프는 IPC 경계에서 typed 프로토콜 오류로 거부한다", () => {
  // A private local endpoint still receives untyped JSON, not a trusted SDK object.
  const invalid = [
    { ...telemetry, weekly: { ...telemetry.weekly, remainingPercent: 101 } },
    { ...telemetry, weekly: { ...telemetry.weekly, remainingPercent: -1 } },
    { ...telemetry, weekly: { ...telemetry.weekly, resetsAt: Number.MAX_VALUE } },
    { ...telemetry, context: { usedTokens: -1, maxTokens: 200000 } },
    { ...telemetry, context: { usedTokens: null, maxTokens: 0 } },
    { ...telemetry, fast: "priority" },
  ];

  const errors = invalid.map((value) => expectError(parseSnapshot(snapshot(value))).code);

  expect(errors).toEqual(invalid.map(() => "PROTOCOL_ERROR"));
});
