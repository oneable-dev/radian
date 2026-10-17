import { BoxRenderable, StyledText, TextRenderable, type CliRenderer } from "@opentui/core";
import type { TranscriptSection } from "../transcript.ts";
import { uiTheme } from "../../ui/theme.ts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function fitRequest(text: string, width: number): string {
  if (width <= 0) return "";
  if (Bun.stringWidth(text) <= width) return text;
  if (width <= 3) return ".".repeat(width);
  let prefix = "", used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const cells = Bun.stringWidth(segment);
    if (used + cells > width - 3) break;
    prefix += segment; used += cells;
  }
  return `${prefix.trimEnd()}...`;
}

// A passive anchor for the request already present in the transcript, never a draft or queue.
export class RequestHeading {
  readonly root: BoxRenderable;
  private readonly display: TextRenderable;
  private text = "";

  constructor(private readonly renderer: CliRenderer) {
    this.root = new BoxRenderable(renderer, { id: "agent-request", width: "100%", height: 1, minWidth: 0, flexShrink: 0,
      visible: false, onSizeChange: () => this.paint() });
    this.display = new TextRenderable(renderer, { width: "100%", height: 1, minWidth: 0, wrapMode: "none", selectable: false });
    this.root.add(this.display);
    uiTheme(renderer).bind(this.root, () => this.paint());
  }

  update(sections: readonly TranscriptSection[] | undefined, visible: boolean): void {
    if (this.root.isDestroyed) return;
    const request = sections?.findLast((section) => section.kind === "user" || section.skillName !== undefined);
    const text = request ? request.skillName !== undefined ? `/skill:${request.skillName}` : request.text : "";
    this.text = text.replace(/[\s\x00-\x1f\x7f-\x9f]+/gu, " ").trim();
    this.root.visible = visible && this.text.length > 0;
    this.paint();
  }

  private paint(): void {
    if (!this.root || this.root.isDestroyed || !this.root.visible) return;
    const width = Math.max(0, Math.floor(this.root.width)), colors = uiTheme(this.renderer).colors;
    // Keep useful request text even when the work pane cannot accommodate the label.
    const label = width >= 12 ? "Request " : "";
    this.display.content = new StyledText([
      { __isChunk: true, text: label, fg: colors.muted },
      { __isChunk: true, text: fitRequest(this.text, width - label.length), fg: colors.text },
    ]);
  }
}
