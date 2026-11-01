import { createHash } from "node:crypto";
import { InputError, type ErrorCode, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { SessionDeletionCandidate } from "../agents/session-registry.ts";
import { purgeUiState } from "../app/ui-state.ts";
import type {
  CleanupKind,
  CleanupLedger,
  CleanupReceipt,
  DaemonRegistry,
  ScopeWorktree,
} from "./daemon-protocol.ts";
import type { DeletedScopes } from "./protocol.ts";
import {
  readCleanupLedger,
  withCleanupLock,
  writeCleanupLedger,
  type RestoreStateStore,
} from "./restore-state.ts";
import {
  appendRuntimeCleanupCandidates,
  daemonPaths,
  fenceRuntimeScope,
  fenceRuntimeWrites,
  inspectRuntimeCleanup,
  purgeRuntimeScope,
  reopenRuntimeScope,
  runtimePaths,
  type RuntimeCleanupReport,
  type RuntimeCleanupStatus,
  type RuntimePaths,
} from "./storage.ts";

export type CleanupScope = {
  readonly repositoryId: string;
  readonly kind: CleanupKind;
  readonly worktrees: readonly ScopeWorktree[];
  readonly sessionIds?: readonly string[];
};

export type CleanupItem = { path: string; reason: string; code?: ErrorCode };

export type CleanupReport = {
  token: string;
  // True only when runtime, registry and UI state are all verified clean.
  complete: boolean;
  receipt: CleanupReceipt;
  removed: string[];
  // UI files rewritten without the deleted scope.
  rewritten: string[];
  preserved: CleanupItem[];
  residuals: CleanupItem[];
  // The sanitized registry for the daemon to adopt; null when no registry file exists.
  registry?: DaemonRegistry | null;
};

/** Per-repository runtime purge operations (implemented by `storage.ts`). */
export type RuntimeScopeCleanup = {
  fenceRuntimeWrites: typeof fenceRuntimeWrites;
  fenceRuntimeScope: typeof fenceRuntimeScope;
  appendRuntimeCleanupCandidates: typeof appendRuntimeCleanupCandidates;
  purgeRuntimeScope: typeof purgeRuntimeScope;
  reopenRuntimeScope: typeof reopenRuntimeScope;
  inspectRuntimeCleanup: typeof inspectRuntimeCleanup;
};

const storageCleanup: RuntimeScopeCleanup = {
  fenceRuntimeWrites,
  fenceRuntimeScope,
  appendRuntimeCleanupCandidates,
  purgeRuntimeScope,
  reopenRuntimeScope,
  inspectRuntimeCleanup,
};

const tokenPattern = /^[A-Za-z0-9-]{8,128}$/;
const maxReceipts = 1024;

/**
 * A deterministic receipt token for positive deletion evidence, so a retry after a crash or a
 * repeated notification of the same proof reuses one receipt instead of creating another.
 */
export function cleanupToken(evidenceId: string): string {
  return createHash("sha256").update(evidenceId).digest("hex");
}

/**
 * Coordinates confirmed workspace deletion across runtime, registry and UI state.
 *
 * Lock order: the daemon cleanup lock is held only for short master-ledger transactions and
 * is never held while a repository `state.lock` is acquired. Phases are ordered by the durable
 * ledger state instead, and one in-process queue serializes this coordinator's operations.
 */
export class WorkspaceCleanup {
  private readonly offline: boolean;
  private readonly stateRoot: string | undefined;
  private readonly registry: RestoreStateStore;
  private readonly runtime: RuntimeScopeCleanup;
  private readonly now: () => number;
  private readonly daemonDirectory: string;
  private queue: Promise<unknown> = Promise.resolve();
  private ledger: CleanupLedger | undefined;

  constructor(options: {
    offline: boolean;
    stateRoot?: string;
    registry: RestoreStateStore;
    runtime?: RuntimeScopeCleanup;
    now?: () => number;
  }) {
    this.offline = options.offline;
    this.stateRoot = options.stateRoot;
    this.registry = options.registry;
    this.runtime = options.runtime ?? storageCleanup;
    this.now = options.now ?? Date.now;
    this.daemonDirectory = daemonPaths(this.offline, this.stateRoot).directory;
  }

  /**
   * Blocks the scope in this process synchronously, then records a durable receipt.
   * `stableToken` (see `cleanupToken`) makes a repeated fence of the same evidence idempotent.
   */
  fence(
    scope: CleanupScope,
    stableToken?: string,
  ): { token: string; durable: Promise<Result<CleanupReceipt, ExpectedError>> } {
    const token = stableToken ?? crypto.randomUUID();
    const invalid = validateScope(scope, token);
    if (invalid) {
      return { token, durable: Promise.resolve(err(invalid)) };
    }

    const paths = this.paths(scope.repositoryId);
    this.runtime.fenceRuntimeWrites(paths, {
      token,
      kind: scope.kind,
      worktreeIds: scope.worktrees.map((tree) => tree.id),
    });
    this.registry.exclude({
      token,
      repositoryId: scope.repositoryId,
      kind: scope.kind,
      worktreePaths: scope.worktrees.map((tree) => tree.path),
    });

    return { token, durable: this.serialize(() => this.recordFence(scope, token, paths)) };
  }

  /**
   * Removes the scope's owned state after its writers stopped. Any residual or failed phase
   * leaves the receipt `fenced` and the report incomplete; retrying the same token is safe.
   */
  purge(
    token: string,
    input: { writersStopped: true; candidates?: readonly SessionDeletionCandidate[] },
  ): Promise<Result<CleanupReport, ExpectedError>> {
    if (input.writersStopped !== true) {
      return Promise.resolve(err(new InputError("Stop scoped writers before purging state.")));
    }

    return this.serialize(() => this.purgeNow(token, input.candidates ?? []));
  }

  /** Lets a fresh generation use a purged identity again. Old receipts keep fencing old data. */
  reopen(token: string): Promise<Result<CleanupReceipt, ExpectedError>> {
    return this.serialize(async () => {
      const current = await this.load();
      if (!current.ok) return current;

      const receipt = current.value.receipts.find((entry) => entry.token === token);
      if (!receipt) return err(new InputError("Unknown workspace cleanup receipt."));
      if (receipt.state === "fenced") {
        return err(new InputError("A workspace scope can be reopened only after its purge."));
      }
      if (receipt.state === "purged") {
        const reopened = await this.runtime.reopenRuntimeScope(
          this.paths(receipt.repositoryId),
          receipt.repositoryId,
          token,
        );
        if (!reopened.ok) return reopened;
      }

      const updated = await this.update(token, (entry, revision) =>
        entry.state === "reopened"
          ? entry
          : { ...entry, state: "reopened", revision, updatedAt: this.now() },
      );
      if (updated.ok) this.registry.release(token);

      return updated;
    });
  }

  /**
   * Restores fences of confirmed receipts at startup, before any resource restoration.
   * Returns receipts whose purge is still pending. Absent paths never create receipts here.
   */
  resume(): Promise<Result<readonly CleanupReceipt[], ExpectedError>> {
    return this.serialize(async () => {
      const current = await this.load();
      if (!current.ok) return current;

      const active = current.value.receipts.filter((receipt) => receipt.state !== "reopened");
      for (const receipt of active) {
        this.runtime.fenceRuntimeWrites(this.paths(receipt.repositoryId), {
          token: receipt.token,
          kind: receipt.kind,
          worktreeIds: receipt.worktrees.map((tree) => tree.id),
        });
        if (receipt.state === "fenced") {
          this.registry.exclude({
            token: receipt.token,
            repositoryId: receipt.repositoryId,
            kind: receipt.kind,
            worktreePaths: receipt.worktrees.map((tree) => tree.path),
          });
        }
      }

      // Re-register storage fences and finish a durable fence interrupted before storage saw it.
      for (const repositoryId of new Set(active.map((receipt) => receipt.repositoryId))) {
        const paths = this.paths(repositoryId);
        const inspected = await this.runtime.inspectRuntimeCleanup(paths, repositoryId);
        if (!inspected.ok) return inspected;

        const known = new Set(inspected.value.map((status) => status.token));
        for (const receipt of active) {
          if (receipt.repositoryId !== repositoryId || known.has(receipt.token)) continue;
          if (receipt.state !== "fenced") continue;
          const fenced = await this.runtime.fenceRuntimeScope(paths, repositoryId, receipt);
          if (!fenced.ok) return fenced;
        }
      }

      return ok(active.filter((receipt) => receipt.state === "fenced"));
    });
  }

  /** The last ledger view this coordinator read or wrote, for the runtime snapshot. */
  deletedScopes(): DeletedScopes | undefined {
    const ledger = this.ledger;
    if (!ledger) return undefined;

    return {
      revision: ledger.revision,
      scopes: ledger.receipts.map((receipt) => ({
        token: receipt.token,
        repositoryId: receipt.repositoryId,
        kind: receipt.kind,
        worktreeIds: receipt.worktrees.map((tree) => tree.id),
        sessionIds: [...receipt.sessionIds],
        revision: receipt.revision,
        state:
          receipt.state === "fenced"
            ? "pending"
            : receipt.state === "purged"
              ? "complete"
              : "reopened",
      })),
    };
  }

  private paths(repositoryId: string): RuntimePaths {
    return runtimePaths(repositoryId, this.offline, this.stateRoot);
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);

    return next;
  }

  private async load(): Promise<Result<CleanupLedger, ExpectedError>> {
    const ledger = await readCleanupLedger(this.daemonDirectory);
    if (ledger.ok) this.ledger = ledger.value;

    return ledger;
  }

  private async recordFence(
    scope: CleanupScope,
    token: string,
    paths: RuntimePaths,
  ): Promise<Result<CleanupReceipt, ExpectedError>> {
    const recorded = await withCleanupLock(this.daemonDirectory, async () => {
      const ledger = await readCleanupLedger(this.daemonDirectory);
      if (!ledger.ok) return ledger;

      const existing = ledger.value.receipts.find((entry) => entry.token === token);
      if (existing) {
        this.ledger = ledger.value;
        return sameScope(existing, scope)
          ? ok(existing)
          : err(new InputError("Cleanup token is already used for a different scope."));
      }

      const revision = ledger.value.revision + 1;
      const receipt: CleanupReceipt = {
        token,
        repositoryId: scope.repositoryId,
        kind: scope.kind,
        worktrees: scope.worktrees.map((tree) => ({ id: tree.id, path: tree.path })),
        sessionIds: [...new Set(scope.sessionIds ?? [])],
        revision,
        state: "fenced",
        updatedAt: this.now(),
      };
      const receipts = boundedReceipts([...ledger.value.receipts, receipt]);
      if (!receipts) {
        return err(new InputError("Too many unfinished workspace cleanups are pending."));
      }

      return this.write({ version: 1, revision, receipts }, receipt);
    });
    if (!recorded.ok) return recorded;

    const receipt = recorded.value;
    if (receipt.state === "reopened") {
      // The old evidence was already handled and a fresh generation may now use the scope.
      // Reopening again is idempotent and lifts the in-process fence `fence()` just added.
      const reopened = await this.runtime.reopenRuntimeScope(paths, receipt.repositoryId, token);
      if (!reopened.ok) return reopened;
      this.registry.release(token);
      return ok(receipt);
    }

    const fenced = await this.runtime.fenceRuntimeScope(paths, receipt.repositoryId, receipt);
    if (!fenced.ok) return fenced;

    // Closed sessions known only to runtime indexes become deleted for UIs immediately, with a
    // new revision so clients that already acknowledged the fence scrub them too.
    return this.addSessions(
      token,
      fenced.value.sessionIds.map((id) => ({ id })),
      fenced.value.worktrees,
    );
  }

  private async purgeNow(
    token: string,
    candidates: readonly SessionDeletionCandidate[],
  ): Promise<Result<CleanupReport, ExpectedError>> {
    // 1. Record candidate session identities so UI and late saves drop them permanently.
    const recorded = await this.addSessions(
      token,
      candidates.map((candidate) => ({
        worktreeId: candidate.worktreeId,
        id: candidate.sessionId,
      })),
    );
    if (!recorded.ok) return recorded;
    if (recorded.value.state === "reopened") {
      return err(new InputError("This workspace cleanup was reopened and cannot purge again."));
    }

    let receipt = recorded.value;
    const report: CleanupReport = {
      token,
      complete: false,
      receipt,
      removed: [],
      rewritten: [],
      preserved: [],
      residuals: [],
    };
    const paths = this.paths(receipt.repositoryId);

    // 2. Runtime files (repository state.lock; the cleanup lock is not held).
    const runtime = await this.purgeRuntime(paths, receipt, candidates);
    if (!runtime.ok) {
      report.residuals.push(item(paths.directory, runtime.error));
    } else {
      report.removed.push(...runtime.value.removed);
      report.preserved.push(...runtime.value.preserved);
      report.residuals.push(...runtime.value.residuals);
      if (!runtime.value.complete && !runtime.value.residuals.length) {
        report.residuals.push({ path: paths.directory, reason: "Runtime cleanup is incomplete." });
      }

      // Sessions found only in runtime files (index, legacy tabs) are deleted for UIs as well.
      const merged = await this.addSessions(
        token,
        runtime.value.sessionIds.map((id) => ({ id })),
        runtime.value.worktrees,
      );
      if (merged.ok) {
        receipt = merged.value;
        report.receipt = receipt;
      } else {
        report.residuals.push(item(this.daemonDirectory, merged.error));
      }
    }

    // 3. Registry and its v1 backup.
    const registry = await this.registry.purge(receipt);
    if (registry.ok) report.registry = registry.value;
    else report.residuals.push(item(this.daemonDirectory, registry.error));

    // 4. Every attached UI's persisted state.
    const ui = await purgeUiState(this.daemonDirectory);
    if (ui.ok) {
      report.rewritten.push(...ui.value.rewritten);
      report.removed.push(...ui.value.removed);
      report.residuals.push(...ui.value.residuals);
    } else {
      report.residuals.push(item(this.daemonDirectory, ui.error));
    }

    if (report.residuals.length) return ok(report);

    // 5. Only a fully verified purge completes the receipt.
    const completed = await this.update(token, (entry, revision) =>
      entry.state === "fenced"
        ? { ...entry, state: "purged", revision, updatedAt: this.now() }
        : entry,
    );
    if (!completed.ok) {
      report.residuals.push(item(this.daemonDirectory, completed.error));
      return ok(report);
    }

    return ok({ ...report, complete: true, receipt: completed.value });
  }

  private async purgeRuntime(
    paths: RuntimePaths,
    receipt: CleanupReceipt,
    candidates: readonly SessionDeletionCandidate[],
  ): Promise<Result<RuntimeCleanupReport, ExpectedError>> {
    const inspected = await this.runtime.inspectRuntimeCleanup(paths, receipt.repositoryId);
    if (!inspected.ok) return inspected;

    let status: RuntimeCleanupStatus | undefined = inspected.value.find(
      (entry) => entry.token === receipt.token,
    );
    if (!status) {
      const fenced = await this.runtime.fenceRuntimeScope(paths, receipt.repositoryId, receipt);
      if (!fenced.ok) return fenced;
      status = fenced.value;
    }
    if (status.state === "fenced" && candidates.length) {
      const appended = await this.runtime.appendRuntimeCleanupCandidates(
        paths,
        receipt.repositoryId,
        receipt.token,
        candidates,
      );
      if (!appended.ok) return appended;
    }

    return this.runtime.purgeRuntimeScope(paths, receipt.repositoryId, receipt.token, {
      writersStopped: true,
    });
  }

  private addSessions(
    token: string,
    sessions: readonly { id: string; worktreeId?: string }[],
    historicalWorktrees: readonly ScopeWorktree[] = [],
  ): Promise<Result<CleanupReceipt, ExpectedError>> {
    return this.update(token, (entry, revision) => {
      if (entry.state !== "fenced") return entry;
      const inScope = new Set(entry.worktrees.map((tree) => tree.id));
      const known = new Set(entry.sessionIds);
      const added = new Set(
        sessions
          .filter(
            (session) =>
              entry.kind === "repository" ||
              session.worktreeId === undefined ||
              inScope.has(session.worktreeId),
          )
          .map((session) => session.id)
          .filter((id) => !known.has(id)),
      );

      const worktrees = new Map(entry.worktrees.map((tree) => [tree.id, tree]));
      if (entry.kind === "repository") {
        for (const tree of historicalWorktrees) {
          if (!worktrees.has(tree.id)) worktrees.set(tree.id, { ...tree });
        }
      }

      return added.size || worktrees.size !== entry.worktrees.length
        ? {
            ...entry,
            worktrees: [...worktrees.values()],
            sessionIds: [...entry.sessionIds, ...added],
            revision,
            updatedAt: this.now(),
          }
        : entry;
    });
  }

  // One master-ledger transaction. `change` receives the next revision; returning the same
  // receipt object leaves the ledger unchanged.
  private update(
    token: string,
    change: (receipt: CleanupReceipt, revision: number) => CleanupReceipt,
  ): Promise<Result<CleanupReceipt, ExpectedError>> {
    return withCleanupLock(this.daemonDirectory, async () => {
      const ledger = await readCleanupLedger(this.daemonDirectory);
      if (!ledger.ok) return ledger;
      this.ledger = ledger.value;

      const receipt = ledger.value.receipts.find((entry) => entry.token === token);
      if (!receipt) return err(new InputError("Unknown workspace cleanup receipt."));

      const revision = ledger.value.revision + 1;
      const next = change(receipt, revision);
      if (next === receipt) return ok(receipt);

      return this.write(
        {
          version: 1,
          revision,
          receipts: ledger.value.receipts.map((entry) => (entry.token === token ? next : entry)),
        },
        next,
      );
    });
  }

  private async write(
    ledger: CleanupLedger,
    receipt: CleanupReceipt,
  ): Promise<Result<CleanupReceipt, ExpectedError>> {
    const written = await writeCleanupLedger(this.daemonDirectory, ledger);
    if (!written.ok) return written;
    this.ledger = ledger;

    return ok(receipt);
  }
}

function validateScope(scope: CleanupScope, token: string): InputError | undefined {
  if (!tokenPattern.test(token)) {
    return new InputError("Cleanup tokens contain 8-128 letters, digits or hyphens.");
  }
  if (scope.kind === "worktrees" && scope.worktrees.length === 0) {
    return new InputError("A worktree cleanup needs at least one worktree.");
  }
  const texts = [
    scope.repositoryId,
    ...scope.worktrees.flatMap((tree) => [tree.id, tree.path]),
    ...(scope.sessionIds ?? []),
  ];
  if (texts.some((text) => !text || text.includes("\0"))) {
    return new InputError("Cleanup scope identities must be non-empty and contain no NUL.");
  }
  if (scope.worktrees.some((tree) => !tree.path.startsWith("/"))) {
    return new InputError("Cleanup worktree paths must be absolute.");
  }

  return undefined;
}

function sameScope(receipt: CleanupReceipt, scope: CleanupScope): boolean {
  const trees = (list: readonly ScopeWorktree[]) =>
    JSON.stringify(list.map((tree) => `${tree.id}\0${tree.path}`).toSorted());

  return (
    receipt.repositoryId === scope.repositoryId &&
    receipt.kind === scope.kind &&
    (receipt.kind === "repository" || trees(receipt.worktrees) === trees(scope.worktrees))
  );
}

// Drops the oldest reopened receipts first. Unfinished and purged receipts are never dropped:
// they are the only authority that keeps deleted state out of late saves.
function boundedReceipts(receipts: CleanupReceipt[]): CleanupReceipt[] | undefined {
  const result = [...receipts];
  while (result.length > maxReceipts) {
    const index = result.findIndex((receipt) => receipt.state === "reopened");
    if (index < 0) return undefined;
    result.splice(index, 1);
  }

  return result;
}

const item = (path: string, error: ExpectedError): CleanupItem => ({
  path,
  reason: error.message,
  code: error.code,
});
