import { RGBA, TextAttributes, type OptimizedBuffer } from "@opentui/core";
import type { UiColors } from "./theme.ts";
import { selectionGroups, type UiStyles } from "./theme-styles.ts";

// Encode terminal-default colors rather than gray RGB escape sequences. This runs
// inside OpenTUI's synchronous post-process lease and never changes text/link IDs.
export function monochromeFrame(
  buffer: OptimizedBuffer,
  colors?: UiColors,
  styles?: UiStyles,
): void {
  const foreground = RGBA.defaultForeground(colors?.text).buffer;
  const background = RGBA.defaultBackground(colors?.panel).buffer;
  const panel = (styles?.["ui.text"].bg ?? colors?.panel)?.toInts();
  const candidates = styles
    ? selectionGroups.flatMap((group) => (styles[group].bg ? [styles[group].bg!.toInts()] : []))
    : colors
      ? [colors.selected.toInts()]
      : [];
  const backgrounds = candidates.filter(
    (selected) => panel && selected.some((channel, index) => index < 3 && channel !== panel[index]),
  );

  buffer.withBuffers(({ fg, bg, attributes }) => {
    for (let offset = 0, cell = 0; offset < fg.length; offset += 4, cell++) {
      if (
        backgrounds.some(
          (selected) =>
            (bg[offset]! & 255) === selected[0] &&
            (bg[offset + 1]! & 255) === selected[1] &&
            (bg[offset + 2]! & 255) === selected[2],
        )
      ) {
        attributes[cell] = attributes[cell]! | TextAttributes.INVERSE;
      }

      fg.set(foreground, offset);
      bg.set(background, offset);
    }
  });
}
