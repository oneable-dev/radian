import { expect, test } from "bun:test";
import { providerAdapter, providerUsageAdapter } from "./index.ts";
import type { ProviderModel } from "./adapter.ts";

const model = (provider: string, api: string): ProviderModel => ({
  provider,
  api,
  id: "claude-opus-5-5",
  baseUrl: "https://api.anthropic.com",
});

test.each(["openai-responses", "openai-codex-responses"])(
  "Custom %s request compatibility never authorizes an account endpoint",
  (api) => {
    // Request protocols are reusable; account services remain tied to their own identities.
    const custom = model("custom-gateway", api);

    const requests = providerAdapter(custom);
    const accounts = providerUsageAdapter(custom.provider);

    expect(requests?.id).toBe("openai");
    expect(requests?.fast.supports(custom)).toBe(true);
    expect(accounts).toBeUndefined();
  },
);

test.each([
  ["openai", "openai"],
  ["openai-codex", "openai"],
  ["anthropic", "anthropic"],
] as const)("Account provider %s selects only its own %s source", (provider, expected) => {
  // Native provider identity, not model branding, chooses the company account endpoint.
  const adapter = providerUsageAdapter(provider);

  expect(adapter?.id).toBe(expected);
  expect(adapter?.usage.matchesProvider(provider)).toBe(true);
});

test.each([
  ["claude-code", "claude-code-stream-json"],
  ["unrelated", "anthropic-messages"],
  ["openrouter", "anthropic-messages"],
  ["unknown", "unknown-stream"],
])("Unsupported %s/%s has no implicit native transport capability", (provider, api) => {
  // An Opus model name does not grant a custom transport native Fast or another account's quota.
  const unknown = model(provider, api);

  expect(providerAdapter(unknown)).toBeUndefined();
  expect(providerUsageAdapter(provider)).toBeUndefined();
});

test("Missing models require no default adapter or account selection", () => {
  // Discovery can temporarily have no model without choosing a paid request route.
  const adapter = providerAdapter(undefined);

  expect(adapter).toBeUndefined();
});
