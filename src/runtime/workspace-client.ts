import { resolve, sep } from "node:path";
import { CHAT_SCOPE_ID } from "../agents/session-scope.ts";
import type { Repository } from "../workspace/model.ts";
import {
  mergeDashboards,
  type DashboardPeriod,
  type DashboardSnapshot,
} from "../agents/dashboard.ts";
import { RepositoryWatcher } from "../workspace/repository-watcher.ts";
import {
  CancelledError,
  CapabilityError,
  collectCleanup,
  ConnectionError,
  InputError,
  SessionError,
  reportUnexpected,
  withCleanup,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { defaultPreferences, type RuntimeClient } from "./client.ts";
import {
  connectChatRuntime,
  connectRuntime,
  prepareWorkspace,
  type ConnectOptions,
} from "./lifecycle.ts";
import type { WorkspaceSource } from "./daemon-protocol.ts";
import type { RuntimePreferences, RuntimeSnapshot } from "./protocol.ts";
import { runtimePaths, RuntimeStore } from "./storage.ts";
import {
  mergeWorkspacePreferences,
  repositoryPreferences,
  scrubPreferences,
} from "./workspace-preferences.ts";
import type { ProcessResourceSample } from "../usage/process-resources.ts";
import type { WorkspaceResourceScope } from "../usage/workspace-resources.ts";

// Repository-scoped channels share a daemon process; identity fencing and PTY leases stay local.
export type RepositoryClient = Pick<
  RuntimeClient,
  | "snapshot"
  | "connected"
  | "subscribe"
  | "create"
  | "newTab"
  | "prompt"
  | "interrupt"
  | "complete"
  | "closeSession"
  | "listHistory"
  | "previewHistory"
  | "resume"
  | "savePreferences"
  | "openEditor"
  | "attachEditor"
  | "createTerminal"
  | "attachTerminal"
  | "closeTerminal"
  | "beginDetach"
  | "disconnect"
> &
  Partial<
    Pick<
      RuntimeClient,
      | "activate"
      | "image"
      | "models"
      | "selectModel"
      | "catalog"
      | "acknowledge"
      | "dashboard"
      | "resources"
      | "accounts"
      | "answerExtensionUi"
    >
  >;

type Connector = (
  repository: Repository,
  cwd: string,
  options: ConnectOptions,
) => Promise<Result<RepositoryClient | null, ExpectedError>>;

type Entry = {
  repository: Repository;
  preferences: RuntimePreferences;
  connectionVersion: number;
  client?: RepositoryClient;
  unsubscribe?: () => void;
  watcher?: RepositoryWatcher;
  discoveryWarning?: string;
  legacy?: boolean;
  pending?: Promise<Result<RepositoryClient, ExpectedError>>;
  saving?: Promise<Result<void, ExpectedError>>;
  error?: ExpectedError;
  warning?: string;
  sessions: Set<string>;
  editors: Set<string>;
  terminals: Set<string>;
};

export type WorkspaceSnapshot = Pick<
  RuntimeSnapshot,
  | "repositories"
  | "chat"
  | "details"
  | "preferences"
  | "closingCount"
  | "terminalClosingCount"
  | "notice"
  | "editors"
  | "terminals"
  | "extensionUi"
  | "deletedScopes"
>;

// Failures that leave no daemon to attach to; other refresh rejections attach with a notice.
const fatalRefreshCodes = new Set([
  "CONNECTION_FAILED",
  "CONNECTION_TIMEOUT",
  "RUNTIME_ABSENT",
  "PROTOCOL_ERROR",
]);

export class WorkspaceClient {
  private readonly entries: Entry[];
  // True when the shared daemon owns membership and this client only mirrors its catalog.
  private managed = false;
  private ready = false;
  private refreshNotice = "";
  private readonly adding = new Map<string, Promise<void>>();
  private readonly releasing = new Set<Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private preferences = defaultPreferences();
  private detaching = false;
  private recovery = 0;
  private disconnection: Promise<void> | undefined;
  private chatClient: RuntimeClient | undefined;
  private chatUnsubscribe: (() => void) | undefined;
  private chatConnectionVersion = 0;
  // Explicit deletion summaries already applied, by cleanup token. Cold, unavailable and
  // disconnected repositories are never treated as deleted.
  private readonly appliedDeletions = new Map<string, { revision: number; scrubbed: boolean }>();
  // Deleted worktree ID to the repository whose receipt deleted it. The ID is a path that another
  // repository may own now; that repository's state at the same ID is never scrubbed.
  private readonly deletedWorktrees = new Map<string, string>();
  private readonly deletedSessions = new Set<string>();

  private constructor(
    repositories: readonly Repository[],
    private readonly options: ConnectOptions,
    private readonly connect: Connector,
  ) {
    this.entries = repositories.map((repository) => this.entry(repository));
  }

  private entry(repository: Repository): Entry {
    return {
      repository,
      preferences: defaultPreferences(),
      connectionVersion: 0,
      sessions: new Set(),
      editors: new Set(),
      terminals: new Set(),
    };
  }

  // Shared daemon membership: current repositories plus unavailable ones that keep resources.
  private listedRepositories(): Map<string, Repository | null> {
    const shared = this.chatClient?.snapshot;
    const listed = new Map<string, Repository | null>(
      (shared?.repositories ?? []).map((repository) => [repository.id, repository]),
    );
    for (const id of shared?.unavailableRepositories ?? []) {
      if (!listed.has(id)) {
        listed.set(id, null);
      }
    }

    return listed;
  }

  /**
   * Applies explicit deletion summaries from the shared daemon: deleted worktrees and sessions
   * are scrubbed from memory, and later preference saves cannot write them back. A reopened
   * scope admits a fresh generation; only its old sessions stay deleted.
   */
  private applyDeletions(): void {
    const scopes = this.chatClient?.snapshot.deletedScopes?.scopes ?? [];
    const worktrees = new Map<string, string>();
    const sessionIds = new Set<string>();
    for (const scope of scopes) {
      const applied = this.appliedDeletions.get(scope.token);
      if (applied && applied.revision >= scope.revision) continue;

      const reopened = scope.state === "reopened";
      // Worktree state is scrubbed once per deletion; a reopened worktree is a new generation.
      if (!applied?.scrubbed) {
        for (const id of scope.worktreeIds) worktrees.set(id, scope.repositoryId);
      }
      for (const id of scope.worktreeIds) {
        if (reopened) this.deletedWorktrees.delete(id);
        else this.deletedWorktrees.set(id, scope.repositoryId);
      }
      for (const id of scope.sessionIds) {
        sessionIds.add(id);
        this.deletedSessions.add(id);
      }
      this.appliedDeletions.set(scope.token, { revision: scope.revision, scrubbed: true });
    }
    if (!worktrees.size && !sessionIds.size) return;

    this.preferences = scrubPreferences(this.preferences, {
      worktreeIds: this.ownedDeletions(worktrees),
      sessionIds,
    });
    for (const entry of this.entries) {
      entry.preferences = scrubPreferences(entry.preferences, {
        worktreeIds: this.ownedDeletions(worktrees, entry.repository.id),
        sessionIds,
      });
      for (const id of sessionIds) entry.sessions.delete(id);
    }
  }

  /**
   * Deleted worktree IDs whose state belongs to the deleting repository. For one repository's
   * preferences that is its own receipts; for merged preferences, an ID that no other current
   * repository lists. Keys of a repository that reuses a deleted path are kept.
   */
  private ownedDeletions(deleted: ReadonlyMap<string, string>, repositoryId?: string): Set<string> {
    const owners = new Map<string, string>();
    for (const entry of this.entries) {
      for (const tree of entry.repository.worktrees) owners.set(tree.id, entry.repository.id);
    }
    for (const repository of this.chatClient?.snapshot.repositories ?? []) {
      for (const tree of repository.worktrees) owners.set(tree.id, repository.id);
    }

    const owned = new Set<string>();
    for (const [id, deleting] of deleted) {
      const owner = repositoryId ?? owners.get(id);
      if (owner === undefined || owner === deleting) owned.add(id);
    }

    return owned;
  }

  // Mirror daemon catalog changes: connect newly prepared repositories, drop released ones.
  private syncMembership(): void {
    if (
      !this.managed ||
      !this.ready ||
      this.detaching ||
      !this.chatClient?.connected ||
      this.chatClient.snapshot.capabilities?.includes("daemon-starting")
    ) {
      return;
    }

    const listed = this.listedRepositories();
    for (const [id, repository] of listed) {
      if (!repository || this.adding.has(id) || this.entries.some((e) => e.repository.id === id)) {
        continue;
      }

      const adding = this.addEntry(repository)
        .catch((error: unknown) => {
          this.refreshNotice = reportUnexpected(error, "workspace membership");
          this.emit();
        })
        .finally(() => {
          this.adding.delete(id);
          this.syncMembership();
        });
      this.adding.set(id, adding);
    }
    const released = this.entries.filter(
      (entry) => !listed.has(entry.repository.id) && !entry.pending,
    );
    for (const entry of released) {
      this.entries.splice(this.entries.indexOf(entry), 1);
      entry.watcher?.close();
      entry.unsubscribe?.();
      const disconnected = (entry.saving ?? Promise.resolve(ok(undefined)))
        .then(() => entry.client?.disconnect())
        .catch((error: unknown) => {
          reportUnexpected(error, "released repository disconnect");
        });
      this.releasing.add(disconnected);
      void disconnected.finally(() => this.releasing.delete(disconnected));
      this.emit();
    }
  }

  private async addEntry(repository: Repository): Promise<void> {
    const entry = this.entry(repository);
    await this.load(entry);
    if (
      this.detaching ||
      this.chatClient?.snapshot.capabilities?.includes("daemon-starting") ||
      !this.listedRepositories().has(repository.id)
    ) {
      entry.unsubscribe?.();
      await entry.client?.disconnect();

      return;
    }

    this.entries.push(entry);
    // Existing workspace values win; the new repository contributes its saved drafts and views.
    this.preferences = mergeWorkspacePreferences(
      [entry.preferences, this.preferences],
      this.preferences.selection.worktreeId,
    );
    this.emit();
  }

  /**
   * Production entry point: asks the shared daemon to rediscover `source` and mirrors the
   * membership it prepared. The TUI never registers or decides a competing repository list;
   * later catalog changes arrive through the shared daemon snapshot.
   */
  static async attach(
    source: WorkspaceSource,
    options: ConnectOptions,
    connect: Connector = connectRuntime,
  ): Promise<Result<WorkspaceClient, ExpectedError>> {
    const prepared = await prepareWorkspace(source, options, true);
    let notice = "";
    if (!prepared.ok) {
      if (fatalRefreshCodes.has(prepared.error.code)) {
        return prepared;
      }

      // The refresh was rejected without changes (for example a policy conflict); show the
      // daemon's current catalog rather than inventing a local one.
      notice = `Workspace refresh [${prepared.error.code}]: ${prepared.error.message}`;
    }

    // The source is the single settings selection; CHAT and repository channels must use it too.
    const configured = { ...options, source };
    if (source.settings.explicit) configured.config = source.settings.path;
    else delete configured.config;
    return WorkspaceClient.start([], source.cwd, configured, connect, notice);
  }

  /**
   * Low-level entry point with an explicit ad hoc repository list. Each repository is
   * registered individually; production startup uses `attach` instead.
   */
  static open(
    repositories: readonly Repository[],
    cwd: string,
    options: ConnectOptions,
    connect: Connector,
  ): Promise<Result<WorkspaceClient, ExpectedError>> {
    return WorkspaceClient.start(repositories, cwd, options, connect);
  }

  private static async start(
    initial: readonly Repository[],
    cwd: string,
    options: ConnectOptions,
    connect: Connector,
    notice?: string,
  ): Promise<Result<WorkspaceClient, ExpectedError>> {
    const managed = notice !== undefined;
    const workspace = new WorkspaceClient(initial, options, connect);
    let ready = false;

    workspace.managed = managed;
    workspace.refreshNotice = notice ?? "";

    return withCleanup(
      async () => {
        if (managed || connect === connectRuntime || !initial.length) {
          const chat = await connectChatRuntime(options);
          if (!chat.ok) return chat;
          workspace.chatClient = chat.value;
          let wasConnected = chat.value.connected;
          workspace.chatUnsubscribe = chat.value.subscribe(() => {
            if (!wasConnected && chat.value.connected) {
              workspace.recovery++;
              workspace.chatConnectionVersion++;
            }
            wasConnected = chat.value.connected;
            workspace.applyDeletions();
            workspace.syncMembership();
            workspace.emit();
          });
        }
        if (managed) {
          for (const repository of workspace.listedRepositories().values()) {
            if (repository) {
              workspace.entries.push(workspace.entry(repository));
            }
          }
        }

        const repositories = workspace.entries.map((entry) => entry.repository);
        let cursor = 0;
        const loaded = await Promise.allSettled(
          Array.from({ length: Math.min(4, repositories.length) }, async () => {
            while (cursor < workspace.entries.length) {
              await workspace.load(workspace.entries[cursor++]!);
            }
          }),
        );
        const failures: unknown[] = loaded.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length) {
          throw new AggregateError(failures, "Workspace initialization failed.");
        }

        const directory = resolve(cwd);
        const current = repositories
          .flatMap((repo) => repo.worktrees)
          .filter((tree) => directory === tree.path || directory.startsWith(tree.path + sep))
          .sort((a, b) => b.path.length - a.path.length)[0];
        const preferred =
          workspace.entries.find((entry) =>
            entry.repository.worktrees.some((tree) => tree.id === current?.id),
          ) ?? workspace.entries[0];
        const remembered = preferred?.preferences.selection.worktreeId;
        const selected =
          preferred?.repository.worktrees.find((tree) => tree.id === remembered)?.id ??
          current?.id ??
          preferred?.repository.worktrees[0]?.id ??
          null;

        workspace.preferences = mergeWorkspacePreferences(
          workspace.entries.map((entry) => entry.preferences),
          selected,
        );
        workspace.appliedDeletions.clear();
        workspace.applyDeletions();
        ready = true;
        workspace.ready = true;
        workspace.syncMembership();

        return ok(workspace);
      },
      () => (ready ? Promise.resolve() : workspace.disconnect()),
    );
  }

  private async load(entry: Entry): Promise<void> {
    const saved = await new RuntimeStore(
      runtimePaths(entry.repository.id, this.options.offline ?? false, this.options.stateRoot),
    ).load(entry.repository.id);
    if (saved.ok) {
      if (saved.value) {
        entry.preferences = saved.value.preferences;
      }
    } else {
      entry.error = saved.error;
    }

    // Register metadata with the shared daemon without allocating repository execution resources.
    // A daemon-owned catalog is attached as prepared, never registered by this client.
    const connected = await this.connect(entry.repository, this.cwd(entry), {
      ...this.options,
      start: false,
      register: !this.managed,
    });
    if (!connected.ok) {
      entry.error = connected.error;
    } else if (connected.value) {
      this.bind(entry, connected.value);
    }
    if (!entry.client && !this.managed) {
      entry.watcher = new RepositoryWatcher(
        entry.repository,
        (result) => {
          if (this.detaching || entry.client) {
            return;
          }
          if (!result.ok) {
            entry.discoveryWarning = `Worktree discovery failed [${result.error.code}]: ${result.error.message}. Previous entries were retained.`;
          } else if (result.value) {
            entry.repository = result.value;
            delete entry.discoveryWarning;
          } else {
            entry.discoveryWarning = "Repository is missing; previous entries were retained.";
          }

          this.emit();
        },
        (error) => {
          entry.discoveryWarning = reportUnexpected(error, "workspace worktree discovery");
          this.emit();
        },
      );
      const watched = await entry.watcher.start();
      if (!watched.ok) {
        entry.discoveryWarning = `Worktree watching failed [${watched.error.code}]: ${watched.error.message}`;
      }
    }
  }

  get recoveryVersion(): number {
    return this.recovery;
  }

  get attentionNotice(): string {
    const legacy = this.entries
      .filter(
        (entry) =>
          entry.client && !entry.client.snapshot.capabilities?.includes("session-attention"),
      )
      .map((entry) => entry.repository.name);

    return legacy.length
      ? `Unread tracking requires updated repository services: ${legacy.join(", ")}. Finish work, then explicitly stop/restart those services. No service was restarted.`
      : "";
  }

  get retainedSessionIds(): ReadonlySet<string> {
    return new Set(
      this.entries
        .filter(
          (entry) =>
            !entry.client || entry.client.snapshot.capabilities?.includes("repository-catalog"),
        )
        .flatMap((entry) => [
          ...Object.keys(entry.preferences.drafts),
          ...Object.keys(entry.preferences.inputDrafts ?? {}),
        ]),
    );
  }

  hasSnapshot(worktreeId: string): boolean {
    return this.entries.some(
      (entry) =>
        !entry.client?.snapshot.capabilities?.includes("repository-catalog") &&
        entry.client?.snapshot.repositories.some((repo) =>
          repo.worktrees.some((tree) => tree.id === worktreeId),
        ),
    );
  }

  get snapshot(): WorkspaceSnapshot {
    const snapshots = this.entries.flatMap((entry) =>
      entry.client ? [entry.client.snapshot] : [],
    );

    return {
      repositories: this.entries.flatMap((entry) => {
        const current = entry.client?.snapshot.repositories.find(
          (repo) => repo.id === entry.repository.id,
        );
        // An unavailable daemon repository lists only rows still owned by resources.
        if (current || (this.managed && entry.client)) {
          return current ? [current] : [];
        }

        return [entry.repository];
      }),
      ...(this.chatClient?.snapshot.chat ? { chat: this.chatClient.snapshot.chat } : {}),
      ...(this.chatClient?.snapshot.deletedScopes
        ? { deletedScopes: structuredClone(this.chatClient.snapshot.deletedScopes) }
        : {}),
      details: Object.fromEntries([
        ...snapshots.flatMap((snapshot) => Object.entries(snapshot.details)),
        ...Object.entries(this.chatClient?.snapshot.chat?.details ?? {}),
      ]),
      preferences: structuredClone(this.preferences),
      closingCount:
        snapshots.reduce((count, snapshot) => count + snapshot.closingCount, 0) +
        (this.chatClient?.snapshot.chat?.closingCount ?? 0),
      terminalClosingCount: snapshots.reduce(
        (count, snapshot) => count + (snapshot.terminalClosingCount ?? 0),
        0,
      ),
      editors: snapshots.flatMap((snapshot) => snapshot.editors ?? []),
      terminals: snapshots.flatMap((snapshot) => snapshot.terminals ?? []),
      extensionUi: this.detaching
        ? []
        : [
            ...(this.chatClient?.snapshot.extensionUi ?? []),
            ...this.entries.flatMap((entry) =>
              entry.client?.connected ? (entry.client.snapshot.extensionUi ?? []) : [],
            ),
          ],
      notice: [
        this.refreshNotice,
        this.chatClient?.snapshot.notice,
        ...this.entries.flatMap((entry) => {
          const notice =
            entry.error?.message ||
            entry.warning ||
            entry.discoveryWarning ||
            entry.client?.snapshot.notice;
          const legacy = entry.legacy
            ? "A legacy repository process still owns this state. It was not stopped or migrated. Finish work, save editor buffers, then use runtime stop --legacy with --runtime-cwd to migrate."
            : "";

          return notice || legacy
            ? [`${entry.repository.name}: ${[notice, legacy].filter(Boolean).join(" · ")}`]
            : [];
        }),
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    if (!this.detaching) {
      for (const listener of this.listeners) {
        listener();
      }
    }
  }

  private cwd(entry: Entry): string {
    return entry.repository.worktrees[0]?.path ?? resolve(entry.repository.id, "..");
  }

  private bind(entry: Entry, client: RepositoryClient): void {
    entry.watcher?.close();
    entry.client = client;
    delete entry.error;
    delete entry.warning;
    delete entry.discoveryWarning;
    entry.preferences = client.snapshot.preferences;
    entry.legacy = !client.snapshot.capabilities?.includes("shared-daemon");

    let wasConnected = client.connected;
    entry.unsubscribe = client.subscribe(() => {
      if (!wasConnected && client.connected) {
        this.recovery++;
        entry.connectionVersion++;
      }

      wasConnected = client.connected;
      this.emit();
    });
  }

  private ensure(entry: Entry): Promise<Result<RepositoryClient, ExpectedError>> {
    if (this.detaching) {
      return Promise.resolve(err(new CancelledError("Workspace is detaching.")));
    }
    if (entry.client) {
      const client = entry.client;

      return client.activate
        ? client.activate().then((result) => (result.ok ? ok(client) : result))
        : Promise.resolve(ok(client));
    }

    entry.pending ??= this.connectEntry(entry).finally(() => {
      delete entry.pending;
    });

    return entry.pending;
  }

  private async connectEntry(entry: Entry): Promise<Result<RepositoryClient, ExpectedError>> {
    const connected = await this.connect(entry.repository, this.cwd(entry), {
      ...this.options,
      start: true,
    });
    if (this.detaching) {
      if (connected.ok && connected.value) {
        await connected.value.disconnect();
      }

      return err(new CancelledError("Workspace is detaching."));
    }
    if (!connected.ok) {
      entry.error = connected.error;
      this.emit();

      return connected;
    }
    if (!connected.value) {
      return err(new ConnectionError("RUNTIME_ABSENT", "Repository runtime did not start."));
    }

    this.bind(entry, connected.value);

    // Selection/view changes may have been queued before this cold repo had a client.
    const repository =
      connected.value.snapshot.repositories.find((repo) => repo.id === entry.repository.id) ??
      entry.repository;
    const scoped = repositoryPreferences(this.preferences, repository, entry.preferences, [
      ...entry.sessions,
    ]);
    const saved = await this.writePreferences(entry, connected.value, scoped);
    if (!saved.ok) {
      entry.warning = `Runtime connected; UI preference persistence failed: ${saved.error.message}`;
    }

    this.emit();

    return ok(connected.value);
  }

  async activate(worktreeId: string): Promise<Result<void, ExpectedError>> {
    const entry = this.worktreeOwner(worktreeId);
    if (!entry.ok) {
      return entry;
    }

    const client = await this.ensure(entry.value);

    return client.ok ? ok(undefined) : client;
  }

  private worktreeOwner(id: string): Result<Entry, InputError> {
    const entry = this.entries.find((entry) =>
      (entry.client?.snapshot.repositories ?? [entry.repository]).some((repo) =>
        repo.worktrees.some((tree) => tree.id === id),
      ),
    );

    return entry ? ok(entry) : err(new InputError("Worktree does not belong to this workspace."));
  }

  private chatOwner(id: string): boolean {
    return this.chatClient?.snapshot.chat?.sessions.some((session) => session.id === id) ?? false;
  }

  private sessionOwner(id: string): Result<Entry, SessionError> {
    const entry = this.entries.find(
      (entry) =>
        entry.sessions.has(id) ||
        entry.client?.snapshot.repositories.some((repo) =>
          repo.worktrees.some((tree) => tree.sessions.some((session) => session.id === id)),
        ),
    );

    return entry
      ? ok(entry)
      : err(new SessionError("SESSION_NOT_OPEN", "Session is not open in this workspace."));
  }

  async createChat(): ReturnType<RuntimeClient["createChat"]> {
    return (
      this.chatClient?.createChat() ?? err(new CapabilityError("CHAT runtime is unavailable."))
    );
  }

  async create(worktreeId: string): ReturnType<RuntimeClient["create"]> {
    if (worktreeId === CHAT_SCOPE_ID) return this.createChat();
    const entry = this.worktreeOwner(worktreeId);
    if (!entry.ok) {
      return entry;
    }

    const client = await this.ensure(entry.value);
    if (!client.ok) {
      return client;
    }

    const result = await client.value.create(worktreeId);
    if (result.ok) {
      entry.value.sessions.add(result.value);
    }

    return result;
  }

  async newTab(sessionId: string): ReturnType<RuntimeClient["newTab"]> {
    if (this.chatOwner(sessionId)) return this.chatClient!.newTab(sessionId);
    const entry = this.sessionOwner(sessionId);
    if (!entry.ok) {
      return entry;
    }

    const result = await entry.value.client!.newTab(sessionId);
    if (result.ok) {
      entry.value.sessions.add(result.value);
    }

    return result;
  }

  async resumeChat(savedId: string): ReturnType<RuntimeClient["resumeChat"]> {
    return (
      this.chatClient?.resumeChat(savedId) ??
      err(new CapabilityError("CHAT runtime is unavailable."))
    );
  }

  async resume(worktreeId: string, savedId: string): ReturnType<RuntimeClient["resume"]> {
    if (worktreeId === CHAT_SCOPE_ID) return this.resumeChat(savedId);
    const entry = this.worktreeOwner(worktreeId);
    if (!entry.ok) {
      return entry;
    }

    const client = await this.ensure(entry.value);
    if (!client.ok) {
      return client;
    }

    const result = await client.value.resume(worktreeId, savedId);
    if (result.ok) {
      entry.value.sessions.add(result.value);
    }

    return result;
  }

  get resourceScopes(): readonly WorkspaceResourceScope[] {
    return this.entries.flatMap((entry) => {
      const snapshot = entry.client?.snapshot;
      const repository =
        snapshot?.repositories.find((repo) => repo.id === entry.repository.id) ?? entry.repository;
      const owner =
        !this.detaching && entry.client?.connected && snapshot?.editors && snapshot.terminals
          ? {
              pid: snapshot.pid,
              processes: [...snapshot.editors, ...snapshot.terminals].filter(
                (item) => !item.exited,
              ),
            }
          : null;

      return repository.worktrees.map((tree) => ({
        id: tree.id,
        name: `${repository.name} / ${tree.name}`,
        roots: owner
          ? owner.processes
              .filter((item) => item.worktreeId === tree.id)
              .map((item) => ({ pid: item.pid, parentPid: owner.pid }))
          : null,
      }));
    });
  }

  async resources(signal?: AbortSignal): Promise<Result<ProcessResourceSample, ExpectedError>> {
    if (signal?.aborted || this.detaching) {
      return err(new CancelledError());
    }

    // Every repository channel shares the same daemon. Read one connected channel,
    // without activating a cold repository or summing its PID once per project.
    const client = this.entries
      .map((entry) => entry.client)
      .find(
        (client) =>
          client?.connected && client.snapshot.capabilities?.includes("process-resources"),
      );
    if (!client?.resources) {
      return err(new CapabilityError("No connected shared runtime supports process resources."));
    }

    return client.resources(signal);
  }

  async dashboard(
    days: DashboardPeriod,
    repositoryId?: string,
    signal?: AbortSignal,
  ): Promise<Result<DashboardSnapshot, ExpectedError>> {
    if (signal?.aborted || this.detaching) {
      return err(new CancelledError());
    }

    const entries = repositoryId
      ? this.entries.filter((entry) => entry.repository.id === repositoryId)
      : this.entries;
    if (!entries.length) {
      return err(new InputError("Dashboard project does not belong to this workspace."));
    }

    const snapshots: DashboardSnapshot[] = [];
    const warnings: string[] = [];
    let firstError: ExpectedError | undefined;
    for (const entry of entries) {
      if (signal?.aborted || this.detaching) {
        return err(new CancelledError());
      }

      const connected = await this.ensure(entry);
      if (signal?.aborted || this.detaching) {
        return err(new CancelledError());
      }

      const result = !connected.ok
        ? connected
        : connected.value.dashboard
          ? await connected.value.dashboard(days, signal)
          : err(new CapabilityError("This repository service does not support Agent Dashboard."));
      if (!result.ok) {
        if (result.error.code === "CANCELLED") {
          return result;
        }

        firstError ??= result.error;
        warnings.push(`${entry.repository.name}: excluded [${result.error.code}].`);
        continue;
      }

      snapshots.push(result.value);
    }
    if (!snapshots.length && firstError) {
      return err(firstError);
    }

    const merged = mergeDashboards(snapshots, days);
    merged.warnings = [...new Set([...merged.warnings, ...warnings])].slice(0, 100);

    return ok(merged);
  }

  async listChatHistory(signal?: AbortSignal): ReturnType<RuntimeClient["listChatHistory"]> {
    return (
      this.chatClient?.listChatHistory(signal) ??
      err(new CapabilityError("CHAT runtime is unavailable."))
    );
  }

  listHistory(
    worktreeId: typeof CHAT_SCOPE_ID,
    signal?: AbortSignal,
  ): ReturnType<RuntimeClient["listChatHistory"]>;
  listHistory(worktreeId: string, signal?: AbortSignal): ReturnType<RuntimeClient["listHistory"]>;
  async listHistory(
    worktreeId: string,
    signal?: AbortSignal,
  ): Promise<
    Result<
      | readonly import("./protocol.ts").ChatHistoryItem[]
      | readonly import("../agents/history.ts").HistoryItem[],
      ExpectedError
    >
  > {
    if (signal?.aborted) {
      return err(new CancelledError());
    }
    if (worktreeId === CHAT_SCOPE_ID) return this.listChatHistory(signal);

    const entry = this.worktreeOwner(worktreeId);
    if (!entry.ok) {
      return entry;
    }

    const client = await this.ensure(entry.value);
    if (signal?.aborted) {
      return err(new CancelledError());
    }

    return client.ok ? client.value.listHistory(worktreeId, signal) : client;
  }

  async previewChatHistory(
    savedId: string,
    signal?: AbortSignal,
  ): ReturnType<RuntimeClient["previewChatHistory"]> {
    return (
      this.chatClient?.previewChatHistory(savedId, signal) ??
      err(new CapabilityError("CHAT runtime is unavailable."))
    );
  }

  previewHistory(
    worktreeId: typeof CHAT_SCOPE_ID,
    savedId: string,
    signal?: AbortSignal,
  ): ReturnType<RuntimeClient["previewChatHistory"]>;
  previewHistory(
    worktreeId: string,
    savedId: string,
    signal?: AbortSignal,
  ): ReturnType<RuntimeClient["previewHistory"]>;
  async previewHistory(
    worktreeId: string,
    savedId: string,
    signal?: AbortSignal,
  ): Promise<
    Result<
      | import("./protocol.ts").ChatHistoryPreview
      | import("../agents/history-preview.ts").HistoryPreview,
      ExpectedError
    >
  > {
    if (signal?.aborted) {
      return err(new CancelledError());
    }
    if (worktreeId === CHAT_SCOPE_ID) return this.previewChatHistory(savedId, signal);

    const entry = this.worktreeOwner(worktreeId);
    if (!entry.ok) {
      return entry;
    }

    const client = await this.ensure(entry.value);
    if (!client.ok) {
      return client;
    }
    if (signal?.aborted) {
      return err(new CancelledError());
    }

    return client.value.previewHistory(worktreeId, savedId, signal);
  }

  async acknowledge(
    ...args: Parameters<RuntimeClient["acknowledge"]>
  ): ReturnType<RuntimeClient["acknowledge"]> {
    if (this.chatOwner(args[0])) return this.chatClient!.acknowledge(...args);
    const entry = this.sessionOwner(args[0]);
    if (!entry.ok) {
      return entry;
    }

    return entry.value.client?.acknowledge
      ? entry.value.client.acknowledge(...args)
      : err(new CapabilityError("This repository connection does not support session attention."));
  }

  async interrupt(
    ...args: Parameters<RuntimeClient["interrupt"]>
  ): ReturnType<RuntimeClient["interrupt"]> {
    if (this.chatOwner(args[0])) return this.chatClient!.interrupt(...args);
    const entry = this.sessionOwner(args[0]);

    return entry.ok ? entry.value.client!.interrupt(...args) : entry;
  }

  async prompt(...args: Parameters<RuntimeClient["prompt"]>): ReturnType<RuntimeClient["prompt"]> {
    if (this.chatOwner(args[0])) return this.chatClient!.prompt(...args);
    const entry = this.sessionOwner(args[0]);

    return entry.ok ? entry.value.client!.prompt(...args) : entry;
  }

  async image(...args: Parameters<RuntimeClient["image"]>): ReturnType<RuntimeClient["image"]> {
    if (this.chatOwner(args[0])) return this.chatClient!.image(...args);
    const entry = this.sessionOwner(args[0]);
    if (!entry.ok) {
      return entry;
    }

    const client = entry.value.client;

    return client?.image
      ? client.image(...args)
      : err(new CapabilityError("This repository connection does not provide image previews."));
  }

  async accounts(
    request: Parameters<RuntimeClient["accounts"]>[0],
    signal?: AbortSignal,
  ): ReturnType<RuntimeClient["accounts"]> {
    if (request.worktreeId === CHAT_SCOPE_ID)
      return (
        this.chatClient?.accounts(request, signal) ??
        err(new CapabilityError("CHAT runtime is unavailable."))
      );
    const entry = this.worktreeOwner(request.worktreeId);
    if (!entry.ok) {
      return entry;
    }

    const client = await this.ensure(entry.value);
    if (!client.ok) {
      return client;
    }

    return client.value.accounts
      ? client.value.accounts(request, signal)
      : err(new CapabilityError("This repository connection does not support account management."));
  }

  async answerExtensionUi(
    ...args: Parameters<RuntimeClient["answerExtensionUi"]>
  ): ReturnType<RuntimeClient["answerExtensionUi"]> {
    if (this.chatOwner(args[0])) return this.chatClient!.answerExtensionUi(...args);
    const entry = this.sessionOwner(args[0]);
    if (!entry.ok) {
      return entry;
    }

    return entry.value.client?.answerExtensionUi
      ? entry.value.client.answerExtensionUi(...args)
      : err(new CapabilityError("This repository connection does not host extension dialogs."));
  }

  async models(...args: Parameters<RuntimeClient["models"]>): ReturnType<RuntimeClient["models"]> {
    if (this.chatOwner(args[0])) return this.chatClient!.models(...args);
    const entry = this.sessionOwner(args[0]);
    if (!entry.ok) {
      return entry;
    }

    const client = entry.value.client;

    return client?.models
      ? client.models(...args)
      : err(new CapabilityError("This repository connection does not support model selection."));
  }

  async selectModel(
    ...args: Parameters<RuntimeClient["selectModel"]>
  ): ReturnType<RuntimeClient["selectModel"]> {
    if (this.chatOwner(args[0])) return this.chatClient!.selectModel(...args);
    const entry = this.sessionOwner(args[0]);
    if (!entry.ok) {
      return entry;
    }

    const client = entry.value.client;

    return client?.selectModel
      ? client.selectModel(...args)
      : err(new CapabilityError("This repository connection does not support model selection."));
  }

  dataIdentity(worktreeId: string, kind: "models" | "accounts" | "history"): string | undefined {
    if (worktreeId === CHAT_SCOPE_ID) {
      const snapshot = this.chatClient?.snapshot;
      return snapshot?.chat
        ? JSON.stringify([
            snapshot.instance,
            this.chatConnectionVersion,
            kind === "history" ? snapshot.chat.historyRevision : snapshot.chat.accountsRevision,
            Object.values(snapshot.chat.details).map((state) => [
              state.conversationId,
              state.resourceRevision ?? 0,
              ...(kind === "models" ? [state.telemetry?.model, state.telemetry?.effort] : []),
            ]),
          ])
        : undefined;
    }
    const entry = this.worktreeOwner(worktreeId);
    if (!entry.ok) {
      return undefined;
    }

    const snapshot = entry.value.client?.snapshot;
    // Never activate a cold repository solely to preload popup data.
    if (
      !snapshot?.capabilities?.includes("popup-preload") ||
      snapshot.capabilities.includes("repository-catalog")
    ) {
      return undefined;
    }

    const revisions = Object.values(snapshot.details).map((state) => state.resourceRevision ?? 0);

    return JSON.stringify([
      snapshot.instance,
      entry.value.connectionVersion,
      kind === "history" ? (snapshot.historyRevision ?? 0) : (snapshot.accountsRevision ?? 0),
      kind === "accounts" ? 0 : revisions,
    ]);
  }

  completionIdentity(sessionId: string): string {
    if (this.chatOwner(sessionId)) {
      const snapshot = this.chatClient!.snapshot;
      const state = snapshot.chat!.details[sessionId];
      return JSON.stringify([
        snapshot.instance,
        state?.conversationId,
        state?.resourceRevision ?? 0,
        this.chatConnectionVersion,
      ]);
    }
    const entry = this.sessionOwner(sessionId);
    if (!entry.ok) {
      return JSON.stringify([sessionId, null]);
    }

    const snapshot = entry.value.client?.snapshot;
    const state = snapshot?.details[sessionId];

    return JSON.stringify([
      snapshot?.instance,
      state?.conversationId,
      state?.resourceRevision ?? 0,
      entry.value.connectionVersion,
    ]);
  }

  async catalog(
    ...args: Parameters<RuntimeClient["catalog"]>
  ): ReturnType<RuntimeClient["catalog"]> {
    if (this.chatOwner(args[0])) return this.chatClient!.catalog(...args);
    const entry = this.sessionOwner(args[0]);
    if (!entry.ok) {
      return entry;
    }

    return entry.value.client?.catalog
      ? entry.value.client.catalog(...args)
      : err(
          new CapabilityError("This repository connection does not provide completion catalogs."),
        );
  }

  async complete(
    ...args: Parameters<RuntimeClient["complete"]>
  ): ReturnType<RuntimeClient["complete"]> {
    if (this.chatOwner(args[0])) return this.chatClient!.complete(...args);
    const entry = this.sessionOwner(args[0]);

    return entry.ok ? entry.value.client!.complete(...args) : entry;
  }

  async closeSession(id: string): ReturnType<RuntimeClient["closeSession"]> {
    if (this.chatOwner(id)) return this.chatClient!.closeSession(id);
    const entry = this.sessionOwner(id);
    if (!entry.ok) {
      return entry;
    }

    const result = await entry.value.client!.closeSession(id);
    if (result.ok) {
      entry.value.sessions.delete(id);
    }

    return result;
  }

  async openEditor(
    ...args: Parameters<RuntimeClient["openEditor"]>
  ): ReturnType<RuntimeClient["openEditor"]> {
    const entry = this.worktreeOwner(args[0]);
    if (!entry.ok) {
      return entry;
    }

    const client = await this.ensure(entry.value);
    if (!client.ok) {
      return client;
    }

    const result = await client.value.openEditor(...args);
    if (result.ok) {
      entry.value.editors.add(result.value);
    }

    return result;
  }

  async createTerminal(
    ...args: Parameters<RuntimeClient["createTerminal"]>
  ): ReturnType<RuntimeClient["createTerminal"]> {
    const entry = this.worktreeOwner(args[0]);
    if (!entry.ok) {
      return entry;
    }

    const client = await this.ensure(entry.value);
    if (!client.ok) {
      return client;
    }

    const result = await client.value.createTerminal(...args);
    if (result.ok) {
      entry.value.terminals.add(result.value);
    }

    return result;
  }

  private ptyOwner(
    id: string,
    kind: "editors" | "terminals",
  ): Result<RepositoryClient, InputError> {
    const entry = this.entries.find(
      (entry) => entry[kind].has(id) || entry.client?.snapshot[kind]?.some((pty) => pty.id === id),
    );

    return entry?.client
      ? ok(entry.client)
      : err(
          new InputError(
            `Unknown ${kind === "editors" ? "editor" : "terminal"} in this workspace.`,
          ),
        );
  }

  async attachEditor(
    ...args: Parameters<RuntimeClient["attachEditor"]>
  ): ReturnType<RuntimeClient["attachEditor"]> {
    const client = this.ptyOwner(args[0], "editors");

    return client.ok ? client.value.attachEditor(...args) : client;
  }

  async attachTerminal(
    ...args: Parameters<RuntimeClient["attachTerminal"]>
  ): ReturnType<RuntimeClient["attachTerminal"]> {
    const client = this.ptyOwner(args[0], "terminals");

    return client.ok ? client.value.attachTerminal(...args) : client;
  }

  async closeTerminal(id: string): ReturnType<RuntimeClient["closeTerminal"]> {
    const client = this.ptyOwner(id, "terminals");

    return client.ok ? client.value.closeTerminal(id) : client;
  }

  async savePreferences(preferences: RuntimePreferences): Promise<Result<void, ExpectedError>> {
    // A UI that has not processed a deletion yet must not write the deleted state back.
    this.preferences =
      this.deletedWorktrees.size || this.deletedSessions.size
        ? scrubPreferences(preferences, {
            worktreeIds: this.ownedDeletions(this.deletedWorktrees),
            sessionIds: this.deletedSessions,
          })
        : structuredClone(preferences);
    preferences = this.preferences;

    return collectCleanup(
      this.entries.flatMap((entry) => {
        if (!entry.client) {
          return [];
        }

        const repository =
          entry.client.snapshot.repositories.find((repo) => repo.id === entry.repository.id) ??
          entry.repository;
        const scoped = repositoryPreferences(preferences, repository, entry.preferences, [
          ...entry.sessions,
        ]);

        return [this.writePreferences(entry, entry.client, scoped)];
      }),
      "Some repository UI preferences could not be saved.",
    );
  }

  private writePreferences(
    entry: Entry,
    client: RepositoryClient,
    preferences: RuntimePreferences,
  ): Promise<Result<void, ExpectedError>> {
    entry.preferences = preferences;

    const saved = (entry.saving ?? Promise.resolve(ok(undefined))).then(() =>
      client.savePreferences(preferences),
    );
    entry.saving = saved;

    return saved.then((result) => {
      if (result.ok) {
        delete entry.warning;
      }

      return result;
    });
  }

  beginDetach(): void {
    if (this.detaching) {
      return;
    }

    this.detaching = true;
    this.chatUnsubscribe?.();
    this.chatClient?.beginDetach();
    for (const entry of this.entries) {
      entry.watcher?.close();
      entry.unsubscribe?.();
      entry.client?.beginDetach();
    }

    this.listeners.clear();
  }

  disconnect(): Promise<void> {
    this.beginDetach();
    this.disconnection ??= this.finishDisconnect();

    return this.disconnection;
  }

  private async finishDisconnect(): Promise<void> {
    const pending = await Promise.allSettled(
      this.entries.flatMap((entry) => (entry.pending ? [entry.pending] : [])),
    );
    const writes = await Promise.allSettled(
      this.entries.flatMap((entry) => (entry.saving ? [entry.saving] : [])),
    );
    const detached = await Promise.allSettled([
      ...this.entries.flatMap((entry) => (entry.client ? [entry.client.disconnect()] : [])),
      ...(this.chatClient ? [this.chatClient.disconnect()] : []),
    ]);
    const watchers = await Promise.allSettled(
      this.entries.flatMap((entry) => (entry.watcher ? [entry.watcher.stop()] : [])),
    );
    const released = await Promise.allSettled([...this.releasing, ...this.adding.values()]);
    const errors = [...pending, ...writes, ...detached, ...watchers, ...released].flatMap(
      (result) => (result.status === "rejected" ? [result.reason] : []),
    );
    if (errors.length) {
      throw new AggregateError(errors, "Workspace detach failed.");
    }
  }
}
