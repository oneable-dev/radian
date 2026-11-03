import { chmod, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { snapshotEvents } from "./events.ts";
import { TranscriptFrames, transcriptStream, withoutTranscripts } from "./transcript-frames.ts";
import { ChatRuntime } from "./chat-runtime.ts";
import { CHAT_SCOPE_ID } from "../agents/session-scope.ts";
import { accountRequestSchema } from "../accounts/model.ts";
import { completionQuerySchema, completionCatalogQuerySchema } from "./completion-protocol.ts";
import { modelCatalogQuerySchema } from "../agents/model-selection.ts";
import { transcriptImageQuerySchema } from "../agents/transcript-images.ts";
import { Value } from "typebox/value";
import {
  capture,
  collectCleanup,
  InputError,
  parseJson,
  ConnectionError,
  ProtocolError,
  reportUnexpected,
  SessionError,
  withCleanup,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { discoverRepository, isMissingPath, probeRepository } from "../workspace/discovery.ts";
import { discoverConfiguredWorkspace, workspacePathIsReachable } from "../workspace/roots.ts";
import type { WorkspaceConfig } from "../workspace/config.ts";
import type { Repository } from "../workspace/model.ts";
import { loadWorkspaceSource, workspaceSource } from "../app/settings.ts";
import {
  emptyRegistry,
  mergeSource,
  repositoryState,
  RestoreStateStore,
  sourceContexts,
  withRepositoryState,
} from "./restore-state.ts";
import {
  acquireRuntime,
  daemonPaths,
  privateDirectory,
  runtimePaths,
  type RuntimePaths,
} from "./storage.ts";
import {
  repositoryRegistrationSchema,
  workspaceRequestSchema,
  type DaemonRegistry,
  type RepositoryRegistration,
  type WorkspaceSource,
} from "./daemon-protocol.ts";
import { RepositoryHost, rejected } from "./repository-host.ts";
import { DeletionTracker } from "../workspace/deletion.ts";
import { WorkspaceCleanup, type CleanupReport } from "./workspace-cleanup.ts";
import { WorkspaceDeletion, type BlockedScope, type StoppedWriters } from "./workspace-deletion.ts";
import { AccountManager } from "../accounts/manager.ts";
import {
  emptyPreferences,
  maxFrameBytes,
  parseCommand,
  protocolVersion,
  historyPreviewQuerySchema,
  type RuntimeSnapshot,
  type WireError,
} from "./protocol.ts";

type Entry = {
  host: RepositoryHost;
  // The settings file whose session policy this host enforces; undefined selects the default.
  config: string | undefined;
  implicitConfig: string | undefined;
  unobserve: () => void;
};

export type RuntimeOptions = { source?: WorkspaceSource; attachChat?: boolean };

// One owner per user/state-root/mode; all repository endpoints below live in this process.
export async function runRuntime(
  offline: boolean,
  stateRoot?: string,
  options: RuntimeOptions = {},
): Promise<void> {
  const paths = daemonPaths(offline, stateRoot);
  await privateDirectory(paths.directory);

  const release = await acquireRuntime(paths);
  if (!release) {
    return;
  }

  const daemon = new SharedDaemon(paths, offline, stateRoot);
  let server: Bun.Server<undefined> | undefined;
  const stopped = Promise.withResolvers<void>();
  const stop = () => stopped.resolve();

  daemon.onStop = stop;
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await withCleanup(
    async () => {
      const loaded = await daemon.load(options.source, options.attachChat);
      if (!loaded.ok) {
        throw loaded.error;
      }

      // Queue startup discovery before serving, so early refreshes and registrations wait for it.
      const restoring = daemon.restore();
      server = Bun.serve({ unix: paths.socket, fetch: (request) => daemon.fetch(request) });
      await chmod(paths.socket, 0o600);
      await restoring;
      await stopped.promise;
    },
    async () => {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      await withCleanup(async () => {
        await withCleanup(
          async () => {
            const result = await daemon.stop();
            if (!result.ok) {
              throw result.error;
            }
          },
          async () => {
            await server?.stop(true);
          },
        );
      }, release);
    },
  );
}

type Discovered = {
  repositories: readonly Repository[];
  warnings: WireError[];
  uncertain: string[];
};

function within(path: string, root: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  );
}

function overlaps(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}

const notice = (error: ExpectedError, context: string): WireError => ({
  code: error.code,
  message: `${context}: ${error.message}`,
  outcome: "rejected",
});

/**
 * Owns the shared catalog. With a remembered workspace source, membership is derived only from
 * the latest configuration and the filesystem/Git; the registry contributes restoration
 * metadata (active intent, per-repository policy file) to repositories discovery finds.
 * Without a source, isolated low-level clients may still register repositories ad hoc.
 */
class SharedDaemon {
  readonly instance = crypto.randomUUID();
  onStop: () => void = () => {};

  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<Result<RepositoryHost, ExpectedError>>>();
  private readonly store: RestoreStateStore;
  private saved: DaemonRegistry = emptyRegistry();
  private launchSource: WorkspaceSource | undefined;
  private launchAttachesChat = false;
  // In-memory provenance only, used to retain the right prior scope during transient root failures.
  private readonly knownRoots = new Map<string, string>();
  // Current members by repository ID, or null when no workspace source owns membership yet.
  private members: Set<string> | null = null;
  // Workspace discovery and releases run one at a time so catalogs never interleave.
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private loaded = false;
  private ready = false;
  private accounts: AccountManager | undefined;
  private unsubscribeAccounts: (() => void) | undefined;
  private chat: ChatRuntime | undefined;
  private readonly listeners = new Set<() => void>();
  private warning = "";
  private discoveryWarning = "";
  // Positive deletion evidence spans cold hosts, active runtimes and host replacement.
  private readonly tracker = new DeletionTracker();
  private readonly cleanup: WorkspaceCleanup;
  private readonly deletion: WorkspaceDeletion;

  constructor(
    private readonly paths: RuntimePaths,
    private readonly offline: boolean,
    private readonly stateRoot: string | undefined,
  ) {
    this.store = new RestoreStateStore(paths.manifest);
    this.cleanup = new WorkspaceCleanup({
      offline,
      ...(stateRoot !== undefined ? { stateRoot } : {}),
      registry: this.store,
    });
    this.deletion = new WorkspaceDeletion(this.cleanup, {
      fence: (scope) => this.fenceScope(scope),
      acknowledge: (id) => {
        this.tracker.acknowledge(id);
      },
      stopWriters: (scope) => this.stopScopeWriters(scope),
      purged: (_scope, report) => this.adoptPurge(report),
      reopened: (scope) => this.releaseScope(scope),
      stopping: () => this.stopped,
      serialize: (task) => this.serialize(task),
      changed: () => this.emit(),
    });
    this.tracker.onReceipt((receipt) => this.deletion.receive(receipt));
  }

  // Synchronous: also covers hosts that are still opening (see openRepository).
  private fenceScope(scope: BlockedScope): void {
    this.entries.get(scope.repositoryId)?.host.fenceScope(scope.kind, scope.worktreeIds);
  }

  private async stopScopeWriters(
    scope: BlockedScope,
  ): Promise<Result<StoppedWriters, ExpectedError>> {
    await Promise.allSettled(this.pending.values());
    const entry = this.entries.get(scope.repositoryId);
    if (entry) {
      const stopped = await entry.host.stopScope(scope.kind, scope.worktreeIds);

      return stopped.ok ? ok({ candidates: stopped.value }) : stopped;
    }

    // No host: reserve repository ownership, so a legacy repository service cannot still write.
    const paths = runtimePaths(scope.repositoryId, this.offline, this.stateRoot);
    const reserved = await capture(() => acquireRuntime(paths));
    if (!reserved.ok) return reserved;
    if (!reserved.value) {
      return err(
        new ConnectionError(
          "CONNECTION_FAILED",
          "Another service still owns the deleted repository's state; cleanup will be retried.",
        ),
      );
    }

    const release = reserved.value;

    return ok({ candidates: [], release });
  }

  private adoptPurge(report: CleanupReport): void {
    // The sanitized registry is valid even when other phases left residuals.
    if (report.registry) this.saved = report.registry;
  }

  private async releaseScope(scope: BlockedScope): Promise<Result<void, ExpectedError>> {
    const deleted = this.cleanup
      .deletedScopes()
      ?.scopes.find((entry) => entry.token === scope.token);
    const sessionIds = new Set(deleted?.sessionIds ?? []);
    const entry = this.entries.get(scope.repositoryId);
    if (scope.kind === "repository") {
      if (entry) {
        // The deleted host never checkpoints; the next discovery opens a fresh generation.
        this.entries.delete(scope.repositoryId);
        entry.unobserve();
        this.members?.delete(scope.repositoryId);
        const stopped = await entry.host.stop();
        if (!stopped.ok) {
          this.warning = `Deleted repository release failed [${stopped.error.code}]: ${stopped.error.message}`;
        }
      }
      this.tracker.untrack(scope.repositoryId);
    } else if (entry) {
      const released = await entry.host.releaseScope(scope.worktreeIds, sessionIds);
      if (!released.ok) return released;
    }

    // Launch contexts or members may have changed; discovery never substitutes a removed cwd.
    const source = this.saved.source;
    if (source && this.loaded && !this.stopped) {
      const refreshed = await this.reconcile(source);
      if (!refreshed.ok) {
        this.discoveryWarning = `Workspace discovery [${refreshed.error.code}]: ${refreshed.error.message}`;
      }
    } else {
      await this.persist();
    }
    this.emit();

    return ok(undefined);
  }

  async load(source?: WorkspaceSource, attachChat = false): Promise<Result<void, ExpectedError>> {
    this.launchAttachesChat = attachChat;
    const accounts = await AccountManager.open(this.paths.directory, { offline: this.offline });
    if (!accounts.ok) {
      return accounts;
    }

    this.accounts = accounts.value;
    this.unsubscribeAccounts = accounts.value.subscribe(() => this.emit());
    const chat = await ChatRuntime.open(this.paths.directory, accounts.value, this.offline);
    if (!chat.ok) return chat;
    this.chat = chat.value;
    this.chat.subscribe(() => this.emit());

    const registry = await this.store.load();
    if (!registry.ok) {
      return registry;
    }

    this.saved = registry.value ?? emptyRegistry();
    // Confirmed cleanups resume before discovery or restoration; absence alone never does.
    const resumed = await this.deletion.resume();
    if (!resumed.ok) {
      return resumed;
    }

    // An explicit launch source is adopted; otherwise the remembered reference is re-read.
    this.launchSource = source;
    if (!this.launchSource && !this.saved.source && !this.offline) {
      // A first live start has a legitimate default configuration, even without a prior TUI.
      // Legacy registration paths never supply this launch context or configuration origin.
      this.launchSource = workspaceSource({ cwd: process.cwd() });
    }
    if (this.saved.chatConfig !== undefined) {
      this.chat.startRetention(
        this.saved.chatConfig ?? undefined,
        this.saved.chatConfig === null && !this.saved.source?.settings.explicit
          ? this.saved.source?.settings.path
          : undefined,
      );
    }

    this.loaded = true;

    return ok(undefined);
  }

  // Startup discovery and restoration, before and independently of any TUI.
  async restore(): Promise<void> {
    // Read the source inside the queue: a TUI refresh accepted first may already have merged it.
    const refreshed = await this.serialize(async () => {
      const previous = this.saved.source;
      const source = this.launchSource ? mergeSource(previous, this.launchSource) : previous;
      // Without a remembered source, v1 paths are metadata only and never restored as candidates.
      if (!source) return ok([]);
      const result = await this.reconcile(
        source,
        true,
        this.launchAttachesChat
          ? source.settings.explicit
            ? source.settings.path
            : null
          : undefined,
      );
      if (!result.ok && this.launchAttachesChat && previous) {
        // Rejecting a new TUI must leave the last accepted workspace prepared, even across restart.
        const retained = await this.reconcile(previous, true);
        if (!retained.ok)
          this.warning = `Previous workspace recovery [${retained.error.code}]: ${retained.error.message}`;
      }
      return result;
    });
    if (!refreshed.ok) {
      this.discoveryWarning = `Workspace discovery [${refreshed.error.code}]: ${refreshed.error.message}`;
      this.emit();
    }
    this.ready = true;
    this.emit();
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);

    return next;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private hostConfig(source: WorkspaceSource): string | undefined {
    return source.settings.explicit ? source.settings.path : undefined;
  }

  private async discover(source: WorkspaceSource, config: WorkspaceConfig): Promise<Discovered> {
    const repositories = new Map<string, Repository>();
    const warnings: WireError[] = [];
    const uncertain: string[] = [];
    for (const root of config.roots) {
      const canonical = await capture(() => realpath(root));
      if (canonical.ok) this.knownRoots.set(root, canonical.value);
    }
    const scopes = config.roots.length ? [source.cwd] : sourceContexts(source);
    for (const cwd of scopes) {
      const discovered = await discoverConfiguredWorkspace(config, cwd);
      if (!discovered.ok) {
        // A deleted launch context is simply absent now; it stays remembered for reappearance.
        if (!config.roots.length && isMissingPath(discovered.error)) {
          continue;
        }

        uncertain.push(cwd, ...config.roots.map((root) => this.knownRoots.get(root) ?? root));
        warnings.push(notice(discovered.error, cwd));
        continue;
      }
      for (const repository of discovered.value.repositories) {
        repositories.set(repository.id, repository);
      }
      for (const { path, error } of discovered.value.warnings) {
        // A missing configured root is a notice, but does not make other members uncertain.
        if (!isMissingPath(error)) {
          uncertain.push(path, this.knownRoots.get(path) ?? path);
          if (error.code === "INVALID_INPUT") {
            // The directory budget may leave more than one queued subtree unscanned.
            uncertain.push(...config.roots.map((root) => this.knownRoots.get(root) ?? root));
          }
        }

        warnings.push(notice(error, path));
      }
    }

    return { repositories: [...repositories.values()], warnings, uncertain };
  }

  /**
   * Re-reads configuration, rediscovers members and applies restoration metadata.
   * Conflicts are validated before the source, catalog or registry changes.
   */
  private async reconcile(
    source: WorkspaceSource,
    startup = false,
    chatPolicy?: string | null,
  ): Promise<Result<WireError[], ExpectedError>> {
    if (this.stopped) {
      return err(new SessionError("RUNTIME_STOPPING", "Shared daemon is stopping."));
    }

    const config = await loadWorkspaceSource(source, { offline: this.offline });
    if (!config.ok) {
      return config;
    }

    const discovered = await this.discover(source, config.value);
    const policy = this.hostConfig(source);
    // Keep the existing per-repository policy guard: never silently change a running host's policy.
    for (const repository of discovered.repositories) {
      const entry = this.entries.get(repository.id);
      if (entry && entry.config !== policy) {
        return err(
          new InputError(
            `${repository.name} is already running with a different settings file. Use the original configuration or an isolated --state-dir; the workspace was not changed.`,
          ),
        );
      }
    }

    const previous = this.members ?? new Set(this.entries.keys());
    const members = new Set(discovered.repositories.map((repository) => repository.id));
    // A root failure must not look like a removal. Absence is accepted only when confirmed.
    for (const id of previous) {
      if (members.has(id) || !discovered.uncertain.length) {
        continue;
      }
      const checkouts =
        this.entries
          .get(id)
          ?.host.snapshot.repositories.flatMap((repository) =>
            repository.worktrees.map((tree) => tree.path),
          ) ?? [];
      const paths = config.value.roots.length
        ? checkouts.filter((path) =>
            config.value.roots.some((input) => {
              const root = this.knownRoots.get(input) ?? input;
              return workspacePathIsReachable(root, path, config.value.maxDepth);
            }),
          )
        : [id, ...checkouts];
      if (
        !discovered.uncertain.some((scope) =>
          paths.some((path) =>
            config.value.roots.length ? within(path, scope) : overlaps(path, scope),
          ),
        )
      ) {
        continue;
      }

      const probed = await probeRepository(id);
      if (!probed.ok || probed.value) {
        members.add(id);
      }
    }

    // A workspace attachment also intends to attach CHAT under the same policy. Check and
    // reserve that existing contract before accepting source/catalog changes, not afterward.
    if (
      chatPolicy !== undefined &&
      this.saved.chatConfig !== undefined &&
      this.saved.chatConfig !== chatPolicy
    ) {
      return err(
        new InputError(
          "CHAT is already running with a different settings file; the workspace was not changed.",
        ),
      );
    }
    const configureChat = chatPolicy !== undefined && this.saved.chatConfig === undefined;
    this.saved = { ...this.saved, source, ...(configureChat ? { chatConfig: chatPolicy } : {}) };
    if (configureChat)
      this.chat?.startRetention(
        chatPolicy ?? undefined,
        chatPolicy === null && !source.settings.explicit ? source.settings.path : undefined,
      );
    this.members = members;
    this.discoveryWarning = discovered.warnings
      .map((warning) => `Workspace discovery [${warning.code}] ${warning.message}`)
      .join(" · ");

    const failures: WireError[] = [];
    // A repository with a confirmed whole deletion is reopened only after its cleanup.
    const open = discovered.repositories.filter(
      (repository) =>
        !this.entries.has(repository.id) && !this.deletion.blocked(repository.id).whole,
    );
    await this.parallel(open, async (repository) => {
      const previous = repositoryState(this.saved, repository.id);
      const restoredConfig = previous?.implicitConfig ? undefined : (previous?.config ?? policy);
      const implicitConfig =
        restoredConfig === undefined
          ? (previous?.implicitConfig ?? source.settings.path)
          : undefined;
      const opened = await this.register(repository, restoredConfig, implicitConfig);
      if (!opened.ok) {
        failures.push(notice(opened.error, repository.name));
      }
    });
    for (const repository of discovered.repositories) {
      this.entries.get(repository.id)?.host.rediscovered(repository);
    }
    for (const [id, entry] of this.entries) {
      entry.host.setExcluded(!members.has(id));
    }

    // Restore only previously active members; cold members stay SDK-free.
    const active = [...members].flatMap((id) => {
      const entry = this.entries.get(id);

      return entry &&
        !entry.host.active &&
        !entry.host.repositoryDeleted &&
        repositoryState(this.saved, id)?.active
        ? [entry.host]
        : [];
    });
    await this.parallel(active, async (host) => {
      const activated = await host.activate();
      if (!activated.ok) {
        failures.push(notice(activated.error, "Repository restoration"));
      }
    });

    // Map iteration tolerates deleting the visited entry.
    for (const id of this.entries.keys()) {
      await this.releaseIfUnused(id);
    }

    this.warning = failures.map((failure) => `[${failure.code}] ${failure.message}`).join(" · ");
    const saved = await this.persist();
    this.emit();

    const warnings = [...discovered.warnings, ...failures];
    if (!saved.ok) {
      warnings.push({ ...notice(saved.error, "Workspace was refreshed"), outcome: "unknown" });
    }
    if (startup && warnings.length) {
      console.error(
        `[radian:workspace] ${warnings.map((warning) => `[${warning.code}] ${warning.message}`).join(" · ")}`,
      );
    }

    return ok(warnings);
  }

  private async parallel<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
    let cursor = 0;
    const outcomes = await Promise.allSettled(
      Array.from({ length: Math.min(4, items.length) }, async () => {
        while (cursor < items.length) {
          await run(items[cursor++]!);
        }
      }),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        this.warning = reportUnexpected(outcome.reason, "repository recovery");
      }
    }
  }

  // Unavailable hosts stay until their last session, editor or terminal is released.
  private async releaseIfUnused(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (
      !entry ||
      entry.host.available ||
      entry.host.retainsResources ||
      // Only its cleanup releases a deleted repository; a normal stop would checkpoint it.
      entry.host.repositoryDeleted ||
      this.stopped
    ) {
      return;
    }

    this.entries.delete(id);
    entry.unobserve();
    // Drain evidence first; untracking must not drop proof that is not yet durable.
    this.tracker.collect();
    if (!this.tracker.receipts().some((receipt) => receipt.repositoryId === id)) {
      this.tracker.untrack(id);
    }
    if (this.members?.has(id)) {
      // Confirmed missing on disk: the next workspace refresh may rediscover it.
      this.members.delete(id);
    }

    const stopped = await entry.host.stop();
    if (!stopped.ok) {
      this.warning = `Repository release failed [${stopped.error.code}]: ${stopped.error.message}`;
    }

    this.emit();
  }

  private observeHost(id: string, host: RepositoryHost): () => void {
    let scheduled = false;
    let catalog = "";

    return host.observe(() => {
      // Propagate catalog membership changes without rebroadcasting every streamed Agent update.
      const snapshot = host.snapshot;
      const next = JSON.stringify([
        snapshot.unavailableRepositories ?? [],
        snapshot.repositories.map((repo) => [repo.id, repo.worktrees.map((tree) => tree.id)]),
      ]);
      if (next !== catalog) {
        catalog = next;
        this.emit();
      }
      if (scheduled || host.available || host.retainsResources || host.repositoryDeleted) {
        return;
      }

      scheduled = true;
      void this.serialize(async () => {
        scheduled = false;
        if (this.entries.get(id)?.host === host) {
          await this.releaseIfUnused(id);
        }
      }).catch((error: unknown) => {
        this.warning = reportUnexpected(error, "repository release");
        this.emit();
      });
    });
  }

  private register(
    repository: Repository,
    config: string | undefined,
    implicitConfig?: string,
  ): Promise<Result<RepositoryHost, ExpectedError>> {
    if (this.stopped) {
      return Promise.resolve(
        err(new SessionError("RUNTIME_STOPPING", "Shared daemon is stopping.")),
      );
    }
    if (this.deletion.blocked(repository.id).whole) {
      return Promise.resolve(
        err(
          new InputError(
            "This repository was deleted and its cleanup has not finished; it was not registered.",
          ),
        ),
      );
    }

    const existing = this.entries.get(repository.id);
    if (existing) {
      return Promise.resolve(this.matchConfig(existing, config));
    }

    const pending = this.pending.get(repository.id);
    if (pending) {
      return pending.then((result) =>
        result.ok ? this.matchConfig(this.entries.get(repository.id)!, config) : result,
      );
    }

    const opening = this.openRepository(repository, config, implicitConfig).finally(() => {
      this.pending.delete(repository.id);
    });
    this.pending.set(repository.id, opening);

    return opening;
  }

  private matchConfig(
    entry: Entry,
    config: string | undefined,
  ): Result<RepositoryHost, ExpectedError> {
    return entry.config === config
      ? ok(entry.host)
      : err(
          new InputError(
            "This repository is already registered with a different settings file. Use the registered file or an isolated --state-dir; its running policy was not changed.",
          ),
        );
  }

  private async openRepository(
    repository: Repository,
    config: string | undefined,
    implicitConfig?: string,
  ): Promise<Result<RepositoryHost, ExpectedError>> {
    const opened = await RepositoryHost.open(
      repository,
      runtimePaths(repository.id, this.offline, this.stateRoot),
      this.offline,
      this.stateRoot,
      config,
      () => this.onStop(),
      () => this.persist(),
      this.accounts,
      implicitConfig,
      this.tracker,
    );
    if (!opened.ok) {
      return opened;
    }

    // Deletion confirmed while the host was opening is applied before it becomes reachable.
    const blocked = this.deletion.blocked(repository.id);
    if (blocked.whole || blocked.worktreeIds.size) {
      opened.value.fenceScope(blocked.whole ? "repository" : "worktrees", blocked.worktreeIds);
    }

    this.entries.set(repository.id, {
      host: opened.value,
      config,
      implicitConfig,
      unobserve: this.observeHost(repository.id, opened.value),
    });

    return opened;
  }

  // Low-level registration: identity-checked, and limited to current members once a source exists.
  private registerRequest(
    registration: RepositoryRegistration,
  ): Promise<Result<RepositoryHost, ExpectedError>> {
    // Wait for in-flight discovery so startup cannot admit a candidate before membership exists.
    return this.serialize(() => this.registerChecked(registration));
  }

  private async registerChecked(
    registration: RepositoryRegistration,
  ): Promise<Result<RepositoryHost, ExpectedError>> {
    if ((this.saved.source || this.launchSource) && !this.members) {
      return err(
        new InputError(
          "Workspace discovery has not succeeded; repository registration was not accepted.",
        ),
      );
    }
    const discovered = await discoverRepository(registration.cwd);
    if (!discovered.ok) {
      return discovered;
    }
    if (discovered.value.id !== registration.repositoryId) {
      return err(
        new ProtocolError(
          "Repository registration identity does not match its Git common directory.",
        ),
      );
    }
    if (this.members && !this.members.has(registration.repositoryId)) {
      return err(
        new InputError(
          "This repository is not part of the current workspace configuration. Refresh the workspace instead of registering it directly.",
        ),
      );
    }

    return this.register(discovered.value, registration.config);
  }

  private get snapshot(): RuntimeSnapshot {
    const snapshots = [...this.entries.values()].map((entry) => entry.host.snapshot);
    const unavailable = snapshots.flatMap((snapshot) => snapshot.unavailableRepositories ?? []);
    const deletedScopes = this.cleanup.deletedScopes();
    const tracking = this.tracker.lastError();

    return {
      version: protocolVersion,
      pid: process.pid,
      instance: this.instance,
      repositoryId: "radian:shared",
      mode: this.offline ? "offline" : "live",
      capabilities: [
        "shared-daemon",
        "chat-sessions",
        "history",
        "history-preview",
        "model-selection",
        "model-effort",
        "completion-catalog",
        "prompt-completion",
        "extension-arguments",
        "transcript-images",
        "prompt-images",
        "session-attention",
        "session-controls",
        "task-repair",
        "session-tab-commands",
        "session-exit",
        "agent-interrupt",
        "recursive-delegation",
        "resource-reload",
        "accounts",
        "account-labels",
        "account-reauthentication",
        "extension-ui",
        "workspace-source",
        ...(!this.ready ? ["daemon-starting"] : []),
        ...(this.stopped ? ["daemon-stopping"] : []),
      ],
      repositories: snapshots.flatMap((snapshot) => snapshot.repositories),
      ...(unavailable.length ? { unavailableRepositories: unavailable } : {}),
      ...(deletedScopes ? { deletedScopes } : {}),
      ...(this.chat ? { chat: this.chat.snapshot } : {}),
      // TUIs receive repository transcripts from repository runtimes and CHAT transcripts from
      // `chat`. Shared details carry state only, so lifecycle probes stay small.
      details: withoutTranscripts({
        ...Object.assign({}, ...snapshots.map((snapshot) => snapshot.details)),
        ...this.chat?.snapshot.details,
      }),
      preferences: structuredClone(emptyPreferences),
      closingCount:
        snapshots.reduce((total, snapshot) => total + snapshot.closingCount, 0) +
        (this.chat?.snapshot.closingCount ?? 0),
      accountsRevision: this.accounts?.revision ?? 0,
      historyRevision: this.chat?.snapshot.historyRevision ?? 0,
      extensionUi: this.chat?.extensionUi ?? [],
      editors: snapshots.flatMap((snapshot) => snapshot.editors ?? []),
      terminals: snapshots.flatMap((snapshot) => snapshot.terminals ?? []),
      terminalClosingCount: snapshots.reduce(
        (total, snapshot) => total + (snapshot.terminalClosingCount ?? 0),
        0,
      ),
      notice: [
        this.warning,
        this.discoveryWarning,
        this.deletion.notice,
        tracking ? `Deletion tracking [${tracking.code}]: ${tracking.message}` : "",
        this.chat?.notice,
        ...snapshots.map((snapshot) => snapshot.notice),
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/snapshot" && request.method === "GET") {
        const snapshot = this.snapshot;
        return Response.json(
          snapshot.chat
            ? {
                ...snapshot,
                chat: { ...snapshot.chat, details: withoutTranscripts(snapshot.chat.details) },
              }
            : snapshot,
        );
      }
      if (path === "/events" && request.method === "GET") {
        const frames = transcriptStream(request) ? new TranscriptFrames() : undefined;
        return snapshotEvents(
          () => {
            const snapshot = this.snapshot;
            if (!frames) return snapshot;
            const { details, transcripts } = frames.split(snapshot.chat?.details ?? {});
            return {
              ...snapshot,
              ...(snapshot.chat ? { chat: { ...snapshot.chat, details } } : {}),
              transcripts,
            };
          },
          (listener) => {
            this.listeners.add(listener);
            this.accounts?.setActive(true, this.instance);
            this.chat?.registry.setUiActive(true);
            return () => {
              this.listeners.delete(listener);
              this.accounts?.setActive(this.listeners.size > 0, this.instance);
              this.chat?.registry.setUiActive(this.listeners.size > 0);
            };
          },
        );
      }
      if (this.stopped) {
        return rejected(new SessionError("RUNTIME_STOPPING", "Shared daemon is stopping."));
      }

      const expected = request.headers.get("X-Radian-Instance");
      if (expected && expected !== this.instance) {
        return rejected(
          new ProtocolError("Shared daemon instance changed. No action was accepted."),
        );
      }
      if (
        [
          "/history",
          "/history/preview",
          "/models",
          "/completion-catalog",
          "/completions",
          "/images",
        ].includes(path) &&
        request.method === "GET"
      ) {
        if (expected !== this.instance)
          return rejected(new ProtocolError("Current CHAT daemon identity is required."));
        return this.chatGet(path, request);
      }
      if (
        request.method !== "POST" ||
        !["/repositories", "/workspace", "/chat-config", "/command", "/accounts"].includes(path)
      ) {
        return new Response("Not found", { status: 404 });
      }
      if (expected !== this.instance) {
        return rejected(new ProtocolError("Current shared daemon identity is required."));
      }
      if (Number(request.headers.get("content-length")) > maxFrameBytes) {
        return rejected(new InputError("Request is too large."));
      }

      const text = await request.text();
      if (Buffer.byteLength(text) > maxFrameBytes) {
        return rejected(new InputError("Request is too large."));
      }
      if (path === "/chat-config") {
        const parsed = parseJson(text, "CHAT configuration");
        if (!parsed.ok) return rejected(parsed.error);
        const value = parsed.value;
        if (
          !value ||
          typeof value !== "object" ||
          !("config" in value) ||
          !(value.config === null || typeof value.config === "string") ||
          Object.keys(value).length !== 1
        )
          return rejected(new InputError("Invalid CHAT configuration."));
        const configured = value.config ? resolve(value.config) : null;
        if (this.saved.chatConfig !== undefined && this.saved.chatConfig !== configured) {
          return rejected(
            new InputError(
              "CHAT is already running with a different settings file. Use the original configuration or an isolated --state-dir; running policy was not changed.",
            ),
          );
        }
        if (this.saved.chatConfig === undefined) {
          this.saved.chatConfig = configured;
          const saved = await this.persist();
          if (!saved.ok) return rejected(saved.error);
          this.chat?.startRetention(
            configured ?? undefined,
            configured === null && !this.saved.source?.settings.explicit
              ? this.saved.source?.settings.path
              : undefined,
          );
        }
        return Response.json({ ok: true, value: null });
      }
      if (path === "/workspace") {
        const parsed = parseJson(text, "workspace source");
        if (!parsed.ok) return rejected(parsed.error);
        if (!Value.Check(workspaceRequestSchema, parsed.value)) {
          return rejected(new InputError("Malformed workspace source."));
        }

        const { source, attachChat } = parsed.value;
        const normalized: WorkspaceSource = {
          settings: { ...source.settings, path: resolve(source.settings.path) },
          workspace: { ...source.workspace, path: resolve(source.workspace.path) },
          cwd: resolve(source.cwd),
          ...(source.contexts ? { contexts: source.contexts.map((path) => resolve(path)) } : {}),
        };
        // An explicit refresh also retries unfinished deletion cleanups.
        this.deletion.retry();
        const refreshed = await this.serialize(() =>
          this.reconcile(
            mergeSource(this.saved.source, normalized),
            false,
            attachChat
              ? normalized.settings.explicit
                ? normalized.settings.path
                : null
              : undefined,
          ),
        );
        if (!refreshed.ok) return rejected(refreshed.error);

        return Response.json({
          ok: true,
          value: null,
          ...(refreshed.value.length ? { warnings: refreshed.value } : {}),
        });
      }
      if (path === "/accounts") {
        const parsed = parseJson(text, "CHAT account request");
        if (!parsed.ok) return rejected(parsed.error);
        if (
          !Value.Check(accountRequestSchema, parsed.value) ||
          parsed.value.worktreeId !== CHAT_SCOPE_ID
        ) {
          return rejected(new InputError("Account request does not belong to CHAT."));
        }
        const result = await this.accounts!.handle(parsed.value, request.signal);
        return result.ok ? Response.json(result.value) : rejected(result.error);
      }
      if (path === "/repositories") {
        const json = parseJson(text, "repository registration");
        if (!json.ok) {
          return rejected(json.error);
        }
        if (!Value.Check(repositoryRegistrationSchema, json.value)) {
          return rejected(new InputError("Malformed repository registration."));
        }

        const registration = {
          ...json.value,
          ...(json.value.config ? { config: resolve(json.value.config) } : {}),
        };
        const registered = await this.registerRequest(registration);
        if (!registered.ok) {
          return rejected(registered.error);
        }

        const saved = await this.persist();

        return Response.json({
          ok: true,
          value: null,
          ...(!saved.ok
            ? {
                warnings: [
                  { code: saved.error.code, message: saved.error.message, outcome: "unknown" },
                ],
              }
            : {}),
        });
      }

      const command = parseCommand(text);
      if (!command.ok) {
        return rejected(command.error);
      }
      if (command.value.type === "stop") {
        setTimeout(() => this.onStop(), 20);
        return Response.json({ ok: true, value: null });
      }
      const chat = this.chat;
      const sessionId = "sessionId" in command.value ? command.value.sessionId : undefined;
      if (
        !chat ||
        (!["chat-create", "chat-resume"].includes(command.value.type) &&
          (!sessionId || !chat.snapshot.sessions.some((entry) => entry.id === sessionId)))
      ) {
        return rejected(
          new InputError(
            "The shared endpoint only accepts CHAT commands; workspace commands require their repository endpoint.",
          ),
        );
      }
      const result = await chat.command(command.value);
      if (!result.ok) return rejected(result.error);
      return Response.json({ ok: true, value: result.value });
    } catch (error) {
      reportUnexpected(error, "shared daemon request");

      return Response.json(
        {
          ok: false,
          error: {
            code: "REMOTE_INTERNAL_ERROR",
            message: "Unexpected shared daemon failure. Action outcome may be unknown.",
            outcome: "unknown",
          },
        },
        { status: 500 },
      );
    }
  }

  private async chatGet(path: string, request: Request): Promise<Response> {
    if (!this.chat) return rejected(new SessionError("RUNTIME_STOPPING", "CHAT is unavailable."));
    const params = new URL(request.url).searchParams;
    const query = Object.fromEntries(params);
    if (path === "/history") {
      if (params.get("worktreeId") !== CHAT_SCOPE_ID)
        return rejected(new InputError("Missing CHAT scope."));
      const result = await this.chat.listHistory(request.signal);
      return result.ok ? Response.json(result.value) : rejected(result.error);
    }
    if (path === "/history/preview") {
      if (!Value.Check(historyPreviewQuerySchema, query) || query.worktreeId !== CHAT_SCOPE_ID)
        return rejected(new InputError("Invalid CHAT preview identity."));
      const result = await this.chat.previewHistory(query.savedId, request.signal);
      return result.ok ? Response.json(result.value) : rejected(result.error);
    }
    if (path === "/models") {
      if (!Value.Check(modelCatalogQuerySchema, query))
        return rejected(new InputError("Invalid CHAT model query."));
      const result = await this.chat.registry.models(
        query.sessionId,
        query.conversationId,
        request.signal,
        params.get("refresh") === "true",
      );
      return result.ok ? Response.json(result.value) : rejected(result.error);
    }
    if (path === "/completion-catalog") {
      if (!Value.Check(completionCatalogQuerySchema, query))
        return rejected(new InputError("Invalid CHAT completion catalog query."));
      const result = this.chat.registry.catalog(query.sessionId, query.conversationId);
      return result.ok ? Response.json(result.value) : rejected(result.error);
    }
    if (path === "/completions") {
      if (!Value.Check(completionQuerySchema, query))
        return rejected(new InputError("Invalid CHAT completion query."));
      const result = await this.chat.registry.complete(query.sessionId, query, request.signal);
      return result.ok ? Response.json(result.value) : rejected(result.error);
    }
    if (!Value.Check(transcriptImageQuerySchema, query))
      return rejected(new InputError("Invalid CHAT image identity."));
    const result = this.chat.registry.imageData(query.sessionId, query.imageId);
    return result.ok
      ? new Response(result.value.bytes, {
          headers: {
            "Content-Type": result.value.mimeType,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        })
      : rejected(result.error);
  }

  // Restoration metadata only: entries never become candidates without discovery.
  private persist(): Promise<Result<void, ExpectedError>> {
    let registry = this.saved;
    for (const [repositoryId, { host, config, implicitConfig }] of this.entries) {
      const previous = repositoryState(registry, repositoryId);
      registry = withRepositoryState(registry, {
        repositoryId,
        active: host.active || previous?.active === true,
        ...(config ? { config } : {}),
        ...(implicitConfig ? { implicitConfig } : {}),
        ...(previous?.cwd ? { cwd: previous.cwd } : {}),
      });
    }

    this.saved = registry;

    return this.store.save(registry).then((result) => {
      if (!result.ok) {
        this.warning = `Shared daemon registry persistence failed: ${result.error.message}`;
      }

      return result;
    });
  }

  async stop(): Promise<Result<void, ExpectedError>> {
    this.stopped = true;
    await Promise.allSettled(this.pending.values());
    await this.queue;
    // Record every confirmed deletion durably before resources stop; phases resume on restart.
    this.tracker.collect();
    await this.deletion.idle();
    const unrecorded = this.tracker.close();
    if (unrecorded.length) {
      console.error(
        `[radian:workspace-cleanup] ${unrecorded.length} deletion receipt(s) were not recorded; their data was retained.`,
      );
    }

    // Persist active intent before any repository releases its resources.
    const saved = this.loaded ? await this.persist() : ok(undefined);
    const stopped = await collectCleanup(
      [
        Promise.resolve(saved),
        ...[...this.entries.values()].map((entry) => {
          entry.unobserve();

          return entry.host.stop();
        }),
        ...(this.chat ? [this.chat.stop()] : []),
      ],
      "Shared daemon shutdown failed.",
    );
    this.unsubscribeAccounts?.();
    const accounts = this.accounts ? await this.accounts.stop() : ok(undefined);

    return collectCleanup(
      [Promise.resolve(stopped), Promise.resolve(accounts)],
      "Shared daemon account shutdown failed.",
    );
  }
}
