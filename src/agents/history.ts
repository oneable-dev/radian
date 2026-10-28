import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { repositorySnapshot, type RepositorySource } from "../workspace/catalog.ts";
import { validateHistory, type SessionRecord, type SessionRegistry } from "./session-registry.ts";
import {
  CancelledError,
  capture,
  HistoryError,
  SessionError,
  StorageError,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import {
  previewSessionSnapshot,
  readHistoryPreview,
  type HistoryPreview,
} from "./history-preview.ts";
import type { SessionSnapshotSource } from "./session-snapshot.ts";
import { mergeDashboards, type DashboardPeriod, type DashboardSnapshot } from "./dashboard.ts";
import { readDashboardHistory } from "./dashboard-history.ts";

export type HistoryItem = {
  readonly id: string;
  readonly worktreeId: string;
  readonly title: string;
  readonly modified: string;
  readonly messageCount: number;
  readonly revision?: string;
  readonly openSessionId: string | null;
  readonly unavailableReason: string | null;
};

type SavedHistory = HistoryItem & { readonly path: string; readonly requireCwd?: boolean };

type HistoryIndex = {
  readonly cwd: string;
  readonly items: readonly SavedHistory[];
  readonly byId: ReadonlyMap<string, SavedHistory>;
};

type Discovery = {
  readonly ready: Promise<Result<HistoryIndex, ExpectedError>>;
  readonly signal: AbortSignal | undefined;
  valid: boolean;
};

// SDK owns discovery. Cached indexes only resolve IDs to paths; they never authorize a writable Open.
export class SessionHistory {
  private readonly indexes = new Map<string, Discovery>();

  constructor(
    private readonly repositories: RepositorySource,
    private readonly registry: SessionRegistry,
    private readonly sessionDir?: string,
    private readonly snapshots?: SessionSnapshotSource,
    private readonly includeDefaultSessions = false,
  ) {}

  invalidate(): void {
    this.indexes.clear();
  }

  async list(
    worktreeId: string,
    signal?: AbortSignal,
  ): Promise<Result<readonly HistoryItem[], ExpectedError>> {
    const saved = await this.index(worktreeId, signal, true);
    if (!saved.ok) {
      return saved;
    }

    // Failed recovery can retain open intent without a live executor owning the SDK file.
    const lifecycles = new Map(
      this.snapshots
        ?.listSessions(worktreeId)
        .map((snapshot) => [snapshot.conversationId ?? snapshot.id, snapshot.lifecycle]),
    );
    for (const record of this.registry.checkpointRecords) {
      if (record.worktreeId === worktreeId) {
        lifecycles.set(record.state.conversationId ?? record.id, record.lifecycle ?? "open");
      }
    }

    // Keep the full index for ownership-safe resume, direct previews and dashboard totals.
    return ok(
      saved.value.items
        .filter(
          (item) =>
            lifecycles.get(item.id) !== "open" && !item.openSessionId && !item.unavailableReason,
        )
        .map(({ path: _path, requireCwd: _requireCwd, ...item }) => item),
    );
  }

  async preview(
    worktreeId: string,
    savedId: string,
    signal?: AbortSignal,
  ): Promise<Result<HistoryPreview, ExpectedError>> {
    if (signal?.aborted) {
      return err(new CancelledError());
    }
    if (this.snapshots?.isExpired?.(worktreeId, savedId)) {
      return err(new HistoryError("HISTORY_UNAVAILABLE", "Saved session has expired."));
    }

    const tree = repositorySnapshot(this.repositories)
      .flatMap((repo) => repo.worktrees)
      .find((entry) => entry.id === worktreeId);
    if (!tree) {
      return err(new HistoryError("HISTORY_UNAVAILABLE", "No worktree is available for history."));
    }

    let saved = await this.index(worktreeId, signal);
    // A different caller may have cancelled a shared cold discovery. Retry only that cancelled discovery.
    if (!saved.ok && saved.error.code === "CANCELLED" && !signal?.aborted) {
      saved = await this.index(worktreeId, signal);
    }
    if (signal?.aborted) {
      return err(new CancelledError());
    }
    if (!saved.ok) {
      return saved;
    }

    const item = saved.value.byId.get(savedId);
    if (!item) {
      return err(
        new HistoryError(
          "HISTORY_UNAVAILABLE",
          "Saved session is not available in this worktree. Refresh history.",
        ),
      );
    }

    const cwd = await capture(() => realpath(tree.path));
    if (!cwd.ok) {
      return cwd;
    }
    if (cwd.value !== saved.value.cwd) {
      return err(
        new HistoryError("HISTORY_UNAVAILABLE", "Saved session worktree changed. Refresh history."),
      );
    }

    const current = this.registry.sessionSnapshot(worktreeId, savedId);
    if (this.snapshots && current) {
      return this.snapshotPreview(current, savedId, cwd.value, signal);
    }
    if (this.snapshots) {
      const snapshot = await this.snapshots.readSession(worktreeId, savedId);
      if (!snapshot.ok) {
        return snapshot;
      }
      if (signal?.aborted) {
        return err(new CancelledError());
      }
      if (snapshot.value?.sessionFile === item.path) {
        const file = await capture(() => stat(item.path));
        if (!file.ok) {
          return file;
        }
        // External SDK writes supersede a closed runtime snapshot's transcript.
        if (
          snapshot.value.updatedAt === undefined ||
          Math.floor(Math.max(file.value.mtimeMs, file.value.ctimeMs)) <= snapshot.value.updatedAt
        ) {
          return this.snapshotPreview(snapshot.value, savedId, cwd.value, signal);
        }
      }
    }

    const selectedPath = item.path;
    const path = await capture(() => realpath(selectedPath));
    if (!path.ok) {
      return path;
    }
    if (cwd.value !== saved.value.cwd || path.value !== item.path) {
      return err(
        new HistoryError("HISTORY_UNAVAILABLE", "Saved session location changed. Refresh history."),
      );
    }

    const preview = await readHistoryPreview(path.value, worktreeId, savedId, signal, {
      cwd: cwd.value,
      requireCwd: item.requireCwd ?? !!this.sessionDir,
    });
    if (!preview.ok) {
      return preview;
    }

    const owner = this.registry.historyOwnership(path.value).openSessionId;
    const telemetry = owner ? this.registry.details(owner)?.telemetry : undefined;

    return ok(telemetry ? { ...preview.value, telemetry } : preview.value);
  }

  private async snapshotPreview(
    record: SessionRecord,
    savedId: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<Result<HistoryPreview, ExpectedError>> {
    const snapshotCwd = record.cwd;
    if (snapshotCwd) {
      const scope = await capture(() => realpath(snapshotCwd));
      if (!scope.ok) {
        return scope;
      }
      if (scope.value !== cwd) {
        return err(
          new HistoryError(
            "HISTORY_UNAVAILABLE",
            "Saved snapshot belongs to a different worktree. Refresh history.",
          ),
        );
      }
    }

    return signal?.aborted
      ? err(new CancelledError())
      : ok(previewSessionSnapshot(record, savedId));
  }

  async resume(worktreeId: string, savedId: string): Promise<Result<string, ExpectedError>> {
    if (this.snapshots?.isExpired?.(worktreeId, savedId)) {
      return err(new HistoryError("HISTORY_UNAVAILABLE", "Saved session has expired."));
    }

    // Mutating actions always rediscover current membership and writer ownership.
    const saved = await this.index(worktreeId, undefined, true);
    if (!saved.ok) {
      return saved;
    }

    const item = saved.value.byId.get(savedId);
    if (!item) {
      return err(
        new HistoryError(
          "HISTORY_UNAVAILABLE",
          "Saved session is not available in this worktree. Refresh history.",
        ),
      );
    }
    if (item.unavailableReason) {
      return err(new SessionError("SESSION_CONFLICT", item.unavailableReason));
    }
    if (item.openSessionId) {
      return ok(item.openSessionId);
    }

    const validated = await validateHistory(item.path);
    if (!validated.ok) {
      return validated;
    }

    const managed =
      this.snapshots
        ?.listSessions(worktreeId)
        .find((snapshot) => snapshot.conversationId === savedId)?.managed === true;

    return this.registry.create(worktreeId, item.path, {
      id: crypto.randomUUID(),
      name: item.title,
      managed,
    });
  }

  async dashboard(
    days: DashboardPeriod,
    signal?: AbortSignal,
  ): Promise<Result<DashboardSnapshot, ExpectedError>> {
    const now = Date.now();
    const seen = new Set<string>();
    const files = new Set<string>();
    const summaries: DashboardSnapshot[] = [];
    const warnings: string[] = [];
    let sharedSessions: readonly SessionInfo[] | undefined;
    for (const tree of repositorySnapshot(this.repositories).flatMap(
      (repository) => repository.worktrees,
    )) {
      if (signal?.aborted) {
        return err(new CancelledError());
      }

      // Directory-wide SDK discovery is shared only within this refresh, never across requests.
      if (this.sessionDir && !sharedSessions) {
        const sessions = await capture(() =>
          SessionManager.listAll(this.sessionDir, undefined, signal),
        );
        if (!sessions.ok) {
          return sessions;
        }

        sharedSessions = sessions.value;
      }

      const index = await this.index(tree.id, signal, true, sharedSessions);
      if (!index.ok) {
        return index;
      }
      for (const item of index.value.items) {
        if (signal?.aborted) {
          return err(new CancelledError());
        }
        if (files.has(item.path)) {
          continue;
        }

        files.add(item.path);

        const summary = await readDashboardHistory(
          item.path,
          index.value.cwd,
          days,
          now,
          seen,
          signal,
        );
        if (!summary.ok) {
          if (summary.error.code === "CANCELLED") {
            return summary;
          }

          warnings.push(`A conversation was excluded [${summary.error.code}]. Refresh to retry.`);
          continue;
        }

        summaries.push(summary.value.snapshot);
        for (const identity of summary.value.identities) {
          seen.add(identity);
        }
      }
    }

    const snapshot = mergeDashboards(summaries, days, now);
    snapshot.warnings = [...new Set([...snapshot.warnings, ...warnings])].slice(0, 100);

    return ok(snapshot);
  }

  private index(
    worktreeId: string,
    signal?: AbortSignal,
    refresh = false,
    sharedSessions?: readonly SessionInfo[],
  ): Promise<Result<HistoryIndex, ExpectedError>> {
    if (signal?.aborted) {
      return Promise.resolve(err(new CancelledError()));
    }

    const ids = new Set(
      repositorySnapshot(this.repositories).flatMap((repo) =>
        repo.worktrees.map((tree) => tree.id),
      ),
    );
    for (const id of this.indexes.keys()) {
      if (!ids.has(id)) {
        this.indexes.delete(id);
      }
    }
    if (!ids.has(worktreeId)) {
      return Promise.resolve(
        err(new HistoryError("HISTORY_UNAVAILABLE", "No worktree is available for history.")),
      );
    }

    const previous = this.indexes.get(worktreeId);
    if (!refresh && previous && (previous.valid || !previous.signal?.aborted)) {
      return previous.ready;
    }

    const ready = this.discover(worktreeId, signal, sharedSessions).then((result) => {
      entry.valid = result.ok;

      return result;
    });
    const entry: Discovery = { ready, signal, valid: false };

    this.indexes.set(worktreeId, entry);

    // Replacing the promise before it resolves also fences out older refreshes.
    return ready;
  }

  private async discover(
    worktreeId: string,
    signal?: AbortSignal,
    sharedSessions?: readonly SessionInfo[],
  ): Promise<Result<HistoryIndex, ExpectedError>> {
    if (signal?.aborted) {
      return err(new CancelledError());
    }

    const tree = repositorySnapshot(this.repositories)
      .flatMap((repo) => repo.worktrees)
      .find((entry) => entry.id === worktreeId);
    if (!tree) {
      return err(new HistoryError("HISTORY_UNAVAILABLE", "No worktree is available for history."));
    }

    const cwd = await capture(() => realpath(tree.path));
    if (!cwd.ok) {
      return cwd;
    }
    if (signal?.aborted) {
      return err(new CancelledError());
    }

    const resolvedCwd = resolve(tree.path);
    const sessions = await capture(async () => {
      // listAll is directory-wide; retain list's cwd scope before canonical-path validation.
      const owned = (
        sharedSessions
          ? sharedSessions.filter((session) => session.cwd && resolve(session.cwd) === resolvedCwd)
          : await SessionManager.list(tree.path, this.sessionDir, undefined, signal)
      ).map((session) => ({ ...session, requireCwd: !!this.sessionDir }));
      const legacy = this.includeDefaultSessions
        ? (await SessionManager.list(tree.path, undefined, undefined, signal)).map((session) => ({
            ...session,
            requireCwd: false,
          }))
        : [];

      return [...owned, ...legacy];
    });
    if (!sessions.ok) {
      return sessions;
    }

    const result: SavedHistory[] = [];
    for (const session of sessions.value) {
      if (this.snapshots?.isExpired?.(worktreeId, session.id)) {
        continue;
      }
      if (signal?.aborted) {
        return err(new CancelledError());
      }
      // A custom directory may be shared by worktrees; cwd metadata must still scope each list.
      if (session.cwd) {
        const savedCwd = await capture(() => realpath(session.cwd));
        if (!savedCwd.ok) {
          if (savedCwd.error instanceof StorageError && savedCwd.error.systemCode === "ENOENT") {
            continue;
          }

          return savedCwd;
        }
        if (savedCwd.value !== cwd.value) {
          continue;
        }
      } else if (session.requireCwd) {
        continue;
      }

      const path = await capture(() => realpath(session.path));
      if (!path.ok) {
        if (path.error instanceof StorageError && path.error.systemCode === "ENOENT") {
          continue;
        }

        return path;
      }

      const file = await capture(() => stat(path.value, { bigint: true }));
      if (!file.ok) {
        if (file.error instanceof StorageError && file.error.systemCode === "ENOENT") {
          continue;
        }

        return file;
      }

      const revision = `${file.value.ino}:${file.value.size}:${file.value.mtimeNs}:${file.value.ctimeNs}`;
      const ownership = this.registry.historyOwnership(path.value);

      result.push({
        id: session.id,
        revision,
        path: path.value,
        requireCwd: session.requireCwd,
        worktreeId,
        title: (session.name?.trim() || session.firstMessage.trim() || "Untitled session")
          .replace(/\s+/g, " ")
          .slice(0, 120),
        modified: session.modified.toISOString(),
        messageCount: session.messageCount,
        openSessionId: ownership.openSessionId,
        unavailableReason: ownership.unavailableReason,
      });
    }
    if (signal?.aborted) {
      return err(new CancelledError());
    }

    result.sort((a, b) => b.modified.localeCompare(a.modified) || a.id.localeCompare(b.id));

    // Preserve the same newest-first resolution as the original Array.find for duplicate saved IDs.
    const byId = new Map<string, SavedHistory>();
    for (const item of result) {
      if (!byId.has(item.id)) {
        byId.set(item.id, item);
      }
    }

    return ok({ cwd: cwd.value, items: result, byId });
  }
}
