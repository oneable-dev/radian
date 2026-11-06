# Agent workflow release checklist

This checklist maps `radian-agent-workflow-engineering-plan@1` to implementation and executable
self-check evidence. It is not execution consent or an independent QA verdict. The implementation
was completed by the parent without new verifier agents; previously pending QA/defect records are
preserved. Passing the test suite must not mark Q01–Q07 or older pending defects accepted.

## Phase coverage

| Plan scope                                                        | Implementation                                                                                                              | Self-check evidence                                                                                                  | Independent acceptance                                                                          |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| T01: declarations, action validation and correction budget        | `tool-protocol.ts`, `task-tool.ts`, `task-planning.ts`, `subagent-tools.ts`                                                 | `tool-protocol.test.ts`, `provider-adapter.integration.test.ts`, `task-planning.test.ts`                             | Earlier per-task verdicts are historical; no final-source aggregate verdict.                    |
| T02: session tools and host-derived planning purpose              | `session-registry.ts`, `task-routing.ts`, `pi-session-adapter.ts`                                                           | `session-replacement.test.ts`, `task-routing.test.ts`, `delegated-planning.test.ts`                                  | Final shared-file regression acceptance pending.                                                |
| T03–T05: built-ins, preferences and tool boundaries               | `builtin-agents.ts`, `effective-profile.ts`, `agent-profiles.ts`, `leaf-extension.ts`, `resources/agents/`                  | `builtin-agents.test.ts`, `effective-profile*.test.ts`, `agent-profiles.test.ts`, `leaf-extension.test.ts`           | Final shared-file regression acceptance pending.                                                |
| T06: legacy inventory                                             | `docs/agent-roles.md`                                                                                                       | Read-only inventory and unknown-consumer/removal gates in that document                                              | No permission to remove dotfiles; unknown consumers remain unknown.                             |
| T07: lossless v2 state and migration                              | `task-workflow.ts`, `task-workflow-store.ts`, `workflow-schedule-state.ts`                                                  | `task-workflow-store.test.ts`, `workflow-schedule-state.test.ts`, `task-plan-retention.test.ts`                      | No live workflow migration performed for verification.                                          |
| T08–T09: planning scheduling and controls                         | `workflow-scheduler.ts`, `workflow-scheduler-driver.ts`, `workflow-command.ts`, repository/CHAT/client command routing      | `workflow-scheduler*.test.ts`, `workflow-command.test.ts`, `workflow-runtime.test.ts`, `workflow-visibility.test.ts` | Existing pending planning defects still require their exact admitted revision/attempt verdicts. |
| T10: separate execution consent                                   | `workflow-consent.ts`, `workflow-consent-schema.ts`, host user-command boundary                                             | `workflow-consent.test.ts`, `workflow-execution-host.test.ts`, `workflow-runtime.test.ts`                            | No new independent Q06 verdict.                                                                 |
| T11: serial implementation, exact-revision QA and permanent locks | `workflow-execution-scheduler.ts`, `session-registry.ts`, existing verification policy                                      | `workflow-execution-scheduler.test.ts`, `workflow-execution-host.test.ts`, `verification-policy.test.ts`             | No new independent Q06 verdict.                                                                 |
| T12: documented behavior and limitations                          | `docs/reference.md`, `docs/task-collaboration.md`, `docs/agent-roles.md`, `docs/workflow-execution.md`, graph-plan guidance | Local-link checks, source/test trace above, static checks and compiled build                                         | Q07 documentation acceptance pending.                                                           |

Source/test names in this table are under `src/agents/` unless their directory is explicit;
`workflow-runtime.test.ts` is under `src/runtime/` and `task-plan-retention.test.ts` is under
`src/runtime/`. Glob-style entries name multiple existing test files, not shell commands.

### Regression matrix

| Axis               | Cases and evidence                                                                                                                                                                                                                                                        | Limits                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider/transport | Injected declaration encoders and strict/nonstrict projections; canonical Claude Code/Codex routing, paid API/endpoint/environment refusal; `subscription-policy.test.ts`, `subscription-runtime.test.ts`, `subscription-routing.test.ts`, `subscription-session.test.ts` | No live subscription generation, entitlement check or zero-charge guarantee. Provider tests are under `src/providers/`, routing under `src/agents/`, session under `src/accounts/`. |
| Runtime            | Repository/CHAT typed and legacy direct-user commands, stale identity, unsupported old service, no prompt fallback; `src/runtime/workflow-runtime.test.ts`, `src/runtime/client.test.ts`                                                                                  | Loopback transport and offline model executors, not the user's active daemon.                                                                                                       |
| Config             | Missing agent directory, personal/trusted-project overlay, CHAT exclusion, flag off, immutable active profile, unavailable skill/model; effective-profile and agent-profile tests                                                                                         | Shared Pi files remain unchanged; external consumers are not exhaustively inventoried.                                                                                              |
| Planning           | Dependencies, capacity, questions, exact frozen inputs, cancellation ownership, settings off, orphan/reopen/reassign, three invalidations; scheduler reducer/driver/host tests                                                                                            | Single owning-host coordination, not a distributed lease.                                                                                                                           |
| Approval           | Stored model/effort/tool/skill snapshots, scope and provenance match the preview; changed inputs and tampered snapshots fail closed; old receipts stay readable                                                                                                           | Old v2 receipts have a fingerprint but no embedded display facts; they are not rewritten or upgraded into invented evidence.                                                        |
| Execution/QA       | Submit closes writes; exact-revision verdicts, dependency gating, serial worktree access, explicit repairs, initial fail plus three failed fixes, read-only analysis and no fourth fix                                                                                    | Scripted fake executors do not evaluate a real model's semantic correctness. Bash/MCP are unsandboxed.                                                                              |
| TUI                | Real Workbench renderer/keymap with keyboard preview → confirm → pause → resume → cancel; same-name template cannot replace `/workflow`; invalid input retains the draft                                                                                                  | Headless renderer plus offline host executors, not a manual OS-terminal/live-provider end-to-end session.                                                                           |
| Packaging          | Isolated `bun src/build.ts --outfile <temporary>/radian`, then `<temporary>/radian --help`; packaged prompt assets covered by built-in tests                                                                                                                              | Does not replace/restart the running service or activate scheduling.                                                                                                                |

## Gates

For any release candidate, freeze source and run:

```sh
bun run typecheck
bun run lint
bun run format:check
git diff --check
bun test
```

Build in a uniquely owned temporary distribution, smoke its CLI, then remove only that temporary
distribution. Do not run a production build over the user's currently running binary as a test.
A timeout, blocked check or failed full suite is a gate failure, not permission to retry until green,
increase timeouts, skip a test or claim cancellation. Keep the failing evidence and diagnose first.
Parent-only checks remain self-checks even when all gates pass.

Before claiming independent acceptance:

- [ ] Verify the frozen final source through a genuinely independent reviewer on the same task/revision.
- [ ] Reconcile pending planning defects using their existing admitted attempts; do not overwrite records.
- [ ] Recheck the subscription-routing release gate on the final source, rather than reusing an old pass.
- [ ] Record final documentation and cross-module regression verdicts without resetting failure counts.
- [ ] If authorized, run a live-model/manual-terminal smoke. Otherwise label it unverified.

## Deliberate non-goals and operator actions

Existing independent sessions in separate Git worktrees remain available. A single scheduler
invocation operates in its selected worktree and serializes implementation/QA there. Automatic
cross-worktree task placement, worktree creation, stacked-PR branch mapping/restack/merge management
and distributed writers are not implemented by this release. They are not prerequisites for its
single-worktree sequential workflow.

The scheduler stays off by default. Starting/restarting a real service, opting into scheduling,
requesting execution consent or migrating an actual user's workflow are operator actions, not
self-test side effects. Dotfiles deletion/relinking, changes to personal models/accounts, dependency
installation, commits, pushes and PR publication require their own authorization.
