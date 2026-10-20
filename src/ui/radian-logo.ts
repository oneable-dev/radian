import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import { uiTheme } from "./theme.ts";
import { paintText } from "./theme-styles.ts";

// Temporary artwork. Replace this component when the Radian logo is finalized;
// transcript visibility and layout do not depend on its shape or rendering format.
const placeholder = [
  "    ▄▄    ",
  "  ▄████▄  ",
  "▄██▀  ▀██▄",
  "▀██▄  ▄██▀",
  "  ▀████▀  ",
  "    ▀▀    ",
];
const width = Math.max(...placeholder.map((line) => Bun.stringWidth(line)));

export class RadianLogo extends BoxRenderable {
  private readonly mark: TextRenderable;

  constructor(renderer: CliRenderer) {
    super(renderer, { id: "radian-logo", position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
      justifyContent: "center", alignItems: "center", overflow: "hidden", onSizeChange: () => this.resizeMark() });
    this.mark = new TextRenderable(renderer, { id: "radian-logo-mark", width, height: placeholder.length, flexShrink: 0,
      content: placeholder.join("\n"), wrapMode: "none", selectable: false });
    this.add(this.mark);
    uiTheme(renderer).bindStyles(this, (styles) => paintText(this.mark, styles["branding.logo"]));
  }

  private resizeMark(): void {
    if (!this.mark || this.isDestroyed) return;
    const compact = this.width < width || this.height < placeholder.length;
    this.mark.width = compact ? 1 : width;
    this.mark.height = compact ? 1 : placeholder.length;
    const content = compact ? "◇" : placeholder.join("\n");
    if (this.mark.plainText !== content) this.mark.content = content;
  }
}
