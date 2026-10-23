import { expect, test } from "bun:test";
import { emptyPreferences, parseSnapshot } from "../runtime/protocol.ts";
import { expectError, expectOk } from "../testing/results.ts";
import type { SessionTelemetry } from "./telemetry.ts";

const legacy = { version: 1, pid: 123, instance: "instance", mode: "offline", repositoryId: "repo", repositories: [],
  details: { session: { status: null, output: "legacy", error: null } }, closingCount: 0, preferences: emptyPreferences, notice: "" };
const telemetry: SessionTelemetry = { provider: "openai-codex", model: "gpt-5.5", effort: "high", fast: null,
  context: { usedTokens: null, maxTokens: 200000 }, weekly: { remainingPercent: 82, observedAt: 1800000000000, resetsAt: 1800003600000 } };
const snapshot = (value: unknown) => ({ ...legacy, details: { session: { ...legacy.details.session, telemetry: value } } });

test("Telemetry is optional on the wire and serializes unknown values and fractional remaining usage", () => {
  // Old runtimes lack telemetry entirely; a new runtime can report unknown context after compaction.
  const stored = JSON.parse(JSON.stringify(snapshot({ ...telemetry, weekly: { ...telemetry.weekly, remainingPercent: 82.5 } })));

  const old = expectOk(parseSnapshot(legacy));
  const fresh = expectOk(parseSnapshot(stored));

  expect(old.details.session?.telemetry).toBeUndefined();
  expect(fresh.details.session?.telemetry?.context?.usedTokens).toBeNull();
  expect(fresh.details.session?.telemetry?.fast).toBeNull();
  expect(fresh.details.session?.telemetry?.weekly?.remainingPercent).toBe(82.5);
});

test("Provider-neutral usage ratios, windows, resets, and errors round-trip over the wire", () => {
  const usage: NonNullable<SessionTelemetry["usage"]> = { provider: "acme", status: "ready", windows: [{ id: "quota", usedPercent: 10, periodMs: 604800000, resetsAt: 1800003600000 }],
    updatedAt: 1800000000000, errorCode: null };

  const decoded = expectOk(parseSnapshot(JSON.parse(JSON.stringify(snapshot({ ...telemetry, usage })))));

  expect(decoded.details.session?.telemetry?.usage).toEqual(usage);
  expect(expectError(parseSnapshot(snapshot({ ...telemetry, usage: { ...usage, windows: [{ ...usage.windows[0], usedPercent: 101 }] } }))).code).toBe("PROTOCOL_ERROR");
  expect(expectError(parseSnapshot(snapshot({ ...telemetry, usage: { ...usage, errorCode: "INVENTED_ERROR" } }))).code).toBe("PROTOCOL_ERROR");
});

test("Invalid remaining values, tokens, and timestamps return typed IPC protocol errors", () => {
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
