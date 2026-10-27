import { BoxRenderable, RGBA, type OptimizedBuffer } from "@opentui/core";

const transparent = RGBA.fromValues(0, 0, 0, 0);

// Fill the body, but preserve the underlay in border cells so no surface extends outside the line.
export class PopupFrame extends BoxRenderable {
  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (this.width < 1 || this.height < 1) return;
    const x = Math.trunc(this.screenX),
      y = Math.trunc(this.screenY);
    const { left, right, top, bottom } = this.borderSides;
    const insetX = Number(left),
      insetY = Number(top);
    const width = this.width - insetX - Number(right),
      height = this.height - insetY - Number(bottom);
    if (this.shouldFill && this._backgroundColor.a > 0 && width > 0 && height > 0) {
      buffer.fillRect(x + insetX, y + insetY, width, height, this._backgroundColor);
    }
    if (!left && !right && !top && !bottom) return;
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
