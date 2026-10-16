import { EmbeddedTerminalRenderable, type CliRenderer } from "@opentui/core";
import type { PtyFrame } from "../../runtime/protocol.ts";
import type { TerminalTheme } from "./theme.ts";

export type PtyAttachment = {
  input(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  disconnect(): Promise<void>;
  scroll?(lines: number): void;
};

// A presentation/input adapter only. Owners decide what to launch, which tab is
// selected, whether to display exited output, and when to close a process.
export class TerminalSurface {
  readonly root: EmbeddedTerminalRenderable;
  private connection: PtyAttachment | undefined;
  private frame: PtyFrame | undefined;
  private dimensions = "";
  private paintQueued = false;
  private readonly unsubscribeTheme: (() => void) | undefined;
  acceptsInput = true;

  constructor(private readonly renderer: CliRenderer, id: string, private readonly theme?: TerminalTheme) {
    this.root = new EmbeddedTerminalRenderable(renderer, { id, width: "100%", flexGrow: 1, flexShrink: 1,
      minHeight: 1, maxWidth: 500, maxHeight: 200, maxScrollback: 0,
      onData: (bytes, source) => { if (source === "input" && this.acceptsInput && !this.frame?.exited) this.connection?.input(bytes); },
      onTerminalResize: (cols, rows) => { this.resize(cols, rows); this.queuePaint(); },
      onMouseScroll: (event) => {
        if (this.canScroll && (event.scroll?.direction === "up" || event.scroll?.direction === "down")) {
          event.preventDefault(); event.stopPropagation(); this.scroll(event.scroll.direction === "up" ? -3 : 3);
        }
      },
    });
    this.unsubscribeTheme = theme?.subscribe(() => this.queuePaint());
  }
  get canScroll(): boolean { return this.frame?.scrollback?.enabled ?? false; }
  get scrollOffset(): number { return this.frame?.scrollback?.offset ?? 0; }
  scroll(lines: number): void { if (this.canScroll) this.connection?.scroll?.(lines); }
  connect(connection: PtyAttachment): void {
    this.connection = connection; this.resize(); this.queuePaint();
  }
  // Release presentation/input ownership without discarding the last painted VT.
  suspend(): void { this.acceptsInput = false; this.connection = undefined; this.dimensions = ""; }
  display(frame: PtyFrame): void { this.frame = frame; this.queuePaint(); }
  private queuePaint(): void {
    if (!this.paintQueued) { this.paintQueued = true; this.renderer.once("frame", this.paint); }
    this.renderer.requestRender();
  }
  private paint = (): void => {
    this.paintQueued = false;
    const frame = this.frame;
    // A local resize repaints even when the server already has the same revision.
    if (this.root.isDestroyed || !this.root.visible || !frame || this.root.width !== frame.cols || this.root.height !== frame.rows) return;
    // Full snapshots start with RIS, which resets the embedded VT's palette.
    // Apply the host theme after that reset, before painting any default cells.
    const reset = "\x1bc", colors = this.theme?.ansi ?? "";
    this.root.write(frame.ansi.startsWith(reset) ? reset + colors + frame.ansi.slice(reset.length) : colors + frame.ansi);
  };
  private resize(cols = this.root?.width ?? 0, rows = this.root?.height ?? 0): void {
    if (!this.connection || !this.root || this.root.isDestroyed || !this.root.visible || cols < 2 || rows < 1) return;
    const key = `${cols}:${rows}`;
    if (key === this.dimensions) return;
    this.dimensions = key; this.connection.resize(cols, rows);
  }
  dispose(): void {
    this.unsubscribeTheme?.();
    this.renderer.off("frame", this.paint); this.paintQueued = false;
    if (!this.root.isDestroyed) this.root.destroyRecursively();
    this.connection = undefined; this.frame = undefined;
  }
}
