import {
  BoxRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  Selection as TextSelection,
  StyledText,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
} from "@opentui/core";
import { stripVTControlCharacters } from "node:util";
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
import { SessionMonitor } from "../../agents/ui/session-monitor.ts";
import { DashboardPanel, type DashboardActions } from "../../agents/ui/dashboard-panel.ts";
import { SessionNotificationStack } from "../../agents/ui/session-notifications.ts";
import type { SessionNotification } from "../../agents/session-notification.ts";
import { ModelPicker, type ModelPickerActions } from "../../agents/ui/model-picker.ts";
import { AccountsPanel, type AccountsActions } from "../../accounts/panel.ts";
import {
  ExtensionDialogPanel,
  type ExtensionDialogActions,
} from "../../agents/ui/extension-dialog.ts";
import type { SessionExtensionUi } from "../../agents/extension-ui.ts";
import { Footer, type FooterShortcut } from "../../ui/footer.ts";
import { Messages, messageText, type Message, type NoticeOptions } from "../../ui/messages.ts";
import { MessagesPanel } from "../../ui/messages-panel.ts";
import { formatRunDuration } from "../../agents/ui/run-completion.ts";
import { TextDialog } from "../../ui/text-dialog.ts";
import { PopupFrame } from "../../ui/popup-frame.ts";
import { POPUP_SIZES, SearchPopupLayout, centerPopup } from "../../ui/popup-layout.ts";
import { SearchInput } from "../../ui/search-input.ts";
import { keymapHelp } from "../../keybindings/help.ts";
import { footerKeyHint } from "../../keybindings/footer.ts";
import { Button, type ButtonVariant } from "../../ui/button.ts";
import { halfPageStep } from "../../ui/navigation.ts";
import { singleLine } from "../../ui/text.ts";
import { err, ok, type Result } from "../../result.ts";
import {
  CapabilityError,
  ProtocolError,
  SessionError,
  reportUnexpected,
  type ExpectedError,
} from "../../errors.ts";
import { EditorPanel, type EditorActions } from "../../editor/ui/panel.ts";
import {
  TerminalPanel,
  type TerminalActions,
  type OpenTerminalUrl,
} from "../../terminal/ui/panel.ts";
import { GitPanel, type GitActions } from "../../git/ui/panel.ts";
import type { WorkView, WorkViewPreferences } from "../../runtime/protocol.ts";
import { defaultKeymap, formatKeys, type Keymap } from "../../keybindings/config.ts";
import { KeyRouter } from "../../keybindings/router.ts";
import { inScope, tabIndex, type CommandId, type KeyContext } from "../../keybindings/commands.ts";
import type { TerminalTheme } from "../../ui/embedded-terminal/theme.ts";
import { uiTheme, type UiTheme } from "../../ui/theme.ts";
import { paintText, styleChunk } from "../../ui/theme-styles.ts";

import type { PreloadedData } from "../preload.ts";

export type WorkbenchActions = AgentActions & {
  preloaded?: Pick<PreloadedData, "cachedModels" | "cachedAccounts" | "cachedHistory" | "previews">;
  onCloseSession: (worktreeId: string, sessionId: string) => void;
  getRetainedSessionIds?: () => ReadonlySet<string>;
  onDashboard?: DashboardActions["load"];
  onResources?: DashboardActions["resources"];
  onWorkspaceResources?: DashboardActions["workspaces"];
  onListModels?: ModelPickerActions["list"];
  onSelectModel?: ModelPickerActions["select"];
  onAccountsRequest?: AccountsActions["request"];
  getExtensionUi?: () => readonly SessionExtensionUi[];
  onExtensionUiResponse?: ExtensionDialogActions["answer"];
  onOpenLoginUrl?: AccountsActions["openUrl"];
  onListHistory?: (
    worktreeId: string,
    signal?: AbortSignal,
    refresh?: boolean,
  ) => Promise<Result<readonly HistoryItem[], ExpectedError>>;
  onPreviewHistory?: (
    worktreeId: string,
    savedId: string,
    signal?: AbortSignal,
  ) => Promise<Result<HistoryPreview, ExpectedError>>;
  onResumeSession?: (worktreeId: string, savedId: string) => Promise<Result<string, ExpectedError>>;
  editor?: EditorActions;
  terminal?: TerminalActions;
  onOpenTerminalUrl?: OpenTerminalUrl;
  git?: GitActions;
  terminalUnavailable?: string;
  terminalTheme?: TerminalTheme;
  initialWorkViews?: WorkViewPreferences;
  onWorkViewsChange?: (preferences: WorkViewPreferences) => void;
  keymap?: Keymap;
  onDetach?: () => void;
  onAcknowledge?: (
    sessionId: string,
    conversationId: string,
    resultId: string,
  ) => Promise<Result<void, ExpectedError>>;
  getMonitoringNotice?: () => string;
};

type RowView = {
  box: BoxRenderable;
  body: BoxRenderable;
  text: TextRenderable;
  status?: TextRenderable;
};

export class Workbench {
  readonly root: BoxRenderable;
  private readonly sidebar: BoxRenderable;
  private readonly workspacePopup: BoxRenderable;
  private workspaceOwner: Renderable | undefined;
  private readonly monitor: SessionMonitor;
  private readonly dashboard: DashboardPanel;
  private readonly notifications: SessionNotificationStack;
  private readonly messages = new Messages();
  private readonly messagesPanel: MessagesPanel;
  private noticeSnapshot = "";
  private foreground = false;
  private readonly acknowledgements = new Map<string, string>();
  private readonly search: SearchInput;
  private readonly tree: ScrollBoxRenderable;
  private readonly workspaceLayout: SearchPopupLayout;
  private readonly history: SessionHistoryPanel;
  private readonly models: ModelPicker;
  private readonly accounts: AccountsPanel;
  private readonly extension: ExtensionDialogPanel;
  private readonly extensionNotifications = new Set<string>();
  private extensionStatus = "";
  private extensionRefreshQueued = false;
  private readonly agent: AgentPanel;
  private readonly workPanel: BoxRenderable;
  private readonly editor: EditorPanel;
  private readonly terminals: TerminalPanel;
  private readonly git: GitPanel;
  private readonly workViews: WorkViewPreferences;
  private displayedWorkView: WorkView = "agent";
  private sessionCreationIntent = 0;
  private readonly footer: Footer;
  private readonly dialog: TextDialog;
  private readonly buttonHints = new WeakMap<Renderable, string>();
  private readonly buttonActions = new WeakMap<Renderable, () => void>();
  private readonly keymap: Keymap;
  private readonly router: KeyRouter;
  private textSelection: { selection: TextSelection; owner: Renderable } | undefined;
  private readonly rows = new Map<string, RowView>();
  private rowOrder: string[] = [];
  private navigationKey: string | null = null;
  private lastScrolledKey: string | null = null;
  private navigationRevealPending = false;
  private activeWorktreeId: string | null = null;
  private readonly unsubscribe: () => void;
  private disposed = false;
  private readonly theme: UiTheme;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly selection: WorkspaceSelection,
    private readonly actions: WorkbenchActions,
  ) {
    this.theme = uiTheme(renderer);
    this.keymap = actions.keymap ?? defaultKeymap();
    this.workViews = structuredClone(actions.initialWorkViews ?? { active: {}, agentScroll: {} });
    this.root = new BoxRenderable(renderer, {
      id: "workspace-screen",
      width: "100%",
      height: "100%",
      flexDirection: "column",
    });

    const panels = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 0, flexDirection: "row" });
    this.workspacePopup = new BoxRenderable(renderer, {
      id: "workspace-picker",
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      zIndex: 4900,
      visible: false,
      onMouseDown: (event) => event.stopPropagation(),
      onMouseScroll: (event) => event.stopPropagation(),
    });
    // Legacy search/tree IDs and key commands remain, without permanent sidebar geometry.
    this.sidebar = new PopupFrame(renderer, {
      id: "workspace-sidebar",
      position: "absolute",
      visible: false,
      minWidth: 0,
      minHeight: 0,
      flexDirection: "column",
      border: false,
      paddingX: 0,
    });
    this.workspacePopup.add(this.sidebar);
    this.search = new SearchInput(renderer, {
      id: "workspace-search",
      fieldId: "workspace-search-box",
      title: "Workspaces",
    });
    this.tree = new ScrollBoxRenderable(renderer, {
      id: "workspace-tree",
      flexGrow: 1,
      minHeight: 0,
      scrollX: false,
      contentOptions: { flexDirection: "column" },
    });
    this.workspaceLayout = new SearchPopupLayout(renderer, {
      id: "workspace",
      search: this.search,
      list: this.tree,
    });
    this.history = new SessionHistoryPanel(renderer, {
      ...(actions.onListHistory ? { list: actions.onListHistory } : {}),
      ...(actions.preloaded
        ? { cached: actions.preloaded.cachedHistory, previews: actions.preloaded.previews }
        : {}),
      ...(actions.onResumeSession ? { resume: actions.onResumeSession } : {}),
      ...(actions.onPreviewHistory ? { preview: actions.onPreviewHistory } : {}),
      details: (id) => actions.getSessionDetails?.(id) ?? null,
      draft: (id) => this.agent?.promptDraftFor(id),
      ...(actions.onImage ? { image: actions.onImage } : {}),
      onChange: () => this.updateFooter(),
      keyHint: (command, context) => this.keymap.hint(command, context),
      onError: (message, options) =>
        this.notify(message, { level: "error", source: "History", ...options }),
      onCloseFallback: () => this.focusNavigation(),
      onOpened: (worktreeId, sessionId) => {
        this.activateSession(worktreeId, sessionId);
        if (this.agent.active) {
          this.agent.focusTranscript();
        } else {
          this.agent.focusTargets[0]?.focus();
        }
      },
    });
    this.models = new ModelPicker(renderer, {
      ...(actions.preloaded ? { cached: actions.preloaded.cachedModels } : {}),
      ...(actions.onListModels ? { list: actions.onListModels } : {}),
      ...(actions.onSelectModel ? { select: actions.onSelectModel } : {}),
      notice: (message, options) => this.notify(message, options),
      changed: () => this.updateFooter(),
      fallback: () => this.focusNavigation(),
      keyHint: (command, context) => this.keymap.hint(command, context),
    });
    this.accounts = new AccountsPanel(renderer, {
      ...(actions.preloaded ? { cached: actions.preloaded.cachedAccounts } : {}),
      ...(actions.onAccountsRequest ? { request: actions.onAccountsRequest } : {}),
      ...(actions.onOpenLoginUrl ? { openUrl: actions.onOpenLoginUrl } : {}),
      ...(actions.onCopyTranscript ? { copy: actions.onCopyTranscript } : {}),
      notice: (message, options) => this.notify(message, options),
      changed: () => this.updateFooter(),
      fallback: () => this.focusNavigation(),
      keyHint: (command, context) => this.keymap.hint(command, context),
    });
    this.extension = new ExtensionDialogPanel(renderer, {
      answer: (id, conversation, response) =>
        actions.onExtensionUiResponse?.(id, conversation, response) ??
        Promise.resolve(err(new CapabilityError("Extension UI is unavailable in this view."))),
      changed: () => this.updateFooter(),
      fallback: () => this.focusNavigation(),
      notice: (message, options) => this.notify(message, options),
      keyHint: (command, context) => this.keymap.hint(command, context),
    });
    this.dialog = new TextDialog(
      renderer,
      () => this.updateFooter(),
      () => this.focusNavigation(),
      actions.onCopyTranscript,
    );
    this.messagesPanel = new MessagesPanel(renderer, this.messages, {
      changed: () => this.updateFooter(),
      fallback: () => this.focusNavigation(),
      hint: (command, context) => this.keymap.hint(command, context),
      details: (item) => this.showMessage(item),
      copy: (item) => this.copyText(item.text),
    });
    this.monitor = new SessionMonitor(renderer, {
      details: (id) => actions.getSessionDetails?.(id) ?? null,
      open: (tree, id) => {
        this.activateSession(tree, id);
        this.agent.focusLatest("prompt");
      },
      changed: () => this.updateFooter(),
      fallback: () => this.focusNavigation(),
      notice: (text, options) => this.notify(text, options),
      ...(actions.getMonitoringNotice ? { warning: actions.getMonitoringNotice } : {}),
      keyHint: (command, context) => this.keymap.hint(command, context),
    });
    this.dashboard = new DashboardPanel(renderer, {
      ...(actions.onDashboard ? { load: actions.onDashboard } : {}),
      ...(actions.onResources ? { resources: actions.onResources } : {}),
      ...(actions.onWorkspaceResources ? { workspaces: actions.onWorkspaceResources } : {}),
      details: (content) => this.dialog.show(content),
      visibilityChanged: () => this.render(),
      projects: () =>
        this.selection.snapshot.map((repository) => ({ id: repository.id, name: repository.name })),
      changed: () => this.updateFooter(),
      fallback: () => this.focusNavigation(),
      keyHint: (command, context) => this.keymap.hint(command, context),
    });
    this.sidebar.add(this.workspaceLayout.root);
    this.workPanel = new BoxRenderable(renderer, {
      id: "work-panel",
      flexGrow: 1,
      minWidth: 0,
      flexDirection: "column",
    });
    this.agent = new AgentPanel(
      renderer,
      {
        ...actions,
        onNewSession: (id) => this.createAgentSession(id),
        onModel: (id) => this.showModels(id),
        onAccounts: () => this.showAccounts(),
        onHistory: () => this.history.show(this.selection.worktree),
        onShowDashboard: () => this.dashboard.show(),
        onInspectInput: (content) => this.dialog.show(content),
        onSelectSession: (tree, id) => this.activateSession(tree, id),
      },
      (label, activate, actionLabel) => this.button(label, activate, actionLabel),
      (message, options) => this.notify(message, options),
      () => this.updateFooter(),
      () => this.focusNavigation(),
      this.workViews.agentScroll,
      (id, position) => {
        this.workViews.agentScroll[id] = position;
        this.saveWorkViews();
      },
      {
        ...(this.workViews.agentViews ? { initialViews: this.workViews.agentViews } : {}),
        saveView: (id, state) => {
          (this.workViews.agentViews ??= {})[id] = state;
          this.saveWorkViews();
        },
        keyHint: (command, context) => this.keymap.hint(command, context),
      },
    );
    this.editor = new EditorPanel(
      renderer,
      actions.editor,
      (label, activate) => this.button(label, activate, "Open editor"),
      (message, options) => this.notify(message, options),
      () => this.updateFooter(),
      actions.terminalTheme,
    );
    this.terminals = new TerminalPanel(
      renderer,
      actions.terminal,
      (label, activate, actionLabel, variant) => this.button(label, activate, actionLabel, variant),
      (message, options) => this.notify(message, options),
      (worktreeId, id) => {
        const selected = (this.workViews.terminalSelection ??= {});
        if ((selected[worktreeId] ?? null) === id) {
          return;
        }
        if (id) {
          selected[worktreeId] = id;
        } else {
          delete selected[worktreeId];
        }

        this.saveWorkViews();
      },
      () => this.updateFooter(),
      actions.terminalUnavailable,
      actions.terminalTheme,
      () => this.keymap.hint("tab.new", "button") || this.keymap.hint("terminal.new", "button"),
      actions.onCopyTranscript,
      actions.onOpenTerminalUrl,
    );
    this.git = new GitPanel(
      renderer,
      actions.git,
      (message, options) => this.notify(message, options),
      () => this.updateFooter(),
      (id, state) => {
        const views = (this.workViews.gitViews ??= {});
        if (JSON.stringify(views[id]) === JSON.stringify(state)) {
          return;
        }

        views[id] = state;
        this.saveWorkViews();
      },
      this.workViews.gitViews ?? {},
      (command, context) => this.keymap.hint(command, context),
      (content) => this.dialog.show(content),
    );
    this.workPanel.add(this.agent.root);
    this.workPanel.add(this.editor.root);
    this.workPanel.add(this.git.root);
    this.workPanel.add(this.terminals.root);
    this.workPanel.add(this.dashboard.root);
    panels.add(this.workPanel);
    this.root.add(panels);

    const help = this.button("Help", () => this.showHelp(), "Open help");
    // Opening a pointer-triggered popup restores the original editor/PTY focus on close.
    help.onMouseDown = (event) => {
      if (event.button === 0) {
        event.preventDefault();
        event.stopPropagation();
        this.showHelp();
      }
    };
    this.footer = new Footer(renderer, { help });
    this.root.add(this.footer.root);
    this.root.add(this.workspacePopup);
    this.root.add(this.monitor.root);
    this.root.add(this.history.root);
    this.root.add(this.models.root);
    this.root.add(this.accounts.root);
    this.root.add(this.extension.root);
    this.root.add(this.dialog.root);
    this.root.add(this.messagesPanel.root);
    this.notifications = new SessionNotificationStack(renderer, (notification) => {
      if ("result" in notification) {
        this.openNotification(notification);
      } else {
        this.showNotice();
        this.showMessage(notification);
      }
    });
    this.root.add(this.notifications.root);
    renderer.root.add(this.root);
    this.router = new KeyRouter(
      renderer,
      this.keymap,
      () => this.keyContext(),
      (command) => this.commandAvailable(command),
      (command, key) => this.command(command, key),
      (key) =>
        this.keyContext().startsWith("transcript") &&
        this.agent.transcriptCaptureKey(key, this.keymap),
      () => (this.selectedText() !== null ? "selection" : null),
    );
    renderer.on("resize", this.resize);
    renderer.on("selection", this.selectionFinished);
    renderer.on("focused_renderable", this.updateFooter);
    renderer.addPostProcessFn(this.settleRows);
    renderer.addPostProcessFn(this.acknowledgeVisible);
    renderer.on("focus", this.focusTerminal);
    renderer.on("blur", this.blurTerminal);
    this.search.on(InputRenderableEvents.INPUT, this.handleSearchInput);
    this.unsubscribe = selection.subscribe(() => this.render());
    this.resize();
    this.render();
    this.focusNavigation();
    this.theme.scrollbars(this.tree);
    this.tree.on("focused", this.repaintRows);
    this.tree.on("blurred", this.repaintRows);
    this.theme.bindStyles(this.root, (styles) => {
      this.root.backgroundColor = styles["ui.text"].bg;
      this.workspacePopup.backgroundColor = styles["ui.backdrop"].bg;
      this.sidebar.backgroundColor = styles["ui.popup"].bg;
      this.paintRows(this.visibleRows());
    });
  }

  get promptDrafts(): Record<string, string> {
    return this.agent.promptDrafts;
  }

  get promptInputDrafts() {
    return this.agent.promptInputDrafts;
  }

  get workViewPreferences(): WorkViewPreferences {
    return structuredClone(this.workViews);
  }

  private toggleSidebar(): void {
    this.setSidebarVisible(!this.sidebar.visible);
  }

  private setSidebarVisible(visible: boolean, restoreFocus = true): void {
    if (this.disposed || this.root.isDestroyed || this.sidebar.visible === visible) {
      return;
    }
    if (visible) {
      this.workspaceOwner = this.renderer.currentFocusedRenderable ?? undefined;
    }

    this.sidebar.visible = this.workspacePopup.visible = visible;
    if (visible) {
      this.search.clear();
    }

    this.paintRows(this.visibleRows());
    if (visible) {
      this.search.focus();
      this.navigationRevealPending = true;
    } else {
      const owner = this.workspaceOwner;
      this.workspaceOwner = undefined;

      let available = !!owner && !owner.isDestroyed;
      for (
        let node: Renderable | null = owner ?? null;
        node;
        node = node.parent as Renderable | null
      ) {
        available &&= node.visible;
      }
      if (restoreFocus && available && owner) {
        owner.focus();
      } else if (restoreFocus) {
        this.focusNavigation();
      }
    }

    this.updateFooter();
  }

  private focusNavigation(): void {
    this.focusWorkView();

    let focused = this.renderer.currentFocusedRenderable ?? null;
    let visible = !!focused && !focused.isDestroyed;
    for (; focused; focused = focused.parent as Renderable | null) {
      visible &&= focused.visible;
    }
    if (!visible) {
      this.footer?.focusTargets.at(-1)?.focus();
    }
  }

  private focusTerminal = (): void => {
    this.foreground = true;
  };

  private blurTerminal = (): void => {
    this.foreground = false;
  };

  private acknowledgeVisible = (): void => {
    if (
      this.disposed ||
      !this.foreground ||
      !this.actions.onAcknowledge ||
      !this.agent.resultVisible ||
      this.messagesPanel.visible ||
      this.sidebar.visible ||
      this.monitor.visible ||
      this.history.visible ||
      this.models.visible ||
      this.accounts.visible ||
      this.dashboard.visible ||
      this.dialog.visible ||
      this.git.modal
    ) {
      return;
    }

    const id = this.selection.sessionId;
    const attention = this.selection.worktree?.sessions.find(
      (session) => session.id === id,
    )?.attention;
    // Most frames have nothing to acknowledge: do not rebuild the aggregate runtime snapshot for them.
    if (!id || !attention || this.acknowledgements.get(id) === attention.id) {
      return;
    }

    const state = this.actions.getSessionDetails?.(id);
    if (!state?.conversationId || state.attention?.id !== attention.id) {
      return;
    }

    this.acknowledgements.set(id, attention.id);
    void this.actions
      .onAcknowledge(id, state.conversationId, state.attention.id)
      .then((result) => {
        if (!result.ok && !this.disposed) {
          this.notify(
            `[${result.error.code}] Result could not be marked as read: ${result.error.message}`,
            { level: "warning", source: "Notifications" },
          );
        }
      })
      .catch((error) => {
        if (!this.disposed) {
          this.notify(reportUnexpected(error, "session acknowledgement"), {
            level: "error",
            source: "Notifications",
          });
        }
      });
  };

  private focusWorkView(): void {
    switch (this.displayedWorkView) {
      case "agent":
        (this.agent.active ? this.agent.prompt : this.agent.focusTargets[0])?.focus();
        break;
      case "editor":
        (this.editor.input ?? this.editor.openButton).focus();
        break;
      case "git":
        this.git.focus();
        break;
      case "terminal":
        this.terminals.focus();
        break;
    }
  }

  private saveWorkViews(): void {
    this.actions.onWorkViewsChange?.(this.workViewPreferences);
  }

  private selectWorkView(view: WorkView, explicit = false): void {
    const worktree = this.selection.worktree;
    if (!worktree) {
      return;
    }

    this.dashboard.hide(false);
    this.agent.rememberScroll();
    this.workViews.active[worktree.id] = view;
    this.saveWorkViews();
    this.render();
    if (view === "editor" && explicit) {
      this.editor.show(worktree, true);
    }

    this.focusWorkView();
  }

  private moveWorkTab(direction: 1 | -1): void {
    if (this.displayedWorkView === "terminal") {
      this.terminals.next(direction);

      return;
    }

    const worktree = this.selection.worktree;
    const sessions = worktree?.sessions;
    if (!worktree || !sessions?.length) {
      return;
    }

    const index = sessions.findIndex((session) => session.id === this.selection.sessionId);
    let target: number;
    if (index < 0) {
      target = direction > 0 ? 0 : sessions.length - 1;
    } else {
      target = (index + direction + sessions.length) % sessions.length;
    }

    const session = sessions[target];
    if (session && session.id !== this.selection.sessionId) {
      // Returning to the original tab must not revive an older creation's focus claim.
      this.sessionCreationIntent++;
      this.activateSession(worktree.id, session.id);
      this.focusWorkView();
    }
  }

  private createAgentSession(worktreeId: string): void {
    const sessionId = this.selection.sessionId;
    const owner = this.renderer.currentFocusedRenderable;
    const intent = ++this.sessionCreationIntent;

    this.actions.onNewSession(worktreeId, (createdId) => {
      // A late creation must not take focus from navigation, a popup or a newer request.
      if (
        this.disposed ||
        this.root.isDestroyed ||
        intent !== this.sessionCreationIntent ||
        this.displayedWorkView !== "agent" ||
        this.selection.worktree?.id !== worktreeId ||
        this.renderer.currentFocusedRenderable !== owner
      ) {
        return;
      }

      const selected = this.selection.sessionId;
      // The first snapshot in an empty worktree may already have selected this new session.
      if (selected !== sessionId && (sessionId !== null || selected !== createdId)) {
        return;
      }

      this.activateSession(worktreeId, createdId);
      this.focusWorkView();
    });
  }

  private activateSession(worktreeId: string, sessionId: string): void {
    this.foreground = true;
    this.acknowledgements.delete(sessionId);
    this.agent.rememberScroll();
    this.workViews.active[worktreeId] = "agent";
    this.saveWorkViews();
    this.selection.selectSession(worktreeId, sessionId);
  }

  notifySession(notification: SessionNotification): void {
    if (this.disposed) {
      return;
    }

    const state = this.actions.getSessionDetails?.(notification.sessionId);
    const result = notification.result;
    const title = {
      complete: "Completed",
      error: "Failed",
      unfinished: "Stopped",
      cancelled: "Cancelled",
    }[result.outcome];
    let level: "success" | "error" | "warning" = "warning";
    if (result.outcome === "complete") {
      level = "success";
    } else if (result.outcome === "error") {
      level = "error";
    }

    const elapsed =
      notification.durationMs === undefined
        ? ""
        : ` · ${formatRunDuration(notification.durationMs)}`;
    const message = this.messages.add(
      [
        `${title}${elapsed}`,
        result.request?.text,
        state?.conversationId === notification.conversationId ? state?.error : undefined,
      ]
        .filter(Boolean)
        .join("\n\n"),
      result.completedAt,
      {
        id: notification.id,
        title,
        level,
        source: `${notification.repository} / ${notification.worktree}`,
      },
    );
    if (!message) {
      return;
    }

    this.messagesPanel.refresh();
    this.notifications.show(notification);
  }

  private openNotification(notification: SessionNotification): void {
    const tree = this.selection.snapshot
      .flatMap((repo) => repo.worktrees)
      .find((tree) => tree.id === notification.worktreeId);
    const state = this.actions.getSessionDetails?.(notification.sessionId);
    if (
      !tree?.sessions.some((session) => session.id === notification.sessionId) ||
      !state ||
      state.conversationId !== notification.conversationId
    ) {
      this.notify("This notification's conversation is no longer open.", { level: "warning" });

      return;
    }

    this.setSidebarVisible(false, false);
    this.monitor.hide(false);
    this.history.hide(false);
    this.models.hide(false);
    this.dashboard.hide(false);
    this.dialog.hide();
    this.messagesPanel.hide(false);
    this.activateSession(notification.worktreeId, notification.sessionId);
    this.agent.focusLatest("prompt");
  }

  setNotice(text: string, options: NoticeOptions = {}): void {
    const signature = JSON.stringify([text, options.level ?? "info", options.source]);
    if (signature === this.noticeSnapshot) {
      return;
    }

    this.noticeSnapshot = signature;
    this.notify(text, options);
  }

  notify(text: string, options: NoticeOptions = {}): void {
    if (this.disposed || this.root.isDestroyed) {
      return;
    }

    const tree = this.selection.worktree;
    const item = this.messages.add(text, Date.now(), {
      source: tree ? `${this.displayedWorkView.toUpperCase()} / ${tree.name}` : "Radian",
      ...options,
    });
    if (!item) {
      return;
    }

    this.messagesPanel.refresh();
    this.notifications.show(item);
  }

  private updateFooter = (): void => {
    if (this.disposed || !this.footer || this.root.isDestroyed) {
      return;
    }
    // Closing another popup must reveal a waiting extension request even when
    // the runtime has no further events to publish.
    if (!this.extensionRefreshQueued) {
      this.extensionRefreshQueued = true;
      queueMicrotask(() => {
        this.extensionRefreshQueued = false;
        if (!this.disposed) {
          this.refreshExtensionUi();
        }
      });
    }

    this.notifications?.setHidden(this.messagesPanel.visible || this.dialog.visible);

    const focused = this.renderer.currentFocusedRenderable;
    let shortcuts: readonly FooterShortcut[] = [];
    const context = this.keyContext();
    const key = (command: CommandId) =>
      footerKeyHint(command, context, this.keymap.hint(command, context));
    const hint = (command: CommandId, label: string): FooterShortcut => ({
      key: key(command),
      label,
    });
    const pair = (a: CommandId, b: CommandId, label: string): FooterShortcut => ({
      key: [key(a), key(b)].filter(Boolean).join("/"),
      label,
    });
    const help = this.keymap.bindings.find(
      (binding) =>
        binding.command === "app.help" &&
        binding.keys.length === 1 &&
        inScope(binding.scope, context),
    );

    this.footer.setHelpHint(
      help ? formatKeys(help.displayKeys) : this.keymap.hint("app.help", context),
    );
    if (this.extension.visible) {
      shortcuts = this.extension.shortcuts;
    } else if (this.dialog.visible) {
      shortcuts = [
        hint("dialog.copy", "Copy"),
        hint("dialog.half-page-down", "½ page"),
        hint("dialog.dismiss", "Close"),
      ];
    } else if (this.messagesPanel.visible) {
      shortcuts = this.messagesPanel.shortcuts;
    } else if (this.dashboard.visible) {
      shortcuts = this.dashboard.shortcuts;
    } else if (this.accounts.visible) {
      shortcuts = this.accounts.shortcuts;
    } else if (this.models.visible) {
      shortcuts = this.models.shortcuts;
    } else if (this.history.visible) {
      shortcuts = this.history.shortcuts;
    } else if (this.monitor?.visible) {
      shortcuts = this.monitor.shortcuts;
    } else if (focused === this.search) {
      shortcuts = [
        hint("focus.results", "Open"),
        pair("workspace.previous", "workspace.next", "Navigate"),
        hint("workspace.half-page-down", "½ page"),
        hint("workspace.dismiss", "Close"),
      ];
    } else if (focused === this.tree) {
      shortcuts = [
        ...(this.visibleRows().some(
          (row) => row.kind === "worktree" && row.key === this.navigationKey,
        )
          ? [hint("workspace.open", "Open worktree")]
          : []),
        pair("workspace.previous", "workspace.next", "Navigate"),
        hint("workspace.dismiss", "Close"),
        hint("workspace.half-page-down", "½ page"),
        pair("workspace.first", "workspace.last", "First/last"),
      ];
    } else if (focused && focused === this.editor?.input) {
      shortcuts = [hint("sidebar.toggle", "Workspaces")];
    } else if (this.terminals.copyContext) {
      shortcuts = [
        hint("terminal.copy-right", "Cursor"),
        hint("terminal.copy-visual", "Select"),
        hint("terminal.copy-visual-line", "Lines"),
        hint("terminal.copy-yank", context === "terminal-visual" ? "Copy selection" : "Copy line"),
        hint("terminal.copy-open-link", "Open link"),
        hint("terminal.copy-half-page-down", "½ page"),
        hint("terminal.copy-back", "Back"),
      ];
    } else if (focused && focused === this.terminals?.input) {
      shortcuts = [
        hint("output.read", "Read output"),
        pair("tab.previous", "tab.next", "Tab"),
        hint("tab.new", "New terminal"),
        hint("tab.close", "Close tab"),
        ...(this.terminals.canScroll
          ? [pair("terminal.scroll-up", "terminal.scroll-down", "Scroll")]
          : []),
        hint("sidebar.toggle", "Workspaces"),
      ];
    } else if (this.terminals.root.visible && this.commandAvailable("tab.new")) {
      shortcuts = [hint("tab.new", "New terminal")];
    } else if (this.agent.root.visible && !this.agent.active) {
      shortcuts = [hint("tab.new", "New session")];
    } else if (this.agent.transcriptContext()) {
      shortcuts = this.agent.transcriptShortcuts;
    } else if (focused === this.agent.prompt && this.agent.active) {
      shortcuts = this.agent.completionOpen
        ? [
            {
              ...hint("agent.send", this.agent.working ? "Queue" : "Run"),
              disabled: !this.agent.canSubmit,
            },
            {
              key: this.keymap.hints("completion.accept", context),
              label: "Insert",
              disabled: !this.agent.completionAvailable("completion.accept"),
            },
            {
              ...hint("completion.next", "Next"),
              disabled: !this.agent.completionAvailable("completion.next"),
            },
            {
              ...hint("completion.previous", "Previous"),
              disabled: !this.agent.completionAvailable("completion.previous"),
            },
            hint("completion.dismiss", "Dismiss"),
          ]
        : [
            ...(this.agent.canSubmit
              ? [hint("agent.send", this.agent.working ? "Queue" : "Run")]
              : []),
            hint("agent.newline", "New line"),
            ...(this.agent.prompt.canInspect ? [hint("agent.inspect", "Inspect")] : []),
            ...(this.agent.canInterrupt ? [hint("agent.interrupt", "Interrupt")] : []),
            ...(this.agent.prompt.value ? [hint("agent.clear", "Clear")] : []),
            pair("agent.history-previous", "agent.history-next", "Input history"),
            hint("output.read", "Transcript"),
            pair("tab.previous", "tab.next", "Tab"),
            hint("sidebar.toggle", "Workspace"),
            hint("tab.new", "New session"),
            hint("tab.close", "Close tab"),
            hint("dashboard.show", "Usage"),
          ];
    } else if (
      context === "git" ||
      context === "git-tabs" ||
      context === "git-search" ||
      context === "git-prompt" ||
      this.git.available("git.back")
    ) {
      shortcuts = this.git.shortcuts;
    } else if (focused) {
      const label = this.buttonHints.get(focused);
      if (focused.visible && label) {
        shortcuts = [
          {
            key: footerKeyHint(
              "button.activate",
              "button",
              this.keymap.hints("button.activate", "button"),
            ),
            label,
          },
        ];
      }
    }

    this.footer.setView(this.dashboard.visible ? "USAGE" : this.displayedWorkView.toUpperCase());
    this.footer.setWorkspace(this.selection.worktree);

    const overlay =
      this.messagesPanel.visible ||
      this.extension.visible ||
      this.dialog.visible ||
      this.history.visible ||
      this.models.visible ||
      this.accounts.visible ||
      this.dashboard.visible ||
      this.monitor?.visible ||
      this.sidebar.visible;
    let outputStatus = "";
    if (this.agent.active) {
      outputStatus = this.agent.transcriptStatus;
    } else if (this.terminals.root.visible) {
      outputStatus = this.terminals.copyStatus;
    }

    this.footer.setContext(overlay ? "" : this.extensionStatus || outputStatus);
    this.footer.setShortcuts(shortcuts.filter((shortcut) => shortcut.key));
  };

  refreshPreloadedData(): void {
    this.models.updateData();
    this.accounts.updateData();
    this.history.updateData();
  }

  private showAccounts(): Result<void, ExpectedError> {
    const worktreeId = this.selection.worktree?.id;
    if (!worktreeId || !this.actions.onAccountsRequest) {
      return err(
        new CapabilityError("Account management is unavailable in this view. No prompt was sent."),
      );
    }

    this.accounts.show(worktreeId);

    return ok(undefined);
  }

  private showModels(sessionId: string): Result<void, ExpectedError> {
    if (!this.actions.onListModels || !this.actions.onSelectModel) {
      return err(
        new CapabilityError("Model selection is unavailable in this view. No prompt was sent."),
      );
    }
    if (this.models.changing) {
      return err(
        new SessionError(
          "SESSION_BUSY",
          "The previous model selection is still settling. Check the session model before retrying.",
        ),
      );
    }

    const conversationId = this.actions.getSessionDetails?.(sessionId)?.conversationId;
    if (!conversationId) {
      return err(
        new ProtocolError(
          "Current conversation identity is unavailable. Reconnect before opening /model.",
        ),
      );
    }

    this.models.show({ sessionId, conversationId });

    return ok(undefined);
  }

  private showHelp(): void {
    const context = this.keyContext();
    const text = keymapHelp(this.keymap, context, (command) => this.commandAvailable(command));

    this.extension.suspend();
    this.dialog.show({ title: "Keyboard help", text });
  }

  private showNotice(): void {
    this.extension.suspend();
    this.messagesPanel.show();
  }

  private showMessage(message: Message): void {
    this.dialog.show({
      title: message.title ?? "Message details",
      text: messageText(message.text),
      copyText: message.text,
    });
  }

  refreshHistory(): void {
    if (this.disposed || this.root.isDestroyed) {
      return;
    }

    this.history.refreshVisible();
  }

  private button(
    label: string,
    activate: () => void,
    actionLabel = label,
    variant: ButtonVariant = "default",
  ): Button {
    const button = new Button(this.renderer, label, activate, variant);
    this.buttonHints.set(button, actionLabel);
    this.buttonActions.set(button, activate);

    return button;
  }

  private activateRow(row: WorkspaceRow): void {
    this.navigationKey = row.key;
    if (row.kind === "worktree") {
      this.setSidebarVisible(false, false);
      this.selection.selectWorktree(row.worktree.id);
      this.focusWorkView();
    }
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
    const view = this.rows.get(key);
    const viewport = this.tree.viewport;
    if (!view || viewport.height < 1) {
      return;
    }

    // Prefer the labels when the frame cannot fit; culled text positions can still
    // lack their border inset. Native nearest-edge scrolling also skips exact fits.
    const inset = view.box.height > viewport.height ? 1 : 0;
    const top = view.box.y + inset;
    const bottom = view.box.y + view.box.height - inset;

    if (top < viewport.y) {
      this.tree.scrollBy(top - viewport.y);
    } else if (bottom > viewport.y + viewport.height) {
      this.tree.scrollBy(bottom - viewport.y - viewport.height);
    }
  }

  private moveTree(direction: "up" | "down" | "home" | "end", step = 1): void {
    const rows = this.visibleRows().filter((row) => row.kind === "worktree");
    const index = rows.findIndex((row) => row.key === this.navigationKey);
    let next = direction === "up" ? index - step : index + step;
    if (direction === "home") {
      next = 0;
    }
    if (direction === "end") {
      next = rows.length - 1;
    }

    const row = rows[Math.max(0, Math.min(rows.length - 1, next))];
    if (row) {
      this.navigationKey = row.key;
      this.paintRows(this.visibleRows());
      this.revealRow(row.key);
      this.navigationRevealPending = true;
      this.lastScrolledKey = row.key;
      this.updateFooter();
    }
  }

  private keyContext(): KeyContext {
    if (this.dialog?.visible) {
      return "dialog";
    }
    if (this.messagesPanel?.visible) {
      return this.messagesPanel.context;
    }
    if (this.extension?.visible) {
      return this.extension.context;
    }
    if (this.accounts?.visible) {
      return this.accounts.context;
    }
    if (this.dashboard?.visible) {
      return this.dashboard.context;
    }
    if (this.models?.visible) {
      return this.models.context;
    }
    if (this.history?.visible) {
      return this.history.context;
    }
    if (this.monitor?.visible) {
      return this.monitor.context;
    }
    if (this.sidebar.visible) {
      return this.search.focused ? "search" : "workspace";
    }

    const focused = this.renderer.currentFocusedRenderable;
    if (!focused) {
      return "none";
    }

    const gitContext = this.git?.keyContext();
    if (gitContext) {
      return gitContext;
    }

    const transcriptContext = this.agent?.transcriptContext();
    if (transcriptContext) {
      return transcriptContext;
    }
    if (focused === this.editor.input) {
      return "editor";
    }
    if (this.terminals.copyContext) {
      return this.terminals.copyContext;
    }
    if (focused === this.terminals.input) {
      return "terminal";
    }
    if (focused === this.tree) {
      return "workspace";
    }
    if (focused === this.search) {
      return "search";
    }
    if (focused === this.agent.prompt) {
      return this.agent.completionOpen ? "prompt-completion" : "prompt";
    }
    if (focused === this.agent.transcriptScroll) {
      return "transcript";
    }

    return "button";
  }

  private selectionRoot(): Renderable {
    if (this.dialog.visible) {
      return this.dialog.root;
    }

    if (this.messagesPanel.visible) {
      return this.messagesPanel.root;
    }

    if (this.extension.visible) {
      return this.extension.root;
    }

    if (this.accounts.visible) {
      return this.accounts.root;
    }

    if (this.dashboard.visible) {
      return this.dashboard.root;
    }

    if (this.models.visible) {
      return this.models.root;
    }

    if (this.history.visible) {
      return this.history.root;
    }

    if (this.monitor.visible) {
      return this.monitor.root;
    }

    if (this.sidebar.visible) {
      return this.sidebar;
    }

    return this.workPanel;
  }

  private selectionFinished = (selection: TextSelection): void => {
    this.textSelection = { selection, owner: this.selectionRoot() };
  };

  private selectedText(): string | null {
    const selection = this.renderer.getSelection();
    const owner = this.selectionRoot();
    // A popup must not copy an older selection from the screen underneath it.
    if (
      !selection?.isActive ||
      selection.isDragging ||
      this.textSelection?.selection !== selection ||
      this.textSelection.owner !== owner
    ) {
      return null;
    }

    const visible = selection.selectedRenderables.filter((renderable) => {
      for (let node: Renderable | null = renderable; node; node = node.parent) {
        if (node.isDestroyed || !node.visible) {
          return false;
        }
        if (node === owner) {
          return true;
        }
      }

      return false;
    });
    if (!visible.length) {
      return null;
    }

    // OpenTUI can include hidden Markdown readers/decorations in native selections.
    // Reuse its text ordering without mutating the user's live selection.
    const selected = new TextSelection(
      visible[0]!,
      selection.anchor,
      selection.focus,
      selection.behavior,
    );
    selected.updateSelectedRenderables(visible);

    return selected.getSelectedText() || null;
  }

  private copyText(text: string): void {
    void Promise.resolve()
      .then(() => this.dialog.copyContent(text))
      .then((result) => {
        if (!this.disposed) {
          this.notify(result.ok ? result.value : `[${result.error.code}] ${result.error.message}`, {
            level: result.ok ? "success" : "error",
            source: "Clipboard",
          });
        }
      })
      .catch((error: unknown) => {
        const message = reportUnexpected(error, "clipboard copy");
        if (!this.disposed) {
          this.notify(message, { level: "error", source: "Clipboard" });
        }
      });
  }

  private activeSearch(): SearchInput | undefined {
    if (this.dialog.visible || this.dashboard.visible) {
      return undefined;
    }

    if (this.messagesPanel.visible) {
      return this.messagesPanel.search;
    }

    if (this.extension.visible) {
      return this.extension.search.field.visible ? this.extension.search : undefined;
    }

    if (this.accounts.visible) {
      return this.accounts.search.field.visible ? this.accounts.search : undefined;
    }

    if (this.models.visible) {
      return this.models.search;
    }

    if (this.history.visible) {
      return this.history.search;
    }

    if (this.monitor.visible) {
      return this.monitor.search;
    }

    return this.sidebar.visible ? this.search : this.git.search;
  }

  private commandAvailable(command: CommandId): boolean {
    if (command === "selection.copy") {
      return this.selectedText() !== null;
    }
    // Explicit ignore bindings are consumed without reaching native input or shortcut help.
    if (command === "input.ignore") {
      return false;
    }
    if (command === "search.clear") {
      return this.activeSearch() !== undefined;
    }
    if (command === "notice.details") {
      return !this.dialog.visible;
    }
    if (this.messagesPanel.visible && !this.dialog.visible) {
      return (
        command.startsWith("messages.") ||
        ["search.clear", "focus.next", "focus.previous", "app.detach", "app.help"].includes(command)
      );
    }
    if (command.startsWith("messages.")) {
      return false;
    }
    if (this.extension.visible) {
      return (
        this.extension.available(command) ||
        command === "focus.next" ||
        command === "focus.previous" ||
        command === "app.detach" ||
        command === "app.help"
      );
    }
    if (command.startsWith("extension.")) {
      return false;
    }
    if (this.dialog.visible) {
      return (
        command.startsWith("dialog.") ||
        command === "focus.next" ||
        command === "focus.previous" ||
        command === "app.detach"
      );
    }
    if (command.startsWith("dialog.")) {
      return false;
    }
    if (this.accounts.visible) {
      return (
        command.startsWith("accounts.") ||
        command === "focus.next" ||
        command === "focus.previous" ||
        command === "app.detach"
      );
    }
    if (command.startsWith("accounts.")) {
      return false;
    }
    if (this.dashboard.visible) {
      return (
        (command.startsWith("dashboard.") && command !== "dashboard.show") ||
        (command.startsWith("view.") && Boolean(this.selection.worktree)) ||
        command === "focus.next" ||
        command === "focus.previous" ||
        command === "app.help" ||
        command === "app.detach"
      );
    }
    if (command === "dashboard.show") {
      return (
        !this.models.visible &&
        !this.history.visible &&
        !this.monitor.visible &&
        !this.sidebar.visible &&
        !this.git.modal
      );
    }
    if (command.startsWith("dashboard.")) {
      return false;
    }
    if (this.models.visible) {
      return (
        command.startsWith("model.") ||
        command === "focus.next" ||
        command === "focus.previous" ||
        command === "app.detach"
      );
    }
    if (command.startsWith("model.")) {
      return false;
    }
    if (this.history.visible) {
      return (
        command.startsWith("history.") ||
        command === "focus.next" ||
        command === "focus.previous" ||
        command === "app.detach"
      );
    }
    if (this.monitor.visible) {
      return (
        command.startsWith("monitor.") ||
        command === "focus.next" ||
        command === "focus.previous" ||
        command === "app.detach"
      );
    }
    if (this.sidebar.visible) {
      return (
        command.startsWith("workspace.") ||
        [
          "sidebar.toggle",
          "focus.sidebar",
          "focus.search",
          "focus.results",
          "search.clear",
          "focus.next",
          "focus.previous",
          "app.detach",
        ].includes(command)
      );
    }
    if (command === "monitor.show") {
      return true;
    }
    if (command.startsWith("monitor.")) {
      return false;
    }
    if (command === "app.help") {
      return true;
    }
    if (command === "history.show") {
      return Boolean(this.selection.worktree);
    }
    if (command.startsWith("history.")) {
      return false;
    }

    const index = tabIndex(command);
    if (index >= 0) {
      return this.displayedWorkView === "agent"
        ? Boolean(this.selection.worktree?.sessions[index])
        : this.displayedWorkView === "terminal" && this.terminals.canSelect(index);
    }
    if (command === "tab.next" || command === "tab.previous") {
      return this.displayedWorkView === "agent"
        ? Boolean(this.selection.worktree?.sessions.length)
        : this.displayedWorkView === "terminal" && this.terminals.canSelect(0);
    }
    if (command === "tab.new") {
      return this.displayedWorkView === "agent"
        ? Boolean(this.selection.worktree)
        : this.displayedWorkView === "terminal" &&
            Boolean(this.selection.worktree && this.actions.terminal);
    }
    if (command === "tab.close") {
      return this.displayedWorkView === "agent"
        ? this.agent.sessionAvailable("session.close")
        : this.displayedWorkView === "terminal" && this.terminals.canClose;
    }
    if (command.startsWith("completion.")) {
      return this.agent.completionAvailable(command);
    }
    if (command.startsWith("session.")) {
      return this.agent.sessionAvailable(command);
    }
    if (command.startsWith("git.")) {
      return this.git.available(command);
    }
    if (command.startsWith("transcript.")) {
      return this.agent.transcriptAvailable(command);
    }
    if (command.startsWith("terminal.copy-")) {
      return this.terminals.copyContext !== null;
    }
    switch (command) {
      case "app.detach":
        return Boolean(this.actions.onDetach);
      case "view.agent":
      case "view.editor":
      case "view.git":
      case "view.terminal":
        return Boolean(this.selection.worktree);
      case "workspace.open":
        return this.visibleRows().some(
          (row) => row.kind === "worktree" && row.key === this.navigationKey,
        );
      case "terminal.new":
        return Boolean(this.selection.worktree && this.actions.terminal);
      case "terminal.close":
      case "terminal.next":
      case "terminal.previous":
        return this.terminals.root.visible && this.terminals.canClose;
      case "terminal.tab-previous":
      case "terminal.tab-next":
        return this.terminals.root.visible && this.terminals.canClose;
      case "terminal.scroll-up":
      case "terminal.scroll-down":
        return this.terminals.root.visible && this.terminals.canScroll;
      case "output.read":
        return this.displayedWorkView === "agent"
          ? this.agent.active
          : this.displayedWorkView === "terminal" && this.terminals.canRead;
      case "focus.prompt":
      case "focus.transcript":
        return this.agent.active;
      case "agent.send":
        return this.agent.active && Boolean(this.agent.sessionId);
      case "agent.paste":
      case "agent.newline":
      case "agent.clear":
        return this.agent.active;
      case "agent.history-previous":
      case "agent.history-next":
        return this.agent.promptHistoryAvailable;
      case "agent.interrupt":
        return this.agent.canInterrupt;
      case "agent.inspect":
        return this.agent.active && this.agent.prompt.canInspect;
      case "button.activate":
        return (
          !!this.renderer.currentFocusedRenderable &&
          this.buttonActions.has(this.renderer.currentFocusedRenderable)
        );
      default:
        return true;
    }
  }

  private command(command: CommandId, key?: KeyEvent): void {
    if (!command.startsWith("transcript.")) {
      this.agent.cancelTranscriptPending();
    }

    this.foreground = true;
    if (command === "selection.copy") {
      const text = this.selectedText();
      if (text !== null) {
        this.copyText(text);
      }

      return;
    }
    if (command === "dashboard.show") {
      this.dashboard.show();

      return;
    }
    if (command.startsWith("dashboard.")) {
      this.dashboard.command(command);

      return;
    }
    if (command === "monitor.show") {
      this.monitor.show();

      return;
    }
    if (command.startsWith("monitor.")) {
      this.monitor.command(command);

      return;
    }
    if (command === "app.help") {
      this.showHelp();

      return;
    }
    if (command === "notice.details") {
      this.showNotice();

      return;
    }
    if (command.startsWith("messages.")) {
      this.messagesPanel.command(command);

      return;
    }
    if (command.startsWith("extension.")) {
      this.extension.command(command);

      return;
    }
    if (command.startsWith("dialog.")) {
      this.dialog.command(command);

      return;
    }
    if (command.startsWith("accounts.")) {
      this.accounts.command(command);

      return;
    }
    if (command.startsWith("model.")) {
      this.models.command(command);

      return;
    }
    if (command === "history.show") {
      this.history.show(this.selection.worktree);

      return;
    }
    if (command.startsWith("history.")) {
      this.history.command(command);

      return;
    }

    const index = tabIndex(command);
    if (index >= 0) {
      if (this.displayedWorkView === "terminal") {
        this.terminals.select(index);
      } else {
        const worktree = this.selection.worktree;
        const session = worktree?.sessions[index];
        if (worktree && session) {
          this.activateSession(worktree.id, session.id);
          this.focusWorkView();
        }
      }

      return;
    }
    if (command === "tab.next" || command === "tab.previous") {
      this.moveWorkTab(command === "tab.next" ? 1 : -1);

      return;
    }
    if (command === "tab.new") {
      if (this.displayedWorkView === "terminal") {
        this.terminals.create();
      } else if (this.selection.worktree) {
        this.createAgentSession(this.selection.worktree.id);
      }

      return;
    }
    if (command === "tab.close") {
      if (this.displayedWorkView === "terminal") {
        this.terminals.closeSelected();
      } else {
        this.agent.sessionCommand("session.close");
      }

      return;
    }
    if (command.startsWith("completion.")) {
      this.agent.completionCommand(command);

      return;
    }
    if (command.startsWith("session.")) {
      this.agent.sessionCommand(command);

      return;
    }
    if (command.startsWith("git.")) {
      this.git.command(command);

      return;
    }
    if (command.startsWith("transcript.")) {
      this.agent.transcriptCommand(command, key);

      return;
    }
    if (command.startsWith("terminal.copy-")) {
      this.terminals.copyCommand(command);

      return;
    }
    switch (command) {
      case "app.detach":
        this.actions.onDetach?.();
        break;
      case "sidebar.toggle":
        this.toggleSidebar();
        break;
      case "focus.sidebar":
      case "focus.search":
        this.setSidebarVisible(true);
        this.search.focus();
        break;
      case "focus.results": {
        const row = this.visibleRows().find((item) => item.key === this.navigationKey);
        if (row) {
          this.activateRow(row);
        }

        break;
      }
      case "workspace.dismiss":
        this.setSidebarVisible(false);
        break;
      case "workspace.search":
        this.search.focus();
        break;
      case "output.read":
        if (this.displayedWorkView === "terminal") {
          this.terminals.readOutput();
        } else {
          this.agent.focusTranscript();
        }
        break;
      case "focus.prompt":
        this.agent.prompt.focus();
        break;
      case "focus.transcript":
        this.agent.focusTranscript();
        break;
      case "focus.next":
        this.moveFocus(1);
        break;
      case "focus.previous":
        this.moveFocus(-1);
        break;
      case "search.clear":
        this.activeSearch()?.clear();
        break;
      case "view.agent":
        this.selectWorkView("agent");
        break;
      case "view.editor":
        this.selectWorkView("editor", true);
        break;
      case "view.git":
        this.selectWorkView("git");
        break;
      case "view.terminal":
        this.selectWorkView("terminal");
        break;
      case "terminal.new":
        this.selectWorkView("terminal");
        this.terminals.create();
        break;
      case "terminal.close":
        this.terminals.closeSelected();
        break;
      case "terminal.previous":
        this.terminals.next(-1);
        break;
      case "terminal.next":
        this.terminals.next(1);
        break;
      case "terminal.tab-previous":
        this.terminals.next(-1);
        break;
      case "terminal.tab-next":
        this.terminals.next(1);
        break;
      case "terminal.scroll-up":
        this.terminals.scroll(-1);
        break;
      case "terminal.scroll-down":
        this.terminals.scroll(1);
        break;
      case "workspace.open": {
        const row = this.visibleRows().find((item) => item.key === this.navigationKey);
        if (row) {
          this.activateRow(row);
        }

        break;
      }
      case "workspace.previous":
        this.moveTree("up");
        break;
      case "workspace.next":
        this.moveTree("down");
        break;
      case "workspace.first":
        this.moveTree("home");
        break;
      case "workspace.last":
        this.moveTree("end");
        break;
      case "workspace.half-page-up":
      case "workspace.half-page-down": {
        if (this.search.focused) {
          this.tree.focus();
        }

        // Each candidate owns two label lines, independent of search and group headings.
        this.moveTree(
          command === "workspace.half-page-up" ? "up" : "down",
          halfPageStep(this.tree.viewport.height, 2),
        );
        break;
      }
      case "agent.clear":
        this.agent.clearPrompt();
        break;
      case "agent.history-previous":
        this.agent.movePromptHistory(-1);
        break;
      case "agent.history-next":
        this.agent.movePromptHistory(1);
        break;
      case "agent.interrupt":
        void this.agent
          .interrupt()
          .catch((error: unknown) =>
            this.notify(reportUnexpected(error, "agent interruption"), { level: "error" }),
          );
        break;
      case "agent.newline":
        this.agent.prompt.newLine();
        break;
      case "agent.inspect":
        this.agent.prompt.inspectAtCursor();
        break;
      case "agent.paste":
        void this.agent.prompt
          .pasteClipboard()
          .catch((error: unknown) =>
            this.notify(reportUnexpected(error, "clipboard read"), { level: "error" }),
          );
        break;
      case "agent.send":
        void this.agent
          .submitPrompt()
          .catch((error: unknown) =>
            this.notify(reportUnexpected(error, "prompt submission"), { level: "error" }),
          );
        break;
      case "button.activate": {
        const focused = this.renderer.currentFocusedRenderable;
        if (focused) {
          this.buttonActions.get(focused)?.();
        }

        break;
      }
    }
  }

  private moveFocus(direction: 1 | -1): void {
    if (this.dialog.visible) {
      this.dialog.moveFocus();

      return;
    }
    if (this.messagesPanel.visible) {
      const targets = this.messagesPanel.focusTargets;
      const index = targets.indexOf(this.renderer.currentFocusedRenderable!);

      targets[(index + direction + targets.length) % targets.length]?.focus();

      return;
    }
    if (this.extension.visible) {
      const targets = this.extension.focusTargets;
      const index = targets.indexOf(this.renderer.currentFocusedRenderable!);

      targets[(index + direction + targets.length) % targets.length]?.focus();

      return;
    }
    if (this.dashboard.visible) {
      const targets = this.dashboard.focusTargets;
      const index = targets.indexOf(this.renderer.currentFocusedRenderable!);

      targets[(index + direction + targets.length) % targets.length]?.focus();

      return;
    }
    if (this.accounts.visible) {
      const targets = this.accounts.focusTargets;
      const index = targets.indexOf(this.renderer.currentFocusedRenderable!);

      targets[(index + direction + targets.length) % targets.length]?.focus();

      return;
    }
    if (this.models.visible) {
      const targets = this.models.focusTargets;
      const index = targets.indexOf(this.renderer.currentFocusedRenderable!);

      targets[(index + direction + targets.length) % targets.length]?.focus();

      return;
    }
    if (this.history.visible) {
      this.history.moveFocus(direction);

      return;
    }
    if (this.git.modal && !this.monitor.visible && !this.sidebar.visible) {
      this.git.moveFocus(direction);

      return;
    }
    if (this.monitor.visible || this.sidebar.visible) {
      const targets = this.monitor.visible ? this.monitor.focusTargets : [this.search, this.tree];
      const index = targets.indexOf(this.renderer.currentFocusedRenderable!);

      targets[(index + direction + targets.length) % targets.length]?.focus();

      return;
    }

    const targets: Renderable[] = [...this.agent.focusTargets];
    if (this.editor.root.visible) {
      if (this.editor.openButton.visible) {
        targets.push(this.editor.openButton);
      }
      if (this.editor.input) {
        targets.push(this.editor.input);
      }
    }
    if (this.terminals.root.visible) {
      targets.push(...this.terminals.focusTargets);
    }
    if (this.git.root.visible) {
      targets.push(...this.git.focusTargets);
    }

    targets.push(...this.footer.focusTargets);

    const index = targets.findIndex((target) => target === this.renderer.currentFocusedRenderable);
    const next = (index + direction + targets.length) % targets.length;

    targets[next]?.focus();
  }

  private resize = (): void => {
    const { height } = centerPopup(
      this.sidebar,
      POPUP_SIZES.standard,
      this.renderer.width,
      this.renderer.height,
    );
    this.search.fit(height - 4);
    this.spaceRows(this.visibleRows());
    this.navigationRevealPending = true;
    this.workPanel.minWidth = 0;
  };

  private spaceRows(rows: readonly WorkspaceRow[]): void {
    rows.forEach((row, index) => {
      const view = this.rows.get(row.key);
      if (!view) {
        return;
      }

      view.box.marginTop = row.kind === "repository" && index > 0 ? 1 : 0;
    });
  }

  private settleRows = (): void => {
    if (this.disposed || !this.sidebar.visible) {
      return;
    }
    // Public text widths settle after native layout. Keep the shared offset valid
    // after resize or metadata shrink, without resetting it for ordinary repaint.
    for (const { text } of this.rows.values()) {
      if (text.scrollX > 0) {
        // oxlint-disable-next-line eslint/no-self-assign -- Re-run the native setter to clamp stale offsets after layout changes.
        text.scrollX = text.scrollX;
      }
    }
    if (!this.navigationRevealPending) {
      return;
    }

    this.navigationRevealPending = false;
    // Native row positions settle after layout, not in the renderer's resize callback.
    if (this.navigationKey) {
      this.revealRow(this.navigationKey);
    }
  };

  private render(): void {
    if (this.disposed || this.root.isDestroyed) {
      return;
    }

    const rows = this.visibleRows();
    this.search.setCounts({
      matched: rows.filter((row) => row.kind === "worktree").length,
      total: this.selection.snapshot.reduce(
        (total, repository) => total + repository.worktrees.length,
        0,
      ),
    });

    const order = rows.map((row) => row.key);
    if (order.join("\0") !== this.rowOrder.join("\0")) {
      const focusedRow = this.tree.content.hasFocusedDescendant;
      for (const row of this.rows.values()) {
        row.box.destroyRecursively();
      }

      this.rows.clear();
      for (const row of rows) {
        const box = new BoxRenderable(this.renderer, {
          id: row.key,
          height: row.kind === "worktree" ? 2 : 1,
          flexShrink: 0,
          minWidth: 0,
          flexDirection: "row",
          paddingLeft: row.kind === "worktree" ? 0 : row.depth * 2,
          onMouseScroll: (event) => {
            if (
              row.kind !== "worktree" ||
              !event.scroll ||
              !["left", "right"].includes(event.scroll.direction)
            ) {
              return;
            }

            const text = this.rows.get(row.key)?.text;
            if (!text) {
              return;
            }

            event.preventDefault();
            event.stopPropagation();
            text.scrollX +=
              event.scroll.direction === "right" ? event.scroll.delta : -event.scroll.delta;
          },
          onMouseDown: (event) => {
            if (event.button !== 0 || row.kind !== "worktree") {
              return;
            }

            event.preventDefault();
            this.tree.focus();
            this.activateRow(row);
          },
        });
        // Keep both label lines and their fixed status slot in one inset body.
        const body =
          row.kind === "worktree"
            ? new BoxRenderable(this.renderer, {
                id: `${row.key}:body`,
                height: 2,
                flexGrow: 1,
                flexShrink: 1,
                minWidth: 0,
                flexDirection: "row",
                paddingLeft: row.depth * 2,
              })
            : box;
        if (body !== box) {
          box.add(body);
        }

        // One two-line text viewport shares its horizontal offset and width across both labels.
        const text = new TextRenderable(this.renderer, {
          id: `${row.key}:label`,
          content: row.label,
          height: row.kind === "worktree" ? 2 : 1,
          wrapMode: "none",
          selectable: false,
          onMouseScroll: (event) => {
            // The native text handler already pans both lines. Avoid applying the same delta twice.
            if (
              row.kind === "worktree" &&
              event.scroll &&
              ["left", "right"].includes(event.scroll.direction)
            ) {
              event.stopPropagation();
            }
          },
        });
        text.flexGrow = 1;
        text.flexShrink = 1;
        text.minWidth = 0;
        body.add(text);

        const status =
          row.kind === "worktree"
            ? new TextRenderable(this.renderer, {
                id: `${row.key}:error`,
                content: icons.error,
                width: 1,
                height: 1,
                flexShrink: 0,
                wrapMode: "none",
                selectable: false,
                visible: false,
              })
            : undefined;
        if (status) {
          const slot = new BoxRenderable(this.renderer, {
            id: `${row.key}:status`,
            width: 1,
            height: "100%",
            flexShrink: 0,
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
          });
          slot.add(status);
          body.add(slot);
        }

        this.tree.add(box);
        this.rows.set(row.key, { box, body, text, ...(status ? { status } : {}) });
      }

      this.rowOrder = order;
      this.lastScrolledKey = null;
      if (focusedRow) {
        this.tree.focus();
      }
    }

    this.spaceRows(rows);

    const selectedKey = rows.find((row) => this.selected(row))?.key ?? null;
    const activeId = this.selection.worktree?.id ?? null;
    if (activeId !== this.activeWorktreeId) {
      this.activeWorktreeId = activeId;
      this.navigationKey = selectedKey;
    }
    if (!rows.some((row) => row.key === this.navigationKey)) {
      this.navigationKey = selectedKey ?? rows.find((row) => row.kind === "worktree")?.key ?? null;
    }

    this.paintRows(rows);

    const worktree = this.selection.worktree;
    const workView = worktree ? (this.workViews.active[worktree.id] ?? "agent") : "agent";

    this.displayedWorkView = workView;

    const sessionIds = new Set(
      this.selection.snapshot.flatMap((repo) =>
        repo.worktrees.flatMap((tree) => tree.sessions.map((item) => item.id)),
      ),
    );
    this.notifications.retain(sessionIds);

    const openIds = new Set([...sessionIds, ...(this.actions.getRetainedSessionIds?.() ?? [])]);
    const workViewVisible = !this.dashboard.visible;
    this.agent.update(
      worktree,
      this.selection.sessionId,
      openIds,
      workViewVisible && workView === "agent",
    );
    if (workViewVisible && workView === "git") {
      this.git.show(worktree, this.selection.sessionId);
    } else {
      this.git.hide();
    }
    if (workViewVisible && workView === "editor") {
      this.editor.show(worktree);
    } else {
      this.editor.hide();
    }
    if (workViewVisible && workView === "terminal") {
      this.terminals.show(
        worktree,
        worktree ? this.workViews.terminalSelection?.[worktree.id] : undefined,
      );
    } else {
      this.terminals.hide();
    }

    this.workspaceLayout.results.showEmpty(
      !rows.length ? (this.search.value ? "No matching workspaces" : "No repositories") : undefined,
    );
    this.history.updateScope(worktree);
    this.monitor.update(this.selection.snapshot);
    for (const id of this.acknowledgements.keys()) {
      if (!openIds.has(id)) {
        this.acknowledgements.delete(id);
      }
    }

    this.refreshExtensionUi();
    this.accounts.updateScope(this.selection.worktree?.id ?? null);
    this.models.updateScope(
      this.selection.sessionId,
      this.selection.sessionId
        ? this.actions.getSessionDetails?.(this.selection.sessionId)?.conversationId
        : undefined,
      workViewVisible && workView === "agent",
    );
    if (this.navigationKey && this.navigationKey !== this.lastScrolledKey) {
      this.revealRow(this.navigationKey);
      this.navigationRevealPending = true;
    }

    this.lastScrolledKey = this.navigationKey;
    this.updateFooter();
  }

  private refreshExtensionUi(): void {
    const extension = this.actions
      .getExtensionUi?.()
      .find(
        (state) =>
          state.sessionId === this.selection.sessionId &&
          state.conversationId ===
            this.actions.getSessionDetails?.(state.sessionId)?.conversationId,
      );
    this.agent.updateMcp(extension?.mcp);
    this.extensionStatus = Object.entries(extension?.statuses ?? {})
      .filter(([key]) => key !== "mcp" || extension?.mcp === undefined)
      .map(([, text]) => singleLine(stripVTControlCharacters(text)))
      .join(" · ");
    for (const notification of extension?.notifications ?? []) {
      if (this.extensionNotifications.has(notification.id)) {
        continue;
      }

      this.extensionNotifications.add(notification.id);

      const message = `Extension ${notification.level} · ${stripVTControlCharacters(notification.message)}`;
      let level: "error" | "warning" | "info" = "info";
      if (notification.level === "error") {
        level = "error";
      } else if (notification.level === "warning") {
        level = "warning";
      }

      this.notify(message, { level, source: "Extension" });
    }

    if (this.extensionNotifications.size > 128) {
      const keep = [...this.extensionNotifications].slice(-64);
      this.extensionNotifications.clear();
      for (const id of keep) {
        this.extensionNotifications.add(id);
      }
    }

    const blocked =
      this.messagesPanel.visible ||
      this.dialog.visible ||
      this.accounts.visible ||
      this.models.visible ||
      this.history.visible ||
      this.dashboard.visible ||
      this.monitor.visible ||
      this.sidebar.visible ||
      this.git.modal;
    if (blocked && extension?.dialog) {
      this.extension.suspend();
    } else {
      this.extension.update(
        extension?.dialog
          ? {
              sessionId: extension.sessionId,
              conversationId: extension.conversationId,
              dialog: extension.dialog,
            }
          : undefined,
      );
    }
  }

  private repaintRows = (): void => {
    if (this.disposed || this.root.isDestroyed || this.search.isDestroyed) {
      return;
    }

    this.paintRows(this.visibleRows());
  };

  private paintRows(rows: readonly WorkspaceRow[]): void {
    const styles = this.theme.styles;
    for (const row of rows) {
      const view = this.rows.get(row.key);
      if (!view) {
        continue;
      }

      const presentation = rowPresentation(row);
      const active = this.selected(row);
      // Search keeps input focus, but candidate navigation still needs a visible cursor.
      const highlighted = row.key === this.navigationKey;
      const label = `${presentation.icon} ${singleLine(row.label)}`;
      const itemStyle = styles[highlighted ? "sidebar.selected" : "sidebar.item"];

      paintText(view.text, itemStyle);
      view.text.content =
        row.kind === "worktree"
          ? new StyledText([
              styleChunk(`${label}\n`, itemStyle),
              styleChunk(
                `${icons.branch} ${singleLine(row.worktree.branch ?? "detached HEAD")}`,
                styles[
                  highlighted ? "sidebar.selected" : active ? "sidebar.item" : "sidebar.branch"
                ],
              ),
            ])
          : label;
      view.text.attributes = itemStyle.attributes | (active ? TextAttributes.BOLD : 0);
      view.box.backgroundColor = view.body.backgroundColor =
        styles[highlighted ? "ui.selection" : "ui.popup"].bg;
      if (row.kind === "worktree") {
        if (view.status) {
          view.status.visible = row.worktree.sessions.some(
            (session) => sessionStatus(session) === "failure",
          );
          paintText(view.status, styles["status.error"]);
        }
      }
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.agent.rememberScroll();
    this.disposed = true;
    this.unsubscribe();
    this.messagesPanel.dispose();
    this.notifications.dispose();
    this.agent.dispose();
    this.history.dispose();
    this.monitor.dispose();
    this.models.dispose();
    this.accounts.dispose();
    this.extension.dispose();
    this.dashboard.dispose();
    this.dialog.dispose();
    this.editor.dispose();
    this.terminals.dispose();
    this.git.dispose();
    this.search.off(InputRenderableEvents.INPUT, this.handleSearchInput);
    this.router.dispose();
    this.renderer.off("resize", this.resize);
    this.renderer.off("selection", this.selectionFinished);
    this.textSelection = undefined;
    this.renderer.off("focused_renderable", this.updateFooter);
    this.renderer.removePostProcessFn(this.settleRows);
    this.renderer.removePostProcessFn(this.acknowledgeVisible);
    this.renderer.off("focus", this.focusTerminal);
    this.renderer.off("blur", this.blurTerminal);
    this.root.destroyRecursively();
  }
}
