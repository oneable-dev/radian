import { expect, test } from "bun:test";
import { expectOk } from "../testing/results.ts";
import { anthropicUsageResolver } from "../usage/providers/anthropic.ts";
import type { ProviderModel } from "./adapter.ts";
import { anthropicProviderAdapter as adapter } from "./anthropic.ts";

const fastBeta = "fast-mode-2026-02-01";
const model = (overrides: Partial<ProviderModel> = {}): ProviderModel => ({
  provider: "anthropic",
  api: "anthropic-messages",
  id: "claude-opus-5-5",
  baseUrl: "https://api.anthropic.com",
  ...overrides,
});
const now = 1800000000000;

const unsupportedModels: ProviderModel[] = [
  ...[
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-5-5-latest",
    "claude-sonnet-5",
    "unknown",
  ].map((id) => model({ id })),
  ...["custom-anthropic", "anthropic-gateway", "claude-code", "claude-code-stream-json"].map(
    (provider) => model({ provider }),
  ),
  ...["claude-code", "claude-code-stream-json", "openai-responses", "openai-completions"].map(
    (api) => model({ api }),
  ),
  ...[
    "https://gateway.invalid/anthropic",
    "http://api.anthropic.com",
    "https://api.anthropic.com.evil.invalid",
    "https://api.anthropic.com:444",
    "https://api.anthropic.com@evil.invalid",
    "https://user:secret@api.anthropic.com",
    "http://127.0.0.1:8080",
    "not-a-url",
    "",
  ].map((baseUrl) => model({ baseUrl })),
];

test.each(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"])(
  "Native %s supports explicit Fast on the canonical HTTPS origin",
  (id) => {
    // Path suffixes and the default HTTPS port do not change the native origin.
    const current = model({ id, baseUrl: "https://api.anthropic.com:443/v1/" });

    const supported = adapter.fast.supports(current);

    expect(supported).toBe(true);
    expect(adapter.matchesModel(current)).toBe(true);
  },
);

test.each(unsupportedModels.map((current) => [current] as const))(
  "Unsupported model, provider, API, or endpoint never transforms requests: %j",
  (current) => {
    // Neither a familiar model name nor a compatible protocol authorizes Fast.
    const payload = Object.freeze({ model: current.id, speed: "fast", betas: [fastBeta] });

    const supported = adapter.fast.supports(current);
    const on = adapter.fast.apply(payload, current, true);
    const off = adapter.fast.apply(payload, current, false);

    expect(supported).toBe(false);
    expect(on).toBe(payload);
    expect(off).toBe(payload);
    expect(adapter.fast.readPayload(payload, current)).toBeNull();
  },
);

test("Opus 5.5 enables Fast without introducing a beta or changing nested fields", () => {
  // Frozen extension data must remain immutable when the current model needs no beta.
  const current = model();
  const messages = Object.freeze([{ role: "user", content: "fixture" }]);
  const payload = Object.freeze({ model: current.id, messages, stream: true });

  const outgoing = adapter.fast.apply(payload, current, true);

  expect(outgoing).toEqual({ ...payload, speed: "fast" });
  expect(outgoing).not.toBe(payload);
  expect(outgoing).toHaveProperty("messages", messages);
  expect(outgoing).not.toHaveProperty("betas");
  expect(payload).not.toHaveProperty("speed");
});

test.each(["claude-opus-5", "claude-opus-4-8"])(
  "%s merges the required Fast beta after existing extension betas",
  (id) => {
    // Existing beta order and unrelated fields must survive the opt-in.
    const current = model({ id });
    const betas = Object.freeze(["oauth-2025-04-20", "extension-beta"]);
    const payload = Object.freeze({ model: id, speed: "standard", betas, temperature: 0.5 });

    const outgoing = adapter.fast.apply(payload, current, true);

    expect(outgoing).toEqual({ ...payload, speed: "fast", betas: [...betas, fastBeta] });
    expect(payload.speed).toBe("standard");
    expect(payload.betas).toEqual(["oauth-2025-04-20", "extension-beta"]);
    expect(adapter.fast.apply({ model: id }, current, true)).toEqual({
      model: id,
      speed: "fast",
      betas: [fastBeta],
    });
  },
);

test.each(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"])(
  "%s preserves the position of an existing Fast beta without duplicating it",
  (id) => {
    // A beta supplied by an extension is not reordered, even on the beta-free model.
    const betas = Object.freeze(["first-beta", fastBeta, "last-beta"]);
    const payload = Object.freeze({ model: id, betas });

    const outgoing = adapter.fast.apply(payload, model({ id }), true);

    expect(outgoing).toEqual({ model: id, betas, speed: "fast" });
    expect(outgoing).toHaveProperty("betas", betas);
  },
);

test("Explicit Fast off removes only Fast speed and beta while preserving extension order", () => {
  // Multiple Fast beta occurrences must not leave a hidden per-request opt-in.
  const current = model({ id: "claude-opus-5" });
  const betas = Object.freeze(["first-beta", fastBeta, "last-beta", fastBeta]);
  const payload = Object.freeze({ model: current.id, speed: "fast", betas, temperature: 0.5 });

  const outgoing = adapter.fast.apply(payload, current, false);

  expect(outgoing).toEqual({
    model: current.id,
    betas: ["first-beta", "last-beta"],
    temperature: 0.5,
  });
  expect(payload.speed).toBe("fast");
  expect(payload.betas).toEqual(["first-beta", fastBeta, "last-beta", fastBeta]);
});

test("Fast off restores defaults without an empty beta override or explicit standard speed", () => {
  // The last Fast-only beta should not produce another per-request override.
  const current = model();
  const payload = Object.freeze({ model: current.id, speed: "fast", betas: [fastBeta] });

  const outgoing = adapter.fast.apply(payload, current, false);

  expect(outgoing).toEqual({ model: current.id });
  expect(adapter.fast.apply({ model: current.id, speed: "fast" }, current, false)).toEqual({
    model: current.id,
  });
});

test.each([undefined, "standard", "extension-mode", null])(
  "Fast off leaves unrelated speed %j and betas unchanged",
  (speed) => {
    // Disabling Fast is not permission to normalize extension-owned request choices.
    const current = model();
    const payload = Object.freeze({ model: current.id, speed, betas: ["extension-beta"] });

    const outgoing = adapter.fast.apply(payload, current, false);

    expect(outgoing).toBe(payload);
    expect(
      adapter.fast.apply({ ...payload, betas: [fastBeta, "extension-beta"] }, current, false),
    ).toEqual(payload);
  },
);

test.each([undefined, "fast", "standard"])(
  "An undefined preference preserves an outgoing speed of %j and all betas",
  (speed) => {
    // Absence of a choice must preserve provider defaults and extension opt-ins alike.
    const current = model({ id: "claude-opus-5" });
    const payload = Object.freeze({
      model: current.id,
      speed,
      betas: [fastBeta, "extension-beta"],
    });

    const outgoing = adapter.fast.apply(payload, current, undefined);

    expect(outgoing).toBe(payload);
  },
);

test.each([null, "true", "false", 0, 1])(
  "Runtime preference %j cannot substitute for an explicit boolean choice",
  (preference) => {
    // Runtime extension values must not accidentally opt in through truthiness.
    const current = model();
    const payload = Object.freeze({ model: current.id, speed: "fast" });

    const outgoing: unknown = Reflect.apply(adapter.fast.apply, undefined, [
      payload,
      current,
      preference,
    ]);

    expect(outgoing).toBe(payload);
  },
);

test.each([null, undefined, [], "payload", 1, true].map((payload) => [payload] as const))(
  "Non-record payload %j is preserved and cannot establish an outgoing mode",
  (payload) => {
    // Only request records can carry a model and mode.
    const current = model();

    const outgoing = adapter.fast.apply(payload, current, true);

    expect(outgoing).toBe(payload);
    expect(adapter.fast.apply(payload, current, false)).toBe(payload);
    expect(adapter.fast.readPayload(payload, current)).toBeNull();
  },
);

test.each([{}, { model: undefined }, { model: "other-model" }, { model: 1 }])(
  "Explicit changes require the selected request model: %j",
  (fields) => {
    // An extension replacement must not silently receive changes for another model.
    const current = model();
    const payload = Object.freeze({ ...fields, speed: "fast" });

    const on = adapter.fast.apply(payload, current, true);
    const off = adapter.fast.apply(payload, current, false);

    expect(on).toBe(payload);
    expect(off).toBe(payload);
  },
);

test.each(
  [null, "extension-beta", {}, [fastBeta, 1], [false], [null], [""], [" "], Array(1)].map(
    (betas) => [betas] as const,
  ),
)("Invalid extension betas %j are preserved rather than coerced", (betas) => {
  // Invalid beta metadata must not be dropped to manufacture a valid-looking Fast request.
  const current = model({ id: "claude-opus-5" });
  const payload = Object.freeze({ model: current.id, speed: "fast", betas });

  const on = adapter.fast.apply(payload, current, true);
  const off = adapter.fast.apply(payload, current, false);

  expect(on).toBe(payload);
  // Malformed metadata stays intact, but it cannot override an explicit premium-speed opt-out.
  expect(off).toEqual({ model: current.id, betas });
  expect(off).not.toBe(payload);
  expect(payload.speed).toBe("fast");
  expect(adapter.fast.readPayload(payload, current)).toBeNull();
});

test.each([
  [{ speed: "fast" }, true],
  [{ speed: "standard" }, false],
  [{}, false],
  [{ speed: undefined, betas: [] }, false],
  [{ speed: null }, null],
  [{ speed: "priority" }, null],
  [{ speed: true }, null],
] as const)(
  "Outgoing mode %j is read independently of confirmed server speed",
  (payload, expected) => {
    // Reading extension output does not require a model field or proof of beta entitlement.
    const current = model({ id: "claude-opus-5" });

    const requested = adapter.fast.readPayload(payload, current);

    expect(requested).toBe(expected);
    expect(adapter.fast.readPayload({ ...payload, model: current.id }, current)).toBe(expected);
    expect(adapter.fast.readPayload({ ...payload, model: "other-model" }, current)).toBeNull();
    expect(adapter.fast.readPayload({ ...payload, model: undefined }, current)).toBeNull();
  },
);

const usageCases = [
  [{ speed: "fast" }, true],
  [{ speed: "standard" }, false],
  [{}, null],
  [{ speed: null }, null],
  [{ speed: "priority" }, null],
  [{ speed: true }, null],
  [undefined, null],
  [null, null],
  [[], null],
  ["fast", null],
] as const;

test.each(usageCases)(
  "Native message-start usage %j yields a confirmed speed of %j",
  (usage, expected) => {
    // Message start establishes response evidence after the outgoing request reset it.
    const start = { type: "message_start", message: { usage } };

    const started = adapter.telemetry.event(start, model(), now);

    expect(started).toEqual({ fastObserved: expected });
  },
);

test.each([
  ["fast", true],
  ["standard", false],
  [null, null],
  ["priority", null],
  [true, null],
] as const)("Explicit delta speed %j updates confirmation to %j", (speed, expected) => {
  // A delta may explicitly correct the speed reported at the start of the same response.
  const delta = { type: "message_delta", usage: { speed } };

  const updated = adapter.telemetry.event(delta, model(), now);

  expect(updated).toEqual({ fastObserved: expected });
});

test.each([undefined, null, [], {}, { output_tokens: 10 }].map((usage) => [usage] as const))(
  "Delta without a speed field preserves prior confirmation: %j",
  (usage) => {
    // Ordinary output-token deltas omit speed; that omission cannot erase earlier server evidence.
    const delta = { type: "message_delta", usage };

    const updated = adapter.telemetry.event(delta, model(), now);

    expect(updated).toEqual({});
  },
);

test.each(["claude-opus-4-6", "claude-opus-4-7", "unknown"])(
  "Native %s can report observed speed without supporting a Fast request",
  (id) => {
    // Model allowlists restrict writes, not native usage observations.
    const current = model({ id });

    const observations = adapter.telemetry.event(
      { type: "message_delta", usage: { speed: "fast" } },
      current,
      now,
    );

    expect(adapter.matchesModel(current)).toBe(true);
    expect(adapter.fast.supports(current)).toBe(false);
    expect(observations).toEqual({ fastObserved: true });
  },
);

test.each(
  [
    null,
    [],
    {},
    { type: "message_stop", usage: { speed: "fast" } },
    { type: "content_block_delta", usage: { speed: "standard" } },
    { type: "response.completed", response: { usage: { speed: "fast" } } },
  ].map((event) => [event] as const),
)("Unrelated event %j cannot clear a prior speed observation", (event) => {
  // An absent observation is distinct from an explicit unknown native usage value.
  const current = model();

  const observations = adapter.telemetry.event(event, current, now);

  expect(observations).toEqual({});
});

test.each([{}, { message: null }, { message: [] }, { message: { speed: "fast" } }])(
  "Missing native message-start usage explicitly reports unknown: %j",
  (fields) => {
    // A top-level or misplaced speed field is not native usage evidence.
    const event = { type: "message_start", usage: { speed: "fast" }, ...fields };

    const observations = adapter.telemetry.event(event, model(), now);

    expect(observations).toEqual({ fastObserved: null });
  },
);

test.each(unsupportedModels.filter((current) => current.id === "claude-opus-5-5"))(
  "Non-native transport ignores Anthropic-shaped telemetry: %j",
  (current) => {
    // Provider and API identity cannot be inferred from message-shaped extension data.
    const event = { type: "message_delta", usage: { speed: "fast" } };

    const observations = adapter.telemetry.event(event, current, now);

    expect(adapter.matchesModel(current)).toBe(false);
    expect(observations).toEqual({});
  },
);

test("HTTP responses never claim a confirmed speed from request-like headers", () => {
  // Native speed evidence arrives in message usage, not HTTP headers.
  const response = { status: 200, headers: { speed: "fast", "anthropic-beta": fastBeta } };

  const observations = adapter.telemetry.response(response, model(), now);

  expect(observations).toEqual({});
});

test.each(["custom-anthropic", "claude-code", "claude-code-stream-json", "openai"])(
  "Usage lookup for %s never resolves credentials or accesses the account endpoint",
  async (provider) => {
    // Protocol compatibility and Claude branding cannot authorize Anthropic account access.
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
        return Response.json({ seven_day: null });
      },
    );

    const account = expectOk(await resolver(provider, new AbortController().signal));

    expect(adapter.usage.matchesProvider(provider)).toBe(false);
    expect(account).toBeNull();
    expect(authCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  },
);

test("Canonical account usage reuses the existing resolver and injected transport", async () => {
  // A synthetic token verifies delegation without real credentials or paid requests.
  const providers: string[] = [];
  const urls: string[] = [];
  const resolver = adapter.usage.createResolver(
    {
      isUsingOAuth: () => true,
      getAuth: async (provider) => {
        providers.push(provider);
        return { auth: { apiKey: "sk-ant-oat01-fixture-only" } };
      },
    },
    async (url) => {
      urls.push(url);
      return Response.json({ seven_day: null });
    },
  );
  const signal = new AbortController().signal;

  const account = expectOk(await resolver("anthropic", signal))!;
  const windows = expectOk(await account.load(signal));

  expect(adapter.usage.matchesProvider("anthropic")).toBe(true);
  expect(adapter.usage.createResolver).toBe(anthropicUsageResolver);
  expect(providers).toEqual(["anthropic"]);
  expect(urls).toEqual(["https://api.anthropic.com/api/oauth/usage"]);
  expect(windows).toEqual([]);
});

test.each([
  ["account-fixture", "56a6e8f56694cdec2370ffe25032b83684924d6f3accba1e40891a832bd8b69c"],
  ["account-fixture-2", "d9170ea8e81e2f44634224834ca3e3d85560a9434b1e23ec0a6b6263eb16cb9b"],
  ["", "fe829dd27de1610e0c7457997e1bf7862129a0df95bb15528c63be1f5186461b"],
])("Named account %j retains its exact private cache key", (id, expected) => {
  // Fixed historical hashes guard the null-separated namespace against silent cache migration.
  const key = adapter.usage.namedAccountKey;

  const first = key?.(id);
  const repeated = key?.(id);

  expect(first).toBe(expected);
  expect(repeated).toBe(expected);
});
