import type { OpenSession } from "../model.ts";
import { CHAT_SCOPE_ID } from "../session-scope.ts";

// CHAT has no repository or branch. A CODE worktree satisfies this display contract.
export type SessionCollection = {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly sessions: readonly OpenSession[];
};

export function isChatCollection(collection: SessionCollection | null): boolean {
  return collection?.id === CHAT_SCOPE_ID;
}
