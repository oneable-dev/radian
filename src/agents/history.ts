import { SessionManager } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { repositorySnapshot, type RepositorySource } from "../workspace/catalog.ts";
import { validateHistory, type SessionRegistry } from "./session-registry.ts";
import { CancelledError, capture, HistoryError, SessionError, StorageError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
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
type HistoryIndex = { readonly cwd: string; readonly items: readonly SavedHistory[]; readonly byId: ReadonlyMap<string, SavedHistory> };
type Discovery = { readonly ready: Promise<Result<HistoryIndex, ExpectedError>>; readonly signal: AbortSignal | undefined; valid: boolean };

// SDK owns discovery. Cached indexes only resolve IDs to paths; they never authorize a writable Open.
export class SessionHistory {
  private readonly indexes = new Map<string, Discovery>();

  constructor(private readonly repositories: RepositorySource, private readonly registry: SessionRegistry,
    private readonly sessionDir?: string) {}

  async list(worktreeId: string, signal?: AbortSignal): Promise<Result<readonly HistoryItem[], ExpectedError>> {
    const saved = await this.index(worktreeId, signal, true);
    return saved.ok ? ok(saved.value.items.map(({ path: _path, ...item }) => item)) : saved;
  }

  async preview(worktreeId: string, savedId: string, signal?: AbortSignal): Promise<Result<HistoryPreview, ExpectedError>> {
    if (signal?.aborted) return err(new CancelledError());
    const tree = repositorySnapshot(this.repositories).flatMap(repo => repo.worktrees).find(entry => entry.id === worktreeId);
    if (!tree) return err(new HistoryError("HISTORY_UNAVAILABLE", "No worktree is available for history."));
    let saved = await this.index(worktreeId, signal);
    // A different caller may have cancelled a shared cold discovery. Retry only that cancelled discovery.
    if (!saved.ok && saved.error.code === "CANCELLED" && !signal?.aborted) saved = await this.index(worktreeId, signal);
    if (signal?.aborted) return err(new CancelledError());
    if (!saved.ok) return saved;
    const item = saved.value.byId.get(savedId);
    if (!item) return err(new HistoryError("HISTORY_UNAVAILABLE", "Saved session is not available in this worktree. Refresh history."));
    const cwd = await capture(() => realpath(tree.path)); if (!cwd.ok) return cwd;
    const path = await capture(() => realpath(item.path)); if (!path.ok) return path;
    if (cwd.value !== saved.value.cwd || path.value !== item.path) return err(new HistoryError("HISTORY_UNAVAILABLE", "Saved session location changed. Refresh history."));
    return readHistoryPreview(path.value, worktreeId, savedId, signal, { cwd: cwd.value, requireCwd: !!this.sessionDir });
  }

  async resume(worktreeId: string, savedId: string): Promise<Result<string, ExpectedError>> {
    // Mutating actions always rediscover current membership and writer ownership.
    const saved = await this.index(worktreeId, undefined, true); if (!saved.ok) return saved;
    const item = saved.value.byId.get(savedId);
    if (!item) return err(new HistoryError("HISTORY_UNAVAILABLE", "Saved session is not available in this worktree. Refresh history."));
    if (item.unavailableReason) return err(new SessionError("SESSION_CONFLICT", item.unavailableReason));
    if (item.openSessionId) return ok(item.openSessionId);
    const validated = await validateHistory(item.path); if (!validated.ok) return validated;
    return this.registry.create(worktreeId, item.path, { id: crypto.randomUUID(), name: item.title });
  }

  private index(worktreeId: string, signal?: AbortSignal, refresh = false): Promise<Result<HistoryIndex, ExpectedError>> {
    if (signal?.aborted) return Promise.resolve(err(new CancelledError()));
    const ids = new Set(repositorySnapshot(this.repositories).flatMap(repo => repo.worktrees.map(tree => tree.id)));
    for (const id of this.indexes.keys()) if (!ids.has(id)) this.indexes.delete(id);
    if (!ids.has(worktreeId)) return Promise.resolve(err(new HistoryError("HISTORY_UNAVAILABLE", "No worktree is available for history.")));
    const previous = this.indexes.get(worktreeId);
    if (!refresh && previous && (previous.valid || !previous.signal?.aborted)) return previous.ready;
    const ready = this.discover(worktreeId, signal).then(result => { entry.valid = result.ok; return result; });
    const entry: Discovery = { ready, signal, valid: false };
    this.indexes.set(worktreeId, entry);
    // Replacing the promise before it resolves also fences out older refreshes.
    return ready;
  }

  private async discover(worktreeId: string, signal?: AbortSignal): Promise<Result<HistoryIndex, ExpectedError>> {
    if (signal?.aborted) return err(new CancelledError());
    const tree = repositorySnapshot(this.repositories).flatMap(repo => repo.worktrees).find(entry => entry.id === worktreeId);
    if (!tree) return err(new HistoryError("HISTORY_UNAVAILABLE", "No worktree is available for history."));
    const cwd = await capture(() => realpath(tree.path)); if (!cwd.ok) return cwd;
    if (signal?.aborted) return err(new CancelledError());
    const sessions = await capture(() => SessionManager.list(tree.path, this.sessionDir, undefined, signal)); if (!sessions.ok) return sessions;
    const result: SavedHistory[] = [];
    for (const session of sessions.value) {
      if (signal?.aborted) return err(new CancelledError());
      // A custom directory may be shared by worktrees; cwd metadata must still scope each list.
      if (session.cwd) {
        const savedCwd = await capture(() => realpath(session.cwd));
        if (!savedCwd.ok) {
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
    if (signal?.aborted) return err(new CancelledError());
    result.sort((a, b) => b.modified.localeCompare(a.modified) || a.id.localeCompare(b.id));
    // Preserve the same newest-first resolution as the original Array.find for duplicate saved IDs.
    const byId = new Map<string, SavedHistory>();
    for (const item of result) if (!byId.has(item.id)) byId.set(item.id, item);
    return ok({ cwd: cwd.value, items: result, byId });
  }
}
