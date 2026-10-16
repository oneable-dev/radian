import type { RGBA } from "@opentui/core";
import { blendColors, type UiColors } from "../../ui/theme.ts";
import type { TranscriptKind } from "../transcript.ts";

// Subtle host-palette tints keep the section identity in both light and dark themes.
export function transcriptBackground(kind: TranscriptKind, colors: UiColors): RGBA {
  switch (kind) {
    case "user": return blendColors(colors.panel, colors.accent, 0.10);
    case "assistant": return blendColors(colors.panel, colors.text, 0.04);
    case "thinking": return blendColors(colors.panel, colors.keyword, 0.08);
    case "tool": return blendColors(colors.panel, colors.info, 0.09);
    case "notice": return blendColors(colors.panel, colors.warning, 0.08);
  }
}

export function transcriptSpacing(height: number) {
  const compact = height < 18;
  return { sectionGap: compact ? 1 : 2, bodyGap: compact ? 0 : 1, bottomInset: compact ? 0 : 1 };
}
