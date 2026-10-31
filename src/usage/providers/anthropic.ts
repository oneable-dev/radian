import { createHash } from "node:crypto";
import { ModelsError, type AuthResult } from "@earendil-works/pi-ai";
import {
  CancelledError,
  UsageError,
  knownError,
  parseJson,
  systemCode,
  type ExpectedError,
} from "../../errors.ts";
import { err, ok, type Result } from "../../result.ts";
import type { UsageResolver, UsageWindow } from "../model.ts";

type AuthRuntime = {
  isUsingOAuth(provider: string): boolean;
  getAuth(provider: string, options: { signal: AbortSignal }): Promise<AuthResult | undefined>;
};

type Fetch = (url: string, options: RequestInit) => Promise<Response>;

const endpoint = "https://api.anthropic.com/api/oauth/usage";
const minRefreshMs = 300000;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const protocol = () =>
  err(
    new UsageError("USAGE_PROTOCOL_ERROR", "The account usage response has an unsupported format."),
  );

function resetTimestamp(value: string): number | null {
  // Date.parse alone accepts non-ISO strings and silently rolls invalid calendar dates forward.
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) {
    return null;
  }

  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const zone = parts[7]!;
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]! ||
    Number(parts[4]) > 23 ||
    Number(parts[5]) > 59 ||
    Number(parts[6]) > 59 ||
    (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))
  ) {
    return null;
  }

  const timestamp = Date.parse(value);

  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
}

export function parseAnthropicUsage(value: unknown): Result<readonly UsageWindow[], UsageError> {
  if (!record(value) || !("five_hour" in value || "seven_day" in value)) {
    return protocol();
  }

  const windows: UsageWindow[] = [];
  // Model-specific weekly quotas are not substitutes for the overall subscription allowance.
  for (const [id, periodMs] of [
    ["five_hour", 18000000],
    ["seven_day", 604800000],
  ] as const) {
    const window = value[id];
    if (window === undefined || window === null) {
      continue;
    }
    if (!record(window)) {
      return protocol();
    }

    const utilization = window.utilization;
    if (
      utilization !== undefined &&
      utilization !== null &&
      (typeof utilization !== "number" ||
        !Number.isFinite(utilization) ||
        utilization < 0 ||
        utilization > 100)
    ) {
      return protocol();
    }

    const reset = window.resets_at;
    if (reset !== undefined && reset !== null && typeof reset !== "string") {
      return protocol();
    }
    const resetsAt = typeof reset === "string" ? resetTimestamp(reset) : null;
    if (typeof reset === "string" && resetsAt === null) {
      return protocol();
    }
    if (utilization === undefined || utilization === null) {
      continue;
    }

    windows.push({ id, usedPercent: utilization, periodMs, resetsAt });
  }

  return ok(windows);
}

function retryAfterMs(header: string | null): number {
  const value = header?.trim();
  if (!value) {
    return minRefreshMs;
  }
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const milliseconds = Number(value) * 1000;

    return milliseconds > 0 && Number.isSafeInteger(milliseconds) ? milliseconds : minRefreshMs;
  }
  // Do not let Date.parse reinterpret invalid numeric values (for example "-1") as dates.
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
    return minRefreshMs;
  }

  const deadline = Date.parse(value);
  const wait = deadline - Date.now();

  return Number.isSafeInteger(wait) && wait > 0 ? wait : minRefreshMs;
}

function transportError(error: unknown, signal: AbortSignal): ExpectedError | null {
  if (signal.aborted) {
    return new CancelledError();
  }
  const known = knownError(error);
  if (known) {
    return known;
  }
  if (
    error instanceof TypeError ||
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EHOSTUNREACH",
      "EAI_AGAIN",
      "EPIPE",
    ].includes(systemCode(error) ?? "")
  ) {
    return new UsageError(
      "USAGE_QUERY_FAILED",
      "Could not reach or read the account usage service.",
      undefined,
      { cause: error },
    );
  }

  return null;
}

async function load(
  access: string,
  signal: AbortSignal,
  fetcher: Fetch,
): Promise<Result<readonly UsageWindow[], ExpectedError>> {
  if (signal.aborted) {
    return err(new CancelledError());
  }

  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "GET",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${access}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      },
    });
  } catch (error) {
    const expected = transportError(error, signal);
    if (expected) {
      return err(expected);
    }

    throw error;
  }

  let text = "";
  try {
    // A cancellation can win even if a transport returns a completed response afterward.
    if (signal.aborted || !response.ok) {
      await response.body?.cancel();
    } else {
      text = await response.text();
    }
  } catch (error) {
    const expected = transportError(error, signal);
    if (expected) {
      return err(expected);
    }

    throw error;
  }
  if (signal.aborted) {
    return err(new CancelledError());
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return err(
        new UsageError(
          "USAGE_AUTH_REQUIRED",
          "Account usage access was denied. Check the provider login.",
        ),
      );
    }
    if (response.status === 429) {
      return err(
        new UsageError(
          "USAGE_RATE_LIMITED",
          "Account usage lookup is rate limited.",
          retryAfterMs(response.headers.get("retry-after")),
        ),
      );
    }

    return err(
      new UsageError(
        "USAGE_QUERY_FAILED",
        `Account usage lookup returned HTTP ${response.status}.`,
      ),
    );
  }
  if (text.length > 131072) {
    return protocol();
  }

  const parsed = parseJson(text, "account usage response");

  return parsed.ok ? parseAnthropicUsage(parsed.value) : protocol();
}

export function anthropicUsageResolver(
  runtime: AuthRuntime,
  fetcher: Fetch = fetch,
): UsageResolver {
  return async (provider, signal) => {
    if (provider !== "anthropic" || !runtime.isUsingOAuth(provider)) {
      return ok(null);
    }
    if (signal.aborted) {
      return err(new CancelledError());
    }

    let auth: AuthResult | undefined;
    try {
      auth = await runtime.getAuth(provider, { signal });
    } catch (error) {
      if (signal.aborted) {
        return err(new CancelledError());
      }
      if (error instanceof ModelsError && (error.code === "auth" || error.code === "oauth")) {
        return err(
          new UsageError(
            "USAGE_AUTH_REQUIRED",
            "Could not resolve the provider login.",
            undefined,
            { cause: error },
          ),
        );
      }
      const known = knownError(error);
      if (known) {
        return err(known);
      }

      throw error;
    }
    if (signal.aborted) {
      return err(new CancelledError());
    }

    const access = auth?.auth.apiKey;
    // Reject API keys and other providers' tokens even if the auth type changed during lookup.
    if (!access || !/^sk-ant-oat\d+-[A-Za-z0-9_-]+$/.test(access)) {
      return err(
        new UsageError(
          "USAGE_AUTH_REQUIRED",
          "The provider login has no Anthropic OAuth access token.",
        ),
      );
    }

    const key = createHash("sha256").update(`anthropic\0${access}`).digest("hex");

    return ok({
      key,
      provider: "anthropic",
      minRefreshMs,
      load: (requestSignal) => load(access, requestSignal, fetcher),
    });
  };
}
