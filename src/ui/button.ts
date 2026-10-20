import { BoxRenderable, TextAttributes, TextRenderable, type CliRenderer } from "@opentui/core";
import { uiTheme } from "./theme.ts";

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
      const colors = theme.colors;
      this.backgroundColor = this.variant === "work-tab" ? undefined : this.focused ? colors.selected
        : this.variant === "session-tab" && this.selected ? colors.surface : undefined;
      this.label.fg = this.selected === undefined ? colors.accent : this.selected ? colors.text : colors.muted;
      const underline = this.variant !== "session-tab" && (this.selected || this.variant === "work-tab" && this.focused);
      this.label.attributes = (this.selected ? TextAttributes.BOLD : 0) | (underline ? TextAttributes.UNDERLINE : 0);
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
