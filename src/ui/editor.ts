import { BoxRenderable, TextRenderable, type EmbeddedTerminalRenderable, type CliRenderer } from "@opentui/core";
import { ExpectedError, reportUnexpected } from "../errors.ts";
import type { Result } from "../result.ts";
import type { EditorFrame, EditorInfo } from "../runtime/protocol.ts";
import type { Worktree } from "../workspace/model.ts";

import { TerminalSurface, type PtyAttachment } from "./terminal-surface.ts";

export type EditorAttachment = PtyAttachment;
export type EditorActions = {
  info(worktreeId: string): EditorInfo | undefined;
  open(worktreeId: string, size: { cols: number; rows: number }): Promise<Result<string, ExpectedError>>;
  attach(id: string, frame: (frame: EditorFrame) => void, failed: (error: unknown) => void): Promise<Result<EditorAttachment, ExpectedError>>;
};

export class EditorPanel {
  readonly root: BoxRenderable;
  readonly openButton: BoxRenderable;
  private readonly message: TextRenderable;
  private terminal: TerminalSurface | undefined;
  private connection: EditorAttachment | undefined;
  private worktree: Worktree | null = null;
  private generation = 0;
  private task: Promise<void> = Promise.resolve();
  private disposed = false;
  private cancelLayout: (() => void) | undefined;

  constructor(private readonly renderer: CliRenderer, private readonly actions: EditorActions | undefined,
    button: (label: string, activate: () => void) => BoxRenderable, private readonly notice: (message: string) => void,
    private readonly changed: () => void) {
    this.root = new BoxRenderable(renderer, { id: "editor-view", width: "100%", flexGrow: 1, minHeight: 0, flexDirection: "column", visible: false });
    this.message = new TextRenderable(renderer, { content: "", fg: "#94A3B8", height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    this.openButton = button("Open / reconnect editor", () => { if (this.worktree) this.show(this.worktree, true); });
    this.root.add(this.message); this.root.add(this.openButton);
  }
  get input(): EmbeddedTerminalRenderable | undefined { return this.terminal?.root.visible ? this.terminal.root : undefined; }
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
      const terminal = new TerminalSurface(this.renderer, "editor-terminal");
      this.terminal = terminal; this.root.add(terminal.root);
      const attached = await this.actions.attach(id, (frame) => {
        if (!this.current(generation) || terminal.root.isDestroyed) return;
        terminal.display(frame);
        this.message.content = frame.exited ? `Neovim exited (${frame.exitCode ?? "signal"}) · open again explicitly` : `Neovim · ${worktree.name} · Ctrl+] sidebar`;
        this.openButton.visible = frame.exited;
        if (frame.exited && terminal.root.focused) this.openButton.focus();
        terminal.root.visible = !frame.exited;
        this.changed();
      }, (error) => { if (this.current(generation)) this.failed(error); });
      if (!attached.ok) { if (this.current(generation)) this.failed(attached.error); return; }
      if (!this.current(generation) || terminal.root.isDestroyed) { await attached.value.disconnect(); return; }
      this.connection = attached.value; terminal.connect(attached.value);
      if (explicit && terminal.root.visible) terminal.root.focus();
      this.changed();
    }).catch((error: unknown) => { if (this.current(generation)) this.failed(error); else reportUnexpected(error, "editor cleanup"); });
  }
  private current(generation: number): boolean { return !this.disposed && !this.root.isDestroyed && this.root.visible && generation === this.generation; }
  private failed(error: unknown): void {
    const text = error instanceof ExpectedError ? `[${error.code}] ${error.message}` : reportUnexpected(error, "editor view");
    this.message.content = "Editor unavailable · open / reconnect explicitly";
    this.openButton.visible = true;
    if (this.terminal?.root.focused) this.openButton.focus();
    this.removeTerminal(); this.notice(text); this.changed();
  }
  private laidOut(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { this.renderer.off("frame", done); this.cancelLayout = undefined; resolve(); };
      this.cancelLayout = done; this.renderer.once("frame", done); this.renderer.requestRender();
    });
  }
  private removeTerminal(): void { this.terminal?.dispose(); this.terminal = undefined; }
  private async detach(): Promise<void> {
    const connection = this.connection; this.connection = undefined;
    await connection?.disconnect();
  }
  hide(): void {
    if (!this.root.visible) return;
    if (this.terminal && !this.terminal.root.isDestroyed) this.terminal.root.blur();
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
