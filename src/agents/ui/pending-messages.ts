import { BoxRenderable, ScrollBoxRenderable, StyledText, TextAttributes, TextRenderable, type CliRenderer } from "@opentui/core";
import type { RequestSummary } from "../request-summary.ts";
import { formatRequestCaption } from "./request-caption.ts";
import { uiTheme } from "../../ui/theme.ts";

// This is a projection of the runtime queue, never a second queue owned by the TUI.
export class PendingMessages {
  readonly root: BoxRenderable;
  private readonly heading: TextRenderable;
  private readonly hint: TextRenderable;
  private readonly scroll: ScrollBoxRenderable;
  private readonly items: TextRenderable[] = [];
  private messages: readonly RequestSummary[] = [];
  private signature = "";

  constructor(private readonly renderer: CliRenderer, private readonly interruptKey: () => string) {
    this.root = new BoxRenderable(renderer, { id: "agent-pending-messages", width: "100%", height: 0, flexShrink: 0,
      flexDirection: "column", visible: false, overflow: "hidden", onSizeChange: () => this.paint() });
    this.heading = new TextRenderable(renderer, { height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    this.hint = new TextRenderable(renderer, { id: "agent-pending-hint", height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    this.scroll = new ScrollBoxRenderable(renderer, { id: "agent-pending-list", height: 1, flexGrow: 1, minHeight: 0, scrollX: false,
      contentOptions: { flexDirection: "column" } });
    this.root.add(this.heading); this.root.add(this.hint); this.root.add(this.scroll);
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
    this.heading.visible = height >= 3; this.hint.visible = height >= 1; this.scroll.visible = height >= 2;
    while (this.items.length > messages.length) this.items.pop()!.destroy();
    while (this.items.length < messages.length) {
      const item = new TextRenderable(this.renderer, { height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
      this.items.push(item); this.scroll.add(item);
    }
    this.paint();
  }

  private paint(): void {
    if (this.root.isDestroyed || !this.heading) return;
    const colors = uiTheme(this.renderer).colors, width = this.root.width;
    this.heading.fg = colors.muted;
    this.heading.content = width >= 64 ? "Messages will be sent after the current response and tools finish" : "Messages waiting to be sent";
    const key = this.interruptKey().toLowerCase();
    this.hint.content = key ? new StyledText([
      { __isChunk: true, text: "(press ", fg: colors.muted },
      { __isChunk: true, text: key, fg: colors.text, attributes: TextAttributes.BOLD },
      { __isChunk: true, text: " to interrupt and send immediately)", fg: colors.muted },
    ]) : "";
    this.items.forEach((item, index) => { item.fg = colors.text; item.content = formatRequestCaption(this.messages[index]!, Math.max(0, width - 2)); });
  }
}
