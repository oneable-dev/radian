import {
  BoxRenderable, InputRenderable, InputRenderableEvents, ScrollBoxRenderable, TextRenderable,
  type CliRenderer, type Renderable,
} from "@opentui/core";
import packageInfo from "../../package.json";
import { workspaceRows, type WorkspaceRow } from "../workspace/model.ts";
import { WorkspaceSelection } from "../workspace/selection.ts";
import { filterWorkspaces } from "../workspace/filter-workspaces.ts";
import { rowPresentation, workspaceIcons } from "../workspace/status.ts";
import type { ExecutionState } from "../sessions/session-registry.ts";
import type { HistoryItem } from "../sessions/history.ts";
import { SessionHistoryPanel } from "./session-history.ts";
import { Footer, type FooterShortcut } from "./footer.ts";
import type { Result } from "../result.ts";
import { reportUnexpected, type ExpectedError } from "../errors.ts";
import { EditorPanel, type EditorActions } from "./editor.ts";
import { TerminalPanel, type TerminalActions } from "./terminals.ts";
import { GitPanel, type GitActions } from "./git.ts";
import type { WorkView, WorkViewPreferences } from "../runtime/protocol.ts";
import { defaultKeymap, type Keymap } from "../keybindings/config.ts";
import { KeyRouter } from "../keybindings/router.ts";
import type { CommandId, KeyContext } from "../keybindings/commands.ts";
import type { TerminalTheme } from "./terminal-theme.ts";

export type WorkspaceActions = {
  onNewSession: (worktreeId: string) => void;
  onCloseSession: (worktreeId: string, sessionId: string) => void;
  onPrompt?: (sessionId: string, text: string) => Result<void, ExpectedError> | Promise<Result<void, ExpectedError>>;
  getSessionDetails?: (sessionId: string) => ExecutionState | null;
  initialDrafts?: Readonly<Record<string, string>>;
  onDraftChange?: (drafts: Record<string, string>) => void;
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

const colors = { text: "#CBD5E1", muted: "#94A3B8", selected: "#1E3A5F", panel: "#0F172A", accent: "#7DD3FC" };

type RowView = { box: BoxRenderable; text: TextRenderable };

export class WorkspaceView {
  readonly root: BoxRenderable;
  private readonly sidebar: BoxRenderable;
  private readonly search: InputRenderable;
  private readonly tree: ScrollBoxRenderable;
  private readonly resultMessage: TextRenderable;
  private readonly history: SessionHistoryPanel;
  private readonly center: BoxRenderable;
  private readonly centerTitle: TextRenderable;
  private readonly centerDetails: TextRenderable;
  private readonly runtimePanel: BoxRenderable;
  private readonly transcript: TextRenderable;
  private readonly transcriptScroll: ScrollBoxRenderable;
  private readonly prompt: InputRenderable;
  private readonly drafts = new Map<string, string>();
  private readonly submitting = new Set<string>();
  private promptSessionId: string | null = null;
  private lastTranscriptKey = "";
  private syncingDraft = false;
  private readonly workPanel: BoxRenderable;
  private readonly workTabs: Record<WorkView, BoxRenderable>;
  private readonly editor: EditorPanel;
  private readonly terminals: TerminalPanel;
  private readonly git: GitPanel;
  private readonly workViews: WorkViewPreferences;
  private displayedWorkView: WorkView = "agent";
  private pendingScroll: number | null = null;
  private syncingScroll = false;
  private readonly footer: Footer;
  private readonly buttonHints = new WeakMap<Renderable, string>();
  private readonly buttonActions = new WeakMap<Renderable, () => void>();
  private readonly keymap: Keymap;
  private readonly router: KeyRouter;
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
    this.keymap = actions.keymap ?? defaultKeymap();
    this.workViews = structuredClone(actions.initialWorkViews ?? { active: {}, agentScroll: {} });
    this.root = new BoxRenderable(renderer, { id: "workspace-screen", width: "100%", height: "100%", flexDirection: "column", backgroundColor: colors.panel });
    const panels = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 0, flexDirection: "row" });
    this.sidebar = new BoxRenderable(renderer, { width: 34, flexShrink: 0, flexDirection: "column", border: ["right"], borderColor: colors.muted, paddingX: 1 });
    this.sidebar.add(this.text(actions.onPrompt ? "radian / Workspace" : "radian / Workspace preview", colors.accent));
    this.search = new InputRenderable(renderer, {
      id: "workspace-search", width: "100%", flexShrink: 0,
      placeholder: "Search repo/worktree/branch", placeholderColor: colors.muted,
      textColor: colors.text, backgroundColor: colors.panel, focusedBackgroundColor: colors.selected,
    });
    this.sidebar.add(this.search);
    const tabs = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", gap: 1 });
    this.workspaceTab = this.button("Workspace", () => this.setTab("workspace"), "Open Workspace");
    this.historyTab = this.button("History", () => this.setTab("history"), "Open History");
    tabs.add(this.workspaceTab);
    tabs.add(this.historyTab);
    this.sidebar.add(tabs);
    const toolbar = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", gap: 1 });
    this.newButton = this.button("+ New session", () => this.openNewSession(), "New session");
    this.closeButton = this.button("Close selected", () => this.closeSession(), "Close session");
    toolbar.add(this.newButton);
    toolbar.add(this.closeButton);
    this.sidebar.add(toolbar);
    this.tree = new ScrollBoxRenderable(renderer, {
      id: "workspace-tree", flexGrow: 1, minHeight: 0, scrollX: false,
      contentOptions: { flexDirection: "column" },
    });
    this.resultMessage = this.text("", colors.muted);
    this.history = new SessionHistoryPanel(renderer, {
      ...(actions.onListHistory ? { list: actions.onListHistory } : {}),
      ...(actions.onResumeSession ? { resume: actions.onResumeSession } : {}),
      button: (label, activate) => this.button(label, activate, "Refresh history"),
      onChange: () => this.updateFooter(),
      keyHint: (command) => this.keymap.hint(command, "history"),
      onError: (message) => this.setNotice(message),
      onOpened: (worktreeId, sessionId) => {
        this.activateSession(worktreeId, sessionId);
        this.setTab("workspace"); this.tree.focus();
      },
    });
    this.sidebar.add(this.resultMessage);
    this.sidebar.add(this.tree);
    this.sidebar.add(this.history.root);
    this.workPanel = new BoxRenderable(renderer, { id: "work-panel", flexGrow: 1, minWidth: 0, flexDirection: "column" });
    const workTabs = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", paddingX: 1, gap: 2 });
    this.workTabs = {
      agent: this.button("Agent", () => this.selectWorkView("agent"), "Show Agent"),
      editor: this.button("Editor", () => this.selectWorkView("editor", true), "Show Editor"),
      git: this.button("Git", () => this.selectWorkView("git"), "Show Git"),
      terminal: this.button("Terminal", () => this.selectWorkView("terminal"), "Show Terminal"),
    };
    for (const tab of Object.values(this.workTabs)) workTabs.add(tab);
    this.workPanel.add(workTabs);
    this.center = new BoxRenderable(renderer, { id: "agent-view", flexGrow: 1, minHeight: 0, minWidth: 0, padding: 1, flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 1 });
    this.centerTitle = this.text("", colors.accent);
    this.centerDetails = this.text("", colors.muted);
    this.emptyNewButton = this.button("+ New session", () => this.openNewSession(), "New session");
    this.center.add(this.centerTitle);
    this.center.add(this.centerDetails);
    this.center.add(this.emptyNewButton);
    this.runtimePanel = new BoxRenderable(renderer, { width: "100%", flexGrow: 1, minHeight: 0, flexDirection: "column", gap: 1 });
    this.transcriptScroll = new ScrollBoxRenderable(renderer, { id: "session-transcript", flexGrow: 1, minHeight: 0, scrollX: false,
      renderBefore: this.finishAgentScroll });
    this.transcript = new TextRenderable(renderer, { width: "100%", content: "", fg: colors.text, wrapMode: "word", selectable: false });
    this.transcriptScroll.add(this.transcript);
    this.transcriptScroll.verticalScrollBar.on("change", this.rememberAgentScroll);
    this.transcriptScroll.content.on("resize", this.applyAgentScroll);
    this.transcriptScroll.viewport.on("resize", this.applyAgentScroll);
    this.prompt = new InputRenderable(renderer, {
      id: "session-prompt", width: "100%", flexShrink: 0, placeholder: "Prompt · Enter to run", textColor: colors.text,
      backgroundColor: colors.panel, focusedBackgroundColor: colors.selected,
    });
    for (const [id, draft] of Object.entries(actions.initialDrafts ?? {})) this.drafts.set(id, draft);
    this.prompt.on(InputRenderableEvents.INPUT, this.handleDraftInput);
    this.runtimePanel.add(this.transcriptScroll);
    this.runtimePanel.add(this.prompt);
    this.center.add(this.runtimePanel);
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
    this.workPanel.add(this.center); this.workPanel.add(this.editor.root); this.workPanel.add(this.git.root); this.workPanel.add(this.terminals.root);
    panels.add(this.sidebar);
    panels.add(this.workPanel);
    this.root.add(panels);
    this.root.add(this.text(`${workspaceIcons.working} Working · ${workspaceIcons.complete} Complete · ${workspaceIcons.failure} Failure · ${workspaceIcons.unreported} Status not supplied`, colors.muted));
    this.footer = new Footer(renderer, `${packageInfo.name} ${packageInfo.version}`);
    this.footer.setNotice("UI preview only · no agents running");
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
  }

  get promptDrafts(): Record<string, string> {
    return Object.fromEntries(this.drafts);
  }

  get workViewPreferences(): WorkViewPreferences { return structuredClone(this.workViews); }

  private saveWorkViews(): void { this.actions.onWorkViewsChange?.(this.workViewPreferences); }
  private selectWorkView(view: WorkView, explicit = false): void {
    const worktree = this.selection.worktree; if (!worktree) return;
    this.rememberAgentScroll();
    this.workViews.active[worktree.id] = view; this.saveWorkViews(); this.render();
    if (view === "editor" && explicit) this.editor.show(worktree, true);
    if (view === "git") this.git.focus();
  }
  private activateSession(worktreeId: string, sessionId: string): void {
    this.rememberAgentScroll();
    this.workViews.active[worktreeId] = "agent"; this.saveWorkViews();
    this.selection.selectSession(worktreeId, sessionId);
  }
  private rememberAgentScroll = (): void => {
    if (this.disposed || this.root.isDestroyed || this.syncingScroll || this.pendingScroll !== null || !this.promptSessionId || !this.runtimePanel.visible) return;
    const position = Math.max(0, Math.round(this.transcriptScroll.scrollTop));
    if (this.workViews.agentScroll[this.promptSessionId] === position) return;
    this.workViews.agentScroll[this.promptSessionId] = position; this.saveWorkViews();
  };
  private applyAgentScroll = (): void => {
    if (this.disposed || this.root.isDestroyed || this.pendingScroll === null || !this.runtimePanel.visible) return;
    this.syncingScroll = true;
    try { this.transcriptScroll.scrollTo(this.pendingScroll); }
    finally { this.syncingScroll = false; }
  };
  private finishAgentScroll = (): void => {
    if (!this.runtimePanel.visible) return;
    // Scroll translations must settle during layout, not in a post-present frame
    // callback. Keep the target through content/viewport resize rounds so a short
    // previous transcript cannot clamp a longer session's saved position.
    this.pendingScroll = null;
  };

  private handleDraftInput = (): void => {
    if (this.syncingDraft || !this.promptSessionId) return;
    this.drafts.set(this.promptSessionId, this.prompt.value);
    this.actions.onDraftChange?.(this.promptDrafts);
    this.updateFooter();
  };

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
      pair("workspace.previous", "workspace.next", "Select"), pair("workspace.first", "workspace.last", "First/last"),
      ...(this.selection.worktree ? [hint("session.new", "New session")] : []),
      ...(this.selection.sessionId ? [hint("session.close", "Close session")] : []),
    ];
    else if (focused && focused === this.editor?.input) shortcuts = [hint("focus.sidebar", "Sidebar"), ...(!this.keymap.bound("escape", "editor") ? [{ key: "Esc", label: "Normal mode" }] : [])];
    else if (focused && focused === this.terminals?.input) shortcuts = [
      ...(!this.keymap.bound("ctrl+c", "terminal") ? [{ key: "Ctrl+C", label: "Interrupt" }] : []),
      ...(this.terminals.canScroll ? [pair("terminal.scroll-up", "terminal.scroll-down", "Scroll")] : []), hint("focus.sidebar", "Sidebar"),
    ];
    else if (focused === this.transcriptScroll && this.runtimePanel.visible) shortcuts = [
      { key: "↑/↓", label: "Scroll" }, { key: "PgUp/PgDn", label: "Page" },
    ];
    else if (focused === this.prompt && this.runtimePanel.visible) {
      const ready = this.promptSessionId && this.prompt.value.trim() && !this.submitting.has(this.promptSessionId);
      const busy = this.promptSessionId && this.actions.getSessionDetails?.(this.promptSessionId)?.status === "working";
      shortcuts = [...(ready ? [hint("agent.send", busy ? "Queue" : "Run")] : []), hint("focus.sidebar", "Workspace")];
    } else if (context === "git" || context === "git-prompt") shortcuts = this.git.shortcuts;
    else if (focused === this.history.list && this.tab === "history") shortcuts = this.history.shortcuts;
    else if (focused) {
      const unavailable = (focused === this.newButton || focused === this.emptyNewButton) && !this.selection.worktree
        || focused === this.closeButton && !this.selection.sessionId;
      const label = this.buttonHints.get(focused);
      if (!unavailable && focused.visible && label) shortcuts = [{ key: this.keymap.hints("button.activate", "button"), label }];
    }
    this.footer.setShortcuts(shortcuts.filter((shortcut) => shortcut.key));
  };

  refreshHistory(): void {
    if (!this.disposed && !this.root.isDestroyed && this.tab === "history") this.history.show(this.selection.worktree);
  }

  private text(content: string, fg: string = colors.text): TextRenderable {
    return new TextRenderable(this.renderer, { content, fg, selectable: false, wrapMode: "none", height: 1, flexShrink: 0 });
  }

  private button(label: string, activate: () => void, actionLabel = label): BoxRenderable {
    const button = new BoxRenderable(this.renderer, {
      height: 1, flexShrink: 0, focusable: true,
      onMouseDown: (event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        event.preventDefault();
        button.focus();
        activate();
      },
    });
    this.buttonHints.set(button, actionLabel); this.buttonActions.set(button, activate);
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
    if (tab === "workspace") this.history.hide();
    else this.history.show(this.selection.worktree);
    this.render();
  }

  private activateRow(row: WorkspaceRow): void {
    this.navigationKey = row.key;
    if (row.kind === "worktree") this.selection.selectWorktree(row.worktree.id);
    if (row.kind === "session") this.activateSession(row.worktree.id, row.session.id);
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

  private async submitPrompt(): Promise<void> {
    const id = this.selection.sessionId;
    if (!id || !this.prompt.value.trim() || !this.actions.onPrompt || this.submitting.has(id)) return;
    const text = this.prompt.value;
    this.submitting.add(id); this.updateFooter();
    try {
      const result = await this.actions.onPrompt(id, text);
      if (!result.ok) { this.setNotice(`[${result.error.code}] ${result.error.message} · prompt retained`); return; }
      if (this.drafts.get(id) === text) {
        this.drafts.delete(id);
        if (!this.disposed && !this.root.isDestroyed && this.promptSessionId === id && this.prompt.value === text) {
          this.syncingDraft = true; this.prompt.value = ""; this.syncingDraft = false;
        }
        this.actions.onDraftChange?.(this.promptDrafts);
      }
    } finally { this.submitting.delete(id); this.updateFooter(); }
  }

  private moveTree(direction: "up" | "down" | "home" | "end"): void {
    const rows = this.visibleRows().filter((row) => row.kind === "worktree" || row.kind === "session");
    const index = rows.findIndex((row) => row.key === this.navigationKey);
    let next = direction === "up" ? index - 1 : index + 1;
    if (direction === "home") next = 0;
    if (direction === "end") next = rows.length - 1;
    const row = rows[Math.max(0, Math.min(rows.length - 1, next))];
    if (row) this.activateRow(row);
  }

  private keyContext(): KeyContext {
    const focused = this.renderer.currentFocusedRenderable;
    if (!focused) return "none";
    const gitContext = this.git?.keyContext(); if (gitContext) return gitContext;
    if (focused === this.editor.input) return "editor";
    if (focused === this.terminals.input) return "terminal";
    if (focused === this.tree) return "workspace";
    if (focused === this.search) return "search";
    if (focused === this.prompt) return "prompt";
    if (focused === this.history.list) return "history";
    if (focused === this.transcriptScroll) return "transcript";
    return "button";
  }
  private commandAvailable(command: CommandId): boolean {
    if (command.startsWith("git.")) return this.git.available(command);
    switch (command) {
      case "app.detach": return Boolean(this.actions.onDetach);
      case "session.new": case "view.agent": case "view.editor": case "view.git": case "view.terminal": return Boolean(this.selection.worktree);
      case "terminal.new": return Boolean(this.selection.worktree && this.actions.terminal);
      case "terminal.close": case "terminal.next": case "terminal.previous": return this.terminals.root.visible && this.terminals.canClose;
      case "terminal.scroll-up": case "terminal.scroll-down": return this.terminals.root.visible && this.terminals.canScroll;
      case "session.close": return Boolean(this.selection.sessionId);
      case "focus.prompt": return this.runtimePanel.visible;
      case "agent.send": return this.runtimePanel.visible && Boolean(this.promptSessionId);
      case "button.activate": return !!this.renderer.currentFocusedRenderable && this.buttonActions.has(this.renderer.currentFocusedRenderable);
      default: return true;
    }
  }
  private command(command: CommandId): void {
    if (command.startsWith("git.")) { this.git.command(command); return; }
    switch (command) {
      case "app.detach": this.actions.onDetach?.(); break;
      case "focus.sidebar": case "focus.results": if (this.tab === "history") this.history.list.focus(); else this.tree.focus(); break;
      case "focus.search": this.search.focus(); break;
      case "focus.prompt": this.prompt.focus(); break;
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
      case "session.new": this.openNewSession(); break;
      case "session.close": this.closeSession(); break;
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
      case "agent.send": void this.submitPrompt().catch((error: unknown) => this.setNotice(reportUnexpected(error, "prompt submission"))); break;
      case "button.activate": { const focused = this.renderer.currentFocusedRenderable; if (focused) this.buttonActions.get(focused)?.(); break; }
    }
  }
  private moveFocus(direction: 1 | -1): void {
    if (this.git.modal) {
      const targets = this.git.focusTargets;
      const index = targets.indexOf(this.renderer.currentFocusedRenderable!);
      targets[(index + direction + targets.length) % targets.length]?.focus(); return;
    }
    const targets: Renderable[] = [this.search, this.workspaceTab, this.historyTab];
    if (this.tab === "workspace") targets.push(this.newButton, this.closeButton, this.tree);
    else {
      if (this.history.refreshButton.visible) targets.push(this.history.refreshButton);
      targets.push(this.history.list);
    }
    targets.push(...Object.values(this.workTabs));
    if (this.emptyNewButton.visible) targets.push(this.emptyNewButton);
    if (this.runtimePanel.visible) targets.push(this.prompt, this.transcriptScroll);
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
    this.sidebar.width = this.renderer.width < 80 ? 26 : 36;
    this.workPanel.minWidth = 0;
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
        if (row.kind === "session") box.add(this.button("[x]", () => this.actions.onCloseSession(row.worktree.id, row.session.id), "Close session"));
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
    this.rememberAgentScroll();
    const worktree = this.selection.worktree;
    const workView = worktree ? this.workViews.active[worktree.id] ?? "agent" : "agent";
    const returningAgent = workView === "agent" && this.displayedWorkView !== "agent";
    this.displayedWorkView = workView;
    this.center.visible = workView === "agent";
    if (workView === "git") this.git.show(worktree, this.selection.sessionId); else this.git.hide();
    if (workView === "editor") this.editor.show(worktree); else this.editor.hide();
    if (workView === "terminal") this.terminals.show(worktree, worktree ? this.workViews.terminalSelection?.[worktree.id] : undefined); else this.terminals.hide();
    for (const [name, tab] of Object.entries(this.workTabs)) tab.backgroundColor = name === workView ? colors.selected : colors.panel;
    const session = worktree?.sessions.find((item) => item.id === this.selection.sessionId);
    this.centerTitle.content = session?.name ?? (worktree ? "No open sessions" : "No workspace available");
    const details = session ? this.actions.getSessionDetails?.(session.id) : null;
    this.centerDetails.content = worktree
      ? session ? `Workspace: ${worktree.name} · ${details ? details.error ?? details.status ?? "Ready" : "display preview only"}` : `Workspace: ${worktree.name} · create a session explicitly`
      : "Open radian inside a Git repository.";
    const sessionId = session?.id ?? null;
    const switchedSession = sessionId !== this.promptSessionId;
    if (switchedSession || returningAgent) this.pendingScroll = sessionId ? this.workViews.agentScroll[sessionId] ?? Infinity : 0;
    if (switchedSession) {
      if (this.promptSessionId) this.drafts.set(this.promptSessionId, this.prompt.value);
      this.promptSessionId = sessionId;
      this.syncingDraft = true;
      this.prompt.value = sessionId ? this.drafts.get(sessionId) ?? "" : "";
      this.syncingDraft = false;
    }
    const openIds = new Set(this.selection.snapshot.flatMap((repo) => repo.worktrees.flatMap((tree) => tree.sessions.map((item) => item.id))));
    for (const id of this.drafts.keys()) if (!openIds.has(id)) this.drafts.delete(id);
    this.runtimePanel.visible = Boolean(workView === "agent" && session && this.actions.onPrompt);
    const output = details?.output || "Enter a prompt to start this session explicitly.";
    const transcriptKey = `${sessionId ?? ""}\0${output}`;
    if (this.lastTranscriptKey !== transcriptKey) {
      this.lastTranscriptKey = transcriptKey;
      const atBottom = this.transcriptScroll.scrollTop >= this.transcriptScroll.scrollHeight - this.transcriptScroll.viewport.height - 1;
      this.transcript.content = output;
      if (!switchedSession && !returningAgent && this.runtimePanel.visible && atBottom) this.pendingScroll = Infinity;
    }
    if (!this.runtimePanel.visible && this.prompt.focused) this.tree.focus();
    this.emptyNewButton.visible = Boolean(workView === "agent" && worktree && !session);
    this.resultMessage.content = this.search.value ? "No matching workspaces" : "No repositories";
    this.resultMessage.visible = this.tab === "workspace" && rows.length === 0;
    this.tree.visible = this.tab === "workspace";
    this.history.root.visible = this.tab === "history";
    if (this.tab === "history") this.history.updateScope(worktree);
    this.newButton.visible = this.tab === "workspace";
    this.closeButton.visible = this.tab === "workspace";
    this.workspaceTab.backgroundColor = this.tab === "workspace" ? colors.selected : colors.panel;
    this.historyTab.backgroundColor = this.tab === "history" ? colors.selected : colors.panel;
    if (this.navigationKey && this.navigationKey !== this.lastScrolledKey) this.tree.scrollChildIntoView(this.navigationKey);
    this.lastScrolledKey = this.navigationKey;
    this.applyAgentScroll();
    this.updateFooter();
  }

  dispose(): void {
    if (this.disposed) return;
    this.rememberAgentScroll();
    this.disposed = true;
    this.unsubscribe();
    this.history.dispose(); this.editor.dispose(); this.terminals.dispose(); this.git.dispose();
    this.transcriptScroll.verticalScrollBar.off("change", this.rememberAgentScroll);
    this.transcriptScroll.content.off("resize", this.applyAgentScroll);
    this.transcriptScroll.viewport.off("resize", this.applyAgentScroll);
    this.search.off(InputRenderableEvents.INPUT, this.handleSearchInput);
    this.prompt.off(InputRenderableEvents.INPUT, this.handleDraftInput);
    this.router.dispose();
    this.renderer.off("resize", this.resize);
    this.renderer.off("focused_renderable", this.updateFooter);
    this.root.destroyRecursively();
  }
}
