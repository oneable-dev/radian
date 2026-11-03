# Durable task collaboration

## Ownership and trust boundaries

A workflow is host-owned state, not a model-authored transcript convention. There is one canonical version-1 JSON document per origin conversation, at `<originSessionFile>.workflow.json`. Models cannot grant assignments, manufacture user-command provenance, clear repair locks, or interpret a notification as permission to launch a repair.

The host freezes a `WorkflowBinding` at spawn: `{workflowId, taskId, role, assignmentVersion, purpose?}`. Roles are `lead`, `implementer`, `verifier`, and `worker`; purposes are `planning` and `analysis`. The host must associate the binding with the actual selected profile and run, rather than accepting binding fields supplied by tool arguments. Policy checks the workflow, task, assignment generation, operation role, and, for attempt operations, `submittedTaskId`. Reassignment increments the task's assignment generation, revoking all earlier bindings. An analysis-purpose binding can only submit analysis.

Spawn authority (D02) is explicit: `TaskSpawner` distinguishes root, bound and unbound callers.
Root may request workflow roles; a bound caller must be a current, authorized lead spawning within
its own task or declared descendants. This restriction applies to every requested role, including
worker and verifier. Bound non-leads and unbound runs cannot acquire workflow roles. `launchChild`
rechecks the spawner, frozen binding and repair authorization after asynchronous admission, before
reserving capacity.

Models request scope/assignment changes through `radian-task declare/assign/reassign/split/continue`;
the host validates root/current lead authority and freezes actual bindings before invoking policy.
Models never supply host event IDs, author provenance, workflow bindings or human receipts directly.
Recovery and membership management remain host-only. Human APIs require branded `UserCommandProvenance` created by `userCommandProvenance(conversationId, receivedAt)` in `repair-command.ts`, only at the direct user-input boundary. The brand prevents accidental TypeScript construction; it is not an authentication primitive against arbitrary code running inside the host.

## Hierarchical planning and migration

Default `/plan [requirements]` is lead-owned planning, not a single planner returning a proposal for
parent acceptance. The parent discovers available profiles and declares a goal plus relevant branches
through `radian-task declare`: `[{id,title,lead:{profile},scope,dependsOn}]`. Product, engineering,
design and QA are examples, not mandatory branches. Unknown profiles, duplicate IDs, missing
dependencies and cycles remain durable manifest diagnostics.

The parent spawns each branch using `radian-subagent spawn` with the assigned profile and
`binding:{id:branchId,role:"lead"}`. During `/plan`, only declared branch lead spawns are accepted;
unbound spawns and edit/write are blocked. Spawn/status/wait/reply/stop use host planning-purpose
coordination, isolated from ordinary implementation runs. Profile-enabled delegation permits read-only
investigation transitively; descendants inherit planning purpose rather than gaining write tools.

Read-only purpose never widens a profile allowlist (S01). Native tools are
`{read, grep, find, ls}` intersected with the profile's exact-name or `*` wildcard allowlist, both at
SDK loadout and for direct/nested calls. An omitted allowlist imposes no additional profile filter;
an empty allowlist grants no native investigation tools. Host protocol tools are exempt from that
intersection: `radian-supervisor`, `radian-task` for bound runs, and `radian-subagent` only when the
host grants delegation. Each still enforces its own protocol authority; legacy delegation tools
remain blocked.

Leads publish complete `{plan,review}` with `radian-task publish-plan`. The host validates and appends
artifact revisions with actual run/profile/role provenance. The parent sees bounded summaries and
`ref@revision`, never the full body by default, and must not accept/save/rewrite branch proposals.
A bound lead or verifier's own `radian-task status` shows host-frozen prerequisite refs and bounded
summaries captured at spawn, never bodies. `radian-task status {artifact:"ref@revision"}` retrieves
exactly those frozen revisions on demand; other bodies require root/owning-lead authority. The binding,
current dependency edge and declaration must remain valid. Omitted/latest revisions are not authorized
for dependent reads. Missing inputs mean ask the owner, not claim review; respawn to refresh inputs.
The parent need not relay upstream bodies.

`radian-plan report`, also emitted at settling, derives readiness from durable state: branches and
leads, artifact references/revisions plus summaries or `missing`, manifest diagnostics, cross-branch
dependencies without current artifacts, and unresolved planner questions. Each hierarchical `/plan`
records its invocation start. A missing manifest or `manifest.declaredAt` older than that start makes
the report `incomplete`: `Scope was not declared for the current /plan request`. Legacy manifests
without `declaredAt` also require a fresh declaration. The old goal remains visible as `Previous scope`;
artifacts and history are not deleted. `declareScope` records `declaredAt`; `declareSubtasks` may update
`updatedAt` and accumulate diagnostics but never refreshes the scope declaration.

A branch publication older than `manifest.declaredAt` is stale and counts as missing, while its
`ref@revision` remains listed. Latest artifact bodies must validate as `{plan, review}`. Every
`plan.openQuestions` entry is a visible blocking `Open question (<branch>): ...` and counts toward
questions. `review.warnings` appear as non-blocking `Warning (<branch>): ...` lines. Files shared by
plan tasks in different branches appear as non-blocking `Diagnostic: shared file <path> in <branches>`
lines. Accumulated manifest diagnostics remain visible and blocking. Every branch must publish current
artifacts and all blockers must be absent to be `ready for review`; otherwise the report is
`incomplete`. `Approval: not implied` always remains explicit. Execution has not started.

Context injection uses the same freshness/readiness rules, with a legacy `.plan.json` pointer if
present. Reports/context are bounded to 12,000 characters; blocking reasons precede reference rows,
warnings and shared-file diagnostics. Truncation is explicitly marked; retrieve individual details on
demand rather than treating truncation as omitted authorization.
`radian-plan cancel` stops planning runs but retains declarations, diagnostics and accepted artifacts.

Explicit `/plan --single [requirements]` preserves legacy behavior: `commandAgents.plan` chooses one
read-only drafting profile and the parent uses delegate/wait/reply/accept to validate/save `.plan.json`;
without a binding the parent uses submit. `radian-plan read` continues reading that legacy file.
Plain `/plan` ignores the binding and includes this notice in request and report:
`commandAgents.plan (<profile>) is a legacy single-planner binding and is not used by hierarchical /plan; run /plan --single to use it.`
There is no automatic sidecar migration, root super-planner, execution or approval.

## Role routing and repair ownership

- A lead owns its branch/task, assigns bounded subtasks and receives QA findings, failed rechecks and
  lock analysis requests. Parent leads can inspect descendant status without becoming their verifier.
- An implementer submits a revision for its exact host-bound task. The host durably admits an
  automated repair before launching it; notifications and ordinary follow-up text cannot authorize it.
- A QA verifier records findings and current-revision pass/fail/blocked verdicts for the exact bound
  task. Initial implementation and every submitted fix require QA; neither root nor lead can substitute
  its own verdict. Findings route to implementer and responsible leads, not new coordination rights;
  root retains status inspection without being woken for routine local QA.
- Three failed automated rechecks permanently lock the defect. Discovery/initial QA does not consume
  an attempt; stale, duplicate, blocked or interrupted results do not increment the count. Reassignment,
  split, task continuation, conversation continuation and recovery cannot reset the counter/lock.
- Every responsible lead publishes read-only analysis after lock. Once all analyses exist, the host
  requests human action. Models cannot unlock or manufacture manual-command provenance. Use direct
  user `/repair status [id]`, `/repair recheck <id>`, `/repair cancel <id>` or
  `/repair continue <workflowId>`; `/repair` alone shows status. Recheck creates a manual revision and
  mandatory QA, not another automated attempt. Cancellation is not verification or rollback.

Locked-task spawning (D01) rejects lead/worker bindings without read-only purpose with
`WORKFLOW_REPAIR_LOCKED`. Planning/analysis-purpose leads and workers remain available for read-only
investigation; those purposes cannot be attached to implementer/verifier roles.

Attempt claims (D03) allow only one live run per authorized automated attempt; a duplicate or
concurrent launch returns `WORKFLOW_CONFLICT`. Admission is committed before capacity reservation.
Pre-launch failure or confirmed executor/subtree cleanup releases the live claim, but retains the
durable, uncounted admission for reuse. Failed cleanup retains the claim until closure is confirmed.
Claims are in-memory, single-owning-host coordination, not cross-process leases. Restart loses live
claims; workflow recovery interrupts authorized attempts without counting a failure or replaying
work, and a fresh admission is required. Submitted attempts remain awaiting QA.

Per-call write authorization (D04) covers bound runs and unbound descendants, which inherit the
nearest bound ancestor's authorization without acquiring its workflow role. Before every tool call
outside `hostReadOnlyTools` (`read`, `grep`, `find`, `ls` and the three host protocol tools), the SDK
hook reopens current durable state. This includes direct and nested bash, MCP and custom-tool aliases,
not just native edit/write. It rechecks run liveness, binding/profile/assignment, read-only purpose and
the ancestor's `writeClosed` gate. Accepted submission closes writes before notification delivery;
a routing failure does not reopen them. Non-verifiers additionally pass the current lock guard.
Repair implementers need the exact automated attempt still authorized for their task and claimed by
that run; initial implementers require no unresolved defect and cannot continue after their own
submission awaiting QA. Verifiers may run tools for QA after binding/purpose/closed checks: their
product-code editing prohibition is a role instruction, not a tool sandbox. Missing, corrupt or
otherwise unavailable workflow state fails closed. Host protocol calls use their own authorization.

Root wake policy (D08) delivers only `notify-root` (human-required), cross-team effects spanning
different top-level branches, and orphan escalations with no live responsible recipient to root.
Routine findings, fixes and QA chatter go to responsible leads/implementers/verifiers. Delivery and
redelivery do not grant execution authority. Root messages use compact `renderRootSummary` text
when defects are present, bounded to 2,000 characters, with `/repair status <defectId>` for details;
root can still inspect status on demand.

### Limitations

Workflow storage coordinates a single owning host, not independent writer processes. Tool authorization is a
host tool boundary, not an OS sandbox: trusted extensions and root shell permissions remain outside
that boundary. Readiness validates publications/diagnostics, not semantic correctness or user consent.
The conservative unbound repair guard matches literal task/defect IDs in text; it cannot recognize
aliases, paraphrases or all semantically related work. Always use explicit durable bindings rather than
relying on text matching. Existing run depth/capacity limits still apply; planning does not queue work
automatically or schedule implementation. Session restart retains records but does not replay tasks.

## Document and public types

`src/agents/task-workflow.ts` exports the schemas and inferred types:

- `WorkflowDocument`: `version: 1`, UUID `workflowId`, monotonic integer `revision`, `origin`, `members`, nullable `manifest`, `tasks`, `defects`, `artifacts`, `processed`, and `log`. The manifest has `goal`, `updatedAt`, accumulated `diagnostics`, and optional integer `declaredAt` for backward-compatible scope freshness.
- `WorkflowOwner`: `{conversationId, cwd}`. `WorkflowOrigin` additionally has `sessionFile`.
- Members contain the origin identity plus `addedAt` and `via: "origin" | "user-continuation"`.
- `WorkflowTask`: identity/title/kind/scope/dependencies, optional `parentTaskId`, `splitFrom` and `continues`, lead and optional implementer/verifier profiles, `assignmentVersion`, `artifactRevision`, verification state and revision, task status, and optional plan artifact reference.
- `WorkflowDefect`: identity, responsible task IDs, discovery event/revision, summary/evidence, `automatedFailures` (0–3), permanent `locked` flag, lifecycle state, attempts, per-task analyses, and optional authorization receipt. Optional `resolutions?: Record<taskId, {revision: number, eventKey: string, at: number}>` preserves per-responsibility QA receipts; keys must be responsible tasks. An absent map grants no current resolutions.
- `WorkflowAttempt`: identity, automated/manual origin, fixed `submittedTaskId`, authorization document revision, optional submitted artifact revision and worktree fingerprint, lifecycle status, verdict evidence, and optional terminal pass/fail.
- Artifacts contain append-only revisions with run/profile/role provenance, publication time, bounded summary and full plan/review body. Status never renders full plan bodies.
- `WorkflowMutation`: `{doc, effects, outcome}`. Outcomes include applied, duplicate, terminal and stale; stale carries `code: "WORKFLOW_STALE"`.

`createWorkflowDocument(origin, workflowId, at)` creates revision zero. `validateWorkflowDocument(unknown)` validates the supported schema and safety references. `hasCurrentResolution(doc, defect, taskId)` checks a task's receipt against its current artifact revision. `renderWorkflowStatus(doc, id?)` renders compact plain-text owners, revisions, failure counts, per-task resolutions, blockers, references, analysis and human decisions. Analysis-pending/human-required entries include attempt/remedy counts and `handoff: /repair status <defectId>`.

`renderHumanHandoff(doc, defectId): Result<string, WorkflowError>` returns `WORKFLOW_NOT_FOUND` for an
unknown defect. Otherwise it renders the complete durable human package: defect identity, responsible
tasks and per-task resolutions, lock, automated failures/3, state, discovery revision and evidence;
every attempt's ID/origin/task/status/submitted revision/terminal outcome and every verdict's event
key/verdict/revision/evidence; every lead analysis's full reproduction, attempts, verified/hypothetical
causes, remedies and human decisions; exact `/repair recheck <taskId>` commands and
`/repair cancel <defectId>`. Retrieval (D06) uses `/repair status <defectId>` for this full package;
`/repair status <taskId>` stays compact and includes handoff lines for analysis-pending/human-required
defects. Models can request `radian-task status {id: defectId, detail:"handoff"}` only as root or a
current responsible lead (including its ancestor lead); implementers, verifiers and unrelated leads
cannot retrieve it through that tool. It sanitizes control characters without the compact display's 512-character
field truncation. The 60,000-character transport bound has an explicit truncation marker naming
`<originSessionFile>.workflow.json` for complete evidence.

`renderRootSummary(doc, defectId): string` limits parent escalations to 2,000 characters: defect ID,
responsible tasks, failures/3, lock, state, analyses received/required, decision count and
`/repair status <defectId>`. It never substitutes that summary for the durable human package.

`processed[eventKey] = {docRevision, outcome}` is a permanent safety receipt, never an evictable cache. At `MAX_PROCESSED_EVENTS` (100,000) new events are refused with `WORKFLOW_CONFLICT`; byte limits also refuse writes rather than dropping facts. Duplicate events remain readable at the cap. The informational log retains at most 256 entries and is never consulted for authorization or counting.

## Pure policy API

All mutations in `src/agents/verification-policy.ts` have the signature:

```ts
(doc: WorkflowDocument, command: Command) => Result<WorkflowMutation, WorkflowError>;
```

Every command supplies host-generated `{eventKey, at}`. Bound commands additionally supply `binding`. The functions do not read clocks, generate IDs, perform I/O, launch runs or deliver notifications. Accepted new events advance the document revision once; duplicate event keys return their original outcome without changing the document. Rejected operations leave the input untouched.

| Function                             | Additional command fields                                                 | Contract                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `declareScope`                       | goal, branches, knownProfiles                                             | Host declares plan branches and sets manifest.declaredAt to event.at. Missing dependencies, cycles, duplicate IDs, unknown profiles and older diagnostics are retained.                                                                                                                                                             |
| `declareSubtasks`                    | optional binding, parentTaskId, subtasks, knownProfiles                   | Root host or exact current parent lead declares children. Each child fixes parentTaskId, inherits omitted lead, and starts without inherited defects. Diagnostics accumulate without changing manifest.declaredAt; if no manifest exists, its initial goal is the parent title, not a fresh scope declaration.                      |
| `isTaskLead`                         | Separate helper `(doc, binding, taskId) => boolean`                       | Checks a current lead binding on the target itself or a parentTaskId ancestor, with cycle protection. This does not grant permission to declare children for a different immediate parent.                                                                                                                                          |
| `publishPlanArtifact`                | binding, artifactId, plan, review, author                                 | Assigned planning lead only. Uses existing `validateTaskPlan` and `planReviewSchema`, appends provenance, returns bounded reference/goal/task-count/external-dependency/warning summary in outcome.                                                                                                                                 |
| `submitImplementation` / `submitFix` | binding, optional defectId/attemptId                                      | Assigned implementer submits a new revision. A fix requires the committed automated attempt assigned to this exact task. Initial work without a defect still awaits current-revision QA.                                                                                                                                            |
| `recordFinding`                      | binding, defectId, revision, summary, evidence, optional responsibleTasks | Current verifier discovers a defect with zero automated failures and invalidates every responsible task's verification at that task's current artifact revision.                                                                                                                                                                    |
| `recordVerdict`                      | binding, optional defectId/attemptId, revision, verdict, evidence         | Exact task verifier only. Current revision required. Attempt passes record resolutions[taskId]; all non-cancelled responsibilities need current receipts before global resolution. Initial fail creates `<taskId>-initial-<revision>` with zero failures.                                                                           |
| `admitRepair`                        | binding, defectId, attemptId                                              | Current lead or implementer authorizes one automated attempt. Commit this result **before any implementer launch**, including continuation or reassignment launch.                                                                                                                                                                  |
| `recordAnalysis`                     | binding, defectId, analysis                                               | Responsible lead supplies reproduction, attempts/QA evidence references, verified/hypothetical causes, remedies and human decisions. Never changes locks or QA verdicts.                                                                                                                                                            |
| `reassign`                           | taskId, role, profile                                                     | Host changes assignment and advances its generation. Lead/implementer reassignment interrupts only authorized automated attempts, without counting them; verifier reassignment interrupts none. Submitted fixes still await QA. Lead reassignment invalidates that task's analysis.                                                 |
| `splitTask` / `continueTask`         | taskId, task                                                              | Host creates a linked task and extends the same defects' responsibleTasks without a resolution for the new task. Its QA is not inherited; resolved defects reopen. Counter and lock are never reset.                                                                                                                                |
| `addContinuationMember`              | provenance, member                                                        | Self-join only: the direct user command must originate in the joining conversation. The host validates matching scope before committing membership.                                                                                                                                                                                 |
| `humanRecheck`                       | provenance, id, attemptId, optional worktreeFingerprint                   | Creates manual attempts for the selected task's unresolved defects and increments only that task's artifact revision by one. A multi-responsibility defect ID is ambiguous and returns candidate task IDs plus `/repair recheck <taskId>`. Repeating a recheck while its current manual QA is pending returns the existing attempt. |
| `humanCancel`                        | provenance, id                                                            | Cancels the selected task or defect without treating cancellation as QA. Shared defects retain other active responsibilities; cancelled tasks no longer block resolution. Cancels a task's defect only when no active responsibility remains.                                                                                       |
| `humanStatus`                        | Separate API `(doc, provenance)`                                          | Checks member provenance and returns the document without mutation.                                                                                                                                                                                                                                                                 |
| `recoverWorkflow`                    | eventKey, at                                                              | Interrupts only authorized attempts and requests attention without replaying work or counting a failure. Submitted attempts remain awaiting QA for their submitted revision.                                                                                                                                                        |

`SubtasksCommand.subtasks` contains `{id,title,kind,scope,dependsOn,implementer?,verifier?,lead?}`. `kind` is `plan` or `implement`. All exported command types are available from the policy module for host integration.

### Verification and repair transitions

```text
initial submission -> awaiting-qa -> current pass -> verified (if no unresolved blockers)
                                  -> initial fail -> defect open, failures=0

failed current revision -> committed admitRepair -> authorized -> submitted fix
                                                             -> awaiting-recheck
QA blocked -> nonterminal; another current pass/fail is still allowed
QA pass    -> attempt closed, current task resolution recorded
           -> all non-cancelled responsibilities have current resolutions -> defect resolved
           -> otherwise open, or human-required for locked/manual ownership
QA fail    -> attempt closed, automated failures +1 exactly once
third fail -> locked + analysis-pending in the same mutation
all responsible leads analyzed -> human-required + notify-root
human recheck -> new revision/manual attempt -> QA pass or human-required on fail
```

A fourth automated admission is impossible after lock. Initial discovery does not consume an automated attempt. Manual failures do not increment the automated counter and do not return the defect to automated ownership. Manual passes may resolve a defect but never erase its lock or counter. A partial manual pass remains
`human-required` even when unlocked: human-origin work never returns the defect to automated ownership.
Only an unlocked automated attempt's partial pass returns the defect to `open`. A shared finding invalidates all responsible tasks' previous verification, even if another task had
already passed. A task is verified only when its current artifact revision passed and every unresolved,
non-cancelled defect has that task's current resolution. Thus one task may become verified while
another responsibility still requires fresh QA; the defect itself stays unresolved and a human recheck
of the remaining task must remain available. Cancelled responsible tasks do not block global resolution.
Split/continuation tasks have no inherited resolution and must obtain their own fresh QA. No transition,
including a final global resolution, resets `locked` or `automatedFailures`.

Wrong role, assignment, workflow or attempt task returns `WORKFLOW_NOT_AUTHORIZED`. Stale revisions are informational committed outcomes, not thrown errors: their receipt is persisted, the count stays unchanged, and the host reports `WORKFLOW_STALE` after commit. This distinction permits durable deduplication of stale events. A later event for an already-terminal attempt returns the first terminal outcome without adding evidence or counting again. Blocked evidence is nonterminal.

## Durable storage

`src/agents/task-workflow-store.ts` exports:

```ts
type WorkflowLocation = { originSessionFile: string };
openWorkflow(sessionFile, owner): Promise<Result<OpenedWorkflow | null, ExpectedError>>;
mutateWorkflow(location, originOwner, mutate, options?):
  Promise<Result<WorkflowMutation, ExpectedError>>;
writeWorkflowLink(sessionFile, owner, location, originOwner):
  Promise<Result<void, ExpectedError>>;
```

`OpenedWorkflow` is `{doc, location}`. The mutation callback accepts `WorkflowDocument | null` and returns `WorkflowPolicyResult`. Only initial creation should handle null; an absent existing workflow should produce `WORKFLOW_NOT_FOUND`. Creation can return `ok({doc: createWorkflowDocument(...), effects: [], outcome: {kind: "applied"}})`. Options support `expectedRevision?: number | null` and injectable `io?: Partial<WorkflowWriteIO>` for filesystem fault tests. An existing document must advance by exactly one revision, unless it is byte-equivalent idempotent state. Identity cannot change.

The canonical path has a per-path serialized queue. Each mutation rereads inside that queue, validates schema/owner/SDK identity, applies policy, and verifies replacement fingerprints. Files must be private 0600 regular single-link files owned by this OS user, in an owned canonical directory; symlinks are refused. SDK headers must match conversation ID and cwd. Only ENOENT means absent. Invalid JSON, unsupported versions, unsafe paths, wrong owners and changing fingerprints fail closed.

Writes use an exclusive 0600 temporary file, complete write, file fsync, atomic rename and directory fsync where the platform supports it. Expected I/O failures return `StorageError`; policy failures use stable `WorkflowError` codes (`WORKFLOW_NOT_AUTHORIZED`, `WORKFLOW_STALE`, `WORKFLOW_REPAIR_LOCKED`, `WORKFLOW_NOT_FOUND`, `WORKFLOW_CONFLICT`). Unexpected programming exceptions retain their original cause/stack.

**Commit precedes effects.** No effects are returned on a storage failure. Before rename, a failure preserves the prior document. A directory-fsync failure after rename cannot promise rollback: the new document may already be present. Retry with the same event key; never assume a failed response authorized a new launch.

`pendingDeliveries(doc)` derives `notify-leads`, `notify-root`, `notify-qa` and `needs-attention` effects from durable state. After an uncertain commit or restart the host can recover notifications without replaying mutations or repair launches. These are state-derived, at-least-once notifications: delivery consumers must deduplicate/coalesce appropriately.

The queue coordinates writers inside one host process, not independent processes. Workflow writes require the single owning host; fingerprint rechecks also refuse observed external replacements. This is not a cross-process transaction lock.

### Recovery and reassignment

Recovery interrupts only authorized attempts: implementation was admitted but no artifact was submitted. Interrupted nonterminal attempts still produce `needs-attention` through `pendingDeliveries`. They do not count as failures or block a fresh `admitRepair` with a new attempt ID against the current failed revision. Recovery never resets `automatedFailures` or `locked`; after two failures, the next failed automated recheck still triggers the permanent third-failure lock.

Submitted attempts are durable artifacts awaiting mandatory QA, not running implementations. Recovery preserves their status, `submittedRevision`, task verification and assignment generation, so the current verifier can still record a verdict. Awaiting-QA tasks continue to produce `notify-qa`; a later automated failure counts once, even if its verdict is delivered repeatedly.

Lead or implementer reassignment follows the same interruption rule for authorized automated attempts and preserves submitted attempts. Verifier reassignment interrupts no attempts, including authorized work. Every reassignment advances `assignmentVersion` and revokes old bindings; the host must bind the current verifier to the new generation before it reviews an existing submitted revision.

## Continuation links

A continuation stores only `<sessionFile>.workflow-link.json` with `{workflowId, originSessionFile, originOwner, owner}`. The extra local owner record permits verified link-only cleanup after its SDK original is gone. Membership must first be committed with `addContinuationMember`; then the host verifies the continuation SDK header and writes its link. Unlike other human operations, continuation does not require existing membership: provenance must have `kind: "user-command"` and its conversation ID must equal the joining member's conversation ID. Even an existing origin member cannot enroll another conversation by proxy. Matching scope is a host responsibility, not a pure-policy inference. A conversation already linked to another workflow is rejected with `WORKFLOW_CONFLICT` at link creation without replacing its existing link. An interrupted two-step operation may leave membership without a link, which is not an active continuation and can be safely retried.

`openWorkflow` checks both link identity and canonical membership, including member conversation/cwd/sessionFile and `via: "user-continuation"`. A forged/copied link cannot grant access. There is never a canonical-state copy in the continuation directory. After origin SDK retention, a validated live continuation still opens and mutates the canonical origin using its original owner and location.

## Retention and purge

Workflow records follow conversation retention, not an independent TTL. RuntimeStore and ChatStore inspect sidecars before SDK deletion, recheck fingerprints after the cleanup reservation, and store `cleanupWorkflow` with deletion intent so restart cannot delete a newly created replacement. Corrupt, foreign or changing records block deletion with the existing cleanup error path.

The store provides `inspectWorkflowForRetention`, `recheckWorkflowForRetention`, `deleteWorkflowForRetention` and `deleteWorkflowForPurge`. Deletion returns `removed`, `absent` or `retained`. The origin workflow is retained if any canonical continuation member has a valid SDK header and a private link pointing back to that origin. The origin SDK itself may expire. RuntimeStore/ChatStore expose `retentionWarnings: string[]`, reset per sweep; preservation warnings are not errors. Repository purge reports preserved workflow paths in `report.preserved`, not residual failures. Deleting a continuation removes only its link, never the canonical origin document.

## Reserved user command

`parseRepairCommand(text)` returns `Result<RepairCommand | null, InputError>`:

```text
/repair
/repair status [id]
/repair recheck <id>
/repair cancel <id>
/repair continue <workflowId>
```

The discriminant is `kind`. `repairCommand` exports the completion item. `resolveRepairId(doc, id)` accepts exact task/defect IDs or a unique prefix of at least six characters; ambiguous/missing IDs return stable workflow errors. Invalid reserved syntax reports usage and must not be forwarded to the model. `/repair continue` requires a complete workflow UUID; host integration must locate the canonical workflow and create membership/link through the user-command path.

## Verification coverage

English Q-prefixed tests cover Q01 lead publication/provenance/bounded context/explicit body authority;
Q02 incomplete readiness, fresh scope/artifacts, required questions, diagnostics and cancellation (E1);
Q03 hierarchical planning-purpose guards, explicit legacy compatibility and S01 profile intersection
(including nested reads and write-only profiles); Q04 discovery/three-strike lock/initial QA;
Q05 authority/stale revisions; Q06 event/terminal idempotency, blocked/concurrent admission and permanent
safety receipts; Q07 cancellation; Q08 fault injection/corruption/uncertain directory fsync/recovery;
Q09 assignment/split/task and conversation continuation/forged links/subtasks; Q10/Q11 D08 routine,
orphan, cross-branch and compact human-required routing; Q11 multi-lead analysis, complete bounded
handoff retrieval and artifacts (E1); Q14 manual revision, per-task resolution receipts and shared-task
QA (E1); Q16 recovery of submitted QA/interrupted admission/counter and lock preservation; and Q17
retention/purge/live continuations/fingerprint races/unlink failures. `task-host-boundary.test.ts`
adds Q04/Q05/Q06/Q15 coverage for D01/D02/D03/D04: locked-purpose spawns, scoped role acquisition,
single-live claims with capacity/factory/cleanup failures, and current-state authorization across
bound descendants, submission and real SDK direct/nested calls. Q11 also checks host handoff retrieval.
