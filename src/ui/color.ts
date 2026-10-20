import { RGBA } from "@opentui/core";

export const blendColors = (background: RGBA, foreground: RGBA, amount: number): RGBA => RGBA.fromValues(
  background.r + (foreground.r - background.r) * amount,
  background.g + (foreground.g - background.g) * amount,
  background.b + (foreground.b - background.b) * amount,
);

export function neutralColor(background: RGBA, foreground: RGBA): RGBA {
  const muted = blendColors(background, foreground, 0.65);
  const gray = muted.r * 0.299 + muted.g * 0.587 + muted.b * 0.114;
  return RGBA.fromValues(gray, gray, gray);
}
