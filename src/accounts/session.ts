import { cleanupSessionResources, ModelsError } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AccountManager } from "./manager.ts";

// Pin credentials at each model-request boundary, not at the start of an agent/tool run.
export function bindAccountSession(
  manager: AccountManager,
  worktreeId: string,
  session: AgentSession,
): () => void {
  const original = session.agent.streamFunction,
    scopes = new Set<string>();
  session.agent.streamFunction = (model, context, options) =>
    manager.request(worktreeId, async (runtime, identity) => {
      const auth = await runtime.getAuth(model, options?.signal ? { signal: options.signal } : {});
      if (!auth)
        throw new ModelsError(
          "auth",
          "The selected provider has no authentication. Open /accounts to configure it.",
        );
      const sessionId = manager.transportScope(options?.sessionId ?? session.sessionId, auth);
      scopes.add(sessionId);
      const stamp = identity(model.provider);
      const current = () => manager.selectionIdentity(worktreeId, model.provider) === stamp;
      // Compaction may pass previously resolved auth in options. Do not carry A's key/env or
      // authorization headers into a request that is now bound to B.
      const { apiKey: _key, headers: previousHeaders, env: _env, ...rest } = options ?? {};
      const headers = Object.fromEntries(
        Object.entries(previousHeaders ?? {}).filter(
          ([name]) =>
            ![
              "authorization",
              "x-api-key",
              "api-key",
              "chatgpt-account-id",
              "x-goog-api-key",
            ].includes(name.toLowerCase()),
        ),
      );
      return original(
        auth.auth.baseUrl ? { ...model, baseUrl: auth.auth.baseUrl } : model,
        context,
        {
          ...rest,
          sessionId,
          ...(auth.auth.apiKey !== undefined ? { apiKey: auth.auth.apiKey } : {}),
          headers: { ...headers, ...auth.auth.headers },
          ...(auth.env ? { env: auth.env } : {}),
          onResponse: async (response, model) => {
            if (current()) await options?.onResponse?.(response, model);
          },
          onProviderStreamEvent: async (event, model) => {
            if (current()) await options?.onProviderStreamEvent?.(event, model);
          },
        },
      );
    });
  return () => {
    for (const scope of scopes) cleanupSessionResources(scope);
    scopes.clear();
  };
}
