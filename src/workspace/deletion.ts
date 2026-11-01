import { statSync } from "node:fs";
import { dirname } from "node:path";
import { InputError, knownError, StorageError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import {
  createDirectoryMonitor,
  pathIdentity,
  sameIdentity,
  type DirectoryIdentity,
  type DirectoryMonitor,
  type EvidenceSource,
  type HeldDirectory,
  REPLACED_DURING_REGISTRATION,
} from "./deletion-native.ts";
import { isMissingPath, readMainWorktree, type MainWorktree } from "./discovery.ts";
import type { Repository } from "./model.ts";

export type { DirectoryIdentity, EvidenceSource } from "./deletion-native.ts";

/** A directory whose exact inode the kernel reported as unlinked. */
export type DeletedDirectory = {
  readonly role: "common" | "main" | "worktree";
  readonly path: string;
  readonly identity: DirectoryIdentity;
};

/** A worktree scope covered by a receipt; `identity` is null when it could not be held. */
export type DeletedScope = {
  readonly worktreeId: string;
  readonly path: string;
  readonly identity: DirectoryIdentity | null;
};

/**
 * Positive, persisted-safe proof that a scope was deleted (not renamed, moved, excluded,
 * unmounted or merely inaccessible). Plain JSON so callers can persist it before cleanup and
 * resume after restart. `identity` values bind the receipt to the deleted generation: a new
 * directory recreated at the same path has a different identity and must not be cleaned.
 */
export type DeletionReceipt = {
  readonly version: 1;
  readonly id: string;
  readonly kind: "worktree" | "repository";
  readonly repositoryId: string;
  readonly evidence: EvidenceSource;
  readonly directories: readonly DeletedDirectory[];
  // `worktree`: exactly the deleted scope. `repository`: every associated scope.
  readonly scopes: readonly DeletedScope[];
};

export type DeletionTrackerOptions = {
  readonly monitor?: { monitor: DirectoryMonitor; source: EvidenceSource | null };
  readonly readMain?: typeof readMainWorktree;
};

type TrackedScope = { path: string; held: HeldDirectory | null; deleted: boolean };

type TrackedRepository = {
  readonly repositoryId: string;
  layoutKey: string;
  main: MainWorktree | null;
  common: HeldDirectory | null;
  // Main checkout already proven deleted while its external common directory survived.
  deletedMain: DeletedDirectory | null;
  readonly scopes: Map<string, TrackedScope>;
};

type PathState = "gone" | "present" | "uncertain";

function key(identity: DirectoryIdentity): string {
  return `${identity.device}:${identity.inode}:${identity.birth}`;
}

function cleanUnlink(held: HeldDirectory | null): held is HeldDirectory {
  if (!held) {
    return false;
  }

  const signals = held.signals();

  // A rename, revocation (unmount) or registration failure makes later unlinks ambiguous.
  return signals.unlinked && !signals.renamed && !signals.revoked && !signals.failed;
}

function isReplaced(error: ExpectedError): boolean {
  return error instanceof StorageError && error.systemCode === REPLACED_DURING_REGISTRATION;
}

function expected(error: unknown): ExpectedError {
  const known = knownError(error);
  if (known) {
    return known;
  }

  throw error;
}

/**
 * Confirms that the old path no longer leads to the held inode and that the nearest existing
 * ancestor is accessible. Permission/I/O failures keep the evidence pending, never confirmed.
 */
function pathState(path: string, identity: DirectoryIdentity): PathState {
  const current = pathIdentity(path);
  if (current.ok) {
    return sameIdentity(current.value, identity) ? "present" : "gone";
  }
  if (!isMissingPath(current.error)) {
    return "uncertain";
  }

  let ancestor = dirname(path);
  while (true) {
    try {
      statSync(ancestor);

      return "gone";
    } catch (error) {
      if (!isMissingPath(expected(error))) {
        return "uncertain";
      }
    }

    const parent = dirname(ancestor);
    if (parent === ancestor) {
      return "uncertain";
    }

    ancestor = parent;
  }
}

/**
 * Tracks held directory descriptors for repository scopes and turns kernel unlink reports into
 * deletion receipts. It never polls: callers drain it from existing invalidations (`collect`)
 * and when the catalog changes (`track`). Receipts stay pending until acknowledged, typically
 * after the caller has persisted them, and survive disposal through `close()`'s return value.
 */
export class DeletionTracker {
  private readonly repositories = new Map<string, TrackedRepository>();
  private readonly pending = new Map<string, DeletionReceipt>();
  private readonly listeners = new Set<(receipt: DeletionReceipt) => void>();
  private native: { monitor: DirectoryMonitor; source: EvidenceSource | null } | undefined;
  private failure: ExpectedError | null = null;
  private closed = false;

  constructor(private readonly options: DeletionTrackerOptions = {}) {}

  private monitor(): { monitor: DirectoryMonitor; source: EvidenceSource | null } {
    this.native ??= this.options.monitor ?? createDirectoryMonitor();

    return this.native;
  }

  /** The most recent capability, registration or drain failure; never evidence of deletion. */
  lastError(): ExpectedError | null {
    return this.failure;
  }

  /** Unacknowledged receipts, oldest first. */
  receipts(): readonly DeletionReceipt[] {
    return [...this.pending.values()];
  }

  /** Drops a receipt after the caller has durably recorded or completed it. */
  acknowledge(id: string): boolean {
    return this.pending.delete(id);
  }

  onReceipt(listener: (receipt: DeletionReceipt) => void): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Identity of the directory currently held for a scope, to tag the live scope generation. */
  scopeIdentity(repositoryId: string, worktreeId: string): DirectoryIdentity | null {
    const scope = this.repositories.get(repositoryId)?.scopes.get(worktreeId);

    return scope && !scope.deleted && scope.held ? scope.held.identity : null;
  }

  /**
   * Holds the common directory and every present checkout of an available repository.
   * Pending kernel reports are drained first, so replacing a same-path directory never
   * discards proof about the previous one.
   */
  async track(repository: Repository): Promise<Result<void, ExpectedError>> {
    if (this.closed) {
      return ok(undefined);
    }

    this.collect();

    const layoutKey = JSON.stringify([
      repository.id,
      repository.worktrees.map((tree) => tree.path),
    ]);
    const existing = this.repositories.get(repository.id);
    let main = existing?.main ?? null;
    if (!existing || existing.layoutKey !== layoutKey) {
      const read = await (this.options.readMain ?? readMainWorktree)(repository.id);
      if (this.closed) {
        return ok(undefined);
      }
      if (!read.ok) {
        return this.fail(read.error);
      }

      main = read.value;
    }

    const tracked: TrackedRepository = existing ?? {
      repositoryId: repository.id,
      layoutKey,
      main,
      common: null,
      deletedMain: null,
      scopes: new Map(),
    };
    tracked.layoutKey = layoutKey;
    tracked.main = main;
    this.repositories.set(repository.id, tracked);

    let failure: ExpectedError | null = null;
    const hold = (path: string, held: HeldDirectory | null): HeldDirectory | null => {
      const current = pathIdentity(path);
      // Captured unlink proof that is not confirmed yet (an inaccessible ancestor, or a removed
      // `.git` whose checkout survives) is kept until classified. Scope proofs whose path shows
      // a newer generation already became receipts in the drain above; a common directory
      // recreated at the same path after `.git`-only loss is a new generation, not deletion.
      if (cleanUnlink(held) && (!current.ok || pathState(path, held.identity) === "uncertain")) {
        return held;
      }

      if (held && current.ok && sameIdentity(held.identity, current.value)) {
        const signals = held.signals();
        if (!signals.renamed && !signals.revoked && !signals.failed && !signals.unlinked) {
          return held;
        }
      }

      // The previous inode was renamed away, revoked or replaced; its proof was drained above.
      held?.release();
      if (!current.ok) {
        // Removed after discovery: the next invalidation reclassifies it. Other failures surface.
        if (!isMissingPath(current.error)) {
          failure ??= current.error;
        }

        return null;
      }

      const next = this.monitor().monitor.hold(path);
      if (!next.ok) {
        // A path removed or replaced during registration is retried on the next invalidation.
        if (!isMissingPath(next.error) && !isReplaced(next.error)) {
          failure ??= next.error;
        }

        return null;
      }

      return next.value;
    };

    tracked.common = hold(repository.id, tracked.common);
    const present = new Set(repository.worktrees.map((tree) => tree.id));
    for (const [worktreeId, scope] of tracked.scopes) {
      if (!present.has(worktreeId)) {
        scope.held?.release();
        tracked.scopes.delete(worktreeId);
      }
    }
    for (const tree of repository.worktrees) {
      const scope = tracked.scopes.get(tree.id);
      if (scope && !scope.deleted && scope.path === tree.path) {
        scope.held = hold(tree.path, scope.held);
      } else {
        scope?.held?.release();
        tracked.scopes.set(tree.id, {
          path: tree.path,
          held: hold(tree.path, null),
          deleted: false,
        });
      }
    }
    const deletedMain = tracked.deletedMain;
    if (
      deletedMain &&
      [...tracked.scopes.values()].some(
        (scope) => !scope.deleted && scope.path === deletedMain.path,
      )
    ) {
      // The main checkout reappeared as a new generation; its old proof is already a receipt.
      tracked.deletedMain = null;
    }

    return failure ? this.fail(failure) : ok(undefined);
  }

  /** Stops tracking a repository without producing evidence. */
  untrack(repositoryId: string): void {
    const tracked = this.repositories.get(repositoryId);
    if (!tracked) {
      return;
    }

    this.release(tracked);
    this.repositories.delete(repositoryId);
  }

  /**
   * Non-blocking drain of queued kernel reports. Returns receipts newly confirmed by this
   * call; earlier unacknowledged ones remain available from `receipts()`.
   */
  collect(): Result<readonly DeletionReceipt[], ExpectedError> {
    if (this.closed || !this.native) {
      return ok([]);
    }

    const drained = this.native.monitor.collect();
    const source = this.native.source;
    const confirmed: DeletionReceipt[] = [];
    if (source) {
      for (const tracked of this.repositories.values()) {
        confirmed.push(...this.classify(tracked, source));
      }
    }
    for (const receipt of confirmed) {
      this.pending.set(receipt.id, receipt);
    }
    for (const receipt of confirmed) {
      for (const listener of this.listeners) {
        listener(receipt);
      }
    }

    return drained.ok ? ok(confirmed) : this.fail(drained.error);
  }

  private classify(tracked: TrackedRepository, evidence: EvidenceSource): DeletionReceipt[] {
    this.rearmRestored(tracked);

    const commonDeleted = this.proven(tracked.common, "common");
    const main = tracked.main;
    // Only bare repositories have no root other than the common directory. A non-bare main
    // entry naming the common directory (for example `--separate-git-dir`) hides the real
    // checkout, so its loss is never treated as whole-repository or checkout deletion.
    const rootIsCommon = !!main?.bare;
    const mainScope =
      main && !main.bare && main.path !== tracked.repositoryId
        ? [...tracked.scopes.values()].find((scope) => scope.path === main.path)
        : undefined;
    const mainDeleted = tracked.deletedMain ?? this.proven(mainScope?.held ?? null, "main");
    // `.git` loss alone is corruption; a checkout alone with a surviving common directory is
    // that worktree's deletion. The repository is gone only when its root is gone too.
    if (commonDeleted && (rootIsCommon || mainDeleted)) {
      const directories = [commonDeleted, ...(rootIsCommon || !mainDeleted ? [] : [mainDeleted])];
      const scopes: DeletedScope[] = [...tracked.scopes].map(([worktreeId, scope]) => ({
        worktreeId,
        path: scope.path,
        identity: scope.held?.identity ?? null,
      }));
      if (mainDeleted && !scopes.some((scope) => scope.path === mainDeleted.path)) {
        // Already reported separately, but listed so repository cleanup covers every scope.
        scopes.push({
          worktreeId: mainDeleted.path,
          path: mainDeleted.path,
          identity: mainDeleted.identity,
        });
      }
      this.release(tracked);
      this.repositories.delete(tracked.repositoryId);

      return [this.receipt("repository", tracked.repositoryId, evidence, directories, scopes)];
    }

    const receipts: DeletionReceipt[] = [];
    for (const [worktreeId, scope] of tracked.scopes) {
      if (scope.deleted || scope.path === tracked.repositoryId) {
        continue;
      }

      const isMain = scope === mainScope;
      const proven = this.proven(scope.held, isMain ? "main" : "worktree");
      if (!proven) {
        continue;
      }

      scope.deleted = true;
      if (isMain) {
        tracked.deletedMain = proven;
      }

      receipts.push(
        this.receipt(
          "worktree",
          tracked.repositoryId,
          evidence,
          [proven],
          [{ worktreeId, path: scope.path, identity: proven.identity }],
        ),
      );
    }

    return receipts;
  }

  private proven(
    held: HeldDirectory | null,
    role: DeletedDirectory["role"],
  ): DeletedDirectory | null {
    if (!cleanUnlink(held) || pathState(held.path, held.identity) !== "gone") {
      return null;
    }

    return { role, path: held.path, identity: held.identity };
  }

  // A directory renamed and then moved back is the same live scope again; re-arm its watch so
  // the sticky rename flag does not hide a later real deletion.
  private rearmRestored(tracked: TrackedRepository): void {
    const rearm = (held: HeldDirectory | null): HeldDirectory | null => {
      if (!held) {
        return held;
      }

      const signals = held.signals();
      if (!signals.renamed || signals.unlinked || signals.revoked || signals.failed) {
        return held;
      }
      if (pathState(held.path, held.identity) !== "present") {
        return held;
      }

      const next = this.native!.monitor.hold(held.path);
      if (!next.ok || !sameIdentity(next.value.identity, held.identity)) {
        if (next.ok) {
          next.value.release();
        }

        return held;
      }

      held.release();

      return next.value;
    };

    tracked.common = rearm(tracked.common);
    for (const scope of tracked.scopes.values()) {
      if (!scope.deleted) {
        scope.held = rearm(scope.held);
      }
    }
  }

  private receipt(
    kind: DeletionReceipt["kind"],
    repositoryId: string,
    evidence: EvidenceSource,
    directories: DeletedDirectory[],
    scopes: DeletedScope[],
  ): DeletionReceipt {
    const id = [
      kind,
      repositoryId,
      ...directories.map((directory) => key(directory.identity)),
    ].join("\0");

    return { version: 1, id, kind, repositoryId, evidence, directories, scopes };
  }

  private release(tracked: TrackedRepository): void {
    tracked.common?.release();
    tracked.common = null;
    for (const scope of tracked.scopes.values()) {
      scope.held?.release();
      scope.held = null;
    }
  }

  private fail(error: ExpectedError): Result<never, ExpectedError> {
    this.failure = error;

    return err(error);
  }

  /** Releases every descriptor and returns receipts that were never acknowledged. */
  close(): readonly DeletionReceipt[] {
    if (!this.closed) {
      this.closed = true;
      for (const tracked of this.repositories.values()) {
        this.release(tracked);
      }

      this.repositories.clear();
      this.native?.monitor.close();
      this.listeners.clear();
    }

    return this.receipts();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIdentity(value: unknown): DirectoryIdentity | null | undefined {
  if (value === null) {
    return null;
  }
  if (
    isRecord(value) &&
    typeof value.device === "string" &&
    typeof value.inode === "string" &&
    typeof value.birth === "string"
  ) {
    return { device: value.device, inode: value.inode, birth: value.birth };
  }

  return undefined;
}

/** Validates a persisted receipt; anything malformed is rejected, never treated as proof. */
export function parseDeletionReceipt(value: unknown): Result<DeletionReceipt, InputError> {
  const invalid = err(new InputError("Invalid workspace deletion receipt."));
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    (value.kind !== "worktree" && value.kind !== "repository") ||
    typeof value.repositoryId !== "string" ||
    (value.evidence !== "darwin-kqueue-note-delete" &&
      value.evidence !== "linux-unlinked-descriptor") ||
    !Array.isArray(value.directories) ||
    !Array.isArray(value.scopes)
  ) {
    return invalid;
  }

  const directories: DeletedDirectory[] = [];
  for (const item of value.directories) {
    const identity = isRecord(item) ? parseIdentity(item.identity) : undefined;
    if (
      !isRecord(item) ||
      (item.role !== "common" && item.role !== "main" && item.role !== "worktree") ||
      typeof item.path !== "string" ||
      !identity
    ) {
      return invalid;
    }

    directories.push({ role: item.role, path: item.path, identity });
  }

  const scopes: DeletedScope[] = [];
  for (const item of value.scopes) {
    const identity = isRecord(item) ? parseIdentity(item.identity) : undefined;
    if (
      !isRecord(item) ||
      typeof item.worktreeId !== "string" ||
      typeof item.path !== "string" ||
      identity === undefined
    ) {
      return invalid;
    }

    scopes.push({ worktreeId: item.worktreeId, path: item.path, identity });
  }
  if (!directories.length || (value.kind === "worktree" && scopes.length !== 1)) {
    return invalid;
  }

  return ok({
    version: 1,
    id: value.id,
    kind: value.kind,
    repositoryId: value.repositoryId,
    evidence: value.evidence,
    directories,
    scopes,
  });
}
