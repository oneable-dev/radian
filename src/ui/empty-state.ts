import { BoxRenderable, TextAttributes, TextRenderable, type CliRenderer } from "@opentui/core";
import { uiTheme } from "./theme.ts";
import { paintText } from "./theme-styles.ts";
import { singleLine, truncateCells } from "./text.ts";

type EmptyStateContent = {
  icon: string;
  title: string;
  description?: string;
  action?: { key: string; label: string };
};

// A shared, non-interactive empty body; keyboard ownership remains with the feature's panel.
export class EmptyState {
  readonly root: BoxRenderable;
  private readonly icon: TextRenderable;
  private readonly title: TextRenderable;
  private readonly description: TextRenderable;
  private readonly hint: TextRenderable;
  private content: EmptyStateContent = { icon: "", title: "" };

  constructor(renderer: CliRenderer, id: string) {
    this.root = new BoxRenderable(renderer, { id, width: "100%", flexGrow: 1, minHeight: 0, minWidth: 0,
      flexDirection: "column", justifyContent: "center", alignItems: "center", overflow: "hidden",
      onSizeChange: () => this.layout() });
    const text = (name: string) => new TextRenderable(renderer, { id: `${id}:${name}`, height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    this.icon = text("icon"); this.title = text("title"); this.description = text("description"); this.hint = text("hint");
    this.root.add(this.icon); this.root.add(this.title); this.root.add(this.description); this.root.add(this.hint);
    uiTheme(renderer).bindStyles(this.root, styles => {
      paintText(this.icon, styles["ui.muted"]);
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
    for (const [node, value] of [[this.icon, icon], [this.title, title], [this.description, description], [this.hint, hint]] as const) {
      node.maxWidth = width; node.content = truncateCells(singleLine(value), width);
    }
    // In compact bodies, retain the creation hint before decorative artwork or extra prose.
    this.hint.visible = Boolean(hint && height > 0);
    this.title.visible = height > (this.hint.visible ? 1 : 0);
    const required = Number(this.hint.visible) + Number(this.title.visible);
    this.description.visible = Boolean(description && height > required);
    const rows = required + Number(this.description.visible);
    this.icon.visible = Boolean(icon && height >= rows * 2 + 1);
    const count = rows + Number(this.icon.visible);
    this.root.gap = height >= count * 2 - 1 ? 1 : 0;
  }
}
