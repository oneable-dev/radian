import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AsyncLocalStorage } from "node:async_hooks";
import { SubscriptionPolicyError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

type ModelRoute = {
  readonly provider: string;
  readonly api: string;
  readonly id: string;
  readonly baseUrl: string;
};

type PolicyRequest = { error?: SubscriptionPolicyError };

/** Preserve typed agent-request failures across SDK boundaries that retain only their message. */
export class SubscriptionPolicyScope {
  private readonly runs = new AsyncLocalStorage<{ request?: PolicyRequest }>();
  private readonly requests = new AsyncLocalStorage<PolicyRequest>();

  request<T>(action: () => T): T {
    const request: PolicyRequest = {};
    const run = this.runs.getStore();
    // A continuation/retry owns the terminal outcome, never an earlier request or tool call.
    if (run) run.request = request;
    return this.requests.run(request, action);
  }

  reject(error: unknown): never {
    const request = this.requests.getStore();
    if (request && error instanceof SubscriptionPolicyError) request.error = error;
    throw error;
  }

  async capture<T>(action: () => Promise<T>): Promise<{
    value: T;
    error: SubscriptionPolicyError | undefined;
  }> {
    // Each invocation owns its slot, even for overlapping prompts on the same session.
    const run: { request?: PolicyRequest } = {};
    return this.runs.run(run, async () => ({ value: await action(), error: run.request?.error }));
  }
}

/** An approved transport is not proof of the account's remaining entitlement or final charge. */
export function isSubscriptionRoute(model: ModelRoute): boolean {
  if (model.provider === "claude-code" && model.api === "claude-code-stream-json")
    return model.baseUrl === "process://claude-code";
  return (
    model.provider === "openai-codex" &&
    model.api === "openai-codex-responses" &&
    (model.baseUrl === "https://chatgpt.com/backend-api" ||
      model.baseUrl === "https://chatgpt.com/backend-api/")
  );
}

export function validateSubscriptionRoute(
  model: ModelRoute,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Result<void, SubscriptionPolicyError> {
  if (!isSubscriptionRoute(model)) {
    return err(
      new SubscriptionPolicyError(
        "SUBSCRIPTION_ROUTE_BLOCKED",
        `Subscription-only mode blocks ${model.provider}/${model.id} (${model.api}). ` +
          "Choose the claude-code provider for Claude or openai-codex for GPT in /model. " +
          "No API fallback was attempted. Footer quotas do not establish request eligibility.",
      ),
    );
  }
  if (model.provider === "claude-code" && env.PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS) {
    return err(
      new SubscriptionPolicyError(
        "SUBSCRIPTION_EXTRA_USAGE_ENABLED",
        "Subscription-only mode requires PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS to be unset. " +
          "Disable Claude usage credits in the account settings as well; CLI charge detection " +
          "can happen after a request and cannot reverse an existing charge.",
      ),
    );
  }
  return ok(undefined);
}

/**
 * Keep generation auth local to this host, including registry calls and cache warming that
 * bypass the agent stream. Pi calls this.getAuth again inside prepareRequest; preserving
 * the proxy as `this` also guards recursive virtual-model requests after physical routing.
 * Provider-string auth reads remain available for independent account/usage observations.
 */
export function subscriptionModelRuntime(
  runtime: ModelRuntime,
  failures = new SubscriptionPolicyScope(),
): ModelRuntime {
  return new Proxy(runtime, {
    get(target, property, receiver) {
      if (property !== "getAuth") return Reflect.get(target, property, receiver);
      const getAuth: ModelRuntime["getAuth"] = async (model, options) => {
        if (typeof model === "string") return target.getAuth(model, options);
        const allowed = validateSubscriptionRoute(model, { ...process.env, ...options?.env });
        // Pi's auth/transport boundary is exception-based, unlike the policy's Result contract.
        if (!allowed.ok) failures.reject(allowed.error);
        const auth = await target.getAuth(model, options);
        if (auth) {
          const resolved = auth.auth.baseUrl ? { ...model, baseUrl: auth.auth.baseUrl } : model;
          const allowed = validateSubscriptionRoute(resolved, {
            ...process.env,
            ...auth.env,
            ...options?.env,
          });
          if (!allowed.ok) failures.reject(allowed.error);
        }
        return auth;
      };
      return getAuth;
    },
  });
}

/** Guard every SDK request, including tool continuations, compaction and routed physical models. */
export function bindSubscriptionSession(
  session: { readonly agent: Pick<AgentSession["agent"], "streamFunction"> },
  failures = new SubscriptionPolicyScope(),
): () => void {
  const original = session.agent.streamFunction;
  const guarded: typeof original = (model, context, options) =>
    failures.request(() => {
      const allowed = validateSubscriptionRoute(model, { ...process.env, ...options?.env });
      // Pi's stream boundary requires rejection; the policy itself returns a typed Result.
      if (!allowed.ok) failures.reject(allowed.error);
      // Account binding can reject after resolving credentials, before the runtime facade runs.
      try {
        return Promise.resolve(original(model, context, options)).catch((error: unknown) =>
          failures.reject(error),
        );
      } catch (error) {
        return failures.reject(error);
      }
    });
  session.agent.streamFunction = guarded;
  return () => {
    if (session.agent.streamFunction === guarded) session.agent.streamFunction = original;
  };
}
