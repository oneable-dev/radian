import { RGBA, TextAttributes, type OptimizedBuffer } from "@opentui/core";
import type { UiColors } from "./theme.ts";

// Encode terminal-default colors rather than gray RGB escape sequences. This runs
// inside OpenTUI's synchronous post-process lease and never changes text/link IDs.
export function monochromeFrame(buffer: OptimizedBuffer, colors?: UiColors): void {
  const foreground = RGBA.defaultForeground(colors?.text).buffer;
  const background = RGBA.defaultBackground(colors?.panel).buffer;
  const selected = colors?.selected.toInts(), panel = colors?.panel.toInts();
  const distinguishSelection = selected && panel && selected.some((channel, index) => index < 3 && channel !== panel[index]);
  buffer.withBuffers(({ fg, bg, attributes }) => {
    for (let offset = 0, cell = 0; offset < fg.length; offset += 4, cell++) {
      if (distinguishSelection && selected && (bg[offset]! & 255) === selected[0] && (bg[offset + 1]! & 255) === selected[1]
        && (bg[offset + 2]! & 255) === selected[2]) attributes[cell] = attributes[cell]! | TextAttributes.INVERSE;
      fg.set(foreground, offset); bg.set(background, offset);
    }
  });
}
