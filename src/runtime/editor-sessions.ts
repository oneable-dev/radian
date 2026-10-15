import { capture, collectCleanup, EditorError, InputError, knownError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { Repository } from "../workspace/model.ts";
import type { EditorInfo } from "./protocol.ts";
import { PtySession } from "./pty-session.ts";

// Keep the existing editor wire errors while the common PTY layer is domain-neutral.
function editorResult<T>(result: Result<T, ExpectedError>): Result<T, ExpectedError> {
  if (result.ok) return result;
  switch (result.error.code) {
    case "PTY_BUSY": return err(new EditorError("EDITOR_BUSY", result.error.message, { cause: result.error }));
    case "PTY_NOT_OPEN": return err(new EditorError("EDITOR_NOT_OPEN", result.error.message, { cause: result.error }));
    default: return result;
  }
}
export class EditorSessions {
  private readonly sessions = new Map<string, PtySession>();
  private stopping = false;
  private readonly opening = new Map<string, Promise<Result<string, ExpectedError>>>();
  constructor(private readonly repositories: readonly Repository[], private readonly changed: () => void,
    private readonly options: { clean?: boolean; executable?: string } = {}) {}
  get infos(): EditorInfo[] { return [...this.sessions.values()].map((session) => session.info); }

  open(worktreeId: string, size = { cols: 80, rows: 24 }): Promise<Result<string, ExpectedError>> {
    const pending = this.opening.get(worktreeId); if (pending) return pending;
    const task = this.openOnce(worktreeId, size).finally(() => this.opening.delete(worktreeId));
    this.opening.set(worktreeId, task); return task;
  }
  private async openOnce(worktreeId: string, size: { cols: number; rows: number }): Promise<Result<string, ExpectedError>> {
    if (this.stopping) return err(new EditorError("EDITOR_UNAVAILABLE", "Editor runtime is stopping."));
    const worktree = this.repositories.flatMap((repo) => repo.worktrees).find((tree) => tree.id === worktreeId);
    if (!worktree) return err(new InputError("Unknown editor worktree."));
    const existing = this.sessions.get(worktreeId);
    if (existing && !existing.info.exited) return ok(existing.id);
    if (existing) {
      if (existing.lease) return err(new EditorError("EDITOR_BUSY", "Detach the exited editor before opening another."));
      const disposed = await existing.dispose(); if (!disposed.ok) return disposed;
      this.sessions.delete(worktreeId);
      if (this.stopping) return err(new EditorError("EDITOR_UNAVAILABLE", "Editor runtime is stopping."));
    }
    const executable = Bun.which(this.options.executable ?? "nvim");
    if (!executable) return err(new EditorError("EDITOR_UNAVAILABLE", "Neovim is not installed or is not on the runtime PATH. Install nvim, then open Editor again."));
    try {
      const session = new PtySession(worktreeId, { cwd: worktree.path, size,
        argv: [executable, ...(this.options.clean ? ["--clean", "-i", "NONE"] : [])] }, this.changed);
      this.sessions.set(worktreeId, session); this.changed(); return ok(session.id);
    } catch (error) {
      if (!knownError(error)) throw error;
      return err(new EditorError("EDITOR_UNAVAILABLE", "Could not start Neovim in this worktree.", { cause: error }));
    }
  }
  attach(editorId: string, lease: string): Result<Response, ExpectedError> {
    const session = this.find(editorId); return session.ok ? editorResult(session.value.attach(lease)) : session;
  }
  detach(editorId: string, lease: string): void {
    const session = this.find(editorId);
    if (session.ok && session.value.lease === lease) session.value.lease = null;
  }
  input(editorId: string, lease: string, data: Uint8Array): Result<void, ExpectedError> {
    const session = this.owned(editorId, lease); if (!session.ok) return session;
    try { session.value.input(data); return ok(undefined); }
    catch (error) {
      if (!knownError(error)) throw error;
      return err(new EditorError("EDITOR_UNAVAILABLE", "Editor terminal I/O failed; input was not retried.", { cause: error }));
    }
  }
  async resize(editorId: string, lease: string, cols: number, rows: number): Promise<Result<void, ExpectedError>> {
    const session = this.owned(editorId, lease); if (!session.ok) return session;
    return editorResult(await capture(() => session.value.resize(cols, rows, lease)));
  }
  private find(id: string): Result<PtySession, EditorError> {
    const session = [...this.sessions.values()].find((item) => item.id === id);
    return session ? ok(session) : err(new EditorError("EDITOR_NOT_OPEN", "Editor is no longer available. Open it explicitly; previous input will not be replayed."));
  }
  private owned(id: string, lease: string): Result<PtySession, EditorError> {
    const session = this.find(id); if (!session.ok) return session;
    if (session.value.lease !== lease) return err(new EditorError("EDITOR_BUSY", "Editor attachment changed; input was not sent."));
    return session.value.info.exited ? err(new EditorError("EDITOR_NOT_OPEN", "Neovim has exited. Open Editor again explicitly.")) : session;
  }
  async stop(): Promise<Result<void, ExpectedError>> {
    this.stopping = true;
    return collectCleanup([...this.sessions.values()].map((session) => session.dispose()), "Editor cleanup failed.");
  }
}
