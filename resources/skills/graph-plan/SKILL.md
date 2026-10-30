---
name: graph-plan
description: Create and review a structurally validated task and delegation graph without implementing or executing its tasks.
---

# Graph planning

Create a plan, not an implementation. Do not spawn subagents, edit product files, install dependencies, run task acceptance commands, commit, or execute the proposed work. Read repository instructions and relevant code to ground the plan. Shell access is for read-only investigation, not a sandbox or permission to mutate the workspace.

## Establish the contract

1. Identify the user's goal, scope, constraints, and observable acceptance criteria. Read supplied requirements and relevant existing code before choosing tasks.
2. Separate confirmed facts from assumptions. Ask about decisions that would materially change the work. Keep unresolved questions explicit; do not silently invent product policy.
3. Use `radian-plan` with `action: "read"` when updating the current conversation's plan. Its saved file is authoritative; older submissions in the transcript are historical.

## Build a task and delegation graph

Submit a JSON plan with all of these fields:

- `schemaVersion`: `1`.
- `goal`: the intended outcome.
- `outOfScope`, `assumptions`, `openQuestions`: arrays of nonblank strings; empty arrays are allowed.
- `tasks`: a nonempty array of tasks, each containing:
  - `id`: a stable identifier using letters, digits, `_`, or `-`, beginning with a letter or digit.
  - `title`: one cohesive outcome.
  - `agent`: `main` or an actually available role profile. Assignment is a proposal, not delegation. Use `main` when the host does not advertise role profiles or profile discovery. Only use a list action when the host actually provides one; do not spawn agents.
  - `dependsOn`: IDs of prerequisites; roots use `[]`.
  - `inputs`: required contracts, evidence, or artifacts; `[]` is allowed.
  - `outputs`: at least one concrete artifact or decision.
  - `acceptanceCriteria`: at least one observable check, described but not executed now.
  - `files`: expected workspace-relative write scope; `[]` is allowed for investigation tasks. Scope is not a file lock.

Choose dependencies from actual input/output requirements, not an arbitrary numbered sequence. Make shared contracts explicit before parallel implementation. Avoid unnecessary task fragmentation and unnecessary delegation. Plan parallelism only where dependencies and write scopes permit it. Do not maintain a separate authoritative edge list or hand-written graph.

## Review and submit

Review requirement coverage, task size, prerequisite artifacts, role fit, shared-file risks, verification coverage, and unresolved decisions. Plans may be structurally valid while still needing a user decision. Report those limitations honestly.

Call `radian-plan` with `action: "submit"`, the complete `plan`, and `review: { "summary": "...", "warnings": [] }`. The summary describes the semantic review actually performed. Warnings contain remaining risks or limitations; they are not structural errors. The host validates the graph and atomically replaces the current saved plan only on success. An invalid submission must not replace the previous valid plan. Correct reported structural errors before claiming success.

Present the saved plan's task dependencies, proposed role assignments, outputs, acceptance criteria, semantic review, warnings, and unresolved questions. State separately that structure passed, semantic review is an agent assessment, user approval is not implied, and no tasks were executed. Use the same saved plan data rather than inventing a second graph in prose.
