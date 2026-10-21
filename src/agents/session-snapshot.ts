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
  readonly updatedAt: number;
  readonly title: string;
  readonly messageCount: number;
};

// Recovery and History read the same records; only recovery filters by lifecycle.
export type SessionSnapshotSource = {
  listSessions(worktreeId: string): readonly SessionSnapshotInfo[];
  readSession(worktreeId: string, conversationId: string): Promise<Result<SessionRecord | null, ExpectedError>>;
};

export function sessionRecordKey(record: SessionRecord): string {
  return JSON.stringify([record.worktreeId, record.state.conversationId ?? record.id]);
}
