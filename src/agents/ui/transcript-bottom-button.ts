import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import { uiTheme } from "../../ui/theme.ts";
import { truncateCells } from "../../ui/text.ts";

// A viewport overlay: the blank row below the button never changes the scroll range.
export class TranscriptBottomButton extends BoxRenderable {
  private readonly label: TextRenderable;

  constructor(renderer: CliRenderer, activate: () => void) {
    super(renderer, { id: "transcript-bottom-overlay", position: "absolute", left: 0, bottom: 0,
      width: "100%", height: 2, paddingBottom: 1, alignItems: "center", zIndex: 1, visible: false });
    const button = new BoxRenderable(renderer, { id: "transcript-bottom-button", height: 1, paddingX: 1, flexShrink: 0,
      onMouseDown: (event) => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation(); activate();
      } });
    // Keyboard activation belongs to transcript.latest; pointer activation must not steal prompt focus.
    this.label = new TextRenderable(renderer, { height: 1, wrapMode: "none", selectable: false });
    button.add(this.label); this.add(button);
    uiTheme(renderer).bind(this, (colors) => {
      this.backgroundColor = colors.panel; button.backgroundColor = colors.selected; this.label.fg = colors.accent;
    });
  }

  update(visible: boolean, hint: string, width: number): void {
    this.visible = visible;
    if (!visible) return;
    const caption = `↓ Back to bottom${hint ? ` · ${hint}` : ""}`;
    const content = truncateCells(caption, Math.max(0, width - 2));
    if (this.label.plainText !== content) this.label.content = content;
  }
}
