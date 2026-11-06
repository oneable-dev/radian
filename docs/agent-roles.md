# Agent roles and personal-profile migration

[Back to reference](reference.md#agent-profiles-and-collaboration)

Radian ships its own role definitions. A global `agents` directory is not required to use the
built-ins. Personal and trusted project files customize those roles through narrowing-only overlays;
custom agents remain supported separately. `main` identifies the root session, not a profile.

This guide covers the shipped registry, overlays and host tool policy, plus a read-only migration
inventory. It does not authorize configuration changes or promise automatic task scheduling.
See [Durable task collaboration](task-collaboration.md) for task bindings, planning, independent QA,
repair locks and retention. Saving a plan does not approve or start implementation.

## Built-in identities

Each canonical ID also accepts the alias `radian:<id>` (for example `radian:qa`). Aliases identify the
same role, not another profile or another permission set. Model IDs and thinking levels are not
built-in product defaults; they are resolved from configuration and the session's model selection.

| Canonical ID   | Descriptor workflow roles | Delegation eligibility | Responsibility                                   |
| -------------- | ------------------------- | ---------------------- | ------------------------------------------------ |
| `product-lead` | lead                      | enabled                | Product outcomes, scope and acceptance decisions |
| `tech-lead`    | lead                      | enabled                | Engineering plans, interfaces and risk analysis  |
| `ui-ux-lead`   | lead                      | enabled                | Interaction, accessibility and design delivery   |
| `pm`           | implementer, worker       | disabled               | Bounded product research and documentation       |
| `engineer`     | implementer, worker       | disabled               | Bounded engineering implementation               |
| `designer`     | implementer, worker       | disabled               | Bounded interface and interaction design         |
| `qa`           | verifier, worker          | disabled               | Independent current-revision verification        |

Eligibility is not launch authority: the host must also authorize delegation, assignment and purpose.
An overlay cannot change descriptor identity, workflow roles or output contracts.

Sources: [`builtin-agents.ts`](../src/agents/builtin-agents.ts) and the seven packaged
[prompt assets](../resources/agents/).

## Overlay resolution

Resolution order, from lowest to highest precedence:

```text
built-in descriptor and prose
  -> personal <agentDir>/agents/<id>.md (normally ~/.pi/agent/agents/<id>.md)
  -> trusted ancestor .pi/agents/<id>.md, farthest ancestor to nearest
  -> explicit host-supplied per-run choice
```

CHAT excludes all project overlays. Untrusted projects contribute no overlays. Missing optional
profile directories do not remove the built-ins. A per-run choice is a resolver input supplied by
the host, not a new user command or permission-bearing tool argument.

Files use YAML frontmatter plus an optional Markdown body. The accepted fields are `name`,
`description`, `model`, `thinking`, `skills`, `tools` and `delegation`.

| Field         | Built-in overlay behavior                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | Must preserve canonical identity; canonical and `radian:<id>` spellings are equivalent.                                                         |
| `description` | Replaces display text only; it grants no authority.                                                                                             |
| `model`       | Replaces the earlier preference with an exact `provider/model` identifier; an unavailable configured model blocks admission.                    |
| `thinking`    | Replaces the earlier effort preference: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. The selected model must support it.        |
| `skills`      | Ordered, deduplicated union of required names, not replacement. A missing or parent-only required skill blocks admission.                       |
| Markdown body | Adds a source- and path-labelled `agent_overlay` section after built-in prose; it never replaces the built-in role instructions.                |
| `tools`       | Narrows the current ceiling with concrete tool names only; wildcard entries in built-in overlays are rejected. `[]` removes ordinary tools.     |
| `delegation`  | Only `{ enabled: boolean }`; may turn eligibility off, never enable a disabled descriptor or re-enable it after an earlier overlay disabled it. |

These are not ordinary last-file-wins profiles: later overlays cannot restore tools or delegation
removed by an earlier overlay. Host-granted reporting, bound-task and authorized coordination tools
retain their own authority checks rather than being granted by the `tools` field. Other skill
resources remain discoverable on demand; a profile's required-skill list does not own or replace the
shared skill installation.

### Filename identity and blocking diagnostics

If either the filename stem or declared `name` identifies a built-in or its alias, both must resolve
to the same canonical built-in. An omitted `name` uses the filename stem. Thus `qa.md` with
`name: radian:qa` is valid; `qa.md` with `name: engineer` blocks both involved built-ins with
`AGENT_NAME_COLLISION`. Duplicate canonical identities in one discovery directory also collide.
A malformed alias file still belongs to its canonical role and cannot bypass blocking admission.
For files whose stem and name are both custom, the existing declared-name behavior is retained.

| Code                      | Meaning                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `AGENT_OVERLAY_WIDENS`    | Tools or delegation would widen the current ceiling.                                       |
| `AGENT_OVERLAY_FIELD`     | Malformed frontmatter, unsupported fields or invalid overlay values.                       |
| `AGENT_SKILL_MISSING`     | A required skill is unavailable to the child, including a parent-only skill.               |
| `AGENT_MODEL_UNAVAILABLE` | The configured model is unavailable in the registered model catalog.                       |
| `AGENT_NAME_COLLISION`    | Invalid built-in identity, duplicate identity or an attempt to define `main` as a profile. |

These configuration diagnostics block the affected role, not unrelated valid roles. Discovery may
still list a diagnosed role, but admission rejects it; the built-in fallback used for listing does
not make the role runnable. General I/O/discovery failures are separate and may prevent catalog
loading. An unsupported model effort or missing concrete registered tool may also fail admission;
the five codes above are not an exhaustive list of runtime failures.

Sources: [`effective-profile.ts`](../src/agents/effective-profile.ts),
[`agent-profiles.ts`](../src/agents/agent-profiles.ts) and model/skill/tool admission in
[`pi-session-adapter.ts`](../src/agents/pi-session-adapter.ts).

## Frozen run configuration and host ceilings

At launch, Radian freezes an `EffectiveProfile` snapshot: canonical ID, descriptor version, built-in
prompt hash, overlay paths/hashes and source kinds, resolved model/thinking, required skill
paths/hashes, tool ceiling, verification tools, delegation, purpose and output-contract versions.
The snapshot is retained in coordination records and the SDK session's `radian.effective-profile`
entry. Editing an overlay or skill does not change an existing child's compiled role instructions
or frozen capabilities, including on reload; new runs resolve new inputs. This records provenance,
not an OS-level isolation or cross-runtime migration guarantee.

- Built-in QA never receives the known Pi product-edit entry points `edit` and `write`.
- Lead-only built-ins deny those entry points unless bound as implementer; even that binding does
  not bypass overlay narrowing or durable authorization. PM, engineer and designer may edit only
  within their effective ceiling and current host authorization.
- Planning and analysis are read-only: tool access is restricted to `read`, `grep`, `find` and `ls`
  intersected with the profile ceiling, plus host-granted protocol tools. No tests/builds or
  implementation execution are authorized by those purposes.
- Visibility is not enforcement. The host checks direct and nested SDK tool calls; out-of-ceiling
  calls return `[AGENT_TOOL_CEILING]`. Denied native tools have hidden, denial-only dispatch
  implementations rather than executable capabilities.
- QA execution-purpose ceilings include `bash` and `mcp__*` verification access before overlay
  narrowing. These are **host-trusted, not sandboxed**. Shell commands, generic MCP servers and
  arbitrary trusted extension I/O can still mutate files. The host does not semantically classify
  shell commands, MCP operations or every tool alias. A denied `edit`/`write` call is not proof that
  all product-file mutation is impossible.

Run status and saved records report `toolPolicy`, `deniedProductEdit`, `reachableUnsandboxed`,
`verificationTrust` and `sandboxed` enforcement facts. Reachability is a policy allowance, not proof
that a shell/server is installed. For durable per-call authorization and the exact enforcement
limits, see [Role routing and repair ownership](task-collaboration.md#role-routing-and-repair-ownership)
and [Limitations](task-collaboration.md#limitations), rather than interpreting prose as a sandbox.

Sources: [`leaf-extension.ts`](../src/agents/leaf-extension.ts),
[`builtin-agents.ts`](../src/agents/builtin-agents.ts),
[`pi-session-adapter.ts`](../src/agents/pi-session-adapter.ts) and
[`subagent-record.ts`](../src/agents/subagent-record.ts).

## Legacy discovery switch and custom agents

Built-ins are on by default. For compatibility, this **Pi settings** value restores legacy
file-based discovery instead of built-in overlays:

```json
{
  "radian": { "builtInAgents": "off" }
}
```

Use Pi's `~/.pi/agent/settings.json` or trusted project `.pi/settings.json` settings path, not Radian's
unified `~/.config/radian/settings.json`. CHAT uses personal settings, not project settings.
`"on"` or an absent flag enables built-ins; other flag values are invalid. The switch does not
rewrite profiles or reconfigure existing frozen runs. Legacy discovery requires files for named
roles and retains its existing validation and custom allowlist behavior.

With built-ins enabled, files with non-built-in identities remain custom profiles: they need a
description and role-instruction body; omitted delegation means leaf behavior, and their tool
allowlists retain existing wildcard support. Personal profiles are read from the configured agent
directory, not directly from an arbitrary dotfiles checkout. Shared instructions, skills, settings
and custom agents are kept. Standalone Pi use of those shared resources is unaffected by this
Radian feature flag or this documentation; standalone profile consumers must be assessed separately.

## Observed personal configuration (example inventory as of 2026-11-05)

This is a bounded example inventory, **not product defaults, a recommended configuration, or a
claim that any file is unused**. Personal model identifiers are retained here solely to make the
observed replacement requirements explicit. They are not credentials and do not prove provider
availability, authentication or current runtime use.

### Evidence and scope

- **Directly read:** all seven `/Users/sanghyeon/.dotfiles/pi/agents/*.md` files listed below,
  the seven `resources/agents/*.md` assets, the source modules linked above, and
  [`resources/skills/graph-plan/SKILL.md`](../resources/skills/graph-plan/SKILL.md).
  Frontmatter and prose facts below come from those files, not inferred usage telemetry.
- **Owner-supplied evidence, not independently resolved here:**
  `~/.pi/agent/agents -> Nix store -> ~/.dotfiles/pi/agents`, with the managed declaration at
  `~/.dotfiles/home.nix:51-62`. The source files were read through their explicit dotfiles paths;
  the symlink chain, exact store target and Nix declaration were not revalidated in this inventory.
- **Known integration/reference, not proven active use:** Radian's `discoverAgentProfiles` reads
  `<agentDir>/agents/*.md`; with the supplied directory mapping these files are overlay inputs
  (or legacy definitions when the flag is off). The packaged graph-plan guidance names the lead
  profiles as selectable examples. Personal lead prose names its worker role as noted below.
- **Unknown:** standalone Pi extensions/CLIs, other hosts, shell scripts, command bindings, project
  references, deployment generations and active runs that may consume these definitions. No
  exhaustive cross-repository or runtime consumer inventory was performed. Absence of an observed
  reference is not evidence of non-use.

In the table, `I` = `read`, `grep`, `find`, `ls`; `W` = `web_enable`, `web_search`, `fetch_content`,
`get_search_content`, `source_check`; `E` = `edit`, `write`; `D` = `mcp__figma_remote`, `mcp__spline`.
These abbreviations describe the observed personal allowlists, not built-in ceilings. All source
paths below are relative to the directly read `/Users/sanghyeon/.dotfiles/pi/agents/` directory.

| Source            | Role / delegation / tools / skills category                                                                                                                        | Preserved preferences (observed model / thinking) | Radian-specific workflow prose now duplicated by built-ins                                                    | Known consumers / references                                                                         | Unknown / unresolved consumers                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `product-lead.md` | Product decisions; delegation `true`; I + W; required `work-with-evidence`                                                                                         | `openai-codex/gpt-6-astra` / `xhigh`              | Host-first routing, hierarchical publication, read-only planning, independent QA, repair lock                 | Radian personal discovery; graph-plan lead example                                                   | Other hosts, standalone Pi loaders, bindings/scripts and active runs unknown |
| `tech-lead.md`    | Technical decisions/review; delegation `true`; I + W; required `write-good-code`, `work-with-evidence`                                                             | `claude-code/claude-opus-5-5` / `xhigh`           | Lead publication, task-bound QA, admitted repair and locked-defect analysis                                   | Radian personal discovery; graph-plan lead example                                                   | Other hosts, standalone Pi loaders, bindings/scripts and active runs unknown |
| `ui-ux-lead.md`   | UX/design decisions; delegation `true`; I + W + D; required `work-with-evidence`                                                                                   | `claude-code/claude-opus-5-5` / `xhigh`           | Lead publication, host/owner coordination, read-only planning and QA/repair boundaries                        | Radian personal discovery; graph-plan lead example                                                   | Other hosts, standalone Pi loaders, bindings/scripts and active runs unknown |
| `pm.md`           | Product artifacts; delegation omitted (leaf); I + E + W; required `work-with-evidence`                                                                             | `openai-codex/gpt-6.1-sol` / `high`               | Bound implementer submission, no delegation, fresh QA, admitted repairs and human-only lock handling          | Radian personal discovery; personal `product-lead.md` explicitly delegates product work to `pm`      | Other hosts, standalone Pi loaders, bindings/scripts and active runs unknown |
| `engineer.md`     | Engineering implementation; delegation omitted (leaf); tools omitted (SDK defaults, not a read-only restriction); required `write-good-code`, `work-with-evidence` | `openai-codex/gpt-6.1-sol` / `high`               | Bound submission, no delegation, fresh QA, admitted repairs and permanent repair lock                         | Radian personal discovery; personal `tech-lead.md` explicitly delegates implementation to `engineer` | Other hosts, standalone Pi loaders, bindings/scripts and active runs unknown |
| `designer.md`     | Design artifacts; delegation omitted (leaf); I + E + W + D; required `work-with-evidence`                                                                          | `claude-code/claude-sonnet-5-5` / `high`          | Bound submission, no delegation, fresh QA, admitted repairs and owner-only escalation                         | Radian personal discovery; personal `ui-ux-lead.md` explicitly delegates design work to `designer`   | Other hosts, standalone Pi loaders, bindings/scripts and active runs unknown |
| `qa.md`           | Independent verification; delegation omitted (leaf); I + `bash`, `mcp__browser_use`; required `work-with-evidence`, `verify-changes`                               | `openai-codex/gpt-6-astra` / `high`               | Exact-task findings/verdicts, no product edits, current-revision QA, initial count zero and three-strike lock | Radian personal discovery; QA is referenced in personal lead/worker workflow prose                   | Other hosts, standalone Pi loaders, bindings/scripts and active runs unknown |

Duplicated workflow prose is only a migration candidate, not a reason to discard personal content.
The personal files also carry preferences and operating guidance not replaced automatically: Korean
reporting, on-demand skill selection, web-source handling, domain review detail and Figma/browser
proxy/shared-GUI instructions. Required skills and personal tool narrowing must be preserved or
explicitly reviewed; the built-in descriptors do not install those personal skill requirements.
For example, the observed lead/PM allowlists omit shell access; built-in availability alone must
not be interpreted as preserving that restriction if their overlays are changed.

## Removal gate for a separate, user-authorized dotfiles task

**Current disposition: keep all seven files.** This documentation changes no dotfiles, symlinks,
Nix declarations or user configuration, and instructs no file deletion. A future cleanup decision
requires a separate user-authorized task and all of the following evidence:

- [ ] Explicit user authorization identifies the dotfiles task, scope, owner and intended changes.
- [ ] A complete consumer/reference inventory covers Radian versions, standalone Pi and other
      loaders/extensions, scripts, project overlays, command bindings (including legacy
      `commandAgents.plan` where applicable), instructions, and relevant persisted/runtime records.
      Unknown consumers are resolved or explicitly accepted by the user; files are never assumed unused.
- [ ] The replacement is validated in an isolated configuration for every affected role: discovery,
      canonical/alias identity, model/effort availability, required skills, additive instructions,
      tool narrowing, delegation and affected workflows. Both built-in-on and required legacy-off
      consumers have a supported path. Built-in prose alone is not proof of equivalent preferences.
- [ ] Active runs, frozen profiles, daemon versions, resume/reload behavior and standalone parser
      compatibility are assessed. Older strict parsers may reject delegation metadata. Any required
      transition/restart is explicit; existing work is not silently interrupted or replayed.
- [ ] The exact authoritative source paths, current symlink chain, Nix-managed declaration and
      generation are re-confirmed. Generated Nix-store targets and discovery symlinks are not treated
      as editable source files. Owner-supplied paths above are leads for verification, not authorization.
- [ ] A recoverable backup exists **outside every discoverable `agents/*.md` directory**, so it cannot
      be loaded as a duplicate profile. It preserves original contents, source paths and managed-link
      information, and restoration is tested or otherwise demonstrably recoverable.
- [ ] A rollback plan identifies the saved source revision/backup, managed-link restoration, any
      required user-authorized Nix activation/runtime restart, legacy flag/settings restoration and
      post-restore checks. The feature flag alone cannot restore a missing personal file.
- [ ] Shared common instructions, shared skills, settings, custom agents, credentials and histories
      remain intact. Standalone Pi's shared-resource usage remains supported; only individually
      justified Radian-specific duplication is considered for a later change.

Until these gates are satisfied, the inventory is incomplete for cleanup purposes. The next handoff
is consumer verification and replacement validation in that separate task, not automatic removal.
