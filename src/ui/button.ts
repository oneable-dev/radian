import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import { uiTheme } from "./theme.ts";
import { paintText } from "./theme-styles.ts";

export type ButtonVariant = "default" | "work-tab" | "session-tab";

// Input routing belongs to the workbench; this control owns only pointer activation and presentation.
export class Button extends BoxRenderable {
  private readonly label: TextRenderable;
  private selected: boolean | undefined;
  private readonly paint: () => void;

  constructor(renderer: CliRenderer, label: string, activate: () => void, private readonly variant: ButtonVariant = "default") {
    super(renderer, {
      height: 1, flexShrink: 0, paddingX: 1, focusable: true,
      onMouseDown: (event) => {
        if (event.button !== 0) return;
        event.stopPropagation(); event.preventDefault(); this.focus(); activate();
      },
    });
    this.label = new TextRenderable(renderer, { content: label, height: 1, wrapMode: "none", selectable: false });
    this.add(this.label);
    const theme = uiTheme(renderer);
    this.paint = () => {
      const styles = theme.styles;
      const group = this.selected === undefined ? this.focused ? "ui.buttonFocused" : "ui.button"
        : this.variant === "default" ? this.selected ? "ui.buttonActive" : "ui.buttonInactive"
        : this.selected ? this.variant === "session-tab" ? "ui.tabActive" : "ui.workTabActive"
        : this.variant === "work-tab" && this.focused ? "ui.workTabFocused" : "ui.tab";
      const value = styles[group]; paintText(this.label, value);
      this.backgroundColor = this.variant === "work-tab" ? value.bg : this.focused ? value.bg ?? styles["ui.selection"].bg
        : this.variant === "session-tab" && this.selected ? value.bg ?? styles["ui.selectionInactive"].bg : value.bg;
    };
    theme.bind(this, this.paint); this.on("focused", this.paint); this.on("blurred", this.paint);
  }

  setLabel(value: string): void { this.label.content = value; }

  set active(value: boolean) {
    this.selected = value;
    this.paint();
  }
}

export type ButtonFactory = (label: string, activate: () => void, actionLabel?: string, variant?: ButtonVariant) => Button;
