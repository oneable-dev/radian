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

const endpoint = "https://chatgpt.com/backend-api/wham/usage";
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const protocol = () =>
  err(
    new UsageError("USAGE_PROTOCOL_ERROR", "The account usage response has an unsupported format."),
  );

function accountId(auth: AuthResult): string | null {
  const token = auth.auth.apiKey;
  const encoded = token?.split(".")[1];
  if (!encoded) {
    return null;
  }

  const parsed = parseJson(
    Buffer.from(encoded, "base64url").toString("utf8"),
    "OAuth account claims",
  );
  if (!parsed.ok || !record(parsed.value)) {
    return null;
  }

  const claims = parsed.value["https://api.openai.com/auth"];
  if (!record(claims)) {
    return null;
  }
  for (const [name, value] of Object.entries(auth.auth.headers ?? {})) {
    if (
      name.toLowerCase() === "chatgpt-account-id" &&
      typeof value === "string" &&
      value.trim() &&
      !/[\r\n]/.test(value)
    ) {
      return value;
    }
  }

  const id = claims.chatgpt_account_id;

  return typeof id === "string" && id.trim() && !/[\r\n]/.test(id) ? id : null;
}

export function parseOpenAiUsage(value: unknown): Result<readonly UsageWindow[], UsageError> {
  if (!record(value) || !("rate_limit" in value)) {
    return protocol();
  }
  if (value.rate_limit === null) {
    return ok([]);
  }
  if (!record(value.rate_limit)) {
    return protocol();
  }

  const windows: UsageWindow[] = [];
  for (const id of ["primary", "secondary"]) {
    const window = value.rate_limit[`${id}_window`];
    if (window === undefined || window === null) {
      continue;
    }
    if (
      !record(window) ||
      typeof window.used_percent !== "number" ||
      !Number.isFinite(window.used_percent) ||
      window.used_percent < 0 ||
      window.used_percent > 100
    ) {
      return protocol();
    }

    const seconds = window.limit_window_seconds;
    const reset = window.reset_at;
    if (
      seconds !== undefined &&
      seconds !== null &&
      (typeof seconds !== "number" || seconds <= 0 || !Number.isSafeInteger(seconds * 1000))
    ) {
      return protocol();
    }
    if (
      reset !== undefined &&
      reset !== null &&
      (typeof reset !== "number" || reset <= 0 || !Number.isSafeInteger(reset * 1000))
    ) {
      return protocol();
    }

    windows.push({
      id,
      usedPercent: window.used_percent,
      periodMs: typeof seconds === "number" ? seconds * 1000 : null,
      resetsAt: typeof reset === "number" ? reset * 1000 : null,
    });
  }

  return ok(windows);
}

function retryAfterMs(header: string | null): number {
  if (!header?.trim()) {
    return 60000;
  }

  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return seconds > 0 && Number.isSafeInteger(seconds * 1000) ? seconds * 1000 : 60000;
  }

  const deadline = Date.parse(header);

  return Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : 60000;
}

async function load(
  auth: AuthResult,
  id: string,
  signal: AbortSignal,
  fetcher: Fetch,
): Promise<Result<readonly UsageWindow[], ExpectedError>> {
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "GET",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${auth.auth.apiKey}`,
        "ChatGPT-Account-Id": id,
        Accept: "application/json",
      },
    });
  } catch (error) {
    if (signal.aborted) {
      return err(new CancelledError());
    }
    if (
      error instanceof TypeError ||
      ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH"].includes(
        systemCode(error) ?? "",
      )
    ) {
      return err(
        new UsageError(
          "USAGE_QUERY_FAILED",
          "Could not reach the account usage service.",
          undefined,
          { cause: error },
        ),
      );
    }

    throw error;
  }
  if (!response.ok) {
    await response.body?.cancel();
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

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (signal.aborted) {
      return err(new CancelledError());
    }
    if (error instanceof TypeError || systemCode(error)) {
      return err(
        new UsageError(
          "USAGE_QUERY_FAILED",
          "Could not read the account usage response.",
          undefined,
          { cause: error },
        ),
      );
    }

    throw error;
  }
  if (text.length > 131072) {
    return protocol();
  }

  const parsed = parseJson(text, "account usage response");

  return parsed.ok ? parseOpenAiUsage(parsed.value) : protocol();
}

// Provider-specific HTTP/auth stays here; polling, IPC and presentation only know normalized usage.
export function openAiUsageResolver(runtime: AuthRuntime, fetcher: Fetch = fetch): UsageResolver {
  return async (provider, signal) => {
    // API keys are not subscription auth. Never send them to a ChatGPT endpoint or another provider.
    if (!["openai-codex", "openai"].includes(provider) || !runtime.isUsingOAuth(provider)) {
      return ok(null);
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

    const id = auth && accountId(auth);
    if (!auth?.auth.apiKey || !id) {
      return err(
        new UsageError(
          "USAGE_AUTH_REQUIRED",
          "The provider login has no subscription account identity.",
        ),
      );
    }

    const key = createHash("sha256").update(`openai\0${id}\0codex`).digest("hex");

    return ok({
      key,
      provider: "openai",
      load: (requestSignal) => load(auth, id, requestSignal, fetcher),
    });
  };
}
