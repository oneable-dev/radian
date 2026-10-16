import { RGBA, Renderable, RenderableEvents, type BoxRenderable, type CliRenderer, type InputRenderable, type ScrollBoxRenderable, type TerminalColors } from "@opentui/core";
import { isThemeColor, themeRoles, type ThemeOverrides, type ThemeRole } from "./theme-config.ts";
import { reportUnexpected } from "../errors.ts";

export type UiColors = Readonly<Record<ThemeRole, RGBA>>;
const themes = new WeakMap<CliRenderer, UiTheme>();
const fallbackAnsi = ["#000000", "#CD3131", "#0DBC79", "#E5C07B", "#2472C8", "#BC3FBC", "#11A8CD", "#E5E5E5"];
export const blendColors = (background: RGBA, foreground: RGBA, amount: number): RGBA => RGBA.fromValues(
  background.r + (foreground.r - background.r) * amount,
  background.g + (foreground.g - background.g) * amount,
  background.b + (foreground.b - background.b) * amount,
);

function resolveColors(palette: TerminalColors | undefined, overrides: ThemeOverrides, light: boolean): UiColors {
  const override = (role: ThemeRole, fallback: RGBA) => overrides[role] ? RGBA.fromHex(overrides[role]) : fallback;
  const snapshot = (value: unknown, fallback: string) => isThemeColor(value) ? value : fallback;
  // Preserve terminal-default/indexed intent, including when OSC queries are unsupported.
  const text = override("text", RGBA.defaultForeground(snapshot(palette?.defaultForeground, light ? "#202020" : "#E5E5E5")));
  const panel = override("panel", RGBA.defaultBackground(snapshot(palette?.defaultBackground, light ? "#FFFFFF" : "#101010")));
  const ansi = (role: ThemeRole, index: number) => override(role, RGBA.fromIndex(index, snapshot(palette?.palette[index], fallbackAnsi[index]!)));
  const success = ansi("success", 2), error = ansi("error", 1);
  return {
    text, panel, success, error,
    surface: override("surface", blendColors(panel, text, 0.05)),
    muted: override("muted", blendColors(panel, text, 0.65)),
    selected: override("selected", blendColors(panel, text, 0.16)),
    accent: ansi("accent", 6), info: ansi("info", 4), warning: ansi("warning", 3), keyword: ansi("keyword", 5), number: ansi("number", 3),
    added: override("added", blendColors(panel, success, 0.14)), removed: override("removed", blendColors(panel, error, 0.14)),
  };
}

// UI colors belong to one attached renderer, never to the shared runtime or a module-global palette.
export class UiTheme {
  private palette: TerminalColors | undefined;
  private overrides: ThemeOverrides = {};
  private readonly bindings = new Map<() => void, () => void>();
  private value: UiColors;
  private disposed = false;
  private hostChange = false;
  private sawForeground = false;
  private sawBackground = false;

  constructor(private readonly renderer: CliRenderer) {
    this.value = resolveColors(undefined, {}, renderer.themeMode === "light");
    renderer.on("palette", this.updatePalette); renderer.on("theme_mode", this.refresh);
    renderer.prependInputHandler(this.hostThemeSequence);
    renderer.once("destroy", this.dispose);
  }
  get colors(): UiColors { return this.value; }
  configure(palette: TerminalColors, overrides: ThemeOverrides = {}): void {
    this.overrides = { ...overrides }; this.updatePalette(palette);
  }
  bind(owner: Renderable, paint: (colors: UiColors) => void): void {
    if (owner.isDestroyed) return;
    const update = () => { if (!owner.isDestroyed) paint(this.colors); };
    const cleanup = () => { this.bindings.delete(update); owner.off(RenderableEvents.DESTROYED, cleanup); };
    this.bindings.set(update, cleanup); owner.once(RenderableEvents.DESTROYED, cleanup); update();
  }
  input(input: InputRenderable): void {
    this.bind(input, (colors) => {
      input.textColor = colors.text; input.focusedTextColor = colors.text;
      input.backgroundColor = colors.surface; input.focusedBackgroundColor = colors.selected;
      input.placeholderColor = colors.muted; input.selectionBg = colors.selected; input.selectionFg = colors.text;
    });
  }
  focusBorder(panel: BoxRenderable): void {
    const paint = () => {
      if (panel.isDestroyed) return;
      // The renderer announces focus before ancestor hasFocusedDescendant flags settle.
      let focused = false;
      for (let node = this.renderer.currentFocusedRenderable; node; node = node.parent instanceof Renderable ? node.parent : null) {
        if (node === panel) { focused = true; break; }
      }
      panel.borderColor = focused ? this.colors.accent : blendColors(this.colors.panel, this.colors.text, 0.22);
    };
    this.bind(panel, paint);
    this.renderer.on("focused_renderable", paint);
    panel.once(RenderableEvents.DESTROYED, () => this.renderer.off("focused_renderable", paint));
  }
  scrollbars(scroll: ScrollBoxRenderable): void {
    this.bind(scroll, (colors) => {
      for (const bar of [scroll.verticalScrollBar, scroll.horizontalScrollBar]) {
        bar.trackOptions = { foregroundColor: colors.muted, backgroundColor: colors.panel };
        bar.arrowOptions = { foregroundColor: colors.muted, backgroundColor: colors.panel };
      }
    });
  }
  private hostThemeSequence = (sequence: string): boolean => {
    if (sequence === "\x1b[?997;1n" || sequence === "\x1b[?997;2n") {
      this.hostChange = true; this.sawForeground = false; this.sawBackground = false;
    } else if (this.hostChange) {
      this.sawForeground ||= sequence.includes("\x1b]10;"); this.sawBackground ||= sequence.includes("\x1b]11;");
      if (this.sawForeground && this.sawBackground) {
        this.hostChange = false;
        // OpenTUI refreshes automatically only when light/dark mode changes. Observe its
        // completed OSC handshake before refreshing same-mode palette changes ourselves.
        queueMicrotask(() => {
          if (this.disposed) return;
          if (this.renderer.paletteDetectionStatus !== "detecting") this.renderer.clearPaletteCache();
          void this.renderer.getPalette({ size: 256, timeout: 200 }).catch((error: unknown) => {
            if (!this.disposed) reportUnexpected(error, "terminal theme refresh");
          });
        });
      }
    }
    return false;
  };
  private updatePalette = (palette: TerminalColors): void => { this.palette = palette; this.refresh(); };
  private refresh = (): void => {
    const next = resolveColors(this.palette, this.overrides, this.renderer.themeMode === "light");
    this.renderer.setBackgroundColor(next.panel);
    if (themeRoles.every((role) => next[role].equals(this.value[role]))) return;
    this.value = next;
    for (const update of [...this.bindings.keys()]) update();
    this.renderer.requestRender();
  };
  private dispose = (): void => {
    this.disposed = true; this.renderer.removeInputHandler(this.hostThemeSequence);
    this.renderer.off("palette", this.updatePalette); this.renderer.off("theme_mode", this.refresh);
    for (const cleanup of [...this.bindings.values()]) cleanup();
    themes.delete(this.renderer);
  };
}

export function uiTheme(renderer: CliRenderer): UiTheme {
  let theme = themes.get(renderer);
  if (!theme) { theme = new UiTheme(renderer); themes.set(renderer, theme); }
  return theme;
}
