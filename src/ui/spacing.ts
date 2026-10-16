import { RenderableEvents, type BoxRenderable, type CliRenderer } from "@opentui/core";

export const horizontalInset = (width: number): number => width < 80 ? 1 : 2;

export function panelSpacing(renderer: Pick<CliRenderer, "width" | "height">) {
  return { horizontal: horizontalInset(renderer.width), vertical: renderer.height < 18 ? 0 : 1 };
}

// Keep feature content aligned without adding padding inside the embedded program's own screen.
export function bindPanelSpacing(renderer: CliRenderer, panel: BoxRenderable): void {
  const resize = () => {
    if (panel.isDestroyed) return;
    const { horizontal, vertical } = panelSpacing(renderer);
    panel.paddingX = horizontal; panel.paddingY = vertical;
  };
  renderer.on("resize", resize);
  panel.once(RenderableEvents.DESTROYED, () => renderer.off("resize", resize));
  resize();
}
