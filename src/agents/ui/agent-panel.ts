import {
  BoxRenderable, InputRenderable, InputRenderableEvents, ScrollBoxRenderable, TextAttributes, TextRenderable,
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
import { CompletionMenu, type CompletionProvider } from "./completion-menu.ts";
import { SessionTabs } from "./session-tabs.ts";
import { SubagentSummary } from "./subagent-summary.ts";

export type AgentActions = {
  onNewSession: (worktreeId: string) => void;
  onSelectSession?: (worktreeId: string, sessionId: string) => void;
  onCloseSession?: (worktreeId: string, sessionId: string) => void;
  onPrompt?: (sessionId: string, text: string) => Result<void, ExpectedError> | Promise<Result<void, ExpectedError>>;
  getSessionDetails?: (sessionId: string) => ExecutionState | null;
  initialDrafts?: Readonly<Record<string, string>>;
  onDraftChange?: (drafts: Record<string, string>) => void;
  onCopyTranscript?: (text: string) => Promise<Result<string, ExpectedError>>;
  onComplete?: CompletionProvider;
};
type Button = (label: string, activate: () => void, actionLabel: string) => BoxRenderable;

// Owns the Agent view, drafts and transcript viewport. The workbench supplies
// selection and visibility; it alone decides how this panel joins other features.
export class AgentPanel {
  readonly root: BoxRenderable;
  readonly prompt: InputRenderable;
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
  private readonly drafts = new Map<string, string>();
  private readonly submitting = new Set<string>();
  private worktree: Worktree | null = null;
  private promptSessionId: string | null = null;
  private syncingDraft = false;
  private disposed = false;

  constructor(private readonly renderer: CliRenderer, private readonly actions: AgentActions, button: Button,
    private readonly notice: (message: string) => void, private readonly changed: () => void,
    private readonly focusSidebar: () => void, initialScroll: Readonly<Record<string, number>>,
    saveScroll: (sessionId: string, position: number) => void,
    transcriptOptions: Pick<TranscriptOptions, "initialViews" | "saveView" | "keyHint"> = {}) {
    const theme = uiTheme(renderer);
    this.root = new BoxRenderable(renderer, { id: "agent-view", flexGrow: 1, minHeight: 0, minWidth: 0, padding: 1, flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 1 });
    this.title = new TextRenderable(renderer, { content: "", height: 1, flexShrink: 0, wrapMode: "none", selectable: false, attributes: TextAttributes.BOLD });
    this.details = new TextRenderable(renderer, { content: "", height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    this.sessions = new SessionTabs(renderer, { button, changed,
      select: (id) => { if (this.worktree) actions.onSelectSession?.(this.worktree.id, id); },
      create: () => { if (this.worktree) actions.onNewSession(this.worktree.id); },
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
    this.prompt = new InputRenderable(renderer, { id: "session-prompt", width: "100%", flexShrink: 0, placeholder: "Prompt · Enter to run" });
    for (const [id, draft] of Object.entries(actions.initialDrafts ?? {})) this.drafts.set(id, draft);
    this.prompt.on(InputRenderableEvents.INPUT, this.handleDraftInput);
    const composer = this.composer = new BoxRenderable(renderer, { id: "agent-composer", width: "100%", height: 3, flexShrink: 0,
      flexDirection: "row", alignItems: "center", paddingX: 1, gap: 1, border: ["left"] });
    const marker = new TextRenderable(renderer, { content: "›", height: 1, flexShrink: 0, selectable: false });
    this.prompt.width = "auto"; this.prompt.flexGrow = 1; this.prompt.minWidth = 0;
    composer.add(marker); composer.add(this.prompt);
    this.sessionStatus = new SessionStatus(renderer);
    this.completion = new CompletionMenu(renderer, this.prompt, () => this.active ? this.promptSessionId : null, actions.onComplete, changed);
    const statusRow = new BoxRenderable(renderer, { id: "transcript-status-row", width: "100%", height: 1, flexShrink: 0, flexDirection: "row", gap: 1 });
    this.transcript.status.flexGrow = 1; this.transcript.status.flexShrink = 1; this.transcript.status.minWidth = 0;
    this.children = new SubagentSummary(renderer);
    statusRow.add(this.transcript.status); statusRow.add(this.children.root);
    this.root.on("resize", () => this.children.resize(this.root.width));
    this.runtimePanel.add(this.transcriptScroll); this.runtimePanel.add(statusRow);
    this.runtimePanel.add(this.sessionStatus.root); this.runtimePanel.add(composer); this.runtimePanel.add(this.completion.root); this.root.add(this.runtimePanel);
    theme.input(this.prompt); theme.scrollbars(this.transcriptScroll); theme.focusBorder(composer);
    theme.bind(this.root, (colors) => {
      this.title.fg = colors.text; this.details.fg = colors.muted;
      composer.backgroundColor = colors.surface; marker.fg = colors.accent;
    });
    bindPanelSpacing(renderer, this.root);
    renderer.on("resize", this.resize); this.resize();
  }

  get promptDrafts(): Record<string, string> { return Object.fromEntries(this.drafts); }
  get active(): boolean { return this.runtimePanel.visible; }
  get sessionId(): string | null { return this.promptSessionId; }
  get canSubmit(): boolean { return Boolean(this.promptSessionId && this.prompt.value.trim() && !this.submitting.has(this.promptSessionId)); }
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
    const switchedSession = sessionId !== this.promptSessionId;
    if (switchedSession) {
      this.completion.hide();
      if (this.promptSessionId) this.drafts.set(this.promptSessionId, this.prompt.value);
      this.promptSessionId = sessionId;
      this.syncingDraft = true;
      this.prompt.value = sessionId ? this.drafts.get(sessionId) ?? "" : "";
      this.syncingDraft = false;
    }
    for (const id of this.drafts.keys()) if (!openIds.has(id)) this.drafts.delete(id);
    this.runtimePanel.visible = Boolean(visible && session && this.actions.onPrompt);
    this.sessionStatus.update(details?.telemetry, this.active);
    this.emptyPanel.visible = visible && !this.active;
    this.children.update(session?.subagents ?? [], this.active);
    this.root.gap = 0;
    this.root.alignItems = "stretch";
    this.root.justifyContent = "flex-start";
    const output = details?.output || "Enter a prompt to start this session explicitly.";
    const transcriptFocused = this.transcript.focused;
    this.transcript.update(sessionId, details?.sections, output, this.active);
    if ((!this.active && (this.prompt.focused || transcriptFocused)) || (!visible && tabsFocused)) this.focusSidebar();
    if (!this.active) this.completion.hide(); else this.completion.refresh();
  }

  private resize = (): void => {
    if (this.disposed || this.root.isDestroyed) return;
    const { horizontal, vertical } = panelSpacing(this.renderer);
    this.runtimePanel.marginTop = vertical;
    this.runtimePanel.gap = vertical;
    // The mode line, telemetry and composer share one full-width column and responsive gap.
    this.composer.height = 1 + vertical * 2;
    this.composer.paddingX = horizontal;
  };

  rememberScroll = (): void => { this.transcript.rememberScroll(); };
  private handleDraftInput = (): void => {
    if (this.syncingDraft || !this.promptSessionId) return;
    this.drafts.set(this.promptSessionId, this.prompt.value);
    this.actions.onDraftChange?.(this.promptDrafts); this.completion.refresh(); this.changed();
  };

  async submitPrompt(): Promise<void> {
    if (this.completionOpen) { this.completion.command("completion.accept"); return; }
    const id = this.promptSessionId;
    if (!id || !this.prompt.value.trim() || !this.actions.onPrompt || this.submitting.has(id)) return;
    const text = this.prompt.value;
    this.submitting.add(id); this.changed();
    try {
      const result = await this.actions.onPrompt(id, text);
      if (!result.ok) { this.notice(`[${result.error.code}] ${result.error.message} · prompt retained`); return; }
      if (this.drafts.get(id) === text) {
        this.drafts.delete(id);
        if (!this.disposed && !this.root.isDestroyed && this.promptSessionId === id && this.prompt.value === text) {
          this.syncingDraft = true; this.prompt.value = ""; this.syncingDraft = false;
        }
        this.actions.onDraftChange?.(this.promptDrafts);
      }
    } finally { this.submitting.delete(id); this.changed(); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.rememberScroll(); this.disposed = true;
    this.renderer.off("resize", this.resize);
    this.completion.dispose(); this.sessionStatus.dispose(); this.transcript.dispose(); this.sessions.dispose(); this.children.dispose();
    this.prompt.off(InputRenderableEvents.INPUT, this.handleDraftInput);
  }
}
