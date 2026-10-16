import type { OpenSession } from "../agents/model.ts";

// Repository/worktree snapshots include agent summaries, not execution handles.
export type Worktree = {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly branch: string | null;
  readonly sessions: readonly OpenSession[];
};

export type Repository = {
  readonly id: string;
  readonly name: string;
  readonly worktrees: readonly Worktree[];
};
