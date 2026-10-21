import {
  BoxRenderable, InputRenderableEvents, ScrollBoxRenderable,
  type CliRenderer, type Renderable,
} from "@opentui/core";
import type { ExecutionState } from "../session-registry.ts";
import type { Worktree } from "../../workspace/model.ts";
import { CapabilityError, InputError, type ExpectedError } from "../../errors.ts";
import { err, ok, type Result } from "../../result.ts";
import { uiTheme } from "../../ui/theme.ts";
import { EmptyState } from "../../ui/empty-state.ts";
import { icons } from "../../icons.ts";
import { TranscriptPanel, type TranscriptOptions } from "./transcript-panel.ts";
import { TranscriptBottomButton } from "./transcript-bottom-button.ts";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import type { FooterShortcut } from "../../ui/footer.ts";
import { bindPanelSpacing, panelSpacing } from "../../ui/spacing.ts";
import { SessionStatus } from "./session-status.ts";
import { RunStatus } from "./run-status.ts";
import { PromptInput } from "../../ui/prompt-input.ts";
import { expandPromptDraft, type PromptDraft } from "../prompt-input.ts";
import type { DialogContent } from "../../ui/text-dialog.ts";
import { CompletionMenu, type CompletionProvider } from "./completion-menu.ts";
import { SessionTabs } from "./session-tabs.ts";
import { SubagentSummary } from "./subagent-summary.ts";
import type { TranscriptImageProvider } from "../transcript-images.ts";
import { PendingMessages } from "./pending-messages.ts";
import { parseSessionControl } from "../session-controls.ts";
import { parseModelCommand } from "../model-selection.ts";
import { parseHistoryCommand } from "../history-command.ts";

export type AgentActions = {
  // Invoke onCreated only after the new session is observable in the workspace snapshot.
  onNewSession: (worktreeId: string, onCreated?: (sessionId: string) => void) => void;
  onHistory?: () => void;
  onModel?: (sessionId: string) => Result<void, ExpectedError>;
  onSelectSession?: (worktreeId: string, sessionId: string) => void;
  onCloseSession?: (worktreeId: string, sessionId: string) => void;
  onPrompt?: (sessionId: string, text: string, images?: readonly string[]) => Result<void, ExpectedError> | Promise<Result<void, ExpectedError>>;
  getSessionDetails?: (sessionId: string) => ExecutionState | null;
  onInterrupt?: (sessionId: string) => Promise<Result<void, ExpectedError>>;
  initialDrafts?: Readonly<Record<string, string>>;
  onDraftChange?: (drafts: Record<string, string>, inputs: Record<string, PromptDraft>) => void;
  initialInputDrafts?: Readonly<Record<string, PromptDraft>>;
  onInspectInput?: (content: DialogContent) => void;
  onCopyTranscript?: (text: string) => Promise<Result<string, ExpectedError>>;
  onComplete?: CompletionProvider;
  onImage?: TranscriptImageProvider;
};
type Button = (label: string, activate: () => void, actionLabel: string) => BoxRenderable;
type PanelOptions = Pick<TranscriptOptions, "initialViews" | "saveView" | "keyHint" | "initialPosition" | "emptyLogo"> & { readOnly?: boolean; idPrefix?: string; snapshotTime?: () => number | undefined };

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
  private readonly submitting = new Set<string>();
  private worktree: Worktree | null = null;
  private promptSessionId: string | null = null;
  private readonly conversations = new Map<string, string>();
  private syncingDraft = false;
  private disposed = false;
  private composerLayout = "";

  constructor(private readonly renderer: CliRenderer, private readonly actions: AgentActions, button: Button,
    private readonly notice: (message: string) => void, private readonly changed: () => void,
    private readonly focusSidebar: () => void, initialScroll: Readonly<Record<string, number>>,
    saveScroll: (sessionId: string, position: number) => void,
    private readonly transcriptOptions: PanelOptions = {}) {
    const theme = uiTheme(renderer);
    const id = (name: string) => `${transcriptOptions.idPrefix ?? ""}${name}`;
    this.root = new BoxRenderable(renderer, { id: id("agent-view"), onSizeChange: () => this.resizeComposer(),
      renderAfter: (buffer) => this.transcript.paintFocusGutter(buffer),
      flexGrow: 1, minHeight: 0, minWidth: 0, padding: 1, flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 1 });
    this.sessions = new SessionTabs(renderer, { button, changed,
      select: (id) => { if (this.worktree) actions.onSelectSession?.(this.worktree.id, id); },
      create: () => { if (this.worktree) actions.onNewSession(this.worktree.id); },
      ...(actions.onHistory ? { history: actions.onHistory } : {}),
      close: (id) => { if (this.worktree) actions.onCloseSession?.(this.worktree.id, id); },
      keyHint: (command, context) => transcriptOptions.keyHint?.(command, context) ?? "",
    });
    this.emptyState = new EmptyState(renderer, id("agent-empty-state"));
    this.root.add(this.sessions.root); this.root.add(this.emptyState.root);
    this.runtimePanel = new BoxRenderable(renderer, { width: "100%", flexGrow: 1, minHeight: 0, flexDirection: "column", gap: 0 });
    this.transcript = new TranscriptPanel(renderer, { notice, changed, focusPrompt: () => this.prompt.focus(), initialScroll, saveScroll, cacheSessions: true,
      ...transcriptOptions, ...(actions.onCopyTranscript ? { copy: actions.onCopyTranscript } : {}), ...(actions.onImage ? { image: actions.onImage } : {}) });
    this.transcriptScroll = this.transcript.scroll;
    this.transcriptScroll.id = id("session-transcript");
    // Hide the session scroll thumb; wheel, keys and the shared scroll model stay active.
    this.transcriptScroll.verticalScrollBar.visible = false;
    this.bottomButton = new TranscriptBottomButton(renderer, () => { renderer.clearSelection(); this.transcript.followLatest(); });
    this.runtimePanel.add(this.bottomButton);
    const interruptKey = () => transcriptOptions.readOnly ? "" : transcriptOptions.keyHint?.("agent.interrupt", "prompt") ?? "esc";
    this.runStatus = new RunStatus(renderer, interruptKey);
    this.pendingMessages = new PendingMessages(renderer, interruptKey);
    const transcriptArea = this.transcriptArea = new BoxRenderable(renderer, { id: id("agent-transcript-area"), width: "100%", flexGrow: 1, minHeight: 0, minWidth: 0, flexDirection: "column", overflow: "hidden" });
    transcriptArea.add(this.transcriptScroll);
    this.prompt = new PromptInput(renderer, notice, (content) => actions.onInspectInput?.(content), {
      id: id("session-prompt"), fieldId: id("agent-composer"), activityId: id("prompt-paste-loading"), readOnly: transcriptOptions.readOnly ?? false,
    });
    if (transcriptOptions.readOnly) this.prompt.placeholder = "Read-only preview · Open session to continue";
    for (const [id, draft] of Object.entries(actions.initialDrafts ?? {})) this.drafts.set(id, draft);
    for (const [id, draft] of Object.entries(actions.initialInputDrafts ?? {})) { this.inputDrafts.set(id, draft); this.drafts.set(id, expandPromptDraft(draft, false).text); }
    this.prompt.on(InputRenderableEvents.INPUT, this.handleDraftInput);
    const composer = this.composer = this.prompt.field;
    this.sessionStatus = new SessionStatus(renderer);
    this.sessionStatus.root.id = id("session-status");
    this.completion = new CompletionMenu(renderer, this.prompt, () => this.active ? this.promptSessionId : null, actions.onComplete,
      () => { this.resizeComposer(); changed(); }, () => this.completionRows());
    const statusRow = this.statusRow = new BoxRenderable(renderer, { id: id("transcript-status-row"), width: "100%", height: 1, visible: false, flexShrink: 0, flexDirection: "row", gap: 1 });
    this.children = new SubagentSummary(renderer);
    statusRow.add(this.runStatus.root); statusRow.add(this.children.root);
    this.root.on("resize", () => this.children.resize(this.root.width));
    // Keep completion and telemetry attached to the composer; only the three outer regions use gap.
    const inputArea = new BoxRenderable(renderer, { id: id("agent-input-area"), width: "100%", minWidth: 0, minHeight: 0, flexShrink: 0, flexDirection: "column" });
    inputArea.add(this.pendingMessages.root); inputArea.add(composer); inputArea.add(this.completion.root); inputArea.add(this.sessionStatus.root);
    this.runtimePanel.add(transcriptArea); this.runtimePanel.add(statusRow); this.runtimePanel.add(inputArea); this.root.add(this.runtimePanel);
    theme.scrollbars(this.transcriptScroll);
    bindPanelSpacing(renderer, this.root);
    this.prompt.on("resize", this.resizeComposer); this.prompt.on("line-info-change", this.resizeComposer);
    renderer.on("resize", this.resize);
    // Native public geometry settles after size callbacks. The signature-guarded
    // post-layout pass fits the editor/menu without creating a render loop.
    renderer.addPostProcessFn(this.resizeComposer); renderer.addPostProcessFn(this.layoutBottomButton); this.resize();
  }

  get promptDrafts(): Record<string, string> {
    const drafts = Object.fromEntries(this.drafts);
    if (!this.disposed && !this.prompt.isDestroyed && this.promptSessionId && this.prompt.value) drafts[this.promptSessionId] = this.prompt.legacyText;
    return drafts;
  }
  get promptInputDrafts(): Record<string, PromptDraft> {
    const drafts = structuredClone(Object.fromEntries(this.inputDrafts));
    if (!this.disposed && !this.prompt.isDestroyed && this.promptSessionId && this.prompt.value) drafts[this.promptSessionId] = this.prompt.draft;
    return drafts;
  }
  get active(): boolean { return this.runtimePanel.visible; }
  get resultVisible(): boolean { return this.active && this.transcript.latestVisible; }
  focusLatest(): void { this.transcript.followLatest(); this.focusTranscript(); }
  get sessionId(): string | null { return this.promptSessionId; }
  get canSubmit(): boolean { return !this.transcriptOptions.readOnly && Boolean(this.promptSessionId && this.prompt.value.trim() && !this.prompt.pending && !this.submitting.has(this.promptSessionId)); }
  get canInterrupt(): boolean {
    const details = this.promptSessionId ? this.actions.getSessionDetails?.(this.promptSessionId) : null;
    return !this.transcriptOptions.readOnly && this.active && !!this.actions.onInterrupt && (!!details?.pendingMessages?.length || details?.status === "working" || !!this.promptSessionId && this.submitting.has(this.promptSessionId));
  }
  get working(): boolean { return !!this.promptSessionId && this.actions.getSessionDetails?.(this.promptSessionId)?.status === "working"; }
  get transcriptShortcuts(): readonly FooterShortcut[] { return this.transcript.shortcuts; }
  get transcriptStatus(): string { return this.transcript.footerStatus; }
  get completionOpen(): boolean { return this.completion.engaged; }
  get sessionTabsFocused(): boolean { return this.root.visible && this.sessions.focused; }
  get sessionShortcuts(): readonly FooterShortcut[] { return this.sessions.shortcuts; }
  sessionAvailable(command: CommandId): boolean { return this.root.visible && this.sessions.available(command); }
  sessionCommand(command: CommandId): void { this.sessions.command(command); }
  completionAvailable(command: CommandId): boolean { return this.active && this.completion.available(command); }
  completionCommand(command: CommandId): void { this.completion.command(command); }
  transcriptContext(): KeyContext | null { return this.transcript.keyContext(); }
  focusTranscript(): void { this.completion.hide(); if (this.transcriptScroll.visible) this.transcript.focus(); }
  get transcriptFocused(): boolean { return this.transcript.focused; }
  transcriptAvailable(command: CommandId): boolean { return this.active && this.transcript.available(command); }
  transcriptCommand(command: CommandId): void { this.transcript.command(command); }
  get focusTargets(): Renderable[] {
    return this.root.visible ? [...this.sessions.focusTargets, ...(this.active ? [this.prompt, ...(this.transcriptScroll.visible ? [this.transcript.focusTarget] : [])] : [])] : [];
  }

  update(worktree: Worktree | null, selectedId: string | null, openIds: ReadonlySet<string>, visible: boolean): void {
    if (this.disposed || this.root.isDestroyed) return;
    this.rememberScroll();
    const tabsFocused = this.sessions.containsFocus;
    this.root.visible = visible; this.worktree = worktree;
    this.sessions.update(worktree?.id ?? null, this.transcriptOptions.readOnly ? [] : worktree?.sessions ?? [], selectedId, visible && !this.transcriptOptions.readOnly);
    const session = worktree?.sessions.find((item) => item.id === selectedId);
    const details = session ? this.actions.getSessionDetails?.(session.id) : null;
    const creationKey = worktree && !session && !this.transcriptOptions.readOnly ? this.sessions.creationShortcut : "";
    this.emptyState.update({ icon: icons.robot, title: session?.name ?? (worktree ? "No AI sessions" : "No workspace available"),
      description: worktree ? session ? `Workspace: ${worktree.name} · ${details ? details.error ?? details.status ?? "Ready" : "display preview only"}` : "" : "Open radian inside a Git repository.",
      ...(creationKey ? { action: { key: creationKey, label: "New session" } } : {}) });
    const sessionId = session?.id ?? null;
    const previousConversation = sessionId ? this.conversations.get(sessionId) : undefined;
    const replaced = !!details?.conversationId && previousConversation !== undefined && previousConversation !== details.conversationId;
    if (sessionId && details?.conversationId) this.conversations.set(sessionId, details.conversationId);
    if (replaced) this.completion.hide();
    const switchedSession = sessionId !== this.promptSessionId;
    if (switchedSession) {
      this.completion.hide();
      if (this.promptSessionId) this.saveDraft();
      this.promptSessionId = sessionId;
      this.prompt.setWorkingDirectory(worktree?.path ?? process.cwd());
      this.syncingDraft = true;
      const draft = sessionId ? this.inputDrafts.get(sessionId) : undefined;
      if (draft) {
        const restored = this.prompt.restore(draft);
        if (!restored.ok) { this.prompt.value = expandPromptDraft(draft, false).text; this.notice(`[${restored.error.code}] Attachment display could not be restored; original references were retained.`); }
      } else this.prompt.value = sessionId ? this.drafts.get(sessionId) ?? "" : "";
      this.syncingDraft = false;
    }
    for (const id of this.drafts.keys()) if (!openIds.has(id)) this.drafts.delete(id);
    for (const id of this.inputDrafts.keys()) if (!openIds.has(id)) this.inputDrafts.delete(id);
    this.runtimePanel.visible = Boolean(visible && session && (this.actions.onPrompt || this.transcriptOptions.readOnly));
    this.completion.prepare(sessionId, worktree?.path, openIds);
    this.runStatus.update(sessionId, details, this.active);
    this.pending = details?.pendingMessages ?? [];
    this.sessionStatus.update(details?.telemetry, this.active, worktree, this.transcriptOptions.snapshotTime?.());
    this.emptyState.root.visible = visible && !this.active;
    this.children.update(session?.subagents ?? [], this.active);
    this.root.gap = 0;
    this.root.alignItems = "stretch";
    this.root.justifyContent = "flex-start";
    const output = details?.output ?? "";
    const transcriptFocused = this.transcript.focused;
    this.transcript.update(sessionId, details?.sections, output, this.active, details?.conversationId);
    this.transcript.retainSessions(openIds);
    if (replaced && this.active && transcriptFocused) this.prompt.focus();
    if ((!this.active && (this.prompt.focused || transcriptFocused)) || (!this.sessions.root.visible && tabsFocused)) this.focusSidebar();
    if (!this.active) { this.completion.hide(); this.prompt.cancelPaste(); } else this.completion.refresh();
    this.resizeComposer();
    if (switchedSession) this.publishDrafts();
  }

  private resize = (): void => {
    if (this.disposed || this.root.isDestroyed) return;
    const { horizontal } = panelSpacing(this.renderer);
    this.runtimePanel.marginTop = 0;
    // Bleed the surface through the pane inset, keeping its text aligned with the other rows.
    this.resizeComposer();
    this.composer.marginX = -horizontal;
  };

  private resizeComposer = (): void => {
    if (this.disposed || !this.composer || !this.statusRow || this.prompt.isDestroyed) return;
    if (this.transcriptOptions.readOnly) {
      const compact = this.root.height < 8;
      this.sessionStatus.root.height = compact ? 1 : 3; this.sessionStatus.root.paddingY = compact ? 0 : 1;
    }
    const requested = this.prompt.requestedRows;
    const showStatus = this.runStatus.hasContent || this.children.hasContent;
    const menuRowsBeforeLayout = this.completion?.open ? this.completion.root.height : 0;
    const controls = (this.sessions.root.visible ? 1 : 0) + this.sessionStatus.root.height + (showStatus ? 1 : 0) + 1 + menuRowsBeforeLayout;
    this.pendingMessages.update(this.pending ?? [], this.active, Math.min(Math.floor(this.root.height / 3), Math.max(0, this.root.height - controls)));
    const signature = JSON.stringify([this.pendingMessages.rows, this.root.height, this.prompt.width, this.prompt.height, this.composer.height, this.sessions.root.visible,
      this.statusRows, this.layoutGap, this.transcriptArea.visible, showStatus, this.sessionStatus.root.height, requested, this.completion?.open, this.completion?.root.height]);
    if (signature === this.composerLayout) return;
    this.composerLayout = signature;
    const menuRows = this.completion?.open ? this.completion.root.height : 0;
    const fixedRows = (this.sessions.root.visible ? 1 : 0) + this.sessionStatus.root.height + menuRows + this.pendingMessages.rows;
    const statusRows = showStatus ? 1 : 0;
    // Reserve one prompt row and one conversation row before decorating their boundaries.
    const boundaries = 1 + statusRows;
    const gap = this.root.height >= fixedRows + statusRows + boundaries + 2 ? 1 : 0;
    if (this.statusRows !== statusRows || this.layoutGap !== gap) {
      this.transcript.prepareLayoutChange();
      this.statusRows = statusRows; this.statusRow.visible = showStatus;
      this.layoutGap = gap; this.runtimePanel.gap = gap;
    }
    const reserved = this.reservedRows(true) + menuRows;
    // The panel allocates space; the shared input alone fits its editor and decoration.
    const available = this.transcriptOptions.readOnly && this.root.height < 8 ? 1 : Math.max(1, this.root.height - reserved - 1);
    const { rows: lines, height } = this.prompt.measure(available);
    const showTranscript = this.root.height > reserved + height;
    if (this.transcriptScroll.visible !== showTranscript || this.transcriptArea.visible !== showTranscript) {
      this.transcript.prepareLayoutChange(); this.transcriptScroll.visible = this.transcriptArea.visible = showTranscript;
    }
    if (this.composer.height !== height || this.prompt.height !== lines) {
      this.transcript.prepareLayoutChange();
    }
    this.prompt.fit(available);
    this.completion?.reflow();
  };
  private layoutBottomButton = (): void => {
    if (this.disposed || this.root.isDestroyed) return;
    const viewport = this.transcriptScroll.viewport;
    // Reuse a parent-owned boundary gap, a padded status row, or the composer's top inset.
    const edge = viewport.y + viewport.height;
    const next = this.statusRow.visible ? this.statusRow : this.pendingMessages.rows ? this.pendingMessages.root : this.composer;
    const y = next.y > edge ? edge : this.statusRow.visible && this.statusRow.height === 3 ? this.statusRow.y
      : this.prompt.y > this.composer.y ? this.prompt.y - 1 : null;
    const space = y !== null && y >= viewport.y + viewport.height && y < this.runtimePanel.y + this.runtimePanel.height
      ? { left: viewport.x - this.runtimePanel.x, top: y - this.runtimePanel.y, width: viewport.width } : null;
    const hint = this.transcriptOptions.keyHint?.("transcript.latest", this.transcript.keyContext() ?? "transcript") ?? "";
    this.bottomButton.update(this.active && this.transcript.canFollowLatest, hint, space);
  };
  private reservedRows(transcript = this.transcriptArea.visible): number {
    const boundaries = (transcript ? 1 : 0) + (this.statusRows ? 1 : 0);
    return (this.sessions.root.visible ? 1 : 0) + this.statusRows + this.sessionStatus.root.height + this.pendingMessages.rows + this.layoutGap * boundaries;
  }
  private completionRows(): number {
    return Math.max(1, this.root.height - this.reservedRows() - this.composer.height);
  }
  private saveDraft(): void {
    if (!this.promptSessionId) return;
    if (this.prompt.value) { this.drafts.set(this.promptSessionId, this.prompt.legacyText); this.inputDrafts.set(this.promptSessionId, this.prompt.draft); }
    else { this.drafts.delete(this.promptSessionId); this.inputDrafts.delete(this.promptSessionId); }
  }
  private publishDrafts(): void {
    this.actions.onDraftChange?.(this.promptDrafts, this.promptInputDrafts);
  }
  rememberScroll = (): void => { this.transcript.rememberScroll(); };
  private handleDraftInput = (): void => {
    if (this.syncingDraft || !this.promptSessionId) return;
    this.saveDraft(); this.publishDrafts(); this.resizeComposer(); this.completion.refresh(); this.changed();
  };

  clearPrompt(): void { this.completion.hide(); this.prompt.clear(); }

  async interrupt(): Promise<void> {
    const id = this.promptSessionId;
    if (!id || !this.canInterrupt || !this.actions.onInterrupt) return;
    const result = await this.actions.onInterrupt(id);
    if (!result.ok) this.notice(`[${result.error.code}] ${result.error.message}`);
  }

  async submitPrompt(): Promise<void> {
    const id = this.promptSessionId;
    if (!id || !this.canSubmit || !this.actions.onPrompt) return;
    this.submitting.add(id); this.changed();
    try {
      const prepared = this.completion.prepareCommandSubmission();
      const ready = typeof prepared === "boolean" ? prepared : await prepared;
      if (!ready) return;
      if (this.disposed || this.root.isDestroyed || this.promptSessionId !== id || !this.active) return;
      this.completion.command("completion.dismiss");
      this.saveDraft();
      const draft = this.prompt.draft, submission = this.prompt.submission;
      const fingerprint = (value: PromptDraft | undefined) => value ? JSON.stringify([value.value, value.tokens]) : "";
      const sent = fingerprint(draft);
      const control = parseSessionControl(submission.text);
      if (!control.ok) { this.notice(`[${control.error.code}] ${control.error.message} · prompt retained`); return; }
      const model = parseModelCommand(submission.text);
      if (!model.ok) { this.notice(`[${model.error.code}] ${model.error.message} · prompt retained`); return; }
      const history = parseHistoryCommand(submission.text);
      if (!history.ok) { this.notice(`[${history.error.code}] ${history.error.message} · prompt retained`); return; }
      // Non-conversation actions must not reset the outgoing conversation's reading position.
      if (!model.value && !history.value && control.value?.action !== "new-tab" && control.value?.action !== "exit" && control.value?.action !== "reload") this.transcript.followLatest();
      let result: Result<void, ExpectedError>;
      if (history.value) {
        if (submission.images.length) result = err(new InputError("/history does not accept image attachments. Input was retained."));
        else if (!this.actions.onHistory) result = err(new CapabilityError("History is unavailable in this view. No prompt was sent."));
        else { this.actions.onHistory(); result = ok(undefined); }
      } else if (model.value) {
        result = submission.images.length ? err(new InputError("/model does not accept image attachments. Input was retained."))
          : this.actions.onModel?.(id) ?? err(new CapabilityError("Model selection is unavailable in this view. No prompt was sent."));
      } else result = await this.actions.onPrompt(id, submission.text, submission.images);
      if (!result.ok) { this.notice(`[${result.error.code}] ${result.error.message} · prompt retained`); return; }
      if (fingerprint(this.inputDrafts.get(id)) === sent) {
        this.drafts.delete(id); this.inputDrafts.delete(id);
        if (!this.disposed && !this.root.isDestroyed && this.promptSessionId === id && fingerprint(this.prompt.draft) === sent) {
          this.syncingDraft = true; this.prompt.value = ""; this.syncingDraft = false;
        }
        this.publishDrafts(); this.resizeComposer();
      }
    } finally { this.submitting.delete(id); this.changed(); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.rememberScroll(); this.disposed = true;
    this.renderer.off("resize", this.resize); this.renderer.removePostProcessFn(this.resizeComposer);
    this.renderer.removePostProcessFn(this.layoutBottomButton);
    this.completion.dispose(); this.prompt.dispose(); this.runStatus.dispose(); this.sessionStatus.dispose(); this.transcript.dispose(); this.sessions.dispose(); this.children.dispose();
    this.prompt.off("resize", this.resizeComposer); this.prompt.off("line-info-change", this.resizeComposer);
    this.prompt.off(InputRenderableEvents.INPUT, this.handleDraftInput);
  }
}
