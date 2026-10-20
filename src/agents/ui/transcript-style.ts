import type { RGBA } from "@opentui/core";
import type { UiStyles } from "../../ui/theme-styles.ts";
import type { TranscriptKind } from "../transcript.ts";

// Only user, tool and notice blocks are tinted. Agent prose/reasoning use the host's plain surface.
export function transcriptBackground(kind: TranscriptKind, styles: UiStyles, fallback: RGBA): RGBA {
  const group = kind === "user" ? "transcript.user" : kind === "tool" ? "transcript.tool" : kind === "notice" ? "transcript.notice" : "ui.text";
  return styles[group].bg ?? styles["ui.text"].bg ?? fallback;
}

export function transcriptSpacing() {
  return { sectionGap: 1, bodyGap: 1, verticalInset: 1 };
}
