import { CancelledError, SessionError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { CompletionFileIndex } from "./completion-file-index.ts";
import {
  filterCatalog,
  type CompletionCatalog,
  type CompletionQuery,
  type CompletionResult,
} from "./completion.ts";

export type CompletionProvider = ((
  sessionId: string,
  query: CompletionQuery,
  signal: AbortSignal,
) => Promise<Result<CompletionResult, ExpectedError>>) & {
  prepare?: (sessionId: string, cwd: string) => void;
  read?: (
    sessionId: string,
    query: CompletionQuery,
  ) => Result<CompletionResult, ExpectedError> | undefined;
  subscribe?: (listener: () => void) => () => void;
  retain?: (ids: ReadonlySet<string>) => void;
};
type CatalogEntry = {
  identity: string;
  cwd: string;
  abort: AbortController;
  ready: Promise<Result<CompletionCatalog, ExpectedError>>;
  result?: Result<CompletionCatalog, ExpectedError>;
};
type Files = { index: CompletionFileIndex; ready: Promise<Result<void, ExpectedError>> };
type CatalogLoader = (
  id: string,
  signal: AbortSignal,
) => Promise<Result<CompletionCatalog, ExpectedError>>;

// Owned by the attached UI. SDK catalogs are session-scoped; filesystem indexes are
// worktree-scoped. Querying a prepared cache performs no I/O and starts no timers.
export class CompletionCache {
  readonly provider: CompletionProvider;
  private readonly sessions = new Map<string, CatalogEntry>();
  private readonly files = new Map<string, Files>();
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(
    private readonly load: CatalogLoader,
    private readonly identity: (id: string) => string,
    private readonly unexpected: (error: unknown) => void,
  ) {
    this.provider = Object.assign(this.complete, {
      prepare: this.prepare,
      read: this.read,
      subscribe: (listener: () => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      retain: this.retain,
    });
  }

  private emit = (): void => {
    if (!this.disposed) for (const listener of this.listeners) listener();
  };
  private prepare = (id: string, cwd: string): void => {
    if (this.disposed) return;
    if (!this.files.has(cwd)) {
      const index = new CompletionFileIndex(cwd, this.emit, this.unexpected),
        ready = index.refresh();
      this.files.set(cwd, { index, ready });
      void ready.catch(this.unexpected);
    }
    const identity = this.identity(id),
      previous = this.sessions.get(id);
    if (previous?.identity === identity && previous.cwd === cwd) return;
    previous?.abort.abort();
    const abort = new AbortController();
    const ready = Promise.resolve()
      .then(() => this.load(id, abort.signal))
      .then((result) => {
        if (
          this.disposed ||
          this.sessions.get(id) !== entry ||
          abort.signal.aborted ||
          this.identity(id) !== identity
        )
          return err(new CancelledError("Completion catalog became stale."));
        entry.result = result;
        this.emit();
        return result;
      });
    const entry: CatalogEntry = { identity, cwd, abort, ready };
    this.sessions.set(id, entry);
    void ready.catch(this.unexpected);
    this.emit(); // Invalidate old menu candidates before the replacement catalog arrives.
  };

  private read = (
    id: string,
    query: CompletionQuery,
  ): Result<CompletionResult, ExpectedError> | undefined => {
    if (this.disposed) return err(new CancelledError("Completion cache is closed."));
    const entry = this.sessions.get(id);
    if (!entry)
      return err(
        new SessionError(
          "SESSION_NOT_OPEN",
          "Completion resources are not prepared for this session.",
        ),
      );
    if (entry.identity !== this.identity(id)) {
      this.prepare(id, entry.cwd);
      return undefined;
    }
    if (query.kind === "file") return this.files.get(entry.cwd)?.index.read(query.query);
    const result = entry.result;
    return result ? (result.ok ? ok(filterCatalog(result.value.items, query)) : result) : undefined;
  };

  private complete = async (
    id: string,
    query: CompletionQuery,
    signal: AbortSignal,
  ): Promise<Result<CompletionResult, ExpectedError>> => {
    if (signal.aborted) return err(new CancelledError());
    const cached = this.read(id, query);
    if (cached) return cached;
    const entry = this.sessions.get(id);
    if (!entry)
      return err(
        new SessionError(
          "SESSION_NOT_OPEN",
          "Completion resources are not prepared for this session.",
        ),
      );
    const pending = query.kind === "file" ? this.files.get(entry.cwd)!.ready : entry.ready;
    const result = await waitFor<unknown>(pending, signal);
    if (!result.ok) return result;
    if (signal.aborted || this.disposed || this.sessions.get(id) !== entry)
      return err(new CancelledError());
    return (
      this.read(id, query) ??
      err(new CancelledError("Completion resources changed during preparation."))
    );
  };

  async refresh(id: string): Promise<Result<void, ExpectedError>> {
    const previous = this.sessions.get(id);
    if (!previous || this.disposed)
      return err(
        new SessionError(
          "SESSION_NOT_OPEN",
          "Completion resources are not prepared for this session.",
        ),
      );
    this.prepare(id, previous.cwd);
    const entry = this.sessions.get(id)!;
    const catalog = await entry.ready;
    if (!catalog.ok) return catalog;
    if (this.disposed || this.sessions.get(id) !== entry) return err(new CancelledError());
    const files = this.files.get(entry.cwd)!;
    files.ready = files.index.refresh();
    return files.ready;
  }

  private retain = (ids: ReadonlySet<string>): void => {
    for (const [id, entry] of this.sessions)
      if (!ids.has(id)) {
        entry.abort.abort();
        this.sessions.delete(id);
      }
    const paths = new Set([...this.sessions.values()].map((entry) => entry.cwd));
    for (const [path, files] of this.files)
      if (!paths.has(path)) {
        files.index.dispose();
        this.files.delete(path);
      }
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.sessions.values()) entry.abort.abort();
    for (const files of this.files.values()) files.index.dispose();
    this.sessions.clear();
    this.files.clear();
    this.listeners.clear();
  }
}

async function waitFor<T>(
  task: Promise<Result<T, ExpectedError>>,
  signal: AbortSignal,
): Promise<Result<T, ExpectedError>> {
  if (signal.aborted) return err(new CancelledError());
  const cancelled = Promise.withResolvers<Result<T, ExpectedError>>();
  const abort = () => cancelled.resolve(err(new CancelledError()));
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([task, cancelled.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
