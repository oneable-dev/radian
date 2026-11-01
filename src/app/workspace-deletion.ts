import type { ExpectedError } from "../errors.ts";
import { ok, type Result } from "../result.ts";
import type { DeletedScopes } from "../runtime/protocol.ts";
import type { CleanupScope } from "../runtime/restore-state.ts";
import type { Repository } from "../workspace/model.ts";
import {
  recordedOwner,
  referencedWorktrees,
  resolveUiScrub,
  scrubUiState,
  type UiState,
} from "./ui-state.ts";
import type { SelectionDeletion, WorkspaceSelection } from "./workspace-selection.ts";

/** UI memory to scrub for explicit deletions newer than the acknowledged cleanup revision. */
export type DeletionBatch = SelectionDeletion & {
  // `deletedScopes.revision` to acknowledge once the scrubbed state is coherent.
  readonly revision: number;
  // Per-receipt identities. Worktree IDs are paths another repository may own now, so worktree
  // state is scrubbed only where the receipt's repository owns it.
  readonly scopes: readonly CleanupScope[];
};

/**
 * Reads the daemon's explicit deletion summary. Cold, not-ready, unavailable or disconnected
 * repositories never appear here, so their UI state is never treated as deleted.
 *
 * Every scope changed after `acknowledged` is scrubbed, including a reopened one: a UI that
 * missed the pending/complete states still holds the deleted generation's memory. Returns
 * `null` when nothing newer than `acknowledged` was published.
 */
export function pendingDeletion(
  summary: DeletedScopes | undefined,
  acknowledged: number,
): DeletionBatch | null {
  if (!summary || summary.revision <= acknowledged) {
    return null;
  }

  const worktreeIds = new Set<string>();
  const sessionIds = new Set<string>();
  const scopes: CleanupScope[] = [];
  for (const scope of summary.scopes) {
    if (scope.revision <= acknowledged) {
      continue;
    }

    for (const id of scope.worktreeIds) {
      worktreeIds.add(id);
    }
    for (const id of scope.sessionIds) {
      sessionIds.add(id);
    }
    scopes.push({
      repositoryId: scope.repositoryId,
      wholeRepository: scope.kind === "repository",
      worktreeIds: scope.worktreeIds,
      sessionIds: scope.sessionIds,
    });
  }

  return { revision: summary.revision, worktreeIds, sessionIds, scopes };
}

type DeletionView = { forgetWorkspaces(deletion: SelectionDeletion): void };
type CleanupAcknowledgement = { acknowledgeCleanup(revision: number): void };

/**
 * Applies explicit workspace deletions to one attached UI.
 *
 * Order: scrub every in-memory copy (view, selection, UI state) and switch selection while
 * persistence is suspended, then acknowledge the cleanup revision, then persist once. Saves
 * requested earlier keep their own captured acknowledgement, so they are still scrubbed by
 * the store. Session IDs of every receipt stay deleted permanently, so late draft callbacks
 * and detach saves cannot write them back after their worktree path is recreated.
 */
export class WorkspaceDeletions {
  private acknowledged: number;
  private readonly deleted = new Set<string>();
  private applying = false;

  constructor(
    private readonly state: UiState,
    private readonly store: CleanupAcknowledgement | undefined,
    // Cleanup revision already reflected by `state`, from `UiStateStore.load`.
    acknowledged: number,
  ) {
    this.acknowledged = acknowledged;
  }

  /** True while a deletion batch is applied; persistence and activation must wait. */
  get suspended(): boolean {
    return this.applying;
  }

  isDeleted(sessionId: string): boolean {
    return this.deleted.has(sessionId);
  }

  /** Copy of `record` without entries keyed by deleted session IDs. */
  withoutDeleted<T>(record: Readonly<Record<string, T>>): Record<string, T> {
    return Object.fromEntries(Object.entries(record).filter(([id]) => !this.deleted.has(id)));
  }

  /**
   * Scrubs the loaded state before anything is mounted. Returns whether the selected worktree
   * was deleted, so the caller can choose the initial view. Worktree keys belong to the owner
   * recorded in the state, else to their repository in the current `repositories`.
   */
  prepare(
    summary: DeletedScopes | undefined,
    repositories: readonly Repository[] = [],
    // The store already cleared the selected worktree in a cleanup scrub (`selectionDeleted`).
    selectionCleared = false,
  ): boolean {
    this.remember(summary);

    const requested = pendingDeletion(summary, this.acknowledged);
    if (!requested) {
      return selectionCleared;
    }

    const current = worktreeOwners(repositories);
    const deletion = this.expand(
      requested,
      [],
      recordedOwner(this.state, (id) => current.get(id)),
    );
    const selected = this.state.preferences.selection.worktreeId;
    this.scrub(deletion);
    this.acknowledge(deletion.revision);

    return selectionCleared || (selected !== null && deletion.worktreeIds.has(selected));
  }

  /**
   * Applies a new snapshot. Returns false without side effects when it publishes no deletion
   * newer than the acknowledged revision; the caller then refreshes selection normally.
   */
  apply(
    summary: DeletedScopes | undefined,
    repositories: readonly Repository[],
    parts: { selection: WorkspaceSelection; view?: DeletionView; persist: () => void },
  ): boolean {
    this.remember(summary);

    const requested = pendingDeletion(summary, this.acknowledged);
    if (!requested) {
      return false;
    }

    // Memory reflects the displayed catalog, so its owner wins over the recorded and the next one.
    const displayed = worktreeOwners(parts.selection.snapshot);
    const next = worktreeOwners(repositories);
    const recorded = recordedOwner(this.state, (id) => next.get(id));
    const deletion = this.expand(
      requested,
      parts.selection.snapshot,
      (id) => displayed.get(id) ?? recorded(id),
    );
    this.applying = true;
    try {
      parts.view?.forgetWorkspaces(deletion);
      parts.selection.forget(deletion);
      this.scrub(deletion);
      parts.selection.replaceSnapshot(repositories, this.state.preferences.selection.sessions);
    } finally {
      this.applying = false;
    }

    this.acknowledge(deletion.revision);
    parts.persist();

    return true;
  }

  private remember(summary: DeletedScopes | undefined): void {
    for (const scope of summary?.scopes ?? []) {
      for (const id of scope.sessionIds) {
        this.deleted.add(id);
      }
    }
  }

  /**
   * Keeps only worktrees the receipts' repositories own, then adds sessions recorded or displayed
   * under them: those belong to the deleted generation. A worktree whose owner is unknown is kept
   * unless this state links it to a deleted session; receipt session IDs are always deleted.
   */
  private expand(
    deletion: DeletionBatch,
    displayed: readonly Repository[],
    owner: (worktreeId: string) => string | undefined,
  ): DeletionBatch {
    const { worktreeIds } = resolveUiScrub(this.state, deletion.scopes, owner);
    const sessionIds = new Set(deletion.sessionIds);
    for (const [id, scope] of Object.entries(this.state.sessionScopes ?? {})) {
      if (worktreeIds.has(scope)) sessionIds.add(id);
    }
    for (const tree of displayed.flatMap((repo) => repo.worktrees)) {
      if (worktreeIds.has(tree.id)) {
        for (const session of tree.sessions) sessionIds.add(session.id);
      }
    }
    for (const id of sessionIds) {
      this.deleted.add(id);
    }

    return { ...deletion, worktreeIds, sessionIds };
  }

  private scrub(deletion: DeletionBatch): void {
    const scrubbed = scrubUiState(this.state, {
      worktreeIds: new Set(deletion.worktreeIds),
      sessionIds: new Set(deletion.sessionIds),
    });
    // UI callbacks hold the preferences object, so it is updated in place.
    Object.assign(this.state.preferences, scrubbed.preferences);
    if (scrubbed.sessionScopes) {
      this.state.sessionScopes = scrubbed.sessionScopes;
    }
  }

  private acknowledge(revision: number): void {
    this.acknowledged = Math.max(this.acknowledged, revision);
    this.store?.acknowledgeCleanup(revision);
  }
}

/**
 * The view to mount. A Code view whose selected workspace was deleted reopens on the existing
 * CHAT view when no workspace remains; with survivors the selection falls back to one of them and
 * the Code view stays. Cold or unavailable workspaces never report a deleted selection.
 */
export function initialView(
  view: UiState["view"],
  selectionDeleted: boolean,
  repositories: readonly Repository[],
): UiState["view"] {
  const workspaces = repositories.some((repo) => repo.worktrees.length);

  return selectionDeleted && !workspaces ? "chat" : view;
}

/** Worktree ID to repository ID of a catalog. */
export function worktreeOwners(repositories: readonly Repository[]): Map<string, string> {
  return new Map(
    repositories.flatMap((repo) => repo.worktrees.map((tree) => [tree.id, repo.id] as const)),
  );
}

/**
 * Owners of the worktree keys `state` references: the displayed repository, else the owner
 * recorded earlier (a cold or unavailable row is not a change of owner). Keys still unknown stay
 * unrecorded rather than guessed.
 */
export function recordWorktreeOwners(
  state: UiState,
  displayed: readonly Repository[],
): Record<string, string> {
  const current = worktreeOwners(displayed);
  const owner = recordedOwner(state, () => undefined);
  const recorded: Record<string, string> = {};
  for (const id of referencedWorktrees(state)) {
    const known = current.get(id) ?? owner(id);
    if (known !== undefined) recorded[id] = known;
  }

  return recorded;
}

type UiStateWriter = { save(state: UiState): Promise<Result<void, ExpectedError>> };

/**
 * Writes one UI's state, skipping unchanged snapshots. Each save is handed to the store
 * immediately: the store captures its cleanup acknowledgement at call time and serializes
 * writes itself. Queueing the call behind earlier saves would let an old snapshot pick up an
 * acknowledgement made later and skip the scrub it still needs.
 */
export class UiStatePersistence {
  private last = "";
  private latest: Promise<Result<void, ExpectedError>> = Promise.resolve(ok(undefined));

  constructor(
    private readonly store: UiStateWriter | undefined,
    private readonly observe: (saved: Promise<Result<void, ExpectedError>>) => void,
  ) {}

  save(state: UiState): void {
    const key = JSON.stringify(state);
    if (!this.store || key === this.last) {
      return;
    }

    this.last = key;
    this.latest = this.store.save(state);
    this.observe(this.latest);
  }

  /** Settles after the latest requested save, which the store writes after all earlier ones. */
  get settled(): Promise<Result<void, ExpectedError>> {
    return this.latest;
  }
}
