import {
  BorderChars, BoxRenderable, InputRenderable, InputRenderableEvents, ScrollBoxRenderable, TextAttributes, TextRenderable,
  type CliRenderer, type Renderable,
} from "@opentui/core";
import packageInfo from "../../../package.json";
import { workspaceRows, type WorkspaceRow } from "./workspace-rows.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { filterWorkspaces } from "../../workspace/filter-workspaces.ts";
import { rowPresentation } from "./workspace-status.ts";
import { icons } from "../../icons.ts";
import { sessionStatus } from "../../agents/status.ts";
import { StatusIndicator } from "../../agents/ui/status-indicator.ts";
import { AgentPanel, type AgentActions } from "../../agents/ui/agent-panel.ts";
import type { HistoryItem } from "../../agents/history.ts";
import { SessionHistoryPanel } from "../../agents/ui/history-panel.ts";
import { Footer, type FooterShortcut } from "../../ui/footer.ts";
import { Button } from "../../ui/button.ts";
import { panelSpacing } from "../../ui/spacing.ts";
import type { Result } from "../../result.ts";
import { reportUnexpected, type ExpectedError } from "../../errors.ts";
import { EditorPanel, type EditorActions } from "../../editor/ui/panel.ts";
import { TerminalPanel, type TerminalActions } from "../../terminal/ui/panel.ts";
import { GitPanel, type GitActions } from "../../git/ui/panel.ts";
import type { WorkView, WorkViewPreferences } from "../../runtime/protocol.ts";
import { defaultKeymap, type Keymap } from "../../keybindings/config.ts";
import { KeyRouter } from "../../keybindings/router.ts";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import type { TerminalTheme } from "../../ui/embedded-terminal/theme.ts";
import { uiTheme, type UiTheme } from "../../ui/theme.ts";
import type { ThemeRole } from "../../ui/theme-config.ts";

export type WorkbenchActions = AgentActions & {
  onCloseSession: (worktreeId: string, sessionId: string) => void;
  onListHistory?: (worktreeId: string) => Promise<Result<readonly HistoryItem[], ExpectedError>>;
  onResumeSession?: (worktreeId: string, savedId: string) => Promise<Result<string, ExpectedError>>;
  editor?: EditorActions;
  terminal?: TerminalActions;
  git?: GitActions;
  terminalUnavailable?: string;
  terminalTheme?: TerminalTheme;
  initialWorkViews?: WorkViewPreferences;
  onWorkViewsChange?: (preferences: WorkViewPreferences) => void;
  onNotice?: (message: string) => void;
  keymap?: Keymap;
  onDetach?: () => void;
};

type RowView = { box: BoxRenderable; text: TextRenderable; branch?: TextRenderable; status?: StatusIndicator };

export class Workbench {
  readonly root: BoxRenderable;
  private readonly sidebar: BoxRenderable;
  private readonly search: InputRenderable;
  private readonly tree: ScrollBoxRenderable;
  private readonly resultMessage: TextRenderable;
  private readonly history: SessionHistoryPanel;
  private readonly agent: AgentPanel;
  private readonly workPanel: BoxRenderable;
  private readonly workTabs: Record<WorkView, Button>;
  private readonly workContext: TextRenderable;
  private readonly sidebarTabs: BoxRenderable;
  private readonly viewTabs: BoxRenderable;
  private readonly editor: EditorPanel;
  private readonly terminals: TerminalPanel;
  private readonly git: GitPanel;
  private readonly workViews: WorkViewPreferences;
  private displayedWorkView: WorkView = "agent";
  private readonly footer: Footer;
  private readonly buttonHints = new WeakMap<Renderable, string>();
  private readonly buttonActions = new WeakMap<Renderable, () => void>();
  private readonly keymap: Keymap;
  private readonly router: KeyRouter;
  private readonly workspaceTab: Button;
  private readonly historyTab: Button;
  private readonly rows = new Map<string, RowView>();
  private rowOrder: string[] = [];
  private tab: "workspace" | "history" = "workspace";
  private historyStale = false;
  private navigationKey: string | null = null;
  private lastScrolledKey: string | null = null;
  private activeWorktreeId: string | null = null;
  private readonly unsubscribe: () => void;
  private disposed = false;
  private readonly theme: UiTheme;

  constructor(private readonly renderer: CliRenderer, private readonly selection: WorkspaceSelection, private readonly actions: WorkbenchActions) {
    this.theme = uiTheme(renderer);
    const colors = this.theme.colors;
    this.keymap = actions.keymap ?? defaultKeymap();
    this.workViews = structuredClone(actions.initialWorkViews ?? { active: {}, agentScroll: {} });
    this.root = new BoxRenderable(renderer, { id: "workspace-screen", width: "100%", height: "100%", flexDirection: "column", backgroundColor: colors.panel });
    const panels = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 0, flexDirection: "row" });
    // Put the separator on the cell edge so full-bleed surfaces meet it without a half-cell gap.
    this.sidebar = new BoxRenderable(renderer, { id: "workspace-sidebar", width: 34, flexShrink: 0, flexDirection: "column",
      border: ["right"], customBorderChars: { ...BorderChars.single, vertical: "▕" }, paddingX: 1 });
    this.search = new InputRenderable(renderer, {
      id: "workspace-search", width: "100%", flexShrink: 0,
      placeholder: "Search repo/worktree/branch", placeholderColor: colors.muted,
      textColor: colors.text, backgroundColor: colors.panel, focusedBackgroundColor: colors.selected,
    });
    const tabs = this.sidebarTabs = new BoxRenderable(renderer, { height: 3, paddingY: 1, flexShrink: 0, flexDirection: "row", gap: 1 });
    this.workspaceTab = this.button("Workspace", () => this.setTab("workspace"), "Open Workspace");
    this.historyTab = this.button("History", () => this.setTab("history"), "Open History");
    tabs.add(this.workspaceTab);
    tabs.add(this.historyTab);
    this.sidebar.add(tabs);
    this.sidebar.add(this.search);
    this.tree = new ScrollBoxRenderable(renderer, {
      id: "workspace-tree", flexGrow: 1, minHeight: 0, marginTop: 1, scrollX: false,
      contentOptions: { flexDirection: "column" },
    });
    this.resultMessage = this.text("", "muted");
    this.history = new SessionHistoryPanel(renderer, {
      ...(actions.onListHistory ? { list: actions.onListHistory } : {}),
      ...(actions.onResumeSession ? { resume: actions.onResumeSession } : {}),
      button: (label, activate) => this.button(label, activate, "Refresh history"),
      onChange: () => this.updateFooter(),
      keyHint: (command) => this.keymap.hint(command, "history"),
      onError: (message) => this.setNotice(message),
      onOpened: (worktreeId, sessionId) => {
        this.activateSession(worktreeId, sessionId);
        this.setTab("workspace"); this.focusNavigation();
      },
    });
    this.sidebar.add(this.resultMessage);
    this.sidebar.add(this.tree);
    this.sidebar.add(this.history.root);
    this.workPanel = new BoxRenderable(renderer, { id: "work-panel", flexGrow: 1, minWidth: 0, flexDirection: "column" });
    const workTabs = this.viewTabs = new BoxRenderable(renderer, { height: 3, paddingY: 1, flexShrink: 0, flexDirection: "row", paddingX: 1 });
    this.workTabs = {
      agent: this.button("Agents", () => this.selectWorkView("agent"), "Show Agents"),
      editor: this.button("Editor", () => this.selectWorkView("editor", true), "Show Editor"),
      git: this.button("Git", () => this.selectWorkView("git"), "Show Git"),
      terminal: this.button("Terminal", () => this.selectWorkView("terminal"), "Show Terminal"),
    };
    for (const tab of Object.values(this.workTabs)) workTabs.add(tab);
    this.workContext = this.text("", "muted");
    this.workContext.flexGrow = 1; this.workContext.flexShrink = 1; this.workContext.minWidth = 0;
    this.workContext.textAlign = "right"; workTabs.add(this.workContext);
    this.workPanel.add(workTabs);
    this.agent = new AgentPanel(renderer, { ...actions, onSelectSession: (tree, id) => this.activateSession(tree, id) }, (label, activate, actionLabel) => this.button(label, activate, actionLabel),
      (message) => this.setNotice(message), () => this.updateFooter(), () => this.focusNavigation(), this.workViews.agentScroll,
      (id, position) => { this.workViews.agentScroll[id] = position; this.saveWorkViews(); }, {
        ...(this.workViews.agentViews ? { initialViews: this.workViews.agentViews } : {}),
        saveView: (id, state) => { (this.workViews.agentViews ??= {})[id] = state; this.saveWorkViews(); },
        keyHint: (command, context) => this.keymap.hint(command, context),
      });
    this.editor = new EditorPanel(renderer, actions.editor, (label, activate) => this.button(label, activate, "Open editor"),
      (message) => { if (actions.onNotice) actions.onNotice(message); else this.setNotice(message); }, () => this.updateFooter(), this.keymap.hint("focus.sidebar", "editor"), actions.terminalTheme);
    this.terminals = new TerminalPanel(renderer, actions.terminal, (label, activate, actionLabel) => this.button(label, activate, actionLabel),
      (message) => { if (actions.onNotice) actions.onNotice(message); else this.setNotice(message); },
      (worktreeId, id) => {
        const selected = this.workViews.terminalSelection ??= {};
        if ((selected[worktreeId] ?? null) === id) return;
        if (id) selected[worktreeId] = id; else delete selected[worktreeId];
        this.saveWorkViews();
      }, () => this.updateFooter(), actions.terminalUnavailable, actions.terminalTheme);
    this.git = new GitPanel(renderer, actions.git, (label, activate, actionLabel) => this.button(label, activate, actionLabel),
      (message) => { if (actions.onNotice) actions.onNotice(message); else this.setNotice(message); }, () => this.updateFooter(),
      (id, state) => {
        const views = this.workViews.gitViews ??= {};
        if (JSON.stringify(views[id]) === JSON.stringify(state)) return;
        views[id] = state; this.saveWorkViews();
      }, this.workViews.gitViews ?? {}, (command, context) => this.keymap.hint(command, context));
    this.workPanel.add(this.agent.root); this.workPanel.add(this.editor.root); this.workPanel.add(this.git.root); this.workPanel.add(this.terminals.root);
    panels.add(this.sidebar);
    panels.add(this.workPanel);
    this.root.add(panels);
    this.footer = new Footer(renderer, `Radian ${packageInfo.version}`);
    this.root.add(this.footer.root);
    renderer.root.add(this.root);
    this.router = new KeyRouter(renderer, this.keymap, () => this.keyContext(), (command) => this.commandAvailable(command), (command) => this.command(command));
    renderer.on("resize", this.resize);
    renderer.on("focused_renderable", this.updateFooter);
    this.search.on(InputRenderableEvents.INPUT, this.handleSearchInput);
    this.unsubscribe = selection.subscribe(() => this.render());
    this.resize();
    this.render();
    this.tree.focus();
    this.theme.input(this.search);
    this.theme.scrollbars(this.tree);
    this.theme.focusBorder(this.sidebar);
    this.tree.on("focused", this.repaintRows); this.tree.on("blurred", this.repaintRows);
    this.theme.bind(this.root, (colors) => {
      this.root.backgroundColor = colors.panel;
      this.paintRows(this.visibleRows()); this.paintTabs();
    });
  }

  get promptDrafts(): Record<string, string> {
    return this.agent.promptDrafts;
  }

  get workViewPreferences(): WorkViewPreferences { return structuredClone(this.workViews); }

  private setSidebarVisible(visible: boolean): void {
    if (this.disposed || this.root.isDestroyed || this.sidebar.visible === visible) return;
    const focused = this.sidebar.hasFocusedDescendant;
    this.sidebar.visible = visible;
    if (this.tab === "history") {
      if (visible) {
        this.history.show(this.selection.worktree, { refresh: this.historyStale });
        this.historyStale = false;
      } else this.history.hide();
    }
    this.paintRows(this.visibleRows());
    if (!visible && focused) this.workTabs[this.displayedWorkView].focus();
    this.updateFooter();
  }

  private focusNavigation(): void {
    if (!this.sidebar.visible) this.workTabs[this.displayedWorkView].focus();
    else if (this.tab === "history") this.history.list.focus();
    else this.tree.focus();
  }

  private saveWorkViews(): void { this.actions.onWorkViewsChange?.(this.workViewPreferences); }
  private selectWorkView(view: WorkView, explicit = false): void {
    const worktree = this.selection.worktree; if (!worktree) return;
    this.agent.rememberScroll();
    this.workViews.active[worktree.id] = view; this.saveWorkViews(); this.render();
    if (view === "editor" && explicit) this.editor.show(worktree, true);
    if (view === "git") this.git.focus();
  }
  private activateSession(worktreeId: string, sessionId: string): void {
    this.agent.rememberScroll();
    this.workViews.active[worktreeId] = "agent"; this.saveWorkViews();
    this.selection.selectSession(worktreeId, sessionId);
  }
  setNotice(message: string): void {
    if (!this.disposed && !this.root.isDestroyed) this.footer.setNotice(message);
  }

  private updateFooter = (): void => {
    if (this.disposed || !this.footer || this.root.isDestroyed) return;
    const focused = this.renderer.currentFocusedRenderable;
    let shortcuts: readonly FooterShortcut[] = [];
    const context = this.keyContext();
    const hint = (command: CommandId, label: string): FooterShortcut => ({ key: this.keymap.hint(command, context), label });
    const pair = (a: CommandId, b: CommandId, label: string): FooterShortcut => ({ key: [this.keymap.hint(a, context), this.keymap.hint(b, context)].filter(Boolean).join("/"), label });
    if (focused === this.search) shortcuts = [hint("focus.results", this.tab === "history" ? "History" : "Results"), hint("search.clear", "Clear")];
    else if (focused === this.tree && this.tab === "workspace") shortcuts = [
      pair("workspace.previous", "workspace.next", "Navigate"),
      ...(this.visibleRows().some((row) => row.kind === "worktree" && row.key === this.navigationKey) ? [hint("workspace.open", "Open worktree")] : []),
      pair("workspace.first", "workspace.last", "First/last"),
    ];
    else if (focused && focused === this.editor?.input) shortcuts = [hint("focus.sidebar", "Sidebar"), ...(!this.keymap.bound("escape", "editor") ? [{ key: "Esc", label: "Normal mode" }] : [])];
    else if (focused && focused === this.terminals?.input) shortcuts = [
      ...(!this.keymap.bound("ctrl+c", "terminal") ? [{ key: "Ctrl+C", label: "Interrupt" }] : []),
      ...(this.terminals.canScroll ? [pair("terminal.scroll-up", "terminal.scroll-down", "Scroll")] : []), hint("focus.sidebar", "Sidebar"),
    ];
    else if (this.agent.sessionTabsFocused) shortcuts = this.agent.sessionShortcuts;
    else if (this.agent.transcriptContext()) shortcuts = this.agent.transcriptShortcuts;
    else if (focused === this.agent.prompt && this.agent.active) {
      shortcuts = this.agent.completionOpen
        ? [
          { ...hint("completion.next", "Next"), disabled: !this.agent.completionAvailable("completion.next") },
          { ...hint("completion.previous", "Previous"), disabled: !this.agent.completionAvailable("completion.previous") },
          { key: this.keymap.hints("completion.accept", context), label: "Insert", disabled: !this.agent.completionAvailable("completion.accept") },
          hint("completion.dismiss", "Dismiss"),
        ]
        : [...(this.agent.canSubmit ? [hint("agent.send", this.agent.working ? "Queue" : "Run")] : []), hint("focus.transcript", "Transcript"), hint("focus.sidebar", "Workspace")];
    } else if (context === "git" || context === "git-prompt") shortcuts = this.git.shortcuts;
    else if (focused === this.history.list && this.tab === "history") shortcuts = this.history.shortcuts;
    else if (focused) {
      const label = this.buttonHints.get(focused);
      if (focused.visible && label) shortcuts = [{ key: this.keymap.hints("button.activate", "button"), label }];
    }
    this.footer.setShortcuts(shortcuts.filter((shortcut) => shortcut.key));
  };

  refreshHistory(): void {
    if (this.disposed || this.root.isDestroyed || this.tab !== "history") return;
    if (this.sidebar.visible) this.history.show(this.selection.worktree);
    else this.historyStale = true;
  }

  private text(content: string, role: ThemeRole = "text"): TextRenderable {
    const text = new TextRenderable(this.renderer, { content, selectable: false, wrapMode: "none", height: 1, flexShrink: 0 });
    this.theme.bind(text, (colors) => { text.fg = colors[role]; });
    return text;
  }

  private button(label: string, activate: () => void, actionLabel = label): Button {
    const button = new Button(this.renderer, label, activate);
    this.buttonHints.set(button, actionLabel); this.buttonActions.set(button, activate);
    return button;
  }

  private setTab(tab: "workspace" | "history"): void {
    this.tab = tab;
    if (tab === "workspace") this.history.hide();
    else { this.history.show(this.selection.worktree); this.historyStale = false; }
    this.render();
  }

  private activateRow(row: WorkspaceRow): void {
    this.navigationKey = row.key;
    if (row.kind === "worktree") this.selection.selectWorktree(row.worktree.id);
  }

  private selected(row: WorkspaceRow): boolean {
    return row.kind === "worktree" && this.selection.worktree?.id === row.worktree.id;
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

  private moveTree(direction: "up" | "down" | "home" | "end"): void {
    const rows = this.visibleRows().filter((row) => row.kind === "worktree");
    const index = rows.findIndex((row) => row.key === this.navigationKey);
    let next = direction === "up" ? index - 1 : index + 1;
    if (direction === "home") next = 0;
    if (direction === "end") next = rows.length - 1;
    const row = rows[Math.max(0, Math.min(rows.length - 1, next))];
    if (row) {
      this.navigationKey = row.key;
      this.paintRows(this.visibleRows()); this.tree.scrollChildIntoView(row.key);
      this.lastScrolledKey = row.key; this.updateFooter();
    }
  }

  private keyContext(): KeyContext {
    const focused = this.renderer.currentFocusedRenderable;
    if (!focused) return "none";
    const gitContext = this.git?.keyContext(); if (gitContext) return gitContext;
    const transcriptContext = this.agent?.transcriptContext(); if (transcriptContext) return transcriptContext;
    if (focused === this.editor.input) return "editor";
    if (focused === this.terminals.input) return "terminal";
    if (focused === this.tree) return "workspace";
    if (focused === this.search) return "search";
    if (this.agent.sessionTabsFocused) return "session-tabs";
    if (focused === this.agent.prompt) return this.agent.completionOpen ? "prompt-completion" : "prompt";
    if (focused === this.history.list) return "history";
    if (focused === this.agent.transcriptScroll) return "transcript";
    return "button";
  }
  private commandAvailable(command: CommandId): boolean {
    if (command.startsWith("completion.")) return this.agent.completionAvailable(command);
    if (command.startsWith("session.")) return this.agent.sessionAvailable(command);
    if (command.startsWith("git.")) return this.git.available(command);
    if (command.startsWith("transcript.")) return this.agent.transcriptAvailable(command);
    switch (command) {
      case "app.detach": return Boolean(this.actions.onDetach);
      case "view.agent": case "view.editor": case "view.git": case "view.terminal": return Boolean(this.selection.worktree);
      case "workspace.open": return this.visibleRows().some((row) => row.kind === "worktree" && row.key === this.navigationKey);
      case "terminal.new": return Boolean(this.selection.worktree && this.actions.terminal);
      case "terminal.close": case "terminal.next": case "terminal.previous": return this.terminals.root.visible && this.terminals.canClose;
      case "terminal.scroll-up": case "terminal.scroll-down": return this.terminals.root.visible && this.terminals.canScroll;
      case "focus.prompt": case "focus.transcript": return this.agent.active;
      case "agent.send": return this.agent.active && Boolean(this.agent.sessionId);
      case "button.activate": return !!this.renderer.currentFocusedRenderable && this.buttonActions.has(this.renderer.currentFocusedRenderable);
      default: return true;
    }
  }
  private command(command: CommandId): void {
    if (command.startsWith("completion.")) { this.agent.completionCommand(command); return; }
    if (command.startsWith("session.")) { this.agent.sessionCommand(command); return; }
    if (command.startsWith("git.")) { this.git.command(command); return; }
    if (command.startsWith("transcript.")) { this.agent.transcriptCommand(command); return; }
    switch (command) {
      case "app.detach": this.actions.onDetach?.(); break;
      case "sidebar.toggle": this.setSidebarVisible(!this.sidebar.visible); break;
      case "focus.sidebar": case "focus.results": this.setSidebarVisible(true); this.focusNavigation(); break;
      case "focus.search": this.setSidebarVisible(true); this.search.focus(); break;
      case "focus.prompt": this.agent.prompt.focus(); break;
      case "focus.transcript": this.agent.focusTranscript(); break;
      case "focus.next": this.moveFocus(1); break;
      case "focus.previous": this.moveFocus(-1); break;
      case "search.clear": this.search.value = ""; break;
      case "view.agent": this.selectWorkView("agent"); break;
      case "view.editor": this.selectWorkView("editor", true); break;
      case "view.git": this.selectWorkView("git"); break;
      case "view.terminal": this.selectWorkView("terminal"); break;
      case "terminal.new": this.selectWorkView("terminal"); this.terminals.create(); break;
      case "terminal.close": this.terminals.closeSelected(); break;
      case "terminal.previous": this.terminals.next(-1); break;
      case "terminal.next": this.terminals.next(1); break;
      case "terminal.scroll-up": this.terminals.scroll(-1); break;
      case "terminal.scroll-down": this.terminals.scroll(1); break;
      case "workspace.open": {
        const row = this.visibleRows().find((item) => item.key === this.navigationKey);
        if (row) this.activateRow(row);
        break;
      }
      case "workspace.previous": this.moveTree("up"); break;
      case "workspace.next": this.moveTree("down"); break;
      case "workspace.first": this.moveTree("home"); break;
      case "workspace.last": this.moveTree("end"); break;
      case "history.refresh": this.history.command("refresh"); break;
      case "history.open": this.history.command("open"); break;
      case "history.previous": this.history.command("previous"); break;
      case "history.next": this.history.command("next"); break;
      case "history.first": this.history.command("first"); break;
      case "history.last": this.history.command("last"); break;
      case "agent.send": void this.agent.submitPrompt().catch((error: unknown) => this.setNotice(reportUnexpected(error, "prompt submission"))); break;
      case "button.activate": { const focused = this.renderer.currentFocusedRenderable; if (focused) this.buttonActions.get(focused)?.(); break; }
    }
  }
  private moveFocus(direction: 1 | -1): void {
    if (this.git.modal) {
      const targets = this.git.focusTargets;
      const index = targets.indexOf(this.renderer.currentFocusedRenderable!);
      targets[(index + direction + targets.length) % targets.length]?.focus(); return;
    }
    const targets: Renderable[] = [];
    if (this.sidebar.visible) {
      targets.push(this.search, this.workspaceTab, this.historyTab);
      if (this.tab === "workspace") targets.push(this.tree);
      else {
        if (this.history.refreshButton.visible) targets.push(this.history.refreshButton);
        targets.push(this.history.list);
      }
    }
    targets.push(...Object.values(this.workTabs));
    targets.push(...this.agent.focusTargets);
    if (this.editor.root.visible) {
      if (this.editor.openButton.visible) targets.push(this.editor.openButton);
      if (this.editor.input) targets.push(this.editor.input);
    }
    if (this.terminals.root.visible) targets.push(...this.terminals.focusTargets);
    if (this.git.root.visible) targets.push(...this.git.focusTargets);
    const index = targets.findIndex((target) => target === this.renderer.currentFocusedRenderable);
    const next = (index + direction + targets.length) % targets.length;
    targets[next]?.focus();
  }

  private resize = (): void => {
    const { horizontal, vertical } = panelSpacing(this.renderer);
    this.sidebar.width = this.renderer.width < 80 ? 26 : 40;
    this.sidebar.paddingX = horizontal; this.sidebar.paddingBottom = vertical;
    for (const tabs of [this.sidebarTabs, this.viewTabs]) {
      tabs.height = 1 + vertical * 2; tabs.paddingY = vertical;
    }
    this.viewTabs.paddingX = horizontal;
    this.search.marginBottom = vertical;
    this.tree.marginTop = vertical;
    this.workContext.visible = this.renderer.width >= 100;
    this.workPanel.minWidth = 0;
  };

  private render(): void {
    if (this.disposed || this.root.isDestroyed) return;
    const rows = this.visibleRows();
    const order = rows.map((row) => row.key);
    if (order.join("\0") !== this.rowOrder.join("\0")) {
      const focusedRow = this.tree.content.hasFocusedDescendant;
      for (const row of this.rows.values()) { row.status?.dispose(); row.box.destroyRecursively(); }
      this.rows.clear();
      for (const row of rows) {
        const box = new BoxRenderable(this.renderer, {
          id: row.key, height: row.kind === "worktree" ? 2 : 1, flexShrink: 0, minWidth: 0,
          flexDirection: "column", paddingLeft: row.depth * 2,
          onMouseDown: (event) => {
            if (event.button !== 0 || row.kind !== "worktree") return;
            event.preventDefault();
            this.tree.focus();
            this.activateRow(row);
          },
        });
        const heading = new BoxRenderable(this.renderer, { width: "100%", height: 1, flexShrink: 0, minWidth: 0, flexDirection: "row" });
        const text = new TextRenderable(this.renderer, { content: row.label, height: 1, wrapMode: "none", selectable: false });
        text.flexGrow = 1;
        text.flexShrink = 1;
        text.minWidth = 0;
        heading.add(text); box.add(heading);
        const status = row.kind === "worktree" ? new StatusIndicator(this.renderer) : undefined;
        if (status) {
          const slot = new BoxRenderable(this.renderer, { width: 2, height: 1, flexShrink: 0 });
          slot.add(status.root); heading.add(slot);
        }
        // Both lines belong to one navigation/click target and use the same horizontal inset.
        const branch = row.kind === "worktree" ? new TextRenderable(this.renderer, {
          width: "100%", height: 1, flexShrink: 0, minWidth: 0, wrapMode: "none", selectable: false,
        }) : undefined;
        if (branch) box.add(branch);
        this.tree.add(box);
        this.rows.set(row.key, { box, text, ...(branch ? { branch } : {}), ...(status ? { status } : {}) });
      }
      this.rowOrder = order;
      this.lastScrolledKey = null;
      if (focusedRow) this.tree.focus();
    }
    const selectedKey = rows.find((row) => this.selected(row))?.key ?? null;
    const activeId = this.selection.worktree?.id ?? null;
    if (activeId !== this.activeWorktreeId) { this.activeWorktreeId = activeId; this.navigationKey = selectedKey; }
    if (!rows.some((row) => row.key === this.navigationKey)) this.navigationKey = selectedKey ?? rows.find((row) => row.kind === "worktree")?.key ?? null;
    this.paintRows(rows);
    const worktree = this.selection.worktree;
    this.workContext.content = worktree ? `${worktree.name} · ${worktree.branch ?? "detached"}` : "";
    const workView = worktree ? this.workViews.active[worktree.id] ?? "agent" : "agent";
    this.displayedWorkView = workView;
    const openIds = new Set(this.selection.snapshot.flatMap((repo) => repo.worktrees.flatMap((tree) => tree.sessions.map((item) => item.id))));
    this.agent.update(worktree, this.selection.sessionId, openIds, workView === "agent");
    if (workView === "git") this.git.show(worktree, this.selection.sessionId); else this.git.hide();
    if (workView === "editor") this.editor.show(worktree); else this.editor.hide();
    if (workView === "terminal") this.terminals.show(worktree, worktree ? this.workViews.terminalSelection?.[worktree.id] : undefined); else this.terminals.hide();
    this.resultMessage.content = this.search.value ? "No matching workspaces" : "No repositories";
    this.resultMessage.visible = this.tab === "workspace" && rows.length === 0;
    this.tree.visible = this.tab === "workspace";
    this.history.root.visible = this.sidebar.visible && this.tab === "history";
    if (this.sidebar.visible && this.tab === "history") this.history.updateScope(worktree);
    this.paintTabs();
    if (this.navigationKey && this.navigationKey !== this.lastScrolledKey) this.tree.scrollChildIntoView(this.navigationKey);
    this.lastScrolledKey = this.navigationKey;
    this.updateFooter();
  }

  private repaintRows = (): void => {
    if (this.disposed || this.root.isDestroyed || this.search.isDestroyed) return;
    this.paintRows(this.visibleRows());
  };

  private paintRows(rows: readonly WorkspaceRow[]): void {
    const colors = this.theme.colors;
    const selected = this.tree.focused ? colors.selected : colors.surface;
    for (const row of rows) {
      const view = this.rows.get(row.key);
      if (!view) continue;
      const presentation = rowPresentation(row);
      view.text.content = `${presentation.icon} ${row.label}`;
      const cursor = row.key === this.navigationKey && this.tree.focused, active = this.selected(row);
      view.text.fg = cursor ? colors.accent : colors[presentation.color];
      view.text.attributes = active ? TextAttributes.BOLD : 0;
      view.box.backgroundColor = cursor ? selected : active ? colors.surface : colors.panel;
      if (row.kind === "worktree" && view.branch) {
        view.branch.content = `${icons.branch} ${row.worktree.branch ?? "detached HEAD"}`;
        view.branch.fg = cursor ? colors.accent : active ? colors.text : colors.muted;
        view.branch.attributes = active ? TextAttributes.BOLD : 0;
      }
      if (row.kind === "worktree" && view.status) {
        const statuses = row.worktree.sessions.map(sessionStatus);
        const status = statuses.includes("failure") ? "failure" : statuses.includes("working") ? "working" : null;
        view.status.update(status, this.sidebar.visible && this.tab === "workspace" && status !== null);
        view.status.root.visible = status !== null;
      }
    }
  }
  private paintTabs(): void {
    for (const [name, tab] of Object.entries(this.workTabs)) tab.active = name === this.displayedWorkView;
    this.workspaceTab.active = this.tab === "workspace";
    this.historyTab.active = this.tab === "history";
  }

  dispose(): void {
    if (this.disposed) return;
    this.agent.rememberScroll();
    this.disposed = true;
    this.unsubscribe();
    this.agent.dispose(); this.history.dispose(); this.editor.dispose(); this.terminals.dispose(); this.git.dispose();
    for (const row of this.rows.values()) row.status?.dispose();
    this.search.off(InputRenderableEvents.INPUT, this.handleSearchInput);
    this.router.dispose();
    this.renderer.off("resize", this.resize);
    this.renderer.off("focused_renderable", this.updateFooter);
    this.root.destroyRecursively();
  }
}
