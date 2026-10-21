import { BoxRenderable, TextRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import { uiTheme } from "./theme.ts";
import { paintText } from "./theme-styles.ts";
import { singleLine, truncateCells } from "./text.ts";

export const SESSION_TAB_WIDTH = 18;

type SessionTabOptions = {
  id: string;
  closeId: string;
  closeLabel: string;
  select(): void;
  close(): void;
  button(label: string, activate: () => void, action: string): BoxRenderable;
  leading?: Renderable;
  focusable?: boolean;
};

// Session owners retain navigation and lifecycle; this frame owns shared tab geometry and styling.
export class SessionTab {
  readonly root: BoxRenderable;
  readonly title: TextRenderable;
  readonly closeButton: BoxRenderable;
  private label = "";
  private width = SESSION_TAB_WIDTH;
  private active = false;
  private stripFocused = false;

  constructor(private readonly renderer: CliRenderer, private readonly options: SessionTabOptions) {
    this.root = new BoxRenderable(renderer, { id: options.id, width: SESSION_TAB_WIDTH, height: 1, flexShrink: 0,
      flexDirection: "row", paddingX: 1, gap: 1, focusable: options.focusable ?? false,
      onMouseDown: event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        if (options.focusable) this.root.focus();
        options.select();
      } });
    this.title = new TextRenderable(renderer, { height: 1, minWidth: 0, flexGrow: 1, flexShrink: 1, wrapMode: "none", selectable: false });
    this.closeButton = options.button("×", () => options.close(), options.closeLabel);
    this.closeButton.id = options.closeId; this.closeButton.paddingX = 0; this.closeButton.width = 1;
    // Closing an inactive tab must not first select it or steal native input focus.
    this.closeButton.onMouseDown = event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation(); options.close();
    };
    if (options.leading) this.root.add(options.leading);
    this.root.add(this.title); this.root.add(this.closeButton);
    uiTheme(renderer).bindStyles(this.root, () => this.paint());
    this.root.on("focused", this.paint); this.root.on("blurred", this.paint);
  }

  resize(availableWidth: number): void {
    this.width = Math.max(1, Math.min(SESSION_TAB_WIDTH, availableWidth || SESSION_TAB_WIDTH));
    this.root.width = this.width;
    this.root.paddingX = this.width >= 4 ? 1 : 0;
    this.root.gap = this.width >= 4 ? 1 : 0;
    this.refreshLabel();
  }

  setLabel(label: string): void {
    this.label = singleLine(label); this.refreshLabel();
  }

  update(active: boolean, stripFocused = false): void {
    this.active = active; this.stripFocused = stripFocused; this.paint();
  }

  private refreshLabel(): void {
    const gap = this.width >= 4 ? 1 : 0, padding = gap * 2;
    const leading = this.options.leading;
    const reserved = padding + 1 + gap + (leading?.visible ? leading.width + gap : 0);
    const width = Math.max(0, this.width - reserved);
    this.title.content = truncateCells(this.label, width);
  }

  private paint = (): void => {
    if (this.root.isDestroyed) return;
    const styles = uiTheme(this.renderer).styles;
    const focused = this.root.focused || (this.active && this.stripFocused);
    this.root.backgroundColor = styles[focused ? "ui.selection" : this.active ? "ui.selectionInactive" : "ui.text"].bg;
    paintText(this.title, styles[this.active ? "ui.tabActive" : "ui.tab"]);
  };
}
