import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type CliRenderer, type KeyEvent } from "@opentui/core";
import type { HistoryItem } from "../sessions/history.ts";
import type { Worktree } from "../workspace/model.ts";

export type HistoryActions = {
  list?: (worktreeId: string) => Promise<readonly HistoryItem[]>;
  resume?: (worktreeId: string, savedId: string) => Promise<string>;
  onOpened: (worktreeId: string, sessionId: string) => void;
  onError: (message: string) => void;
  button: (label: string, activate: () => void) => BoxRenderable;
};

export class SessionHistoryPanel {
  readonly root: BoxRenderable;
  readonly refreshButton: BoxRenderable;
  readonly list: ScrollBoxRenderable;
  private readonly title: TextRenderable;
  private readonly message: TextRenderable;
  private worktree: Worktree | null = null;
  private items: readonly HistoryItem[] = [];
  private readonly rows: BoxRenderable[] = [];
  private cursor = 0;
  private generation = 0;
  private resuming = false;
  private disposed = false;

  constructor(private readonly renderer: CliRenderer, private readonly actions: HistoryActions) {
    this.root = new BoxRenderable(renderer, { id: "session-history", flexGrow: 1, minHeight: 0, flexDirection: "column" });
    this.title = this.text("History", "#7DD3FC");
    this.refreshButton = actions.button("Refresh history [r]", () => { void this.refresh(); });
    this.message = this.text("", "#94A3B8");
    this.list = new ScrollBoxRenderable(renderer, { id: "history-list", flexGrow: 1, minHeight: 0, scrollX: false,
      contentOptions: { flexDirection: "column" }, onKeyDown: (key) => this.handleKey(key) });
    this.root.add(this.title); this.root.add(this.refreshButton); this.root.add(this.message); this.root.add(this.list);
  }

  show(worktree: Worktree | null): void {
    this.worktree = worktree; this.root.visible = true;
    void this.refresh();
  }
  hide(): void { this.root.visible = false; this.generation++; }
  updateScope(worktree: Worktree | null): void {
    if (!this.root.visible || this.worktree?.id === worktree?.id) return;
    this.worktree = worktree; void this.refresh();
  }

  private async refresh(): Promise<void> {
    const generation = ++this.generation;
    const selected = this.items[this.cursor]?.id;
    const worktree = this.worktree;
    this.items = []; this.clearRows();
    this.title.content = worktree ? `History · ${worktree.name}` : "History";
    this.refreshButton.visible = Boolean(worktree && this.actions.list);
    if (!this.actions.list) { this.message.content = "Session history UI is deferred."; return; }
    if (!worktree) { this.message.content = "No worktree selected"; return; }
    this.message.content = "Loading saved sessions...";
    try {
      const items = await this.actions.list(worktree.id);
      if (!this.current(generation)) return;
      this.items = items;
      this.cursor = Math.max(0, items.findIndex((item) => item.id === selected));
      this.message.content = items.length ? "↑/↓ select · Enter open" : "No saved sessions";
      for (const [index, item] of items.entries()) {
        const row = new BoxRenderable(this.renderer, { id: `history:${item.id}`, height: 2, flexShrink: 0, flexDirection: "column",
          onMouseDown: (event) => {
            if (event.button !== 0) return;
            event.preventDefault(); event.stopPropagation(); this.list.focus(); this.cursor = index; this.paint();
            void this.openSelected();
          },
        });
        const prefix = item.unavailableReason ? "[Busy] " : item.openSessionId ? "[Open] " : "";
        row.add(this.text(prefix + item.title, "#CBD5E1"));
        row.add(this.text(`${item.modified.slice(0, 16).replace("T", " ")} · ${item.messageCount} messages`, "#94A3B8"));
        this.list.add(row); this.rows.push(row);
      }
      this.paint();
    } catch (error) {
      if (this.current(generation)) {
        const message = `History error: ${error instanceof Error ? error.message : String(error)}`;
        this.message.content = message; this.actions.onError(message);
      }
    }
  }

  private async openSelected(): Promise<void> {
    const item = this.items[this.cursor];
    const worktree = this.worktree;
    if (!item || !worktree || !this.actions.resume || this.resuming) return;
    if (item.unavailableReason) { this.message.content = item.unavailableReason; return; }
    const generation = this.generation;
    this.resuming = true; this.message.content = "Opening saved session...";
    try {
      const id = await this.actions.resume(worktree.id, item.id);
      if (this.current(generation)) this.actions.onOpened(worktree.id, id);
    } catch (error) {
      if (this.current(generation)) {
        const message = `Resume error: ${error instanceof Error ? error.message : String(error)}`;
        this.message.content = message; this.actions.onError(message);
      }
    } finally { this.resuming = false; }
  }

  private handleKey(key: KeyEvent): void {
    if (key.name === "r") { key.preventDefault(); key.stopPropagation(); void this.refresh(); return; }
    if (key.name === "return") { key.preventDefault(); key.stopPropagation(); void this.openSelected(); return; }
    if (!["up", "down", "home", "end"].includes(key.name)) return;
    key.preventDefault(); key.stopPropagation();
    if (key.name === "home") this.cursor = 0;
    else if (key.name === "end") this.cursor = this.items.length - 1;
    else this.cursor += key.name === "up" ? -1 : 1;
    this.cursor = Math.max(0, Math.min(this.items.length - 1, this.cursor)); this.paint();
  }
  private paint(): void {
    this.rows.forEach((row, index) => { row.backgroundColor = index === this.cursor ? "#1E3A5F" : "#0F172A"; });
    const row = this.rows[this.cursor]; if (row) this.list.scrollChildIntoView(row.id);
  }
  private clearRows(): void {
    const focused = this.list.content.hasFocusedDescendant;
    for (const row of this.rows) row.destroyRecursively(); this.rows.length = 0;
    if (focused) this.list.focus();
  }
  private current(generation: number): boolean { return !this.disposed && !this.root.isDestroyed && this.root.visible && generation === this.generation; }
  private text(content: string, fg: string): TextRenderable {
    return new TextRenderable(this.renderer, { content, fg, height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
  }
  dispose(): void { this.disposed = true; this.generation++; }
}
