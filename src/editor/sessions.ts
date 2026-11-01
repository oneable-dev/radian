import {
  capture,
  collectCleanup,
  EditorError,
  InputError,
  knownError,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { repositorySnapshot, type RepositorySource } from "../workspace/catalog.ts";
import type { EditorInfo } from "../runtime/protocol.ts";
import { PtySession } from "../runtime/pty/session.ts";

// Keep the existing editor wire errors while the common PTY layer is domain-neutral.
function editorResult<T>(result: Result<T, ExpectedError>): Result<T, ExpectedError> {
  if (result.ok) {
    return result;
  }
  switch (result.error.code) {
    case "PTY_BUSY":
      return err(new EditorError("EDITOR_BUSY", result.error.message, { cause: result.error }));
    case "PTY_NOT_OPEN":
      return err(new EditorError("EDITOR_NOT_OPEN", result.error.message, { cause: result.error }));
    default:
      return result;
  }
}

export class EditorSessions {
  private readonly sessions = new Map<string, PtySession>();
  private stopping = false;
  private readonly opening = new Map<string, Promise<Result<string, ExpectedError>>>();
  // Removed worktrees reject opens; epochs reject launches begun for an older generation.
  private readonly fenced = new Set<string>();
  private readonly epochs = new Map<string, number>();
  private readonly destroying = new Map<string, Promise<Result<void, ExpectedError>>>();

  constructor(
    private readonly repositories: RepositorySource,
    private readonly changed: () => void,
    private readonly options: { clean?: boolean; executable?: string } = {},
  ) {}

  get infos(): EditorInfo[] {
    return [...this.sessions.values()].map((session) => session.info);
  }

  get retainedWorktreeIds(): ReadonlySet<string> {
    return new Set([
      ...[...this.sessions].flatMap(([id, session]) =>
        !session.info.exited || session.lease ? [id] : [],
      ),
      ...this.opening.keys(),
      ...this.destroying.keys(),
    ]);
  }

  /** Synchronously blocks editor opening and I/O for removed worktrees. Idempotent. */
  fenceWorktrees(worktreeIds: ReadonlySet<string>): void {
    for (const id of worktreeIds) {
      if (!this.fenced.has(id)) {
        this.fenced.add(id);
        this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
      }
    }
  }

  /**
   * Fences and terminates editors of removed worktrees, including pending launches, without
   * waiting for unsaved-buffer confirmation. Idempotent; failed editors stay retained.
   */
  async destroyWorktrees(worktreeIds: ReadonlySet<string>): Promise<Result<void, ExpectedError>> {
    this.fenceWorktrees(worktreeIds);

    return collectCleanup(
      [...worktreeIds].map((id) => this.destroyWorktree(id)),
      "Could not stop every editor of the removed worktrees.",
    );
  }

  /** Opens a new generation for destroyed worktree IDs. Refuses while old editors remain. */
  releaseWorktrees(worktreeIds: ReadonlySet<string>): Result<void, ExpectedError> {
    if ([...worktreeIds].some((id) => this.sessions.has(id) || this.retainedWorktreeIds.has(id))) {
      return err(new EditorError("EDITOR_BUSY", "The removed worktree editor is still stopping."));
    }
    for (const id of worktreeIds) {
      this.fenced.delete(id);
    }

    return ok(undefined);
  }

  private destroyWorktree(worktreeId: string): Promise<Result<void, ExpectedError>> {
    const running = this.destroying.get(worktreeId);
    if (running) {
      return running;
    }

    const task = (async (): Promise<Result<void, ExpectedError>> => {
      // A pending launch observes the epoch change and disposes its own PTY.
      await this.opening.get(worktreeId)?.catch(() => undefined);

      const session = this.sessions.get(worktreeId);
      if (!session) {
        return ok(undefined);
      }

      session.lease = null;
      const stopped = await session.terminate();
      if (stopped.ok && this.sessions.get(worktreeId) === session) {
        this.sessions.delete(worktreeId);
      }

      return stopped;
    })().finally(() => {
      this.destroying.delete(worktreeId);
      this.changed();
    });
    this.destroying.set(worktreeId, task);
    this.changed();

    return task;
  }

  private removed(): EditorError {
    return new EditorError("EDITOR_NOT_OPEN", "This worktree was removed; the editor was closed.");
  }

  open(worktreeId: string, size = { cols: 80, rows: 24 }): Promise<Result<string, ExpectedError>> {
    const pending = this.opening.get(worktreeId);
    if (pending) {
      return pending;
    }

    const task = this.openOnce(worktreeId, size).finally(() => {
      this.opening.delete(worktreeId);
      this.changed();
    });
    this.opening.set(worktreeId, task);

    return task;
  }

  private async openOnce(
    worktreeId: string,
    size: { cols: number; rows: number },
  ): Promise<Result<string, ExpectedError>> {
    if (this.stopping) {
      return err(new EditorError("EDITOR_UNAVAILABLE", "Editor runtime is stopping."));
    }
    if (this.fenced.has(worktreeId)) {
      return err(this.removed());
    }

    const epoch = this.epochs.get(worktreeId) ?? 0;
    const worktree = repositorySnapshot(this.repositories)
      .flatMap((repo) => repo.worktrees)
      .find((tree) => tree.id === worktreeId);
    if (!worktree) {
      return err(new InputError("Unknown editor worktree."));
    }

    const existing = this.sessions.get(worktreeId);
    if (existing && !existing.info.exited) {
      return ok(existing.id);
    }
    if (existing) {
      if (existing.lease) {
        return err(
          new EditorError("EDITOR_BUSY", "Detach the exited editor before opening another."),
        );
      }

      const disposed = await existing.dispose();
      if (!disposed.ok) {
        return disposed;
      }

      this.sessions.delete(worktreeId);
      if (this.stopping) {
        return err(new EditorError("EDITOR_UNAVAILABLE", "Editor runtime is stopping."));
      }
      if ((this.epochs.get(worktreeId) ?? 0) !== epoch) {
        return err(this.removed());
      }
    }

    const executable = Bun.which(this.options.executable ?? "nvim");
    if (!executable) {
      return err(
        new EditorError(
          "EDITOR_UNAVAILABLE",
          "Neovim is not installed or is not on the runtime PATH. Install nvim, then open Editor again.",
        ),
      );
    }
    try {
      const session = new PtySession(
        worktreeId,
        {
          cwd: worktree.path,
          size,
          waitForResizeOutput: true,
          argv: [executable, ...(this.options.clean ? ["--clean", "-i", "NONE", "-n"] : [])],
        },
        this.changed,
      );
      this.sessions.set(worktreeId, session);
      this.changed();

      return ok(session.id);
    } catch (error) {
      if (!knownError(error)) {
        throw error;
      }

      return err(
        new EditorError("EDITOR_UNAVAILABLE", "Could not start Neovim in this worktree.", {
          cause: error,
        }),
      );
    }
  }

  attach(editorId: string, lease: string): Result<Response, ExpectedError> {
    const session = this.find(editorId);

    return session.ok ? editorResult(session.value.attach(lease)) : session;
  }

  detach(editorId: string, lease: string): void {
    const session = this.find(editorId);
    if (session.ok && session.value.lease === lease) {
      session.value.lease = null;
      if (session.value.info.exited) {
        this.changed();
      }
    }
  }

  input(editorId: string, lease: string, data: Uint8Array): Result<void, ExpectedError> {
    const session = this.owned(editorId, lease);
    if (!session.ok) {
      return session;
    }
    try {
      session.value.input(data);

      return ok(undefined);
    } catch (error) {
      if (!knownError(error)) {
        throw error;
      }

      return err(
        new EditorError(
          "EDITOR_UNAVAILABLE",
          "Editor terminal I/O failed; input was not retried.",
          { cause: error },
        ),
      );
    }
  }

  async resize(
    editorId: string,
    lease: string,
    cols: number,
    rows: number,
  ): Promise<Result<void, ExpectedError>> {
    const session = this.owned(editorId, lease);
    if (!session.ok) {
      return session;
    }

    return editorResult(await capture(() => session.value.resize(cols, rows, lease)));
  }

  private find(id: string): Result<PtySession, EditorError> {
    const session = [...this.sessions.values()].find((item) => item.id === id);
    if (session && this.fenced.has(session.worktreeId)) {
      return err(this.removed());
    }

    return session
      ? ok(session)
      : err(
          new EditorError(
            "EDITOR_NOT_OPEN",
            "Editor is no longer available. Open it explicitly; previous input will not be replayed.",
          ),
        );
  }

  private owned(id: string, lease: string): Result<PtySession, EditorError> {
    const session = this.find(id);
    if (!session.ok) {
      return session;
    }
    if (session.value.lease !== lease) {
      return err(new EditorError("EDITOR_BUSY", "Editor attachment changed; input was not sent."));
    }

    return session.value.info.exited
      ? err(new EditorError("EDITOR_NOT_OPEN", "Neovim has exited. Open Editor again explicitly."))
      : session;
  }

  async stop(): Promise<Result<void, ExpectedError>> {
    this.stopping = true;

    return collectCleanup(
      [...this.sessions.values()].map((session) => session.dispose()),
      "Editor cleanup failed.",
    );
  }
}
