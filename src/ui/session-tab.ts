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
};

// Session owners retain navigation and lifecycle; this frame owns shared tab geometry and styling.
export class SessionTab {
  readonly root: BoxRenderable;
  readonly title: TextRenderable;
  readonly closeButton: BoxRenderable;
  private readonly number: TextRenderable;
  private label = "";
  private width = SESSION_TAB_WIDTH;
  private active = false;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly options: SessionTabOptions,
  ) {
    this.root = new BoxRenderable(renderer, {
      id: options.id,
      width: SESSION_TAB_WIDTH,
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      paddingLeft: 2,
      paddingRight: 1,
      gap: 1,
      focusable: false,
      onMouseDown: (event) => {
        if (event.button !== 0) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        options.select();
      },
    });
    this.number = new TextRenderable(renderer, {
      id: `${options.id}:number`,
      content: "1.",
      width: 2,
      height: 1,
      flexShrink: 0,
      selectable: false,
    });
    this.title = new TextRenderable(renderer, {
      id: `${options.id}:title`,
      height: 1,
      minWidth: 0,
      flexGrow: 1,
      flexShrink: 1,
      wrapMode: "none",
      selectable: false,
    });
    this.closeButton = options.button("×", () => options.close(), options.closeLabel);
    this.closeButton.id = options.closeId;
    this.closeButton.paddingX = 0;
    this.closeButton.width = 1;
    this.closeButton.focusable = false;
    // Closing an inactive tab must not first select it or steal native input focus.
    this.closeButton.onMouseDown = (event) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      options.close();
    };
    this.root.add(this.number);
    if (options.leading) {
      this.root.add(options.leading);
    }

    this.root.add(this.title);
    this.root.add(this.closeButton);
    uiTheme(renderer).bindStyles(this.root, () => this.paint());
  }

  resize(availableWidth: number): void {
    this.width = Math.max(1, Math.min(SESSION_TAB_WIDTH, availableWidth || SESSION_TAB_WIDTH));
    this.root.width = this.width;
    this.refreshLabel();
  }

  setPosition(position: number): void {
    const label = `${position}.`;
    this.number.content = label;
    this.number.width = label.length;
    this.refreshLabel();
  }

  setLabel(label: string): void {
    this.label = singleLine(label);
    this.refreshLabel();
  }

  update(active: boolean): void {
    this.active = active;
    this.paint();
  }

  private refreshLabel(): void {
    // The left inset and close control take priority if the number cannot fit.
    this.number.visible = this.width >= this.number.width + 2;

    const leading = this.options.leading;
    const controls =
      1 +
      (this.number.visible ? this.number.width : 0) +
      (leading?.visible ? leading.width : 0) +
      1;
    const gaps = 1 + Number(this.number.visible) + Number(!!leading?.visible);
    const gap = this.width >= controls + gaps + 2 ? 1 : 0;

    this.root.paddingLeft = 1 + gap;
    this.root.paddingRight = gap;
    this.root.gap = gap;

    const reserved = controls + gap * (gaps + 2);
    const width = Math.max(0, this.width - reserved);

    this.title.content = truncateCells(this.label, width);
  }

  private paint = (): void => {
    if (this.root.isDestroyed) {
      return;
    }

    const styles = uiTheme(this.renderer).styles;
    this.root.backgroundColor = styles[this.active ? "ui.selectionInactive" : "ui.text"].bg;
    paintText(this.number, styles[this.active ? "ui.tabActive" : "ui.muted"]);
    paintText(this.title, styles[this.active ? "ui.tabActive" : "ui.tab"]);
  };
}
