import { BoxRenderable, ScrollBoxRenderable, StyledText, TextRenderable, type CliRenderer } from "@opentui/core";
import type { GraphCell } from "./graph.ts";
import { uiTheme } from "../../ui/theme.ts";
import { paintText, styleChunk, type StyleGroup, type UiStyles } from "../../ui/theme-styles.ts";

type GitListSpan = { text: string; color?: StyleGroup };
export type GitListItem = { key: string; label: string | readonly GitListSpan[]; graph?: GraphCell[]; connector?: GraphCell[]; color?: StyleGroup; disabled?: boolean; gapBefore?: boolean };
const styledText = (spans: readonly GitListSpan[], styles: UiStyles) => new StyledText(spans.map((span) => styleChunk(span.text, styles[span.color ?? "ui.label"])));

export class GitList {
  readonly root: ScrollBoxRenderable;
  private items: readonly GitListItem[] = [];
  private signature = "";
  private selected: string | null = null;
  private readonly rows = new Map<string, BoxRenderable>();

  constructor(private readonly renderer: CliRenderer, id: string, private readonly choose: (key: string) => void,
    private readonly activate: (key: string) => void) {
    this.root = new ScrollBoxRenderable(renderer, { id, flexGrow: 1, minHeight: 0, minWidth: 0, scrollX: false,
      contentOptions: { flexDirection: "column" }, onMouseDown: () => this.root.focus() });
    uiTheme(renderer).scrollbars(this.root);
    this.root.on("focused", () => this.highlight()); this.root.on("blurred", () => this.highlight());
  }
  get selectedKey(): string | null { return this.selected; }
  update(items: readonly GitListItem[], selected: string | null): void {
    this.items = items; this.selected = selected;
    const signature = JSON.stringify(items);
    if (signature !== this.signature) {
      this.signature = signature;
      for (const row of this.rows.values()) row.destroyRecursively();
      this.rows.clear();
      for (const item of items) {
        let down: { x: number; y: number } | undefined;
        const row = new BoxRenderable(this.renderer, { id: `${this.root.id}:${item.key}`, height: item.connector ? 2 : 1, flexShrink: 0, marginTop: item.gapBefore ? 1 : 0,
          flexDirection: "column", onMouseDown: (event) => { if (event.button === 0) down = { x: event.x, y: event.y }; },
          onMouseUp: (event) => {
            if (event.button !== 0 || !down || event.x !== down.x || event.y !== down.y || item.disabled) { down = undefined; return; }
            down = undefined; this.select(item.key); this.activate(item.key);
          } });
        const line = new BoxRenderable(this.renderer, { height: 1, flexDirection: "row", flexShrink: 0, minWidth: 0 });
        if (item.graph) line.add(this.graph(item.graph, item.graph.length));
        const label = new TextRenderable(this.renderer, { height: 1, flexGrow: 1,
          minWidth: 0, wrapMode: "none", selectable: !item.disabled });
        uiTheme(this.renderer).bindStyles(label, (styles) => {
          paintText(label, styles[item.color ?? "ui.label"]);
          label.content = typeof item.label === "string" ? item.label : styledText(item.label, styles);
          label.selectionBg = styles["ui.selection"].bg; label.selectionFg = styles["ui.selection"].fg;
        });
        uiTheme(this.renderer).bindStyles(row, (styles) => { row.backgroundColor = item.key === this.selected ? this.selectionColor : styles["ui.text"].bg; });
        line.add(label); row.add(line);
        if (item.connector) row.add(this.graph(item.connector));
        this.root.add(row); this.rows.set(item.key, row);
      }
    }
    this.highlight();
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
  private highlight(): void {
    const styles = uiTheme(this.renderer).styles;
    for (const [key, row] of this.rows) row.backgroundColor = key === this.selected ? this.selectionColor : styles["ui.text"].bg;
  }
  select(key: string): void {
    if (this.items.find((item) => item.key === key)?.disabled) return;
    this.selected = key; this.highlight();
    this.root.scrollChildIntoView(`${this.root.id}:${key}`); this.choose(key);
  }
  move(direction: "previous" | "next" | "first" | "last"): void {
    const items = this.items.filter((item) => !item.disabled);
    if (!items.length) return;
    const current = items.findIndex((item) => item.key === this.selected);
    const next = direction === "first" ? 0 : direction === "last" ? items.length - 1
      : Math.max(0, Math.min(items.length - 1, current + (direction === "previous" ? -1 : 1)));
    this.select(items[next]!.key);
  }
  open(): void { if (this.selected) this.activate(this.selected); }
}
