import {
  BoxRenderable, InputRenderable, InputRenderableEvents, ScrollBoxRenderable, TextRenderable,
  type CliRenderer, type KeyEvent,
} from "@opentui/core";
import { workspaceRows, type WorkspaceRow } from "../workspace/model.ts";
import { WorkspaceSelection } from "../workspace/selection.ts";
import { filterWorkspaces } from "../workspace/filter-workspaces.ts";
import { rowPresentation, workspaceIcons } from "../workspace/status.ts";

export type WorkspaceActions = {
  onNewSession: (worktreeId: string) => void;
  onCloseSession: (worktreeId: string, sessionId: string) => void;
};

const colors = { text: "#CBD5E1", muted: "#94A3B8", selected: "#1E3A5F", panel: "#0F172A", accent: "#7DD3FC" };

type RowView = { box: BoxRenderable; text: TextRenderable };

export class WorkspaceView {
  readonly root: BoxRenderable;
  private readonly sidebar: BoxRenderable;
  private readonly search: InputRenderable;
  private readonly tree: ScrollBoxRenderable;
  private readonly resultMessage: TextRenderable;
  private readonly history: TextRenderable;
  private readonly center: BoxRenderable;
  private readonly centerTitle: TextRenderable;
  private readonly centerDetails: TextRenderable;
  private readonly right: BoxRenderable;
  private readonly notice: TextRenderable;
  private readonly workspaceTab: BoxRenderable;
  private readonly historyTab: BoxRenderable;
  private readonly newButton: BoxRenderable;
  private readonly closeButton: BoxRenderable;
  private readonly emptyNewButton: BoxRenderable;
  private readonly rows = new Map<string, RowView>();
  private rowOrder: string[] = [];
  private tab: "workspace" | "history" = "workspace";
  private navigationKey: string | null = null;
  private lastScrolledKey: string | null = null;
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(private readonly renderer: CliRenderer, private readonly selection: WorkspaceSelection, private readonly actions: WorkspaceActions) {
    this.root = new BoxRenderable(renderer, { id: "workspace-screen", width: "100%", height: "100%", flexDirection: "column", backgroundColor: colors.panel });
    const panels = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 0, flexDirection: "row" });
    this.sidebar = new BoxRenderable(renderer, { width: 34, flexShrink: 0, flexDirection: "column", border: ["right"], borderColor: colors.muted, paddingX: 1 });
    this.sidebar.add(this.text("radian / Workspace preview", colors.accent));
    this.search = new InputRenderable(renderer, {
      id: "workspace-search", width: "100%", flexShrink: 0,
      placeholder: "Search repo/worktree/branch", placeholderColor: colors.muted,
      textColor: colors.text, backgroundColor: colors.panel, focusedBackgroundColor: colors.selected,
      onKeyDown: (key) => this.handleSearchKey(key),
    });
    this.sidebar.add(this.search);
    const tabs = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", gap: 1 });
    this.workspaceTab = this.button("Workspace", () => this.setTab("workspace"));
    this.historyTab = this.button("History", () => this.setTab("history"));
    tabs.add(this.workspaceTab);
    tabs.add(this.historyTab);
    this.sidebar.add(tabs);
    const toolbar = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", gap: 1 });
    this.newButton = this.button("+ New session", () => this.openNewSession());
    this.closeButton = this.button("Close selected", () => this.closeSession());
    toolbar.add(this.newButton);
    toolbar.add(this.closeButton);
    this.sidebar.add(toolbar);
    this.tree = new ScrollBoxRenderable(renderer, {
      id: "workspace-tree", flexGrow: 1, minHeight: 0, scrollX: false,
      contentOptions: { flexDirection: "column" }, onKeyDown: (key) => this.handleTreeKey(key),
    });
    this.resultMessage = this.text("", colors.muted);
    this.history = this.text("Session history UI is deferred.", colors.muted);
    this.sidebar.add(this.resultMessage);
    this.sidebar.add(this.tree);
    this.sidebar.add(this.history);
    this.center = new BoxRenderable(renderer, { flexGrow: 1, minWidth: 0, padding: 1, flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 1 });
    this.centerTitle = this.text("", colors.accent);
    this.centerDetails = this.text("", colors.muted);
    this.emptyNewButton = this.button("+ New session", () => this.openNewSession());
    this.center.add(this.centerTitle);
    this.center.add(this.centerDetails);
    this.center.add(this.emptyNewButton);
    this.right = new BoxRenderable(renderer, { width: 20, flexShrink: 0, border: ["left"], borderColor: colors.muted, padding: 1 });
    this.right.add(this.text("Inspector", colors.muted));
    this.right.add(this.text("Deferred UI", colors.muted));
    panels.add(this.sidebar);
    panels.add(this.center);
    panels.add(this.right);
    this.root.add(panels);
    this.notice = this.text("UI preview only · no agents running", colors.muted);
    this.root.add(this.notice);
    this.root.add(this.text(`${workspaceIcons.working} Working · ${workspaceIcons.complete} Complete · ${workspaceIcons.failure} Failure · ${workspaceIcons.unreported} Status not supplied`, colors.muted));
    this.root.add(this.text("Ctrl+f search · Esc clear · Tab focus · ↑/↓ select · n new · x close · Ctrl+C quit", colors.muted));
    renderer.root.add(this.root);
    renderer.keyInput.on("keypress", this.handleGlobalKey);
    renderer.on("resize", this.resize);
    this.search.on(InputRenderableEvents.INPUT, this.handleSearchInput);
    this.unsubscribe = selection.subscribe(() => this.render());
    this.resize();
    this.render();
    this.tree.focus();
  }

  setNotice(message: string): void {
    this.notice.content = message;
  }

  private text(content: string, fg: string = colors.text): TextRenderable {
    return new TextRenderable(this.renderer, { content, fg, selectable: false, wrapMode: "none", height: 1, flexShrink: 0 });
  }

  private button(label: string, activate: () => void): BoxRenderable {
    const button = new BoxRenderable(this.renderer, {
      height: 1, flexShrink: 0, focusable: true,
      onMouseDown: (event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        event.preventDefault();
        button.focus();
        activate();
      },
      onKeyDown: (key) => {
        if (key.name !== "return" && key.name !== "space") return;
        key.preventDefault();
        key.stopPropagation();
        activate();
      },
    });
    button.add(this.text(label, colors.accent));
    button.on("focused", () => { button.backgroundColor = colors.selected; });
    button.on("blurred", () => { button.backgroundColor = colors.panel; });
    return button;
  }

  private openNewSession(): void {
    if (this.selection.worktree) this.actions.onNewSession(this.selection.worktree.id);
  }

  private closeSession(): void {
    const worktree = this.selection.worktree;
    const sessionId = this.selection.sessionId;
    if (worktree && sessionId) this.actions.onCloseSession(worktree.id, sessionId);
  }

  private setTab(tab: "workspace" | "history"): void {
    this.tab = tab;
    this.render();
  }

  private activateRow(row: WorkspaceRow): void {
    this.navigationKey = row.key;
    if (row.kind === "worktree") this.selection.selectWorktree(row.worktree.id);
    if (row.kind === "session") this.selection.selectSession(row.worktree.id, row.session.id);
  }

  private selected(row: WorkspaceRow): boolean {
    return (row.kind === "worktree" && this.selection.worktree?.id === row.worktree.id && !this.selection.sessionId)
      || (row.kind === "session" && this.selection.worktree?.id === row.worktree.id && this.selection.sessionId === row.session.id);
  }

  private visibleRows(): WorkspaceRow[] {
    return workspaceRows(filterWorkspaces(this.selection.snapshot, this.search.value));
  }

  private handleSearchInput = (): void => {
    this.tree.scrollTo(0);
    this.navigationKey = null;
    this.lastScrolledKey = null;
    this.render();
  };

  private handleSearchKey(key: KeyEvent): void {
    if (key.name === "escape") {
      key.preventDefault();
      key.stopPropagation();
      this.search.value = "";
    } else if (key.name === "return" && this.tab === "workspace") {
      key.preventDefault();
      key.stopPropagation();
      this.tree.focus();
    }
  }

  private handleTreeKey(key: KeyEvent): void {
    if (key.name === "n") { this.openNewSession(); return; }
    if (key.name === "x") { this.closeSession(); return; }
    if (!["up", "down", "home", "end"].includes(key.name)) return;
    key.preventDefault();
    key.stopPropagation();
    const rows = this.visibleRows().filter((row) => row.kind === "worktree" || row.kind === "session");
    const index = rows.findIndex((row) => row.key === this.navigationKey);
    let next = key.name === "up" ? index - 1 : index + 1;
    if (key.name === "home") next = 0;
    if (key.name === "end") next = rows.length - 1;
    const row = rows[Math.max(0, Math.min(rows.length - 1, next))];
    if (row) this.activateRow(row);
  }

  private handleGlobalKey = (key: KeyEvent): void => {
    if (key.ctrl && key.name === "f") {
      key.preventDefault();
      key.stopPropagation();
      this.search.focus();
      return;
    }
    if (key.name !== "tab") return;
    key.preventDefault();
    key.stopPropagation();
    const targets = [this.search, this.workspaceTab, this.historyTab];
    if (this.tab === "workspace") targets.push(this.newButton, this.closeButton, this.tree);
    if (this.emptyNewButton.visible) targets.push(this.emptyNewButton);
    const index = targets.findIndex((target) => target === this.renderer.currentFocusedRenderable);
    const next = (index + (key.shift ? -1 : 1) + targets.length) % targets.length;
    targets[next]?.focus();
  };

  private resize = (): void => {
    this.sidebar.width = this.renderer.width < 80 ? 26 : 36;
    this.right.visible = this.renderer.width >= 110;
  };

  private render(): void {
    const rows = this.visibleRows();
    const order = rows.map((row) => row.key);
    if (order.join("\0") !== this.rowOrder.join("\0")) {
      const focusedRow = this.tree.content.hasFocusedDescendant;
      for (const row of this.rows.values()) row.box.destroyRecursively();
      this.rows.clear();
      for (const row of rows) {
        const box = new BoxRenderable(this.renderer, {
          id: row.key, height: 1, flexShrink: 0, flexDirection: "row", paddingLeft: row.depth * 2,
          onMouseDown: (event) => {
            if (event.button !== 0 || (row.kind !== "session" && row.kind !== "worktree")) return;
            event.preventDefault();
            this.tree.focus();
            this.activateRow(row);
          },
        });
        const text = this.text(row.label);
        text.flexGrow = 1;
        text.flexShrink = 1;
        text.minWidth = 0;
        box.add(text);
        if (row.kind === "session") box.add(this.button("[x]", () => this.actions.onCloseSession(row.worktree.id, row.session.id)));
        this.tree.add(box);
        this.rows.set(row.key, { box, text });
      }
      this.rowOrder = order;
      this.lastScrolledKey = null;
      if (focusedRow) this.tree.focus();
    }
    const selectedKey = rows.find((row) => this.selected(row))?.key ?? null;
    if (!rows.some((row) => row.key === this.navigationKey)) this.navigationKey = selectedKey;
    for (const row of rows) {
      const view = this.rows.get(row.key);
      if (!view) continue;
      const presentation = rowPresentation(row);
      view.text.content = `${presentation.icon} ${row.label}`;
      view.text.fg = row.key === this.navigationKey && (row.kind === "repository" || row.kind === "worktree")
        ? colors.accent : presentation.color;
      view.box.backgroundColor = this.selected(row) ? colors.selected : colors.panel;
    }
    const worktree = this.selection.worktree;
    const session = worktree?.sessions.find((item) => item.id === this.selection.sessionId);
    this.centerTitle.content = session?.name ?? (worktree ? "No open sessions" : "No workspace available");
    this.centerDetails.content = worktree
      ? session ? `Workspace: ${worktree.name} · display preview only` : `Workspace: ${worktree.name} · create a session explicitly`
      : "Open radian inside a Git repository.";
    this.emptyNewButton.visible = Boolean(worktree && !session);
    this.resultMessage.content = this.search.value ? "No matching workspaces" : "No repositories";
    this.resultMessage.visible = this.tab === "workspace" && rows.length === 0;
    this.tree.visible = this.tab === "workspace";
    this.history.visible = this.tab === "history";
    this.newButton.visible = this.tab === "workspace";
    this.closeButton.visible = this.tab === "workspace";
    this.workspaceTab.backgroundColor = this.tab === "workspace" ? colors.selected : colors.panel;
    this.historyTab.backgroundColor = this.tab === "history" ? colors.selected : colors.panel;
    if (this.navigationKey && this.navigationKey !== this.lastScrolledKey) this.tree.scrollChildIntoView(this.navigationKey);
    this.lastScrolledKey = this.navigationKey;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.search.off(InputRenderableEvents.INPUT, this.handleSearchInput);
    this.renderer.keyInput.off("keypress", this.handleGlobalKey);
    this.renderer.off("resize", this.resize);
    this.root.destroyRecursively();
  }
}
