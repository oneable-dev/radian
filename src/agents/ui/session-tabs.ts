import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import type { OpenSession } from "../model.ts";
import { sessionStatus } from "../status.ts";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import type { FooterShortcut } from "../../ui/footer.ts";
import { uiTheme } from "../../ui/theme.ts";
import { paintText } from "../../ui/theme-styles.ts";
import { singleLine, truncateCells } from "../../ui/text.ts";
import { StatusIndicator } from "./status-indicator.ts";

type Tab = { root: BoxRenderable; title: TextRenderable; status: StatusIndicator };
type Actions = {
  select(id: string): void;
  create(): void;
  history?(): void;
  close(id: string): void;
  changed(): void;
  keyHint(command: CommandId, context: KeyContext): string;
  button(label: string, activate: () => void, action: string): BoxRenderable;
};

export class SessionTabs {
  readonly root: BoxRenderable;
  readonly list: ScrollBoxRenderable;
  private readonly tabs = new Map<string, Tab>();
  private sessions: readonly OpenSession[] = [];
  private selected: string | null = null;
  private worktreeId: string | null = null;
  private visible = false;
  private reveal = false;
  private disposed = false;

  constructor(private readonly renderer: CliRenderer, private readonly actions: Actions) {
    this.root = new BoxRenderable(renderer, { id: "agent-session-tabs", width: "100%", height: 1, flexShrink: 0, flexDirection: "row", gap: 1 });
    this.list = new ScrollBoxRenderable(renderer, { id: "agent-session-list", height: 1, flexGrow: 1, flexShrink: 1, minWidth: 0,
      scrollX: true, scrollY: false, contentOptions: { flexDirection: "row", gap: 1 }, horizontalScrollbarOptions: { visible: false },
      onSizeChange: () => { this.resizeTitles(); this.reveal = true; this.renderer.requestRender(); } });
    this.root.add(this.list);
    uiTheme(renderer).scrollbars(this.list);
    uiTheme(renderer).bind(this.root, () => this.paint());
    this.list.on("focused", () => { this.paint(); actions.changed(); });
    this.list.on("blurred", () => this.paint());
    renderer.on("frame", this.revealSelected);
  }

  get focused(): boolean { return this.renderer.currentFocusedRenderable === this.list; }
  get containsFocus(): boolean { return this.root.hasFocusedDescendant; }
  get focusTargets(): Renderable[] {
    return this.visible ? [this.list] : [];
  }
  get shortcuts(): readonly FooterShortcut[] {
    const hint = (id: CommandId) => this.actions.keyHint(id, "session-tabs");
    return [...(this.sessions.length ? [{ key: [hint("session.previous"), hint("session.next")].filter(Boolean).join("/"), label: "Session" }] : []),
      { key: hint("session.new"), label: "New session" }, ...(this.actions.history ? [{ key: hint("history.show"), label: "History" }] : []), ...(this.selected ? [{ key: hint("session.close"), label: "Close session" }] : [])];
  }

  update(worktreeId: string | null, sessions: readonly OpenSession[], selected: string | null, visible: boolean): void {
    if (this.disposed || this.root.isDestroyed) return;
    const switched = worktreeId !== this.worktreeId;
    this.reveal ||= switched || selected !== this.selected;
    this.worktreeId = worktreeId; this.sessions = sessions; this.selected = selected;
    this.visible = visible && !!worktreeId; this.root.visible = this.visible;
    const ids = new Set(sessions.map((session) => session.id));
    for (const [id, tab] of this.tabs) if (switched || !ids.has(id)) {
      tab.status.dispose(); tab.root.destroyRecursively(); this.tabs.delete(id);
    }
    for (const [index, session] of sessions.entries()) {
      let tab = this.tabs.get(session.id);
      if (!tab) {
        const root = new BoxRenderable(this.renderer, { id: `session:${worktreeId}:${session.id}`, height: 1, flexShrink: 0,
          flexDirection: "row", paddingX: 1, gap: 1,
          onMouseDown: (event) => {
            if (event.button !== 0) return;
            event.preventDefault(); event.stopPropagation(); this.list.focus(); this.actions.select(session.id);
          } });
        const title = new TextRenderable(this.renderer, { height: 1, minWidth: 1, wrapMode: "none", selectable: false });
        const status = new StatusIndicator(this.renderer, () => {
          const current = this.tabs.get(session.id); if (!current) return;
          this.setTitle(current, session.id); this.reveal = true; this.renderer.requestRender();
        });
        const close = this.actions.button("×", () => { this.list.focus(); this.actions.close(session.id); }, "Close session");
        close.id = `close-session:${session.id}`; close.paddingX = 0;
        root.add(status.root); root.add(title); root.add(close); this.list.add(root);
        tab = { root, title, status }; this.tabs.set(session.id, tab);
      }
      const working = session.status === "working" || session.subagents.some(child => child.status === "working");
      tab.status.update(working ? "working" : sessionStatus(session), this.visible, session);
      this.setTitle(tab, session.id);
      if (this.list.getChildren()[index] !== tab.root) { this.list.add(tab.root, index); this.reveal = true; }
    }
    // The empty strip remains a keyboard target for explicit creation after the last tab closes.
    this.list.visible = this.visible;
    this.paint();
    if (this.reveal) this.renderer.requestRender();
  }

  available(command: CommandId): boolean {
    if (!this.visible) return false;
    if (command === "session.new") return true;
    return ["session.close", "session.previous", "session.next", "session.first", "session.last"].includes(command) && this.sessions.length > 0;
  }
  command(command: CommandId): void {
    if (!this.available(command)) return;
    if (command === "session.new") { this.actions.create(); return; }
    if (command === "session.close") { this.close(); return; }
    const index = this.sessions.findIndex((session) => session.id === this.selected);
    const target = command === "session.first" ? 0 : command === "session.last" ? this.sessions.length - 1
      : Math.max(0, Math.min(this.sessions.length - 1, index + (command === "session.previous" ? -1 : 1)));
    const session = this.sessions[target]; if (session) this.actions.select(session.id);
  }
  private close(): void { if (this.selected) this.actions.close(this.selected); }
  private setTitle(tab: Tab, id: string): void {
    // Reclaim the entire badge and its gap when there is no execution/unread indicator.
    const reserved = 4 + (tab.status.root.visible ? tab.status.root.width + 1 : 0);
    const text = singleLine(id), width = Math.max(1, this.list.width > 0 ? this.list.width - reserved : Bun.stringWidth(text));
    tab.title.maxWidth = width; tab.title.content = truncateCells(text, width);
  }
  private resizeTitles(): void {
    for (const session of this.sessions) {
      const tab = this.tabs.get(session.id); if (tab) this.setTitle(tab, session.id);
    }
  }
  private paint(): void {
    const styles = uiTheme(this.renderer).styles;
    for (const [id, tab] of this.tabs) {
      const active = id === this.selected;
      tab.root.backgroundColor = styles[active ? this.focused ? "ui.selection" : "ui.selectionInactive" : "ui.text"].bg;
      paintText(tab.title, styles[active ? "ui.tabActive" : "ui.tab"]);
    }
  }
  private revealSelected = (): void => {
    if (!this.reveal || !this.visible || this.disposed || this.root.isDestroyed) return;
    this.reveal = false;
    const tab = this.selected ? this.tabs.get(this.selected)?.root : undefined;
    if (!tab) return;
    const viewport = this.list.viewport;
    // Native nearest-edge scrolling skips children exactly as wide as the viewport.
    const delta = tab.x < viewport.x ? tab.x - viewport.x
      : Math.max(0, tab.x + tab.width - viewport.x - viewport.width);
    if (delta) this.list.scrollBy({ x: delta, y: 0 });
  };
  dispose(): void {
    this.disposed = true; this.renderer.off("frame", this.revealSelected);
    for (const tab of this.tabs.values()) tab.status.dispose();
  }
}
