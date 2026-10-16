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

export type AgentActions = {
  onNewSession: (worktreeId: string) => void;
  onPrompt?: (sessionId: string, text: string) => Result<void, ExpectedError> | Promise<Result<void, ExpectedError>>;
  getSessionDetails?: (sessionId: string) => ExecutionState | null;
  initialDrafts?: Readonly<Record<string, string>>;
  onDraftChange?: (drafts: Record<string, string>) => void;
  onCopyTranscript?: (text: string) => Promise<Result<string, ExpectedError>>;
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
  private readonly runtimePanel: BoxRenderable;
  private readonly composer: BoxRenderable;
  private readonly sessionStatus: SessionStatus;
  private readonly transcript: TranscriptPanel;
  private readonly newButton: BoxRenderable;
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
    this.newButton = button("+ New session", () => { if (this.worktree) actions.onNewSession(this.worktree.id); }, "New session");
    this.root.add(this.title); this.root.add(this.details); this.root.add(this.newButton);
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
    this.runtimePanel.add(this.transcriptScroll); this.runtimePanel.add(this.transcript.status);
    this.runtimePanel.add(this.sessionStatus.root); this.runtimePanel.add(composer); this.root.add(this.runtimePanel);
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
  transcriptContext(): KeyContext | null { return this.transcript.keyContext(); }
  focusTranscript(): void { this.transcript.focus(); }
  transcriptAvailable(command: CommandId): boolean { return this.active && this.transcript.available(command); }
  transcriptCommand(command: CommandId): void { this.transcript.command(command); }
  get focusTargets(): Renderable[] {
    return [...(this.newButton.visible ? [this.newButton] : []), ...(this.active ? [this.prompt, this.transcript.focusTarget] : [])];
  }

  update(worktree: Worktree | null, selectedId: string | null, openIds: ReadonlySet<string>, visible: boolean): void {
    if (this.disposed || this.root.isDestroyed) return;
    this.rememberScroll();
    this.root.visible = visible; this.worktree = worktree;
    const session = worktree?.sessions.find((item) => item.id === selectedId);
    this.title.content = session?.name ?? (worktree ? "No open sessions" : "No workspace available");
    const details = session ? this.actions.getSessionDetails?.(session.id) : null;
    this.details.content = worktree
      ? session ? `Workspace: ${worktree.name} · ${details ? details.error ?? details.status ?? "Ready" : "display preview only"}` : `Workspace: ${worktree.name} · create a session explicitly`
      : "Open radian inside a Git repository.";
    const sessionId = session?.id ?? null;
    const switchedSession = sessionId !== this.promptSessionId;
    if (switchedSession) {
      if (this.promptSessionId) this.drafts.set(this.promptSessionId, this.prompt.value);
      this.promptSessionId = sessionId;
      this.syncingDraft = true;
      this.prompt.value = sessionId ? this.drafts.get(sessionId) ?? "" : "";
      this.syncingDraft = false;
    }
    for (const id of this.drafts.keys()) if (!openIds.has(id)) this.drafts.delete(id);
    this.runtimePanel.visible = Boolean(visible && session && this.actions.onPrompt);
    this.sessionStatus.update(details?.telemetry, this.active);
    this.root.gap = this.active ? 0 : 1;
    this.root.alignItems = this.active ? "stretch" : "center";
    this.root.justifyContent = this.active ? "flex-start" : "center";
    const output = details?.output || "Enter a prompt to start this session explicitly.";
    const transcriptFocused = this.transcript.focused;
    this.transcript.update(sessionId, details?.sections, output, this.active);
    if (!this.active && (this.prompt.focused || transcriptFocused)) this.focusSidebar();
    this.newButton.visible = Boolean(visible && worktree && !session);
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
    this.actions.onDraftChange?.(this.promptDrafts); this.changed();
  };

  async submitPrompt(): Promise<void> {
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
    this.sessionStatus.dispose(); this.transcript.dispose();
    this.prompt.off(InputRenderableEvents.INPUT, this.handleDraftInput);
  }
}
