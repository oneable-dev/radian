import { expect, test } from "bun:test";
import { expectOk } from "../testing/results.ts";
import type { ProviderModel } from "./adapter.ts";
import { openAiProviderAdapter as adapter } from "./openai.ts";

const model = (overrides: Partial<ProviderModel> = {}): ProviderModel => ({
  provider: "custom-openai-fixture",
  api: "openai-codex-responses",
  id: "model-fixture",
  baseUrl: "https://provider.invalid",
  ...overrides,
});
const now = 1800000000000;
const reset = 1800604800;
const weekly = { remainingPercent: 64, resetsAt: 1800604800000, observedAt: now };
const window = (overrides: Record<string, unknown> = {}) => ({
  used_percent: 36,
  window_minutes: 10080,
  reset_at: reset,
  ...overrides,
});
const headers = (bucket = "secondary"): Record<string, string> => ({
  [`x-codex-${bucket}-used-percent`]: "36",
  [`x-codex-${bucket}-window-minutes`]: "10080",
  [`x-codex-${bucket}-reset-at`]: String(reset),
});

test.each(["openai-responses", "openai-codex-responses"])(
  "%s compatibility supports custom providers without authorizing account access",
  (api) => {
    // Transport compatibility is independent of the company's account identity.
    const current = model({ api });

    const matches = adapter.matchesModel(current);
    const supported = adapter.fast.supports(current);

    expect(matches).toBe(true);
    expect(supported).toBe(true);
    expect(adapter.usage.matchesProvider(current.provider)).toBe(false);
  },
);

test.each(["openai", "openai-codex"])(
  "Canonical %s identity does not enable Fast on unsupported APIs",
  (provider) => {
    // Canonical identity can route usage even when its model has a different API.
    const current = model({ provider, api: "openai-completions" });
    const payload = Object.freeze({ model: current.id, service_tier: "default" });

    const outgoing = adapter.fast.apply(payload, current, true);

    expect(adapter.matchesModel(current)).toBe(true);
    expect(adapter.usage.matchesProvider(provider)).toBe(true);
    expect(adapter.fast.supports(current)).toBe(false);
    expect(outgoing).toBe(payload);
    expect(adapter.fast.readPayload(payload, current)).toBeNull();
    expect(adapter.matchesModel(model({ api: "anthropic-messages" }))).toBe(false);
  },
);

test.each(["openai-responses", "openai-codex-responses"])(
  "Explicit Fast on for %s clones the request without changing other fields",
  (api) => {
    // Frozen extension data protects callers from in-place tier changes.
    const current = model({ api });
    const input = Object.freeze([{ role: "user", content: "fixture" }]);
    const payload = Object.freeze({ model: current.id, service_tier: "flex", input, stream: true });

    const outgoing = adapter.fast.apply(payload, current, true);

    expect(outgoing).toEqual({ ...payload, service_tier: "priority" });
    expect(outgoing).not.toBe(payload);
    expect(outgoing).toHaveProperty("input", input);
    expect(payload.service_tier).toBe("flex");
  },
);

test.each(["priority", "fast"])("Explicit Fast off removes only the %s tier", (service_tier) => {
  // Turning off priority must retain unrelated provider and extension options.
  const current = model();
  const payload = Object.freeze({ model: current.id, service_tier, temperature: 0.5 });

  const outgoing = adapter.fast.apply(payload, current, false);

  expect(outgoing).toEqual({ model: current.id, temperature: 0.5 });
  expect(outgoing).not.toBe(payload);
  expect(payload.service_tier).toBe(service_tier);
});

test.each([undefined, "default", "auto", "flex", "extension-tier"])(
  "Fast off preserves a non-priority tier of %s",
  (tier) => {
    // Non-priority tiers belong to the provider or extension, not the Fast toggle.
    const current = model();
    const payload = Object.freeze({ model: current.id, ...(tier ? { service_tier: tier } : {}) });

    const outgoing = adapter.fast.apply(payload, current, false);

    expect(outgoing).toBe(payload);
  },
);

test.each(["priority", "fast", "flex"])(
  "An undefined Fast choice leaves the %s extension tier untouched",
  (service_tier) => {
    // No explicit choice must not become an implicit opt-in or opt-out.
    const current = model();
    const payload = Object.freeze({ model: current.id, service_tier });

    const outgoing = adapter.fast.apply(payload, current, undefined);

    expect(outgoing).toBe(payload);
  },
);

test.each(
  [null, undefined, "payload", 1, true, [], ["model-fixture"]].map((value) => [value] as const),
)("Unknown payload %j is neither transformed nor observed", (payload) => {
  // Only object records represent supported outgoing request shapes.
  const current = model();

  const outgoing = adapter.fast.apply(payload, current, true);
  const observed = adapter.fast.readPayload(payload, current);

  expect(outgoing).toBe(payload);
  expect(adapter.fast.apply(payload, current, false)).toBe(payload);
  expect(observed).toBeNull();
});

test.each([{}, { model: "another-model" }, { model: 1 }])(
  "A missing or mismatched model prevents explicit transforms: %j",
  (fields) => {
    // A compatible transport alone does not prove the request targets the selected model.
    const current = model();
    const payload = Object.freeze({ ...fields, service_tier: "priority" });

    const on = adapter.fast.apply(payload, current, true);
    const off = adapter.fast.apply(payload, current, false);

    expect(on).toBe(payload);
    expect(off).toBe(payload);
  },
);

test.each([
  [{ service_tier: "priority" }, true],
  [{ service_tier: "fast" }, true],
  [{ service_tier: "default" }, false],
  [{ service_tier: "flex" }, false],
  [{ service_tier: null }, false],
  [{}, false],
] as const)(
  "Outgoing extension payload %j is observed without requiring model",
  (payload, fast) => {
    // Existing request transforms may omit model and still communicate the outgoing tier.
    const current = model();

    const observed = adapter.fast.readPayload(payload, current);

    expect(observed).toBe(fast);
  },
);

test("An explicitly redirected payload cannot report the selected model's Fast mode", () => {
  // Omitting model is an extension convention, but naming a different model is not confirmation.
  const current = model();
  const redirected = { model: "another-model", service_tier: "priority" };

  const observed = adapter.fast.readPayload(redirected, current);

  expect(observed).toBeNull();
});

test.each(["primary", "secondary"])(
  "HTTP weekly headers identify the %s bucket by duration and ignore header casing",
  (bucket) => {
    // Five-hour windows must not shadow the seven-day allowance in either ordering.
    const other = bucket === "primary" ? "secondary" : "primary";
    const responseHeaders = Object.fromEntries(
      Object.entries({
        ...headers(other),
        [`x-codex-${other}-window-minutes`]: "300",
        ...headers(bucket),
      }).map(([name, value]) => [name.toUpperCase(), value]),
    );

    const observations = adapter.telemetry.response(
      { status: 200, headers: responseHeaders },
      model(),
      now,
    );

    expect(observations).toEqual({ weekly });
    expect(observations).not.toHaveProperty("fastObserved");
  },
);

test.each([
  ["used-percent", ""],
  ["used-percent", " "],
  ["used-percent", "NaN"],
  ["used-percent", "Infinity"],
  ["used-percent", "-1"],
  ["used-percent", "101"],
  ["window-minutes", "300"],
  ["window-minutes", ""],
  ["reset-at", "1800000000"],
  ["reset-at", "1799999999"],
  ["reset-at", "1800604800.5"],
  ["reset-at", String(Number.MAX_SAFE_INTEGER)],
  ["reset-at", "Infinity"],
] as const)("Invalid HTTP %s=%s reports unknown weekly quota", (field, value) => {
  // Corrupt or expired quota metadata must clear old quota without rejecting the response.
  const responseHeaders = { ...headers(), [`x-codex-secondary-${field}`]: value };

  const observations = adapter.telemetry.response(
    { status: 200, headers: responseHeaders },
    model(),
    now,
  );

  expect(observations).toEqual({ weekly: null });
});

test("Missing HTTP quota reports unknown even on an HTTP error response", () => {
  // HTTP observation behavior does not depend on success status or fabricate missing metadata.
  const response = { status: 429, headers: {} };

  const observations = adapter.telemetry.response(response, model(), now);

  expect(observations).toEqual({ weekly: null });
  expect(adapter.telemetry.response({ status: 429, headers: headers() }, model(), now)).toEqual({
    weekly,
  });
});

test.each(["primary", "secondary"])(
  "WebSocket weekly quota selects the %s seven-day bucket",
  (bucket) => {
    // The active weekly allowance can appear in either bucket, including after invalid metadata.
    const other = bucket === "primary" ? "secondary" : "primary";
    const event = {
      type: "codex.rate_limits",
      rate_limits: { [other]: window({ used_percent: NaN }), [bucket]: window() },
    };

    const observations = adapter.telemetry.event(event, model(), now);

    expect(observations).toEqual({ weekly });
  },
);

test.each([
  [undefined, true],
  [null, true],
  ["codex", true],
  ["other", false],
  [1, false],
] as const)("Codex quota honors metered bucket scope %j", (metered_limit_name, matches) => {
  // Only the default or explicit Codex scope can confirm the current allowance.
  const event = {
    type: "codex.rate_limits",
    metered_limit_name,
    rate_limits: { primary: window() },
  };

  const observations = adapter.telemetry.event(event, model(), now);

  expect(observations).toEqual({ weekly: matches ? weekly : null });
});

test.each([
  { used_percent: "36" },
  { used_percent: NaN },
  { used_percent: Infinity },
  { used_percent: -1 },
  { used_percent: 101 },
  { window_minutes: "10080" },
  { window_minutes: 300 },
  { reset_at: "1800604800" },
  { reset_at: 1800000000 },
  { reset_at: 1799999999 },
  { reset_at: 1800604800.5 },
  { reset_at: Number.MAX_SAFE_INTEGER },
])("Invalid WebSocket window %j reports unknown quota", (invalid) => {
  // WebSocket fields must be validated as numbers rather than coerced like HTTP headers.
  const event = { type: "codex.rate_limits", rate_limits: { primary: window(invalid) } };

  const observations = adapter.telemetry.event(event, model(), now);

  expect(observations).toEqual({ weekly: null });
});

test.each(
  [undefined, null, [], "limits", {}, { primary: null }, { primary: [] }].map(
    (value) => [value] as const,
  ),
)("Missing or malformed WebSocket rate limits %j report unknown quota", (rate_limits) => {
  // A relevant event with no valid window explicitly invalidates previous quota.
  const event = { type: "codex.rate_limits", rate_limits };

  const observations = adapter.telemetry.event(event, model(), now);

  expect(observations).toEqual({ weekly: null });
});

test.each([
  [0, 100],
  [100, 0],
  [36.5, 63.5],
])("Valid quota usage %d retains %d percent remaining", (used, remaining) => {
  // Fully available and exhausted windows are valid, unlike missing metadata.
  const event = {
    type: "codex.rate_limits",
    rate_limits: { primary: window({ used_percent: used }) },
  };

  const observations = adapter.telemetry.event(event, model(), now);

  expect(observations).toEqual({ weekly: { ...weekly, remainingPercent: remaining } });
});

test.each(
  [
    null,
    undefined,
    [],
    {},
    { type: "response.created" },
    { type: "response.completed", response: { service_tier: "priority" } },
  ].map((value) => [value] as const),
)("Unrelated event %j leaves quota and confirmed Fast observations absent", (event) => {
  // Unrelated metadata must not clear quota or manufacture server confirmation.
  const current = model();

  const observations = adapter.telemetry.event(event, current, now);

  expect(observations).toEqual({});
});

test.each(["openai-responses", "openai-completions", "anthropic-messages"])(
  "Non-Codex API %s ignores Codex telemetry despite canonical provider identity",
  (api) => {
    // An account identity does not change the transport's telemetry protocol.
    const current = model({ provider: "openai", api });
    const event = { type: "codex.rate_limits", rate_limits: { primary: window() } };

    const response = adapter.telemetry.response({ status: 200, headers: headers() }, current, now);
    const streamed = adapter.telemetry.event(event, current, now);

    expect(response).toEqual({});
    expect(streamed).toEqual({});
  },
);

test("Compatible custom APIs never resolve credentials or fetch company account usage", async () => {
  // Even OAuth-like custom providers must not reach the ChatGPT account endpoint.
  let authCalls = 0;
  let fetchCalls = 0;
  const resolver = adapter.usage.createResolver(
    {
      isUsingOAuth: () => true,
      getAuth: async () => {
        authCalls++;
        return undefined;
      },
    },
    async () => {
      fetchCalls++;
      return Response.json({ rate_limit: null });
    },
  );

  const account = expectOk(await resolver(model().provider, new AbortController().signal));

  expect(account).toBeNull();
  expect(authCalls).toBe(0);
  expect(fetchCalls).toBe(0);
  expect(adapter.usage.namedAccountKey).toBeUndefined();
});

test.each(["openai", "openai-codex"])(
  "Canonical %s usage reuses OAuth resolution and injected HTTP",
  async (provider) => {
    // Synthetic claims exercise delegation without credentials or real network requests.
    const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "account-fixture" } };
    const token = `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
    const resolved: string[] = [];
    const urls: string[] = [];
    const resolver = adapter.usage.createResolver(
      {
        isUsingOAuth: () => true,
        getAuth: async (requested) => {
          resolved.push(requested);
          return { auth: { apiKey: token } };
        },
      },
      async (url) => {
        urls.push(url);
        return Response.json({ rate_limit: null });
      },
    );
    const signal = new AbortController().signal;

    const account = expectOk(await resolver(provider, signal))!;
    const windows = expectOk(await account.load(signal));

    expect(resolved).toEqual([provider]);
    expect(urls).toEqual(["https://chatgpt.com/backend-api/wham/usage"]);
    expect(account.provider).toBe("openai");
    expect(windows).toEqual([]);
  },
);
