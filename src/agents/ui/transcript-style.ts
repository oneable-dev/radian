import { RGBA } from "@opentui/core";
import { blendColors, type UiColors } from "../../ui/theme.ts";
import type { TranscriptKind } from "../transcript.ts";

// Only user, tool and notice blocks are tinted. Agent prose/reasoning use the host's plain surface.
export function transcriptBackground(kind: TranscriptKind, colors: UiColors): RGBA {
  switch (kind) {
    case "user": return blendColors(colors.panel, colors.accent, 0.10);
    case "assistant": case "thinking": return colors.panel;
    case "tool": return blendColors(colors.panel, colors.info, 0.09);
    case "notice": return blendColors(colors.panel, colors.warning, 0.08);
  }
}

export function transcriptThinkingColor(colors: UiColors): RGBA {
  // Keep reasoning neutral even with tinted host palettes or a colored muted-role override.
  const muted = blendColors(colors.panel, colors.text, 0.65);
  const gray = muted.r * 0.299 + muted.g * 0.587 + muted.b * 0.114;
  return RGBA.fromValues(gray, gray, gray);
}

export function transcriptSpacing() {
  return { sectionGap: 2, bodyGap: 1, bottomInset: 1 };
}
