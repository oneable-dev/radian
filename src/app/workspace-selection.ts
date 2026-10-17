import type { Repository, Worktree } from "../workspace/model.ts";

export type SelectionState = { readonly worktreeId: string | null; readonly sessions: Readonly<Record<string, string>> };

export class WorkspaceSelection {
  private repositories: readonly Repository[];
  private selectedWorktreeId: string | null;
  private readonly lastSessions = new Map<string, string>();
  private readonly listeners = new Set<() => void>();

  constructor(repositories: readonly Repository[]) {
    this.repositories = repositories;
    this.selectedWorktreeId = repositories.flatMap((repo) => repo.worktrees)[0]?.id ?? null;
    this.rememberSession();
  }

  get snapshot(): readonly Repository[] {
    return this.repositories;
  }

  get worktree(): Worktree | null {
    return this.repositories.flatMap((repo) => repo.worktrees)
      .find((worktree) => worktree.id === this.selectedWorktreeId) ?? null;
  }

  get sessionId(): string | null {
    const worktree = this.worktree;
    if (!worktree) return null;
    const remembered = this.lastSessions.get(worktree.id);
    return worktree.sessions.find((session) => session.id === remembered)?.id
      ?? worktree.sessions[0]?.id ?? null;
  }

  get state(): SelectionState {
    const sessions: Record<string, string> = {};
    for (const tree of this.repositories.flatMap((repo) => repo.worktrees)) {
      const selected = tree.sessions.find((session) => session.id === this.lastSessions.get(tree.id)) ?? tree.sessions[0];
      if (selected) sessions[tree.id] = selected.id;
    }
    return { worktreeId: this.worktree?.id ?? null, sessions };
  }

  restore(state: SelectionState): void {
    this.lastSessions.clear();
    for (const tree of this.repositories.flatMap((repo) => repo.worktrees)) {
      const id = state.sessions[tree.id];
      if (id && tree.sessions.some((session) => session.id === id)) this.lastSessions.set(tree.id, id);
    }
    if (this.repositories.some((repo) => repo.worktrees.some((tree) => tree.id === state.worktreeId))) {
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
    if (!this.repositories.some((repo) => repo.worktrees.some((tree) => tree.id === id))) return;
    this.selectedWorktreeId = id;
    this.rememberSession();
    this.emit();
  }

  selectSession(worktreeId: string, sessionId: string): void {
    const worktree = this.repositories.flatMap((repo) => repo.worktrees).find((tree) => tree.id === worktreeId);
    if (!worktree?.sessions.some((session) => session.id === sessionId)) return;
    this.lastSessions.set(worktreeId, sessionId);
    this.selectedWorktreeId = worktreeId;
    this.emit();
  }

  // The host supplies display snapshots, including optimistic removals. Removing
  // an item here never aborts an agent or deletes its persisted history.
  replaceSnapshot(repositories: readonly Repository[], restoredSessions: Readonly<Record<string, string>> = {}): void {
    for (const previous of this.repositories.flatMap((repo) => repo.worktrees)) {
      const next = repositories.flatMap((repo) => repo.worktrees).find((tree) => tree.id === previous.id);
      const selectedId = this.lastSessions.get(previous.id) ?? previous.sessions[0]?.id;
      if (!selectedId || next?.sessions.some((session) => session.id === selectedId)) continue;
      const index = previous.sessions.findIndex((session) => session.id === selectedId);
      const survivingIds = new Set(next?.sessions.map((session) => session.id));
      const following = previous.sessions.slice(index + 1).find((session) => survivingIds.has(session.id));
      const preceding = previous.sessions.slice(0, index).findLast((session) => survivingIds.has(session.id));
      const fallback = following ?? preceding ?? next?.sessions[0];
      if (fallback) this.lastSessions.set(previous.id, fallback.id);
      else this.lastSessions.delete(previous.id);
    }
    // A lazily attached repository may have had no session rows when preferences were restored.
    for (const tree of repositories.flatMap((repo) => repo.worktrees)) {
      const saved = restoredSessions[tree.id];
      if (saved && !tree.sessions.some((session) => session.id === this.lastSessions.get(tree.id)) && tree.sessions.some((session) => session.id === saved)) this.lastSessions.set(tree.id, saved);
    }
    this.repositories = repositories;
    if (!this.worktree) this.selectedWorktreeId = repositories.flatMap((repo) => repo.worktrees)[0]?.id ?? null;
    this.emit();
  }

  private rememberSession(): void {
    const worktree = this.worktree;
    const sessionId = this.sessionId;
    if (worktree && sessionId) this.lastSessions.set(worktree.id, sessionId);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
