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
import { providerAdapter } from "../providers/index.ts";
import type { ProviderObservations } from "../providers/adapter.ts";

const scope = (model: Model<Api>) => JSON.stringify([model.provider, model.api, model.id]);

// Preserves SDK observers and applies only explicitly selected, session-local request settings.
export class PiSessionTelemetry {
  private requestScope: string | null = null;
  private fast: boolean | null = null;
  private fastObserved: boolean | null = null;
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
      this.fastObserved = null;
      this.weekly = null;
    }

    this.requestScope = next;
  }

  private payload: NonNullable<AgentSession["agent"]["onPayload"]> = async (payload, model) => {
    const replacement = await this.previous.payload?.(payload, model);
    const transformed = replacement === undefined ? payload : replacement;
    const outgoing = this.fastMode ? this.fastMode.apply(transformed, model) : transformed;

    this.useScope(model);
    this.fast = providerAdapter(model)?.fast.readPayload(outgoing, model) ?? null;
    this.fastObserved = null;
    if (this.fast !== null) {
      this.fastMode?.observe(model, this.fast);
    }

    // A fresh response must confirm the account allowance again; do not carry it across credentials or buckets.
    this.weekly = null;
    this.changed();

    return outgoing === transformed ? replacement : outgoing;
  };

  private observe(observations: ProviderObservations | undefined, model: Model<Api>): void {
    if (
      !observations ||
      (observations.fastObserved === undefined && observations.weekly === undefined)
    ) {
      return;
    }

    this.useScope(model);
    if (observations.fastObserved !== undefined) {
      this.fastObserved = observations.fastObserved;
    }
    if (observations.weekly !== undefined) {
      this.weekly = observations.weekly;
    }
    this.changed();
  }

  private response: NonNullable<AgentSession["agent"]["onResponse"]> = async (response, model) => {
    await this.previous.response?.(response, model);
    this.observe(providerAdapter(model)?.telemetry.response(response, model, Date.now()), model);
  };

  private event: NonNullable<AgentSession["agent"]["onProviderStreamEvent"]> = async (
    event,
    model,
  ) => {
    await this.previous.event?.(event, model);
    this.observe(providerAdapter(model)?.telemetry.event(event, model, Date.now()), model);
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
      fastObserved: matches ? this.fastObserved : null,
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
    this.fastObserved = null;
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
