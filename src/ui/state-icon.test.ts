import { expect, spyOn, test } from "bun:test";
import { BoxRenderable, ImageError, ImageRenderable, NativeImage, TextRenderable } from "@opentui/core";
import { createTestRenderer, setRendererCapabilities } from "@opentui/core/testing";
import { icons } from "../icons.ts";
import { StateIcon } from "./state-icon.ts";
import { uiTheme } from "./theme.ts";
import { styleBackground } from "./theme-styles.ts";

async function mount() {
  const app = await createTestRenderer({ width: 80, height: 20 });
  const icon = new StateIcon(app.renderer, "state-icon"); app.renderer.root.add(icon);
  const image = icon.findDescendantById("state-icon:image"), glyph = icon.findDescendantById("state-icon:glyph"), raster = icon.findDescendantById("state-icon:raster");
  if (!(image instanceof ImageRenderable) || !(glyph instanceof TextRenderable) || !(raster instanceof TextRenderable)) throw new Error("Missing state icon renderers");
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  return { ...app, icon, image, glyph, raster, render };
}

test.each([icons.robot, icons.terminal, icons.folder])("State icon %s enlarges on ordinary terminals and restores its compact glyph", async symbol => {
  // A font-derived dot raster works without an image-capable terminal or pixel-size response.
  const app = await mount();
  try {
    app.icon.update(symbol, 6); await app.render();

    expect(app.icon.width).toBe(12); expect(app.icon.height).toBe(6);
    expect(app.image.visible).toBe(false); expect(app.raster.visible).toBe(true);
    expect(app.captureCharFrame().trim().length).toBeGreaterThan(1);
    expect(app.glyph.visible).toBe(false);

    // The Agent and model status line share the same outline robot in compact layouts.
    app.icon.update(symbol, 1); await app.render();
    expect(app.captureCharFrame()).toContain(symbol);
    expect(app.image.visible).toBe(false); expect(app.glyph.visible).toBe(true);
    if (symbol === icons.robot) expect(app.glyph.plainText).toBe(icons.model);
  } finally { await app.dispose(); }
});

test("Enlarged state icons follow theme colors and do not paint through opaque popups", async () => {
  // Preserve native image composition instead of painting a decorative image after modal surfaces.
  const app = await mount();
  try {
    const theme = uiTheme(app.renderer);
    setRendererCapabilities(app.renderer, { kitty_graphics: true, image_protocol: "kitty" });
    const palette = { palette: [], defaultForeground: null, defaultBackground: null, cursorColor: null,
      mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null, highlightForeground: null, highlightBackground: null };
    theme.configure(palette, { styles: { "ui.muted": { fg: "#224466" } } });
    app.icon.update(icons.robot, 6); await app.render();
    const before = app.image.image!.raw().data.slice();

    theme.configure(palette, { styles: { "ui.muted": { fg: "#AA8844" } } }); await app.render();

    expect(app.image.image!.raw().data).not.toEqual(before);
    const pixels = app.image.image!.raw().data;
    expect(pixels.some((_, index) => index % 4 === 0 && pixels[index] === 170 && pixels[index + 1] === 136 && pixels[index + 2] === 68)).toBe(true);
    expect(app.icon.height).toBe(6);
    setRendererCapabilities(app.renderer, { kitty_graphics: false, image_protocol: "blocks" }); await app.render();
    const popup = new BoxRenderable(app.renderer, { position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 5000,
      backgroundColor: styleBackground(theme.styles["ui.popup"]) });
    app.renderer.root.add(popup); await app.render();
    expect(app.captureCharFrame().trim()).toBe("");
    popup.visible = false; await app.render();
    expect(app.captureCharFrame().trim().length).toBeGreaterThan(1);
  } finally { await app.dispose(); }
});

test.each(["kitty", "sixel"] as const)("%s state icons keep enlarged geometry and respect monochrome rendering", async protocol => {
  // Only capabilities are substituted; native image loading, layout and rendering remain real.
  const app = await mount();
  setRendererCapabilities(app.renderer, { kitty_graphics: protocol === "kitty", sixel: protocol === "sixel", image_protocol: protocol });
  Object.defineProperty(app.renderer, "resolution", { configurable: true, get: () => ({ width: 800, height: 400 }) });
  try {
    app.icon.update(icons.robot, 6); await app.render();

    expect(app.image.effectiveProtocol).toBe(protocol);
    expect(app.icon.width).toBe(12); expect(app.icon.height).toBe(6);
    expect(app.image.image?.width).toBe(128);

    // The monochrome frame filter must own every painted cell, including decorative icons.
    uiTheme(app.renderer).setMonochrome(true); await app.render();
    expect(app.image.visible).toBe(false); expect(app.raster.visible).toBe(true); expect(app.icon.height).toBe(6);
    uiTheme(app.renderer).setMonochrome(false); await app.render();
    expect(app.image.effectiveProtocol).toBe(protocol); expect(app.image.visible).toBe(true);
  } finally { Reflect.deleteProperty(app.renderer, "resolution"); await app.dispose(); }
});

test("Native image allocation failures retain a font-derived raster across repeated layout updates", async () => {
  // Expected resource exhaustion must not erase the meaning or size of an empty-state icon.
  const app = await mount();
  setRendererCapabilities(app.renderer, { kitty_graphics: true, image_protocol: "kitty" });
  const allocation = spyOn(NativeImage, "fromRgba").mockImplementation(() => { throw new ImageError(6); });
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    app.icon.update(icons.robot, 6); await app.render();
    app.icon.update(icons.robot, 6); await app.render();

    expect(app.captureCharFrame().trim().length).toBeGreaterThan(1);
    expect(app.raster.visible).toBe(true); expect(app.icon.height).toBe(6);
    expect(app.image.visible).toBe(false); expect(warning).toHaveBeenCalledTimes(1);
  } finally { allocation.mockRestore(); warning.mockRestore(); await app.dispose(); }
});
