import {
  BoxRenderable,
  RGBA,
  type BoxOptions,
  type CliRenderer,
  type OptimizedBuffer,
} from "@opentui/core";
import { UI_BORDER_STYLE } from "./border-style.ts";

const transparent = RGBA.fromValues(0, 0, 0, 0);

// Fill the body, but preserve the underlay in border cells so no surface extends outside the line.
export class PopupFrame extends BoxRenderable {
  constructor(renderer: CliRenderer, options: BoxOptions) {
    super(renderer, { ...options, borderStyle: options.borderStyle ?? UI_BORDER_STYLE });
    // OpenTUI enables borders when a style is provided; frame visibility stays explicit.
    this.border = options.border ?? false;
  }

  override get borderColor(): RGBA {
    return super.borderColor;
  }

  override set borderColor(value: RGBA | string) {
    const borderless = this.border === false;
    super.borderColor = value;
    // OpenTUI color setters implicitly enable borders; popup geometry owns that decision.
    if (borderless) this.border = false;
  }

  override get focusedBorderColor(): RGBA {
    return super.focusedBorderColor;
  }

  override set focusedBorderColor(value: RGBA | string) {
    const borderless = this.border === false;
    super.focusedBorderColor = value;
    if (borderless) this.border = false;
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (this.width < 1 || this.height < 1) {
      return;
    }

    const x = Math.trunc(this.screenX);
    const y = Math.trunc(this.screenY);
    const { left, right, top, bottom } = this.borderSides;
    const insetX = Number(left);
    const insetY = Number(top);
    const width = this.width - insetX - Number(right);
    const height = this.height - insetY - Number(bottom);
    if (this.shouldFill && this._backgroundColor.a > 0 && width > 0 && height > 0) {
      buffer.fillRect(x + insetX, y + insetY, width, height, this._backgroundColor);
    }
    if (!left && !right && !top && !bottom) {
      return;
    }

    const focused = this._focusable && (this._focused || this._hasFocusedDescendant);
    const color = focused ? this._focusedBorderColor : this._borderColor;

    buffer.drawBox({
      x,
      y,
      width: this.width,
      height: this.height,
      border: this._border,
      borderStyle: this._borderStyle,
      borderColor: color,
      backgroundColor: transparent,
      shouldFill: false,
      ...(this._customBorderChars ? { customBorderChars: this._customBorderChars } : {}),
    });
  }
}
