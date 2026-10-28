import {
  BoxRenderable,
  TextRenderable,
  type EmbeddedTerminalRenderable,
  type CliRenderer,
} from "@opentui/core";
import { ExpectedError, reportUnexpected } from "../../errors.ts";
import type { Result } from "../../result.ts";
import type { EditorFrame, EditorInfo } from "../../runtime/protocol.ts";
import type { Worktree } from "../../workspace/model.ts";
import { TerminalSurface, type PtyAttachment } from "../../ui/embedded-terminal/surface.ts";
import type { TerminalTheme } from "../../ui/embedded-terminal/theme.ts";
import type { Notice } from "../../ui/messages.ts";
import { uiTheme } from "../../ui/theme.ts";
import { paintText } from "../../ui/theme-styles.ts";

export type EditorAttachment = PtyAttachment;
export type EditorActions = {
  info(worktreeId: string): EditorInfo | undefined;
  open(
    worktreeId: string,
    size: { cols: number; rows: number },
  ): Promise<Result<string, ExpectedError>>;
  attach(
    id: string,
    frame: (frame: EditorFrame) => void,
    failed: (error: unknown) => void,
  ): Promise<Result<EditorAttachment, ExpectedError>>;
};
type CachedEditor = { id: string; surface: TerminalSurface; frame?: EditorFrame };

export class EditorPanel {
  readonly root: BoxRenderable;
  readonly openButton: BoxRenderable;
  private readonly status: BoxRenderable;
  private readonly message: TextRenderable;
  private readonly cached = new Map<string, CachedEditor>();
  private selected: CachedEditor | undefined;
  private connection: EditorAttachment | undefined;
  private worktree: Worktree | null = null;
  private generation = 0;
  private task: Promise<void> = Promise.resolve();
  private disposed = false;
  private cancelLayout: (() => void) | undefined;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly actions: EditorActions | undefined,
    button: (label: string, activate: () => void) => BoxRenderable,
    private readonly notice: Notice,
    private readonly changed: () => void,
    private readonly terminalTheme?: TerminalTheme,
  ) {
    this.root = new BoxRenderable(renderer, {
      id: "editor-view",
      width: "100%",
      flexGrow: 1,
      minHeight: 0,
      padding: 0,
      flexDirection: "column",
      visible: false,
    });
    this.status = new BoxRenderable(renderer, {
      id: "editor-status",
      flexGrow: 1,
      minHeight: 0,
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
      gap: 1,
      overflow: "hidden",
      onSizeChange: () => {
        this.status.gap = this.status.height >= 3 ? 1 : 0;
      },
    });
    this.message = new TextRenderable(renderer, {
      content: "",
      height: 1,
      minHeight: 0,
      maxWidth: "100%",
      flexShrink: 1,
      wrapMode: "none",
      selectable: false,
    });
    uiTheme(renderer).bindStyles(this.message, (styles) =>
      paintText(this.message, styles["ui.muted"]),
    );
    this.openButton = button("Open / reconnect editor", () => {
      if (this.worktree) this.show(this.worktree, true);
    });
    this.openButton.maxWidth = "100%";
    this.openButton.flexShrink = 0;
    this.status.add(this.message);
    this.status.add(this.openButton);
    this.root.add(this.status);
  }
  get input(): EmbeddedTerminalRenderable | undefined {
    return this.root.visible &&
      this.connection &&
      this.selected?.surface.acceptsInput &&
      this.selected.surface.root.visible
      ? this.selected.surface.root
      : undefined;
  }
  prepareResize(cols: number, rows: number, commit: () => void): boolean {
    return Boolean(this.input && this.selected?.surface.prepareResize(cols, rows, commit));
  }
  cancelResize(): void {
    this.selected?.surface.cancelResize();
  }
  show(worktree: Worktree | null, explicit = false): void {
    if (this.disposed || this.root.isDestroyed) return;
    const info = worktree ? this.actions?.info(worktree.id) : undefined;
    const previous = worktree ? this.cached.get(worktree.id) : undefined;
    const exited = info?.exited || (previous?.id === info?.id && previous?.frame?.exited);
    if (this.root.visible && this.worktree?.id === worktree?.id) {
      if (!explicit) return;
      if (this.input && this.selected?.id === info?.id && !exited) {
        this.input.focus();
        return;
      }
    }
    this.suspend();
    this.worktree = worktree;
    this.root.visible = true;
    const generation = ++this.generation;
    this.cancelLayout?.();
    this.message.content = !worktree
      ? "Select a workspace to use Editor."
      : !this.actions
        ? "Editor preview · Neovim is not started in demo mode."
        : exited
          ? `Neovim exited (${info?.exitCode ?? "signal"}) · open again explicitly`
          : "";
    this.message.visible = !worktree || !this.actions || Boolean(exited);
    this.openButton.visible = Boolean(worktree && this.actions && (!info || exited));
    this.status.visible = this.message.visible || this.openButton.visible;
    if (previous && previous.id === info?.id && !exited) {
      this.selected = previous;
      // The last painted screen is visible immediately. Input remains disabled
      // until a fresh exclusive attachment is acknowledged by the runtime.
      previous.surface.root.visible = true;
    } else this.selected = undefined;
    this.task = this.task
      .then(async () => {
        await this.detach();
        if (!this.current(generation) || !worktree || !this.actions) return;
        let id = info?.id;
        if (explicit && (!info || exited)) {
          this.message.content = `Opening Neovim · ${worktree.name}`;
          this.message.visible = true;
          this.openButton.visible = false;
          this.status.visible = true;
          await this.laidOut();
          if (!this.current(generation)) return;
          const opened = await this.actions.open(worktree.id, {
            cols: Math.max(2, Math.min(500, this.root.width)),
            rows: Math.max(1, Math.min(200, this.root.height)),
          });
          if (!this.current(generation)) return;
          if (!opened.ok) {
            this.failed(opened.error);
            return;
          }
          id = opened.value;
        }
        if (!id) {
          this.message.content = "Editor is not running · open explicitly to start Neovim.";
          this.message.visible = true;
          this.status.visible = true;
          return;
        }
        let cached = this.cached.get(worktree.id);
        if (cached?.id !== id) {
          cached?.surface.dispose();
          const surface = new TerminalSurface(
            this.renderer,
            `editor-terminal:${worktree.id}`,
            this.terminalTheme,
          );
          cached = { id, surface };
          this.cached.set(worktree.id, cached);
          this.root.add(surface.root);
        }
        const editor = cached;
        this.selected = editor;
        editor.surface.acceptsInput = false;
        editor.surface.root.visible = !(id === info?.id && exited);
        this.openButton.visible = false;
        const attached = await this.actions.attach(
          id,
          (frame) => {
            if (!this.current(generation) || editor.surface.root.isDestroyed) return;
            editor.frame = frame;
            editor.surface.display(frame);
            this.message.content = frame.exited
              ? `Neovim exited (${frame.exitCode ?? "signal"}) · open again explicitly`
              : "";
            this.message.visible = frame.exited;
            this.openButton.visible = frame.exited;
            this.status.visible = frame.exited;
            if (frame.exited && editor.surface.root.focused) this.openButton.focus();
            editor.surface.acceptsInput = Boolean(this.connection && !frame.exited);
            editor.surface.root.visible = !frame.exited;
            this.changed();
          },
          (error) => {
            if (this.current(generation)) this.failed(error);
          },
        );
        if (!attached.ok) {
          if (this.current(generation)) this.failed(attached.error);
          return;
        }
        if (!this.current(generation) || editor.surface.root.isDestroyed) {
          await attached.value.disconnect();
          return;
        }
        this.connection = attached.value;
        editor.surface.connect(attached.value);
        editor.surface.acceptsInput = !editor.frame?.exited;
        if (explicit && editor.surface.root.visible) editor.surface.root.focus();
        this.changed();
      })
      .catch((error: unknown) => {
        if (this.current(generation)) this.failed(error);
        else reportUnexpected(error, "editor cleanup");
      });
  }
  private current(generation: number): boolean {
    return (
      !this.disposed &&
      !this.root.isDestroyed &&
      this.root.visible &&
      generation === this.generation
    );
  }
  private failed(error: unknown): void {
    const text =
      error instanceof ExpectedError
        ? `[${error.code}] ${error.message}`
        : reportUnexpected(error, "editor view");
    this.generation++; // A failed attachment may still be finishing its admission promise.
    this.message.content = "Editor unavailable · open / reconnect explicitly";
    this.message.visible = true;
    this.openButton.visible = true;
    this.status.visible = true;
    if (this.selected?.surface.root.focused) this.openButton.focus();
    this.selected?.surface.suspend();
    if (this.selected) this.selected.surface.root.visible = false;
    this.notice(text, { level: "error", source: "Editor" });
    this.changed();
  }
  private laidOut(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.renderer.off("frame", done);
        this.cancelLayout = undefined;
        resolve();
      };
      this.cancelLayout = done;
      this.renderer.once("frame", done);
      this.renderer.requestRender();
    });
  }
  private suspend(): void {
    const surface = this.selected?.surface;
    if (surface && !surface.root.isDestroyed) {
      surface.root.blur();
      surface.suspend();
      surface.root.visible = false;
    }
  }
  private async detach(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    await connection?.disconnect();
  }
  hide(): void {
    if (!this.root.visible) return;
    this.suspend();
    this.generation++;
    this.cancelLayout?.();
    if (!this.root.isDestroyed) this.root.visible = false;
    this.task = this.task
      .then(() => this.detach())
      .catch((error: unknown) => {
        reportUnexpected(error, "editor detach");
      });
  }
  dispose(): void {
    if (this.disposed) return;
    this.hide();
    this.disposed = true;
    for (const editor of this.cached.values()) editor.surface.dispose();
    this.cached.clear();
    this.selected = undefined;
  }
}
