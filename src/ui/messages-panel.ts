import { BoxRenderable, InputRenderableEvents, RenderableEvents, ScrollBoxRenderable, TextRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import type { CommandId, KeyContext } from "../keybindings/commands.ts";
import type { FooterShortcut } from "./footer.ts";
import { footerKeyHint } from "../keybindings/footer.ts";
import { SearchInput } from "./search-input.ts";
import { halfPageStep } from "./navigation.ts";
import { messageLabels, messageText, type Message, type Messages } from "./messages.ts";
import { singleLine, truncateCells } from "./text.ts";
import { uiTheme } from "./theme.ts";
import { PopupFrame } from "./popup-frame.ts";
import { SearchPopupLayout, centerPopup } from "./popup-layout.ts";
import { paintText } from "./theme-styles.ts";

type Actions = {
  changed(): void;
  fallback(): void;
  details(message: Message): void;
  copy(message: Message): void;
  hint(command: CommandId, context: KeyContext): string;
};
type Row = { root: BoxRenderable; text: TextRenderable };

export class MessagesPanel {
  readonly root: BoxRenderable;
  readonly search: SearchInput;
  readonly list: ScrollBoxRenderable;
  private readonly panel: BoxRenderable;
  private readonly layout: SearchPopupLayout;
  private readonly rows: Row[] = [];
  private items: readonly Message[] = [];
  private cursor = 0;
  private owner: Renderable | undefined;
  private disposed = false;

  constructor(private readonly renderer: CliRenderer, private readonly messages: Messages, private readonly actions: Actions) {
    this.root = new BoxRenderable(renderer, { id: "messages", position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 5900, visible: false,
      onMouseDown: event => event.stopPropagation(), onMouseScroll: event => event.stopPropagation() });
    this.panel = new PopupFrame(renderer, { id: "messages-panel", position: "absolute", border: true, paddingX: 1, flexDirection: "column", minWidth: 0, minHeight: 0 });
    this.search = new SearchInput(renderer, { id: "messages-search", placeholder: "Search messages, levels or sources…" });
    this.list = new ScrollBoxRenderable(renderer, { id: "messages-list", flexGrow: 1, minHeight: 0, scrollX: false,
      contentOptions: { flexDirection: "column" }, onMouseDown: () => this.list.focus() });
    this.layout = new SearchPopupLayout(renderer, { id: "messages", search: this.search, list: this.list });
    this.panel.add(this.layout.root); this.root.add(this.panel);
    const theme = uiTheme(renderer); theme.scrollbars(this.list);
    theme.bindStyles(this.root, styles => {
      this.root.backgroundColor = styles["ui.backdrop"].bg; this.panel.backgroundColor = styles["ui.popup"].bg; this.panel.borderColor = styles["ui.popupBorder"].fg;
      this.paint();
    });
    this.search.on(InputRenderableEvents.INPUT, this.filter);
    renderer.on("resize", this.resize); renderer.on("focused_renderable", this.keepFocus); this.resize();
    this.root.once(RenderableEvents.DESTROYED, () => this.dispose());
  }
  get visible(): boolean { return !this.disposed && !this.root.isDestroyed && this.root.visible; }
  get context(): KeyContext { return this.search.focused ? "messages-search" : "messages"; }
  get focusTargets(): Renderable[] { return [this.search, this.list]; }
  get shortcuts(): readonly FooterShortcut[] {
    return ([ ["messages.open", "Details"], ["messages.copy", "Copy"], ["messages.dismiss", "Close"] ] as const)
      .map(([command, label]) => ({ key: footerKeyHint(command, this.context, this.actions.hint(command, this.context)), label }));
  }
  show(): void {
    if (this.disposed || this.visible) return;
    this.owner = this.renderer.currentFocusedRenderable ?? undefined;
    this.root.visible = true; this.cursor = 0; this.items = []; this.search.value = ""; this.refresh(); this.search.focus(); this.actions.changed();
  }
  hide(restore = true): void {
    if (!this.visible) return;
    this.root.visible = false;
    const owner = this.owner; this.owner = undefined;
    if (restore) {
      let available = !!owner && !owner.isDestroyed;
      for (let node: Renderable | null = owner ?? null; node; node = node.parent as Renderable | null) available &&= node.visible;
      if (available && owner) owner.focus(); else this.actions.fallback();
    }
    this.actions.changed();
  }
  private filter = (): void => { this.cursor = 0; this.items = []; this.refresh(); };
  refresh(): void {
    if (!this.visible) return;
    const selected = this.items[this.cursor]?.id, query = this.search.value.toLocaleLowerCase();
    this.items = this.messages.items.filter(item => messageText(`${item.level} ${item.title ?? ""} ${item.source} ${item.text}`).toLocaleLowerCase().includes(query));
    const previous = this.items.findIndex(item => item.id === selected);
    this.cursor = previous >= 0 ? previous : Math.max(0, Math.min(this.cursor, this.items.length - 1));
    for (const row of this.rows) row.root.destroyRecursively(); this.rows.length = 0;
    for (const [index, item] of this.items.entries()) {
      const root = new BoxRenderable(this.renderer, { id: `messages-row:${item.id}`, height: 2, flexShrink: 0, minWidth: 0,
        onMouseDown: event => { if (event.button === 0) { event.preventDefault(); event.stopPropagation(); this.cursor = index; this.list.focus(); this.paint(); } } });
      const time = new Date(item.timestamp).toLocaleTimeString("en-GB", { hour12: false });
      const width = Math.max(0, Math.min(110, this.renderer.width - 4) - 4);
      // Keep full originals in the store, not in every native single-line preview buffer.
      const heading = truncateCells(`${time} · ${messageLabels[item.level]} · ${singleLine(messageText(item.source))}`, width);
      const preview = truncateCells(singleLine(messageText(item.text)), width);
      const text = new TextRenderable(this.renderer, { width: "100%", height: 2, wrapMode: "none", selectable: false, content: `${heading}\n${preview}` });
      root.add(text); this.list.add(root); this.rows.push({ root, text });
    }
    this.layout.results.showEmpty(!this.items.length ? this.search.value ? "No matching messages" : "No messages yet" : undefined);
    this.paint();
  }
  private paint(): void {
    const styles = uiTheme(this.renderer).styles;
    for (const [index, row] of this.rows.entries()) {
      row.root.backgroundColor = styles[index === this.cursor ? "ui.selection" : "ui.popup"].bg;
      paintText(row.text, styles[`status.${this.items[index]!.level}`]);
    }
    const selected = this.rows[this.cursor]; if (selected) this.list.scrollChildIntoView(selected.root.id);
  }
  command(command: CommandId): void {
    if (!this.visible) return;
    if (command === "messages.dismiss") { this.hide(); return; }
    const item = this.items[this.cursor];
    if (command === "messages.open") { if (item) this.actions.details(item); return; }
    if (command === "messages.copy") { if (item) this.actions.copy(item); return; }
    if (command === "messages.search") { this.search.focus(); return; }
    if (command === "messages.next" || command === "messages.previous") this.cursor += command === "messages.next" ? 1 : -1;
    else if (command === "messages.first") this.cursor = 0;
    else if (command === "messages.last") this.cursor = this.items.length - 1;
    else if (command === "messages.half-page-up" || command === "messages.half-page-down") {
      if (this.search.focused) this.list.focus();
      this.cursor += (command === "messages.half-page-up" ? -1 : 1) * halfPageStep(this.list.viewport.height, 2);
    } else return;
    this.cursor = Math.max(0, Math.min(this.items.length - 1, this.cursor)); this.paint(); this.actions.changed();
  }
  private keepFocus = (): void => {
    if (!this.visible || this.search.isDestroyed || this.list.isDestroyed || this.renderer.root.findDescendantById("text-dialog")?.visible) return;
    for (let node = this.renderer.currentFocusedRenderable; node; node = node.parent as Renderable | null) if (node === this.root) return;
    this.search.focus();
  };
  private resize = (): void => {
    if (this.disposed) return;
    const width = Math.max(1, Math.min(110, this.renderer.width - 4)), height = Math.max(1, Math.floor(this.renderer.height * 0.8));
    centerPopup(this.panel, width, height, this.renderer.width, this.renderer.height);
    this.search.fit(height - 3); if (this.visible) this.refresh();
  };
  dispose(): void {
    if (this.disposed) return;
    this.hide(false); this.disposed = true;
    this.search.off(InputRenderableEvents.INPUT, this.filter); this.renderer.off("resize", this.resize); this.renderer.off("focused_renderable", this.keepFocus);
    if (!this.root.isDestroyed) this.root.destroyRecursively();
  }
}
