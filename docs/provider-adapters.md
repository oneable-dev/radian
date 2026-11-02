# Provider adapters

## Delivery scope

This implementation follows the user's final instructions after the saved task graph:

- Introduce composed OpenAI and Anthropic `ProviderAdapter` implementations.
- Include Anthropic Fast support for verified native Messages API routes.
- Exclude the subsequently discussed footer ordering, robot-icon, and dash defects,
  including their display-only provider metadata. No footer or branding redesign is included.
- Keep parent and child Fast choices independent. Do not add setting inheritance.
- Do not add automatic speed fallback, a billing subsystem, SDK patches, or dependencies.

The saved graph's footer task and footer-specific criteria are not applicable to this
explicitly narrowed delivery. Anthropic Fast inclusion is no longer an open question.

## Ownership

`src/providers/adapter.ts` defines `ProviderAdapter` and its related capability types.
It is a contract for provider behavior, not another LLM model abstraction.

| Boundary             | Responsibility                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider adapter     | Fast eligibility and payload conversion; request-mode inspection; response/event observations; usage-source selection; provider-specific private account identity |
| `FastMode`           | Explicit per-conversation/model choices, slash commands, branch restoration, persistence warnings, and change subscriptions                                       |
| `PiSessionTelemetry` | SDK hook chaining, normalized observation state, context projection, and account-usage subscriptions                                                              |
| `UsageMonitor`       | Polling, shared account cache, request coalescing, cooldowns, invalidation, and shutdown                                                                          |
| `AccountManager`     | Workspace account selection and pinned auth contexts; it supplies named account IDs without knowing a provider's key format                                       |
| Pi SDK               | Login, credential refresh, model discovery, inference encoding/transport/streaming, and existing retry behavior                                                   |

The registry has separate lookups for model requests and account usage. OpenAI-compatible
request APIs retain their existing Fast support even under custom provider IDs. That
compatibility never authorizes a custom provider to access OpenAI subscription endpoints.
Provider implementations compose the existing isolated sources under `src/usage/providers/`;
credentials and private cache keys never enter UI snapshots.

## Fast support

| Route                                                                             | Models                             | Request                                                                 |
| --------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| OpenAI Responses / Codex Responses, including existing compatible provider IDs    | Existing model selection           | `service_tier: "priority"`                                              |
| Native `anthropic` / `anthropic-messages` at the HTTPS `api.anthropic.com` origin | `claude-opus-5-5`                  | `speed: "fast"`                                                         |
| Same native Anthropic route                                                       | `claude-opus-5`, `claude-opus-4-8` | `speed: "fast"` plus `fast-mode-2026-02-01`, merged with existing betas |

Native Anthropic API-key and OAuth authentication use the same payload instrumentation;
the SDK continues owning authentication. A toggle does not resolve credentials, probe
entitlement, send a model request, change effort, or write global configuration. Actual
access and billing depend on the account and the service's response.

Anthropic support is an exact model/route allowlist, not an Opus-name prefix. Opus 4.6
Fast requests can silently execute at standard speed; Opus 4.7 does not support Fast.
Neither is advertised as supported. Opus 4.8 Fast is deprecated and scheduled for removal
on November 30, 2026; the allowlist must be updated when service availability changes.
Other gateways and SDK providers are not inferred to support native Anthropic Fast.

The separately installed `claude-code` provider uses `claude-code-stream-json` and an
external CLI rather than the native Messages encoder. Its current stream implementation
does not invoke the SDK payload/response/provider-event hooks. It is not aliased to
`anthropic`, charged through another account, or advertised as controlled by Radian's
native `/fast` integration. Supporting that transport requires an instrumentation change
in its provider extension; this delivery does not modify external packages.

Sources checked during implementation:

- [Anthropic Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode)
- Installed Pi 1.2.0 Messages encoder and Anthropic SDK request types.
- Installed `pi-claude-code` provider/stream source (read-only).

Fast requests have premium pricing, and Anthropic standard/Fast prefixes use separate
prompt caches. Account quotas and SDK list-price cost estimates are not a verified bill.
This delivery does not rewrite normalized SDK token-cost accounting or retry policy.

## Preference and observations

`telemetry.fast` retains its existing purpose as the selected request mode. Explicit
user choices take precedence over observed outgoing payloads, are saved per provider/API/
model on the active branch, and are restored without paid calls. Observations never become
persistent opt-ins. A rejected request or a standard-speed response does not silently
cancel the user's next-request preference.

`telemetry.fastObserved` is optional for backward compatibility and reports provider-
confirmed execution mode: `true`, `false`, or `null` when unconfirmed. It resets for a new
request or account scope. An outgoing Fast field alone does not confirm execution speed.
Unrelated stream events preserve existing observations; a relevant event with unknown
metadata can explicitly report unknown. No server latency guarantee is inferred.

Malformed optional quota/speed metadata remains unknown rather than becoming a model
failure or an invented zero. Expected usage/authentication failures retain typed Results
and stable codes; unexpected programming exceptions retain their identity. A generic 403 or opaque
SDK authentication exception is not confirmed evidence that interactive login is required. Named
account recovery reuses credential-bound quota evidence and account-scoped cooldowns instead of
introducing a separate authentication probe loop; see [Account authentication recovery](account-reauthentication.md).

## Verification boundary

Tests use isolated temporary SDK sessions and loopback/injected-fetch provider fixtures.
They verify serialized request bodies and beta headers, Fast ON/OFF and unsupported routes,
response observations, extension hook composition, persistence/restoration, and account/cache
isolation. They do not establish live entitlement, effective billing, or production latency.
No live credentials, paid probes, production runtime restarts, or unrelated footer fixes
are part of validation.
