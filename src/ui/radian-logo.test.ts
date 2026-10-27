import { expect, test } from "bun:test";
import { TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import wordmark from "../../assets/radian.txt" with { type: "text" };
import { RadianLogo } from "./radian-logo.ts";
import { uiTheme } from "./theme.ts";
import packageInfo from "../../package.json";

async function mount() {
  const app = await createTestRenderer({ width: 80, height: 20 });
  const logo = new RadianLogo(app.renderer);
  app.renderer.root.add(logo);
  const mark = logo.findDescendantById("radian-logo-mark");
  if (!(mark instanceof TextRenderable)) throw new Error("Missing logo");
  const version = logo.findDescendantById("radian-logo-version");
  if (!(version instanceof TextRenderable)) throw new Error("Missing logo version");
  const render = async () => {
    await app.renderOnce();
    await app.renderOnce();
  };
  const frame = () =>
    app
      .captureCharFrame()
      .split("\n")
      .slice(mark.y, mark.y + mark.height)
      .map((line) => line.slice(mark.x, mark.x + mark.width))
      .join("\n");
  return { ...app, mark, version, render, frame };
}

function expectCentered(app: Awaited<ReturnType<typeof mount>>): void {
  expect(
    Math.abs(app.mark.x + app.mark.width / 2 - app.renderer.terminalWidth / 2),
  ).toBeLessThanOrEqual(0.5);
  const bottom = app.version.visible
    ? app.version.y + app.version.height
    : app.mark.y + app.mark.height;
  expect(Math.abs((app.mark.y + bottom) / 2 - app.renderer.terminalHeight / 2)).toBeLessThanOrEqual(
    0.5,
  );
}

test("Empty views render the existing RADIAN wordmark without image protocols", async () => {
  // The banner's text source is also the terminal logo's canonical artwork.
  const app = await mount();
  try {
    // Exact-fit viewports must retain every row and column of the wordmark.
    app.resize(50, 7);
    await app.render();

    // Render the real asset rather than a placeholder or clipped approximation.
    expect(app.frame()).toBe(wordmark.trimEnd());
    expect(app.mark.width).toBe(50);
    expect(app.mark.height).toBe(7);
    expectCentered(app);
    expect(app.renderer.currentFocusedRenderable).toBeNull();
  } finally {
    await app.dispose();
  }
});

test("Narrow and short views use compact branding and restore the full wordmark after expansion", async () => {
  // Branding must stay inside the transcript even when only one cell remains.
  const app = await mount();
  try {
    for (const [width, height, expected] of [
      [49, 7, "RADIAN"],
      [50, 6, "RADIAN"],
      [6, 1, "RADIAN"],
      [1, 1, "R"],
      [80, 20, wordmark.trimEnd()],
    ] as const) {
      // Both width and height constraints can trigger the compact form.
      app.resize(width, height);
      await app.render();

      // A resize never leaves a diamond placeholder or overflows the available body.
      expect(app.frame()).toBe(expected);
      expectCentered(app);
      expect(app.mark.x).toBeGreaterThanOrEqual(0);
      expect(app.mark.y).toBeGreaterThanOrEqual(0);
      expect(app.mark.x + app.mark.width).toBeLessThanOrEqual(width);
      expect(app.mark.y + app.mark.height).toBeLessThanOrEqual(height);
    }
  } finally {
    await app.dispose();
  }
});

test("Logo versions use the app release and yield to artwork in constrained viewports", async () => {
  // The CLI and branding must agree on the real package version without a second hardcoded value.
  const app = await mount();
  try {
    await app.render();

    expect(app.version.plainText).toBe(`v${packageInfo.version}`);
    expect(app.version.visible).toBe(true);
    expect(app.version.y).toBe(app.mark.y + app.mark.height + 1);
    expect(
      Math.abs(app.version.x + app.version.width / 2 - app.renderer.terminalWidth / 2),
    ).toBeLessThanOrEqual(0.5);
    expectCentered(app);
    expect(app.renderer.currentFocusedRenderable).toBeNull();

    // Exact-fit artwork stays full-sized instead of shrinking just to make room for metadata.
    app.resize(50, 7);
    await app.render();
    expect(app.frame()).toBe(wordmark.trimEnd());
    expect(app.version.visible).toBe(false);
    app.resize(80, 20);
    await app.render();
    expect(app.version.visible).toBe(true);
    expectCentered(app);
  } finally {
    await app.dispose();
  }
});

test("Full and compact wordmarks follow palette changes and branding style overrides", async () => {
  // Logo colors belong to the theme, not the light or dark banner image files.
  const app = await mount();
  const theme = uiTheme(app.renderer);
  const palette = (foreground: string, background: string) => ({
    palette: [],
    defaultForeground: foreground,
    defaultBackground: background,
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightForeground: null,
    highlightBackground: null,
  });
  const light = palette("#202020", "#FAFAF6");
  const ink = () =>
    app
      .captureSpans()
      .lines[app.mark.y]!.spans.find((span) => span.text.trim())!
      .fg.toInts();
  try {
    // Switching the terminal palette repaints the full wordmark immediately.
    theme.configure(palette("#F0F0F0", "#101010"));
    await app.render();
    const darkInk = ink();
    expect(darkInk).toEqual(theme.styles["branding.logo"].fg.toInts());
    theme.configure(light);
    await app.render();

    expect(ink()).not.toEqual(darkInk);
    expect(ink()).toEqual(theme.styles["branding.logo"].fg.toInts());

    // Explicit branding colors remain authoritative after a compact resize.
    theme.configure(light, { styles: { "branding.logo": { fg: "#4488CC" } } });
    await app.render();
    expect(ink().slice(0, 3)).toEqual([68, 136, 204]);
    app.resize(6, 1);
    await app.render();

    expect(app.frame()).toBe("RADIAN");
    expect(ink().slice(0, 3)).toEqual([68, 136, 204]);
  } finally {
    await app.dispose();
  }
});
