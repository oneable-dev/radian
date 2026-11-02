import { ModelsError, type AuthCheck } from "@earendil-works/pi-ai";
import { CancelledError, UsageError, knownError } from "../../errors.ts";
import { err, ok } from "../../result.ts";
import type { UsageResolver } from "../model.ts";
import { providerUsageAdapter } from "../../providers/index.ts";
import type { UsageAuthRuntime, UsageFetch } from "../../providers/adapter.ts";

export function providerUsageResolver(
  runtime: UsageAuthRuntime,
  fetcher: UsageFetch = fetch,
): UsageResolver {
  return async (provider, signal) => {
    const adapter = providerUsageAdapter(provider);
    if (!adapter) {
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
    const resolver = adapter.usage.createResolver(sourceAuthRuntime, fetcher);

    return resolver(provider, signal);
  };
}
