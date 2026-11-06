import { expect, test } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import { SubscriptionPolicyError } from "../errors.ts";
import { fixtureMessage } from "../testing/offline-runtime.ts";
import { expectError, expectOk } from "../testing/results.ts";
import {
  bindSubscriptionSession,
  isSubscriptionRoute,
  SubscriptionPolicyScope,
  validateSubscriptionRoute,
} from "./subscription-policy.ts";

const claude = {
  provider: "claude-code",
  api: "claude-code-stream-json",
  id: "claude-opus-5-5",
  baseUrl: "process://claude-code",
};
const codex = {
  provider: "openai-codex",
  api: "openai-codex-responses",
  id: "gpt-6.1-sol",
  baseUrl: "https://chatgpt.com/backend-api",
};
const directClaude = {
  ...claude,
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
};

for (const route of [claude, codex, { ...codex, baseUrl: `${codex.baseUrl}/` }]) {
  test(`subscription-only mode permits the approved route ${route.provider} ${route.baseUrl}`, () => {
    // Approved routes are transport identities, not model-name guesses or quota observations.
    const result = validateSubscriptionRoute(route, {});

    // Entitlement is left to the provider rather than inferred from this route check.
    expectOk(result);
    expect(isSubscriptionRoute(route)).toBe(true);
  });
}

test.each([
  directClaude,
  { ...claude, provider: "bedrock", api: "bedrock-converse-stream" },
  { ...claude, api: "anthropic-messages" },
  { ...claude, baseUrl: "https://api.anthropic.com" },
  { ...codex, provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
  { ...codex, provider: "custom-codex" },
  { ...codex, baseUrl: "https://gateway.invalid/backend-api" },
  { ...codex, baseUrl: "https://chatgpt.com.evil.invalid/backend-api" },
  { ...codex, baseUrl: "https://user:secret@chatgpt.com/backend-api" },
  { ...codex, baseUrl: "http://chatgpt.com/backend-api" },
  { ...codex, baseUrl: "https://chatgpt.com/v1" },
  { ...codex, baseUrl: "https://chatgpt.com/backend-api?route=api" },
  { ...codex, baseUrl: "https://chatgpt.com/backend-api#api" },
  { ...codex, baseUrl: "not a URL" },
  { ...codex, baseUrl: `${codex.baseUrl}?` },
  { ...codex, baseUrl: `${codex.baseUrl}#` },
  { ...codex, baseUrl: "https://chatgpt.com/other/../backend-api" },
  { ...codex, baseUrl: "https://chatgpt.com:443/backend-api" },
  { ...codex, baseUrl: ` ${codex.baseUrl}` },
])("subscription-only mode rejects API, alias and endpoint overrides: %j", (route) => {
  // Familiar model IDs cannot turn an API or proxy into an approved subscription route.
  const result = validateSubscriptionRoute(route, {});

  // Rejection identifies the approved providers without exposing credentials from the URL.
  const error = expectError(result);
  expect(error.code).toBe("SUBSCRIPTION_ROUTE_BLOCKED");
  expect(error.message).toContain("claude-code");
  expect(error.message).toContain("No API fallback");
  expect(error.message).not.toContain("secret");
});

test.each(["1", "true", "0", "unknown", " ", "\t"])(
  "Claude usage-credit overrides fail closed until unset: %s",
  (value) => {
    // Even ambiguous configuration must not opt this app into usage credits.
    const result = validateSubscriptionRoute(claude, { PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS: value });

    // The environment and account settings remain user-owned and are never changed here.
    expect(expectError(result).code).toBe("SUBSCRIPTION_EXTRA_USAGE_ENABLED");
    expectOk(validateSubscriptionRoute(claude, {}));
  },
);

test("overlapping policy scopes preserve original error identity without leaking to other runs", async () => {
  // Two invocations can overlap on one session while another child owns an independent scope.
  const scope = new SubscriptionPolicyScope();
  const child = new SubscriptionPolicyScope();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = new SubscriptionPolicyError("SUBSCRIPTION_ROUTE_BLOCKED", "Offline rejection");
  const blocked = scope.capture(() =>
    scope.request(async () => {
      started.resolve();
      await release.promise;
      expect(() => scope.reject(original)).toThrow(original);
    }),
  );
  await started.promise;

  const unrelated = await scope.capture(async () => {
    release.resolve();
    await blocked;
    return "ordinary failure";
  });
  const separate = await child.capture(async () => "child failure");
  const subsequent = await scope.capture(async () => "subsequent failure");

  // The exact Error (including its cause/stack) belongs only to the invocation that rejected.
  expect((await blocked).error).toBe(original);
  expect(unrelated.error).toBeUndefined();
  expect(separate.error).toBeUndefined();
  expect(subsequent.error).toBeUndefined();
});

test("only the latest agent request can supply a policy failure, not nested tool work", async () => {
  // A prompt can contain handled tool rejections and several model requests or retries.
  const scope = new SubscriptionPolicyScope();
  const original = new SubscriptionPolicyError("SUBSCRIPTION_ROUTE_BLOCKED", "Offline rejection");
  const reject = () => expect(() => scope.reject(original)).toThrow(original);

  const nestedOnly = await scope.capture(async () => {
    reject();
  });
  const replaced = await scope.capture(async () => {
    scope.request(reject);
    await scope.request(async () => "successful or unrelated terminal request");
  });
  const blocked = await scope.capture(async () => {
    reject();
    await scope.request(async () => {
      await Promise.resolve();
      reject();
    });
  });

  // Handling a tool error never poisons a run, while the latest failing request retains identity.
  expect(nestedOnly.error).toBeUndefined();
  expect(replaced.error).toBeUndefined();
  expect(blocked.error).toBe(original);
});

test("an older asynchronous request cannot overwrite its replacement's outcome", async () => {
  // Deferred SDK callbacks may finish after a later agent request has taken ownership.
  const scope = new SubscriptionPolicyScope();
  const release = Promise.withResolvers<void>();
  const original = new SubscriptionPolicyError("SUBSCRIPTION_ROUTE_BLOCKED", "Offline rejection");

  const result = await scope.capture(async () => {
    const earlier = scope.request(async () => {
      await release.promise;
      expect(() => scope.reject(original)).toThrow(original);
    });
    scope.request(() => "unrelated terminal request");
    release.resolve();
    await earlier;
  });

  // The old request still owns its own slot, but it is no longer the run's terminal request.
  expect(result.error).toBeUndefined();
});

test("every model request is checked before the transport and cleanup restores ownership", async () => {
  // Keep the provider implementation entirely in memory so no credentials or network are used.
  let calls = 0;
  const original: AgentSession["agent"]["streamFunction"] = (model) => {
    calls++;
    const stream = createAssistantMessageEventStream();
    const message = fixtureMessage(model.api, model.provider, model.id);
    stream.push({ type: "done", reason: "stop", message });
    stream.end();
    return stream;
  };
  const session = { agent: { streamFunction: original } };
  const stop = bindSubscriptionSession(session);
  const model = (route: typeof claude): Model<Api> => ({
    ...route,
    name: route.id,
    reasoning: false,
    input: ["text"],
    contextWindow: 1000,
    maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });

  // A later routed model is checked again instead of inheriting the first request's permission.
  const context = normalizeContext({ messages: [] });
  await session.agent.streamFunction(model(codex), context);
  expect(() => session.agent.streamFunction(model(directClaude), context)).toThrow(
    "Subscription-only mode blocks",
  );
  expect(() =>
    session.agent.streamFunction(model(claude), context, {
      env: { PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS: "1" },
    }),
  ).toThrow("requires PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS to be unset");

  // Both rejected calls stop before the transport and do not trigger a fallback.
  expect(calls).toBe(1);
  stop();
  expect(session.agent.streamFunction).toBe(original);
});
