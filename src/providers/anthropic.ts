import { createHash } from "node:crypto";
import { anthropicUsageResolver } from "../usage/providers/anthropic.ts";
import type { ProviderAdapter, ProviderModel } from "./adapter.ts";

const fastBeta = "fast-mode-2026-02-01";
const fastModels = new Set(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function nativeModel(model: ProviderModel): boolean {
  if (
    model.provider !== "anthropic" ||
    model.api !== "anthropic-messages" ||
    !URL.canParse(model.baseUrl)
  ) {
    return false;
  }

  const url = new URL(model.baseUrl);

  return url.origin === "https://api.anthropic.com" && !url.username && !url.password;
}

function supportsFast(model: ProviderModel): boolean {
  // Fast entitlement cannot be inferred from a gateway's branding or protocol compatibility.
  return nativeModel(model) && fastModels.has(model.id);
}

function validBetas(value: unknown): value is string[] | undefined {
  if (value === undefined) {
    return true;
  }
  if (!Array.isArray(value)) {
    return false;
  }
  for (const beta of value) {
    if (typeof beta !== "string" || !beta.trim()) {
      return false;
    }
  }

  return true;
}

function observedSpeed(usage: unknown): boolean | null {
  if (!record(usage)) {
    return null;
  }
  if (usage.speed === "fast") {
    return true;
  }
  if (usage.speed === "standard") {
    return false;
  }

  return null;
}

export const anthropicProviderAdapter: ProviderAdapter = {
  id: "anthropic",
  matchesModel: nativeModel,
  fast: {
    warning:
      "Anthropic Fast uses premium pricing and a separate prompt cache; account access is required.",
    supports: supportsFast,
    apply(payload, model, enabled) {
      if (
        (enabled !== true && enabled !== false) ||
        !supportsFast(model) ||
        !record(payload) ||
        payload.model !== model.id
      ) {
        return payload;
      }
      if (enabled) {
        if (!validBetas(payload.betas)) {
          return payload;
        }
        const next = { ...payload, speed: "fast" };
        if (model.id !== "claude-opus-5-5" && !payload.betas?.includes(fastBeta)) {
          return { ...next, betas: [...(payload.betas ?? []), fastBeta] };
        }

        return next;
      }

      // An explicit opt-out must remove premium speed even if an extension supplied malformed betas.
      const existingBetas = validBetas(payload.betas) ? payload.betas : undefined;
      const hasFastBeta = existingBetas?.includes(fastBeta);
      if (payload.speed !== "fast" && !hasFastBeta) {
        return payload;
      }

      const next = { ...payload };
      if (next.speed === "fast") {
        delete next.speed;
      }
      if (hasFastBeta && existingBetas) {
        const betas = existingBetas.filter((beta) => beta !== fastBeta);
        if (betas.length) {
          next.betas = betas;
        } else {
          delete next.betas;
        }
      }

      return next;
    },
    readPayload(payload, model) {
      if (
        !supportsFast(model) ||
        !record(payload) ||
        ("model" in payload && payload.model !== model.id) ||
        !validBetas(payload.betas)
      ) {
        return null;
      }
      if (payload.speed === "fast") {
        return true;
      }
      if (payload.speed === undefined || payload.speed === "standard") {
        return false;
      }

      return null;
    },
  },
  telemetry: {
    response: () => ({}),
    event(event, model) {
      if (!nativeModel(model) || !record(event)) {
        return {};
      }
      if (event.type === "message_start") {
        return { fastObserved: observedSpeed(record(event.message) ? event.message.usage : null) };
      }
      if (event.type === "message_delta" && record(event.usage) && "speed" in event.usage) {
        return { fastObserved: observedSpeed(event.usage) };
      }

      return {};
    },
  },
  usage: {
    matchesProvider: (provider) => provider === "anthropic",
    createResolver: anthropicUsageResolver,
    // Opaque OAuth tokens rotate; retain the existing named account's private cache identity.
    namedAccountKey: (id) => createHash("sha256").update(`anthropic\0account\0${id}`).digest("hex"),
  },
};
