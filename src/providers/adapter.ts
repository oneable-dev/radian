import type { Api, AuthCheck, AuthResult, Model, ProviderResponse } from "@earendil-works/pi-ai";
import type { UsageResolver } from "../usage/model.ts";

export type ProviderModel = Pick<Model<Api>, "provider" | "api" | "id" | "baseUrl">;

export type WeeklyQuota = {
  readonly remainingPercent: number;
  readonly resetsAt: number;
  readonly observedAt: number;
};

// Omitted fields are unrelated observations; null explicitly reports an unknown value.
export type ProviderObservations = {
  readonly fastObserved?: boolean | null;
  readonly weekly?: WeeklyQuota | null;
};

export type ProviderFast = {
  readonly warning?: string;
  supports(model: ProviderModel): boolean;
  // Undefined means no explicit choice: preserve extensions and provider defaults.
  apply(payload: unknown, model: ProviderModel, enabled: boolean | undefined): unknown;
  readPayload(payload: unknown, model: ProviderModel): boolean | null;
};

export type ProviderTelemetry = {
  response(response: ProviderResponse, model: ProviderModel, now: number): ProviderObservations;
  event(event: unknown, model: ProviderModel, now: number): ProviderObservations;
};

export type UsageAuthRuntime = {
  checkAuth(provider: string, options: { signal: AbortSignal }): Promise<AuthCheck | undefined>;
  getAuth(provider: string, options: { signal: AbortSignal }): Promise<AuthResult | undefined>;
};

export type UsageSourceRuntime = Pick<UsageAuthRuntime, "getAuth"> & {
  isUsingOAuth(provider: string): boolean;
};

export type UsageFetch = (url: string, options: RequestInit) => Promise<Response>;

export type ProviderAccountUsage = {
  // API compatibility never authorizes access to a company's account endpoint.
  matchesProvider(provider: string): boolean;
  createResolver(runtime: UsageSourceRuntime, fetcher?: UsageFetch): UsageResolver;
  // Only providers whose opaque credentials rotate need a named-account override.
  namedAccountKey?: (accountId: string) => string;
};

// These adapters translate Radian-owned policies, not SDK authentication or model transport.
export type ProviderAdapter = {
  readonly id: "openai" | "anthropic";
  matchesModel(model: ProviderModel): boolean;
  readonly fast: ProviderFast;
  readonly telemetry: ProviderTelemetry;
  readonly usage: ProviderAccountUsage;
};
