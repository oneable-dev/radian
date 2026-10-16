import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import type { HistoryItem } from "../sessions/history.ts";
import type { Worktree } from "../workspace/model.ts";
import { reportUnexpected, type ExpectedError } from "../errors.ts";
import type { Result } from "../result.ts";
import type { FooterShortcut } from "./footer.ts";
import { LoadingSpinner } from "./loading-spinner.ts";
import type { CommandId } from "../keybindings/commands.ts";
import { uiTheme } from "./theme.ts";
import type { ThemeRole } from "./theme-config.ts";

export type HistoryActions = {
  list?: (worktreeId: string) => Promise<Result<readonly HistoryItem[], ExpectedError>>;
  resume?: (worktreeId: string, savedId: string) => Promise<Result<string, ExpectedError>>;
  onOpened: (worktreeId: string, sessionId: string) => void;
  onError: (message: string) => void;
  onChange?: () => void;
  keyHint: (command: Extract<CommandId, `history.${string}`>) => string;
  button: (label: string, activate: () => void) => BoxRenderable;
};

export class SessionHistoryPanel {
  readonly root: BoxRenderable;
  readonly refreshButton: BoxRenderable;
  readonly list: ScrollBoxRenderable;
  private readonly title: TextRenderable;
  private readonly spinner: LoadingSpinner;
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
    const heading = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", gap: 1 });
    this.title = this.text("History", "accent");
    this.title.flexGrow = 1; this.title.flexShrink = 1; this.title.minWidth = 0;
    this.spinner = new LoadingSpinner(renderer);
    uiTheme(renderer).bind(this.spinner.root, (colors) => { this.spinner.root.fg = colors.accent; });
    heading.add(this.title); heading.add(this.spinner.root);
    this.refreshButton = actions.button(`Refresh history${actions.keyHint("history.refresh") ? ` [${actions.keyHint("history.refresh")}]` : ""}`, () => { void this.refresh(); });
    this.message = this.text("", "muted");
    this.list = new ScrollBoxRenderable(renderer, { id: "history-list", flexGrow: 1, minHeight: 0, scrollX: false,
      contentOptions: { flexDirection: "column" } });
    this.root.add(heading); this.root.add(this.refreshButton); this.root.add(this.message); this.root.add(this.list);
    uiTheme(renderer).scrollbars(this.list);
  }

  get shortcuts(): readonly FooterShortcut[] {
    const item = this.items[this.cursor];
    const hint = this.actions.keyHint;
    return [
      ...(this.items.length ? [{ key: [hint("history.previous"), hint("history.next")].filter(Boolean).join("/"), label: "Select" },
        { key: [hint("history.first"), hint("history.last")].filter(Boolean).join("/"), label: "First/last" }] : []),
      ...(item && !item.unavailableReason && this.actions.resume && !this.resuming ? [{ key: hint("history.open"), label: "Open" }] : []),
      ...(this.worktree && this.actions.list ? [{ key: hint("history.refresh"), label: "Refresh" }] : []),
    ].filter((shortcut) => shortcut.key);
  }

  show(worktree: Worktree | null): void {
    this.worktree = worktree; this.root.visible = true;
    void this.refresh();
  }
  hide(): void { this.root.visible = false; this.generation++; this.spinner.cancel(); }
  updateScope(worktree: Worktree | null): void {
    if (!this.root.visible || this.worktree?.id === worktree?.id) return;
    this.worktree = worktree; void this.refresh();
  }

  private async refresh(): Promise<void> {
    const generation = ++this.generation;
    this.spinner.cancel();
    const selected = this.items[this.cursor]?.id;
    const worktree = this.worktree;
    this.items = []; this.clearRows();
    this.actions.onChange?.();
    this.title.content = worktree ? `History · ${worktree.name}` : "History";
    this.refreshButton.visible = Boolean(worktree && this.actions.list);
    if (!this.actions.list) { this.message.content = "Session history UI is deferred."; return; }
    if (!worktree) { this.message.content = "No worktree selected"; return; }
    this.message.content = "";
    this.spinner.start();
    let result: Result<readonly HistoryItem[], ExpectedError>;
    try { result = await this.actions.list(worktree.id); }
    catch (error) { this.showFailure(reportUnexpected(error, "history lookup"), generation); return; }
    finally { if (this.current(generation)) this.spinner.stop(); }
    if (!this.current(generation)) return;
    if (!result.ok) { this.showFailure(`History error: ${result.error.message}`, generation); return; }
    const items = result.value;
    this.items = items;
    this.cursor = Math.max(0, items.findIndex((item) => item.id === selected));
    this.message.content = items.length ? "Select a saved session to open" : "No saved sessions";
    for (const [index, item] of items.entries()) {
      const row = new BoxRenderable(this.renderer, { id: `history:${item.id}`, height: 2, flexShrink: 0, flexDirection: "column",
        onMouseDown: (event) => {
          if (event.button !== 0) return;
          event.preventDefault(); event.stopPropagation(); this.list.focus(); this.cursor = index; this.paint();
          void this.openSelected();
        },
      });
      const prefix = item.unavailableReason ? "[Busy] " : item.openSessionId ? "[Open] " : "";
      uiTheme(this.renderer).bind(row, (colors) => { row.backgroundColor = index === this.cursor ? colors.selected : colors.panel; });
      row.add(this.text(prefix + item.title, "text"));
      row.add(this.text(`${item.modified.slice(0, 16).replace("T", " ")} · ${item.messageCount} messages`, "muted"));
      this.list.add(row); this.rows.push(row);
    }
    this.paint();
  }

  private async openSelected(): Promise<void> {
    const item = this.items[this.cursor];
    const worktree = this.worktree;
    if (!item || !worktree || !this.actions.resume || this.resuming) return;
    if (item.unavailableReason) { this.message.content = item.unavailableReason; return; }
    const generation = this.generation;
    this.resuming = true; this.message.content = "Opening saved session...";
    this.actions.onChange?.();
    let result: Result<string, ExpectedError>;
    try { result = await this.actions.resume(worktree.id, item.id); }
    catch (error) { this.showFailure(reportUnexpected(error, "history resume"), generation); return; }
    finally { this.resuming = false; if (this.current(generation)) this.actions.onChange?.(); }
    if (!this.current(generation)) return;
    if (!result.ok) { this.showFailure(`Resume error: ${result.error.message}`, generation); return; }
    this.actions.onOpened(worktree.id, result.value);
  }

  private showFailure(message: string, generation: number): void {
    if (!this.current(generation)) return;
    this.message.content = message; this.actions.onError(message); this.actions.onChange?.();
  }

  command(command: "refresh" | "open" | "previous" | "next" | "first" | "last"): void {
    if (command === "refresh") { void this.refresh(); return; }
    if (command === "open") { void this.openSelected(); return; }
    if (command === "first") this.cursor = 0;
    else if (command === "last") this.cursor = this.items.length - 1;
    else this.cursor += command === "previous" ? -1 : 1;
    this.cursor = Math.max(0, Math.min(this.items.length - 1, this.cursor)); this.paint();
  }
  private paint(): void {
    const colors = uiTheme(this.renderer).colors;
    this.rows.forEach((row, index) => { row.backgroundColor = index === this.cursor ? colors.selected : colors.panel; });
    const row = this.rows[this.cursor]; if (row) this.list.scrollChildIntoView(row.id);
    this.actions.onChange?.();
  }
  private clearRows(): void {
    const focused = this.list.content.hasFocusedDescendant;
    for (const row of this.rows) row.destroyRecursively(); this.rows.length = 0;
    if (focused) this.list.focus();
  }
  private current(generation: number): boolean { return !this.disposed && !this.root.isDestroyed && this.root.visible && generation === this.generation; }
  private text(content: string, role: ThemeRole): TextRenderable {
    const text = new TextRenderable(this.renderer, { content, height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    uiTheme(this.renderer).bind(text, (colors) => { text.fg = colors[role]; });
    return text;
  }
  dispose(): void { this.disposed = true; this.generation++; this.spinner.cancel(); }
}
