import { RenderableEvents, TextRenderable, type CliRenderer, type TextOptions } from "@opentui/core";
import { spinnerFrames } from "../icons.ts";

type Timer = ReturnType<CliRenderer["clock"]["setTimeout"]>;
const minimumVisibleMs = 500;
const frameIntervalMs = 80;

// Shared loading feedback: delay only hiding the indicator, never the operation's result.
export class LoadingSpinner {
  readonly root: TextRenderable;
  private animation: Timer | undefined;
  private pendingHide: Timer | undefined;
  private startedAt = 0;

  constructor(private readonly renderer: CliRenderer, options: Pick<TextOptions, "id" | "fg"> = {}) {
    this.root = new TextRenderable(renderer, { ...options, content: "", width: 1, height: 1, flexShrink: 0,
      visible: false, selectable: false, wrapMode: "none" });
    this.root.on(RenderableEvents.DESTROYED, () => this.cancel());
  }

  // A new operation owns a fresh minimum interval, including during a previous delayed hide.
  start(): void {
    if (this.root.isDestroyed) return;
    this.clearPendingHide();
    this.startedAt = this.renderer.clock.now();
    if (this.animation !== undefined) return;
    let frame = 0;
    this.root.content = spinnerFrames[frame]!;
    this.root.visible = true;
    this.animation = this.renderer.clock.setInterval(() => {
      frame = (frame + 1) % spinnerFrames.length;
      this.root.content = spinnerFrames[frame]!;
    }, frameIntervalMs);
  }

  stop(): void {
    if (this.animation === undefined || this.pendingHide !== undefined) return;
    const remaining = minimumVisibleMs - (this.renderer.clock.now() - this.startedAt);
    if (remaining <= 0) { this.cancel(); return; }
    this.pendingHide = this.renderer.clock.setTimeout(() => this.cancel(), remaining);
  }

  // Owners cancel immediately when hidden or disposed; this does not cancel the underlying request.
  cancel(): void {
    this.clearPendingHide();
    if (this.animation !== undefined) this.renderer.clock.clearInterval(this.animation);
    this.animation = undefined;
    if (!this.root.isDestroyed) { this.root.visible = false; this.root.content = ""; }
  }

  private clearPendingHide(): void {
    if (this.pendingHide !== undefined) this.renderer.clock.clearTimeout(this.pendingHide);
    this.pendingHide = undefined;
  }
}
