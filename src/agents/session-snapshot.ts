import type { ExpectedError } from "../errors.ts";
import type { Result } from "../result.ts";
import type { SessionRecord } from "./session-registry.ts";

export type SessionLifecycle = "open" | "closed";
export type SessionSnapshotInfo = {
  readonly id: string;
  readonly name: string;
  readonly worktreeId: string;
  readonly conversationId?: string;
  readonly sessionFile?: string;
  readonly cwd?: string;
  readonly lifecycle: SessionLifecycle;
  readonly closedAt?: number | null;
  readonly managed?: boolean;
  readonly updatedAt: number;
  readonly title: string;
  readonly messageCount: number;
};

// Recovery restores open records; History reads snapshots only for SDK-discovered conversations.
export type SessionSnapshotSource = {
  listSessions(worktreeId: string): readonly SessionSnapshotInfo[];
  readSession(worktreeId: string, conversationId: string): Promise<Result<SessionRecord | null, ExpectedError>>;
  isExpired?(worktreeId: string, conversationId: string): boolean;
};

export function sessionRecordKey(record: SessionRecord): string {
  return JSON.stringify([record.worktreeId, record.state.conversationId ?? record.id]);
}
