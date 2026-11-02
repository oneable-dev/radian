import { expect, test } from "bun:test";
import type { ProviderUsage } from "../usage/model.ts";
import { assessAuthentication } from "./auth-assessment.ts";

const usage: ProviderUsage = {
  provider: "anthropic",
  status: "ready",
  windows: [{ id: "five_hour", usedPercent: 10, periodMs: 18000000, resetsAt: null }],
  updatedAt: 1,
  errorCode: null,
};

test("Successful authenticated quota evidence confirms authentication", () => {
  // A completed authenticated endpoint read proves that its credential was accepted.
  const assessment = assessAuthentication(usage);

  expect(assessment.status).toBe("valid");
  expect(assessment.message.length).toBeGreaterThan(0);
});

test("Successful empty quota responses still confirm authenticated endpoint access", () => {
  // Empty measured quotas are unavailable for display, but are not an unsupported endpoint.
  const assessment = assessAuthentication({ ...usage, status: "unavailable", windows: [] });

  expect(assessment.status).toBe("valid");
});

test("Confirmed authentication denial requires reauthentication even with old quota windows", () => {
  // Retained display windows cannot overrule the current confirmed denial.
  const assessment = assessAuthentication({
    ...usage,
    status: "error",
    errorCode: "USAGE_AUTH_REQUIRED",
  });

  expect(assessment.status).toBe("reauth-required");
});

test.each<Partial<ProviderUsage>>([
  { status: "loading" },
  { status: "unavailable", windows: [], updatedAt: null },
  { updatedAt: null },
  { status: "error", errorCode: "USAGE_QUERY_FAILED" },
  { status: "error", errorCode: "USAGE_PROTOCOL_ERROR" },
  { status: "error", errorCode: "USAGE_RATE_LIMITED" },
  { status: "error", errorCode: "USAGE_TIMEOUT" },
])("Unavailable or inconclusive evidence remains indeterminate: %j", (overrides) => {
  // Unsupported reads and operational failures never prove invalid credentials.
  const assessment = assessAuthentication({ ...usage, ...overrides });

  expect(assessment.status).toBe("indeterminate");
});
