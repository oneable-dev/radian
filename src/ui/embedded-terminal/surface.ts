import { EmbeddedTerminalRenderable, type CliRenderer } from "@opentui/core";
import type { PtyFrame, TerminalText } from "../../runtime/protocol.ts";
import type { ExpectedError } from "../../errors.ts";
import type { Result } from "../../result.ts";
import type { TerminalTheme } from "./theme.ts";
import { bindCtrlClickLink } from "../ctrl-click-link.ts";

export type PtyAttachment = {
  input(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  disconnect(): Promise<void>;
  scroll?(lines: number): void;
  read?(): Promise<Result<TerminalText, ExpectedError>>;
};

export type TerminalDisplayFrame = Pick<PtyFrame, "cols" | "rows" | "revision" | "ansi"> &
  Partial<PtyFrame>;

// A presentation/input adapter only. Owners decide what to launch, which tab is
// selected, whether to display exited output, and when to close a process.
export class TerminalSurface {
  readonly root: EmbeddedTerminalRenderable;
  private connection: PtyAttachment | undefined;
  private frame: TerminalDisplayFrame | undefined;
  private dimensions = "";
  private paintQueued = false;
  private prepared:
    | { cols: number; rows: number; revision: number; commit: () => void }
    | undefined;
  private readonly unsubscribeTheme: (() => void) | undefined;
  private paintedFrame: TerminalDisplayFrame | undefined;
  acceptsInput = true;

  constructor(
    private readonly renderer: CliRenderer,
    id: string,
    private readonly theme?: TerminalTheme,
    openLink?: (url: string) => void,
  ) {
    this.root = new EmbeddedTerminalRenderable(renderer, {
      id,
      width: "100%",
      flexGrow: 1,
      flexShrink: 1,
      minHeight: 1,
      maxWidth: 500,
      maxHeight: 200,
      maxScrollback: 0,
      onData: (bytes, source) => {
        if (source === "input" && this.acceptsInput && !this.frame?.exited) {
          this.connection?.input(bytes);
        }
      },
      renderBefore: this.paint,
      onTerminalResize: (cols, rows) => {
        if (!this.prepared) {
          this.resize(cols, rows);
        }

        this.queuePaint();
      },
      onMouseScroll: (event) => {
        if (
          this.canScroll &&
          (event.scroll?.direction === "up" || event.scroll?.direction === "down")
        ) {
          event.preventDefault();
          event.stopPropagation();
          this.scroll(event.scroll.direction === "up" ? -3 : 3);
        }
      },
    });
    if (openLink) {
      bindCtrlClickLink(this.root, {
        linkAt: (x, y) => this.linkAt(x, y),
        revision: () => this.paintedFrame,
        open: openLink,
      });
    }

    this.unsubscribeTheme = theme?.subscribe(() => this.queuePaint());
  }

  private linkAt(x: number, y: number): string | undefined {
    const frame = this.paintedFrame;
    if (
      !frame ||
      !this.root.visible ||
      this.root.isDestroyed ||
      frame.cols !== this.root.width ||
      frame.rows !== this.root.height
    ) {
      return;
    }

    const column = x - this.root.x;
    const row = y - this.root.y;

    return frame.links?.find((link) =>
      link.cells.some((cell) => cell.row === row && column >= cell.start && column < cell.end),
    )?.url;
  }

  get canScroll(): boolean {
    return this.frame?.scrollback?.enabled ?? false;
  }

  get scrollOffset(): number {
    return this.frame?.scrollback?.offset ?? 0;
  }

  scroll(lines: number): void {
    if (this.canScroll) {
      this.connection?.scroll?.(lines);
    }
  }

  connect(connection: PtyAttachment): void {
    this.connection = connection;
    this.resize();
    this.queuePaint();
  }

  // Release presentation/input ownership without discarding the last painted VT.
  suspend(): void {
    this.acceptsInput = false;
    this.prepared = undefined;
    this.connection = undefined;
    this.dimensions = "";
  }

  // Prepare a layout transition without resizing the currently displayed native VT.
  // The owner commits its layout from the frame callback, before the next layout/paint pass.
  prepareResize(cols: number, rows: number, commit: () => void): boolean {
    if (
      !this.connection ||
      !this.frame ||
      this.frame.exited ||
      this.root.isDestroyed ||
      !this.root.visible
    ) {
      return false;
    }
    if (
      this.root.width === cols &&
      this.root.height === rows &&
      this.frame.cols === cols &&
      this.frame.rows === rows
    ) {
      commit();

      return true;
    }

    this.prepared = { cols, rows, revision: this.frame.revision, commit };
    this.resize(cols, rows);

    return true;
  }

  cancelResize(): void {
    if (!this.prepared) {
      return;
    }

    this.prepared = undefined;
    // Cancellation supersedes UI intent; it does not prove the earlier PTY resize was rolled back.
    this.resize();
  }

  display(frame: TerminalDisplayFrame): void {
    this.frame = frame;

    const prepared = this.prepared;
    if (
      prepared &&
      (frame.exited ||
        (frame.cols === prepared.cols &&
          frame.rows === prepared.rows &&
          frame.revision > prepared.revision))
    ) {
      this.prepared = undefined;
      prepared.commit();
    }

    this.queuePaint();
  }

  private queuePaint(): void {
    this.paintQueued = true;
    this.renderer.requestRender();
  }

  private paint = (): void => {
    if (!this.paintQueued) {
      return;
    }

    const frame = this.frame;
    // A local resize repaints even when the server already has the same revision.
    if (
      this.root.isDestroyed ||
      !this.root.visible ||
      !frame ||
      this.root.width !== frame.cols ||
      this.root.height !== frame.rows
    ) {
      return;
    }

    // Full snapshots start with RIS, which resets the embedded VT's palette.
    // Apply the host theme after that reset, before painting any default cells.
    this.paintQueued = false;

    const reset = "\x1bc";
    const colors = this.theme?.ansi ?? "";

    this.root.write(
      frame.ansi.startsWith(reset)
        ? reset + colors + frame.ansi.slice(reset.length)
        : colors + frame.ansi,
    );
    this.paintedFrame = frame;
  };

  private resize(cols = this.root?.width ?? 0, rows = this.root?.height ?? 0): void {
    if (
      !this.connection ||
      !this.root ||
      this.root.isDestroyed ||
      !this.root.visible ||
      cols < 2 ||
      rows < 1
    ) {
      return;
    }

    const key = `${cols}:${rows}`;
    if (key === this.dimensions) {
      return;
    }

    this.dimensions = key;
    this.connection.resize(cols, rows);
  }

  dispose(): void {
    this.unsubscribeTheme?.();
    this.prepared = undefined;
    this.paintQueued = false;
    if (!this.root.isDestroyed) {
      this.root.destroyRecursively();
    }

    this.connection = undefined;
    this.frame = undefined;
    this.paintedFrame = undefined;
  }
}
