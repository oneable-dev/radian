import { RenderableEvents, type BoxRenderable, type CliRenderer } from "@opentui/core";

export const horizontalInset = (width: number): number => (width < 80 ? 1 : 2);

export function panelSpacing(renderer: Pick<CliRenderer, "width" | "height">) {
  return { horizontal: horizontalInset(renderer.width), vertical: 1 };
}

// Work surfaces start directly below their tabs and end at the sidebar divider's bottom.
// Keep side insets outside embedded programs rather than padding inside their screen.
export function bindPanelSpacing(renderer: CliRenderer, panel: BoxRenderable): void {
  const resize = () => {
    if (panel.isDestroyed) return;
    const { horizontal } = panelSpacing(renderer);
    panel.paddingX = horizontal;
    panel.paddingTop = 0;
    panel.paddingBottom = 0;
  };
  renderer.on("resize", resize);
  panel.once(RenderableEvents.DESTROYED, () => renderer.off("resize", resize));
  resize();
}
