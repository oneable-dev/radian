import {
  BoxRenderable, InputRenderable, InputRenderableEvents, ScrollBoxRenderable, TextAttributes, TextRenderable,
  type CliRenderer, type Renderable,
} from "@opentui/core";
import type { ExecutionState } from "../session-registry.ts";
import type { Worktree } from "../../workspace/model.ts";
import type { ExpectedError } from "../../errors.ts";
import type { Result } from "../../result.ts";
import { uiTheme } from "../../ui/theme.ts";
import { bindPanelSpacing, panelSpacing } from "../../ui/spacing.ts";

export type AgentActions = {
  onNewSession: (worktreeId: string) => void;
  onPrompt?: (sessionId: string, text: string) => Result<void, ExpectedError> | Promise<Result<void, ExpectedError>>;
  getSessionDetails?: (sessionId: string) => ExecutionState | null;
  initialDrafts?: Readonly<Record<string, string>>;
  onDraftChange?: (drafts: Record<string, string>) => void;
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
  private readonly transcript: TextRenderable;
  private readonly newButton: BoxRenderable;
  private readonly drafts = new Map<string, string>();
  private readonly submitting = new Set<string>();
  private readonly scrollPositions: Record<string, number>;
  private worktree: Worktree | null = null;
  private promptSessionId: string | null = null;
  private lastTranscriptKey = "";
  private syncingDraft = false;
  private pendingScroll: number | null = null;
  private syncingScroll = false;
  private disposed = false;

  constructor(private readonly renderer: CliRenderer, private readonly actions: AgentActions, button: Button,
    private readonly notice: (message: string) => void, private readonly changed: () => void,
    private readonly focusSidebar: () => void, initialScroll: Readonly<Record<string, number>>,
    private readonly saveScroll: (sessionId: string, position: number) => void) {
    const theme = uiTheme(renderer);
    this.scrollPositions = { ...initialScroll };
    this.root = new BoxRenderable(renderer, { id: "agent-view", flexGrow: 1, minHeight: 0, minWidth: 0, padding: 1, flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 1 });
    this.title = new TextRenderable(renderer, { content: "", height: 1, flexShrink: 0, wrapMode: "none", selectable: false, attributes: TextAttributes.BOLD });
    this.details = new TextRenderable(renderer, { content: "", height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    this.newButton = button("+ New session", () => { if (this.worktree) actions.onNewSession(this.worktree.id); }, "New session");
    this.root.add(this.title); this.root.add(this.details); this.root.add(this.newButton);
    this.runtimePanel = new BoxRenderable(renderer, { width: "100%", flexGrow: 1, minHeight: 0, marginTop: 1, flexDirection: "column", gap: 1 });
    this.transcriptScroll = new ScrollBoxRenderable(renderer, { id: "session-transcript", flexGrow: 1, minHeight: 0, scrollX: false,
      renderBefore: this.finishScroll });
    this.transcript = new TextRenderable(renderer, { width: "100%", content: "", wrapMode: "word", selectable: false });
    this.transcriptScroll.add(this.transcript);
    this.transcriptScroll.verticalScrollBar.on("change", this.rememberScroll);
    this.transcriptScroll.content.on("resize", this.applyScroll);
    this.transcriptScroll.viewport.on("resize", this.applyScroll);
    this.prompt = new InputRenderable(renderer, { id: "session-prompt", width: "100%", flexShrink: 0, placeholder: "Prompt · Enter to run" });
    for (const [id, draft] of Object.entries(actions.initialDrafts ?? {})) this.drafts.set(id, draft);
    this.prompt.on(InputRenderableEvents.INPUT, this.handleDraftInput);
    const composer = this.composer = new BoxRenderable(renderer, { id: "agent-composer", width: "100%", height: 3, flexShrink: 0,
      flexDirection: "row", alignItems: "center", paddingX: 1, gap: 1, border: ["left"] });
    const marker = new TextRenderable(renderer, { content: "›", height: 1, flexShrink: 0, selectable: false });
    this.prompt.width = "auto"; this.prompt.flexGrow = 1; this.prompt.minWidth = 0;
    composer.add(marker); composer.add(this.prompt);
    this.runtimePanel.add(this.transcriptScroll); this.runtimePanel.add(composer); this.root.add(this.runtimePanel);
    theme.input(this.prompt); theme.scrollbars(this.transcriptScroll); theme.focusBorder(composer);
    theme.bind(this.root, (colors) => {
      this.title.fg = colors.text; this.details.fg = colors.muted; this.transcript.fg = colors.text;
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
  get focusTargets(): Renderable[] {
    return [...(this.newButton.visible ? [this.newButton] : []), ...(this.active ? [this.prompt, this.transcriptScroll] : [])];
  }

  update(worktree: Worktree | null, selectedId: string | null, openIds: ReadonlySet<string>, visible: boolean): void {
    if (this.disposed || this.root.isDestroyed) return;
    this.rememberScroll();
    const returning = visible && !this.root.visible;
    this.root.visible = visible; this.worktree = worktree;
    const session = worktree?.sessions.find((item) => item.id === selectedId);
    this.title.content = session?.name ?? (worktree ? "No open sessions" : "No workspace available");
    const details = session ? this.actions.getSessionDetails?.(session.id) : null;
    this.details.content = worktree
      ? session ? `Workspace: ${worktree.name} · ${details ? details.error ?? details.status ?? "Ready" : "display preview only"}` : `Workspace: ${worktree.name} · create a session explicitly`
      : "Open radian inside a Git repository.";
    const sessionId = session?.id ?? null;
    const switchedSession = sessionId !== this.promptSessionId;
    if (switchedSession || returning) this.pendingScroll = sessionId ? this.scrollPositions[sessionId] ?? Infinity : 0;
    if (switchedSession) {
      if (this.promptSessionId) this.drafts.set(this.promptSessionId, this.prompt.value);
      this.promptSessionId = sessionId;
      this.syncingDraft = true;
      this.prompt.value = sessionId ? this.drafts.get(sessionId) ?? "" : "";
      this.syncingDraft = false;
    }
    for (const id of this.drafts.keys()) if (!openIds.has(id)) this.drafts.delete(id);
    this.runtimePanel.visible = Boolean(visible && session && this.actions.onPrompt);
    this.root.gap = this.active ? 0 : 1;
    this.root.alignItems = this.active ? "stretch" : "center";
    this.root.justifyContent = this.active ? "flex-start" : "center";
    const output = details?.output || "Enter a prompt to start this session explicitly.";
    const transcriptKey = `${sessionId ?? ""}\0${output}`;
    if (this.lastTranscriptKey !== transcriptKey) {
      this.lastTranscriptKey = transcriptKey;
      const atBottom = this.transcriptScroll.scrollTop >= this.transcriptScroll.scrollHeight - this.transcriptScroll.viewport.height - 1;
      this.transcript.content = output;
      if (!switchedSession && !returning && this.active && atBottom) this.pendingScroll = Infinity;
    }
    if (!this.active && this.prompt.focused) this.focusSidebar();
    this.newButton.visible = Boolean(visible && worktree && !session);
    this.applyScroll();
  }

  private resize = (): void => {
    if (this.disposed || this.root.isDestroyed) return;
    const { horizontal, vertical } = panelSpacing(this.renderer);
    this.runtimePanel.marginTop = vertical;
    this.runtimePanel.gap = vertical;
    this.composer.height = 1 + vertical * 2;
    this.composer.paddingX = horizontal;
  };

  rememberScroll = (): void => {
    if (this.disposed || this.root.isDestroyed || this.syncingScroll || this.pendingScroll !== null || !this.promptSessionId || !this.active) return;
    const position = Math.max(0, Math.round(this.transcriptScroll.scrollTop));
    if (this.scrollPositions[this.promptSessionId] === position) return;
    this.scrollPositions[this.promptSessionId] = position; this.saveScroll(this.promptSessionId, position);
  };
  private applyScroll = (): void => {
    if (this.disposed || this.root.isDestroyed || this.pendingScroll === null || !this.active) return;
    this.syncingScroll = true;
    try { this.transcriptScroll.scrollTo(this.pendingScroll); }
    finally { this.syncingScroll = false; }
  };
  private finishScroll = (): void => {
    if (!this.active) return;
    // Keep the target through layout resize rounds. A short previous transcript
    // must not clamp the next session's position before its first presentation.
    this.pendingScroll = null;
  };
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
    this.transcriptScroll.verticalScrollBar.off("change", this.rememberScroll);
    this.transcriptScroll.content.off("resize", this.applyScroll);
    this.transcriptScroll.viewport.off("resize", this.applyScroll);
    this.prompt.off(InputRenderableEvents.INPUT, this.handleDraftInput);
  }
}
