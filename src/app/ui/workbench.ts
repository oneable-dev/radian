import {
  BorderChars, BoxRenderable, InputRenderable, InputRenderableEvents, ScrollBoxRenderable, StyledText, TextAttributes, TextRenderable,
  type CliRenderer, type Renderable,
} from "@opentui/core";
import packageInfo from "../../../package.json";
import { workspaceRows, type WorkspaceRow } from "./workspace-rows.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { filterWorkspaces } from "../../workspace/filter-workspaces.ts";
import { rowPresentation } from "./workspace-status.ts";
import { icons } from "../../icons.ts";
import { sessionStatus } from "../../agents/status.ts";
import { AgentPanel, type AgentActions } from "../../agents/ui/agent-panel.ts";
import type { HistoryItem } from "../../agents/history.ts";
import type { HistoryPreview } from "../../agents/history-preview.ts";
import { SessionHistoryPanel } from "../../agents/ui/history-panel.ts";
import { Footer, type FooterShortcut } from "../../ui/footer.ts";
import { TextDialog } from "../../ui/text-dialog.ts";
import { keymapHelp } from "../../keybindings/help.ts";
import { Button, type ButtonVariant } from "../../ui/button.ts";
import { panelSpacing } from "../../ui/spacing.ts";
import { singleLine } from "../../ui/text.ts";
import type { Result } from "../../result.ts";
import { reportUnexpected, type ExpectedError } from "../../errors.ts";
import { EditorPanel, type EditorActions } from "../../editor/ui/panel.ts";
import { TerminalPanel, type TerminalActions } from "../../terminal/ui/panel.ts";
import { GitPanel, type GitActions } from "../../git/ui/panel.ts";
import type { WorkView, WorkViewPreferences } from "../../runtime/protocol.ts";
import { defaultKeymap, formatKeys, type Keymap } from "../../keybindings/config.ts";
import { KeyRouter } from "../../keybindings/router.ts";
import { inScope, type CommandId, type KeyContext } from "../../keybindings/commands.ts";
import type { TerminalTheme } from "../../ui/embedded-terminal/theme.ts";
import { uiTheme, type UiTheme } from "../../ui/theme.ts";
import type { ThemeRole } from "../../ui/theme-config.ts";

export type WorkbenchActions = AgentActions & {
  onCloseSession: (worktreeId: string, sessionId: string) => void;
  getRetainedSessionIds?: () => ReadonlySet<string>;
  onListHistory?: (worktreeId: string, signal?: AbortSignal) => Promise<Result<readonly HistoryItem[], ExpectedError>>;
  onPreviewHistory?: (worktreeId: string, savedId: string, signal?: AbortSignal) => Promise<Result<HistoryPreview, ExpectedError>>;
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

type RowView = { box: BoxRenderable; body: BoxRenderable; text: TextRenderable; status?: TextRenderable };
// Reserve the same frame in every item, including in monochrome terminals.
const hiddenWorkspaceBorder = {
  topLeft: " ", topRight: " ", bottomLeft: " ", bottomRight: " ", horizontal: " ", vertical: " ",
  topT: " ", bottomT: " ", leftT: " ", rightT: " ", cross: " ",
};

export class Workbench {
  readonly root: BoxRenderable;
  private readonly sidebar: BoxRenderable;
  private readonly search: InputRenderable;
  private readonly searchBox: BoxRenderable;
  private readonly tree: ScrollBoxRenderable;
  private readonly resultMessage: TextRenderable;
  private readonly history: SessionHistoryPanel;
  private readonly agent: AgentPanel;
  private readonly workPanel: BoxRenderable;
  private readonly workTabs: Record<WorkView, Button>;
  private readonly viewTabs: BoxRenderable;
  private readonly editor: EditorPanel;
  private readonly terminals: TerminalPanel;
  private readonly git: GitPanel;
  private readonly workViews: WorkViewPreferences;
  private displayedWorkView: WorkView = "agent";
  private readonly footer: Footer;
  private readonly dialog: TextDialog;
  private readonly buttonHints = new WeakMap<Renderable, string>();
  private readonly buttonActions = new WeakMap<Renderable, () => void>();
  private readonly keymap: Keymap;
  private readonly router: KeyRouter;
  private readonly rows = new Map<string, RowView>();
  private rowOrder: string[] = [];
  private navigationKey: string | null = null;
  private lastScrolledKey: string | null = null;
  private navigationRevealPending = false;
  private activeWorktreeId: string | null = null;
  private sidebarTransition: { visible: boolean; worktreeId: string | null } | undefined;
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
    this.searchBox = new BoxRenderable(renderer, {
      id: "workspace-search-box", width: "auto", height: 3, minWidth: 0, flexShrink: 0,
      flexDirection: "column", backgroundColor: colors.surface,
      onMouseDown: (event) => { if (event.button === 0 && !this.search.focused) this.search.focus(); },
    });
    this.search = new InputRenderable(renderer, {
      id: "workspace-search", width: "auto", minWidth: 0, flexShrink: 0,
      placeholder: "Search repo/worktree/branch", placeholderColor: colors.muted,
      textColor: colors.text, backgroundColor: colors.panel, focusedBackgroundColor: colors.selected,
    });
    this.searchBox.add(this.search); this.sidebar.add(this.searchBox);
    this.tree = new ScrollBoxRenderable(renderer, {
      id: "workspace-tree", flexGrow: 1, minHeight: 0, marginTop: 1, scrollX: false,
      contentOptions: { flexDirection: "column" },
    });
    this.resultMessage = this.text("", "muted");
    this.history = new SessionHistoryPanel(renderer, {
      ...(actions.onListHistory ? { list: actions.onListHistory } : {}),
      ...(actions.onResumeSession ? { resume: actions.onResumeSession } : {}),
      ...(actions.onPreviewHistory ? { preview: actions.onPreviewHistory } : {}),
      onChange: () => this.updateFooter(),
      keyHint: (command, context) => this.keymap.hint(command, context),
      onError: (message) => this.setNotice(message),
      onCloseFallback: () => this.focusNavigation(),
      onOpened: (worktreeId, sessionId) => {
        this.activateSession(worktreeId, sessionId);
        if (this.agent.active) this.agent.focusTranscript(); else this.agent.focusTargets[0]?.focus();
      },
    });
    this.dialog = new TextDialog(renderer, () => this.updateFooter(), () => this.focusNavigation(), actions.onCopyTranscript);
    this.sidebar.add(this.resultMessage);
    this.sidebar.add(this.tree);
    this.workPanel = new BoxRenderable(renderer, { id: "work-panel", flexGrow: 1, minWidth: 0, flexDirection: "column" });
    const workTabs = this.viewTabs = new BoxRenderable(renderer, { id: "work-view-tabs", height: 3, paddingY: 1, flexShrink: 0, flexDirection: "row", paddingX: 1 });
    this.workTabs = {
      agent: this.button("Agents", () => this.selectWorkView("agent"), "Show Agents", "work-tab"),
      editor: this.button("Editor", () => this.selectWorkView("editor", true), "Show Editor", "work-tab"),
      git: this.button("Git", () => this.selectWorkView("git"), "Show Git", "work-tab"),
      terminal: this.button("Terminal", () => this.selectWorkView("terminal"), "Show Terminal", "work-tab"),
    };
    for (const tab of Object.values(this.workTabs)) workTabs.add(tab);
    this.workPanel.add(workTabs);
    this.agent = new AgentPanel(renderer, { ...actions, onHistory: () => this.history.show(this.selection.worktree), onInspectInput: (content) => this.dialog.show(content), onSelectSession: (tree, id) => this.activateSession(tree, id) }, (label, activate, actionLabel) => this.button(label, activate, actionLabel),
      (message) => this.setNotice(message), () => this.updateFooter(), () => this.focusNavigation(), this.workViews.agentScroll,
      (id, position) => { this.workViews.agentScroll[id] = position; this.saveWorkViews(); }, {
        ...(this.workViews.agentViews ? { initialViews: this.workViews.agentViews } : {}),
        saveView: (id, state) => { (this.workViews.agentViews ??= {})[id] = state; this.saveWorkViews(); },
        keyHint: (command, context) => this.keymap.hint(command, context),
      });
    this.editor = new EditorPanel(renderer, actions.editor, (label, activate) => this.button(label, activate, "Open editor"),
      (message) => { if (actions.onNotice) actions.onNotice(message); else this.setNotice(message); }, () => this.updateFooter(), actions.terminalTheme);
    this.terminals = new TerminalPanel(renderer, actions.terminal, (label, activate, actionLabel, variant) => this.button(label, activate, actionLabel, variant),
      (message) => { if (actions.onNotice) actions.onNotice(message); else this.setNotice(message); },
      (worktreeId, id) => {
        const selected = this.workViews.terminalSelection ??= {};
        if ((selected[worktreeId] ?? null) === id) return;
        if (id) selected[worktreeId] = id; else delete selected[worktreeId];
        this.saveWorkViews();
      }, () => this.updateFooter(), actions.terminalUnavailable, actions.terminalTheme);
    this.git = new GitPanel(renderer, actions.git, (label, activate, actionLabel, variant) => this.button(label, activate, actionLabel, variant),
      (message) => { if (actions.onNotice) actions.onNotice(message); else this.setNotice(message); }, () => this.updateFooter(),
      (id, state) => {
        const views = this.workViews.gitViews ??= {};
        if (JSON.stringify(views[id]) === JSON.stringify(state)) return;
        views[id] = state; this.saveWorkViews();
      }, this.workViews.gitViews ?? {}, (command, context) => this.keymap.hint(command, context), (content) => this.dialog.show(content));
    this.workPanel.add(this.agent.root); this.workPanel.add(this.editor.root); this.workPanel.add(this.git.root); this.workPanel.add(this.terminals.root);
    panels.add(this.sidebar);
    panels.add(this.workPanel);
    this.root.add(panels);
    const help = this.button("Help", () => this.showHelp(), "Open help");
    const details = this.button("Details", () => this.showNotice(), "Read notification");
    // Opening a pointer-triggered popup restores the original editor/PTY focus on close.
    help.onMouseDown = (event) => { if (event.button === 0) { event.preventDefault(); event.stopPropagation(); this.showHelp(); } };
    details.onMouseDown = (event) => { if (event.button === 0) { event.preventDefault(); event.stopPropagation(); this.showNotice(); } };
    this.footer = new Footer(renderer, `Radian ${packageInfo.version}`, { help, details });
    this.root.add(this.footer.root); this.root.add(this.history.root); this.root.add(this.dialog.root);
    renderer.root.add(this.root);
    this.router = new KeyRouter(renderer, this.keymap, () => this.keyContext(), (command) => this.commandAvailable(command), (command) => this.command(command));
    renderer.on("resize", this.resize);
    renderer.on("focused_renderable", this.updateFooter);
    renderer.addPostProcessFn(this.settleRows);
    this.search.on(InputRenderableEvents.INPUT, this.handleSearchInput);
    this.search.on("focused", this.repaintSearch); this.search.on("blurred", this.repaintSearch);
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
      this.repaintSearch(); this.paintRows(this.visibleRows()); this.paintTabs();
    });
  }

  get promptDrafts(): Record<string, string> {
    return this.agent.promptDrafts;
  }

  get promptInputDrafts() { return this.agent.promptInputDrafts; }

  get workViewPreferences(): WorkViewPreferences { return structuredClone(this.workViews); }

  private toggleSidebar(): void {
    if (this.disposed || this.root.isDestroyed) return;
    const visible = !(this.sidebarTransition?.visible ?? this.sidebar.visible);
    this.sidebarTransition = undefined; this.editor.cancelResize();
    if (this.sidebar.visible === visible) return;
    const transition = { visible, worktreeId: this.selection.worktree?.id ?? null };
    this.sidebarTransition = transition;
    const commit = () => { if (this.sidebarTransition === transition) this.finishSidebarTransition(); };
    const width = this.renderer.width - (visible ? this.sidebar.width : 0);
    const { horizontal } = panelSpacing(this.renderer);
    const cols = Math.min(500, width - horizontal * 2), rows = this.editor.input?.height ?? 0;
    if (cols < 2 || rows < 1 || !this.editor.prepareResize(cols, rows, commit)) commit();
  }
  private finishSidebarTransition(): void {
    const transition = this.sidebarTransition;
    if (transition) this.setSidebarVisible(transition.visible);
  }
  private setSidebarVisible(visible: boolean): void {
    if (this.disposed || this.root.isDestroyed) return;
    this.sidebarTransition = undefined; this.editor.cancelResize();
    if (this.sidebar.visible === visible) return;
    const focused = this.sidebar.hasFocusedDescendant;
    this.sidebar.visible = visible;
    this.paintRows(this.visibleRows());
    if (visible) this.focusNavigation();
    else if (focused) {
      if (this.agent.active) this.agent.prompt.focus();
      else if (this.editor.input && this.displayedWorkView === "editor") this.editor.input.focus();
      else this.workTabs[this.displayedWorkView].focus();
    }
    this.updateFooter();
  }

  private focusNavigation(): void {
    if (!this.sidebar.visible) this.workTabs[this.displayedWorkView].focus();
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
    if (this.sidebarTransition && !this.editor.input) this.finishSidebarTransition();
    const focused = this.renderer.currentFocusedRenderable;
    let shortcuts: readonly FooterShortcut[] = [];
    const context = this.keyContext();
    const hint = (command: CommandId, label: string): FooterShortcut => ({ key: this.keymap.hint(command, context), label });
    const pair = (a: CommandId, b: CommandId, label: string): FooterShortcut => ({ key: [this.keymap.hint(a, context), this.keymap.hint(b, context)].filter(Boolean).join("/"), label });
    const help = this.keymap.bindings.find((binding) => binding.command === "app.help" && binding.keys.length === 1 && inScope(binding.scope, context));
    this.footer.setHelpHint(help ? formatKeys(help.keys) : this.keymap.hint("app.help", context));
    if (this.dialog.visible) shortcuts = [hint("dialog.copy", "Copy"), hint("dialog.page-down", "Page"), hint("dialog.dismiss", "Close")];
    else if (this.history.visible) shortcuts = this.history.shortcuts;
    else if (focused === this.search) shortcuts = [hint("focus.results", "Results"), hint("search.clear", "Clear")];
    else if (focused === this.tree) shortcuts = [
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
          { ...hint("agent.send", this.agent.working ? "Queue" : "Run"), disabled: !this.agent.canSubmit },
          { key: this.keymap.hints("completion.accept", context), label: "Insert", disabled: !this.agent.completionAvailable("completion.accept") },
          { ...hint("completion.next", "Next"), disabled: !this.agent.completionAvailable("completion.next") },
          { ...hint("completion.previous", "Previous"), disabled: !this.agent.completionAvailable("completion.previous") },
          hint("completion.dismiss", "Dismiss"),
        ]
        : [...(this.agent.canSubmit ? [hint("agent.send", this.agent.working ? "Queue" : "Run")] : []),
          hint("agent.newline", "New line"), ...(this.agent.prompt.canInspect ? [hint("agent.inspect", "Inspect")] : []),
          ...(this.agent.canInterrupt ? [hint("agent.interrupt", "Interrupt")] : []),
          ...(this.agent.prompt.value ? [hint("agent.clear", "Clear")] : []),
          hint("focus.transcript", "Transcript"), hint("sidebar.toggle", "Workspace")];
    } else if (context === "git" || context === "git-prompt" || this.git.available("git.back")) shortcuts = this.git.shortcuts;
    else if (focused) {
      const label = this.buttonHints.get(focused);
      if (focused.visible && label) shortcuts = [{ key: this.keymap.hints("button.activate", "button"), label }];
    }
    this.footer.setContext(this.agent.active && !this.dialog.visible && !this.history.visible ? this.agent.transcriptStatus : "");
    this.footer.setShortcuts(shortcuts.filter((shortcut) => shortcut.key));
  };

  private showHelp(): void {
    const context = this.keyContext();
    this.dialog.show({ title: "Keyboard help", text: keymapHelp(this.keymap, context, (command) => this.commandAvailable(command)) });
  }
  private showNotice(): void {
    if (this.footer.noticeText.trim()) this.dialog.show({ title: "Notification details", text: this.footer.noticeText });
  }

  refreshHistory(): void {
    if (this.disposed || this.root.isDestroyed) return;
    this.history.refreshVisible();
  }

  private text(content: string, role: ThemeRole = "text"): TextRenderable {
    const text = new TextRenderable(this.renderer, { content, selectable: false, wrapMode: "none", height: 1, flexShrink: 0 });
    this.theme.bind(text, (colors) => { text.fg = colors[role]; });
    return text;
  }

  private button(label: string, activate: () => void, actionLabel = label, variant: ButtonVariant = "default"): Button {
    const button = new Button(this.renderer, label, activate, variant);
    this.buttonHints.set(button, actionLabel); this.buttonActions.set(button, activate);
    return button;
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

  private revealRow(key: string): void {
    const view = this.rows.get(key), viewport = this.tree.viewport;
    if (!view || viewport.height < 1) return;
    // Prefer the labels when the frame cannot fit; culled text positions can still
    // lack their border inset. Native nearest-edge scrolling also skips exact fits.
    const inset = view.box.height > viewport.height ? 1 : 0;
    const top = view.box.y + inset, bottom = view.box.y + view.box.height - inset;
    if (top < viewport.y) this.tree.scrollBy(top - viewport.y);
    else if (bottom > viewport.y + viewport.height) this.tree.scrollBy(bottom - viewport.y - viewport.height);
  }

  private moveTree(direction: "up" | "down" | "home" | "end"): void {
    const rows = this.visibleRows().filter((row) => row.kind === "worktree");
    const index = rows.findIndex((row) => row.key === this.navigationKey);
    let next = direction === "up" ? index - 1 : index + 1;
    if (direction === "home") next = 0;
    if (direction === "end") next = rows.length - 1;
    const row = rows[Math.max(0, Math.min(rows.length - 1, next))];
    if (row) {
      this.navigationKey = row.key;
      this.paintRows(this.visibleRows()); this.revealRow(row.key); this.navigationRevealPending = true;
      this.lastScrolledKey = row.key; this.updateFooter();
    }
  }

  private keyContext(): KeyContext {
    if (this.dialog?.visible) return "dialog";
    if (this.history?.visible) return this.history.context;
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
    if (focused === this.agent.transcriptScroll) return "transcript";
    return "button";
  }
  private commandAvailable(command: CommandId): boolean {
    if (this.dialog.visible) return command.startsWith("dialog.") || command === "focus.next" || command === "focus.previous" || command === "app.detach";
    if (command.startsWith("dialog.")) return false;
    if (command === "app.help") return true;
    if (command === "notice.details") return Boolean(this.footer.noticeText.trim());
    if (this.history.visible) return command.startsWith("history.") || command === "focus.next" || command === "focus.previous" || command === "app.detach";
    if (command === "history.show") return Boolean(this.selection.worktree);
    if (command.startsWith("history.")) return false;
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
      case "agent.paste": case "agent.newline": case "agent.clear": return this.agent.active;
      case "agent.interrupt": return this.agent.canInterrupt;
      case "agent.inspect": return this.agent.active && this.agent.prompt.canInspect;
      case "button.activate": return !!this.renderer.currentFocusedRenderable && this.buttonActions.has(this.renderer.currentFocusedRenderable);
      default: return true;
    }
  }
  private command(command: CommandId): void {
    if (command === "app.help") { this.showHelp(); return; }
    if (command === "notice.details") { this.showNotice(); return; }
    if (command.startsWith("dialog.")) { this.dialog.command(command); return; }
    if (command === "history.show") { this.history.show(this.selection.worktree); return; }
    if (command.startsWith("history.")) { this.history.command(command); return; }
    if (command.startsWith("completion.")) { this.agent.completionCommand(command); return; }
    if (command.startsWith("session.")) { this.agent.sessionCommand(command); return; }
    if (command.startsWith("git.")) { this.git.command(command); return; }
    if (command.startsWith("transcript.")) { this.agent.transcriptCommand(command); return; }
    switch (command) {
      case "app.detach": this.actions.onDetach?.(); break;
      case "sidebar.toggle": this.toggleSidebar(); break;
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
      case "agent.clear": this.agent.clearPrompt(); break;
      case "agent.interrupt": void this.agent.interrupt().catch((error: unknown) => this.setNotice(reportUnexpected(error, "agent interruption"))); break;
      case "agent.newline": this.agent.prompt.newLine(); break;
      case "agent.inspect": this.agent.prompt.inspectAtCursor(); break;
      case "agent.paste": void this.agent.prompt.pasteClipboard().catch((error: unknown) => this.setNotice(reportUnexpected(error, "clipboard read"))); break;
      case "agent.send": void this.agent.submitPrompt().catch((error: unknown) => this.setNotice(reportUnexpected(error, "prompt submission"))); break;
      case "button.activate": { const focused = this.renderer.currentFocusedRenderable; if (focused) this.buttonActions.get(focused)?.(); break; }
    }
  }
  private moveFocus(direction: 1 | -1): void {
    if (this.dialog.visible) { this.dialog.moveFocus(direction); return; }
    if (this.history.visible) {
      const targets = this.history.focusTargets, index = targets.indexOf(this.renderer.currentFocusedRenderable!);
      targets[(index + direction + targets.length) % targets.length]?.focus(); return;
    }
    if (this.git.modal) {
      const targets = this.git.focusTargets;
      const index = targets.indexOf(this.renderer.currentFocusedRenderable!);
      targets[(index + direction + targets.length) % targets.length]?.focus(); return;
    }
    const targets: Renderable[] = [];
    if (this.sidebar.visible) {
      targets.push(this.search, this.tree);
    }
    targets.push(...Object.values(this.workTabs));
    targets.push(...this.agent.focusTargets);
    if (this.editor.root.visible) {
      if (this.editor.openButton.visible) targets.push(this.editor.openButton);
      if (this.editor.input) targets.push(this.editor.input);
    }
    if (this.terminals.root.visible) targets.push(...this.terminals.focusTargets);
    if (this.git.root.visible) targets.push(...this.git.focusTargets);
    targets.push(...this.footer.focusTargets);
    const index = targets.findIndex((target) => target === this.renderer.currentFocusedRenderable);
    const next = (index + direction + targets.length) % targets.length;
    targets[next]?.focus();
  }

  private resize = (): void => {
    // A physical terminal resize supersedes the geometry of an in-flight sidebar transition.
    this.finishSidebarTransition();
    const { horizontal, vertical } = panelSpacing(this.renderer);
    this.sidebar.width = this.renderer.width < 80 ? 26 : 40;
    this.sidebar.paddingX = horizontal; this.sidebar.paddingBottom = vertical;
    this.viewTabs.height = 1 + vertical; this.viewTabs.paddingTop = 0; this.viewTabs.paddingBottom = vertical;
    this.viewTabs.paddingX = horizontal;
    this.searchBox.height = 1 + vertical * 2; this.searchBox.paddingY = vertical;
    this.searchBox.marginX = -horizontal; this.searchBox.paddingX = horizontal;
    this.search.placeholder = this.renderer.width < 80 ? "Search workspaces" : "Search repo/worktree/branch";
    this.tree.marginTop = vertical;
    // Keep one cell before the divider without changing the sidebar's left inset.
    this.tree.marginRight = 1 - horizontal;
    this.spaceRows(this.visibleRows());
    this.navigationRevealPending = true;
    this.workPanel.minWidth = 0;
  };

  private repaintSearch = (): void => {
    if (this.disposed || this.searchBox.isDestroyed) return;
    this.searchBox.backgroundColor = this.search.focused ? this.theme.colors.selected : this.theme.colors.surface;
  };

  private spaceRows(rows: readonly WorkspaceRow[]): void {
    rows.forEach((row, index) => {
      const view = this.rows.get(row.key); if (!view) return;
      // Frames occupy the existing gaps; adjacent items share one border row.
      const previous = rows[index - 1];
      if (row.kind === "worktree") view.box.marginTop = previous?.kind === "worktree" ? -1 : 0;
      else view.box.marginTop = index > 0 && previous?.kind !== "worktree" ? 1 : 0;
    });
  }

  private settleRows = (): void => {
    if (this.disposed || !this.sidebar.visible) return;
    // Public text widths settle after native layout. Keep the shared offset valid
    // after resize or metadata shrink, without resetting it for ordinary repaint.
    for (const { text } of this.rows.values()) if (text.scrollX > 0) text.scrollX = text.scrollX;
    if (!this.navigationRevealPending) return;
    this.navigationRevealPending = false;
    // Native row positions settle after layout, not in the renderer's resize callback.
    if (this.sidebar.visible && this.tree.focused && this.navigationKey) this.revealRow(this.navigationKey);
  };

  private render(): void {
    if (this.disposed || this.root.isDestroyed) return;
    const rows = this.visibleRows();
    const order = rows.map((row) => row.key);
    if (order.join("\0") !== this.rowOrder.join("\0")) {
      const focusedRow = this.tree.content.hasFocusedDescendant;
      for (const row of this.rows.values()) row.box.destroyRecursively();
      this.rows.clear();
      for (const row of rows) {
        const box = new BoxRenderable(this.renderer, {
          id: row.key, height: row.kind === "worktree" ? 4 : 1, flexShrink: 0, minWidth: 0,
          ...(row.kind === "worktree" ? { border: true, customBorderChars: hiddenWorkspaceBorder } : {}),
          flexDirection: "row", paddingLeft: row.kind === "worktree" ? 0 : row.depth * 2,
          onMouseScroll: (event) => {
            if (row.kind !== "worktree" || !event.scroll || !["left", "right"].includes(event.scroll.direction)) return;
            const text = this.rows.get(row.key)?.text;
            if (!text) return;
            event.preventDefault(); event.stopPropagation();
            text.scrollX += event.scroll.direction === "right" ? event.scroll.delta : -event.scroll.delta;
          },
          onMouseDown: (event) => {
            if (event.button !== 0 || row.kind !== "worktree") return;
            event.preventDefault();
            this.tree.focus();
            this.activateRow(row);
          },
        });
        // Keep both label lines and their fixed status slot in one inset body.
        const body = row.kind === "worktree" ? new BoxRenderable(this.renderer, { id: `${row.key}:body`,
          height: 2, flexGrow: 1, flexShrink: 1, minWidth: 0, flexDirection: "row", paddingLeft: row.depth * 2 - 1 }) : box;
        if (body !== box) box.add(body);
        // One two-line text viewport shares its horizontal offset and width across both labels.
        const text = new TextRenderable(this.renderer, { id: `${row.key}:label`, content: row.label,
          height: row.kind === "worktree" ? 2 : 1, wrapMode: "none", selectable: false,
          onMouseScroll: (event) => {
            // The native text handler already pans both lines. Avoid applying the same delta twice.
            if (row.kind === "worktree" && event.scroll && ["left", "right"].includes(event.scroll.direction)) event.stopPropagation();
          } });
        text.flexGrow = 1;
        text.flexShrink = 1;
        text.minWidth = 0;
        body.add(text);
        const status = row.kind === "worktree" ? new TextRenderable(this.renderer, { id: `${row.key}:error`,
          content: icons.error, width: 1, height: 1, flexShrink: 0, wrapMode: "none", selectable: false, visible: false }) : undefined;
        if (status) {
          const slot = new BoxRenderable(this.renderer, { id: `${row.key}:status`, width: 1, height: "100%", flexShrink: 0,
            flexDirection: "column", justifyContent: "center", alignItems: "center" });
          slot.add(status); body.add(slot);
        }
        this.tree.add(box);
        this.rows.set(row.key, { box, body, text, ...(status ? { status } : {}) });
      }
      this.rowOrder = order;
      this.lastScrolledKey = null;
      if (focusedRow) this.tree.focus();
    }
    this.spaceRows(rows);
    const selectedKey = rows.find((row) => this.selected(row))?.key ?? null;
    const activeId = this.selection.worktree?.id ?? null;
    if (activeId !== this.activeWorktreeId) { this.activeWorktreeId = activeId; this.navigationKey = selectedKey; }
    if (!rows.some((row) => row.key === this.navigationKey)) this.navigationKey = selectedKey ?? rows.find((row) => row.kind === "worktree")?.key ?? null;
    this.paintRows(rows);
    const worktree = this.selection.worktree;
    const workView = worktree ? this.workViews.active[worktree.id] ?? "agent" : "agent";
    if (this.sidebarTransition && (workView !== "editor" || this.sidebarTransition.worktreeId !== worktree?.id)) this.finishSidebarTransition();
    this.displayedWorkView = workView;
    const openIds = new Set([...this.selection.snapshot.flatMap((repo) => repo.worktrees.flatMap((tree) => tree.sessions.map((item) => item.id))), ...(this.actions.getRetainedSessionIds?.() ?? [])]);
    this.agent.update(worktree, this.selection.sessionId, openIds, workView === "agent");
    if (workView === "git") this.git.show(worktree, this.selection.sessionId); else this.git.hide();
    if (workView === "editor") this.editor.show(worktree); else this.editor.hide();
    if (workView === "terminal") this.terminals.show(worktree, worktree ? this.workViews.terminalSelection?.[worktree.id] : undefined); else this.terminals.hide();
    this.resultMessage.content = this.search.value ? "No matching workspaces" : "No repositories";
    this.resultMessage.visible = rows.length === 0;
    this.history.updateScope(worktree);
    this.paintTabs();
    if (this.navigationKey && this.navigationKey !== this.lastScrolledKey) {
      this.revealRow(this.navigationKey); this.navigationRevealPending = true;
    }
    this.lastScrolledKey = this.navigationKey;
    this.updateFooter();
  }

  private repaintRows = (): void => {
    if (this.disposed || this.root.isDestroyed || this.search.isDestroyed) return;
    this.paintRows(this.visibleRows());
  };

  private paintRows(rows: readonly WorkspaceRow[]): void {
    const colors = this.theme.colors;
    for (const row of rows) {
      const view = this.rows.get(row.key);
      if (!view) continue;
      const presentation = rowPresentation(row);
      const cursor = row.key === this.navigationKey && this.tree.focused, active = this.selected(row);
      const highlighted = this.tree.focused ? cursor : active;
      const label = `${presentation.icon} ${singleLine(row.label)}`;
      view.text.content = row.kind === "worktree" ? new StyledText([
        { __isChunk: true, text: `${label}\n`, fg: highlighted ? colors.accent : colors[presentation.color] },
        { __isChunk: true, text: `${icons.branch} ${singleLine(row.worktree.branch ?? "detached HEAD")}`, fg: highlighted ? colors.accent : active ? colors.text : colors.muted },
      ]) : label;
      view.text.fg = highlighted ? colors.accent : colors[presentation.color];
      view.text.attributes = active ? TextAttributes.BOLD : 0;
      view.box.backgroundColor = colors.panel;
      view.body.backgroundColor = colors.panel;
      if (row.kind === "worktree") {
        view.box.customBorderChars = highlighted ? BorderChars.single : hiddenWorkspaceBorder;
        view.box.borderColor = colors.accent;
        // Later siblings must not erase the selected item's shared border row.
        view.box.zIndex = highlighted ? 2 : active ? 1 : 0;
        if (view.status) {
          view.status.visible = row.worktree.sessions.some((session) => sessionStatus(session) === "failure");
          view.status.fg = colors.error;
        }
      }
    }
  }
  private paintTabs(): void {
    for (const [name, tab] of Object.entries(this.workTabs)) tab.active = name === this.displayedWorkView;
  }

  dispose(): void {
    if (this.disposed) return;
    this.agent.rememberScroll();
    this.sidebarTransition = undefined; this.disposed = true;
    this.unsubscribe();
    this.agent.dispose(); this.history.dispose(); this.dialog.dispose(); this.editor.dispose(); this.terminals.dispose(); this.git.dispose();
    this.search.off(InputRenderableEvents.INPUT, this.handleSearchInput);
    this.search.off("focused", this.repaintSearch); this.search.off("blurred", this.repaintSearch);
    this.router.dispose();
    this.renderer.off("resize", this.resize);
    this.renderer.off("focused_renderable", this.updateFooter);
    this.renderer.removePostProcessFn(this.settleRows);
    this.root.destroyRecursively();
  }
}
