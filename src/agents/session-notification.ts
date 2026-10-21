import type { SessionResult } from "./session-attention.ts";

// A transient delivery is not ownership of the runtime's persistent unread result.
export type SessionNotification = {
  readonly id: string;
  readonly sessionId: string;
  readonly worktreeId: string;
  readonly conversationId: string | undefined;
  readonly repository: string;
  readonly worktree: string;
  readonly branch: string | null;
  readonly result: SessionResult;
  readonly durationMs?: number;
};
