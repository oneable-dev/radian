// Plain, provider-neutral data carried by runtime snapshots. Timestamps are Unix milliseconds.
export type SessionTelemetry = {
  readonly provider: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  // The last observed outgoing request's priority setting, not a speed guarantee.
  readonly fast: boolean | null;
  readonly context: { readonly usedTokens: number | null; readonly maxTokens: number } | null;
  readonly weekly: WeeklyQuota | null;
};

export type WeeklyQuota = {
  readonly remainingPercent: number;
  readonly resetsAt: number;
  readonly observedAt: number;
};
