import {
  BoxRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
} from "@opentui/core";
import type { ExecutionState } from "../session-registry.ts";
import type { McpStatus } from "../mcp-status.ts";
import { isChatCollection, type SessionCollection } from "./session-collection.ts";
import { CapabilityError, InputError, type ExpectedError } from "../../errors.ts";
import { err, ok, type Result } from "../../result.ts";
import type { Notice } from "../../ui/messages.ts";
import { uiTheme } from "../../ui/theme.ts";
import { EmptyState } from "../../ui/empty-state.ts";
import { icons } from "../../icons.ts";
import { TranscriptPanel, type TranscriptOptions } from "./transcript-panel.ts";
import { TranscriptBottomButton } from "./transcript-bottom-button.ts";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import type { Keymap } from "../../keybindings/config.ts";
import type { FooterMode, FooterShortcut } from "../../ui/footer.ts";
import { bindPanelSpacing, panelSpacing } from "../../ui/spacing.ts";
import { SessionStatus } from "./session-status.ts";
import { RunStatus } from "./run-status.ts";
import { PromptInput } from "../../ui/prompt-input.ts";
import { expandPromptDraft, type PromptDraft } from "../prompt-input.ts";
import type { DialogContent } from "../../ui/text-dialog.ts";
import { CompletionMenu, type CompletionProvider } from "./completion-menu.ts";
import { SessionTabs } from "./session-tabs.ts";
import { sessionSpinnerStyle } from "./status-indicator.ts";
import { SubagentSummary } from "./subagent-summary.ts";
import type { TranscriptImageProvider } from "../transcript-images.ts";
import { PendingMessages } from "./pending-messages.ts";
import { parseSessionControl } from "../session-controls.ts";
import { parseModelCommand } from "../model-selection.ts";
import { parseAccountsCommand } from "../../accounts/model.ts";
import { parseHistoryCommand } from "../history-command.ts";
import { parseDashboardCommand } from "../dashboard-command.ts";

export type AgentActions = {
  // Invoke onCreated only after the new session is observable in the workspace snapshot.
  onNewSession: (worktreeId: string, onCreated?: (sessionId: string) => void) => void;
  onHistory?: () => void;
  onShowDashboard?: () => void;
  onModel?: (sessionId: string) => Result<void, ExpectedError>;
  onAccounts?: () => Result<void, ExpectedError>;
  onSelectSession?: (worktreeId: string, sessionId: string) => void;
  onCloseSession?: (worktreeId: string, sessionId: string) => void;
  onPrompt?: (
    sessionId: string,
    text: string,
    images?: readonly string[],
  ) => Result<void, ExpectedError> | Promise<Result<void, ExpectedError>>;
  getSessionDetails?: (sessionId: string) => ExecutionState | null;
  onInterrupt?: (sessionId: string) => Promise<Result<void, ExpectedError>>;
  initialDrafts?: Readonly<Record<string, string>>;
  onDraftChange?: (drafts: Record<string, string>, inputs: Record<string, PromptDraft>) => void;
  initialInputDrafts?: Readonly<Record<string, PromptDraft>>;
  onInspectInput?: (content: DialogContent) => void;
  onCopyTranscript?: (text: string) => Promise<Result<string, ExpectedError>>;
  onOpenTranscriptUrl?: TranscriptOptions["openUrl"];
  onComplete?: CompletionProvider;
  onImage?: TranscriptImageProvider;
};

type Button = (label: string, activate: () => void, actionLabel: string) => BoxRenderable;

type PanelOptions = Pick<
  TranscriptOptions,
  "initialViews" | "saveView" | "keyHint" | "initialPosition" | "emptyLogo"
> & { readOnly?: boolean; idPrefix?: string; snapshotTime?: () => number | undefined };

type PromptHistory = {
  entries: { draft: PromptDraft; bytes: number }[];
  bytes: number;
  selected: number | null;
  draft: PromptDraft | null;
};

const maximumPromptHistoryEntries = 100;
const maximumPromptHistoryBytes = 4 * 1024 * 1024;

// Owns the Agent view, drafts and transcript viewport. The workbench supplies
// selection and visibility; it alone decides how this panel joins other features.
export class AgentPanel {
  readonly root: BoxRenderable;
  readonly prompt: PromptInput;
  readonly transcriptScroll: ScrollBoxRenderable;
  private readonly emptyState: EmptyState;
  private readonly sessions: SessionTabs;
  private readonly children: SubagentSummary;
  private readonly runtimePanel: BoxRenderable;
  private readonly transcriptArea: BoxRenderable;
  private readonly composer: BoxRenderable;
  private readonly statusRow: BoxRenderable;
  private statusRows = 0;
  private layoutGap = 0;
  private readonly sessionStatus: SessionStatus;
  private readonly completion: CompletionMenu;
  private readonly transcript: TranscriptPanel;
  private readonly bottomButton: TranscriptBottomButton;
  private readonly runStatus: RunStatus;
  private readonly pendingMessages: PendingMessages;
  private pending: ExecutionState["pendingMessages"] = [];
  private readonly drafts = new Map<string, string>();
  private readonly inputDrafts = new Map<string, PromptDraft>();
  private readonly promptHistories = new Map<string, PromptHistory>();
  private readonly submitting = new Set<string>();
  private worktree: SessionCollection | null = null;
  private promptSessionId: string | null = null;
  private readonly conversations = new Map<string, string>();
  private syncingDraft = false;
  private disposed = false;
  private composerLayout = "";
  private previewDraftSignature = "";

  constructor(
    private readonly renderer: CliRenderer,
    private readonly actions: AgentActions,
    button: Button,
    private readonly notice: Notice,
    private readonly changed: () => void,
    private readonly focusSidebar: () => void,
    initialScroll: Readonly<Record<string, number>>,
    saveScroll: (sessionId: string, position: number) => void,
    private readonly transcriptOptions: PanelOptions = {},
  ) {
    const theme = uiTheme(renderer);
    const id = (name: string) => `${transcriptOptions.idPrefix ?? ""}${name}`;

    this.root = new BoxRenderable(renderer, {
      id: id("agent-view"),
      onSizeChange: () => this.resizeComposer(),
      renderAfter: (buffer) =>
        this.transcript.paintFocusBorder(buffer, this.bottomButton.visible ? 0 : this.layoutGap),
      flexGrow: 1,
      minHeight: 0,
      minWidth: 0,
      padding: 1,
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
      gap: 1,
    });
    theme.bindStyles(this.root, (styles) => {
      this.root.backgroundColor = styles["ui.text"].bg;
    });
    this.sessions = new SessionTabs(renderer, {
      button,
      ...(transcriptOptions.idPrefix ? { idPrefix: transcriptOptions.idPrefix } : {}),
      spinnerStyle: (id) => sessionSpinnerStyle(actions.getSessionDetails?.(id)),
      select: (id) => {
        if (this.worktree && !transcriptOptions.readOnly) {
          actions.onSelectSession?.(this.worktree.id, id);
        }
      },
      create: () => {
        if (this.worktree && !transcriptOptions.readOnly) {
          actions.onNewSession(this.worktree.id);
        }
      },
      close: (id) => {
        if (this.worktree && !transcriptOptions.readOnly) {
          actions.onCloseSession?.(this.worktree.id, id);
        }
      },
      keyHint: (command, context) => transcriptOptions.keyHint?.(command, context) ?? "",
    });
    this.emptyState = new EmptyState(renderer, id("agent-empty-state"));
    this.root.add(this.sessions.root);
    this.root.add(this.emptyState.root);
    this.runtimePanel = new BoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      minHeight: 0,
      flexDirection: "column",
      gap: 0,
    });
    this.transcript = new TranscriptPanel(renderer, {
      notice,
      changed,
      focusPrompt: () => this.prompt.focus(),
      initialScroll,
      saveScroll,
      cacheSessions: true,
      ...transcriptOptions,
      passive: transcriptOptions.readOnly ?? false,
      ...(actions.onCopyTranscript ? { copy: actions.onCopyTranscript } : {}),
      ...(actions.onOpenTranscriptUrl ? { openUrl: actions.onOpenTranscriptUrl } : {}),
      ...(actions.onImage ? { image: actions.onImage } : {}),
    });
    this.transcriptScroll = this.transcript.scroll;
    this.transcriptScroll.id = id("session-transcript");
    // Hide the session scroll thumb; wheel, keys and the shared scroll model stay active.
    this.transcriptScroll.verticalScrollBar.visible = false;
    this.bottomButton = new TranscriptBottomButton(renderer, () => {
      if (!transcriptOptions.readOnly) {
        renderer.clearSelection();
        this.transcript.followLatest();
      }
    });
    this.runtimePanel.add(this.bottomButton);

    const interruptKey = () => transcriptOptions.keyHint?.("agent.interrupt", "prompt") ?? "<Esc>";
    this.runStatus = new RunStatus(renderer, interruptKey, () =>
      this.transcript.prepareLayoutChange(),
    );
    this.pendingMessages = new PendingMessages(renderer, interruptKey);

    const transcriptArea = (this.transcriptArea = new BoxRenderable(renderer, {
      id: id("agent-transcript-area"),
      width: "100%",
      flexGrow: 1,
      minHeight: 0,
      minWidth: 0,
      flexDirection: "column",
      overflow: "hidden",
    }));
    transcriptArea.add(this.transcriptScroll);
    this.prompt = new PromptInput(
      renderer,
      notice,
      (content) => actions.onInspectInput?.(content),
      {
        id: id("session-prompt"),
        fieldId: id("agent-composer"),
        activityId: id("prompt-paste-loading"),
        readOnly: transcriptOptions.readOnly ?? false,
      },
    );
    for (const [id, draft] of Object.entries(actions.initialDrafts ?? {})) {
      this.drafts.set(id, draft);
    }
    for (const [id, draft] of Object.entries(actions.initialInputDrafts ?? {})) {
      this.inputDrafts.set(id, draft);
      this.drafts.set(id, expandPromptDraft(draft, false).text);
    }

    this.prompt.on(InputRenderableEvents.INPUT, this.handleDraftInput);

    const composer = (this.composer = this.prompt.field);
    this.sessionStatus = new SessionStatus(renderer);
    this.sessionStatus.root.id = id("session-status");
    this.completion = new CompletionMenu(
      renderer,
      this.prompt,
      () => (this.active ? this.promptSessionId : null),
      actions.onComplete,
      () => {
        this.resizeComposer();
        changed();
      },
      () => this.completionRows(),
    );

    const statusRow = (this.statusRow = new BoxRenderable(renderer, {
      id: id("transcript-status-row"),
      width: "100%",
      height: 1,
      visible: false,
      flexShrink: 0,
      flexDirection: "column",
    }));
    this.children = new SubagentSummary(renderer);
    this.runStatus.root.width = "100%";
    this.runStatus.root.flexGrow = 0;
    this.runStatus.root.flexShrink = 0;
    statusRow.add(this.runStatus.root);
    statusRow.add(this.children.root);

    // Keep completion and telemetry attached to the composer; only the three outer regions use gap.
    const inputArea = new BoxRenderable(renderer, {
      id: id("agent-input-area"),
      width: "100%",
      minWidth: 0,
      minHeight: 0,
      flexShrink: 0,
      flexDirection: "column",
    });
    inputArea.add(this.pendingMessages.root);
    inputArea.add(composer);
    inputArea.add(this.completion.root);
    inputArea.add(this.sessionStatus.root);
    this.runtimePanel.add(transcriptArea);
    this.runtimePanel.add(statusRow);
    this.runtimePanel.add(inputArea);
    this.root.add(this.runtimePanel);
    theme.scrollbars(this.transcriptScroll);
    bindPanelSpacing(renderer, this.root);
    this.prompt.on("resize", this.resizeComposer);
    this.prompt.on("line-info-change", this.resizeComposer);
    renderer.on("resize", this.resize);
    // Native public geometry settles after size callbacks. The signature-guarded
    // post-layout pass fits the editor/menu without creating a render loop.
    renderer.addPostProcessFn(this.resizeComposer);
    renderer.addPostProcessFn(this.layoutBottomButton);
    this.resize();
  }

  get promptDrafts(): Record<string, string> {
    const drafts = Object.fromEntries(this.drafts);
    if (!this.disposed && !this.prompt.isDestroyed && this.promptSessionId && this.prompt.value) {
      drafts[this.promptSessionId] = this.prompt.legacyText;
    }

    return drafts;
  }

  get promptInputDrafts(): Record<string, PromptDraft> {
    const drafts = structuredClone(Object.fromEntries(this.inputDrafts));
    if (!this.disposed && !this.prompt.isDestroyed && this.promptSessionId && this.prompt.value) {
      drafts[this.promptSessionId] = this.prompt.draft;
    }

    return drafts;
  }

  promptDraftFor(id: string): PromptDraft | string | undefined {
    if (id === this.promptSessionId && !this.disposed) {
      return this.prompt.draft;
    }

    const draft = this.inputDrafts.get(id);

    return draft ? structuredClone(draft) : this.drafts.get(id);
  }

  showPreviewDraft(draft: PromptDraft | string | undefined): void {
    if (!this.transcriptOptions.readOnly || this.disposed) {
      return;
    }

    const signature = JSON.stringify([this.promptSessionId, draft ?? ""]);
    if (signature === this.previewDraftSignature) {
      return;
    }

    this.previewDraftSignature = signature;
    this.syncingDraft = true;
    try {
      if (draft && typeof draft !== "string") {
        const restored = this.prompt.restore(draft);
        if (!restored.ok) {
          this.prompt.value = expandPromptDraft(draft, false).text;
          this.notice(
            `[${restored.error.code}] Preview attachment display could not be restored.`,
            { level: "warning" },
          );
        }
      } else {
        this.prompt.value = draft ?? "";
      }
    } finally {
      this.syncingDraft = false;
    }

    this.resizeComposer();
  }

  get active(): boolean {
    return this.runtimePanel.visible;
  }

  get resultVisible(): boolean {
    return this.active && this.transcript.latestVisible;
  }

  focusLatest(target: "prompt" | "transcript" = "transcript"): void {
    this.transcript.followLatest();
    if (target === "prompt") {
      this.prompt.focus();
    } else {
      this.focusTranscript();
    }
  }

  get sessionId(): string | null {
    return this.promptSessionId;
  }

  get canSubmit(): boolean {
    return (
      !this.transcriptOptions.readOnly &&
      Boolean(
        this.promptSessionId &&
        this.prompt.value.trim() &&
        !this.prompt.pending &&
        !this.submitting.has(this.promptSessionId),
      )
    );
  }

  get canInterrupt(): boolean {
    const details = this.promptSessionId
      ? this.actions.getSessionDetails?.(this.promptSessionId)
      : null;

    return (
      !this.transcriptOptions.readOnly &&
      this.active &&
      !!this.actions.onInterrupt &&
      (!!details?.pendingMessages?.length ||
        details?.status === "working" ||
        (!!this.promptSessionId && this.submitting.has(this.promptSessionId)))
    );
  }

  get working(): boolean {
    return (
      !!this.promptSessionId &&
      this.actions.getSessionDetails?.(this.promptSessionId)?.status === "working"
    );
  }

  get transcriptShortcuts(): readonly FooterShortcut[] {
    return this.transcript.shortcuts;
  }

  get transcriptMode(): FooterMode | null {
    return this.transcript.footerMode;
  }

  get transcriptStatus(): string {
    return this.transcript.footerStatus;
  }

  get completionOpen(): boolean {
    return this.completion.engaged;
  }

  sessionAvailable(command: CommandId): boolean {
    return (
      !this.transcriptOptions.readOnly && this.root.visible && this.sessions.available(command)
    );
  }

  sessionCommand(command: CommandId): void {
    if (!this.transcriptOptions.readOnly) {
      this.sessions.command(command);
    }
  }

  completionAvailable(command: CommandId): boolean {
    return !this.transcriptOptions.readOnly && this.active && this.completion.available(command);
  }

  completionCommand(command: CommandId): void {
    if (!this.transcriptOptions.readOnly) {
      this.completion.command(command);
    }
  }

  transcriptContext(): KeyContext | null {
    return this.transcript.keyContext();
  }

  focusTranscript(): void {
    this.completion.hide();
    if (this.transcriptScroll.visible) {
      this.transcript.focus();
    }
  }

  get transcriptFocused(): boolean {
    return this.transcript.focused;
  }

  transcriptAvailable(command: CommandId): boolean {
    return this.active && this.transcript.available(command);
  }

  transcriptCommand(command: CommandId, key?: KeyEvent): void {
    this.transcript.command(command, key);
  }

  transcriptCaptureKey(key: KeyEvent, keymap: Keymap): boolean {
    return this.transcript.captureKey(key, keymap);
  }

  cancelTranscriptPending(): void {
    this.transcript.cancelPending();
  }

  get focusTargets(): Renderable[] {
    if (!this.root.visible || !this.worktree) {
      return [];
    }

    return this.active
      ? [this.prompt, ...(this.transcriptScroll.visible ? [this.transcript.focusTarget] : [])]
      : [this.root];
  }

  update(
    worktree: SessionCollection | null,
    selectedId: string | null,
    openIds: ReadonlySet<string>,
    visible: boolean,
  ): void {
    if (this.disposed || this.root.isDestroyed) {
      return;
    }

    this.rememberScroll();

    const emptyFocused = this.root.focused;
    this.root.visible = visible;
    this.worktree = worktree;
    this.sessions.update(
      worktree?.id ?? null,
      isChatCollection(worktree) ? [] : (worktree?.sessions ?? []),
      selectedId,
      visible && !isChatCollection(worktree),
    );

    const session = worktree?.sessions.find((item) => item.id === selectedId);
    const details = session ? this.actions.getSessionDetails?.(session.id) : null;
    const creationKey =
      worktree && !session && !this.transcriptOptions.readOnly
        ? this.sessions.creationShortcut
        : "";

    this.emptyState.update({
      icon: worktree ? icons.robot : icons.folder,
      title:
        session?.name ??
        (isChatCollection(worktree)
          ? worktree?.sessions.length
            ? "No conversation selected"
            : "No conversations"
          : worktree
            ? "No AI sessions"
            : "No workspace available"),
      description: worktree
        ? session
          ? `${isChatCollection(worktree) ? "CHAT" : `Workspace: ${worktree.name}`} · ${details ? (details.error ?? details.status ?? "Ready") : "display preview only"}`
          : ""
        : "Open radian inside a Git repository.",
      ...(creationKey
        ? {
            action: {
              key: creationKey,
              label: isChatCollection(worktree) ? "New conversation" : "New session",
            },
          }
        : {}),
    });

    const sessionId = session?.id ?? null;
    const previousConversation = sessionId ? this.conversations.get(sessionId) : undefined;
    const replaced =
      !!details?.conversationId &&
      previousConversation !== undefined &&
      previousConversation !== details.conversationId;
    if (sessionId && details?.conversationId) {
      this.conversations.set(sessionId, details.conversationId);
    }
    if (replaced) {
      this.completion.hide();
      if (sessionId) {
        this.promptHistories.delete(sessionId);
      }
    }

    const switchedSession = sessionId !== this.promptSessionId;
    if (switchedSession) {
      this.completion.hide();
      if (this.promptSessionId) {
        this.saveDraft();
      }

      this.promptSessionId = sessionId;
      this.prompt.setWorkingDirectory(worktree?.path ?? process.cwd());
      this.syncingDraft = true;

      const draft = sessionId ? this.inputDrafts.get(sessionId) : undefined;
      if (draft) {
        const restored = this.prompt.restore(draft);
        if (!restored.ok) {
          this.prompt.value = expandPromptDraft(draft, false).text;
          this.notice(
            `[${restored.error.code}] Attachment display could not be restored; original references were retained.`,
            { level: "warning" },
          );
        }
      } else {
        this.prompt.value = sessionId ? (this.drafts.get(sessionId) ?? "") : "";
      }

      this.syncingDraft = false;
    }
    for (const id of this.drafts.keys()) {
      if (!openIds.has(id)) {
        this.drafts.delete(id);
      }
    }
    for (const id of this.inputDrafts.keys()) {
      if (!openIds.has(id)) {
        this.inputDrafts.delete(id);
      }
    }
    for (const id of this.promptHistories.keys()) {
      if (!openIds.has(id)) {
        this.promptHistories.delete(id);
      }
    }

    this.runtimePanel.visible = Boolean(
      visible && session && (this.actions.onPrompt || this.transcriptOptions.readOnly),
    );
    // Only empty content needs a fallback target; active pane ancestors must not intercept input clicks.
    this.root.focusable = visible && !!worktree && !this.active;
    this.completion.prepare(sessionId, worktree?.path, openIds, {
      files: !isChatCollection(worktree),
    });

    const capturedAt = this.transcriptOptions.snapshotTime?.();
    this.runStatus.update(sessionId, details, this.active, capturedAt === undefined);
    this.pending = details?.pendingMessages ?? [];
    this.sessionStatus.update(details?.telemetry, this.active, capturedAt);
    this.emptyState.root.visible = visible && !this.active;
    this.children.update(session?.subagents ?? [], this.active);
    this.root.gap = 0;
    this.root.alignItems = "stretch";
    this.root.justifyContent = "flex-start";

    const output = details?.output ?? "";
    const transcriptFocused = this.transcript.focused;

    this.transcript.update(
      sessionId,
      details?.sections,
      output,
      this.active,
      details?.conversationId,
    );
    this.transcript.retainSessions(openIds);
    if (this.active && (emptyFocused || (replaced && transcriptFocused))) {
      this.prompt.focus();
    }
    if (!this.active && (this.prompt.focused || transcriptFocused)) {
      if (visible && worktree) {
        this.root.focus();
      } else {
        this.focusSidebar();
      }
    }
    if (!this.active) {
      this.completion.hide();
      this.prompt.cancelPaste();
    } else {
      this.completion.refresh();
    }

    this.resizeComposer();
    if (switchedSession) {
      this.publishDrafts();
    }
  }

  updateMcp(status: McpStatus | undefined): void {
    this.sessionStatus.updateMcp(status);
  }

  private resize = (): void => {
    if (this.disposed || this.root.isDestroyed) {
      return;
    }

    const { horizontal } = panelSpacing(this.renderer);
    this.runtimePanel.marginTop = 0;
    // Bleed the surface through the pane inset, keeping its text aligned with the other rows.
    this.resizeComposer();
    this.composer.marginX = -horizontal;
  };

  private resizeComposer = (): void => {
    if (this.disposed || !this.composer || !this.statusRow || this.prompt.isDestroyed) {
      return;
    }

    const requested = this.prompt.requestedRows;
    const menuRowsBeforeLayout = this.completion?.open ? this.completion.root.height : 0;
    const minimumControls =
      (this.sessions.root.visible ? 1 : 0) +
      this.sessionStatus.root.height +
      menuRowsBeforeLayout +
      2;
    const statusBudget = Math.max(0, this.root.height - minimumControls);

    this.runStatus.fitRows(Math.max(1, statusBudget));
    this.runStatus.root.visible = this.runStatus.hasContent;
    this.children.fitRows(
      Math.min(
        8,
        Math.floor(this.root.height / 3),
        Math.max(0, statusBudget - this.runStatus.rows),
      ),
    );

    const showStatus = this.runStatus.hasContent || this.children.hasContent;
    const statusRows = this.runStatus.rows + this.children.rows;
    const controls =
      (this.sessions.root.visible ? 1 : 0) +
      this.sessionStatus.root.height +
      statusRows +
      1 +
      menuRowsBeforeLayout;

    this.pendingMessages.update(
      this.pending ?? [],
      this.active,
      Math.min(Math.floor(this.root.height / 3), Math.max(0, this.root.height - controls)),
    );

    const signature = JSON.stringify([
      this.pendingMessages.rows,
      this.root.height,
      this.prompt.width,
      this.prompt.height,
      this.composer.height,
      this.sessions.root.visible,
      this.statusRows,
      statusRows,
      this.layoutGap,
      this.transcriptArea.visible,
      showStatus,
      this.sessionStatus.root.height,
      requested,
      this.completion?.open,
      this.completion?.root.height,
    ]);
    if (signature === this.composerLayout) {
      return;
    }

    this.composerLayout = signature;

    const menuRows = this.completion?.open ? this.completion.root.height : 0;
    const fixedRows =
      (this.sessions.root.visible ? 1 : 0) +
      this.sessionStatus.root.height +
      menuRows +
      this.pendingMessages.rows;
    // Region boundaries are independent of the number of rows inside the Working block.
    const boundaries = 1 + Number(showStatus);
    const gap = this.root.height >= fixedRows + statusRows + boundaries + 2 ? 1 : 0;
    if (this.statusRows !== statusRows || this.layoutGap !== gap) {
      this.transcript.prepareLayoutChange();
      this.statusRows = statusRows;
      this.statusRow.visible = showStatus;
      this.statusRow.height = Math.max(1, statusRows);
      this.layoutGap = gap;
      this.runtimePanel.gap = gap;
    }

    const reserved = this.reservedRows(true) + menuRows;
    // The panel allocates space; the shared input alone fits its editor and decoration.
    const available = Math.max(1, this.root.height - reserved - 1);
    const { rows: lines, height } = this.prompt.measure(available);
    const showTranscript = this.root.height > reserved + height;
    if (
      this.transcriptScroll.visible !== showTranscript ||
      this.transcriptArea.visible !== showTranscript
    ) {
      this.transcript.prepareLayoutChange();
      this.transcriptScroll.visible = this.transcriptArea.visible = showTranscript;
    }
    if (this.composer.height !== height || this.prompt.height !== lines) {
      this.transcript.prepareLayoutChange();
    }

    this.prompt.fit(available);
    this.completion?.reflow();
  };

  private layoutBottomButton = (): void => {
    if (this.disposed || this.root.isDestroyed) {
      return;
    }

    const viewport = this.transcriptScroll.viewport;
    // Use a blank boundary or composer inset, never either occupied row of Working.
    const edge = viewport.y + viewport.height;
    const next = this.statusRow.visible
      ? this.statusRow
      : this.pendingMessages.rows
        ? this.pendingMessages.root
        : this.composer;
    const y = next.y > edge ? edge : this.prompt.y > this.composer.y ? this.prompt.y - 1 : null;
    const space =
      y !== null &&
      y >= viewport.y + viewport.height &&
      y < this.runtimePanel.y + this.runtimePanel.height
        ? {
            left: viewport.x - this.runtimePanel.x,
            top: y - this.runtimePanel.y,
            width: viewport.width,
          }
        : null;
    const hint =
      this.transcriptOptions.keyHint?.(
        "transcript.latest",
        this.transcript.keyContext() ?? "transcript",
      ) ?? "";

    this.bottomButton.update(this.active && this.transcript.canFollowLatest, hint, space);
  };

  private reservedRows(transcript = this.transcriptArea.visible): number {
    const boundaries = (transcript ? 1 : 0) + (this.statusRows ? 1 : 0);

    return (
      (this.sessions.root.visible ? 1 : 0) +
      this.statusRows +
      this.sessionStatus.root.height +
      this.pendingMessages.rows +
      this.layoutGap * boundaries
    );
  }

  private completionRows(): number {
    return Math.max(1, this.root.height - this.reservedRows() - this.composer.height);
  }

  private saveDraft(): void {
    if (!this.promptSessionId) {
      return;
    }
    if (this.prompt.value) {
      this.drafts.set(this.promptSessionId, this.prompt.legacyText);
      this.inputDrafts.set(this.promptSessionId, this.prompt.draft);
    } else {
      this.drafts.delete(this.promptSessionId);
      this.inputDrafts.delete(this.promptSessionId);
    }
  }

  private publishDrafts(): void {
    if (this.transcriptOptions.readOnly) {
      return;
    }

    this.actions.onDraftChange?.(this.promptDrafts, this.promptInputDrafts);
  }

  rememberScroll = (): void => {
    this.transcript.rememberScroll();
  };

  private handleDraftInput = (): void => {
    if (this.syncingDraft || !this.promptSessionId) {
      return;
    }

    this.saveDraft();
    this.publishDrafts();
    this.resizeComposer();
    this.completion.refresh();
    this.changed();
  };

  private promptHistoryFor(id: string): PromptHistory {
    let history = this.promptHistories.get(id);
    if (!history) {
      history = { entries: [], bytes: 0, selected: null, draft: null };
      this.promptHistories.set(id, history);
    }

    return history;
  }

  private rememberPrompt(history: PromptHistory, draft: PromptDraft): void {
    const previous = history.entries.at(-1)?.draft;
    // Cursor movement alone does not make two consecutive accepted inputs distinct.
    if (
      previous?.value === draft.value &&
      JSON.stringify(previous.tokens) === JSON.stringify(draft.tokens)
    ) {
      return;
    }

    const entry = {
      draft: structuredClone(draft),
      bytes: Buffer.byteLength(JSON.stringify(draft)),
    };
    history.entries.push(entry);
    history.bytes += entry.bytes;
    // Keep at least the latest complete rich draft, even when it alone exceeds the history budget.
    while (
      history.entries.length > 1 &&
      (history.entries.length > maximumPromptHistoryEntries ||
        history.bytes > maximumPromptHistoryBytes)
    ) {
      history.bytes -= history.entries.shift()!.bytes;
      if (history.selected !== null) {
        history.selected = Math.max(0, history.selected - 1);
      }
    }
  }

  get promptHistoryAvailable(): boolean {
    return (
      !this.transcriptOptions.readOnly &&
      this.active &&
      !!this.promptSessionId &&
      this.prompt.focused &&
      !this.completion.engaged &&
      !this.prompt.pending &&
      !this.submitting.has(this.promptSessionId)
    );
  }

  movePromptHistory(direction: -1 | 1): void {
    const id = this.promptSessionId;
    if (!id || !this.promptHistoryAvailable) {
      return;
    }

    const history = this.promptHistoryFor(id);
    const current = history.selected ?? history.entries.length;
    const next = Math.max(0, Math.min(history.entries.length, current + direction));
    if (next === current) {
      return;
    }

    const original = history.draft ?? this.prompt.draft;
    const target = next === history.entries.length ? original : history.entries[next]!.draft;
    const restored = this.prompt.restore(target);
    if (!restored.ok) {
      this.notice(`[${restored.error.code}] Input history could not be restored; draft retained.`, {
        level: "error",
      });

      return;
    }

    history.selected = next === history.entries.length ? null : next;
    history.draft = history.selected === null ? null : original;
    // Recalling a slash/file/skill input is not a new completion interaction. Editing it can reopen suggestions.
    this.completion.command("completion.dismiss");
    this.changed();
  }

  clearPrompt(): void {
    this.completion.hide();
    this.prompt.clear();

    const history = this.promptSessionId
      ? this.promptHistories.get(this.promptSessionId)
      : undefined;
    if (history) {
      history.selected = null;
      history.draft = null;
    }
  }

  async interrupt(): Promise<void> {
    const id = this.promptSessionId;
    if (!id || !this.canInterrupt || !this.actions.onInterrupt) {
      return;
    }

    const result = await this.actions.onInterrupt(id);
    if (!result.ok) {
      this.notice(`[${result.error.code}] ${result.error.message}`, { level: "error" });
    }
  }

  async submitPrompt(): Promise<void> {
    const id = this.promptSessionId;
    if (!id || !this.canSubmit || !this.actions.onPrompt) {
      return;
    }

    this.submitting.add(id);
    this.changed();
    try {
      const prepared = this.completion.prepareCommandSubmission();
      const ready = typeof prepared === "boolean" ? prepared : await prepared;
      if (!ready) {
        return;
      }
      if (this.disposed || this.root.isDestroyed || this.promptSessionId !== id || !this.active) {
        return;
      }

      this.completion.command("completion.dismiss");
      this.saveDraft();

      const draft = this.prompt.draft;
      const submission = this.prompt.submission;
      const inputHistory = this.promptHistoryFor(id);
      const fingerprint = (value: PromptDraft | undefined) =>
        value ? JSON.stringify([value.value, value.tokens]) : "";
      const sent = fingerprint(draft);
      const control = parseSessionControl(submission.text);
      if (!control.ok) {
        this.notice(`[${control.error.code}] ${control.error.message} · prompt retained`, {
          level: "error",
        });

        return;
      }

      const accounts = parseAccountsCommand(submission.text);
      if (!accounts.ok) {
        this.notice(`[${accounts.error.code}] ${accounts.error.message} · prompt retained`, {
          level: "error",
        });

        return;
      }

      const model = parseModelCommand(submission.text);
      if (!model.ok) {
        this.notice(`[${model.error.code}] ${model.error.message} · prompt retained`, {
          level: "error",
        });

        return;
      }

      const history = parseHistoryCommand(submission.text);
      if (!history.ok) {
        this.notice(`[${history.error.code}] ${history.error.message} · prompt retained`, {
          level: "error",
        });

        return;
      }

      const dashboard = parseDashboardCommand(submission.text);
      if (!dashboard.ok) {
        this.notice(`[${dashboard.error.code}] ${dashboard.error.message} · prompt retained`, {
          level: "error",
        });

        return;
      }
      // Non-conversation actions must not reset the outgoing conversation's reading position.
      if (
        !accounts.value &&
        !model.value &&
        !history.value &&
        !dashboard.value &&
        control.value?.action !== "new-tab" &&
        control.value?.action !== "exit" &&
        control.value?.action !== "reload"
      ) {
        this.transcript.followLatest();
      }

      let result: Result<void, ExpectedError>;
      if (accounts.value) {
        result = submission.images.length
          ? err(new InputError("/accounts does not accept image attachments. Input was retained."))
          : (this.actions.onAccounts?.() ??
            err(
              new CapabilityError(
                "Account management is unavailable in this view. No prompt was sent.",
              ),
            ));
      } else if (dashboard.value) {
        if (submission.images.length) {
          result = err(
            new InputError("/dashboard does not accept image attachments. Input was retained."),
          );
        } else if (!this.actions.onShowDashboard) {
          result = err(
            new CapabilityError("Dashboard is unavailable in this view. No prompt was sent."),
          );
        } else {
          this.actions.onShowDashboard();
          result = ok(undefined);
        }
      } else if (history.value) {
        if (submission.images.length) {
          result = err(
            new InputError("/history does not accept image attachments. Input was retained."),
          );
        } else if (!this.actions.onHistory) {
          result = err(
            new CapabilityError("History is unavailable in this view. No prompt was sent."),
          );
        } else {
          this.actions.onHistory();
          result = ok(undefined);
        }
      } else if (model.value) {
        result = submission.images.length
          ? err(new InputError("/model does not accept image attachments. Input was retained."))
          : (this.actions.onModel?.(id) ??
            err(
              new CapabilityError(
                "Model selection is unavailable in this view. No prompt was sent.",
              ),
            ));
      } else {
        result = await this.actions.onPrompt(id, submission.text, submission.images);
      }
      if (!result.ok) {
        this.notice(`[${result.error.code}] ${result.error.message} · prompt retained`, {
          level: "error",
        });

        return;
      }
      if (!this.disposed && this.promptHistories.get(id) === inputHistory) {
        this.rememberPrompt(inputHistory, draft);
      }
      if (fingerprint(this.inputDrafts.get(id)) === sent) {
        inputHistory.selected = null;
        inputHistory.draft = null;
        this.drafts.delete(id);
        this.inputDrafts.delete(id);
        if (
          !this.disposed &&
          !this.root.isDestroyed &&
          this.promptSessionId === id &&
          fingerprint(this.prompt.draft) === sent
        ) {
          this.syncingDraft = true;
          this.prompt.value = "";
          this.syncingDraft = false;
        }

        this.publishDrafts();
        this.resizeComposer();
      }
    } finally {
      this.submitting.delete(id);
      this.changed();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.rememberScroll();
    this.disposed = true;
    this.renderer.off("resize", this.resize);
    this.renderer.removePostProcessFn(this.resizeComposer);
    this.renderer.removePostProcessFn(this.layoutBottomButton);
    this.promptHistories.clear();
    this.completion.dispose();
    this.prompt.dispose();
    this.runStatus.dispose();
    this.sessionStatus.dispose();
    this.transcript.dispose();
    this.sessions.dispose();
    this.children.dispose();
    this.prompt.off("resize", this.resizeComposer);
    this.prompt.off("line-info-change", this.resizeComposer);
    this.prompt.off(InputRenderableEvents.INPUT, this.handleDraftInput);
  }
}
