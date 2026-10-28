import { RenderableEvents, type CliRenderer, type Renderable } from "@opentui/core";

export type FastModeFrame = Readonly<{ phase: number }>;

const cycleMs = 1500;

// Session-local Working shimmer; visibility and snapshot mode never change runtime priority.
export class FastModeAnimation {
  private enabled = false;
  private animate = true;
  private startedAt = 0;
  private timer: ReturnType<CliRenderer["clock"]["setInterval"]> | undefined;
  private disposed = false;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly owner: Renderable,
    private readonly paint: (frame: FastModeFrame | null) => void,
  ) {
    renderer.addPostProcessFn(this.sync);
    owner.once(RenderableEvents.DESTROYED, this.dispose);
  }

  update(enabled: boolean, animate = true): void {
    if (this.disposed) {
      return;
    }
    if (enabled && !this.enabled) {
      this.startedAt = this.renderer.clock.now();
    }

    this.enabled = enabled;
    this.animate = animate;
    this.sync();
  }

  private sync = (): void => {
    if (this.disposed) {
      return;
    }

    let visible = !this.owner.isDestroyed;
    for (let node: Renderable | null = this.owner; node && visible; node = node.parent) {
      visible = node.visible;
    }
    if (!this.enabled || !visible || !this.animate) {
      if (this.timer !== undefined) {
        this.renderer.clock.clearInterval(this.timer);
      }

      this.timer = undefined;
      this.paint(this.enabled && visible ? { phase: 0 } : null);

      return;
    }
    if (this.timer !== undefined) {
      return;
    }

    this.tick();
    this.timer = this.renderer.clock.setInterval(this.tick, 50);
  };

  private tick = (): void => {
    const phase = ((this.renderer.clock.now() - this.startedAt) % cycleMs) / cycleMs;
    this.paint({ phase });
  };

  dispose = (): void => {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    if (this.timer !== undefined) {
      this.renderer.clock.clearInterval(this.timer);
    }

    this.timer = undefined;
    this.renderer.removePostProcessFn(this.sync);
    this.owner.off(RenderableEvents.DESTROYED, this.dispose);
  };
}
