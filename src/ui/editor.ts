import { BoxRenderable, EmbeddedTerminalRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import { ExpectedError, reportUnexpected } from "../errors.ts";
import type { Result } from "../result.ts";
import type { EditorFrame, EditorInfo } from "../runtime/protocol.ts";
import type { Worktree } from "../workspace/model.ts";

export type EditorAttachment = {
  input(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  disconnect(): Promise<void>;
};
export type EditorActions = {
  info(worktreeId: string): EditorInfo | undefined;
  open(worktreeId: string, size: { cols: number; rows: number }): Promise<Result<string, ExpectedError>>;
  attach(id: string, frame: (frame: EditorFrame) => void, failed: (error: unknown) => void): Promise<Result<EditorAttachment, ExpectedError>>;
};

export class EditorPanel {
  readonly root: BoxRenderable;
  readonly openButton: BoxRenderable;
  private readonly message: TextRenderable;
  private terminal: EmbeddedTerminalRenderable | undefined;
  private connection: EditorAttachment | undefined;
  private worktree: Worktree | null = null;
  private generation = 0;
  private task: Promise<void> = Promise.resolve();
  private disposed = false;
  private dimensions = "";
  private frame: EditorFrame | undefined;
  private paintQueued = false;
  private cancelLayout: (() => void) | undefined;

  constructor(private readonly renderer: CliRenderer, private readonly actions: EditorActions | undefined,
    button: (label: string, activate: () => void) => BoxRenderable, private readonly notice: (message: string) => void,
    private readonly changed: () => void) {
    this.root = new BoxRenderable(renderer, { id: "editor-view", width: "100%", flexGrow: 1, minHeight: 0, flexDirection: "column", visible: false });
    this.message = new TextRenderable(renderer, { content: "", fg: "#94A3B8", height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    this.openButton = button("Open / reconnect editor", () => { if (this.worktree) this.show(this.worktree, true); });
    this.root.add(this.message); this.root.add(this.openButton);
  }
  get input(): EmbeddedTerminalRenderable | undefined { return this.terminal?.visible ? this.terminal : undefined; }
  show(worktree: Worktree | null, explicit = false): void {
    if (this.disposed || this.root.isDestroyed) return;
    if (this.root.visible && this.worktree?.id === worktree?.id && !explicit) return;
    this.worktree = worktree; this.root.visible = true;
    const generation = ++this.generation;
    this.cancelLayout?.(); this.removeTerminal();
    this.message.content = !worktree ? "Select a workspace to use Editor." : !this.actions
      ? "Editor preview · Neovim is not started in demo mode." : `Neovim · ${worktree.name}`;
    this.openButton.visible = Boolean(worktree && this.actions);
    this.task = this.task.then(async () => {
      await this.detach();
      if (!this.current(generation) || !worktree || !this.actions) return;
      let id = this.actions.info(worktree.id)?.id;
      if (explicit) {
        this.message.content = `Opening Neovim · ${worktree.name}`; this.openButton.visible = false;
        await this.laidOut();
        if (!this.current(generation)) return;
        const opened = await this.actions.open(worktree.id, { cols: Math.max(2, Math.min(500, this.root.width)), rows: Math.max(1, Math.min(200, this.root.height - 1)) });
        if (!this.current(generation)) return;
        if (!opened.ok) { this.failed(opened.error); return; }
        id = opened.value;
      }
      if (!id) { this.message.content = "Editor is not running · open explicitly to start Neovim."; return; }
      this.openButton.visible = false;
      const terminal = new EmbeddedTerminalRenderable(this.renderer, { id: "editor-terminal", width: "100%", flexGrow: 1, flexShrink: 1,
        minHeight: 1, maxWidth: 500, maxHeight: 200, maxScrollback: 0,
        onData: (bytes, source) => { if (source === "input" && this.current(generation) && !this.frame?.exited) this.connection?.input(bytes); },
        onTerminalResize: (cols, rows) => { this.resizeTerminal(cols, rows); this.queuePaint(); },
      });
      this.terminal = terminal; this.dimensions = ""; this.root.add(terminal);
      const attached = await this.actions.attach(id, (frame) => {
        if (!this.current(generation) || terminal.isDestroyed) return;
        this.frame = frame;
        this.message.content = frame.exited ? `Neovim exited (${frame.exitCode ?? "signal"}) · open again explicitly` : `Neovim · ${worktree.name} · Ctrl+] sidebar`;
        this.openButton.visible = frame.exited;
        if (frame.exited && terminal.focused) this.openButton.focus();
        terminal.visible = !frame.exited;
        this.queuePaint(); this.changed();
      }, (error) => { if (this.current(generation)) this.failed(error); });
      if (!attached.ok) { if (this.current(generation)) this.failed(attached.error); return; }
      if (!this.current(generation)) { await attached.value.disconnect(); return; }
      this.connection = attached.value; this.resizeTerminal(); this.queuePaint();
      if (explicit && terminal.visible) terminal.focus();
      this.changed();
    }).catch((error: unknown) => { if (this.current(generation)) this.failed(error); else reportUnexpected(error, "editor cleanup"); });
  }
  private current(generation: number): boolean { return !this.disposed && !this.root.isDestroyed && this.root.visible && generation === this.generation; }
  private failed(error: unknown): void {
    const text = error instanceof ExpectedError ? `[${error.code}] ${error.message}` : reportUnexpected(error, "editor view");
    this.message.content = "Editor unavailable · open / reconnect explicitly";
    this.openButton.visible = true;
    if (this.terminal?.focused) this.openButton.focus();
    this.removeTerminal(); this.notice(text); this.changed();
  }
  private laidOut(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { this.renderer.off("frame", done); this.cancelLayout = undefined; resolve(); };
      this.cancelLayout = done; this.renderer.once("frame", done); this.renderer.requestRender();
    });
  }
  private queuePaint(): void {
    if (!this.paintQueued) { this.paintQueued = true; this.renderer.once("frame", this.paintFrame); }
    this.renderer.requestRender();
  }
  private paintFrame = (): void => {
    this.paintQueued = false;
    const terminal = this.terminal, frame = this.frame;
    // Restoring into an unlaid-out/differently sized VT can scroll its first line away.
    // A local resize must repaint even if the daemon already has that exact size/revision.
    if (!terminal || terminal.isDestroyed || !frame || frame.exited || terminal.width !== frame.cols || terminal.height !== frame.rows) return;
    terminal.write(frame.ansi);
  };
  private resizeTerminal(cols = this.terminal?.width ?? 0, rows = this.terminal?.height ?? 0): void {
    const terminal = this.terminal;
    if (!this.connection || !terminal || terminal.isDestroyed || !terminal.visible || !this.root.visible || cols < 2 || rows < 1) return;
    const key = `${cols}:${rows}`;
    if (key === this.dimensions) return;
    this.dimensions = key; this.connection.resize(cols, rows);
  }
  private removeTerminal(): void {
    this.renderer.off("frame", this.paintFrame); this.paintQueued = false;
    if (this.terminal && !this.terminal.isDestroyed) this.terminal.destroyRecursively();
    this.terminal = undefined; this.dimensions = ""; this.frame = undefined;
  }
  private async detach(): Promise<void> {
    const connection = this.connection; this.connection = undefined;
    await connection?.disconnect();
  }
  hide(): void {
    if (!this.root.visible) return;
    if (this.terminal && !this.terminal.isDestroyed) this.terminal.blur();
    this.generation++; this.cancelLayout?.(); this.worktree = null;
    if (!this.root.isDestroyed) this.root.visible = false;
    this.removeTerminal();
    this.task = this.task.then(() => this.detach()).catch((error: unknown) => { reportUnexpected(error, "editor detach"); });
  }
  dispose(): void {
    if (this.disposed) return;
    this.hide(); this.disposed = true;
  }
}
