import { resolve, sep } from "node:path";
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
import type { ConnectOptions } from "./lifecycle.ts";
import type { RuntimePreferences, RuntimeSnapshot } from "./protocol.ts";
import { runtimePaths, RuntimeStore } from "./storage.ts";
import { mergeWorkspacePreferences, repositoryPreferences } from "./workspace-preferences.ts";
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
  | "details"
  | "preferences"
  | "closingCount"
  | "terminalClosingCount"
  | "notice"
  | "editors"
  | "terminals"
  | "extensionUi"
>;

export class WorkspaceClient {
  private readonly entries: Entry[];
  private readonly listeners = new Set<() => void>();
  private preferences = defaultPreferences();
  private detaching = false;
  private recovery = 0;
  private disconnection: Promise<void> | undefined;

  private constructor(
    repositories: readonly Repository[],
    private readonly options: ConnectOptions,
    private readonly connect: Connector,
  ) {
    this.entries = repositories.map((repository) => ({
      repository,
      preferences: defaultPreferences(),
      connectionVersion: 0,
      sessions: new Set(),
      editors: new Set(),
      terminals: new Set(),
    }));
  }

  static async open(
    repositories: readonly Repository[],
    cwd: string,
    options: ConnectOptions,
    connect: Connector,
  ): Promise<Result<WorkspaceClient, ExpectedError>> {
    if (!repositories.length) {
      return err(new InputError("No repositories discovered in workspace roots."));
    }

    const workspace = new WorkspaceClient(repositories, options, connect);
    let ready = false;

    return withCleanup(
      async () => {
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
          ) ?? workspace.entries[0]!;
        const remembered = preferred.preferences.selection.worktreeId;
        const selected =
          preferred.repository.worktrees.find((tree) => tree.id === remembered)?.id ??
          current?.id ??
          preferred.repository.worktrees[0]?.id ??
          null;

        workspace.preferences = mergeWorkspacePreferences(
          workspace.entries.map((entry) => entry.preferences),
          selected,
        );
        ready = true;

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
    const connected = await this.connect(entry.repository, this.cwd(entry), {
      ...this.options,
      start: false,
      register: true,
    });
    if (!connected.ok) {
      entry.error = connected.error;
    } else if (connected.value) {
      this.bind(entry, connected.value);
    }
    if (!entry.client) {
      entry.watcher = new RepositoryWatcher(
        entry.repository,
        (result) => {
          if (this.detaching || entry.client) {
            return;
          }
          if (result.ok) {
            entry.repository = result.value;
            delete entry.discoveryWarning;
          } else {
            entry.discoveryWarning = `Worktree discovery failed [${result.error.code}]: ${result.error.message}. Previous entries were retained.`;
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
      repositories: this.entries.map(
        (entry) =>
          entry.client?.snapshot.repositories.find((repo) => repo.id === entry.repository.id) ??
          entry.repository,
      ),
      details: Object.fromEntries(
        snapshots.flatMap((snapshot) => Object.entries(snapshot.details)),
      ),
      preferences: structuredClone(this.preferences),
      closingCount: snapshots.reduce((count, snapshot) => count + snapshot.closingCount, 0),
      terminalClosingCount: snapshots.reduce(
        (count, snapshot) => count + (snapshot.terminalClosingCount ?? 0),
        0,
      ),
      editors: snapshots.flatMap((snapshot) => snapshot.editors ?? []),
      terminals: snapshots.flatMap((snapshot) => snapshot.terminals ?? []),
      extensionUi: this.detaching
        ? []
        : this.entries.flatMap((entry) =>
            entry.client?.connected ? (entry.client.snapshot.extensionUi ?? []) : [],
          ),
      notice: this.entries
        .flatMap((entry) => {
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
        })
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

  async create(worktreeId: string): ReturnType<RuntimeClient["create"]> {
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

  async resume(worktreeId: string, savedId: string): ReturnType<RuntimeClient["resume"]> {
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

  async listHistory(
    worktreeId: string,
    signal?: AbortSignal,
  ): ReturnType<RuntimeClient["listHistory"]> {
    if (signal?.aborted) {
      return err(new CancelledError());
    }

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

  async previewHistory(
    worktreeId: string,
    savedId: string,
    signal?: AbortSignal,
  ): ReturnType<RuntimeClient["previewHistory"]> {
    if (signal?.aborted) {
      return err(new CancelledError());
    }

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
    const entry = this.sessionOwner(args[0]);

    return entry.ok ? entry.value.client!.interrupt(...args) : entry;
  }

  async prompt(...args: Parameters<RuntimeClient["prompt"]>): ReturnType<RuntimeClient["prompt"]> {
    const entry = this.sessionOwner(args[0]);

    return entry.ok ? entry.value.client!.prompt(...args) : entry;
  }

  async image(...args: Parameters<RuntimeClient["image"]>): ReturnType<RuntimeClient["image"]> {
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
    const entry = this.sessionOwner(args[0]);
    if (!entry.ok) {
      return entry;
    }

    return entry.value.client?.answerExtensionUi
      ? entry.value.client.answerExtensionUi(...args)
      : err(new CapabilityError("This repository connection does not host extension dialogs."));
  }

  async models(...args: Parameters<RuntimeClient["models"]>): ReturnType<RuntimeClient["models"]> {
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
    const entry = this.sessionOwner(args[0]);

    return entry.ok ? entry.value.client!.complete(...args) : entry;
  }

  async closeSession(id: string): ReturnType<RuntimeClient["closeSession"]> {
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
    this.preferences = structuredClone(preferences);

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
    const detached = await Promise.allSettled(
      this.entries.flatMap((entry) => (entry.client ? [entry.client.disconnect()] : [])),
    );
    const watchers = await Promise.allSettled(
      this.entries.flatMap((entry) => (entry.watcher ? [entry.watcher.stop()] : [])),
    );
    const errors = [...pending, ...writes, ...detached, ...watchers].flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) {
      throw new AggregateError(errors, "Workspace detach failed.");
    }
  }
}
