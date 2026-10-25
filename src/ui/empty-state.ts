import { BoxRenderable, TextAttributes, TextRenderable, type CliRenderer } from "@opentui/core";
import { uiTheme } from "./theme.ts";
import { paintText } from "./theme-styles.ts";
import { singleLine, truncateCells } from "./text.ts";
import { StateIcon } from "./state-icon.ts";

type EmptyStateContent = {
  icon: string;
  title: string;
  description?: string;
  action?: { key: string; label: string };
};

// A shared, non-interactive empty body; keyboard ownership remains with the feature's panel.
export class EmptyState {
  readonly root: BoxRenderable;
  private readonly icon: StateIcon;
  private readonly title: TextRenderable;
  private readonly description: TextRenderable;
  private readonly hint: TextRenderable;
  private content: EmptyStateContent = { icon: "", title: "" };

  constructor(renderer: CliRenderer, id: string) {
    this.root = new BoxRenderable(renderer, { id, width: "100%", flexGrow: 1, minHeight: 0, minWidth: 0,
      flexDirection: "column", justifyContent: "flex-start", alignItems: "flex-start", overflow: "hidden",
      onSizeChange: () => this.layout() });
    const text = (name: string) => new TextRenderable(renderer, { id: `${id}:${name}`, height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    this.icon = new StateIcon(renderer, `${id}:icon`); this.title = text("title"); this.description = text("description"); this.hint = text("hint");
    this.root.add(this.icon); this.root.add(this.title); this.root.add(this.description); this.root.add(this.hint);
    uiTheme(renderer).bindStyles(this.root, styles => {
      paintText(this.title, { ...styles["ui.label"], attributes: styles["ui.label"].attributes | TextAttributes.BOLD });
      paintText(this.description, styles["ui.muted"]); paintText(this.hint, styles["ui.muted"]);
    });
  }

  update(content: EmptyStateContent): void { this.content = content; this.layout(); }

  private layout(): void {
    if (!this.title || this.root.isDestroyed) return;
    const { icon, title, description = "", action } = this.content;
    const hint = action?.key ? `${action.key}  ${action.label}` : "";
    const width = this.root.width, height = this.root.height;
    for (const [node, value] of [[this.title, title], [this.description, description], [this.hint, hint]] as const) {
      const content = truncateCells(singleLine(value), width), columns = Bun.stringWidth(content);
      node.maxWidth = width; node.width = columns; node.content = content;
      node.marginLeft = Math.max(0, Math.floor((width - columns) / 2));
    }
    // In compact bodies, retain the creation hint before decorative artwork or extra prose.
    this.hint.visible = Boolean(hint && height > 0);
    this.title.visible = height > (this.hint.visible ? 1 : 0);
    const required = Number(this.hint.visible) + Number(this.title.visible);
    this.description.visible = Boolean(description && height > required);
    const rows = required + Number(this.description.visible);
    this.icon.visible = Boolean(icon && height >= rows * 2 + 1);
    // Keep artwork understated in wide panes; short panes retain the same glyph
    // in one row before hiding decoration to protect the title and action hint.
    const requestedRows = width >= 100 && height >= 4 + rows * 2 ? 4
      : width >= 60 && height >= 3 + rows * 2 ? 3 : 1;
    const iconRows = this.icon.update(icon, requestedRows);
    const iconWidth = iconRows > 1 ? iconRows * 2 : Math.max(1, Bun.stringWidth(icon));
    // Use the same integer-cell rule for image boxes and text, rather than native
    // flex centering that rounds them onto different columns in odd-width panes.
    this.icon.marginLeft = Math.max(0, Math.floor((width - iconWidth) / 2));
    const count = rows + Number(this.icon.visible), occupied = rows + (this.icon.visible ? iconRows : 0);
    const gap = height >= occupied + count - 1 ? 1 : 0;
    this.root.gap = gap;
    // Integer-cell centering keeps odd-height icons and text from rounding their gap differently.
    this.root.paddingTop = Math.max(0, Math.floor((height - occupied - gap * Math.max(0, count - 1)) / 2));
  }
}
