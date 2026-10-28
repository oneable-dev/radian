import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import {
  InMemoryModelsStore,
  ModelsError,
  type AuthOperationOptions,
  type AuthPrompt,
  type Credential,
  type CredentialStore,
  type ModelsStore,
  type Provider,
} from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  AccountError,
  CancelledError,
  CapabilityError,
  InputError,
  ModelSelectionError,
  StorageError,
  capture,
  knownError,
  parseJson,
  reportUnexpected,
  systemCode,
  withCleanup,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { privateDirectory } from "../runtime/storage.ts";
import { UsageMonitor } from "../usage/monitor.ts";
import { openAiUsageResolver } from "../usage/providers/openai.ts";
import type {
  AccountInfo,
  AccountReply,
  AccountRequest,
  AccountsCatalog,
  LoginView,
} from "./model.ts";

const text = Type.String({ minLength: 1 });
const credentialSchema = Type.Union([
  Type.Object({
    type: Type.Literal("api_key"),
    key: Type.Optional(Type.String()),
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
  }),
  Type.Object(
    { type: Type.Literal("oauth"), access: text, refresh: Type.String(), expires: Type.Number() },
    { additionalProperties: true },
  ),
]);
const storedAccountSchema = Type.Object({
  id: text,
  provider: text,
  label: text,
  credential: credentialSchema,
});
const stateSchema = Type.Object({
  version: Type.Literal(1),
  deviceId: Type.Optional(
    Type.String({
      pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    }),
  ),
  revision: Type.Integer({ minimum: 0 }),
  accounts: Type.Array(storedAccountSchema),
  selections: Type.Record(Type.String(), Type.Record(Type.String(), text)),
  existingLabels: Type.Optional(
    Type.Record(Type.String(), Type.String({ minLength: 1, maxLength: 128 })),
  ),
});

type State = Static<typeof stateSchema>;

type StoredAccount = State["accounts"][number];

type Login = {
  worktreeId: string;
  view: LoginView;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  listeners: Set<() => void>;
  answer?: { id: string; resolve(value: string): void; reject(error: Error): void } | undefined;
  task?: Promise<void>;
};

export type WorkspaceModels = {
  runtime: ModelRuntime;
  usage: UsageMonitor;
  scope: AsyncLocalStorage<Readonly<Record<string, string>>>;
  listeners: Set<(provider: string) => void>;
  catalogs: Map<string, InMemoryModelsStore>;
  refresh?: AbortController;
  modelsKey?: string;
  modelsTask?: { key: string; ready: Promise<Result<void, ExpectedError>> };
};

const networkCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
]);
const externalAuthFailure = (error: unknown) =>
  error instanceof ModelsError ||
  error instanceof SyntaxError ||
  (error instanceof Error &&
    (error.constructor === Error ||
      (error instanceof TypeError && networkCodes.has(systemCode(error.cause) ?? ""))));

type Options = {
  offline?: boolean;
  defaultCredentials?: CredentialStore;
  providers?: readonly Provider[];
};

// One daemon-owned authority. Workspace SDK stores are views, never token copies.
export class AccountManager {
  private state: State = {
    version: 1,
    deviceId: crypto.randomUUID(),
    revision: 0,
    accounts: [],
    selections: {},
  };
  private saving: Promise<unknown> = Promise.resolve();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly workspaces = new Map<string, Promise<WorkspaceModels>>();
  private readonly modelRevisions = new Map<string, number>();
  private readonly logins = new Map<string, Login>();
  private readonly listeners = new Set<() => void>();

  get revision(): number {
    return this.state.revision;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  private active = false;
  private readonly observers = new Set<string>();
  private stopped = false;
  private persistenceWarning = "";
  private deviceIdPersisted = false;

  get warning(): string {
    return this.persistenceWarning;
  }

  private constructor(
    private readonly directory: string,
    private readonly defaults: ModelRuntime,
    private readonly options: Options,
    private readonly defaultAuthPath?: string,
  ) {}

  static async open(
    directory: string,
    options: Options = {},
  ): Promise<Result<AccountManager, ExpectedError>> {
    const prepared = await capture(() => privateDirectory(directory));
    if (!prepared.ok) {
      return prepared;
    }

    const defaultAuthPath = options.offline ? join(directory, "pi-auth.json") : undefined;
    const defaults = await ModelRuntime.create({
      ...(options.defaultCredentials
        ? { credentials: options.defaultCredentials }
        : defaultAuthPath
          ? { authPath: defaultAuthPath }
          : {}),
      ...(options.offline ? { modelsPath: null } : {}),
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
    });
    for (const provider of options.providers ?? []) {
      defaults.registerNativeProvider(provider);
    }

    const manager = new AccountManager(directory, defaults, options, defaultAuthPath);
    const read = await capture(() => readFile(join(directory, "accounts.json"), "utf8"));
    if (!read.ok) {
      return read.error instanceof StorageError && read.error.systemCode === "ENOENT"
        ? ok(manager)
        : read;
    }

    const parsed = parseJson(read.value, "accounts");
    if (!parsed.ok || !Value.Check(stateSchema, parsed.value)) {
      return err(new StorageError("Invalid account storage. The original file was not replaced."));
    }

    const state = parsed.value;
    if (new Set(state.accounts.map((account) => account.id)).size !== state.accounts.length) {
      return err(new StorageError("Duplicate account IDs in account storage."));
    }

    manager.state = { ...state, deviceId: state.deviceId ?? crypto.randomUUID() };
    manager.deviceIdPersisted = state.deviceId !== undefined;

    return ok(manager);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.saving.then(operation);
    // A failed write must not poison future recovery; every caller still observes its own rejection.
    this.saving = task.then(
      () => {},
      () => {},
    );

    return task;
  }

  private lock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const task = (this.locks.get(key) ?? Promise.resolve()).then(operation);
    const tail = task.then(
      () => {},
      () => {},
    );

    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) {
        this.locks.delete(key);
      }
    });

    return task;
  }

  private async commit(next: State, publish = true): Promise<Result<void, ExpectedError>> {
    const saved = await capture(async () => {
      const target = join(this.directory, "accounts.json");
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;

      await withCleanup(
        async () => {
          await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
          await rename(temporary, target);
        },
        () => rm(temporary, { force: true }),
      );
    });
    if (saved.ok) {
      this.state = next;
      this.deviceIdPersisted = true;
      this.persistenceWarning = "";
      if (publish) {
        for (const listener of this.listeners) {
          listener();
        }
      }
    }

    return saved;
  }

  private selection(
    worktreeId: string,
    provider: string,
    view?: Pick<WorkspaceModels, "scope">,
  ): string | undefined {
    return (view?.scope.getStore() ?? this.state.selections[worktreeId])?.[provider];
  }

  private account(id: string, provider?: string): StoredAccount {
    const account = this.state.accounts.find(
      (account) => account.id === id && (!provider || account.provider === provider),
    );
    if (!account) {
      throw new AccountError(
        "ACCOUNT_NOT_FOUND",
        "The selected account no longer exists. Select an account explicitly; default authentication was not used.",
      );
    }

    return account;
  }

  private info(account: StoredAccount): AccountInfo {
    return {
      id: account.id,
      provider: account.provider,
      label: account.label,
      type: account.credential.type,
      usedBy: Object.entries(this.state.selections)
        .filter(([, providers]) => providers[account.provider] === account.id)
        .map(([worktree]) => worktree),
    };
  }

  private async existingAccount(
    provider: Provider,
  ): Promise<
    Result<NonNullable<AccountsCatalog["existingAccounts"]>[number] | undefined, ExpectedError>
  > {
    let auth: Awaited<ReturnType<ModelRuntime["checkAuth"]>>;
    try {
      auth = await this.defaults.checkAuth(provider.id);
    } catch (error) {
      const expected = knownError(error);
      if (expected) {
        return err(expected);
      }
      if (error instanceof ModelsError) {
        return err(
          new AccountError(
            "ACCOUNT_LOGIN_FAILED",
            "Could not check an existing account connection.",
            { cause: error },
          ),
        );
      }

      throw error;
    }

    const label = this.state.existingLabels?.[provider.id];

    return ok(
      auth
        ? {
            provider: provider.id,
            name: provider.name,
            type: auth.type,
            ...(label ? { label } : {}),
          }
        : undefined,
    );
  }

  async catalog(worktreeId: string): Promise<AccountsCatalog> {
    const { runtime } = await this.workspace(worktreeId);
    // Availability checks discover configured credentials without refreshing OAuth tokens.
    // Supported login providers belong to Add account, not the connected-account list.
    const connections = await Promise.all(
      this.defaults.getProviders().map((provider) => this.existingAccount(provider)),
    );
    const existingAccounts = connections.flatMap((result) =>
      result.ok && result.value ? [result.value] : [],
    );
    const incomplete = connections.some((result) => !result.ok);

    return {
      revision: this.state.revision,
      worktreeId,
      selections: { ...this.state.selections[worktreeId] },
      accounts: this.state.accounts.map((account) => this.info(account)),
      existingAccounts,
      ...(incomplete
        ? {
            warning:
              "Some existing connections could not be checked. Refresh to retry; saved accounts are still available.",
          }
        : {}),
      providers: runtime
        .getProviders()
        .map((provider) => ({
          id: provider.id,
          name: provider.name,
          methods: [
            ...(provider.auth.oauth
              ? [
                  {
                    id: "oauth" as const,
                    name: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
                  },
                ]
              : []),
            ...(provider.auth.apiKey?.login
              ? [{ id: "api_key" as const, name: provider.auth.apiKey.name }]
              : []),
          ],
        }))
        .filter((provider) => provider.methods.length > 0),
    };
  }

  private async defaultCredential(
    provider: string,
    options?: AuthOperationOptions,
    refresh = false,
  ): Promise<Credential | undefined> {
    // Status reads must not refresh every stored OAuth account during workspace creation.
    // Actual refresh and command-backed key resolution stay behind Pi's file-locking SDK.
    const read = () =>
      this.options.defaultCredentials
        ? this.options.defaultCredentials.read(provider, options)
        : readStoredCredential(provider, this.defaultAuthPath);
    const stored = await read();
    if (!refresh && !(stored?.type === "api_key" && stored.key?.startsWith("!"))) {
      return stored;
    }

    let auth: Awaited<ReturnType<ModelRuntime["getAuth"]>>;
    try {
      auth = await this.defaults.getAuth(provider, options);
    } catch (error) {
      if (options?.signal?.aborted) {
        throw new CancelledError();
      }
      if (externalAuthFailure(error)) {
        throw new AccountError(
          "ACCOUNT_LOGIN_FAILED",
          "Could not resolve the existing account connection. Check the provider login.",
          { cause: error },
        );
      }

      throw error;
    }

    const latest = await read();
    if (latest?.type === "oauth") {
      return latest;
    }

    return auth
      ? {
          type: "api_key",
          ...(auth.auth.apiKey !== undefined ? { key: auth.auth.apiKey } : {}),
          ...(auth.env ? { env: auth.env } : {}),
        }
      : undefined;
  }

  private credentials(worktreeId: string, view: Pick<WorkspaceModels, "scope">): CredentialStore {
    const read = async (
      provider: string,
      options?: AuthOperationOptions,
    ): Promise<Credential | undefined> => {
      if (options?.signal?.aborted) {
        throw new CancelledError();
      }

      const id = this.selection(worktreeId, provider, view);

      return id
        ? structuredClone(this.account(id, provider).credential)
        : this.defaultCredential(provider, options);
    };

    return {
      read,
      list: async (options) => {
        const entries = new Map(
          (await this.defaults.listCredentials(options)).map((entry) => [entry.providerId, entry]),
        );
        for (const [provider, id] of Object.entries(
          view.scope.getStore() ?? this.state.selections[worktreeId] ?? {},
        )) {
          entries.set(provider, {
            providerId: provider,
            type: this.account(id, provider).credential.type,
          });
        }

        return [...entries.values()];
      },
      modify: (provider, fn, options) => {
        // Capture BEFORE waiting for the lock: switching to B cannot redirect A's refresh write.
        const id = this.selection(worktreeId, provider, view);

        return this.lock(id ?? `pi:${provider}`, async () => {
          if (options?.signal?.aborted) {
            throw new CancelledError();
          }

          const current = id
            ? structuredClone(this.account(id, provider).credential)
            : await this.defaultCredential(provider, options, true);
          let next: Credential | undefined;
          try {
            next = await fn(current);
          } catch (error) {
            if (options?.signal?.aborted) {
              throw new CancelledError();
            }
            if (externalAuthFailure(error)) {
              throw new AccountError(
                "ACCOUNT_LOGIN_FAILED",
                "Could not refresh the selected account. Open /accounts to check its authentication.",
                { cause: error },
              );
            }

            throw error;
          }
          if (!next || JSON.stringify(next) === JSON.stringify(current)) {
            return current;
          }
          if (!Value.Check(credentialSchema, next)) {
            throw new AccountError(
              "ACCOUNT_LOGIN_FAILED",
              "The provider returned an unsupported refreshed credential.",
            );
          }
          if (!id) {
            throw new CapabilityError(
              "Existing credentials are managed outside Radian. Add an account instead.",
            );
          }

          const saved = await this.serialize(async () => {
            this.account(id, provider);

            const state = structuredClone(this.state);
            state.accounts.find((account) => account.id === id)!.credential = next;
            state.revision++;

            const persisted = await this.commit(state);
            if (!persisted.ok) {
              // OAuth rotation already happened remotely. Preserve the new token in the one
              // authoritative in-memory store; pretending to roll back would lose the account.
              this.state = state;
              this.persistenceWarning =
                "Account credentials refreshed in memory, but saving failed. Keep this daemon running and repair account storage before restarting.";
            }

            return persisted;
          });
          if (!saved.ok && saved.error.code !== "STORAGE_FAILED") {
            throw saved.error;
          }

          this.notifyCredential(id, provider);

          return structuredClone(next);
        });
      },
      delete: async () => {
        throw new CapabilityError("Use AccountManager to delete an account explicitly.");
      },
    };
  }

  workspace(worktreeId: string): Promise<WorkspaceModels> {
    let pending = this.workspaces.get(worktreeId);
    if (!pending) {
      pending = this.createWorkspace(worktreeId);
      this.workspaces.set(worktreeId, pending);
      void pending.catch(() => {
        if (this.workspaces.get(worktreeId) === pending) {
          this.workspaces.delete(worktreeId);
        }
      });
    }

    return pending;
  }

  private async createWorkspace(worktreeId: string): Promise<WorkspaceModels> {
    const scope = new AsyncLocalStorage<Readonly<Record<string, string>>>();
    const catalogs = new Map<string, InMemoryModelsStore>();
    const view = { scope };
    const store = (provider: string) => {
      const key = `${provider}\0${this.selection(worktreeId, provider, view) ?? "pi"}`;
      let stored = catalogs.get(key);
      if (!stored) {
        stored = new InMemoryModelsStore();
        catalogs.set(key, stored);
      }

      return stored;
    };
    const modelsStore: ModelsStore = {
      read: (provider, options) => store(provider).read(provider, options),
      write: (provider, entry, options) => store(provider).write(provider, entry, options),
      delete: (provider, options) => store(provider).delete(provider, options),
    };
    const runtime = await scope.run({ ...this.state.selections[worktreeId] }, () =>
      ModelRuntime.create({
        credentials: this.credentials(worktreeId, view),
        modelsStore,
        ...(this.options.offline ? { modelsPath: null } : {}),
        allowModelNetwork: false,
      }),
    );
    for (const provider of this.options.providers ?? []) {
      runtime.registerNativeProvider(provider);
    }

    const usage = new UsageMonitor(openAiUsageResolver(runtime));
    usage.setActive(this.active);

    return { runtime, usage, scope, catalogs, listeners: new Set() };
  }

  setActive(active: boolean, owner = "app"): void {
    if (active) {
      this.observers.add(owner);
    } else {
      this.observers.delete(owner);
    }

    active = this.observers.size > 0;
    this.active = active;
    for (const pending of this.workspaces.values()) {
      void pending
        .then((view) => view.usage.setActive(active))
        .catch((error) => reportUnexpected(error, "account usage activation"));
    }
  }

  private notifyCredential(id: string, provider: string): void {
    for (const [worktreeId, pending] of this.workspaces) {
      if (this.selection(worktreeId, provider) === id) {
        void pending
          .then((view) => {
            view.usage.invalidate(provider);
            for (const listener of view.listeners) {
              listener(provider);
            }
          })
          .catch((error) => reportUnexpected(error, "account credential update"));
      }
    }
  }

  // The callback runs in a pinned selection context for its entire asynchronous request.
  async request<T>(
    worktreeId: string,
    operation: (runtime: ModelRuntime, identity: (provider: string) => string) => Promise<T>,
  ): Promise<T> {
    const view = await this.workspace(worktreeId);
    const selections = { ...this.state.selections[worktreeId] };

    return view.scope.run(selections, () =>
      operation(view.runtime, (provider) =>
        this.selectionIdentity(worktreeId, provider, selections),
      ),
    );
  }

  invalidateModels(worktreeId: string): void {
    this.modelRevisions.set(worktreeId, (this.modelRevisions.get(worktreeId) ?? 0) + 1);
  }

  async refreshModels(
    worktreeId: string,
    signal?: AbortSignal,
  ): Promise<Result<void, ExpectedError>> {
    if (signal?.aborted) {
      return err(new CancelledError());
    }

    const view = await this.workspace(worktreeId);
    const selections = Object.keys(this.state.selections[worktreeId] ?? {})
      .sort()
      .map((provider) => [provider, this.selectionIdentity(worktreeId, provider)]);
    const key = JSON.stringify([selections, this.modelRevisions.get(worktreeId) ?? 0]);
    if (view.modelsKey === key) {
      return ok(undefined);
    }
    if (view.modelsTask?.key === key) {
      return view.modelsTask.ready;
    }

    view.refresh?.abort();

    const controller = (view.refresh = new AbortController());
    // Popup closure must not cancel metadata shared by other sessions or attached UIs.
    const ready = view.scope
      .run(
        { ...this.state.selections[worktreeId] },
        async (): Promise<Result<void, ExpectedError>> => {
          const result = await view.runtime.refresh({
            allowNetwork: !this.options.offline,
            signal: controller.signal,
          });
          if (result.aborted || controller.signal.aborted) {
            return err(new CancelledError("Model metadata refresh was superseded or cancelled."));
          }
          if (result.errors.size) {
            return err(
              new ModelSelectionError(
                "Could not refresh model metadata for the selected authentication. The account selection and running conversations were retained.",
              ),
            );
          }

          view.modelsKey = key;

          return ok(undefined);
        },
      )
      .finally(() => {
        if (view.modelsTask?.ready === ready) {
          delete view.modelsTask;
        }
      });

    view.modelsTask = { key, ready };

    return ready;
  }

  selectionIdentity(
    worktreeId: string,
    provider: string,
    selections = this.state.selections[worktreeId],
  ): string {
    const id = selections?.[provider];

    return id
      ? `${id}:${createHash("sha256")
          .update(JSON.stringify(this.account(id, provider).credential))
          .digest("hex")}`
      : "pi";
  }

  transportScope(sessionId: string, auth: unknown): string {
    return `${sessionId}:auth:${createHash("sha256").update(JSON.stringify(auth)).digest("hex").slice(0, 32)}`;
  }

  private async select(
    request: Extract<AccountRequest, { type: "select" }>,
  ): Promise<Result<string | undefined, ExpectedError>> {
    const saved = await this.serialize(async () => {
      if (request.revision !== this.state.revision) {
        return err(
          new AccountError(
            "ACCOUNT_CONFLICT",
            "Accounts changed. Refresh before applying the selection.",
          ),
        );
      }
      if (
        request.accountId &&
        !this.state.accounts.some(
          (account) => account.id === request.accountId && account.provider === request.provider,
        )
      ) {
        return err(
          new AccountError("ACCOUNT_NOT_FOUND", "That account is not available for this provider."),
        );
      }

      const state = structuredClone(this.state);
      const selected = (state.selections[request.worktreeId] ??= {});
      if (request.accountId) {
        selected[request.provider] = request.accountId;
      } else {
        delete selected[request.provider];
      }

      state.revision++;

      return this.commit(state, false);
    });
    if (!saved.ok) {
      return saved;
    }

    const view = await this.workspace(request.worktreeId);
    view.refresh?.abort();
    view.refresh = new AbortController();

    const result = await view.scope.run({ ...this.state.selections[request.worktreeId] }, () =>
      view.runtime.refresh({
        providers: [request.provider],
        allowNetwork: false,
        signal: view.refresh!.signal,
      }),
    );
    // Publish only after the selected-authentication view is ready for background readers.
    view.usage.invalidate(request.provider);
    for (const listener of view.listeners) {
      listener(request.provider);
    }
    for (const listener of this.listeners) {
      listener();
    }

    return ok(
      result.errors.size || result.aborted
        ? "Account selected, but model metadata refresh did not finish. Reopen /model before selecting a model; the account change was not rolled back."
        : undefined,
    );
  }

  private async rename(
    request: Extract<AccountRequest, { type: "rename" }>,
  ): Promise<Result<void, ExpectedError>> {
    const label = request.label.trim();
    if (!label || label.length > 128) {
      return err(new InputError("Account label must contain 1–128 characters."));
    }

    return this.serialize(async () => {
      if (request.revision !== this.state.revision) {
        return err(
          new AccountError(
            "ACCOUNT_CONFLICT",
            "Accounts changed. Refresh before renaming an account.",
          ),
        );
      }
      if (request.accountId === null) {
        const provider = this.defaults.getProvider(request.provider);
        if (!provider) {
          return err(
            new AccountError("ACCOUNT_NOT_FOUND", "That provider is no longer available."),
          );
        }

        const connection = await this.existingAccount(provider);
        if (!connection.ok) {
          return connection;
        }
        if (!connection.value) {
          return err(
            new AccountError(
              "ACCOUNT_NOT_FOUND",
              "That existing connection is no longer available.",
            ),
          );
        }

        const state = structuredClone(this.state);
        (state.existingLabels ??= {})[request.provider] = label;
        state.revision++;

        return this.commit(state);
      }

      const state = structuredClone(this.state);
      const account = state.accounts.find(
        (account) => account.id === request.accountId && account.provider === request.provider,
      );
      if (!account) {
        return err(
          new AccountError("ACCOUNT_NOT_FOUND", "That account is not available for this provider."),
        );
      }

      account.label = label;
      state.revision++;

      return this.commit(state);
    });
  }

  private remove(
    request: Extract<AccountRequest, { type: "delete" }>,
  ): Promise<Result<void, ExpectedError>> {
    return this.lock(request.accountId, () =>
      this.serialize(async () => {
        if (request.revision !== this.state.revision) {
          return err(
            new AccountError(
              "ACCOUNT_CONFLICT",
              "Accounts changed. Refresh before deleting an account.",
            ),
          );
        }

        const account = this.state.accounts.find((account) => account.id === request.accountId);
        if (!account) {
          return err(new AccountError("ACCOUNT_NOT_FOUND", "That account no longer exists."));
        }
        if (this.info(account).usedBy.length) {
          return err(
            new AccountError(
              "ACCOUNT_IN_USE",
              "This account is used by a worktree. Switch every affected worktree to another connected account before deleting it.",
            ),
          );
        }

        const state = structuredClone(this.state);
        state.accounts = state.accounts.filter((account) => account.id !== account.id);
        state.revision++;

        return this.commit(state);
      }),
    );
  }

  async handle(
    request: AccountRequest,
    signal?: AbortSignal,
  ): Promise<Result<AccountReply, ExpectedError>> {
    if (this.stopped) {
      return err(new CancelledError("Account manager is stopping."));
    }
    if (signal?.aborted) {
      return err(new CancelledError());
    }
    switch (request.type) {
      case "list":
        return ok({
          kind: "catalog",
          catalog: await this.catalog(request.worktreeId),
          ...(this.persistenceWarning ? { warning: this.persistenceWarning } : {}),
        });
      case "select": {
        const selected = await this.select(request);

        return selected.ok
          ? ok({
              kind: "catalog",
              catalog: await this.catalog(request.worktreeId),
              ...(selected.value ? { warning: selected.value } : {}),
            })
          : selected;
      }
      case "rename": {
        const renamed = await this.rename(request);

        return renamed.ok
          ? ok({ kind: "catalog", catalog: await this.catalog(request.worktreeId) })
          : renamed;
      }
      case "delete": {
        const removed = await this.remove(request);

        return removed.ok
          ? ok({ kind: "catalog", catalog: await this.catalog(request.worktreeId) })
          : removed;
      }
      case "login":
        return this.begin(request);
      default: {
        const flow = this.logins.get(request.flowId);
        if (!flow || flow.worktreeId !== request.worktreeId) {
          return err(
            new AccountError(
              "ACCOUNT_NOT_FOUND",
              "This login is no longer available. Start a new login.",
            ),
          );
        }
        if (request.type === "cancel") {
          this.cancel(flow);
        } else if (request.type === "answer") {
          if (flow.view.status !== "pending" || flow.answer?.id !== request.promptId) {
            return err(
              new AccountError(
                "ACCOUNT_CONFLICT",
                "That login prompt has expired. Wait for the current step.",
              ),
            );
          }
          if (
            flow.view.prompt?.type === "select" &&
            !flow.view.prompt.options?.some((option) => option.id === request.value)
          ) {
            return err(new InputError("Choose one of the supported login options."));
          }

          const answer = flow.answer;
          flow.answer = undefined;
          delete flow.view.prompt;
          this.publish(flow);
          answer.resolve(request.value);
        } else if (flow.view.revision <= request.revision && flow.view.status === "pending") {
          await this.wait(flow, signal);
        }

        return ok({ kind: "login", login: structuredClone(flow.view) });
      }
    }
  }

  private publish(flow: Login): void {
    flow.view.revision++;
    const listeners = [...flow.listeners];
    for (const listener of listeners) {
      listener();
    }
  }

  private wait(flow: Login, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        flow.listeners.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, 25000);

      flow.listeners.add(done);
      signal?.addEventListener("abort", done, { once: true });
      if (signal?.aborted) {
        done();
      }
    });
  }

  private cancel(flow: Login): void {
    if (flow.view.status !== "pending") {
      return;
    }

    flow.controller.abort();
    flow.answer?.reject(new CancelledError());
    flow.answer = undefined;
    delete flow.view.prompt;
    flow.view.status = "cancelled";
    flow.view.events = [];
    this.publish(flow);
  }

  private prompt(flow: Login, prompt: AuthPrompt): Promise<string> {
    if (flow.controller.signal.aborted || prompt.signal?.aborted) {
      return Promise.reject(new CancelledError());
    }

    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const cleanup = () => {
        flow.controller.signal.removeEventListener("abort", cancel);
        prompt.signal?.removeEventListener("abort", cancel);
      };
      const cancel = () => {
        cleanup();
        if (flow.answer?.id === id) {
          flow.answer = undefined;
          delete flow.view.prompt;
          this.publish(flow);
        }

        reject(new CancelledError());
      };

      flow.answer = {
        id,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      flow.view.prompt =
        prompt.type === "select"
          ? {
              id,
              type: prompt.type,
              message: prompt.message,
              options: prompt.options.map((option) => ({ ...option })),
            }
          : {
              id,
              type: prompt.type,
              message: prompt.message,
              ...(prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}),
            };
      flow.controller.signal.addEventListener("abort", cancel, { once: true });
      prompt.signal?.addEventListener("abort", cancel, { once: true });
      this.publish(flow);
    });
  }

  private async begin(
    request: Extract<AccountRequest, { type: "login" }>,
  ): Promise<Result<AccountReply, ExpectedError>> {
    if (!request.label.trim()) {
      return err(new InputError("Account label must not be blank."));
    }
    if (this.options.offline && !this.options.providers) {
      return err(new CapabilityError("Live account login is disabled in the offline fixture."));
    }
    if ([...this.logins.values()].some((flow) => flow.view.status === "pending")) {
      return err(
        new AccountError(
          "ACCOUNT_CONFLICT",
          "Another account login is in progress. Finish or cancel it first.",
        ),
      );
    }

    const { runtime } = await this.workspace(request.worktreeId);
    const provider = runtime.getProvider(request.provider);
    if (!this.deviceIdPersisted) {
      const saved = await this.serialize(() => this.commit(this.state));
      if (!saved.ok) {
        return saved;
      }
    }
    if ([...this.logins.values()].some((flow) => flow.view.status === "pending")) {
      return err(
        new AccountError(
          "ACCOUNT_CONFLICT",
          "Another account login is in progress. Finish or cancel it first.",
        ),
      );
    }

    const method = request.method === "oauth" ? provider?.auth.oauth : provider?.auth.apiKey;
    if (!method?.login) {
      return err(
        new CapabilityError(
          "This provider does not support that interactive authentication method.",
        ),
      );
    }

    const id = crypto.randomUUID();
    const controller = new AbortController();
    const flow: Login = {
      worktreeId: request.worktreeId,
      view: { id, revision: 0, status: "pending", events: [] },
      controller,
      listeners: new Set(),
      timer: setTimeout(
        () => {
          this.cancel(flow);
          this.logins.delete(id);
        },
        15 * 60 * 1000,
      ),
    };

    this.logins.set(id, flow);
    flow.task = (async () => {
      let credential: Credential;
      try {
        credential = await method.login!(
          {
            signal: controller.signal,
            prompt: (prompt) => this.prompt(flow, prompt),
            notify: (event) => {
              if (flow.view.status !== "pending") {
                return;
              }
              if (event.type === "auth_url") {
                flow.view.events.push({
                  message: event.instructions ?? "Complete login in your browser.",
                  url: event.url,
                });
              } else if (event.type === "device_code") {
                flow.view.events.push({
                  message: `Open the URL and enter this device code.${event.expiresInSeconds ? ` Expires in ${Math.ceil(event.expiresInSeconds / 60)} minute(s).` : ""}`,
                  url: event.verificationUri,
                  code: event.userCode,
                });
              } else if (event.type === "info") {
                flow.view.events.push({ message: event.message });
                for (const link of event.links ?? []) {
                  flow.view.events.push({ message: link.label ?? "Login link", url: link.url });
                }
              } else {
                flow.view.events.push({ message: event.message });
              }

              flow.view.events = flow.view.events.slice(-16);
              this.publish(flow);
            },
          },
          { agentName: "radian", getDeviceId: () => this.state.deviceId! },
        );
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        // Provider OAuth implementations have an exception-based, untyped external-failure contract.
        // Never forward token responses, authorization codes or SDK error messages to shared logs/UI.
        if (!externalAuthFailure(error) && !knownError(error)) {
          throw error;
        }

        flow.view.status = "error";
        flow.view.error =
          "Login failed. Check the provider, connection and selected login method, then try again.";
        delete flow.view.prompt;
        this.publish(flow);

        return;
      }
      if (controller.signal.aborted || flow.view.status !== "pending") {
        return;
      }

      const saved = await this.serialize(async () => {
        if (controller.signal.aborted) {
          return err(new CancelledError());
        }
        if (!Value.Check(credentialSchema, credential)) {
          return err(
            new AccountError(
              "ACCOUNT_LOGIN_FAILED",
              "Provider returned an unsupported credential.",
            ),
          );
        }
        if (
          credential.type === "oauth" &&
          typeof credential.accountId === "string" &&
          credential.accountId.trim() &&
          this.state.accounts.some(
            (account) =>
              account.provider === request.provider &&
              account.credential.type === "oauth" &&
              "accountId" in account.credential &&
              account.credential.accountId === credential.accountId,
          )
        ) {
          return err(
            new AccountError(
              "ACCOUNT_CONFLICT",
              "That provider account is already saved. Use the existing account; to replace its login, first switch affected worktrees away and delete the old local account.",
            ),
          );
        }

        const account: StoredAccount = {
          id: crypto.randomUUID(),
          provider: request.provider,
          label: request.label.trim(),
          credential,
        };
        const state = structuredClone(this.state);

        state.accounts.push(account);
        state.revision++;

        const saved = await this.commit(state);

        return saved.ok ? ok(account) : saved;
      });
      if (saved.ok) {
        flow.view.status = "complete";
        flow.view.account = this.info(saved.value);
      } else {
        flow.view.status = "error";
        flow.view.error =
          saved.error.code === "ACCOUNT_CONFLICT"
            ? saved.error.message
            : `[${saved.error.code}] Could not save the new account. Existing accounts and selections were retained.`;
      }

      flow.view.events = [];
      delete flow.view.prompt;
      this.publish(flow);
    })().catch((error) => {
      reportUnexpected(error, "account login");
      flow.view.status = "error";
      flow.view.error = "Unexpected login failure. Inspect runtime.log.";
      delete flow.view.prompt;
      this.publish(flow);
    });

    return ok({ kind: "login", login: structuredClone(flow.view) });
  }

  async stop(): Promise<Result<void, ExpectedError>> {
    this.stopped = true;
    this.listeners.clear();
    for (const flow of this.logins.values()) {
      this.cancel(flow);
      clearTimeout(flow.timer);
    }

    await Promise.all([...this.logins.values()].flatMap((flow) => (flow.task ? [flow.task] : [])));
    this.logins.clear();

    const views = await Promise.all(this.workspaces.values());
    for (const view of views) {
      view.refresh?.abort();
      view.listeners.clear();
    }

    await Promise.all(views.flatMap((view) => (view.modelsTask ? [view.modelsTask.ready] : [])));
    await Promise.all(views.map((view) => view.usage.stop()));
    await this.saving;

    return this.persistenceWarning ? this.commit(this.state) : ok(undefined);
  }
}
