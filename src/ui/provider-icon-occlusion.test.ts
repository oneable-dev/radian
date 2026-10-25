import { expect, spyOn, test } from "bun:test";
import { BoxRenderable, OptimizedBuffer, RGBA } from "@opentui/core";
import { createTestRenderer, setRendererCapabilities } from "@opentui/core/testing";
import { ProviderIcon } from "./provider-icon.ts";
import { uiTheme } from "./theme.ts";
import { styleBackground } from "./theme-styles.ts";
import { icons } from "../icons.ts";

type Paint = { pixels: Uint8Array; imageWidth: number; imageHeight: number; width: number; height: number; pixelWidth: number; pixelHeight: number };
function inkWidth(paint: Paint): number {
  const background = paint.pixels.subarray(0, 3); let min = paint.imageWidth, max = -1;
  for (let index = 0; index < paint.pixels.length / 4; index++) {
    if (paint.pixels[index * 4] === background[0] && paint.pixels[index * 4 + 1] === background[1] && paint.pixels[index * 4 + 2] === background[2]) continue;
    min = Math.min(min, index % paint.imageWidth); max = Math.max(max, index % paint.imageWidth);
  }
  return (max - min + 1) / paint.imageWidth * paint.pixelWidth;
}
for (const protocol of ["kitty", "sixel"] as const) for (const light of [false, true]) {
  test.each(["openai", "anthropic"] as const)(`${protocol} logo %s retains enlarged dimensions in light=${light} popups while colors dim with backdrops`, async provider => {
    // Replace only image transport while using real pixels and native translucent composition.
    const app = await createTestRenderer({ width: 80, height: 8 });
    const theme = uiTheme(app.renderer), glyph = provider === "openai" ? icons.openai : icons.claude;
    if (light) app.renderer.emit("palette", { palette: [], defaultForeground: "#202020", defaultBackground: "#FAFAF6",
      cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null,
      highlightForeground: null, highlightBackground: null });
    const background = new BoxRenderable(app.renderer, { width: "100%", height: "100%", backgroundColor: styleBackground(theme.styles["ui.text"]) });
    const icon = new ProviderIcon(app.renderer); icon.left = 4; icon.top = 2; icon.setProvider(provider); icon.visible = true;
    background.add(icon); app.renderer.root.add(background);
    // Explicit translucent overlays remain supported even though default modal backdrops are clear.
    const popup = new BoxRenderable(app.renderer, { id: "popup-backdrop", position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 5600,
      visible: false, backgroundColor: RGBA.fromValues(0, 0, 0, 0.45) }); app.renderer.root.add(popup);
    const paints: Paint[] = [];
    const draw = spyOn(OptimizedBuffer.prototype, "drawImage").mockImplementation((image, _x, _y, width, height, pixelWidth, pixelHeight) => {
      paints.push({ pixels: image.raw().data.slice(), imageWidth: image.width, imageHeight: image.height, width, height, pixelWidth: pixelWidth!, pixelHeight: pixelHeight! }); return true;
    });
    setRendererCapabilities(app.renderer, { kitty_graphics: protocol === "kitty", sixel: protocol === "sixel", image_protocol: protocol });
    Object.defineProperty(app.renderer, "resolution", { configurable: true, get: () => ({ width: 800, height: 160 }) });
    const render = async () => { await app.renderOnce(); await app.renderOnce(); };
    try {
      await render(); const original = paints.at(-1)!;
      expect(original).toBeDefined(); expect(inkWidth(original) / 10).toBeCloseTo(1.5, 2);

      // Keep popup image geometry unchanged and apply composed colors rather than smaller fonts.
      popup.visible = true; await render(); const dimmed = paints.at(-1)!;
      expect(dimmed.pixels).not.toEqual(original.pixels);
      expect([dimmed.width, dimmed.height, dimmed.pixelWidth, dimmed.pixelHeight, dimmed.imageWidth, dimmed.imageHeight])
        .toEqual([original.width, original.height, original.pixelWidth, original.pixelHeight, original.imageWidth, original.imageHeight]);
      expect(inkWidth(dimmed)).toBe(inkWidth(original));
      expect(Math.max(...dimmed.pixels.filter((_, i) => i % 4 !== 3))).toBeLessThan(Math.max(...original.pixels.filter((_, i) => i % 4 !== 3)));
      expect(Array.from(dimmed.pixels.slice(0, 3))).toEqual(app.captureSpans().lines[2]!.spans[0]!.bg.toInts().slice(0, 3));
      expect(dimmed.pixels.filter((_, i) => i % 4 === 3).every(alpha => alpha === 255)).toBe(true);
      expect(app.captureCharFrame().split("\n")[2]).not.toContain(glyph);
      const cached = draw.mock.calls.at(-1)![0]; await render(); expect(draw.mock.calls.at(-1)![0]).toBe(cached);

      // Opaque popup bodies must not let obscured logos redraw through them.
      popup.backgroundColor = styleBackground(theme.styles["ui.popup"]); const beforeOpaque = paints.length; await render();
      expect(paints).toHaveLength(beforeOpaque);

      // Closing restores original colors without resizing.
      popup.visible = false; await render(); expect(paints.at(-1)!.pixels).toEqual(original.pixels);
    } finally { draw.mockRestore(); Reflect.deleteProperty(app.renderer, "resolution"); await app.dispose(); }
  });
}
