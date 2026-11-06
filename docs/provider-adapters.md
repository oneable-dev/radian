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

## Host tool contracts and strict generation

Radian's task, plan, subagent and supervisor tools declare a single object with an
explicit string action enum and optional action fields. Canonical plan, review,
analysis and task bodies remain closed objects. This preserves their shapes through
Claude Code's schema normalization and the native Messages nonstrict projection.

Strict generation is **best effort**, never required. Converter acceptance is not
sufficient: OpenAI's strict conversion makes every optional field required and
nullable. A closed selected action rejects those unused fields, so shared host
action declarations with optional slots explicitly opt out of strict sampling.
This preserves minimal calls such as `{ "action": "status" }` without allowing
null-filled or cross-action payloads through host validation. Action-only schemas
without optional slots may still request `json_schema` / `strict: prefer` when
the installed converter accepts them. Providers can additionally fall back when
their strict subset does not support a schema keyword.

**Host validation is the only guarantee.** The host validates the raw arguments
against the exact selected-action schema before Pi can coerce values or remove
optional nulls. Unknown/missing/alias actions return `TOOL_ACTION_UNKNOWN`;
selected-action field failures return `TOOL_ACTION_FIELDS`, JSON pointers and one
canonical skeleton. Plan graph failures and unavailable agents return
`PLAN_INVALID_SHAPE`. No aliases, extra fields or null placeholders are silently
repaired. The validator returns a Result. At Pi's `prepareArguments` SDK boundary,
a failed Result must become a tool error before SDK normalization; `execute`
validates again defensively.

A bound lead receives at most one automatic publication-correction continuation
per artifact ID and host-owned run, shared across structural and graph failures.
Successful publication clears the pending failure, not the spent budget. Exhaustion
settles with a blocked reason and retains the last valid artifact. Invalid bodies
never create revisions. This budget is independent of defect and repair counters;
correction does not authorize file changes or task execution.

## Subscription-only request routing

Production repository and CHAT hosts enable subscription-only routing for their
parent and child sessions. The model picker lists only `claude-code` with
`claude-code-stream-json` at `process://claude-code`, and `openai-codex` with
`openai-codex-responses` at `https://chatgpt.com/backend-api` (an optional single
trailing slash is accepted; credentials, query, fragment and normalized URL aliases
are not). Native Anthropic, direct OpenAI APIs, aliases and custom endpoint overrides
are not approved generation routes. Offline fixtures and embedded SDK tests opt into
this policy explicitly; they never establish real billing entitlement.

Filtering is not the permission boundary. Radian checks the exact provider/API/baseUrl
allowlist on direct selection, explicit agent profiles and every agent SDK request.
Account-bound requests are checked again after credentials resolve, using the resolved
baseUrl and merged process/auth environment. A host-local ModelRuntime facade also
checks model-object auth resolutions before and after auth resolution, including the
resolved baseUrl and merged process/auth/request environment. This covers extension
registry completions, routed physical models and deferred responses outside the agent
stream. These checks enforce the route allowlist and the usage-credit environment
restriction below; they do not reject arbitrary environment overrides. SDK cache warming
also uses this runtime. Radian disables warming for all hosted parent and child sessions
with a session-local settings getter, including after resource reload. Pi 1.2.0 reads
this global-only setting outside `applyOverrides()`, so an effective-settings override
alone is insufficient. The getter override does not persist changes to the user's global
`cacheWarming` preference. Classifier and image generation through that runtime are blocked
when they do not use an approved subscription route. Provider-string auth reads for account and
quota observations are not generation authorization. An existing conversation with a
blocked selection remains readable and selectable, but cannot generate until the user
chooses an approved provider. No automatic provider substitution or API fallback
occurs, and no global profile, credential or account preference is rewritten.

For `claude-code`, Radian itself rejects a nonempty
`PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS` override until the user unsets it. This is the
only environment variable rejected by Radian's subscription policy. Policy failures
use typed `SUBSCRIPTION_ROUTE_BLOCKED` or `SUBSCRIPTION_EXTRA_USAGE_ENABLED` errors.
Agent prompt Results surface these codes only when the policy rejection is the
terminal agent-request cause; a handled nested tool rejection must not replace a
later unrelated transport failure or successful result.

Auth/backend environment refusal is enforced by the external `pi-claude-code`
extension, not by Radian. The verified version is **0.1.0**. In its
`src/claude-cli.ts`, `launchPlan` calls `processEnvironment` and
`conflictingEnvironment` before process acquisition or spawn, checking the merged
`process.env` and request environment (`options.env`). It refuses nonempty
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and
`ANTHROPIC_FOUNDRY_API_KEY`, and enabled `CLAUDE_CODE_USE_BEDROCK`,
`CLAUDE_CODE_USE_VERTEX` and `CLAUDE_CODE_USE_FOUNDRY` flags. Independent QA verified
refusal before spawn for all seven variables from each environment source (14 cases).
Subscription-only routing relies on this extension behavior; extension updates require
re-verification of this boundary rather than assuming Radian enforces these checks.

Account-level Claude usage credits must also be disabled by the user. An approved CLI
route is **not a guarantee of zero extra charges**: the external CLI/provider owns
entitlement and charge detection may occur after a request. Radian does not inspect
or modify Claude Code credentials or reverse charges.

Footer subscription quotas are independent account-usage observations, not proof
that a model request is authorized on that account or transport. Usage-only
native account connections are not relabelled as Claude Code accounts; Claude
Code continues to own its separate login.

This policy guards Radian-hosted SDK generation, not arbitrary process activity.
Extensions and tools remain trusted executable code: direct HTTP calls, external
commands, raw provider functions or separately created runtimes are not sandboxed by
this routing policy. Review those integrations separately before enabling them.

## Verification boundary

Tests use isolated temporary SDK sessions and loopback/injected-fetch provider fixtures.
They verify serialized request bodies and beta headers, Fast ON/OFF and unsupported routes,
response observations, extension hook composition, persistence/restoration, and account/cache
isolation. They do not establish live entitlement, effective billing, or production latency.
No live credentials, paid probes, production runtime restarts, or unrelated footer fixes
are part of validation.
