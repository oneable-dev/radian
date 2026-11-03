---
name: graph-plan
description: Coordinate read-only branch leads and report durable planning readiness without executing tasks.
---

# Graph planning

Plan, do not implement. Read repository instructions, requirements and relevant code. Do not edit product files, install dependencies, run tests/builds or acceptance commands, commit, or execute proposed implementation tasks. Shell access is for read-only investigation, not an OS sandbox.

## Hierarchical planning (default `/plan`)

1. Establish the goal, scope, constraints and observable acceptance criteria. Separate confirmed facts, assumptions and material unanswered questions. Ask the user about decisions outside your authority.
2. Discover `availableAgents` through `radian-subagent list`. Select only relevant branch leads, such as product-lead, tech-lead, ui-ux-lead or QA; not every profile is required. Do not invent unavailable profiles or use a configured legacy planner as a root super-planner.
3. Declare scope using `radian-task` with `action: "declare"`, `goal`, and `branches: [{id,title,lead:{profile},scope,dependsOn}]`. Stable IDs may be re-declared to replan a branch. Only the declared branches are current; history is retained, not required. Dependencies reference other current branch IDs. The host retains unknown profiles, missing dependencies, duplicates and cycles as diagnostics; do not call a diagnosed manifest ready.
4. Spawn each declared lead using `radian-subagent spawn` with its assigned `agent`, a bounded `task`, and `binding: {id: branchId, role: "lead"}`. Provide requirements, branch scope, evidence, dependencies, available roles and acceptance expectations. Ask the lead to publish its detailed plan and return only a bounded summary/reference. These are read-only planning runs, not implementation runs. Delegation-enabled leads may delegate read-only investigation transitively; every descendant inherits planning purpose.
   Spawn a dependent lead after its upstream publishes: the host freezes upstream artifact references at spawn. If an upstream republishes, respawn the dependent lead and republish to refresh coverage. A lead bound before its branch's latest declaration must also be respawned.

5. Use `status`, `wait` and `reply` for owned planning runs. Relay material questions to the user when necessary. Do not poll or sleep. Resolve questions explicitly, never interpret silence as approval. Stop abandoned runs or use `radian-plan cancel`; cancellation retains durable records and cannot roll back accepted publications.
6. Leads own detailed plans. Each assigned lead calls `radian-task publish-plan` with `artifactId`, complete `plan`, and `review`. The host validates and appends a revision with run/profile/role provenance. The parent receives only a bounded summary and `ref@revision`. Do not request a full proposal, copy or rewrite branch bodies, use parent submit, or accept/save a combined replacement.
7. Call `radian-plan report`. Present the host's readiness, branch owners, artifact references/summaries, diagnostics, unpublished dependencies and unanswered questions. Readiness is `ready for review` only when every declared branch has an artifact and no blockers remain; otherwise it is `incomplete`. Never call it approved. Execution has not started. Settling without publication produces an incomplete report, not success.

The workflow context carries a bounded goal/branch/reference/diagnostic summary, never full artifact bodies. When details are essential, the root or owning lead may explicitly retrieve `radian-task status` with `artifact: "ref@revision"`; another lead may not read a foreign branch body. A legacy `.plan.json` pointer may also exist; `radian-plan read` reads it, not the hierarchical workflow.

## Detailed lead plan and review

Publish a complete JSON plan with:

- `schemaVersion: 1`, `goal`, and arrays `outOfScope`, `assumptions`, `openQuestions` (empty arrays allowed).
- A nonempty `tasks` array. Each task contains `id`, `title`, `agent`, `dependsOn`, `inputs`, `outputs`, `acceptanceCriteria`, `files`.
- IDs use letters, digits, `_` or `-` and start with a letter or digit. Dependencies reference task IDs in the same plan. External prerequisites belong in inputs and the declared branch dependencies.
- `agent` is `main` or an actually available profile. Proposed implementation assignments do not authorize spawning them during planning.
- Outputs and acceptance criteria contain observable deliverables/checks; describe checks without executing them. Files describe expected workspace-relative write scope, not locks.

Choose dependencies from actual inputs/outputs rather than arbitrary numbered order. Make shared contracts and file conflicts explicit before parallel work. Review coverage, useful task size, role availability, verification coverage, risks and open decisions. Publish `review: {summary, warnings: []}` describing the semantic review actually performed. Structural validity is not semantic correctness, user approval or completion.

## Explicit legacy single-planner compatibility

Only `/plan --single [requirements]` uses the former conversation-wide `.plan.json` workflow:

- With `commandAgents.plan`, use `radian-plan delegate` once, then `wait`/`reply`. The read-only child returns `{plan,review}` through `radian-supervisor proposal`. Review its complete proposal and use `radian-plan accept`; do not submit a parent replacement. Invalid, unfinished, stale or cancelled proposals do not replace the prior file.
- Without that binding, investigate in the parent and use `radian-plan submit` with the complete plan and review.
- Present the saved graph, assignments, outputs, acceptance criteria and limitations in the same turn. The parent alone validates/saves the sidecar. This compatibility path is not the hierarchical default.

Plain `/plan` never uses `commandAgents.plan`; the host explicitly reports that it is a legacy single-planner binding and points to `/plan --single`.

## Later authorized execution

Planning is not an automatic scheduler. After the user authorizes implementation, inspect applicable artifacts and compare acceptance criteria with actual changes and verification evidence before reporting completion. Keep unmet/unverified criteria explicit; do not apply stale plans to unrelated work. Bind implementation and QA to the same durable task. Three failed automated repairs permanently lock the defect across reassignment, splitting and continuation: responsible leads supply read-only analysis, then wait for the user's host `/repair` command. Model messages and notifications are never human repair authorization.
