import { Terminal as Screen } from "@xterm/headless";
import { terminalScreen } from "./screen.ts";
import { terminalText } from "./text.ts";
import { capture, PtyError, type ExpectedError } from "../../errors.ts";
import { err, ok, type Result } from "../../result.ts";
import { maxFrameBytes, type PtyFrame, type PtyInfo, type TerminalText } from "../protocol.ts";
import { snapshotEvents } from "../events.ts";

export type PtyLaunch = {
  argv: readonly string[];
  cwd: string;
  size: { cols: number; rows: number };
  env?: Record<string, string | undefined>;
  detached?: boolean;
  scrollback?: number;
  waitForResizeOutput?: boolean;
  ipc?: (message: unknown) => void;
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
  private resizeFrame: PtyFrame | undefined;
  private readonly waitForResizeOutput: boolean;
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private exited = false;
  private exitCode: number | null = null;
  private disposed = false;
  readonly settled: Promise<void>;

  constructor(readonly worktreeId: string, launch: PtyLaunch, private readonly changed: () => void) {
    this.screen = new Screen({ ...launch.size, scrollback: launch.scrollback ?? 0, allowProposedApi: true });
    this.waitForResizeOutput = launch.waitForResizeOutput ?? false;
    for (const final of ["h", "l"]) this.screen.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
      for (const mode of params) if (typeof mode === "number" && [25, 1005, 1006, 1015, 1016].includes(mode)) this.modes.set(mode, final === "h");
      return false;
    });
    this.screen.parser.registerCsiHandler({ intermediates: " ", final: "q" }, (params) => {
      if (typeof params[0] === "number") this.cursorStyle = params[0];
      return false;
    });
    let terminal: Bun.Terminal | undefined;
    let child: Bun.Subprocess | undefined;
    try {
      // Creating the PTY through spawn establishes a controlling terminal. Reusing a
      // separately allocated Bun.Terminal can leave shell job control unavailable.
      child = Bun.spawn([...launch.argv], {
        cwd: launch.cwd, env: { ...process.env, ...launch.env, TERM: "xterm-256color" },
        terminal: { ...launch.size, name: "xterm-256color", data: (_terminal, bytes) => this.screen.write(new Uint8Array(bytes), () => {
          this.resizeFrame = undefined; this.invalidate();
        }) },
        ...(launch.detached ? { detached: true } : {}),
        ...(launch.ipc ? { ipc: (message: unknown) => launch.ipc?.(message) } : {}),
      });
      this.process = child; terminal = child.terminal;
      if (!terminal) throw new Error("Bun did not allocate the requested PTY.");
      this.terminal = terminal;
      this.screen.onData((data) => { if (!this.terminal.closed) this.terminal.write(data); });
    } catch (error) {
      if (child?.exitCode === null) child.kill("SIGTERM");
      terminal?.close(); this.screen.dispose(); throw error;
    }
    this.settled = this.process.exited.then((code) => {
      this.finish(code); this.terminal.close();
    });
  }
  finish(code: number): void {
    if (this.exited) return;
    this.exited = true; this.exitCode = code; this.resizeFrame = undefined; this.invalidate(); this.changed();
  }
  get info(): PtyInfo { return { id: this.id, worktreeId: this.worktreeId, pid: this.process.pid, exited: this.exited, exitCode: this.exitCode }; }
  frame(): PtyFrame {
    if (this.resizeFrame) return this.resizeFrame;
    if (!this.cached) {
      const modes = [...this.modes].map(([mode, enabled]) => `\x1b[?${mode}${enabled ? "h" : "l"}`).join("");
      const buffer = this.screen.buffer.active, offset = buffer.baseY - buffer.viewportY;
      this.cached = { ...this.info, cols: this.screen.cols, rows: this.screen.rows, revision: this.revision,
        ansi: `${terminalScreen(this.screen)}${modes}\x1b[${this.cursorStyle} q${offset ? "\x1b[?25l" : ""}`,
        scrollback: { offset, available: buffer.baseY, enabled: (this.screen.options.scrollback ?? 0) > 0 && buffer.type === "normal" && this.screen.modes.mouseTrackingMode === "none" } };
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
  input(data: Uint8Array): void {
    const focusEvent = data.length === 3 && data[0] === 27 && data[1] === 91 && (data[2] === 73 || data[2] === 79);
    if (!focusEvent && this.screen.buffer.active.viewportY !== this.screen.buffer.active.baseY) { this.screen.scrollToBottom(); this.invalidate(); }
    this.terminal.write(data);
  }
  async read(lease: string): Promise<Result<TerminalText, PtyError>> {
    await new Promise<void>((resolve) => this.screen.write("", resolve));
    if (this.lease !== lease) return err(new PtyError("PTY_BUSY", "Terminal attachment changed before reading output."));
    const text = terminalText(this.screen);
    if (Buffer.byteLength(JSON.stringify(text)) > maxFrameBytes / 2) return err(new PtyError("PTY_UNAVAILABLE", "Terminal output exceeds the copy-mode snapshot limit."));
    return ok(text);
  }
  async scroll(lines: number, lease: string): Promise<void> {
    await new Promise<void>((resolve) => this.screen.write("", resolve));
    if (this.lease !== lease) throw new PtyError("PTY_BUSY", "Terminal attachment changed before scrolling.");
    this.screen.scrollLines(lines); this.invalidate();
  }
  async resize(cols: number, rows: number, lease: string): Promise<void> {
    await new Promise<void>((resolve) => this.screen.write("", resolve));
    if (this.lease !== lease) throw new PtyError("PTY_BUSY", "Terminal attachment changed before resize.");
    if (cols === this.screen.cols && rows === this.screen.rows) return;
    // Resizing the emulator is not an application redraw. Editors retain the last
    // complete snapshot until new process output has passed through the VT parser.
    if (this.waitForResizeOutput && !this.exited) this.resizeFrame ??= this.frame();
    this.screen.resize(cols, rows);
    if (this.exited) { this.invalidate(); return; }
    this.terminal.resize(cols, rows);
    // Bun 1.4.3 can update PTY dimensions without notifying the attached process.
    this.process.kill("SIGWINCH");
    if (!this.resizeFrame) this.invalidate();
  }
  async dispose(): Promise<Result<void, ExpectedError>> {
    const result = await capture(async () => {
      if (this.process.exitCode === null) this.process.kill("SIGTERM");
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
