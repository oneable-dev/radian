import type { WorkspaceClient } from "../runtime/workspace-client.ts";
import type { ModelCatalog } from "../agents/model-selection.ts";
import type { AccountsCatalog, AccountReply, AccountRequest } from "../accounts/model.ts";
import type { HistoryItem } from "../agents/history.ts";
import { HistoryPreviewCache } from "../agents/history-preview-cache.ts";
import { CancelledError, SessionError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

type Loader<T> = (signal: AbortSignal) => Promise<Result<T, ExpectedError>>;

type Entry<T> = {
  identity: string;
  abort: AbortController;
  ready: Promise<Result<T, ExpectedError>>;
  result?: Result<T, ExpectedError>;
};

// Attached-UI caches share requests across popup lifetimes, not across connections.
class Catalogs<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly changed: () => void,
    private readonly unexpected: (error: unknown) => void,
  ) {}

  read(key: string, identity: string | undefined): Result<T, ExpectedError> | undefined {
    const entry = this.entries.get(key);

    return entry?.identity === identity ? entry?.result : undefined;
  }

  load(
    key: string,
    identity: string | undefined,
    loader: Loader<T>,
    force = false,
  ): Promise<Result<T, ExpectedError>> {
    // Older services keep on-demand reads until they can publish invalidation events.
    if (identity === undefined) {
      return loader(new AbortController().signal);
    }

    const previous = this.entries.get(key);
    if (!force && previous?.identity === identity) {
      return previous.ready;
    }

    previous?.abort.abort();

    const abort = new AbortController();
    const ready = Promise.resolve()
      .then(() => loader(abort.signal))
      .then((result) => {
        if (abort.signal.aborted || this.entries.get(key) !== entry) {
          return err(new CancelledError("Preloaded data became stale."));
        }

        entry.result = result;
        this.changed();

        return result;
      });
    const entry: Entry<T> = { identity, abort, ready };

    this.entries.set(key, entry);
    void ready.catch(this.unexpected);

    return ready;
  }

  set(key: string, identity: string | undefined, value: T): void {
    if (identity === undefined) {
      return;
    }

    this.entries.get(key)?.abort.abort();

    const result = ok(value);
    this.entries.set(key, {
      identity,
      abort: new AbortController(),
      ready: Promise.resolve(result),
      result,
    });
    this.changed();
  }

  retain(keys: ReadonlySet<string>): void {
    for (const [key, entry] of this.entries) {
      if (!keys.has(key)) {
        entry.abort.abort();
        this.entries.delete(key);
      }
    }
  }

  dispose(): void {
    this.retain(new Set());
  }
}

type Client = Pick<
  WorkspaceClient,
  | "snapshot"
  | "dataIdentity"
  | "completionIdentity"
  | "models"
  | "accounts"
  | "listHistory"
  | "previewHistory"
>;

export class PreloadedData {
  private readonly models: Catalogs<ModelCatalog>;
  private readonly accounts: Catalogs<AccountsCatalog>;
  private readonly history: Catalogs<readonly HistoryItem[]>;
  readonly previews: HistoryPreviewCache;
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(
    private readonly client: Client,
    unexpected: (error: unknown) => void,
  ) {
    this.models = new Catalogs(this.emit, unexpected);
    this.accounts = new Catalogs(this.emit, unexpected);
    this.history = new Catalogs(this.emit, unexpected);
    this.previews = new HistoryPreviewCache(
      (tree, id, signal) => client.previewHistory(tree, id, signal),
      () => {},
      (error) => {
        unexpected(error);

        return "Unexpected history preview failure. Inspect runtime.log.";
      },
    );
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  private emit = (): void => {
    if (!this.disposed) {
      for (const listener of this.listeners) {
        listener();
      }
    }
  };

  private treeFor(id: string): string | undefined {
    return this.client.snapshot.repositories
      .flatMap((repo) => repo.worktrees)
      .find((tree) => tree.sessions.some((session) => session.id === id))?.id;
  }

  private modelIdentity(
    id: string,
    scope = this.client.dataIdentity(this.treeFor(id) ?? "", "models"),
    state = this.client.snapshot.details[id],
  ): string | undefined {
    if (scope === undefined) {
      return undefined;
    }

    return JSON.stringify([
      scope,
      this.client.completionIdentity(id),
      state?.telemetry?.provider,
      state?.telemetry?.model,
      state?.telemetry?.effort,
    ]);
  }

  preloadModels(): void {
    if (this.disposed) {
      return;
    }

    const ids = new Set<string>();
    const snapshot = this.client.snapshot;
    for (const repo of snapshot.repositories) {
      for (const tree of repo.worktrees) {
        const scope = this.client.dataIdentity(tree.id, "models");
        if (scope === undefined) {
          continue;
        }
        for (const session of tree.sessions) {
          const state = snapshot.details[session.id];
          const conversation = state?.conversationId;
          if (!conversation) {
            continue;
          }

          ids.add(session.id);
          void this.models.load(
            session.id,
            this.modelIdentity(session.id, scope, state),
            (signal) => this.client.models(session.id, conversation, signal),
          );
        }
      }
    }

    this.models.retain(ids);
  }

  preloadAccounts(): void {
    if (this.disposed) {
      return;
    }

    const ids = new Set<string>();
    for (const repo of this.client.snapshot.repositories) {
      for (const tree of repo.worktrees) {
        if (this.client.dataIdentity(tree.id, "accounts") === undefined) {
          continue;
        }

        ids.add(tree.id);
        void this.accountCatalog(tree.id);
      }
    }

    this.accounts.retain(ids);
  }

  preloadHistory(): void {
    if (this.disposed) {
      return;
    }

    const ids = new Set<string>();
    for (const repo of this.client.snapshot.repositories) {
      for (const tree of repo.worktrees) {
        if (this.client.dataIdentity(tree.id, "history") === undefined) {
          continue;
        }

        ids.add(tree.id);
        void this.listHistory(tree.id);
      }
    }

    this.history.retain(ids);
    this.previews.retain(ids);
  }

  cachedModels = (
    id: string,
    conversation: string,
  ): Result<ModelCatalog, ExpectedError> | undefined => {
    if (this.client.snapshot.details[id]?.conversationId !== conversation) {
      return undefined;
    }

    return this.models.read(id, this.modelIdentity(id));
  };

  listModels = (
    id: string,
    conversation: string,
    signal?: AbortSignal,
    refresh = false,
  ): Promise<Result<ModelCatalog, ExpectedError>> =>
    waitFor(
      this.models.load(
        id,
        this.modelIdentity(id),
        (abort) => this.client.models(id, conversation, abort, refresh),
        refresh,
      ),
      signal,
    );

  cachedAccounts = (tree: string): Result<AccountsCatalog, ExpectedError> | undefined =>
    this.accounts.read(tree, this.client.dataIdentity(tree, "accounts"));

  private accountCatalog(
    tree: string,
    refresh = false,
  ): Promise<Result<AccountsCatalog, ExpectedError>> {
    return this.accounts.load(
      tree,
      this.client.dataIdentity(tree, "accounts"),
      async (signal) => {
        const result = await this.client.accounts({ type: "list", worktreeId: tree }, signal);
        if (!result.ok) {
          return result;
        } else if (result.value.kind === "catalog") {
          return ok(result.value.catalog);
        } else {
          return err(
            new SessionError("SESSION_CONFLICT", "Account listing returned a login flow."),
          );
        }
      },
      refresh,
    );
  }

  requestAccounts = async (
    request: AccountRequest,
    signal?: AbortSignal,
    refresh = false,
  ): Promise<Result<AccountReply, ExpectedError>> => {
    if (request.type === "list") {
      const result = await waitFor(this.accountCatalog(request.worktreeId, refresh), signal);

      return result.ok ? ok({ kind: "catalog", catalog: result.value }) : result;
    }

    const result = await this.client.accounts(request, signal);
    if (!this.disposed && result.ok && result.value.kind === "catalog") {
      this.accounts.set(
        request.worktreeId,
        this.client.dataIdentity(request.worktreeId, "accounts"),
        result.value.catalog,
      );
    }
    // Successful login completion can arrive through polling, without a catalog reply.
    if (
      !this.disposed &&
      result.ok &&
      result.value.kind === "login" &&
      result.value.login.status === "complete"
    ) {
      void this.accountCatalog(request.worktreeId, true);
    }

    return result;
  };

  cachedHistory = (tree: string): Result<readonly HistoryItem[], ExpectedError> | undefined =>
    this.history.read(tree, this.client.dataIdentity(tree, "history"));

  listHistory = (
    tree: string,
    signal?: AbortSignal,
    refresh = false,
  ): Promise<Result<readonly HistoryItem[], ExpectedError>> => {
    const identity = this.client.dataIdentity(tree, "history");
    if (refresh) {
      this.previews.preload(tree, []);
    }

    const ready = this.history.load(
      tree,
      identity,
      async (abort) => {
        const result = await this.client.listHistory(tree, abort);
        if (
          result.ok &&
          !this.disposed &&
          !abort.aborted &&
          identity === this.client.dataIdentity(tree, "history")
        ) {
          this.previews.preload(
            tree,
            result.value.map((item) => ({
              id: item.id,
              revision:
                item.revision ?? JSON.stringify([item.modified, item.messageCount, item.title]),
            })),
          );
        }

        return result;
      },
      refresh,
    );

    return waitFor(ready, signal);
  };

  reload(): void {
    if (this.disposed) {
      return;
    }

    this.models.dispose();
    this.accounts.dispose();
    this.history.dispose();
    this.previews.clear();
    this.preloadModels();
    this.preloadAccounts();
    this.preloadHistory();
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.models.dispose();
    this.accounts.dispose();
    this.history.dispose();
    this.previews.clear();
  }
}

function waitFor<T>(
  pending: Promise<Result<T, ExpectedError>>,
  signal?: AbortSignal,
): Promise<Result<T, ExpectedError>> {
  if (!signal) {
    return pending;
  }
  if (signal.aborted) {
    return Promise.resolve(err(new CancelledError()));
  }

  const cancelled = Promise.withResolvers<Result<T, ExpectedError>>();
  const abort = () => cancelled.resolve(err(new CancelledError()));

  signal.addEventListener("abort", abort, { once: true });

  return Promise.race([pending, cancelled.promise]).finally(() =>
    signal.removeEventListener("abort", abort),
  );
}
