import {
  BoxRenderable,
  ScrollBoxRenderable,
  type TextRenderable,
  type CliRenderer,
} from "@opentui/core";
import type { OpenSession } from "../model.ts";
import { sessionStatus } from "../status.ts";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import { uiTheme } from "../../ui/theme.ts";
import { SessionTab } from "../../ui/session-tab.ts";
import type { SpinnerStyle } from "../../ui/loading-spinner.ts";
import { StatusIndicator } from "./status-indicator.ts";

type Tab = {
  root: BoxRenderable;
  title: TextRenderable;
  frame: SessionTab;
  status: StatusIndicator;
};

type Actions = {
  idPrefix?: string;
  select(id: string): void;
  spinnerStyle?(id: string): SpinnerStyle;
  create(): void;
  close(id: string): void;
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

  constructor(
    private readonly renderer: CliRenderer,
    private readonly actions: Actions,
  ) {
    this.root = new BoxRenderable(renderer, {
      id: `${actions.idPrefix ?? ""}agent-session-tabs`,
      width: "100%",
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      gap: 1,
    });
    this.list = new ScrollBoxRenderable(renderer, {
      id: `${actions.idPrefix ?? ""}agent-session-list`,
      height: 1,
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      scrollX: true,
      scrollY: false,
      contentOptions: { flexDirection: "row", gap: 0 },
      horizontalScrollbarOptions: { visible: false },
      onSizeChange: () => {
        this.resizeTitles();
        this.reveal = true;
        this.renderer.requestRender();
      },
    });
    // ScrollBox's constructor only enables focus; disable its inherited default explicitly.
    this.list.focusable = false;
    this.root.add(this.list);
    uiTheme(renderer).scrollbars(this.list);
    uiTheme(renderer).bind(this.root, () => this.paint());
    renderer.on("frame", this.revealSelected);
  }

  get creationShortcut(): string {
    return (
      this.actions.keyHint("tab.new", "button") || this.actions.keyHint("session.new", "button")
    );
  }

  update(
    worktreeId: string | null,
    sessions: readonly OpenSession[],
    selected: string | null,
    visible: boolean,
  ): void {
    if (this.disposed || this.root.isDestroyed) {
      return;
    }

    const switched = worktreeId !== this.worktreeId;
    this.reveal ||= switched || selected !== this.selected;
    this.worktreeId = worktreeId;
    this.sessions = sessions;
    this.selected = selected;
    this.visible = visible && !!worktreeId;
    this.root.visible = this.visible;

    const ids = new Set(sessions.map((session) => session.id));
    for (const [id, tab] of this.tabs) {
      if (switched || !ids.has(id)) {
        tab.status.dispose();
        tab.root.destroyRecursively();
        this.tabs.delete(id);
      }
    }
    for (const [index, session] of sessions.entries()) {
      let tab = this.tabs.get(session.id);
      if (!tab) {
        const status = new StatusIndicator(this.renderer, () => {
          const current = this.tabs.get(session.id);
          if (!current) {
            return;
          }

          this.setTitle(current, session.id);
          this.reveal = true;
          this.renderer.requestRender();
        });
        const frame = new SessionTab(this.renderer, {
          id: `${this.actions.idPrefix ?? ""}session:${worktreeId}:${session.id}`,
          closeId: `${this.actions.idPrefix ?? ""}close-session:${session.id}`,
          closeLabel: "Close session",
          leading: status.root,
          select: () => this.actions.select(session.id),
          close: () => this.actions.close(session.id),
          button: (label, activate, action) => this.actions.button(label, activate, action),
        });

        this.list.add(frame.root);
        tab = { root: frame.root, title: frame.title, frame, status };
        this.tabs.set(session.id, tab);
      }

      tab.frame.setPosition(index + 1);

      const working =
        session.status === "working" ||
        session.subagents.some((child) => child.status === "working");
      tab.status.update(
        working ? "working" : sessionStatus(session),
        this.visible,
        session,
        this.actions.spinnerStyle?.(session.id),
      );
      this.setTitle(tab, session.id);
      if (this.list.getChildren()[index] !== tab.root) {
        this.list.add(tab.root, index);
        this.reveal = true;
      }
    }

    this.list.visible = this.visible;
    this.paint();
    if (this.reveal) {
      this.renderer.requestRender();
    }
  }

  available(command: CommandId): boolean {
    if (!this.visible) {
      return false;
    }
    if (command === "session.new") {
      return true;
    }

    return (
      [
        "session.close",
        "session.previous",
        "session.next",
        "session.first",
        "session.last",
      ].includes(command) && this.sessions.length > 0
    );
  }

  command(command: CommandId): void {
    if (!this.available(command)) {
      return;
    }
    if (command === "session.new") {
      this.actions.create();

      return;
    }
    if (command === "session.close") {
      this.close();

      return;
    }

    const index = this.sessions.findIndex((session) => session.id === this.selected);
    const target =
      command === "session.first"
        ? 0
        : command === "session.last"
          ? this.sessions.length - 1
          : Math.max(
              0,
              Math.min(this.sessions.length - 1, index + (command === "session.previous" ? -1 : 1)),
            );
    const session = this.sessions[target];
    if (session) {
      this.actions.select(session.id);
    }
  }

  private close(): void {
    if (this.selected) {
      this.actions.close(this.selected);
    }
  }

  private setTitle(tab: Tab, id: string): void {
    const previous = tab.title.plainText;
    tab.frame.resize(this.list.width);
    tab.frame.setLabel(id);
    this.reveal ||= tab.title.plainText !== previous;
  }

  private resizeTitles(): void {
    for (const session of this.sessions) {
      const tab = this.tabs.get(session.id);
      if (tab) {
        this.setTitle(tab, session.id);
      }
    }
  }

  private paint(): void {
    for (const [id, tab] of this.tabs) {
      tab.frame.update(id === this.selected);
    }
  }

  private revealSelected = (): void => {
    if (!this.reveal || !this.visible || this.disposed || this.root.isDestroyed) {
      return;
    }

    this.reveal = false;

    const tab = this.selected ? this.tabs.get(this.selected)?.root : undefined;
    if (!tab) {
      return;
    }

    const viewport = this.list.viewport;
    // Native nearest-edge scrolling skips children exactly as wide as the viewport.
    const delta =
      tab.x < viewport.x
        ? tab.x - viewport.x
        : Math.max(0, tab.x + tab.width - viewport.x - viewport.width);
    if (delta) {
      this.list.scrollBy({ x: delta, y: 0 });
    }
  };

  dispose(): void {
    this.disposed = true;
    this.renderer.off("frame", this.revealSelected);
    for (const tab of this.tabs.values()) {
      tab.status.dispose();
    }
  }
}
