import type { ProviderUsage } from "../usage/model.ts";
import type { WeeklyQuota } from "../providers/adapter.ts";

export type { WeeklyQuota } from "../providers/adapter.ts";

// Plain, provider-neutral data carried by runtime snapshots. Timestamps are Unix milliseconds.
export type SessionTelemetry = {
  readonly provider: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  // Explicit request preference takes precedence over an outgoing mode observed from extensions.
  readonly fast: boolean | null;
  // Provider-confirmed execution mode, never inferred from an outgoing request or missing metadata.
  readonly fastObserved?: boolean | null;
  readonly context: { readonly usedTokens: number | null; readonly maxTokens: number } | null;
  readonly weekly: WeeklyQuota | null;
  readonly usage?: ProviderUsage;
  readonly providerUsage?: Readonly<Record<string, ProviderUsage>>;
};
