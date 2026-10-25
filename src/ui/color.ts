import { RGBA } from "@opentui/core";

export const blendColors = (background: RGBA, foreground: RGBA, amount: number): RGBA => RGBA.fromValues(
  background.r + (foreground.r - background.r) * amount,
  background.g + (foreground.g - background.g) * amount,
  background.b + (foreground.b - background.b) * amount,
);

// Resolve cross-role colors to RGB: a terminal-default background reused as foreground
// would otherwise request the terminal's default foreground rather than its background color.
export function contrastingText(background: RGBA, first: RGBA, second: RGBA): RGBA {
  const luminance = (color: RGBA): number => {
    const linear = (channel: number) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
  };
  const base = luminance(background);
  const contrast = (color: RGBA): number => {
    const value = luminance(color);
    return (Math.max(base, value) + 0.05) / (Math.min(base, value) + 0.05);
  };
  const preferred = contrast(first) >= contrast(second) ? first : second;
  if (contrast(preferred) >= 4.5) return RGBA.fromValues(preferred.r, preferred.g, preferred.b);
  const black = RGBA.fromValues(0, 0, 0), white = RGBA.fromValues(1, 1, 1);
  return contrast(black) >= contrast(white) ? black : white;
}

export function neutralColor(background: RGBA, foreground: RGBA): RGBA {
  const muted = blendColors(background, foreground, 0.65);
  const gray = muted.r * 0.299 + muted.g * 0.587 + muted.b * 0.114;
  return RGBA.fromValues(gray, gray, gray);
}
