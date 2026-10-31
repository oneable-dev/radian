import { expect, test } from "bun:test";
import { emptyPreferences, parseSnapshot } from "../runtime/protocol.ts";
import { expectError, expectOk } from "../testing/results.ts";
import type { SessionTelemetry } from "./telemetry.ts";
import { parseAnthropicUsage } from "../usage/providers/anthropic.ts";

const legacy = {
  version: 1,
  pid: 123,
  instance: "instance",
  mode: "offline",
  repositoryId: "repo",
  repositories: [],
  details: { session: { status: null, output: "legacy", error: null } },
  closingCount: 0,
  preferences: emptyPreferences,
  notice: "",
};
const telemetry: SessionTelemetry = {
  provider: "openai-codex",
  model: "gpt-5.5",
  effort: "high",
  fast: null,
  context: { usedTokens: null, maxTokens: 200000 },
  weekly: { remainingPercent: 82, observedAt: 1800000000000, resetsAt: 1800003600000 },
};
const snapshot = (value: unknown) => ({
  ...legacy,
  details: { session: { ...legacy.details.session, telemetry: value } },
});

test("Telemetry is optional on the wire and serializes unknown values and fractional remaining usage", () => {
  // Old runtimes lack telemetry entirely; a new runtime can report unknown context after compaction.
  const stored = JSON.parse(
    JSON.stringify(
      snapshot({ ...telemetry, weekly: { ...telemetry.weekly, remainingPercent: 82.5 } }),
    ),
  );

  const old = expectOk(parseSnapshot(legacy));
  const fresh = expectOk(parseSnapshot(stored));

  expect(old.details.session?.telemetry).toBeUndefined();
  expect(fresh.details.session?.telemetry?.context?.usedTokens).toBeNull();
  expect(fresh.details.session?.telemetry?.fast).toBeNull();
  expect(fresh.details.session?.telemetry?.providerUsage).toBeUndefined();
  expect(fresh.details.session?.telemetry?.weekly?.remainingPercent).toBe(82.5);
});

test("Provider-neutral usage ratios, windows, resets, and errors round-trip over the wire", () => {
  const usage: NonNullable<SessionTelemetry["usage"]> = {
    provider: "acme",
    status: "ready",
    windows: [{ id: "quota", usedPercent: 10, periodMs: 604800000, resetsAt: 1800003600000 }],
    updatedAt: 1800000000000,
    errorCode: null,
  };

  const decoded = expectOk(
    parseSnapshot(JSON.parse(JSON.stringify(snapshot({ ...telemetry, usage })))),
  );

  expect(decoded.details.session?.telemetry?.usage).toEqual(usage);
  expect(
    expectError(
      parseSnapshot(
        snapshot({
          ...telemetry,
          usage: { ...usage, windows: [{ ...usage.windows[0], usedPercent: 101 }] },
        }),
      ),
    ).code,
  ).toBe("PROTOCOL_ERROR");
  expect(
    expectError(
      parseSnapshot(snapshot({ ...telemetry, usage: { ...usage, errorCode: "INVENTED_ERROR" } })),
    ).code,
  ).toBe("PROTOCOL_ERROR");
});

test("Claude reset timestamps satisfy the same positive millisecond contract as IPC snapshots", () => {
  // An epoch sentinel must fail at the source rather than reject the entire runtime snapshot.
  const invalid = parseAnthropicUsage({
    five_hour: { utilization: 1, resets_at: "1970-01-01T00:00:00Z" },
  });
  expect(expectError(invalid).code).toBe("USAGE_PROTOCOL_ERROR");

  // The first valid positive millisecond remains serializable without a unit conversion.
  const windows = expectOk(
    parseAnthropicUsage({ five_hour: { utilization: 1, resets_at: "1970-01-01T00:00:00.001Z" } }),
  );
  const usage = { provider: "anthropic", status: "ready", windows, updatedAt: 0, errorCode: null };
  const decoded = expectOk(
    parseSnapshot(snapshot({ ...telemetry, providerUsage: { anthropic: usage } })),
  );

  expect(decoded.details.session?.telemetry?.providerUsage?.anthropic?.windows[0]?.resetsAt).toBe(
    1,
  );
});

test("Connected provider usage and legacy current usage round-trip with independent windows and failures", () => {
  // Both provider accounts retain their own reset times, including last successful windows after errors.
  const anthropic: NonNullable<SessionTelemetry["usage"]> = {
    provider: "anthropic",
    status: "ready",
    windows: [{ id: "five_hour", usedPercent: 35.5, periodMs: 18000000, resetsAt: 1800003600000 }],
    updatedAt: 1800000000000,
    errorCode: null,
  };
  const openai: NonNullable<SessionTelemetry["usage"]> = {
    provider: "openai",
    status: "error",
    windows: [{ id: "weekly", usedPercent: 82, periodMs: 604800000, resetsAt: 1800604800000 }],
    updatedAt: 1799999999000,
    errorCode: "USAGE_RATE_LIMITED",
  };
  const value: SessionTelemetry = {
    ...telemetry,
    provider: "anthropic",
    usage: anthropic,
    providerUsage: { anthropic, openai },
  };

  const encoded = JSON.stringify(snapshot(value));
  const decoded = expectOk(parseSnapshot(JSON.parse(encoded)));

  expect(decoded.details.session?.telemetry).toEqual(value);
  expect(decoded.details.session?.telemetry?.usage).toEqual(anthropic);
  expect(decoded.details.session?.telemetry?.providerUsage?.openai?.status).toBe("error");
  expect(encoded).not.toContain("account");
  expect(encoded).not.toContain("auth");
});

test("Malformed provider usage records reject invalid entries instead of weakening legacy validation", () => {
  // IPC data is untyped, so every entry must satisfy the same normalized usage schema as current usage.
  const usage: NonNullable<SessionTelemetry["usage"]> = {
    provider: "anthropic",
    status: "ready",
    windows: [{ id: "weekly", usedPercent: 25, periodMs: 604800000, resetsAt: 1800604800000 }],
    updatedAt: 1800000000000,
    errorCode: null,
  };
  const invalid = [
    null,
    [],
    42,
    { anthropic: null },
    { anthropic: { ...usage, provider: null } },
    { anthropic: { ...usage, status: "unknown" } },
    { anthropic: { ...usage, windows: null } },
    { anthropic: { ...usage, windows: [{ ...usage.windows[0], usedPercent: 101 }] } },
    { anthropic: { ...usage, windows: [{ ...usage.windows[0], periodMs: 0 }] } },
    { anthropic: { ...usage, windows: [{ ...usage.windows[0], resetsAt: Number.MAX_VALUE }] } },
    { anthropic: { ...usage, updatedAt: -1 } },
    { anthropic: { ...usage, errorCode: "INVENTED_ERROR" } },
  ];

  const errors = invalid.map(
    (providerUsage) => expectError(parseSnapshot(snapshot({ ...telemetry, providerUsage }))).code,
  );

  expect(errors).toEqual(invalid.map(() => "PROTOCOL_ERROR"));
  expect(
    expectOk(parseSnapshot(snapshot({ ...telemetry, providerUsage: {} }))).details.session
      ?.telemetry?.providerUsage,
  ).toEqual({});
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
