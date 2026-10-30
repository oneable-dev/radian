import { type CliRenderer, type Renderable, type ScrollBoxRenderable } from "@opentui/core";
import type { SessionCollection } from "./session-collection.ts";
import type { ExecutionState } from "../session-registry.ts";
import type { PromptDraft } from "../prompt-input.ts";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import type { Notice } from "../../ui/messages.ts";
import type { TranscriptImageProvider } from "../transcript-images.ts";
import { Button } from "../../ui/button.ts";
import { PopupBody } from "../../ui/popup-layout.ts";
import { AgentPanel } from "./agent-panel.ts";

type Actions = {
  notice: Notice;
  changed(): void;
  focusList(): void;
  keyHint(command: CommandId, context: KeyContext): string;
  details?(id: string): ExecutionState | null;
  image?: TranscriptImageProvider;
};

// Previews share the entire session renderer. Only interaction and persistence are detached.
export class SessionPreview {
  readonly panel: AgentPanel;
  readonly body: PopupBody;
  readonly transcript: ScrollBoxRenderable;
  private state: ExecutionState | null = null;
  private sessionId: string | null = null;
  private capturedAt: number | undefined;
  private focusPending = false;

  constructor(
    private readonly renderer: CliRenderer,
    id: string,
    actions: Actions,
  ) {
    this.panel = new AgentPanel(
      renderer,
      {
        onNewSession() {},
        getSessionDetails: (sessionId) =>
          sessionId === this.sessionId ? this.state : (actions.details?.(sessionId) ?? null),
        ...(actions.image ? { onImage: actions.image } : {}),
      },
      (label, activate) => new Button(renderer, label, activate),
      actions.notice,
      () => actions.changed(),
      () => actions.focusList(),
      {},
      () => {},
      {
        readOnly: true,
        idPrefix: `${id}-preview-`,
        initialPosition: "end",
        keyHint: (command, context) => actions.keyHint(command, context),
        snapshotTime: () => this.capturedAt,
      },
    );
    this.panel.update(null, null, new Set(), false);
    this.transcript = this.panel.transcriptScroll;
    this.transcript.id = `${id}-preview`;
    this.body = new PopupBody(renderer, `${id}-preview-pane`, this.panel.root);
    this.body.root.focusable = true;
    this.body.root.onMouseDown = (event) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      this.focusTarget.focus();
    };
    renderer.addPostProcessFn(this.focusReady);
  }

  get focusTarget(): Renderable {
    return this.panel.root.visible && this.transcript.visible ? this.transcript : this.body.root;
  }

  get focused(): boolean {
    return this.body.root.focused || this.panel.root.hasFocusedDescendant;
  }

  show(
    worktree: SessionCollection,
    sessionId: string,
    state: ExecutionState,
    visible: boolean,
    capturedAt?: number,
    draft?: PromptDraft | string,
  ): void {
    this.focusPending ||= visible && this.body.root.focused;
    this.sessionId = sessionId;
    this.state = state;
    this.capturedAt = capturedAt;
    this.body.showEmpty();
    this.panel.update(
      worktree,
      sessionId,
      new Set(worktree.sessions.map((session) => session.id)),
      visible,
    );
    this.panel.showPreviewDraft(draft);
  }

  empty(message: string, visible: boolean): void {
    const focused = this.focused;
    this.state = null;
    this.sessionId = null;
    this.capturedAt = undefined;
    this.focusPending = false;
    this.panel.update(null, null, new Set(), false);
    this.body.showEmpty(message);
    if (focused && visible) {
      this.body.root.focus();
    }
  }

  hide(): void {
    this.focusPending = false;
    this.panel.update(null, null, new Set(), false);
    this.state = null;
    this.sessionId = null;
    this.capturedAt = undefined;
  }

  private focusReady = (): void => {
    if (!this.focusPending || !this.body.root.visible || !this.panel.root.visible) {
      return;
    }

    this.focusPending = false;
    if (this.body.root.focused || !this.renderer.currentFocusedRenderable) {
      this.focusTarget.focus();
    }
  };

  dispose(): void {
    this.renderer.removePostProcessFn(this.focusReady);
    this.panel.dispose();
  }
}
