import type { Repository, Worktree } from "../workspace/model.ts";

export type SelectionState = {
  readonly worktreeId: string | null;
  readonly sessions: Readonly<Record<string, string>>;
};

/** Explicitly deleted workspace scopes, from the daemon's deletion summary. */
export type SelectionDeletion = {
  readonly worktreeIds: ReadonlySet<string>;
  readonly sessionIds: ReadonlySet<string>;
};

export class WorkspaceSelection {
  private repositories: readonly Repository[];
  private selectedWorktreeId: string | null;
  private readonly lastSessions = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  // Deleted sessions never return, even when their worktree path is recreated.
  private readonly deletedSessions = new Set<string>();
  // Deleted worktrees not yet reconciled with the next snapshot. A row with the same ID in that
  // snapshot is a recreated generation, not a survivor of the deleted one.
  private invalidatedWorktrees = new Set<string>();

  constructor(repositories: readonly Repository[]) {
    this.repositories = repositories;
    this.selectedWorktreeId = repositories.flatMap((repo) => repo.worktrees)[0]?.id ?? null;
    this.rememberSession();
  }

  get snapshot(): readonly Repository[] {
    return this.repositories;
  }

  get worktree(): Worktree | null {
    return (
      this.repositories
        .flatMap((repo) => repo.worktrees)
        .find((worktree) => worktree.id === this.selectedWorktreeId) ?? null
    );
  }

  get sessionId(): string | null {
    const worktree = this.worktree;
    if (!worktree) {
      return null;
    }

    const remembered = this.lastSessions.get(worktree.id);
    const sessions = this.liveSessions(worktree);

    return sessions.find((session) => session.id === remembered)?.id ?? sessions[0]?.id ?? null;
  }

  get state(): SelectionState {
    const sessions: Record<string, string> = {};
    for (const tree of this.repositories.flatMap((repo) => repo.worktrees)) {
      const live = this.liveSessions(tree);
      const selected =
        live.find((session) => session.id === this.lastSessions.get(tree.id)) ?? live[0];
      if (selected) {
        sessions[tree.id] = selected.id;
      }
    }

    return { worktreeId: this.worktree?.id ?? null, sessions };
  }

  restore(state: SelectionState): void {
    this.lastSessions.clear();
    for (const tree of this.repositories.flatMap((repo) => repo.worktrees)) {
      const id = state.sessions[tree.id];
      if (
        id &&
        !this.deletedSessions.has(id) &&
        tree.sessions.some((session) => session.id === id)
      ) {
        this.lastSessions.set(tree.id, id);
      }
    }
    if (
      this.repositories.some((repo) => repo.worktrees.some((tree) => tree.id === state.worktreeId))
    ) {
      this.selectedWorktreeId = state.worktreeId;
    }

    this.rememberSession();
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  selectWorktree(id: string): void {
    if (!this.repositories.some((repo) => repo.worktrees.some((tree) => tree.id === id))) {
      return;
    }

    this.selectedWorktreeId = id;
    this.rememberSession();
    this.emit();
  }

  selectSession(worktreeId: string, sessionId: string): void {
    const worktree = this.repositories
      .flatMap((repo) => repo.worktrees)
      .find((tree) => tree.id === worktreeId);
    if (
      this.deletedSessions.has(sessionId) ||
      !worktree?.sessions.some((session) => session.id === sessionId)
    ) {
      return;
    }

    this.lastSessions.set(worktreeId, sessionId);
    this.selectedWorktreeId = worktreeId;
    this.emit();
  }

  /**
   * Discards remembered selections of explicitly deleted scopes without notifying listeners.
   * Call `replaceSnapshot` next: it moves an affected selected worktree to a survivor and treats
   * a row with a deleted ID as a new generation. Cold or missing rows are not deletions.
   */
  forget(deletion: SelectionDeletion): void {
    for (const id of deletion.sessionIds) {
      this.deletedSessions.add(id);
    }
    for (const [worktreeId, sessionId] of this.lastSessions) {
      if (deletion.worktreeIds.has(worktreeId) || this.deletedSessions.has(sessionId)) {
        this.lastSessions.delete(worktreeId);
      }
    }
    for (const id of deletion.worktreeIds) {
      this.invalidatedWorktrees.add(id);
    }
  }

  // The host supplies display snapshots, including optimistic removals. Removing
  // an item here never aborts an agent or deletes its persisted history.
  replaceSnapshot(
    repositories: readonly Repository[],
    restoredSessions: Readonly<Record<string, string>> = {},
  ): void {
    const invalidated = this.invalidatedWorktrees;
    this.invalidatedWorktrees = new Set();
    for (const previous of this.repositories.flatMap((repo) => repo.worktrees)) {
      if (invalidated.has(previous.id)) {
        continue;
      }

      const next = repositories
        .flatMap((repo) => repo.worktrees)
        .find((tree) => tree.id === previous.id);
      const selectedId = this.lastSessions.get(previous.id) ?? previous.sessions[0]?.id;
      if (!selectedId || next?.sessions.some((session) => session.id === selectedId)) {
        continue;
      }

      const index = previous.sessions.findIndex((session) => session.id === selectedId);
      const survivingIds = new Set(next?.sessions.map((session) => session.id));
      const following = previous.sessions
        .slice(index + 1)
        .find((session) => survivingIds.has(session.id));
      const preceding = previous.sessions
        .slice(0, index)
        .findLast((session) => survivingIds.has(session.id));
      const fallback = following ?? preceding ?? next?.sessions[0];
      if (fallback) {
        this.lastSessions.set(previous.id, fallback.id);
      } else {
        this.lastSessions.delete(previous.id);
      }
    }
    // A lazily attached repository may have had no session rows when preferences were restored.
    for (const tree of repositories.flatMap((repo) => repo.worktrees)) {
      const saved = restoredSessions[tree.id];
      if (
        saved &&
        !this.deletedSessions.has(saved) &&
        !tree.sessions.some((session) => session.id === this.lastSessions.get(tree.id)) &&
        tree.sessions.some((session) => session.id === saved)
      ) {
        this.lastSessions.set(tree.id, saved);
      }
    }

    const previousOrder = this.repositories.flatMap((repo) =>
      repo.worktrees.map((tree) => tree.id),
    );
    this.repositories = repositories;
    const selected = this.selectedWorktreeId;
    if (!this.worktree || (selected !== null && invalidated.has(selected))) {
      this.selectedWorktreeId = this.fallbackWorktree(previousOrder, selected, invalidated);
    }

    this.emit();
  }

  // Next surviving row in the previous display order, then the previous survivor, then the
  // first new row. Recreated rows of deleted worktrees count as new.
  private fallbackWorktree(
    previousOrder: readonly string[],
    selected: string | null,
    invalidated: ReadonlySet<string>,
  ): string | null {
    const nextOrder = this.repositories.flatMap((repo) => repo.worktrees.map((tree) => tree.id));
    const present = new Set(nextOrder);
    const survives = (id: string) => present.has(id) && !invalidated.has(id);
    const index = selected === null ? -1 : previousOrder.indexOf(selected);
    if (index >= 0) {
      const following = previousOrder.slice(index + 1).find(survives);
      const preceding = previousOrder.slice(0, index).findLast(survives);
      const survivor = following ?? preceding;
      if (survivor) {
        return survivor;
      }
    }

    const previous = new Set(previousOrder.filter(survives));

    return nextOrder.find((id) => !previous.has(id)) ?? nextOrder[0] ?? null;
  }

  // A snapshot can still list a deleted session briefly; it is never selected again.
  private liveSessions(worktree: Worktree): Worktree["sessions"] {
    return this.deletedSessions.size
      ? worktree.sessions.filter((session) => !this.deletedSessions.has(session.id))
      : worktree.sessions;
  }

  private rememberSession(): void {
    const worktree = this.worktree;
    const sessionId = this.sessionId;
    if (worktree && sessionId) {
      this.lastSessions.set(worktree.id, sessionId);
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
