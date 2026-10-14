import { SessionManager } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import type { Repository } from "../workspace/model.ts";
import type { SessionRegistry } from "./session-registry.ts";

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
  constructor(private readonly repositories: readonly Repository[], private readonly registry: SessionRegistry,
    private readonly sessionDir?: string) {}

  async list(worktreeId: string): Promise<readonly HistoryItem[]> {
    return (await this.saved(worktreeId)).map(({ path: _path, ...item }) => item);
  }

  async resume(worktreeId: string, savedId: string): Promise<string> {
    const item = (await this.saved(worktreeId)).find((entry) => entry.id === savedId);
    if (!item) throw new Error("Saved session is not available in this worktree. Refresh history.");
    if (item.unavailableReason) throw new Error(item.unavailableReason);
    if (item.openSessionId) return item.openSessionId;
    // Reject malformed JSON before SDK repair logic can overwrite an empty/corrupt file.
    const entries: unknown[] = (await Bun.file(item.path).text()).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
    const header = entries[0];
    if (!header || typeof header !== "object" || !("type" in header) || header.type !== "session") {
      throw new Error("Saved session has no valid header; original file was not changed.");
    }
    // Concurrent resume calls are serialized by the registry's canonical writer reservation.
    return this.registry.create(worktreeId, item.path, { id: crypto.randomUUID(), name: item.title });
  }

  private async saved(worktreeId: string): Promise<SavedHistory[]> {
    const tree = this.repositories.flatMap((repo) => repo.worktrees).find((entry) => entry.id === worktreeId);
    if (!tree) throw new Error("No worktree is available for history.");
    const cwd = await realpath(tree.path);
    const sessions = await SessionManager.list(tree.path, this.sessionDir);
    const result: SavedHistory[] = [];
    for (const session of sessions) {
      // A custom test directory is shared by worktrees; cwd metadata must still scope each list.
      if (session.cwd) {
        let savedCwd: string;
        try { savedCwd = await realpath(session.cwd); }
        catch { continue; }
        if (savedCwd !== cwd) continue;
      } else if (this.sessionDir) continue;
      const path = await realpath(session.path);
      const ownership = this.registry.historyOwnership(path);
      result.push({ id: session.id, path, worktreeId, title: (session.name?.trim() || session.firstMessage.trim() || "Untitled session").replace(/\s+/g, " ").slice(0, 120),
        modified: session.modified.toISOString(), messageCount: session.messageCount,
        openSessionId: ownership.openSessionId, unavailableReason: ownership.unavailableReason });
    }
    return result.sort((a, b) => b.modified.localeCompare(a.modified) || a.id.localeCompare(b.id));
  }
}
