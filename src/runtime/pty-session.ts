import { Terminal as Screen } from "@xterm/headless";
import { terminalScreen } from "./pty-screen.ts";
import { capture, PtyError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { PtyFrame, PtyInfo } from "./protocol.ts";
import { snapshotEvents } from "./events.ts";

export type PtyLaunch = {
  argv: readonly string[];
  cwd: string;
  size: { cols: number; rows: number };
  env?: Record<string, string | undefined>;
  detached?: boolean;
  scrollback?: number;
};

// Process selection and collection policies belong to the editor/shell registries.
// This object owns one PTY, its VT state, and its exclusive input/resize attachment.
export class PtySession {
  readonly id = crypto.randomUUID();
  readonly process: Bun.Subprocess;
  lease: string | null = null;
  private readonly screen: Screen;
  private readonly listeners = new Set<() => void>();
  private readonly terminal: Bun.Terminal;
  private readonly modes = new Map<number, boolean>();
  private cursorStyle = 0;
  private revision = 0;
  private cached: PtyFrame | undefined;
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private exited = false;
  private exitCode: number | null = null;
  private disposed = false;
  readonly settled: Promise<void>;

  constructor(readonly worktreeId: string, launch: PtyLaunch, private readonly changed: () => void) {
    this.screen = new Screen({ ...launch.size, scrollback: launch.scrollback ?? 0, allowProposedApi: true });
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
      terminal = new Bun.Terminal({ ...launch.size, name: "xterm-256color",
        data: (_terminal, bytes) => this.screen.write(new Uint8Array(bytes), () => this.invalidate()),
      });
      this.terminal = terminal;
      this.screen.onData((data) => { if (!this.terminal.closed) this.terminal.write(data); });
      this.process = Bun.spawn([...launch.argv], {
        cwd: launch.cwd, env: { ...process.env, ...launch.env, TERM: "xterm-256color" }, terminal,
        ...(launch.detached ? { detached: true } : {}),
      });
    } catch (error) { terminal?.close(); this.screen.dispose(); throw error; }
    this.settled = this.process.exited.then((code) => {
      this.exited = true; this.exitCode = code; this.terminal.close(); this.invalidate(); this.changed();
    });
  }
  get info(): PtyInfo { return { id: this.id, worktreeId: this.worktreeId, pid: this.process.pid, exited: this.exited, exitCode: this.exitCode }; }
  frame(): PtyFrame {
    if (!this.cached) {
      const modes = [...this.modes].map(([mode, enabled]) => `\x1b[?${mode}${enabled ? "h" : "l"}`).join("");
      this.cached = { ...this.info, cols: this.screen.cols, rows: this.screen.rows, revision: this.revision,
        ansi: `${terminalScreen(this.screen)}${modes}\x1b[${this.cursorStyle} q` };
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
  attach(lease: string): Result<Response, PtyError> {
    if (this.lease) return err(new PtyError("PTY_BUSY", "Terminal is attached in another view. Detach that view before reconnecting."));
    this.lease = lease;
    return ok(snapshotEvents(() => this.frame(), (send) => {
      this.listeners.add(send);
      return () => { this.listeners.delete(send); if (this.lease === lease) this.lease = null; };
    }));
  }
  input(data: Uint8Array): void { this.terminal.write(data); }
  async resize(cols: number, rows: number, lease: string): Promise<void> {
    await new Promise<void>((resolve) => this.screen.write("", resolve));
    if (this.exited) throw new PtyError("PTY_NOT_OPEN", "Terminal process has exited.");
    if (this.lease !== lease) throw new PtyError("PTY_BUSY", "Terminal attachment changed before resize.");
    if (cols === this.screen.cols && rows === this.screen.rows) return;
    this.screen.resize(cols, rows); this.terminal.resize(cols, rows);
    // Bun 1.4.3 can update PTY dimensions without notifying the attached process.
    this.process.kill("SIGWINCH"); this.invalidate();
  }
  async dispose(): Promise<Result<void, ExpectedError>> {
    const result = await capture(async () => {
      if (!this.exited) this.process.kill("SIGTERM");
      await this.settled;
    });
    if (!result.ok) return result;
    this.frame(); // Keep the final snapshot readable while other cleanup is still pending.
    this.disposed = true;
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.terminal.close(); this.screen.dispose(); this.listeners.clear();
    return ok(undefined);
  }
}
