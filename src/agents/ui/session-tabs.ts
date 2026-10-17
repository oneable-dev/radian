import { BoxRenderable, ScrollBoxRenderable, TextAttributes, TextRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import type { OpenSession } from "../model.ts";
import { sessionStatus } from "../status.ts";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import type { FooterShortcut } from "../../ui/footer.ts";
import { uiTheme } from "../../ui/theme.ts";
import { StatusIndicator } from "./status-indicator.ts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function tabLabel(name: string, width: number): string {
  const text = name.replace(/\s+/g, " ");
  if (Bun.stringWidth(text) <= width) return text;
  const parts = [...graphemes.segment(text)].map((part) => part.segment);
  let start = "", end = "", used = 1;
  while (parts.length) {
    const left = Bun.stringWidth(start) <= Bun.stringWidth(end);
    const part = (left ? parts.shift() : parts.pop())!;
    const cells = Bun.stringWidth(part);
    if (used + cells > width) break;
    if (left) start += part; else end = part + end;
    used += cells;
  }
  return `${start}…${end}`;
}

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
  private readonly createButton: BoxRenderable;
  private readonly historyButton: BoxRenderable | undefined;
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
    this.createButton = actions.button("+ New session", () => actions.create(), "New session");
    this.root.add(this.list); this.root.add(this.createButton);
    if (actions.history) {
      this.historyButton = actions.button("History", actions.history, "Open History");
      this.historyButton.id = "agent-history-button";
      // Pointer opening must remember the original prompt/transcript, not the trigger button.
      this.historyButton.onMouseDown = (event) => { if (event.button === 0) { event.preventDefault(); event.stopPropagation(); actions.history?.(); } };
      this.root.add(this.historyButton);
    }
    renderer.on("resize", this.resizeButtons); this.resizeButtons();
    uiTheme(renderer).scrollbars(this.list);
    uiTheme(renderer).bind(this.root, () => this.paint());
    this.list.on("focused", () => { this.paint(); actions.changed(); });
    this.list.on("blurred", () => this.paint());
    renderer.on("frame", this.revealSelected);
  }

  get focused(): boolean { return this.renderer.currentFocusedRenderable === this.list; }
  get containsFocus(): boolean { return this.root.hasFocusedDescendant; }
  get focusTargets(): Renderable[] {
    return this.visible ? [...(this.sessions.length ? [this.list] : []), this.createButton, ...(this.historyButton ? [this.historyButton] : [])] : [];
  }
  get shortcuts(): readonly FooterShortcut[] {
    const hint = (id: CommandId) => this.actions.keyHint(id, "session-tabs");
    return [{ key: [hint("session.previous"), hint("session.next")].filter(Boolean).join("/"), label: "Session" },
      { key: hint("session.new"), label: "New session" }, ...(this.historyButton ? [{ key: hint("history.show"), label: "History" }] : []), ...(this.selected ? [{ key: hint("session.close"), label: "Close session" }] : [])];
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
        const title = new TextRenderable(this.renderer, { height: 1, minWidth: 1, maxWidth: 24, wrapMode: "none", selectable: false });
        const status = new StatusIndicator(this.renderer);
        const close = this.actions.button("×", () => { this.list.focus(); this.actions.close(session.id); }, "Close session");
        close.id = `close-session:${session.id}`;
        root.add(title); root.add(close); root.add(status.root); this.list.add(root);
        tab = { root, title, status }; this.tabs.set(session.id, tab);
      }
      this.setTitle(tab, session.name);
      tab.status.update(sessionStatus(session), this.visible);
      if (this.list.getChildren()[index] !== tab.root) { this.list.add(tab.root, index); this.reveal = true; }
    }
    if (this.focused && this.visible && !sessions.length) this.createButton.focus();
    this.list.visible = sessions.length > 0;
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
  private setTitle(tab: Tab, name: string): void {
    // Keep close/status cells visible even when a selected tab fills the viewport.
    const width = Math.max(1, Math.min(24, this.list.width > 0 ? this.list.width - 9 : 24));
    tab.title.maxWidth = width; tab.title.content = tabLabel(name, width);
  }
  private resizeButtons = (): void => {
    const label = this.createButton.getChildren().find((child) => child instanceof TextRenderable);
    if (label instanceof TextRenderable) label.content = this.historyButton && this.renderer.width < 100 ? "+ New" : "+ New session";
  };
  private resizeTitles(): void {
    for (const session of this.sessions) {
      const tab = this.tabs.get(session.id); if (tab) this.setTitle(tab, session.name);
    }
  }
  private paint(): void {
    const colors = uiTheme(this.renderer).colors;
    for (const [id, tab] of this.tabs) {
      tab.root.backgroundColor = id === this.selected ? this.focused ? colors.selected : colors.surface : colors.panel;
      tab.title.fg = id === this.selected ? colors.text : colors.muted;
      tab.title.attributes = id === this.selected ? TextAttributes.BOLD | TextAttributes.UNDERLINE : 0;
    }
  }
  private revealSelected = (): void => {
    if (!this.reveal || !this.visible || this.disposed || this.root.isDestroyed) return;
    this.reveal = false;
    if (this.selected) this.list.scrollChildIntoView(`session:${this.worktreeId}:${this.selected}`);
  };
  dispose(): void {
    this.disposed = true; this.renderer.off("frame", this.revealSelected); this.renderer.off("resize", this.resizeButtons);
    for (const tab of this.tabs.values()) tab.status.dispose();
  }
}
