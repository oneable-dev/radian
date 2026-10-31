import { AsyncLocalStorage } from "node:async_hooks";
import { expect, test } from "bun:test";
import { ModelsError, type AuthCheck } from "@earendil-works/pi-ai";
import { CancelledError, StorageError } from "../../errors.ts";
import { expectError, expectOk } from "../../testing/results.ts";
import { providerUsageResolver } from "./index.ts";

const signal = () => new AbortController().signal;
const claudeToken = "sk-ant-oat01-fixture-a";
const openAiToken = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-fixture" } })).toString("base64url")}.fixture`;
const claudePayload = Object.freeze({
  five_hour: Object.freeze({ utilization: 12, resets_at: null }),
  seven_day: null,
});
const openAiPayload = Object.freeze({
  rate_limit: Object.freeze({
    primary_window: Object.freeze({ used_percent: 34, limit_window_seconds: 18000 }),
  }),
});

test.each([
  ["anthropic", "anthropic", "https://api.anthropic.com/api/oauth/usage", 12],
  ["openai", "openai", "https://chatgpt.com/backend-api/wham/usage", 34],
  ["openai-codex", "openai", "https://chatgpt.com/backend-api/wham/usage", 34],
] as const)(
  "Fresh auth dispatch routes %s to %s without using runtime snapshots",
  async (provider, expectedProvider, endpoint, usedPercent) => {
    // Only the current auth check may choose OAuth, even when the runtime snapshot disagrees.
    const requestSignal = signal();
    const checked: string[] = [];
    const resolved: string[] = [];
    const runtime = {
      isUsingOAuth: () => {
        throw new Error("Stale snapshot must not be read.");
      },
      async checkAuth(candidate: string, options: { signal: AbortSignal }): Promise<AuthCheck> {
        checked.push(candidate);
        expect(options.signal).toBe(requestSignal);

        return { type: "oauth" };
      },
      async getAuth(candidate: string, options: { signal: AbortSignal }) {
        resolved.push(candidate);
        expect(options.signal).toBe(requestSignal);

        return { auth: { apiKey: candidate === "anthropic" ? claudeToken : openAiToken } };
      },
    };
    let fetched = 0;
    const resolver = providerUsageResolver(runtime, async (url, options) => {
      fetched++;
      expect(url).toBe(endpoint);
      expect(options.signal).toBe(requestSignal);
      const headers = new Headers(options.headers);
      expect(headers.get("authorization")).toBe(
        `Bearer ${provider === "anthropic" ? claudeToken : openAiToken}`,
      );
      expect(headers.get("anthropic-beta")).toBe(
        provider === "anthropic" ? "oauth-2025-04-20" : null,
      );

      return Response.json(provider === "anthropic" ? claudePayload : openAiPayload);
    });

    const account = expectOk(await resolver(provider, requestSignal))!;
    const windows = expectOk(await account.load(requestSignal));

    expect(checked).toEqual([provider]);
    expect(resolved).toEqual([provider]);
    expect(account.provider).toBe(expectedProvider);
    expect(windows[0]?.usedPercent).toBe(usedPercent);
    expect(fetched).toBe(1);
  },
);

test("Unsupported providers do not check, resolve, or send authentication", async () => {
  // A provider with a familiar-looking model name or auth token still has no quota integration.
  let checked = 0;
  let resolved = 0;
  let fetched = 0;
  const resolver = providerUsageResolver(
    {
      checkAuth: async () => {
        checked++;
        return { type: "oauth" };
      },
      getAuth: async () => {
        resolved++;
        return { auth: { apiKey: claudeToken } };
      },
    },
    async () => {
      fetched++;
      return Response.json(claudePayload);
    },
  );

  const values = await Promise.all(
    ["google", "azure", "claude", "Anthropic"].map((provider) => resolver(provider, signal())),
  );

  expect(values.map(expectOk)).toEqual([null, null, null, null]);
  expect(checked).toBe(0);
  expect(resolved).toBe(0);
  expect(fetched).toBe(0);
});

test.each(["anthropic", "openai", "openai-codex"])(
  "Fresh API-key or missing auth for %s cannot use a stale OAuth snapshot",
  async (provider) => {
    // Neither an ambient API key nor missing auth is eligible for a subscription-only endpoint.
    let checked = 0;
    let resolved = 0;
    let fetched = 0;
    const runtime = {
      isUsingOAuth: () => true,
      checkAuth: async (): Promise<AuthCheck | undefined> => {
        checked++;

        return checked === 1 ? { type: "api_key" } : undefined;
      },
      getAuth: async () => {
        resolved++;

        return { auth: { apiKey: claudeToken } };
      },
    };
    const resolver = providerUsageResolver(runtime, async () => {
      fetched++;

      return Response.json(claudePayload);
    });

    const apiKey = expectOk(await resolver(provider, signal()));
    const missing = expectOk(await resolver(provider, signal()));

    expect(apiKey).toBeNull();
    expect(missing).toBeNull();
    expect(checked).toBe(2);
    expect(resolved).toBe(0);
    expect(fetched).toBe(0);
  },
);

test("Every resolution checks the latest auth type and preserves runtime method receivers", async () => {
  // Account changes can occur without refreshing the model runtime's public snapshot.
  const runtime = {
    type: "api_key" as AuthCheck["type"],
    token: claudeToken,
    async checkAuth(): Promise<AuthCheck> {
      return { type: this.type };
    },
    async getAuth() {
      return { auth: { apiKey: this.token } };
    },
  };
  const resolver = providerUsageResolver(runtime);

  const before = expectOk(await resolver("anthropic", signal()));
  runtime.type = "oauth";
  const during = expectOk(await resolver("anthropic", signal()));
  runtime.type = "api_key";
  const after = expectOk(await resolver("anthropic", signal()));

  expect(before).toBeNull();
  expect(during?.provider).toBe("anthropic");
  expect(after).toBeNull();
});

test("Concurrent pinned account contexts keep their own auth checks, tokens, and account keys", async () => {
  // Named-account selection is owned by AccountManager's async context, not a shared snapshot.
  const pinned = new AsyncLocalStorage<{ token: string }>();
  const resolver = providerUsageResolver(
    {
      async checkAuth(): Promise<AuthCheck> {
        await Promise.resolve();
        expect(pinned.getStore()?.token).toMatch(/^sk-ant-oat01-fixture-/);

        return { type: "oauth" };
      },
      async getAuth() {
        await Promise.resolve();

        const token = pinned.getStore()?.token;

        return token ? { auth: { apiKey: token } } : undefined;
      },
    },
    async (_url, options) => {
      const headers = new Headers(options.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${pinned.getStore()?.token}`);

      return Response.json(claudePayload);
    },
  );
  const resolvePinned = (token: string) =>
    pinned.run({ token }, async () => {
      const account = expectOk(await resolver("anthropic", signal()))!;
      expectOk(await account.load(signal()));

      return account.key;
    });

  const [first, second] = await Promise.all([
    resolvePinned(claudeToken),
    resolvePinned("sk-ant-oat01-fixture-b"),
  ]);

  expect(first).not.toBe(second);
  expect(first).not.toContain(claudeToken);
});

test.each([
  [new ModelsError("auth", "fixture"), "USAGE_AUTH_REQUIRED"],
  [new ModelsError("oauth", "fixture"), "USAGE_AUTH_REQUIRED"],
  [new StorageError("fixture"), "STORAGE_FAILED"],
  [new CancelledError(), "CANCELLED"],
  [new DOMException("fixture", "AbortError"), "CANCELLED"],
] as const)("Expected fresh auth check failures stay typed: %s", async (error, code) => {
  // Metadata lookup is an SDK/storage boundary and may fail before credentials can be resolved.
  let resolved = 0;
  const resolver = providerUsageResolver({
    checkAuth: async () => {
      throw error;
    },
    getAuth: async () => {
      resolved++;
      return undefined;
    },
  });

  const failure = expectError(await resolver("anthropic", signal()));

  expect(failure.code).toBe(code);
  expect(resolved).toBe(0);
});

test.each([
  new TypeError("auth implementation defect"),
  new Error("oauth network auth fixture is not a classified SDK error"),
  new ModelsError("provider", "unexpected provider fixture"),
])("Unexpected auth check exceptions retain their original object", async (defect) => {
  // Message wording must never turn a programming defect into a recoverable login error.
  const resolver = providerUsageResolver({
    checkAuth: async () => {
      throw defect;
    },
    getAuth: async () => undefined,
  });

  const operation = resolver("anthropic", signal());

  await expect(operation).rejects.toBe(defect);
});

test("Pre-cancelled dispatch does not check authentication", async () => {
  // A cancelled monitor generation must not start a fresh credential lookup.
  const controller = new AbortController();
  controller.abort();
  let checked = 0;
  const resolver = providerUsageResolver({
    checkAuth: async () => {
      checked++;
      return { type: "oauth" };
    },
    getAuth: async () => undefined,
  });

  const failure = expectError(await resolver("anthropic", controller.signal));

  expect(failure.code).toBe("CANCELLED");
  expect(checked).toBe(0);
});

test.each([false, true])(
  "Cancellation during auth checks stops dispatch whether the check rejects: %s",
  async (reject) => {
    // Even a late successful auth check cannot revive a cancelled request or expose credentials.
    const controller = new AbortController();
    let resolved = 0;
    const resolver = providerUsageResolver({
      checkAuth: async () => {
        controller.abort();
        if (reject) {
          throw new Error("cancelled fixture");
        }

        return { type: "oauth" };
      },
      getAuth: async () => {
        resolved++;
        return undefined;
      },
    });

    const failure = expectError(await resolver("anthropic", controller.signal));

    expect(failure.code).toBe("CANCELLED");
    expect(resolved).toBe(0);
  },
);
