import { BoxRenderable, ScrollBoxRenderable, StyledText, TextAttributes, TextRenderable, type CliRenderer } from "@opentui/core";
import type { RequestSummary } from "../request-summary.ts";
import { formatRequestCaption } from "./request-caption.ts";
import { uiTheme } from "../../ui/theme.ts";
import { styleChunk } from "../../ui/theme-styles.ts";
import { truncateCells } from "../../ui/text.ts";

// This is a projection of the runtime queue, never a second queue owned by the TUI.
export class PendingMessages {
  readonly root: BoxRenderable;
  private readonly heading: TextRenderable;
  private readonly scroll: ScrollBoxRenderable;
  private readonly items: TextRenderable[] = [];
  private messages: readonly RequestSummary[] = [];
  private signature = "";

  constructor(private readonly renderer: CliRenderer, private readonly interruptKey: () => string) {
    this.root = new BoxRenderable(renderer, { id: "agent-pending-messages", width: "100%", height: 0, flexShrink: 0,
      flexDirection: "column", visible: false, overflow: "hidden", onSizeChange: () => this.paint() });
    this.heading = new TextRenderable(renderer, { id: "agent-pending-heading", height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    this.scroll = new ScrollBoxRenderable(renderer, { id: "agent-pending-list", height: 1, flexGrow: 1, minHeight: 0, scrollX: false,
      viewportOptions: { onSizeChange: () => this.paint() }, contentOptions: { flexDirection: "column" } });
    this.root.add(this.heading); this.root.add(this.scroll);
    uiTheme(renderer).scrollbars(this.scroll);
    uiTheme(renderer).bind(this.root, () => this.paint());
  }

  get rows(): number { return this.root.visible ? this.root.height : 0; }

  update(messages: readonly RequestSummary[], visible: boolean, maximumRows: number): void {
    const height = visible && messages.length ? Math.min(Math.max(0, maximumRows), 2 + messages.length) : 0;
    const show = height > 0;
    const signature = JSON.stringify([messages, show, height]);
    if (signature === this.signature) return;
    this.signature = signature; this.messages = messages;
    this.root.visible = show; this.root.height = height;
    // Reuse the former help row as separation from the composer without increasing the height budget.
    this.root.paddingBottom = height >= 3 ? 1 : 0;
    this.heading.visible = show; this.scroll.visible = height >= 2;
    while (this.items.length > messages.length) this.items.pop()!.destroy();
    while (this.items.length < messages.length) {
      const item = new TextRenderable(this.renderer, { height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
      this.items.push(item); this.scroll.add(item);
    }
    this.paint();
  }

  private paint(): void {
    if (this.root.isDestroyed || !this.heading || !this.scroll) return;
    const styles = uiTheme(this.renderer).styles, width = this.root.width;
    const key = this.interruptKey();
    let title = "Messages will be sent after the current response and tools finish";
    let beforeKey = " (press ", afterKey = " to interrupt and send immediately)";
    const fits = () => Bun.stringWidth(`• ${title}${key ? beforeKey + key + afterKey : ""}`) <= width;
    if (!fits()) title = "Messages waiting to be sent";
    if (!fits()) { title = "Messages waiting"; beforeKey = " ("; afterKey = ": interrupt & send)"; }
    const showHint = !!key && fits();
    this.heading.content = new StyledText([
      styleChunk(truncateCells("• ", width), styles["ui.muted"]),
      styleChunk(truncateCells(title, Math.max(0, width - 2)), styles["ui.label"]),
      ...(showHint ? [
        styleChunk(beforeKey, styles["ui.muted"]),
        { ...styleChunk(key, styles["ui.label"]), attributes: styles["ui.label"].attributes | TextAttributes.BOLD },
        styleChunk(afterKey, styles["ui.muted"]),
      ] : []),
    ]);
    const itemWidth = this.scroll.viewport.width;
    this.items.forEach((item, index) => {
      item.content = new StyledText([
        styleChunk(truncateCells("  ↳ ", itemWidth), styles["ui.muted"]),
        styleChunk(formatRequestCaption(this.messages[index]!, Math.max(0, itemWidth - 4)), styles["ui.label"]),
      ]);
    });
  }
}
