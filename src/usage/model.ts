import type { ExpectedError, UsageErrorCode } from "../errors.ts";
import type { Result } from "../result.ts";

export type UsageWindow = {
  readonly id: string;
  readonly usedPercent: number;
  readonly periodMs: number | null;
  readonly resetsAt: number | null;
};

// Safe normalized IPC data. Authentication and private account/cache keys never leave the source.
export type ProviderUsage = {
  readonly provider: string;
  readonly status: "loading" | "ready" | "unavailable" | "error";
  // Errors retain the last successful account windows and timestamp for a muted recovery display.
  readonly windows: readonly UsageWindow[];
  readonly updatedAt: number | null;
  readonly errorCode: UsageErrorCode | null;
};

export type UsageAccount = {
  readonly key: string;
  readonly provider: string;
  load(signal: AbortSignal): Promise<Result<readonly UsageWindow[], ExpectedError>>;
};
export type UsageResolver = (provider: string, signal: AbortSignal) => Promise<Result<UsageAccount | null, ExpectedError>>;
export type UsageSubscription = {
  read(provider: string | null): ProviderUsage;
  refresh(): void;
  dispose(): void;
};
