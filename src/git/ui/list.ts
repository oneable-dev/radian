import { BoxRenderable, ScrollBoxRenderable, StyledText, TextRenderable, type CliRenderer } from "@opentui/core";
import type { GraphCell } from "./graph.ts";
import { uiTheme } from "../../ui/theme.ts";
import { paintText, styleBackground, styleChunk, type StyleGroup, type UiStyles } from "../../ui/theme-styles.ts";
import { blendColors } from "../../ui/color.ts";
import { truncateCells } from "../../ui/text.ts";
import { halfPageStep } from "../../ui/navigation.ts";

type GitListSpan = { text: string; color?: StyleGroup };
type HistoryDecoration = { refs: readonly string[]; color: StyleGroup; nodeColumn: number };
export type GitListItem = { key: string; label: string | readonly GitListSpan[]; graph?: GraphCell[]; connector?: GraphCell[];
  history?: HistoryDecoration; color?: StyleGroup; disabled?: boolean; gapBefore?: boolean };
type Annotation = { item: GitListItem; gutter: BoxRenderable; ref: TextRenderable; leader: TextRenderable;
  node: TextRenderable; link: TextRenderable; indent: BoxRenderable };
const styledText = (spans: readonly GitListSpan[], styles: UiStyles) => new StyledText(spans.map((span) => styleChunk(span.text, styles[span.color ?? "ui.label"])));

export class GitList {
  readonly root: ScrollBoxRenderable;
  private items: readonly GitListItem[] = [];
  private signature = "";
  private selected: string | null = null;
  private refWidth = 0;
  private expandedRef: string | null = null;
  private rowExtent = 0;
  private readonly tail: BoxRenderable;
  private readonly offsets = new Map<string, number>();
  private readonly rows = new Map<string, BoxRenderable>();
  private readonly annotations = new Map<string, Annotation>();

  constructor(private readonly renderer: CliRenderer, id: string, private readonly choose: (key: string) => void,
    private readonly activate: (key: string) => void, private readonly activateOnClick = true) {
    this.root = new ScrollBoxRenderable(renderer, { id, flexGrow: 1, minHeight: 0, minWidth: 0, scrollX: false,
      contentOptions: { flexDirection: "column" }, onMouseDown: () => this.root.focus() });
    this.tail = new BoxRenderable(renderer, { id: `${id}:tail`, height: 0, flexShrink: 0 }); this.root.add(this.tail);
    uiTheme(renderer).scrollbars(this.root);
    this.root.on("focused", () => this.highlight()); this.root.on("blurred", () => this.highlight());
  }
  get selectedKey(): string | null { return this.selected; }
  get selectedOffset(): number | undefined { return this.offsets.get(this.selected ?? ""); }
  get rowsHeight(): number { return this.rowExtent; }
  setTailHeight(height: number): void { this.tail.height = Math.max(0, Math.round(height)); }
  get selectedRow(): Readonly<{ y: number; height: number }> | undefined { return this.rows.get(this.selected ?? ""); }
  get selectedColor(): StyleGroup | undefined { return this.annotations.get(this.selected ?? "")?.item.history?.color; }

  // Focus expansion changes only column geometry, never row identity or graph height.
  setRefWidth(width: number, expanded: string | null): void {
    if (width === this.refWidth && expanded === this.expandedRef) return;
    const resized = width !== this.refWidth, previous = this.expandedRef;
    this.refWidth = width; this.expandedRef = expanded;
    if (resized) { for (const annotation of this.annotations.values()) this.paintAnnotation(annotation); }
    else for (const key of [previous, expanded]) {
      const annotation = this.annotations.get(key ?? ""); if (annotation) this.paintAnnotation(annotation);
    }
  }
  update(items: readonly GitListItem[], selected: string | null): void {
    const previous = this.selected;
    this.items = items; this.selected = selected;
    const signature = JSON.stringify(items);
    if (signature !== this.signature) {
      this.signature = signature;
      for (const row of this.rows.values()) row.destroyRecursively();
      this.rows.clear(); this.annotations.clear(); this.offsets.clear(); this.rowExtent = 0;
      for (const item of items) {
        this.rowExtent += item.gapBefore ? 1 : 0; this.offsets.set(item.key, this.rowExtent);
        this.rowExtent += item.connector ? 2 : 1;
        let down: { x: number; y: number } | undefined;
        const row = new BoxRenderable(this.renderer, { id: `${this.root.id}:${item.key}`, height: item.connector ? 2 : 1, flexShrink: 0, marginTop: item.gapBefore ? 1 : 0,
          flexDirection: "column", onMouseDown: (event) => { if (event.button === 0) down = { x: event.x, y: event.y }; },
          onMouseUp: (event) => {
            if (event.button !== 0 || !down || event.x !== down.x || event.y !== down.y || item.disabled) { down = undefined; return; }
            down = undefined; this.select(item.key); if (this.activateOnClick) this.activate(item.key);
          } });
        const line = new BoxRenderable(this.renderer, { height: 1, flexDirection: "row", flexShrink: 0, minWidth: 0 });
        if (item.history && item.graph) {
          const gutter = new BoxRenderable(this.renderer, { width: this.refWidth, height: 1, flexShrink: 0, flexDirection: "row", overflow: "hidden" });
          const ref = new TextRenderable(this.renderer, { id: `${row.id}:refs`, height: 1, selectable: true, wrapMode: "none", flexShrink: 0 });
          const leader = new TextRenderable(this.renderer, { height: 1, selectable: false, wrapMode: "none", flexShrink: 0 });
          gutter.add(ref); gutter.add(leader); line.add(gutter);
          const node = new TextRenderable(this.renderer, { id: `${row.id}:graph`, height: 1, width: item.graph.length, selectable: false, flexShrink: 0 });
          const link = new TextRenderable(this.renderer, { id: `${row.id}:message-link`, height: 1, width: 4, content: "    ", selectable: false, flexShrink: 0 });
          line.add(node); line.add(link);
          line.add(new BoxRenderable(this.renderer, { id: `${row.id}:message-gap`, width: 2, height: 1, flexShrink: 0 }));
          const indent = new BoxRenderable(this.renderer, { width: this.refWidth, height: 1, flexShrink: 0 });
          this.annotations.set(item.key, { item, gutter, ref, leader, node, link, indent });
        } else if (item.graph) line.add(this.graph(item.graph, item.graph.length));
        const label = new TextRenderable(this.renderer, { id: `${row.id}:label`, height: 1, flexGrow: 1,
          minWidth: 0, wrapMode: "none", selectable: !item.disabled, truncate: true });
        uiTheme(this.renderer).bindStyles(label, (styles) => {
          paintText(label, styles[item.color ?? "ui.label"]);
          label.content = typeof item.label === "string" ? item.label : styledText(item.label, styles);
          label.selectionBg = styles["ui.selection"].bg; label.selectionFg = styles["ui.selection"].fg;
        });
        uiTheme(this.renderer).bindStyles(row, (styles) => {
          row.backgroundColor = !item.history && item.key === this.selected ? this.selectionColor : styles["ui.text"].bg;
          const annotation = this.annotations.get(item.key); if (annotation) this.paintAnnotation(annotation);
        });
        line.add(label); row.add(line);
        if (item.connector) {
          const bottom = new BoxRenderable(this.renderer, { height: 1, flexDirection: "row", flexShrink: 0 });
          const annotation = this.annotations.get(item.key); if (annotation) bottom.add(annotation.indent);
          bottom.add(this.graph(item.connector)); row.add(bottom);
        }
        this.root.add(row); this.rows.set(item.key, row);
      }
      // Only the shared history viewport scrolls when an expanded details card is taller than its rows.
      this.root.remove(this.tail); this.root.add(this.tail);
    }
    this.highlight(previous);
  }
  private paintAnnotation(annotation: Annotation): void {
    const { item, gutter, ref, leader, node, link, indent } = annotation, decoration = item.history!;
    const styles = uiTheme(this.renderer).styles, color = styles[decoration.color];
    const expanded = item.key === this.expandedRef;
    const connected = decoration.refs.length > 0 || expanded;
    const first = decoration.refs[0] ?? (expanded ? `Commit ${item.key.slice(0, 7)}` : "");
    const suffix = decoration.refs.length > 1 ? ` +${decoration.refs.length - 1}` : "";
    const caption = truncateCells(first, Math.max(0, this.refWidth - 3 - Bun.stringWidth(suffix))) + suffix;
    const length = Bun.stringWidth(caption), remaining = Math.max(0, this.refWidth - length);
    gutter.width = this.refWidth; indent.width = this.refWidth;
    ref.content = caption; ref.width = length; paintText(ref, color);
    ref.selectionBg = styles["ui.selection"].bg; ref.selectionFg = styles["ui.selection"].fg;
    leader.width = remaining; leader.content = connected && remaining ? ` ${"─".repeat(remaining - 1)}` : ""; paintText(leader, color);
    const selected = item.key === this.selected;
    const band = blendColors(styleBackground(styles["ui.text"]), color.fg, selected ? (this.root.focused ? 0.56 : 0.44) : 0.32);
    node.content = new StyledText(item.graph!.map((cell, index) => {
      const left = connected && index < decoration.nodeColumn;
      const text = cell.text === " " && left ? "─" : cell.text;
      const style = styles[cell.color ?? (left ? decoration.color : "ui.label")];
      return styleChunk(text, index >= decoration.nodeColumn ? { ...style, bg: band } : style);
    }));
    paintText(link, color); link.bg = band;
  }
  private graph(cells: GraphCell[], width?: number): TextRenderable {
    const text = new TextRenderable(this.renderer, { ...(width ? { width } : {}), height: 1, selectable: false, flexShrink: 0 });
    uiTheme(this.renderer).bindStyles(text, (styles) => { text.content = styledText(cells, styles); });
    return text;
  }
  private get selectionColor() {
    const styles = uiTheme(this.renderer).styles;
    return styles[this.root.focused ? "ui.selection" : "ui.selectionInactive"].bg;
  }
  private highlight(previous: string | null = this.selected): void {
    if (this.root.isDestroyed || this.renderer.isDestroyed) return;
    const styles = uiTheme(this.renderer).styles;
    for (const [key, row] of this.rows) row.backgroundColor = !this.annotations.has(key) && key === this.selected ? this.selectionColor : styles["ui.text"].bg;
    for (const key of new Set([previous, this.selected])) {
      const annotation = this.annotations.get(key ?? ""); if (annotation) this.paintAnnotation(annotation);
    }
  }
  select(key: string): void {
    if (this.items.find((item) => item.key === key)?.disabled) return;
    const previous = this.selected;
    this.selected = key; this.highlight(previous);
    this.root.scrollChildIntoView(`${this.root.id}:${key}`); this.choose(key);
  }
  moveHalfPage(direction: -1 | 1): void {
    const stride = this.rows.get(this.selected ?? "")?.height ?? 1;
    this.move(direction < 0 ? "previous" : "next", halfPageStep(this.root.viewport.height, stride));
  }
  move(direction: "previous" | "next" | "first" | "last", count = 1): void {
    const items = this.items.filter((item) => !item.disabled);
    if (!items.length) return;
    const current = items.findIndex((item) => item.key === this.selected);
    const next = direction === "first" ? 0 : direction === "last" ? items.length - 1
      : Math.max(0, Math.min(items.length - 1, current + (direction === "previous" ? -count : count)));
    this.select(items[next]!.key);
  }
  open(): void { if (this.selected && this.items.some(item => item.key === this.selected && !item.disabled)) this.activate(this.selected); }
}
