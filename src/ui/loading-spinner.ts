import {
  RenderableEvents,
  StyledText,
  TextRenderable,
  type CliRenderer,
  type TextOptions,
} from "@opentui/core";
import { spinnerFrames } from "../icons.ts";
import { uiTheme } from "./theme.ts";
import { styleChunk } from "./theme-styles.ts";

export type SpinnerStyle = "default" | "fast" | "circle-fill";

type Timer = ReturnType<CliRenderer["clock"]["setTimeout"]>;
const minimumVisibleMs = 500;
const frameIntervalMs = 80;
const circleFillFrames = ["○", "◔", "◑", "◕", "●"] as const;

// Shared loading feedback: delay only hiding the indicator, never the operation's result.
export class LoadingSpinner {
  readonly root: TextRenderable;
  private animation: Timer | undefined;
  private pendingHide: Timer | undefined;
  private startedAt = 0;
  private frame = 0;
  private style: SpinnerStyle = "default";

  constructor(
    private readonly renderer: CliRenderer,
    options: Pick<TextOptions, "id" | "fg"> = {},
  ) {
    this.root = new TextRenderable(renderer, {
      ...options,
      content: "",
      width: 1,
      height: 1,
      flexShrink: 0,
      visible: false,
      selectable: false,
      wrapMode: "none",
    });
    this.root.on(RenderableEvents.DESTROYED, () => this.cancel());
    uiTheme(renderer).bindStyles(this.root, () => {
      if (this.style === "fast" && this.root.visible) this.paint();
    });
  }

  get columns(): number {
    return this.style === "fast" ? 3 : 1;
  }
  private get frames(): readonly string[] {
    return this.style === "circle-fill" ? circleFillFrames : spinnerFrames;
  }

  setStyle(style: SpinnerStyle): void {
    if (this.root.isDestroyed || style === this.style) return;
    this.style = style;
    this.frame = 0;
    this.root.width = this.columns;
    if (this.root.visible) this.paint();
  }

  // A new operation owns a fresh minimum interval, including during a previous delayed hide.
  start(): void {
    if (this.root.isDestroyed) return;
    this.clearPendingHide();
    this.startedAt = this.renderer.clock.now();
    if (this.animation !== undefined) return;
    this.frame = 0;
    this.paint();
    this.root.visible = true;
    this.animation = this.renderer.clock.setInterval(() => {
      this.frame = (this.frame + 1) % (this.style === "fast" ? 3 : this.frames.length);
      this.paint();
    }, frameIntervalMs);
  }

  stop(): void {
    if (this.animation === undefined || this.pendingHide !== undefined) return;
    const remaining = minimumVisibleMs - (this.renderer.clock.now() - this.startedAt);
    if (remaining <= 0) {
      this.cancel();
      return;
    }
    this.pendingHide = this.renderer.clock.setTimeout(() => this.cancel(), remaining);
  }

  // Owners cancel immediately when hidden or disposed; this does not cancel the underlying request.
  cancel(): void {
    this.clearPendingHide();
    if (this.animation !== undefined) this.renderer.clock.clearInterval(this.animation);
    this.animation = undefined;
    if (!this.root.isDestroyed) {
      this.root.visible = false;
      this.root.content = "";
    }
  }

  private paint(): void {
    if (this.style !== "fast") {
      this.root.content = this.frames[this.frame]!;
      return;
    }
    const styles = uiTheme(this.renderer).styles;
    this.root.content = new StyledText(
      Array.from({ length: 3 }, (_, index) =>
        styleChunk(
          index === this.frame ? "▶" : "▷",
          styles[index === this.frame ? "metadata.fastOn" : "ui.muted"],
        ),
      ),
    );
  }

  private clearPendingHide(): void {
    if (this.pendingHide !== undefined) this.renderer.clock.clearTimeout(this.pendingHide);
    this.pendingHide = undefined;
  }
}
