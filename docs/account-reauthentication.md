# Account authentication recovery

## Scope and intent

Activating an already-active, named OAuth account in `/accounts` checks its authentication before deciding whether interactive recovery is needed. Selecting an inactive account and adding a separate account retain their existing behavior. External **Existing login** entries and API keys retain their original credential ownership; this flow does not replace them.

Normal OAuth expiry remains the SDK's responsibility. Radian does not implement a second refresh-token client, intercept global fetch, or parse SDK error messages. Automatic assessment initially supports canonical Anthropic accounts. Other managed OAuth accounts can be reauthenticated explicitly, but unsupported automatic checks report an indeterminate result.

## Evidence and decisions

`checkAuth()` only establishes configured OAuth credentials. `getAuth()` can refresh expiring credentials through the SDK credential-store lock, but merely obtaining a token does not prove that the remote service accepts it.

Checks reuse the usage monitor's authenticated read, request sharing, timeout, and account-scoped cooldowns. Evidence belongs to the account and credential generation that produced it, not just to the provider name.

| Evidence                                                                              | Decision                  | Interaction                                                 |
| ------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------- |
| Successful authenticated usage response, including a valid empty quota response       | Valid                     | Retain the account and update permitted usage               |
| Missing resolved credentials for the pinned OAuth account                             | Reauthentication required | Start that account's login flow                             |
| HTTP 401 from the canonical usage endpoint after successful SDK credential resolution | Reauthentication required | Start that account's login flow                             |
| Ordinary expiry followed by successful SDK refresh                                    | Continue assessment       | No interactive login solely because a token expired         |
| Generic HTTP 403, malformed token/response, network failure, timeout, HTTP 429 or 5xx | Indeterminate             | Explain the failure; do not launch login                    |
| Opaque SDK `auth`/`oauth` failure or storage failure                                  | Indeterminate             | Retain credentials and offer explicit recovery              |
| Unsupported provider or no current credential-bound evidence during cooldown          | Indeterminate             | Explain the limitation and retain the account               |
| Cancellation                                                                          | Cancelled operation       | Do not reopen the hidden popup or claim invalid credentials |

Pi 1.2.0's Anthropic refresh implementation embeds remote error details in ordinary exception text. A structured `invalid_grant` is therefore **not** assumed to be available. In particular, sending an expired access token after an indeterminate refresh and receiving 401 would not prove that its refresh token was revoked. No such shortcut is used.

Successful HTTP access is evidence for that endpoint, not proof of every permission or product entitlement. Rate limits, `Retry-After`, and the Claude minimum lookup interval remain enforced. Reauthentication clears obsolete authentication conclusions but does not promise an immediate quota response during a cooldown.

## Commands and IPC

- `accounts.choose` (`<CR>`): select an inactive account; check an already-active named OAuth account.
- `accounts.reauthenticate` (`R` in account results by default): explicitly reconnect the selected named OAuth account even when automatic assessment is indeterminate. The key is configurable and remains literal in search/input fields.
- `check`: a revision-checked, workspace-bound request for the explicitly active named OAuth account. It returns the existing catalog reply (with a warning for indeterminate checks), or the existing login reply when reauthentication is confirmed.
- `reauthenticate`: an explicit, revision-checked request targeting a named OAuth account; it never changes account selections.
- New requests require the `account-reauthentication` runtime capability. Unsupported old runtimes reject the operation instead of silently adding an account or restarting.
- Recovery login views carry `intent: "reauthenticate"`; existing Add account views remain compatible. Login polling, answers, manual-code entry, and cancellation reuse their established protocol.
- IPC recovery waits for the first poll/answer to acknowledge receipt of the flow ID before starting provider login. An unacknowledged flow expires after ten seconds; an adopted flow receives the normal fifteen-minute login window. The client also attempts a bounded cancellation against the original daemon if it must discard an already-decoded pending reply.

Only user commands start authentication. Discovery, background usage polling, and transcript/history rendering never open a browser.

## Credential replacement

A recovery flow pins an existing local account and its credential version. It does not allocate a new account ID, ask for another account label, or change any workspace/CHAT selection. The shared account's current label is retained. Existing in-flight requests keep their pinned authentication context.

Known remote account identifiers must match; a known duplicate identity belonging to another stored account is rejected. When either old or new credentials lack a trustworthy remote identifier, the flow explains that same-account identity cannot be verified and requires an explicit in-content confirmation before replacement. Declining retains the previous local credentials. Local ID preservation is not advertised as verified remote identity.

Credential replacement is serialized with account refresh and storage writes. A deleted target, changed credential, conflicting identity, or stale request must not silently receive a late login result. Browser interaction must not hold the global persistence lock. After accepted replacement, all affected consumers are notified and superseded usage responses cannot restore obsolete authentication evidence.

Cancellation or failure before acceptance retains the previous local credential. Closing a popup cannot undo a remote rotation or an already accepted save. If a remotely accepted credential cannot be persisted, the daemon retains the recoverable credential in memory and reports a persistence warning rather than pretending the login was rolled back. Repair storage before restarting that daemon.

## UI and verification

Checks preserve the current search query, caret, focus, and candidate. Existing popup activity placement and keyboard commands are reused. Authentication stages may focus their own ordinary or secret input; authorization codes never enter Agent drafts, snapshots, or logs. Completion says the account was reauthenticated, not added.

Regression coverage must include healthy checks, successful normal refresh, confirmed denial, indeterminate SDK/network/permission failures, cooldowns, explicit recovery, identity confirmation, cancellation, late results, concurrent rotation, persistence warnings, shared account selections, and capability compatibility. Tests use synthetic credentials and isolated daemon storage. They do not authenticate real accounts, make inference requests, or restart a production runtime. Fixture coverage and live-provider verification are reported separately.
