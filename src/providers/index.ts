import type { ProviderAdapter, ProviderModel } from "./adapter.ts";
import { openAiProviderAdapter } from "./openai.ts";
import { anthropicProviderAdapter } from "./anthropic.ts";

const adapters: readonly ProviderAdapter[] = [openAiProviderAdapter, anthropicProviderAdapter];

// Request protocol compatibility is independent of account-endpoint authorization.
export function providerAdapter(model: ProviderModel | undefined): ProviderAdapter | undefined {
  return model ? adapters.find((adapter) => adapter.matchesModel(model)) : undefined;
}

export function providerUsageAdapter(provider: string): ProviderAdapter | undefined {
  return adapters.find((adapter) => adapter.usage.matchesProvider(provider));
}
