import { openAiUsageResolver } from "../usage/providers/openai.ts";
import type { ProviderAdapter, ProviderModel, WeeklyQuota } from "./adapter.ts";

const weekMinutes = 7 * 24 * 60;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const priorityApi = (model: ProviderModel) =>
  model.api === "openai-responses" || model.api === "openai-codex-responses";
const openAiProvider = (provider: string) => provider === "openai" || provider === "openai-codex";

// Optional quota metadata must never turn a valid request into a failure.
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

    const quota = weeklyWindow(Number(used), Number(minutes), Number(reset), now);
    if (quota) {
      return quota;
    }
  }

  return null;
}

function weeklyEvent(event: Record<string, unknown>, now: number): WeeklyQuota | null {
  // Other metered buckets cannot confirm the active Codex allowance.
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

export const openAiProviderAdapter: ProviderAdapter = {
  id: "openai",
  matchesModel: (model) => openAiProvider(model.provider) || priorityApi(model),
  fast: {
    supports: priorityApi,
    apply(payload, model, enabled) {
      if (
        enabled === undefined ||
        !priorityApi(model) ||
        !record(payload) ||
        payload.model !== model.id
      ) {
        return payload;
      }
      if (enabled) {
        return { ...payload, service_tier: "priority" };
      }
      if (payload.service_tier === "priority" || payload.service_tier === "fast") {
        const next = { ...payload };
        delete next.service_tier;

        return next;
      }

      return payload;
    },
    readPayload(payload, model) {
      if (
        !priorityApi(model) ||
        !record(payload) ||
        ("model" in payload && payload.model !== model.id)
      ) {
        return null;
      }

      // Extensions may replace the payload without retaining its model field.
      return payload.service_tier === "priority" || payload.service_tier === "fast";
    },
  },
  telemetry: {
    response(response, model, now) {
      return model.api === "openai-codex-responses"
        ? { weekly: weeklyHeaders(response.headers, now) }
        : {};
    },
    event(event, model, now) {
      if (
        model.api !== "openai-codex-responses" ||
        !record(event) ||
        event.type !== "codex.rate_limits"
      ) {
        return {};
      }

      return { weekly: weeklyEvent(event, now) };
    },
  },
  usage: {
    matchesProvider: openAiProvider,
    createResolver: openAiUsageResolver,
  },
};
