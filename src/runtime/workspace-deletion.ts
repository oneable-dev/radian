import { CleanupError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { SessionDeletionCandidate } from "../agents/session-registry.ts";
import type { DeletionReceipt } from "../workspace/deletion.ts";
import type { CleanupKind } from "./daemon-protocol.ts";
import { cleanupToken, type CleanupReport, type WorkspaceCleanup } from "./workspace-cleanup.ts";

/** A confirmed deletion scope that blocks new work until its cleanup has fully finished. */
export type BlockedScope = {
  readonly token: string;
  readonly repositoryId: string;
  readonly kind: CleanupKind;
  readonly worktreeIds: ReadonlySet<string>;
};

/** Scoped writers are stopped; `release` returns ownership reserved only for this purge. */
export type StoppedWriters = {
  readonly candidates: readonly SessionDeletionCandidate[];
  readonly release?: () => Promise<void>;
};

/**
 * Daemon-owned resource operations. `fence` must be synchronous: it runs while the tracker
 * drains kernel reports, before any later request can be admitted for the scope.
 */
export type DeletionHooks = {
  fence(scope: BlockedScope): void;
  // Drops tracker evidence after its receipt became durable.
  acknowledge(evidenceId: string): void;
  // Terminates scoped Agent/editor/terminal work and drains checkpoint, retention and plan
  // writers, or reserves repository ownership when no host exists. Never activates resources.
  stopWriters(scope: BlockedScope): Promise<Result<StoppedWriters, ExpectedError>>;
  // Adopts purge results that are valid even when the report is incomplete (registry).
  purged(scope: BlockedScope, report: CleanupReport): void;
  // The purged identity was reopened; scrub live memory, then release resource fences.
  reopened(scope: BlockedScope): Promise<Result<void, ExpectedError>>;
  // Defers remaining phases while the daemon stops; durable receipts resume at the next start.
  stopping(): boolean;
  serialize<T>(task: () => Promise<T>): Promise<T>;
  changed(): void;
};

type Phase = "durable" | "purge" | "reopen" | "release";

type Cleanup = {
  readonly scope: BlockedScope;
  // Only receipts from live evidence carry paths; resumed receipts are already in the ledger.
  readonly worktrees?: readonly { id: string; path: string }[];
  readonly evidence?: string;
  phase: Phase;
  running?: Promise<void> | undefined;
  error?: string;
  candidates?: readonly SessionDeletionCandidate[];
};

const describe = (error: ExpectedError) => `[${error.code}] ${error.message}`;

function residualSummary(report: CleanupReport): string {
  const first = report.residuals[0];
  if (!first) return "Cleanup did not complete.";

  const more = report.residuals.length > 1 ? ` (+${report.residuals.length - 1} more)` : "";

  return `${first.code ? `[${first.code}] ` : ""}${first.reason}: ${first.path}${more}`;
}

/**
 * Turns positive deletion evidence into a complete scope cleanup:
 * synchronous fence -> durable receipt -> stop scoped writers -> purge -> reopen -> release.
 *
 * A phase failure keeps the scope fenced and its error visible; `retry` (workspace refresh,
 * another receipt) or the next daemon start resumes the same token idempotently. Absence and
 * failures are never treated as deletion; only tracker receipts and durable ledger entries are.
 */
export class WorkspaceDeletion {
  private readonly cleanups = new Map<string, Cleanup>();

  constructor(
    private readonly cleanup: WorkspaceCleanup,
    private readonly hooks: DeletionHooks,
  ) {}

  /** Unresolved cleanup failures, for the daemon notice. Never a deletion signal. */
  get notice(): string {
    return [...this.cleanups.values()]
      .flatMap((entry) => (entry.error ? [entry.error] : []))
      .join(" · ");
  }

  /** Scopes still blocked for a repository; a repository receipt blocks all of it. */
  blocked(repositoryId: string): { whole: boolean; worktreeIds: ReadonlySet<string> } {
    let whole = false;
    const worktreeIds = new Set<string>();
    for (const { scope } of this.cleanups.values()) {
      if (scope.repositoryId !== repositoryId) continue;
      if (scope.kind === "repository") whole = true;
      for (const id of scope.worktreeIds) worktreeIds.add(id);
    }

    return { whole, worktreeIds };
  }

  get scopes(): readonly BlockedScope[] {
    return [...this.cleanups.values()].map((entry) => entry.scope);
  }

  /** Synchronous receipt listener for the shared `DeletionTracker`. */
  receive(receipt: DeletionReceipt): void {
    const token = cleanupToken(receipt.id);
    if (this.cleanups.has(token)) return;

    const worktrees = receipt.scopes.map((tree) => ({ id: tree.worktreeId, path: tree.path }));
    const entry: Cleanup = {
      scope: {
        token,
        repositoryId: receipt.repositoryId,
        kind: receipt.kind === "repository" ? "repository" : "worktrees",
        worktreeIds: new Set(worktrees.map((tree) => tree.id)),
      },
      worktrees,
      evidence: receipt.id,
      phase: "durable",
    };
    this.cleanups.set(token, entry);
    this.hooks.fence(entry.scope);
    this.schedule(entry, this.durable(entry));
    this.hooks.changed();
  }

  /**
   * Restores fences of durable receipts at startup, before any discovery or restoration, and
   * schedules their remaining phases.
   */
  async resume(): Promise<Result<void, ExpectedError>> {
    const resumed = await this.cleanup.resume();
    if (!resumed.ok) return resumed;

    for (const deleted of this.cleanup.deletedScopes()?.scopes ?? []) {
      if (deleted.state === "reopened" || this.cleanups.has(deleted.token)) continue;

      const entry: Cleanup = {
        scope: {
          token: deleted.token,
          repositoryId: deleted.repositoryId,
          kind: deleted.kind,
          worktreeIds: new Set(deleted.worktreeIds),
        },
        phase: deleted.state === "pending" ? "purge" : "reopen",
      };
      this.cleanups.set(deleted.token, entry);
      this.hooks.fence(entry.scope);
      this.schedule(entry);
    }

    return ok(undefined);
  }

  /** Retries every failed cleanup, for example after a workspace refresh. */
  retry(): void {
    for (const entry of this.cleanups.values()) {
      if (entry.error || entry.phase === "durable") this.schedule(entry);
    }
  }

  /** Resolves when currently scheduled phases have settled, successfully or not. */
  async idle(): Promise<void> {
    while (true) {
      const running = [...this.cleanups.values()].flatMap((entry) =>
        entry.running ? [entry.running] : [],
      );
      if (!running.length) return;

      await Promise.allSettled(running);
    }
  }

  // The durable fence starts immediately, outside the daemon queue, so stop can wait for it.
  private durable(entry: Cleanup): Promise<Result<void, ExpectedError>> {
    return this.cleanup
      .fence({ ...entry.scope, worktrees: entry.worktrees ?? [] }, entry.scope.token)
      .durable.then((recorded) => {
        if (!recorded.ok) return recorded;

        entry.phase = recorded.value.state === "reopened" ? "release" : "purge";
        if (entry.evidence) this.hooks.acknowledge(entry.evidence);

        return ok(undefined);
      });
  }

  private schedule(entry: Cleanup, durable?: Promise<Result<void, ExpectedError>>): void {
    if (entry.running) return;

    const running = (async () => {
      if (entry.phase === "durable") {
        const recorded = await (durable ?? this.durable(entry));
        if (!recorded.ok) {
          entry.error = `Workspace cleanup [durable] ${describe(recorded.error)}`;
          // Positive deletion already authorizes termination even when persistence fails.
          // Keep late-created file identities in memory, but never purge or acknowledge proof.
          const stopped = await this.hooks.serialize(() => this.hooks.stopWriters(entry.scope));
          if (stopped.ok) {
            entry.candidates = [...(entry.candidates ?? []), ...stopped.value.candidates];
            await stopped.value.release?.();
          } else {
            entry.error += ` · Termination ${describe(stopped.error)}`;
          }
          return;
        }
      }

      await this.hooks.serialize(() => this.advance(entry));
    })();
    entry.running = running
      .catch((error: unknown) => {
        // Unexpected programming errors keep the fence; they are neither deletion nor success.
        entry.error = `Workspace cleanup failed unexpectedly: ${String(error)}`;
        console.error("[radian:workspace-cleanup] Unexpected cleanup failure", error);
      })
      .finally(() => {
        entry.running = undefined;
        this.hooks.changed();
      });
  }

  private async advance(entry: Cleanup): Promise<void> {
    const result = await this.run(entry);
    if (!result.ok) {
      entry.error = `Workspace cleanup [${entry.phase}] ${describe(result.error)}`;
      return;
    }

    delete entry.error;
    if (result.value) this.cleanups.delete(entry.scope.token);
  }

  // ok(true) once the scope is fully released; ok(false) when deferred by shutdown.
  private async run(entry: Cleanup): Promise<Result<boolean, ExpectedError>> {
    const { scope } = entry;
    if (this.hooks.stopping()) return ok(false);

    if (entry.phase === "purge") {
      const stopped = await this.hooks.stopWriters(scope);
      if (!stopped.ok) return stopped;

      let purged: Result<CleanupReport, ExpectedError>;
      try {
        purged = await this.cleanup.purge(scope.token, {
          writersStopped: true,
          candidates: [...(entry.candidates ?? []), ...stopped.value.candidates],
        });
      } finally {
        await stopped.value.release?.();
      }
      if (!purged.ok) return purged;

      this.hooks.purged(scope, purged.value);
      if (!purged.value.complete) {
        return err(new CleanupError(residualSummary(purged.value), []));
      }

      entry.phase = "reopen";
    }
    if (entry.phase === "reopen") {
      const reopened = await this.cleanup.reopen(scope.token);
      if (!reopened.ok) return reopened;

      entry.phase = "release";
    }

    const released = await this.hooks.reopened(scope);

    return released.ok ? ok(true) : released;
  }
}
