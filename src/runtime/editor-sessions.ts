import { Terminal as Screen } from "@xterm/headless";
import { editorScreen } from "./editor-screen.ts";
import { capture, collectCleanup, EditorError, InputError, knownError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { Repository } from "../workspace/model.ts";
import type { EditorFrame, EditorInfo } from "./protocol.ts";
import { snapshotEvents } from "./events.ts";

// The daemon owns both the PTY and its bounded VT screen. A reconnect receives a complete
// screen, not a truncated replay log that can lose buffers, colors, cursor or input modes.
class EditorSession {
  readonly id = crypto.randomUUID();
  readonly process: Bun.Subprocess;
  lease: string | null = null;
  private readonly screen: Screen;
  private readonly listeners = new Set<() => void>();
  private readonly terminal: Bun.Terminal;
  private readonly modes = new Map<number, boolean>();
  private cursorStyle = 0;
  private revision = 0;
  private cached: EditorFrame | undefined;
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private exited = false;
  private exitCode: number | null = null;
  private disposed = false;
  readonly settled: Promise<void>;

  constructor(readonly worktreeId: string, cwd: string, executable: string, clean: boolean, private readonly changed: () => void, size: { cols: number; rows: number }) {
    this.screen = new Screen({ ...size, scrollback: 0, allowProposedApi: true });
    // Retain public VT modes not exposed by xterm's buffer/modes APIs.
    for (const final of ["h", "l"]) this.screen.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
      for (const mode of params) if (typeof mode === "number" && [25, 1005, 1006, 1015, 1016].includes(mode)) this.modes.set(mode, final === "h");
      return false;
    });
    this.screen.parser.registerCsiHandler({ intermediates: " ", final: "q" }, (params) => {
      if (typeof params[0] === "number") this.cursorStyle = params[0];
      return false;
    });
    let terminal: Bun.Terminal | undefined;
    try {
      terminal = new Bun.Terminal({ ...size, name: "xterm-256color",
        data: (_terminal, bytes) => this.screen.write(new Uint8Array(bytes), () => this.invalidate()),
      });
      this.terminal = terminal;
      this.screen.onData((data) => { if (!this.terminal.closed) this.terminal.write(data); });
      this.process = Bun.spawn([executable, ...(clean ? ["--clean", "-i", "NONE"] : [])], {
        cwd, env: { ...process.env, TERM: "xterm-256color" }, terminal: this.terminal,
      });
    } catch (error) { terminal?.close(); this.screen.dispose(); throw error; }
    this.settled = this.process.exited.then((code) => {
      this.exited = true; this.exitCode = code; this.terminal.close(); this.invalidate(); this.changed();
    });
  }
  get info(): EditorInfo { return { id: this.id, worktreeId: this.worktreeId, pid: this.process.pid, exited: this.exited, exitCode: this.exitCode }; }
  frame(): EditorFrame {
    if (!this.cached) {
      const modes = [...this.modes].map(([mode, enabled]) => `\x1b[?${mode}${enabled ? "h" : "l"}`).join("");
      this.cached = { ...this.info, cols: this.screen.cols, rows: this.screen.rows, revision: this.revision,
        ansi: `${editorScreen(this.screen)}${modes}\x1b[${this.cursorStyle} q` };
    }
    return this.cached;
  }
  private invalidate(): void {
    if (this.disposed) return;
    this.revision++; this.cached = undefined;
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      for (const listener of this.listeners) listener();
    }, 16);
    this.notifyTimer.unref();
  }
  attach(lease: string): Result<Response, EditorError> {
    if (this.lease) return err(new EditorError("EDITOR_BUSY", "Editor is attached in another view. Detach that view before reconnecting."));
    this.lease = lease;
    return ok(snapshotEvents(() => this.frame(), (send) => {
      this.listeners.add(send);
      return () => { this.listeners.delete(send); if (this.lease === lease) this.lease = null; };
    }));
  }
  input(data: Uint8Array): void { this.terminal.write(data); }
  async resize(cols: number, rows: number, lease: string): Promise<void> {
    // Parse already-received output at its original dimensions before changing the PTY.
    await new Promise<void>((resolve) => this.screen.write("", resolve));
    if (this.exited) throw new EditorError("EDITOR_NOT_OPEN", "Neovim has exited.");
    if (this.lease !== lease) throw new EditorError("EDITOR_BUSY", "Editor attachment changed before resize.");
    if (cols === this.screen.cols && rows === this.screen.rows) return;
    this.screen.resize(cols, rows); this.terminal.resize(cols, rows);
    // Bun 1.4.3 can update the PTY size without notifying Neovim's TUI process.
    this.process.kill("SIGWINCH"); this.invalidate();
  }
  async dispose(): Promise<Result<void, ExpectedError>> {
    // Only explicit runtime stop (or removal of an already-exited editor) owns termination.
    const result = await capture(async () => {
      if (!this.exited) this.process.kill("SIGTERM");
      await this.settled;
    });
    if (!result.ok) return result;
    this.frame(); // Keep the final snapshot readable while other runtime cleanup is still pending.
    this.disposed = true;
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.terminal.close(); this.screen.dispose(); this.listeners.clear();
    return ok(undefined);
  }
}

export class EditorSessions {
  private readonly sessions = new Map<string, EditorSession>();
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
      const session = new EditorSession(worktreeId, worktree.path, executable, this.options.clean ?? false, this.changed, size);
      this.sessions.set(worktreeId, session); this.changed(); return ok(session.id);
    } catch (error) {
      if (!knownError(error)) throw error;
      return err(new EditorError("EDITOR_UNAVAILABLE", "Could not start Neovim in this worktree.", { cause: error }));
    }
  }
  attach(editorId: string, lease: string): Result<Response, ExpectedError> {
    const session = this.find(editorId); return session.ok ? session.value.attach(lease) : session;
  }
  detach(editorId: string, lease: string): void {
    const session = this.find(editorId);
    if (session.ok && session.value.lease === lease) session.value.lease = null;
  }
  input(editorId: string, lease: string, data: Uint8Array): Result<void, ExpectedError> {
    const session = this.owned(editorId, lease); if (!session.ok) return session;
    return this.io(() => session.value.input(data));
  }
  async resize(editorId: string, lease: string, cols: number, rows: number): Promise<Result<void, ExpectedError>> {
    const session = this.owned(editorId, lease); if (!session.ok) return session;
    return capture(() => session.value.resize(cols, rows, lease));
  }
  private io(operation: () => void): Result<void, ExpectedError> {
    try { operation(); return ok(undefined); }
    catch (error) {
      if (!knownError(error)) throw error;
      return err(new EditorError("EDITOR_UNAVAILABLE", "Editor terminal I/O failed; input was not retried.", { cause: error }));
    }
  }
  private find(id: string): Result<EditorSession, EditorError> {
    const session = [...this.sessions.values()].find((item) => item.id === id);
    return session ? ok(session) : err(new EditorError("EDITOR_NOT_OPEN", "Editor is no longer available. Open it explicitly; previous input will not be replayed."));
  }
  private owned(id: string, lease: string): Result<EditorSession, EditorError> {
    const session = this.find(id); if (!session.ok) return session;
    if (session.value.lease !== lease) return err(new EditorError("EDITOR_BUSY", "Editor attachment changed; input was not sent."));
    return session.value.info.exited ? err(new EditorError("EDITOR_NOT_OPEN", "Neovim has exited. Open Editor again explicitly.")) : session;
  }
  async stop(): Promise<Result<void, ExpectedError>> {
    this.stopping = true;
    return collectCleanup([...this.sessions.values()].map((session) => session.dispose()), "Editor cleanup failed.");
  }
}
