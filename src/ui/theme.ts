import {
  RGBA,
  Renderable,
  RenderableEvents,
  type BoxRenderable,
  type CliRenderer,
  type InputRenderable,
  type TextareaRenderable,
  type ScrollBoxRenderable,
  type TerminalColors,
} from "@opentui/core";
import { isThemeColor, themeRoles, type ThemeOverrides, type ThemeRole } from "./theme-config.ts";
import { reportUnexpected } from "../errors.ts";
import { blendColors } from "./color.ts";
import {
  resolveStyles,
  sameStyles,
  styleBackground,
  type StyleGroup,
  type UiStyles,
} from "./theme-styles.ts";
export { blendColors } from "./color.ts";

export type UiColors = Readonly<Record<ThemeRole, RGBA>>;

const themes = new WeakMap<CliRenderer, UiTheme>();
const fallbackAnsi = [
  "#000000",
  "#CD3131",
  "#0DBC79",
  "#E5C07B",
  "#2472C8",
  "#BC3FBC",
  "#11A8CD",
  "#E5E5E5",
];

function resolveColors(
  palette: TerminalColors | undefined,
  overrides: ThemeOverrides,
  light: boolean,
): UiColors {
  const override = (role: ThemeRole, fallback: RGBA) =>
    overrides[role] ? RGBA.fromHex(overrides[role]) : fallback;
  const snapshot = (value: unknown, fallback: string) => (isThemeColor(value) ? value : fallback);
  // Preserve terminal-default/indexed intent, including when OSC queries are unsupported.
  const text = override(
    "text",
    RGBA.defaultForeground(snapshot(palette?.defaultForeground, light ? "#202020" : "#E5E5E5")),
  );
  const panel = override(
    "panel",
    RGBA.defaultBackground(snapshot(palette?.defaultBackground, light ? "#FFFFFF" : "#101010")),
  );
  const ansi = (role: ThemeRole, index: number) =>
    override(role, RGBA.fromIndex(index, snapshot(palette?.palette[index], fallbackAnsi[index]!)));
  const success = ansi("success", 2);
  const error = ansi("error", 1);

  return {
    text,
    panel,
    success,
    error,
    surface: override("surface", blendColors(panel, text, 0.05)),
    muted: override("muted", blendColors(panel, text, 0.65)),
    selected: override("selected", blendColors(panel, text, 0.16)),
    accent: ansi("accent", 6),
    info: ansi("info", 4),
    warning: ansi("warning", 3),
    attention: override("attention", RGBA.fromHex("#E9953A")),
    keyword: ansi("keyword", 5),
    number: ansi("number", 3),
    added: override("added", blendColors(panel, success, 0.3)),
    removed: override("removed", blendColors(panel, error, 0.3)),
  };
}

// UI colors belong to one attached renderer, never to the shared runtime or a module-global palette.
export class UiTheme {
  private palette: TerminalColors | undefined;
  private overrides: ThemeOverrides = {};
  private readonly bindings = new Map<() => void, () => void>();
  private value: UiColors;
  private styleValue: UiStyles;
  private disposed = false;
  private colorless = false;
  private hostChange = false;
  private sawForeground = false;
  private sawBackground = false;

  constructor(private readonly renderer: CliRenderer) {
    this.value = resolveColors(undefined, {}, renderer.themeMode === "light");
    this.styleValue = resolveStyles(this.value);
    renderer.on("palette", this.updatePalette);
    renderer.on("theme_mode", this.refresh);
    renderer.prependInputHandler(this.hostThemeSequence);
    renderer.once("destroy", this.dispose);
  }

  get colors(): UiColors {
    return this.value;
  }

  get styles(): UiStyles {
    return this.styleValue;
  }

  bindStyles(owner: Renderable, paint: (styles: UiStyles) => void): void {
    this.bind(owner, () => paint(this.styles));
  }

  get monochrome(): boolean {
    return this.colorless;
  }

  setMonochrome(value: boolean): void {
    if (value === this.colorless) {
      return;
    }

    this.colorless = value;

    // Painting may register or dispose bindings; only update the current snapshot.
    const updates = [...this.bindings.keys()];
    for (const update of updates) {
      update();
    }

    this.renderer.requestRender();
  }

  configure(palette: TerminalColors, overrides: ThemeOverrides = {}): void {
    this.overrides = structuredClone(overrides);
    this.updatePalette(palette);
  }

  bind(owner: Renderable, paint: (colors: UiColors) => void): void {
    if (owner.isDestroyed) {
      return;
    }

    const update = () => {
      if (!owner.isDestroyed) {
        paint(this.colors);
      }
    };
    const cleanup = () => {
      this.bindings.delete(update);
      owner.off(RenderableEvents.DESTROYED, cleanup);
    };

    this.bindings.set(update, cleanup);
    owner.once(RenderableEvents.DESTROYED, cleanup);
    update();
  }

  input(
    input: InputRenderable | TextareaRenderable,
    normal: StyleGroup = "ui.input",
    focused: StyleGroup = "ui.inputFocused",
    backgroundStyle?: StyleGroup,
  ): void {
    const paint = () => {
      const styles = this.styles;
      input.textColor = styles[normal].fg;
      input.focusedTextColor = styles[focused].fg;
      input.backgroundColor = styles[backgroundStyle ?? normal].bg;
      input.focusedBackgroundColor = styleBackground(styles[backgroundStyle ?? focused]);
      input.attributes = styles[input.focused ? focused : normal].attributes;
      input.placeholderColor = styles["ui.placeholder"].fg;
      input.selectionBg = styles["ui.selection"].bg;
      input.selectionFg = styles["ui.selection"].fg;
    };
    this.bind(input, paint);
    input.on("focused", paint);
    input.on("blurred", paint);
    input.once(RenderableEvents.DESTROYED, () => {
      input.off("focused", paint);
      input.off("blurred", paint);
    });
  }

  focusBorder(panel: BoxRenderable): void {
    const paint = () => {
      if (panel.isDestroyed) {
        return;
      }

      // The renderer announces focus before ancestor hasFocusedDescendant flags settle.
      let focused = false;
      for (
        let node = this.renderer.currentFocusedRenderable;
        node;
        node = node.parent instanceof Renderable ? node.parent : null
      ) {
        if (node === panel) {
          focused = true;
          break;
        }
      }

      panel.borderColor = this.styles[focused ? "ui.focusBorder" : "ui.border"].fg;
    };
    this.bind(panel, paint);
    this.renderer.on("focused_renderable", paint);
    panel.once(RenderableEvents.DESTROYED, () => this.renderer.off("focused_renderable", paint));
  }

  scrollbars(scroll: ScrollBoxRenderable): void {
    // Constructor visibility is auto-managed by OpenTUI; this setter establishes
    // explicit ownership without disabling horizontal navigation or changing content.
    scroll.horizontalScrollBar.visible = false;
    this.bind(scroll, () => {
      for (const bar of [scroll.verticalScrollBar, scroll.horizontalScrollBar]) {
        const style = this.styles["ui.scrollbar"];
        bar.trackOptions = { foregroundColor: style.fg, backgroundColor: styleBackground(style) };
        bar.arrowOptions = { foregroundColor: style.fg, backgroundColor: styleBackground(style) };
      }
    });
  }

  private hostThemeSequence = (sequence: string): boolean => {
    if (sequence === "\x1b[?997;1n" || sequence === "\x1b[?997;2n") {
      this.hostChange = true;
      this.sawForeground = false;
      this.sawBackground = false;
    } else if (this.hostChange) {
      this.sawForeground ||= sequence.includes("\x1b]10;");
      this.sawBackground ||= sequence.includes("\x1b]11;");
      if (this.sawForeground && this.sawBackground) {
        this.hostChange = false;
        // OpenTUI refreshes automatically only when light/dark mode changes. Observe its
        // completed OSC handshake before refreshing same-mode palette changes ourselves.
        queueMicrotask(() => {
          if (this.disposed) {
            return;
          }
          if (this.renderer.paletteDetectionStatus !== "detecting") {
            this.renderer.clearPaletteCache();
          }

          void this.renderer.getPalette({ size: 256, timeout: 200 }).catch((error: unknown) => {
            if (!this.disposed) {
              reportUnexpected(error, "terminal theme refresh");
            }
          });
        });
      }
    }

    return false;
  };

  private updatePalette = (palette: TerminalColors): void => {
    this.palette = palette;
    this.refresh();
  };

  private refresh = (): void => {
    const next = resolveColors(this.palette, this.overrides, this.renderer.themeMode === "light");
    const styles = resolveStyles(next, this.overrides.styles);

    this.renderer.setBackgroundColor(styles["ui.text"].bg ?? next.panel);
    if (
      themeRoles.every((role) => next[role].equals(this.value[role])) &&
      sameStyles(styles, this.styleValue)
    ) {
      return;
    }

    this.value = next;
    this.styleValue = styles;

    const updates = [...this.bindings.keys()];
    for (const update of updates) {
      update();
    }

    this.renderer.requestRender();
  };

  private dispose = (): void => {
    this.disposed = true;
    this.renderer.removeInputHandler(this.hostThemeSequence);
    this.renderer.off("palette", this.updatePalette);
    this.renderer.off("theme_mode", this.refresh);

    const cleanups = [...this.bindings.values()];
    for (const cleanup of cleanups) {
      cleanup();
    }

    themes.delete(this.renderer);
  };
}

export function uiTheme(renderer: CliRenderer): UiTheme {
  let theme = themes.get(renderer);
  if (!theme) {
    theme = new UiTheme(renderer);
    themes.set(renderer, theme);
  }

  return theme;
}
