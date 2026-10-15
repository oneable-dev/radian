import { BoxRenderable, RGBA, ScrollBoxRenderable, StyledText, TextRenderable, type CliRenderer } from "@opentui/core";
import type { GraphCell } from "../git/graph.ts";

export const gitColors = { text: "#CBD5E1", muted: "#94A3B8", accent: "#7DD3FC", selected: "#1E3A5F", panel: "#0F172A" };
export type GitListItem = { key: string; label: string; graph?: GraphCell[]; connector?: GraphCell[]; color?: string; disabled?: boolean };
const styledGraph = (cells: GraphCell[]) => new StyledText(cells.map((cell) => ({ __isChunk: true as const, text: cell.text, ...(cell.color ? { fg: RGBA.fromHex(cell.color) } : {}) })));

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
        const row = new BoxRenderable(this.renderer, { id: `${this.root.id}:${item.key}`, height: item.connector ? 2 : 1, flexShrink: 0,
          flexDirection: "column", onMouseDown: (event) => { if (event.button === 0) down = { x: event.x, y: event.y }; },
          onMouseUp: (event) => {
            if (event.button !== 0 || !down || event.x !== down.x || event.y !== down.y || item.disabled) { down = undefined; return; }
            down = undefined; this.select(item.key); this.activate(item.key);
          } });
        const line = new BoxRenderable(this.renderer, { height: 1, flexDirection: "row", flexShrink: 0, minWidth: 0 });
        if (item.graph) line.add(new TextRenderable(this.renderer, { content: styledGraph(item.graph), width: item.graph.length, height: 1, selectable: false, flexShrink: 0 }));
        line.add(new TextRenderable(this.renderer, { content: item.label, fg: item.color ?? gitColors.text, height: 1, flexGrow: 1,
          minWidth: 0, wrapMode: "none", selectable: !item.disabled }));
        row.add(line);
        if (item.connector) row.add(new TextRenderable(this.renderer, { content: styledGraph(item.connector), height: 1, selectable: false, flexShrink: 0 }));
        this.root.add(row); this.rows.set(item.key, row);
      }
    }
    this.highlight();
  }
  private highlight(): void {
    for (const [key, row] of this.rows) row.backgroundColor = key === this.selected ? gitColors.selected : gitColors.panel;
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
