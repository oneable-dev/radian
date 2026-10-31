import { estimateTokens, type AgentSession } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage, type Api, type Model } from "@earendil-works/pi-ai";
import type { SessionTelemetry, WeeklyQuota } from "./telemetry.ts";
import type { UsageMonitor } from "../usage/monitor.ts";
import type {
  UsageGroupSubscription,
  UsageRefreshMode,
  UsageSubscription,
} from "../usage/model.ts";
import type { FastMode } from "./fast-mode.ts";

const weekMinutes = 7 * 24 * 60;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const scope = (model: Model<Api>) => JSON.stringify([model.provider, model.api, model.id]);
const priorityApi = (model: Model<Api>) =>
  model.api === "openai-responses" || model.api === "openai-codex-responses";

// Quota metadata is optional. Unsupported/malformed metadata is unknown, never a failed model request.
function weeklyWindow(
  used: unknown,
  minutes: unknown,
  reset: unknown,
  now: number,
): WeeklyQuota | null {
  if (
    typeof used !== "number" ||
    !Number.isFinite(used) ||
    used < 0 ||
    used > 100 ||
    minutes !== weekMinutes ||
    typeof reset !== "number" ||
    !Number.isSafeInteger(reset) ||
    !Number.isSafeInteger(reset * 1000) ||
    reset * 1000 <= now
  ) {
    return null;
  }

  return { remainingPercent: 100 - used, resetsAt: reset * 1000, observedAt: now };
}

function weeklyHeaders(headers: Record<string, string>, now: number): WeeklyQuota | null {
  const normalized = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  for (const name of ["primary", "secondary"]) {
    const prefix = `x-codex-${name}`;
    const used = normalized.get(`${prefix}-used-percent`);
    const minutes = normalized.get(`${prefix}-window-minutes`);
    const reset = normalized.get(`${prefix}-reset-at`);
    if (
      typeof used !== "string" ||
      typeof minutes !== "string" ||
      typeof reset !== "string" ||
      !used.trim() ||
      !minutes.trim() ||
      !reset.trim()
    ) {
      continue;
    }

    const value = weeklyWindow(Number(used), Number(minutes), Number(reset), now);
    if (value) {
      return value;
    }
  }

  return null;
}

function weeklyEvent(event: Record<string, unknown>, now: number): WeeklyQuota | null {
  // Other metered buckets are not interchangeable with the active Codex allowance.
  if (
    event.metered_limit_name !== undefined &&
    event.metered_limit_name !== null &&
    event.metered_limit_name !== "codex"
  ) {
    return null;
  }
  if (!record(event.rate_limits)) {
    return null;
  }
  for (const value of [event.rate_limits.primary, event.rate_limits.secondary]) {
    if (!record(value)) {
      continue;
    }

    const quota = weeklyWindow(value.used_percent, value.window_minutes, value.reset_at, now);
    if (quota) {
      return quota;
    }
  }

  return null;
}

// Preserves SDK observers and applies only explicitly selected, session-local request settings.
export class PiSessionTelemetry {
  private requestScope: string | null = null;
  private fast: boolean | null = null;
  private weekly: WeeklyQuota | null = null;
  private contextCache: { key: string; value: SessionTelemetry["context"] } | undefined;
  private readonly previous;
  private readonly usage: UsageSubscription | undefined;
  private readonly providerUsage: UsageGroupSubscription | undefined;
  private readonly unsubscribeFast: (() => void) | undefined;

  constructor(
    private readonly session: AgentSession,
    private readonly changed: () => void,
    usage?: UsageMonitor,
    private readonly fastMode?: FastMode,
  ) {
    this.usage = usage?.watch(changed);
    this.providerUsage = usage?.watchAll(changed);
    this.unsubscribeFast = fastMode?.subscribe(changed);

    const agent = session.agent;
    this.previous = {
      payload: agent.onPayload,
      response: agent.onResponse,
      event: agent.onProviderStreamEvent,
    };
    agent.onPayload = this.payload;
    agent.onResponse = this.response;
    agent.onProviderStreamEvent = this.event;
  }

  private useScope(model: Model<Api>): void {
    const next = scope(model);
    if (next !== this.requestScope) {
      this.fast = null;
      this.weekly = null;
    }

    this.requestScope = next;
  }

  private payload: NonNullable<AgentSession["agent"]["onPayload"]> = async (payload, model) => {
    const replacement = await this.previous.payload?.(payload, model);
    const transformed = replacement === undefined ? payload : replacement;
    const outgoing = this.fastMode ? this.fastMode.apply(transformed, model) : transformed;

    this.useScope(model);
    this.fast =
      priorityApi(model) && record(outgoing)
        ? outgoing.service_tier === "priority" || outgoing.service_tier === "fast"
        : null;
    if (this.fast !== null) {
      this.fastMode?.observe(model, this.fast);
    }

    // A fresh response must confirm the account allowance again; do not carry it across credentials or buckets.
    this.weekly = null;
    this.changed();

    return outgoing === transformed ? replacement : outgoing;
  };

  private response: NonNullable<AgentSession["agent"]["onResponse"]> = async (response, model) => {
    await this.previous.response?.(response, model);
    if (model.api !== "openai-codex-responses") {
      return;
    }

    this.useScope(model);
    this.weekly = weeklyHeaders(response.headers, Date.now());
    this.changed();
  };

  private event: NonNullable<AgentSession["agent"]["onProviderStreamEvent"]> = async (
    event,
    model,
  ) => {
    await this.previous.event?.(event, model);
    if (
      model.api !== "openai-codex-responses" ||
      !record(event) ||
      event.type !== "codex.rate_limits"
    ) {
      return;
    }

    this.useScope(model);
    this.weekly = weeklyEvent(event, Date.now());
    this.changed();
  };

  read(): SessionTelemetry {
    const routed = this.session.routedModel;
    const model = routed?.model ?? this.session.model;
    // Streaming deltas do not change finalized context. Avoid rebuilding the projection on every token.
    const key = `${this.session.sessionManager.getLeafId()}/${model ? scope(model) : ""}/${model?.contextWindow}`;
    if (key !== this.contextCache?.key) {
      const usage = this.session.getContextUsage();
      let usedTokens = usage?.tokens ?? null;
      if (usage && usedTokens === null) {
        // Pre-compaction usage is stale. Estimate only the current projection, replaying system patches once.
        const { messages } = this.session.sessionManager.buildSessionProjection();
        const system = getCurrentSystemMessage(messages);

        usedTokens = system ? estimateTokens(system) : 0;
        for (const message of messages) {
          if (message.role !== "system") {
            usedTokens += estimateTokens(message);
          }
        }
      }

      this.contextCache = {
        key,
        value: usage ? { usedTokens, maxTokens: usage.contextWindow } : null,
      };
    }

    const matches = model !== undefined && scope(model) === this.requestScope;

    return {
      provider: model?.provider ?? null,
      model: model?.id ?? null,
      effort: routed?.thinkingLevel ?? this.session.thinkingLevel ?? null,
      fast: this.fastMode?.read(model) ?? (matches ? this.fast : null),
      context: this.contextCache.value,
      weekly: matches && this.weekly && this.weekly.resetsAt > Date.now() ? this.weekly : null,
      ...(this.usage ? { usage: this.usage.read(model?.provider ?? null) } : {}),
      ...(this.providerUsage ? { providerUsage: this.providerUsage.read() } : {}),
    };
  }

  invalidateAccount(): void {
    this.requestScope = null;
    this.weekly = null;
    this.fast = null;
    this.changed();
  }

  refreshUsage(mode: UsageRefreshMode = "automatic"): void {
    this.read();
    this.usage?.refresh(mode);
    this.providerUsage?.refresh(mode);
  }

  dispose(): void {
    this.usage?.dispose();
    this.providerUsage?.dispose();
    this.unsubscribeFast?.();

    const agent = this.session.agent;
    if (agent.onPayload === this.payload) {
      agent.onPayload = this.previous.payload;
    }
    if (agent.onResponse === this.response) {
      agent.onResponse = this.previous.response;
    }
    if (agent.onProviderStreamEvent === this.event) {
      agent.onProviderStreamEvent = this.previous.event;
    }
  }
}
