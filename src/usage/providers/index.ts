import { ModelsError, type AuthCheck, type AuthResult } from "@earendil-works/pi-ai";
import { CancelledError, UsageError, knownError } from "../../errors.ts";
import { err, ok } from "../../result.ts";
import type { UsageResolver } from "../model.ts";
import { anthropicUsageResolver } from "./anthropic.ts";
import { openAiUsageResolver } from "./openai.ts";

type AuthRuntime = {
  checkAuth(provider: string, options: { signal: AbortSignal }): Promise<AuthCheck | undefined>;
  getAuth(provider: string, options: { signal: AbortSignal }): Promise<AuthResult | undefined>;
};

type Fetch = (url: string, options: RequestInit) => Promise<Response>;

export function providerUsageResolver(runtime: AuthRuntime, fetcher: Fetch = fetch): UsageResolver {
  return async (provider, signal) => {
    if (!["anthropic", "openai", "openai-codex"].includes(provider)) {
      return ok(null);
    }
    if (signal.aborted) {
      return err(new CancelledError());
    }

    let auth: AuthCheck | undefined;
    try {
      // A runtime snapshot can be stale or refer to a different pinned, named account.
      auth = await runtime.checkAuth(provider, { signal });
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

    const sourceAuthRuntime = {
      isUsingOAuth: (candidate: string) => candidate === provider && auth?.type === "oauth",
      getAuth: (candidate: string, options: { signal: AbortSignal }) =>
        runtime.getAuth(candidate, options),
    };
    const resolver =
      provider === "anthropic"
        ? anthropicUsageResolver(sourceAuthRuntime, fetcher)
        : openAiUsageResolver(sourceAuthRuntime, fetcher);

    return resolver(provider, signal);
  };
}
