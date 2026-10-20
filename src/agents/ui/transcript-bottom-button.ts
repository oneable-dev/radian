import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import { uiTheme } from "../../ui/theme.ts";
import { truncateCells } from "../../ui/text.ts";

// Reuse an existing blank row outside the viewport; never mask transcript content or add a gutter.
export class TranscriptBottomButton extends BoxRenderable {
  private readonly label: TextRenderable;

  constructor(renderer: CliRenderer, activate: () => void) {
    super(renderer, { id: "transcript-bottom-button", position: "absolute", height: 1, paddingX: 1, zIndex: 1, visible: false,
      onMouseDown: (event) => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation(); activate();
      } });
    // Keyboard activation belongs to transcript.latest; pointer activation must not steal prompt focus.
    this.label = new TextRenderable(renderer, { height: 1, wrapMode: "none", selectable: false });
    this.add(this.label);
    uiTheme(renderer).bind(this, (colors) => { this.backgroundColor = colors.selected; this.label.fg = colors.accent; });
  }

  update(visible: boolean, hint: string, space: { left: number; top: number; width: number } | null): void {
    const show = visible && space !== null && space.width >= 3;
    if (this.visible !== show) this.visible = show;
    if (!show || !space) return;
    const caption = `↓ Back to bottom${hint ? ` · ${hint}` : ""}`;
    const content = truncateCells(caption, space.width - 2), width = Bun.stringWidth(content) + 2;
    if (this.label.plainText !== content) this.label.content = content;
    const left = space.left + Math.floor((space.width - width) / 2);
    if (this.width !== width) this.width = width;
    if (this.left !== left) this.left = left;
    if (this.top !== space.top) this.top = space.top;
  }
}
