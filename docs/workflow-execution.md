# Explicit workflow execution

The workflow scheduler is opt-in and defaults to off. Enable it in Pi extension settings only when
ready to use the feature: `{"radian":{"workflowScheduler":"on"}}`. This implementation does not
change personal settings, enable scheduling on existing repositories or migrate live workflows.
Old daemons need an explicit user restart; reconnecting a client does not replace a daemon.

`/plan` remains read-only. A published plan, `ready for review`, an agent message, a successful
model run or a notification is never execution approval. Implementation assignments must first be
declared in the durable workflow. The scheduler does not translate arbitrary plan prose into writes.

## Commands

| Command                                          | Effect                                                                                                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/workflow` or `/workflow status [id]`           | Show durable owners, task revisions, schedules, invocation and operation IDs, queue/block reasons and available controls. Status is readable with scheduling off.                    |
| `/workflow start <all\|taskIds> [--auto-repair]` | Persist and display an execution preview. No model run is started. Task IDs may be comma- or space-separated.                                                                        |
| `/workflow confirm <receiptId>`                  | Explicitly approve exactly the displayed dependency-closed scope and start admission.                                                                                                |
| `/workflow pause [invocationId]`                 | Fence future admissions. Execution runs already in flight may settle; planning pause stops its read-only runs.                                                                       |
| `/workflow resume [invocationId]`                | Revalidate approval and inputs before resuming a paused invocation. Interrupted reservations get new operation IDs, not an automatic replay of a previous run.                       |
| `/workflow cancel [invocationId]`                | Prevent new admissions and stop only owned runs. Changes, submissions, artifacts and defects remain. Uncertain cleanup retains ownership until cancellation is retried successfully. |

Without an ID, controls target this conversation's current owner. After reopen, use the exact ID
shown by status. Completed and cancelled invocations cannot be resumed. Historical controls cannot
release another invocation's owner. Controls of an already-owned execution remain available if the
setting is switched off; turning a setting off is not confirmation of cleanup.

The commands are reserved in composer submission/completion, the runtime client and repository/CHAT host boundaries. They do not
expand SDK templates or extension commands and never become billed model prompts. Old services
without `workflow-scheduling` reject the command with an upgrade message. Attachments, malformed
commands and stale conversation IDs are rejected before admission. Only the direct user-input host
constructs user-command provenance. This is an in-process trust boundary, not authentication against
arbitrary code running inside a trusted extension or under the user's OS account.

## Approval contract

A preview names the worktree, current plan artifact revisions, ordered task scope, assigned
lead/implementer/verifier profiles and automatic-repair choice. It displays each profile's resolved
model and effort, descriptor/instruction identity, tool ceiling, verification tools, delegation,
skills and overlay sources. If an inherited model/effort has not been resolved in the host snapshot,
it says so rather than inventing a value. Every included implementation task needs distinct
implementer and verifier profiles. `all` is conservative: missing assignments, cycles, cancelled
prerequisites, invalid/stale plan publications or unresolved plan questions reject the preview rather
than silently dropping work. Pure grouping tasks without implementations must be assigned explicitly
or excluded by selecting leaf task IDs.

New receipts embed the displayed task scopes/assignments, full effective profile snapshots and
host-created user-command provenance, in addition to fingerprinting task scopes, dependency edges,
assignment generations, current plan refs, worktree and profiles. The stored display facts must match
the fingerprint inputs. Older v2 receipts remain readable with fingerprint validation; no historical
profile evidence is fabricated or written into them. A changed plan, scope, assignment or profile blocks an
unstarted admission and revokes continuing authority. Request a new preview and confirmation; the
scheduler does not substitute the newest plan or model silently. Implementation output revisions do
not revoke their own receipt: they are gated by exact-revision QA instead.

Receipts and their confirmation times are immutable safety records. Revocation cannot be undone,
and records cannot be deleted to recover authority. The first explicitly requested scheduling write
uses the version-2 workflow migration and private version-1 backup; ordinary status does not migrate.
See [Durable task collaboration](task-collaboration.md) for retention and backup ownership rules.

## Execution and verification

1. Commit a frozen operation admission before reserving an actual run.
2. Admit one implementer in the worktree. The assigned scope is passed as instructions; scope text
   and plan file lists are not OS-level path permissions.
3. Require accepted `radian-task submit`, which closes that run's write authority.
4. After confirmed run settlement, admit the assigned independent verifier for that exact revision.
5. Release dependent implementation only after current-revision QA and all unresolved responsibilities
   for that task are satisfied. Run completion without submission or verdict is blocked, not success.

Implementation and verification are serialized in a shared worktree, including across conversations
known to the same host. Confirmation waits for existing model work to settle; ordinary host model
prompts are rejected while execution owns the worktree. Use workflow controls or cancel before
starting unrelated model work. A verifier may run tests through bash/MCP, so it must not overlap a writer.
This version does not create isolated worktrees or enable parallel implementation automatically.
Existing five-active, depth-three and 128-retained-run limits still apply. Pending initialization and
uncertain cleanup hold capacity. Profile/input changes fence writes again at each host-mediated call.

Automatic repair is **off unless the user previews and confirms `--auto-repair`**. With that consent,
repairs use the existing host admission and exact defect/attempt bindings. Initial discovery/QA is
zero failures; only a failed automated post-fix recheck increments the counter. Duplicate, stale,
blocked and interrupted outcomes do not. Three failures permanently lock the defect, admit only
responsible-lead read-only analysis and require the user's direct `/repair` path. The scheduler never
issues `/repair`, resets a counter, cancels a defect to pass QA or interprets a notification as manual
repair authorization. Multiple simultaneous submitted defect attempts require owner coordination
rather than guessing which QA to schedule. A blocked QA does not release dependencies.

Restart recovery pauses execution, records live admissions as interrupted and does not launch model
work. Resume is a separate explicit action. Single-host operation receipts coordinate admission;
independent processes are not protected by a distributed lease. A timeout cannot prove rollback.

## Visibility and verification limits

Agent/session snapshots carry a compact active/paused workflow summary. The list-only session
monitor includes it even when no model is currently streaming. `/workflow status` provides bounded
per-task and operation details through existing transcript notices; no popup, button row or monitor
preview is added.

Regression tests use pure reducers, temporary workflow stores, real SessionRegistry coordination
with fake executors, injected provider encoders, loopback repository/CHAT clients and a real
Workbench renderer/keymap keyboard flow. The TUI test covers preview, confirm, pause, resume and
cancel without model generation, and protects reserved commands from same-name template completion. They do not
send paid model probes or activate scheduling against a user's real worktree. Parent self-validation
is not an independent QA verdict. Preserve pending durable QA/defect records when implementation is
performed without fresh verifier agents.

The subscription-only request guard and its limits are documented in
[Provider adapters](provider-adapters.md#subscription-only-request-routing). The phase-by-phase
[release checklist](workflow-release-checklist.md) separates self-check coverage from pending
independent acceptance. Neither quota displays
nor approved CLI transport names guarantee entitlement or zero additional charges. Bash, MCP and
trusted extensions are not an OS sandbox.
