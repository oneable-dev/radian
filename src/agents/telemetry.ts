import type { ProviderUsage } from "../usage/model.ts";

// Plain, provider-neutral data carried by runtime snapshots. Timestamps are Unix milliseconds.
export type SessionTelemetry = {
  readonly provider: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  // Session-local requested/observed priority mode, not a server speed guarantee.
  readonly fast: boolean | null;
  readonly context: { readonly usedTokens: number | null; readonly maxTokens: number } | null;
  readonly weekly: WeeklyQuota | null;
  readonly usage?: ProviderUsage;
  readonly providerUsage?: Readonly<Record<string, ProviderUsage>>;
};

export type WeeklyQuota = {
  readonly remainingPercent: number;
  readonly resetsAt: number;
  readonly observedAt: number;
};
