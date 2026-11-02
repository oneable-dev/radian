import { chmod } from "node:fs/promises";
import {
  capture,
  collectCleanup,
  ConnectionError,
  InputError,
  ProtocolError,
  ResourceError,
  reportUnexpected,
  SessionError,
  withCleanup,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { Repository } from "../workspace/model.ts";
import { RepositoryWatcher } from "../workspace/repository-watcher.ts";
import type { DeletionTracker } from "../workspace/deletion.ts";
import type { SessionDeletionCandidate } from "../agents/session-registry.ts";
import {
  acquireRuntime,
  privateDirectory,
  RuntimeStore,
  ScopeDeletedError,
  type RuntimePaths,
} from "./storage.ts";
import { scrubPreferences } from "./workspace-preferences.ts";
import { snapshotEvents } from "./events.ts";
import { TranscriptFrames, transcriptStream, withoutTranscripts } from "./transcript-frames.ts";
import {
  emptyPreferences,
  errorStatus,
  maxFrameBytes,
  parseCommand,
  protocolVersion,
  wireError,
  type RuntimeManifest,
  type RuntimeSnapshot,
} from "./protocol.ts";
import type { WorkspaceRuntime } from "./service.ts";
import type { AccountManager } from "../accounts/manager.ts";
import { readProcessResources } from "../usage/process-resources.ts";

export function unavailableRepository(): ResourceError {
  return new ResourceError(
    "This repository is missing or no longer part of the workspace configuration. Existing sessions, editors and terminals were retained; new work was not started.",
  );
}

function deletedScope(): ResourceError {
  return new ResourceError(
    "This repository or worktree was deleted; its cleanup is in progress. No action was accepted.",
  );
}

export function rejected(error: ExpectedError): Response {
  return Response.json({ ok: false, error: wireError(error) }, { status: errorStatus(error) });
}

// A cold repository owns metadata and persistence, but no SDK, editor or terminal resources.
export class RepositoryHost {
  readonly instance = crypto.randomUUID();
  private readonly listeners = new Set<() => void>();
  // In-process observers (the shared daemon); unlike stream listeners they do not mark a UI as active.
  private readonly observers = new Set<() => void>();
  private readonly store: RuntimeStore;
  private missing = false;
  private excluded = false;
  private watcher: RepositoryWatcher | undefined;
  private server: Bun.Server<undefined> | undefined;
  private runtime: WorkspaceRuntime | undefined;
  // A runtime still restoring its resources: it only receives scope fences, never requests.
  private preparing: WorkspaceRuntime | undefined;
  private activating: Promise<Result<void, ExpectedError>> | undefined;
  private unsubscribe: (() => void) | undefined;
  private warning = "";
  private stopped = false;
  private saving: Promise<Result<void, ExpectedError>> = Promise.resolve(ok(undefined));
  // Confirmed deletion: the whole repository, or individual worktrees, until released.
  private deleted = false;
  private readonly deletedWorktrees = new Set<string>();
  private readonly purgedSessions = new Set<string>();
  private deletion: DeletionTracker | undefined;

  private constructor(
    private repository: Repository,
    readonly paths: RuntimePaths,
    private manifest: RuntimeManifest,
    private readonly offline: boolean,
    private readonly stateRoot: string | undefined,
    readonly config: string | undefined,
    private readonly release: () => Promise<void>,
    private readonly requestStop: () => void,
    private readonly activated: () => Promise<Result<void, ExpectedError>>,
    private readonly accounts?: AccountManager,
    private readonly implicitConfig?: string,
  ) {
    this.store = new RuntimeStore(paths);
  }

  static async open(
    repository: Repository,
    paths: RuntimePaths,
    offline: boolean,
    stateRoot: string | undefined,
    config: string | undefined,
    requestStop: () => void,
    activated: () => Promise<Result<void, ExpectedError>>,
    accounts?: AccountManager,
    implicitConfig?: string,
    deletion?: DeletionTracker,
  ): Promise<Result<RepositoryHost, ExpectedError>> {
    const prepared = await capture(async () => {
      await privateDirectory(paths.directory);

      return acquireRuntime(paths);
    });
    if (!prepared.ok) {
      return prepared;
    }

    const release = prepared.value;
    if (!release) {
      return err(
        new ConnectionError(
          "CONNECTION_FAILED",
          `Repository ${repository.name} is still owned by an existing service. Finish its work and explicitly stop the legacy service; it was not replaced.`,
        ),
      );
    }

    let host: RepositoryHost | undefined;
    let ready = false;

    return withCleanup(
      async () => {
        const loaded = await new RuntimeStore(paths).load(repository.id);
        if (!loaded.ok) {
          return loaded;
        }

        const manifest = loaded.value ?? {
          version: protocolVersion,
          repositoryId: repository.id,
          repositories: [repository],
          records: [],
          preferences: structuredClone(emptyPreferences),
        };
        host = new RepositoryHost(
          repository,
          paths,
          manifest,
          offline,
          stateRoot,
          config,
          release,
          requestStop,
          activated,
          accounts,
          implicitConfig,
        );
        host.deletion = deletion;
        host.watcher = new RepositoryWatcher(
          repository,
          (result) => {
            if (host!.stopped) {
              return;
            }
            if (!result.ok) {
              host!.warning = `Worktree discovery failed [${result.error.code}]: ${result.error.message}. Previous entries were retained.`;
            } else if (result.value) {
              host!.repository = result.value;
              host!.missing = false;
              host!.warning = "";
            } else {
              // A deleted repository is an availability change, not a repeated discovery error.
              host!.missing = true;
              host!.warning = "";
            }

            host!.emit();
          },
          (error) => {
            host!.warning = reportUnexpected(error, "repository catalog");
            host!.emit();
          },
          deletion ? { deletion } : {},
        );

        const watched = await host.watcher.start();
        if (!watched.ok) {
          host.warning = `Worktree watching failed [${watched.error.code}]: ${watched.error.message}`;
        }

        const listening = await capture(async () => {
          host!.server = Bun.serve({
            unix: paths.socket,
            fetch: (request) => host!.fetch(request),
          });
          await chmod(paths.socket, 0o600);
        });
        if (!listening.ok) {
          return listening;
        }

        ready = true;

        return ok(host);
      },
      async () => {
        if (ready) {
          return;
        }
        if (host) {
          const result = await host.stop();
          if (!result.ok) {
            throw result.error;
          }
        } else {
          await release();
        }
      },
    );
  }

  get active(): boolean {
    return !!this.runtime;
  }

  get repositoryId(): string {
    return this.repository.id;
  }

  /** Current workspace member that is present on disk; only these accept new work. */
  get available(): boolean {
    return (
      !this.deleted &&
      !this.excluded &&
      !(this.runtime ? this.runtime.repositoryMissing : this.missing)
    );
  }

  /** The whole repository was confirmed deleted; only its cleanup may release this host. */
  get repositoryDeleted(): boolean {
    return this.deleted;
  }

  /** Whether running or pending resources still need this host after it became unavailable. */
  get retainsResources(): boolean {
    return !!this.activating || (this.runtime?.retainsResources ?? false);
  }

  // Workspace discovery found the repository again; do not wait for a watcher event.
  rediscovered(repository: Repository): void {
    if (this.runtime) {
      this.runtime.rediscovered(repository);

      return;
    }
    this.repository = repository;
    this.missing = false;
    this.emit();
  }

  setExcluded(excluded: boolean): void {
    if (this.excluded === excluded) {
      return;
    }

    this.excluded = excluded;
    this.runtime?.setExcluded(excluded);
    this.emit();
  }

  observe(listener: () => void): () => void {
    this.observers.add(listener);

    return () => this.observers.delete(listener);
  }

  get snapshot(): RuntimeSnapshot {
    if (this.runtime) {
      const snapshot = this.runtime.snapshot;

      return {
        ...snapshot,
        ...(this.deleted ? { repositories: [] } : {}),
        ...(!this.available && !this.deleted
          ? { unavailableRepositories: [this.repository.id] }
          : {}),
        capabilities: [...(snapshot.capabilities ?? []), "process-resources"],
        notice: [snapshot.notice, this.warning].filter(Boolean).join(" · "),
      };
    }

    return {
      version: protocolVersion,
      pid: process.pid,
      instance: this.instance,
      repositoryId: this.repository.id,
      mode: this.offline ? "offline" : "live",
      capabilities: ["shared-daemon", "repository-catalog", "process-resources"],
      repositories: this.available ? [this.visibleRepository] : [],
      ...(!this.available && !this.deleted
        ? { unavailableRepositories: [this.repository.id] }
        : {}),
      details: {},
      closingCount: 0,
      preferences: this.manifest.preferences,
      notice: this.warning,
      editors: [],
      terminals: [],
      terminalClosingCount: 0,
    };
  }

  private get visibleRepository(): Repository {
    return this.deletedWorktrees.size
      ? {
          ...this.repository,
          worktrees: this.repository.worktrees.filter(
            (tree) => !this.deletedWorktrees.has(tree.id),
          ),
        }
      : this.repository;
  }

  /**
   * Synchronously blocks confirmed deleted scopes before any later request is admitted,
   * including an activation still opening its runtime. Idempotent.
   */
  fenceScope(kind: "repository" | "worktrees", worktreeIds: ReadonlySet<string>): void {
    if (kind === "repository") this.deleted = true;
    for (const id of worktreeIds) this.deletedWorktrees.add(id);
    this.manifest = this.scrubbed(this.manifest, worktreeIds);
    this.preparing?.fenceScope(worktreeIds);
    this.runtime?.fenceScope(worktreeIds);
    this.emit();
  }

  private scrubbed(manifest: RuntimeManifest, worktreeIds: ReadonlySet<string>): RuntimeManifest {
    const sessionIds = new Set(
      manifest.records
        .filter((record) => record.worktreeId && worktreeIds.has(record.worktreeId))
        .map((record) => record.id),
    );

    return {
      ...manifest,
      records: manifest.records.filter(
        (record) => !record.worktreeId || !worktreeIds.has(record.worktreeId),
      ),
      repositories: manifest.repositories.map((repo) => ({
        ...repo,
        worktrees: repo.worktrees.filter((tree) => !worktreeIds.has(tree.id)),
      })),
      preferences: scrubPreferences(manifest.preferences, { worktreeIds, sessionIds }),
    };
  }

  /**
   * Stops every writer of a deleted scope without checkpointing restoration intent:
   * scoped Agents, children, editors and terminals, then checkpoint and retention writers.
   * A cold host never activates resources. Returns the conversation file candidates.
   */
  async stopScope(
    kind: "repository" | "worktrees",
    worktreeIds: ReadonlySet<string>,
  ): Promise<Result<readonly SessionDeletionCandidate[], ExpectedError>> {
    this.fenceScope(kind, worktreeIds);
    if (this.activating) await this.activating;
    await this.saving;
    if (!this.runtime) return ok([]);
    if (kind === "worktrees") return this.runtime.stopScope(worktreeIds);

    const runtime = this.runtime;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const destroyed = await runtime.destroy();
    // Failed shutdown still owns writers; keep the handle so an idempotent retry can stop them.
    if (destroyed.ok) this.runtime = undefined;
    this.emit();

    return destroyed;
  }

  /**
   * After the scope was purged and reopened: drops the old generation from memory, adopts the
   * reopened store state and admits a fresh generation at the same identity.
   */
  async releaseScope(
    worktreeIds: ReadonlySet<string>,
    sessionIds: ReadonlySet<string>,
  ): Promise<Result<void, ExpectedError>> {
    this.manifest = this.scrubbed(this.manifest, worktreeIds);
    this.manifest = {
      ...this.manifest,
      records: this.manifest.records.filter((record) => !sessionIds.has(record.id)),
      preferences: scrubPreferences(this.manifest.preferences, {
        worktreeIds: new Set(),
        sessionIds,
      }),
    };
    // The cold store saves again when the runtime stops; it must see the reopened state too.
    const adopted = await this.store.adoptCleanup();
    if (!adopted.ok) return adopted;
    if (this.runtime) {
      const released = await this.runtime.releaseScope(worktreeIds, sessionIds);
      if (!released.ok) return released;
    }

    for (const id of worktreeIds) this.deletedWorktrees.delete(id);
    for (const id of sessionIds) this.purgedSessions.add(id);
    this.emit();

    return ok(undefined);
  }

  activate(): Promise<Result<void, ExpectedError>> {
    if (this.deleted) {
      return Promise.resolve(err(deletedScope()));
    }
    if (this.stopped) {
      return Promise.resolve(
        err(new SessionError("RUNTIME_STOPPING", "Shared daemon is stopping.")),
      );
    }
    if (this.runtime) {
      return Promise.resolve(ok(undefined));
    }
    if (!this.available && !this.activating) {
      return Promise.resolve(err(unavailableRepository()));
    }

    this.activating ??= this.openRuntime().finally(() => {
      this.activating = undefined;
    });

    return this.activating;
  }

  private async openRuntime(): Promise<Result<void, ExpectedError>> {
    const { openRepositoryRuntime } = await import("./service.ts");
    const saved = await this.saving;
    if (!saved.ok) {
      return saved;
    }

    let initialized: Result<Result<WorkspaceRuntime, ExpectedError>, ExpectedError>;
    try {
      initialized = await capture(() =>
        openRepositoryRuntime(
          this.repository.id,
          this.offline,
          this.instance,
          this.stateRoot,
          this.config,
          this.accounts,
          this.implicitConfig,
          {
            deletion: this.deletion,
            deletedWorktreeIds: new Set(this.deletedWorktrees),
            onPrepared: (runtime) => {
              // Fences confirmed since the call-time copy apply before restore starts.
              if (this.deletedWorktrees.size) runtime.fenceScope(this.deletedWorktrees);
              this.preparing = runtime;
            },
          },
        ),
      );
    } finally {
      // A failed initialization was stopped by its opener; a ready one is adopted below.
      this.preparing = undefined;
    }
    if (!initialized.ok) {
      return initialized;
    }

    const opened = initialized.value;
    if (!opened.ok) {
      return opened;
    }

    this.runtime = opened.value;
    // Deletions confirmed while the runtime opened apply before it accepts any request.
    if (this.deletedWorktrees.size) this.runtime.fenceScope(this.deletedWorktrees);
    if (this.deleted) {
      // A whole repository deleted during activation is torn down by its cleanup instead.
      this.emit();

      return err(deletedScope());
    }
    this.runtime.setExcluded(this.excluded);
    this.runtime.setObserved(this.listeners.size > 0);
    this.runtime.onStop = this.requestStop;
    this.unsubscribe = this.runtime.subscribe(() => this.emit());
    await this.watcher?.stop();
    this.watcher = undefined;

    const registered = await this.activated();
    this.warning = registered.ok
      ? ""
      : `Repository activated; registration persistence failed: ${registered.error.message}`;
    this.emit();

    return ok(undefined);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
    for (const observer of this.observers) {
      observer();
    }
  }

  private async fetch(request: Request): Promise<Response> {
    try {
      const expected = request.headers.get("X-Radian-Instance");
      const path = new URL(request.url).pathname;
      if (expected && expected !== this.instance) {
        return rejected(
          new ProtocolError(
            "Runtime instance changed; refresh the connection before retrying. No action was accepted.",
          ),
        );
      }
      if (path === "/snapshot" && request.method === "GET") {
        const snapshot = this.snapshot;
        return Response.json({ ...snapshot, details: withoutTranscripts(snapshot.details) });
      }
      if (this.stopped) {
        return rejected(new SessionError("RUNTIME_STOPPING", "Shared daemon is stopping."));
      }
      if (this.deleted && path !== "/events") {
        return rejected(deletedScope());
      }
      if (path === "/resources" && request.method === "GET") {
        if (expected !== this.instance) {
          return rejected(
            new ProtocolError("Process resources require the current runtime instance."),
          );
        }

        const sample = readProcessResources();

        return sample.ok ? Response.json(sample.value) : rejected(sample.error);
      }
      if (path === "/events" && request.method === "GET") {
        const frames = transcriptStream(request) ? new TranscriptFrames() : undefined;
        return snapshotEvents(
          () => {
            const snapshot = this.snapshot;
            return frames ? { ...snapshot, ...frames.split(snapshot.details) } : snapshot;
          },
          (listener) => {
            this.listeners.add(listener);
            this.runtime?.setObserved(true);

            return () => {
              this.listeners.delete(listener);
              this.runtime?.setObserved(this.listeners.size > 0);
            };
          },
        );
      }
      if (path === "/activate" && request.method === "POST") {
        if (expected !== this.instance) {
          return rejected(
            new ProtocolError("Activation requires the current repository instance."),
          );
        }

        const activated = await this.activate();

        return activated.ok ? Response.json({ ok: true, value: null }) : rejected(activated.error);
      }
      if (this.activating) {
        const ready = await this.activating;
        if (!ready.ok) {
          return rejected(ready.error);
        }
      }
      if (!this.runtime && path === "/command" && request.method === "POST") {
        if (Number(request.headers.get("content-length")) > maxFrameBytes) {
          return rejected(new InputError("Command is too large."));
        }

        const text = await request.clone().text();
        if (Buffer.byteLength(text) > maxFrameBytes) {
          return rejected(new InputError("Command is too large."));
        }

        const command = parseCommand(text);
        if (!command.ok) {
          return rejected(command.error);
        }
        // Parsing yields to activation; re-enter the active path instead of writing stale cold state.
        if (this.activating || this.runtime) {
          return this.fetch(request);
        }
        if (command.value.type === "stop") {
          setTimeout(this.requestStop, 20);

          return Response.json({ ok: true, value: null });
        }
        if (command.value.type === "preferences") {
          // The cold catalog has no live tabs; preserve the last runtime's saved order.
          // Stale clients cannot write state of scopes deleted meanwhile.
          const preferences =
            this.deletedWorktrees.size || this.purgedSessions.size
              ? scrubPreferences(command.value.preferences, {
                  worktreeIds: this.deletedWorktrees,
                  sessionIds: this.purgedSessions,
                })
              : command.value.preferences;
          this.manifest = { ...this.manifest, preferences };
          this.saving = this.store.save(this.manifest);

          const saved = await this.saving;
          this.warning = saved.ok ? "" : `Runtime persistence failed: ${saved.error.message}`;
          this.emit();

          return Response.json({
            ok: true,
            value: null,
            ...(!saved.ok ? { warnings: [wireError(saved.error)] } : {}),
          });
        }
      }
      // Unknown paths must not allocate an SDK or start a process.
      if (
        ![
          "/command",
          "/accounts",
          "/dashboard",
          "/history",
          "/history/preview",
          "/models",
          "/completions",
          "/completion-catalog",
          "/images",
          "/editor/events",
          "/terminal/events",
        ].includes(path)
      ) {
        return new Response("Not found", { status: 404 });
      }

      const activated = await this.activate();
      if (!activated.ok) {
        return rejected(activated.error);
      }

      return this.runtime!.fetch(request);
    } catch (error) {
      reportUnexpected(error, "repository request");

      return Response.json(
        {
          ok: false,
          error: {
            code: "REMOTE_INTERNAL_ERROR",
            message:
              "Unexpected repository failure. Inspect the shared daemon log; action outcome may be unknown.",
            outcome: "unknown",
          },
        },
        { status: 500 },
      );
    }
  }

  async stop(): Promise<Result<void, ExpectedError>> {
    if (this.stopped) {
      return ok(undefined);
    }

    this.stopped = true;

    return withCleanup(
      async () => {
        if (this.activating) {
          const result = await this.activating;
          if (!result.ok) {
            this.warning = result.error.message;
          }
        }

        this.unsubscribe?.();

        return collectCleanup(
          [
            this.watcher
              ? this.watcher.stop().then(() => ok(undefined))
              : Promise.resolve(ok(undefined)),
            // A deleted repository never checkpoints; its cleanup resumes from the durable receipt.
            this.runtime
              ? this.deleted
                ? this.runtime.destroy().then((result) => (result.ok ? ok(undefined) : result))
                : this.runtime.stop()
              : this.deleted
                ? Promise.resolve(ok(undefined))
                : this.store.save(this.manifest),
          ],
          "Repository shutdown failed.",
        );
      },
      async () => {
        await withCleanup(async () => {
          await this.server?.stop(true);
        }, this.release);
      },
    );
  }
}

/** Whether a failure only reports that a deleted scope rejected its write (expected). */
export function isScopeDeleted(error: ExpectedError): boolean {
  return error instanceof ScopeDeletedError;
}
