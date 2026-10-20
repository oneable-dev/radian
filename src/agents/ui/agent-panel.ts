import {
  BoxRenderable, InputRenderableEvents, ScrollBoxRenderable, TextAttributes, TextRenderable,
  type CliRenderer, type Renderable,
} from "@opentui/core";
import type { ExecutionState } from "../session-registry.ts";
import type { Worktree } from "../../workspace/model.ts";
import type { ExpectedError } from "../../errors.ts";
import type { Result } from "../../result.ts";
import { uiTheme } from "../../ui/theme.ts";
import { TranscriptPanel, type TranscriptOptions } from "./transcript-panel.ts";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import type { FooterShortcut } from "../../ui/footer.ts";
import { bindPanelSpacing, panelSpacing } from "../../ui/spacing.ts";
import { SessionStatus } from "./session-status.ts";
import { RequestHeading } from "./request-heading.ts";
import { PromptInput } from "./prompt-input.ts";
import { expandPromptDraft, type PromptDraft } from "../prompt-input.ts";
import type { DialogContent } from "../../ui/text-dialog.ts";
import { CompletionMenu, type CompletionProvider } from "./completion-menu.ts";
import { SessionTabs } from "./session-tabs.ts";
import { SubagentSummary } from "./subagent-summary.ts";

export type AgentActions = {
  onNewSession: (worktreeId: string) => void;
  onHistory?: () => void;
  onSelectSession?: (worktreeId: string, sessionId: string) => void;
  onCloseSession?: (worktreeId: string, sessionId: string) => void;
  onPrompt?: (sessionId: string, text: string, images?: readonly string[]) => Result<void, ExpectedError> | Promise<Result<void, ExpectedError>>;
  getSessionDetails?: (sessionId: string) => ExecutionState | null;
  initialDrafts?: Readonly<Record<string, string>>;
  onDraftChange?: (drafts: Record<string, string>, inputs: Record<string, PromptDraft>) => void;
  initialInputDrafts?: Readonly<Record<string, PromptDraft>>;
  onInspectInput?: (content: DialogContent) => void;
  onCopyTranscript?: (text: string) => Promise<Result<string, ExpectedError>>;
  onComplete?: CompletionProvider;
};
type Button = (label: string, activate: () => void, actionLabel: string) => BoxRenderable;

// Owns the Agent view, drafts and transcript viewport. The workbench supplies
// selection and visibility; it alone decides how this panel joins other features.
export class AgentPanel {
  readonly root: BoxRenderable;
  readonly prompt: PromptInput;
  readonly transcriptScroll: ScrollBoxRenderable;
  private readonly title: TextRenderable;
  private readonly details: TextRenderable;
  private readonly emptyPanel: BoxRenderable;
  private readonly sessions: SessionTabs;
  private readonly children: SubagentSummary;
  private readonly runtimePanel: BoxRenderable;
  private readonly composer: BoxRenderable;
  private readonly sessionStatus: SessionStatus;
  private readonly completion: CompletionMenu;
  private readonly transcript: TranscriptPanel;
  private readonly requestHeading: RequestHeading;
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
    transcriptOptions: Pick<TranscriptOptions, "initialViews" | "saveView" | "keyHint"> = {}) {
    const theme = uiTheme(renderer);
    this.root = new BoxRenderable(renderer, { id: "agent-view", onSizeChange: () => this.resizeComposer(), flexGrow: 1, minHeight: 0, minWidth: 0, padding: 1, flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 1 });
    this.title = new TextRenderable(renderer, { content: "", height: 1, flexShrink: 0, wrapMode: "none", selectable: false, attributes: TextAttributes.BOLD });
    this.details = new TextRenderable(renderer, { content: "", height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    this.sessions = new SessionTabs(renderer, { button, changed,
      select: (id) => { if (this.worktree) actions.onSelectSession?.(this.worktree.id, id); },
      create: () => { if (this.worktree) actions.onNewSession(this.worktree.id); },
      ...(actions.onHistory ? { history: actions.onHistory } : {}),
      close: (id) => { if (this.worktree) actions.onCloseSession?.(this.worktree.id, id); },
      keyHint: (command, context) => transcriptOptions.keyHint?.(command, context) ?? "",
    });
    this.emptyPanel = new BoxRenderable(renderer, { width: "100%", flexGrow: 1, minHeight: 0,
      flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 1 });
    this.emptyPanel.add(this.title); this.emptyPanel.add(this.details);
    this.root.add(this.sessions.root); this.root.add(this.emptyPanel);
    this.runtimePanel = new BoxRenderable(renderer, { width: "100%", flexGrow: 1, minHeight: 0, marginTop: 1, flexDirection: "column", gap: 1 });
    this.transcript = new TranscriptPanel(renderer, { notice, changed, focusPrompt: () => this.prompt.focus(), initialScroll, saveScroll,
      ...transcriptOptions, ...(actions.onCopyTranscript ? { copy: actions.onCopyTranscript } : {}) });
    this.transcriptScroll = this.transcript.scroll;
    this.requestHeading = new RequestHeading(renderer);
    const transcriptArea = new BoxRenderable(renderer, { id: "agent-transcript-area", width: "100%", flexGrow: 1, minHeight: 0, minWidth: 0, flexDirection: "column" });
    transcriptArea.add(this.requestHeading.root); transcriptArea.add(this.transcriptScroll);
    this.prompt = new PromptInput(renderer, notice, (content) => actions.onInspectInput?.(content));
    for (const [id, draft] of Object.entries(actions.initialDrafts ?? {})) this.drafts.set(id, draft);
    for (const [id, draft] of Object.entries(actions.initialInputDrafts ?? {})) { this.inputDrafts.set(id, draft); this.drafts.set(id, expandPromptDraft(draft, false).text); }
    this.prompt.on(InputRenderableEvents.INPUT, this.handleDraftInput);
    const composer = this.composer = new BoxRenderable(renderer, { id: "agent-composer", width: "auto", height: 3, flexShrink: 0,
      flexDirection: "row", alignItems: "center", border: ["left"] });
    composer.add(this.prompt);
    this.sessionStatus = new SessionStatus(renderer);
    this.completion = new CompletionMenu(renderer, this.prompt, () => this.active ? this.promptSessionId : null, actions.onComplete,
      () => { this.resizeComposer(); changed(); }, () => this.completionRows());
    const statusRow = new BoxRenderable(renderer, { id: "transcript-status-row", width: "100%", height: 1, flexShrink: 0, flexDirection: "row", gap: 1 });
    this.transcript.status.flexGrow = 1; this.transcript.status.flexShrink = 1; this.transcript.status.minWidth = 0;
    this.children = new SubagentSummary(renderer);
    statusRow.add(this.transcript.status); statusRow.add(this.prompt.activity.root); statusRow.add(this.children.root);
    this.root.on("resize", () => this.children.resize(this.root.width));
    this.runtimePanel.add(transcriptArea); this.runtimePanel.add(statusRow);
    this.runtimePanel.add(this.sessionStatus.root); this.runtimePanel.add(composer); this.runtimePanel.add(this.completion.root); this.root.add(this.runtimePanel);
    theme.input(this.prompt); theme.scrollbars(this.transcriptScroll); theme.focusBorder(composer);
    theme.bind(this.root, (colors) => {
      this.title.fg = colors.text; this.details.fg = colors.muted;
      composer.backgroundColor = colors.surface;
      this.prompt.focusedBackgroundColor = colors.surface;
    });
    bindPanelSpacing(renderer, this.root);
    this.prompt.on("resize", this.resizeComposer); this.prompt.on("line-info-change", this.resizeComposer);
    renderer.on("resize", this.resize);
    // Native public geometry settles after size callbacks. The signature-guarded
    // post-layout pass fits the editor/menu without creating a render loop.
    renderer.addPostProcessFn(this.resizeComposer); this.resize();
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
  get sessionId(): string | null { return this.promptSessionId; }
  get canSubmit(): boolean { return Boolean(this.promptSessionId && this.prompt.value.trim() && !this.prompt.pending && !this.submitting.has(this.promptSessionId)); }
  get working(): boolean { return !!this.promptSessionId && this.actions.getSessionDetails?.(this.promptSessionId)?.status === "working"; }
  get transcriptShortcuts(): readonly FooterShortcut[] { return this.transcript.shortcuts; }
  get completionOpen(): boolean { return this.completion.engaged; }
  get sessionTabsFocused(): boolean { return this.root.visible && this.sessions.focused; }
  get sessionShortcuts(): readonly FooterShortcut[] { return this.sessions.shortcuts; }
  sessionAvailable(command: CommandId): boolean { return this.root.visible && this.sessions.available(command); }
  sessionCommand(command: CommandId): void { this.sessions.command(command); }
  completionAvailable(command: CommandId): boolean { return this.active && this.completion.available(command); }
  completionCommand(command: CommandId): void { this.completion.command(command); }
  transcriptContext(): KeyContext | null { return this.transcript.keyContext(); }
  focusTranscript(): void { this.transcript.focus(); }
  transcriptAvailable(command: CommandId): boolean { return this.active && this.transcript.available(command); }
  transcriptCommand(command: CommandId): void { this.transcript.command(command); }
  get focusTargets(): Renderable[] {
    return this.root.visible ? [...this.sessions.focusTargets, ...(this.active ? [this.prompt, this.transcript.focusTarget] : [])] : [];
  }

  update(worktree: Worktree | null, selectedId: string | null, openIds: ReadonlySet<string>, visible: boolean): void {
    if (this.disposed || this.root.isDestroyed) return;
    this.rememberScroll();
    const tabsFocused = this.sessions.containsFocus;
    this.root.visible = visible; this.worktree = worktree;
    this.sessions.update(worktree?.id ?? null, worktree?.sessions ?? [], selectedId, visible);
    const session = worktree?.sessions.find((item) => item.id === selectedId);
    this.title.content = session?.name ?? (worktree ? "No open sessions" : "No workspace available");
    const details = session ? this.actions.getSessionDetails?.(session.id) : null;
    this.details.content = worktree
      ? session ? `Workspace: ${worktree.name} · ${details ? details.error ?? details.status ?? "Ready" : "display preview only"}` : `Workspace: ${worktree.name} · create a session explicitly`
      : "Open radian inside a Git repository.";
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
    this.runtimePanel.visible = Boolean(visible && session && this.actions.onPrompt);
    this.requestHeading.update(details?.sections, this.active);
    this.sessionStatus.update(details?.telemetry, this.active);
    this.emptyPanel.visible = visible && !this.active;
    this.children.update(session?.subagents ?? [], this.active);
    this.root.gap = 0;
    this.root.alignItems = "stretch";
    this.root.justifyContent = "flex-start";
    const output = details?.output || "Enter a prompt to start this session explicitly.";
    const transcriptFocused = this.transcript.focused;
    this.transcript.update(sessionId, details?.sections, output, this.active, details?.conversationId);
    if (replaced && this.active && transcriptFocused) this.prompt.focus();
    if ((!this.active && (this.prompt.focused || transcriptFocused)) || (!visible && tabsFocused)) this.focusSidebar();
    if (!this.active) { this.completion.hide(); this.prompt.cancelPaste(); } else this.completion.refresh();
    this.resizeComposer();
    if (switchedSession) this.publishDrafts();
  }

  private resize = (): void => {
    if (this.disposed || this.root.isDestroyed) return;
    const { horizontal } = panelSpacing(this.renderer);
    this.runtimePanel.marginTop = 0;
    this.runtimePanel.gap = 0;
    // Bleed the surface through the pane inset, keeping its text aligned with the other rows.
    this.resizeComposer();
    this.composer.marginX = -horizontal;
    this.composer.paddingLeft = horizontal - 1; // The left focus border occupies one cell of the inset.
    this.composer.paddingRight = horizontal;
  };

  private resizeComposer = (): void => {
    if (this.disposed || !this.composer || this.prompt.isDestroyed) return;
    const requested = Math.max(this.prompt.lineCount, this.prompt.editorView.getTotalVirtualLineCount());
    const signature = JSON.stringify([this.root.height, this.prompt.width, this.prompt.height, this.composer.height, this.sessions.root.visible,
      this.requestHeading.root.visible, requested, this.completion?.open, this.completion?.root.height]);
    if (signature === this.composerLayout) return;
    this.composerLayout = signature;
    const menuRows = this.completion?.open ? this.completion.root.height : 0;
    const statusRows = 2, paddingRows = 2;
    const reserved = (this.sessions.root.visible ? 1 : 0) + (this.requestHeading.root.visible ? 1 : 0) + statusRows + paddingRows + menuRows;
    // Preserve a conversation row when possible; temporary menus may use the last one.
    const capacity = Math.max(1, this.root.height - reserved - 1);
    const lines = Math.max(1, Math.min(6, capacity, requested));
    const height = lines + 2;
    if (this.composer.height !== height || this.prompt.height !== lines) {
      this.transcript.prepareLayoutChange();
      this.prompt.height = lines; this.composer.height = height;
    }
    this.completion?.reflow();
  };
  private completionRows(): number {
    return Math.max(1, this.root.height - (this.sessions.root.visible ? 1 : 0) - (this.requestHeading.root.visible ? 1 : 0) - 2 - this.composer.height);
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

  async submitPrompt(): Promise<void> {
    if (this.completionOpen) { this.completion.command("completion.accept"); return; }
    const id = this.promptSessionId;
    if (!id || !this.canSubmit || !this.actions.onPrompt) return;
    this.saveDraft();
    const draft = this.prompt.draft, submission = this.prompt.submission;
    const fingerprint = (value: PromptDraft | undefined) => value ? JSON.stringify([value.value, value.tokens]) : "";
    const sent = fingerprint(draft);
    this.submitting.add(id); this.transcript.followLatest(); this.changed();
    try {
      const result = await this.actions.onPrompt(id, submission.text, submission.images);
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
    this.completion.dispose(); this.prompt.dispose(); this.sessionStatus.dispose(); this.transcript.dispose(); this.sessions.dispose(); this.children.dispose();
    this.prompt.off("resize", this.resizeComposer); this.prompt.off("line-info-change", this.resizeComposer);
    this.prompt.off(InputRenderableEvents.INPUT, this.handleDraftInput);
  }
}
