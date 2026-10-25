import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import wordmark from "../../assets/radian.txt" with { type: "text" };
import packageInfo from "../../package.json";
import { uiTheme } from "./theme.ts";
import { paintText } from "./theme-styles.ts";

// Share the banner's text source without its fixed light/dark image colors.
const artwork = wordmark.trimEnd();
const lines = artwork.split("\n");
const width = Math.max(...lines.map((line) => Bun.stringWidth(line)));
const compactWordmark = "RADIAN";
const version = `v${packageInfo.version}`;

export class RadianLogo extends BoxRenderable {
  private readonly mark: TextRenderable;
  private readonly version: TextRenderable;

  constructor(renderer: CliRenderer) {
    super(renderer, { id: "radian-logo", position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
      flexDirection: "column", justifyContent: "center", alignItems: "center", overflow: "hidden", onSizeChange: () => this.resizeMark() });
    this.mark = new TextRenderable(renderer, { id: "radian-logo-mark", width, height: lines.length, flexShrink: 0,
      content: artwork, wrapMode: "none", selectable: false });
    this.version = new TextRenderable(renderer, { id: "radian-logo-version", width: Bun.stringWidth(version), height: 1, flexShrink: 0,
      content: version, wrapMode: "none", selectable: false });
    this.add(this.mark); this.add(this.version);
    uiTheme(renderer).bindStyles(this, (styles) => {
      paintText(this.mark, styles["branding.logo"]); paintText(this.version, styles["ui.muted"]);
    });
  }

  private resizeMark(): void {
    if (!this.mark || this.isDestroyed) return;
    const compact = this.width < width || this.height < lines.length;
    const content = compact ? (this.width >= compactWordmark.length ? compactWordmark : "R") : artwork;
    this.mark.width = compact ? Bun.stringWidth(content) : width;
    this.mark.height = compact ? 1 : lines.length;
    if (this.mark.plainText !== content) this.mark.content = content;
    this.version.visible = this.width >= this.version.width && this.height >= this.mark.height + 2;
    this.gap = this.version.visible ? 1 : 0;
  }
}
