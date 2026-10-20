import { SessionManager } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { repositorySnapshot, type RepositorySource } from "../workspace/catalog.ts";
import { validateHistory, type SessionRegistry } from "./session-registry.ts";
import { capture, HistoryError, SessionError, StorageError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { CancelledError } from "../errors.ts";
import { readHistoryPreview, type HistoryPreview } from "./history-preview.ts";

export type HistoryItem = {
  readonly id: string;
  readonly worktreeId: string;
  readonly title: string;
  readonly modified: string;
  readonly messageCount: number;
  readonly openSessionId: string | null;
  readonly unavailableReason: string | null;
};

type SavedHistory = HistoryItem & { readonly path: string };

// SDK owns history discovery and context reconstruction. The UI never accepts arbitrary file paths.
export class SessionHistory {
  constructor(private readonly repositories: RepositorySource, private readonly registry: SessionRegistry,
    private readonly sessionDir?: string) {}

  async list(worktreeId: string): Promise<Result<readonly HistoryItem[], ExpectedError>> {
    const saved = await this.saved(worktreeId);
    return saved.ok ? ok(saved.value.map(({ path: _path, ...item }) => item)) : saved;
  }

  async preview(worktreeId: string, savedId: string, signal?: AbortSignal): Promise<Result<HistoryPreview, ExpectedError>> {
    if (signal?.aborted) return err(new CancelledError());
    const saved = await this.saved(worktreeId); if (!saved.ok) return saved;
    if (signal?.aborted) return err(new CancelledError());
    const item = saved.value.find((entry) => entry.id === savedId);
    if (!item) return err(new HistoryError("HISTORY_UNAVAILABLE", "Saved session is not available in this worktree. Refresh history."));
    return readHistoryPreview(item.path, worktreeId, savedId, signal);
  }

  async resume(worktreeId: string, savedId: string): Promise<Result<string, ExpectedError>> {
    const saved = await this.saved(worktreeId); if (!saved.ok) return saved;
    const item = saved.value.find((entry) => entry.id === savedId);
    if (!item) return err(new HistoryError("HISTORY_UNAVAILABLE", "Saved session is not available in this worktree. Refresh history."));
    if (item.unavailableReason) return err(new SessionError("SESSION_CONFLICT", item.unavailableReason));
    if (item.openSessionId) return ok(item.openSessionId);
    const validated = await validateHistory(item.path); if (!validated.ok) return validated;
    return this.registry.create(worktreeId, item.path, { id: crypto.randomUUID(), name: item.title });
  }

  private async saved(worktreeId: string): Promise<Result<SavedHistory[], ExpectedError>> {
    const tree = repositorySnapshot(this.repositories).flatMap((repo) => repo.worktrees).find((entry) => entry.id === worktreeId);
    if (!tree) return err(new HistoryError("HISTORY_UNAVAILABLE", "No worktree is available for history."));
    const cwd = await capture(() => realpath(tree.path)); if (!cwd.ok) return cwd;
    const sessions = await capture(() => SessionManager.list(tree.path, this.sessionDir)); if (!sessions.ok) return sessions;
    const result: SavedHistory[] = [];
    for (const session of sessions.value) {
      // A custom test directory is shared by worktrees; cwd metadata must still scope each list.
      if (session.cwd) {
        const savedCwd = await capture(() => realpath(session.cwd));
        if (!savedCwd.ok) {
          // Deleted historical worktrees are expected; permission/I/O faults are not empty history.
          if (savedCwd.error instanceof StorageError && savedCwd.error.systemCode === "ENOENT") continue;
          return savedCwd;
        }
        if (savedCwd.value !== cwd.value) continue;
      } else if (this.sessionDir) continue;
      const path = await capture(() => realpath(session.path)); if (!path.ok) return path;
      const ownership = this.registry.historyOwnership(path.value);
      result.push({ id: session.id, path: path.value, worktreeId, title: (session.name?.trim() || session.firstMessage.trim() || "Untitled session").replace(/\s+/g, " ").slice(0, 120),
        modified: session.modified.toISOString(), messageCount: session.messageCount,
        openSessionId: ownership.openSessionId, unavailableReason: ownership.unavailableReason });
    }
    return ok(result.sort((a, b) => b.modified.localeCompare(a.modified) || a.id.localeCompare(b.id)));
  }
}
