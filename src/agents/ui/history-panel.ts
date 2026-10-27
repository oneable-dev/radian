import {
  BoxRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
  type Renderable,
} from "@opentui/core";
import type { HistoryItem } from "../history.ts";
import type { HistoryPreview } from "../history-preview.ts";
import { HistoryPreviewCache, type PreviewState } from "../history-preview-cache.ts";
import { SearchInput } from "../../ui/search-input.ts";
import type { Worktree } from "../../workspace/model.ts";
import { reportUnexpected, type ExpectedError } from "../../errors.ts";
import type { Result } from "../../result.ts";
import type { FooterShortcut } from "../../ui/footer.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import { footerKeyHint } from "../../keybindings/footer.ts";
import type { Notice } from "../../ui/messages.ts";
import { uiTheme } from "../../ui/theme.ts";
import { PopupFrame } from "../../ui/popup-frame.ts";
import { POPUP_SIZES, SearchPopupLayout, centerPopup } from "../../ui/popup-layout.ts";
import { paintText } from "../../ui/theme-styles.ts";
import { SessionPreview } from "./session-preview.ts";
import type { PromptDraft } from "../prompt-input.ts";
import type { TranscriptImageProvider } from "../transcript-images.ts";
import type { ExecutionState, SessionRecord } from "../session-registry.ts";
import { halfPageStep } from "../../ui/navigation.ts";
import type { TranscriptSection } from "../transcript.ts";
import { createTextMatcher } from "../../search.ts";

export type HistoryActions = {
  list?: (
    worktreeId: string,
    signal?: AbortSignal,
    refresh?: boolean,
  ) => Promise<Result<readonly HistoryItem[], ExpectedError>>;
  cached?: (worktreeId: string) => Result<readonly HistoryItem[], ExpectedError> | undefined;
  previews?: HistoryPreviewCache;
  preview?: (
    worktreeId: string,
    savedId: string,
    signal?: AbortSignal,
  ) => Promise<Result<HistoryPreview, ExpectedError>>;
  resume?: (worktreeId: string, savedId: string) => Promise<Result<string, ExpectedError>>;
  onOpened: (worktreeId: string, sessionId: string) => void;
  onError: Notice;
  onCloseFallback?: () => void;
  onChange?: () => void;
  keyHint: (command: CommandId, context: KeyContext) => string;
  details?: (id: string) => ExecutionState | null;
  draft?: (id: string) => PromptDraft | string | undefined;
  image?: TranscriptImageProvider;
};

// The popup owns only a query and a candidate cursor. Canonical session selection changes on Open.
export class SessionHistoryPanel {
  readonly root: BoxRenderable;
  readonly search: SearchInput;
  readonly list: ScrollBoxRenderable;
  readonly preview: ScrollBoxRenderable;
  private readonly panel: BoxRenderable;
  private readonly body: BoxRenderable;
  private readonly layout: SearchPopupLayout;
  private readonly listStatus: BoxRenderable;
  private readonly spinner: LoadingSpinner;
  private readonly previewCache: HistoryPreviewCache;
  private readonly unsubscribePreviews: (() => void) | undefined;
  private readonly message: TextRenderable;
  private readonly previewPane: BoxRenderable;
  private readonly session: SessionPreview;
  private readonly rows: BoxRenderable[] = [];
  private items: readonly HistoryItem[] = [];
  private filtered: readonly HistoryItem[] = [];
  private worktree: Worktree | null = null;
  private owner: Renderable | undefined;
  private cursor = 0;
  private generation = 0;
  private previewIdentity: string | undefined;
  private previewState: PreviewState | undefined;
  private loadRequest: AbortController | undefined;
  private resuming = false;
  private loading = false;
  private loadError: string | undefined;
  private compactPreview = false;
  private previewLoading = false;
  private disposed = false;
  private readonly listenerBudget: number;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly actions: HistoryActions,
  ) {
    // The list and shared session surface own native scroll/layout subscriptions.
    this.listenerBudget = renderer.getMaxListeners() === 0 ? 0 : 8;
    if (this.listenerBudget)
      renderer.setMaxListeners(renderer.getMaxListeners() + this.listenerBudget);
    const theme = uiTheme(renderer);
    this.root = new BoxRenderable(renderer, {
      id: "session-history",
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      zIndex: 5000,
      visible: false,
      onMouseDown: (event) => {
        event.stopPropagation();
      },
      onMouseScroll: (event) => event.stopPropagation(),
    });
    this.panel = new PopupFrame(renderer, {
      id: "history-dialog",
      position: "absolute",
      border: false,
      paddingX: 0,
      flexDirection: "column",
      minWidth: 0,
      minHeight: 0,
    });
    this.spinner = new LoadingSpinner(renderer, { id: "history-loading" });
    this.search = new SearchInput(renderer, { id: "history-search", title: "History" });
    this.message = new TextRenderable(renderer, {
      id: "history-message",
      content: "",
      height: 1,
      flexGrow: 1,
      minWidth: 0,
      wrapMode: "none",
      selectable: false,
    });
    this.listStatus = new BoxRenderable(renderer, {
      id: "history-list-status",
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      gap: 1,
    });
    // Collapse completed loading feedback before layout so it leaves no blank row.
    this.listStatus.onLifecyclePass = () => {
      this.listStatus.visible = this.message.visible || this.spinner.root.visible;
    };
    this.listStatus.add(this.spinner.root);
    this.listStatus.add(this.message);
    this.list = new ScrollBoxRenderable(renderer, {
      id: "history-list",
      width: "100%",
      flexGrow: 1,
      minHeight: 0,
      minWidth: 0,
      scrollX: false,
      contentOptions: { flexDirection: "column" },
      onMouseDown: () => this.list.focus(),
    });
    this.session = new SessionPreview(renderer, "history", {
      notice: actions.onError,
      changed: () => actions.onChange?.(),
      focusList: () => this.search.focus(),
      keyHint: actions.keyHint,
      ...(actions.details ? { details: actions.details } : {}),
      ...(actions.image ? { image: actions.image } : {}),
    });
    this.previewCache =
      actions.previews ??
      new HistoryPreviewCache(
        (tree, id, signal) => actions.preview!(tree, id, signal),
        () => this.renderPreview(),
        (error) => reportUnexpected(error, "history preview"),
      );
    this.unsubscribePreviews = actions.previews?.subscribe(() => {
      const item = this.selected;
      if (
        item &&
        this.worktree &&
        this.previewCache.read(this.worktree.id, item.id) !== this.previewState
      )
        this.renderPreview();
    });
    this.preview = this.session.transcript;
    this.previewPane = this.session.body.root;
    this.layout = new SearchPopupLayout(renderer, {
      id: "history",
      search: this.search,
      message: this.listStatus,
      list: this.list,
      preview: { body: this.session.body, width: 58 },
    });
    this.body = this.layout.root;
    this.panel.add(this.body);
    this.root.add(this.panel);
    theme.scrollbars(this.list);
    theme.bindStyles(this.root, (styles) => {
      this.root.backgroundColor = styles["ui.backdrop"].bg;
      this.panel.backgroundColor = styles["ui.popup"].bg;
      paintText(this.message, styles["ui.muted"]);
      this.previewPane.borderColor = styles["ui.border"].fg;
      paintText(this.spinner.root, styles["status.working"]);
      this.paint();
    });
    this.search.on(InputRenderableEvents.INPUT, this.filter);
    renderer.on("resize", this.resize);
    this.resize();
  }

  get visible(): boolean {
    return this.root.visible && !this.disposed && !this.root.isDestroyed;
  }
  get context(): KeyContext {
    return this.search.focused ? "history-search" : "history";
  }
  private get previewTarget(): Renderable {
    return this.session.focusTarget;
  }
  get focusTargets(): Renderable[] {
    return [
      this.search,
      ...(this.list.visible ? [this.list] : []),
      ...(this.previewPane.visible ? [this.previewTarget] : []),
    ];
  }
  get shortcuts(): readonly FooterShortcut[] {
    const hint = (command: Extract<CommandId, `history.${string}`>, label: string) => ({
      key: footerKeyHint(command, this.context, this.actions.keyHint(command, this.context)),
      label,
    });
    return [
      ...(this.selected &&
      !this.selected.unavailableReason &&
      this.actions.resume &&
      !this.resuming &&
      !this.loading
        ? [hint("history.open", "Open")]
        : []),
      hint("history.dismiss", "Close"),
      hint("history.preview", "Preview"),
      hint("history.previous", "Previous"),
      hint("history.next", "Next"),
      hint("history.refresh", "Refresh"),
      hint("history.half-page-down", "½ page"),
    ].filter((item) => item.key);
  }
  private get selected(): HistoryItem | undefined {
    return this.filtered[this.cursor];
  }

  show(worktree: Worktree | null): void {
    if (this.disposed || this.root.isDestroyed) return;
    if (this.visible) {
      this.search.focus();
      return;
    }
    this.owner = this.renderer.currentFocusedRenderable ?? undefined;
    this.worktree = worktree;
    this.compactPreview = false;
    this.root.visible = true;
    this.items = [];
    this.filtered = [];
    this.loadError = undefined;
    this.search.value = "";
    this.filter();
    this.resize();
    this.search.focus();
    const cached = worktree ? this.actions.cached?.(worktree.id) : undefined;
    if (cached) this.accept(cached);
    else this.launch(() => this.refresh());
  }
  updateData(): void {
    if (!this.visible || !this.worktree || this.loading || this.resuming) return;
    const cached = this.actions.cached?.(this.worktree.id);
    if (cached && (!cached.ok || cached.value !== this.items)) this.accept(cached);
  }
  private accept(result: Result<readonly HistoryItem[], ExpectedError>): void {
    this.loadError = result.ok
      ? undefined
      : `[${result.error.code}] History error: ${result.error.message}`;
    this.items = result.ok ? result.value : [];
    this.filter();
  }
  hide(restoreFocus = true): void {
    if (!this.visible) return;
    this.generation++;
    this.loading = false;
    this.cancelPreview();
    this.loadRequest?.abort();
    this.spinner.cancel();
    this.updatePreview(null, [], "", false);
    this.root.visible = false;
    if (this.resuming && restoreFocus)
      this.actions.onError(
        "Open is still settling. Closing history does not cancel an accepted request; check the session tabs before retrying.",
        { level: "warning" },
      );
    const owner = this.owner;
    this.owner = undefined;
    let restored = false;
    if (restoreFocus && owner && !owner.isDestroyed) {
      let visible = true;
      for (let node: Renderable | null = owner; node; node = node.parent as Renderable | null)
        visible &&= node.visible;
      if (visible) {
        owner.focus();
        restored = this.renderer.currentFocusedRenderable === owner;
      }
    }
    if (restoreFocus && !restored) this.actions.onCloseFallback?.();
    this.actions.onChange?.();
  }
  updateScope(worktree: Worktree | null): void {
    if (this.visible && this.worktree?.id !== worktree?.id) this.hide();
  }
  refreshVisible(): void {
    if (this.visible) this.launch(() => this.refresh(true));
  }
  private launch(operation: () => Promise<void>): void {
    const pending = operation(),
      generation = this.generation;
    void pending.catch((error: unknown) => {
      const message = reportUnexpected(error, "history");
      if (!this.current(generation)) return;
      this.failure(message, true);
    });
  }
  private current(generation: number): boolean {
    return this.visible && this.generation === generation;
  }
  private failure(message: string, notify = false): void {
    this.message.content = message;
    this.message.visible = this.listStatus.visible = true;
    if (notify) this.actions.onError(message);
    this.actions.onChange?.();
  }

  private async refresh(force = false): Promise<void> {
    const generation = ++this.generation,
      worktree = this.worktree;
    this.loadRequest?.abort();
    this.cancelPreview();
    this.spinner.cancel();
    this.loading = false;
    this.loadError = undefined;
    if (!worktree || !this.actions.list) {
      this.loadError = worktree
        ? "Session history is unavailable in this preview."
        : "No worktree selected";
      this.items = [];
      this.filter();
      return;
    }
    const request = (this.loadRequest = new AbortController());
    this.loading = true;
    this.spinner.start();
    this.message.content = "Loading saved sessions…";
    this.message.visible = this.listStatus.visible = true;
    this.actions.onChange?.();
    let result: Result<readonly HistoryItem[], ExpectedError>;
    try {
      result = await this.actions.list(worktree.id, request.signal, force);
    } finally {
      if (this.current(generation)) {
        this.loading = false;
        this.spinner.stop();
        this.actions.onChange?.();
      }
    }
    if (!this.current(generation)) return;
    this.accept(result);
  }

  private filter = (): void => {
    if (!this.visible) return;
    const selected = this.selected?.id;
    const matches = createTextMatcher(this.search.value);
    const matchesQuery = this.items.filter((item) => matches(item.title));
    this.search.setCounts(
      this.loading || this.loadError
        ? null
        : { matched: matchesQuery.length, total: this.items.length },
    );
    this.filtered = matchesQuery.slice(0, 200);
    this.cursor = Math.max(
      0,
      this.filtered.findIndex((item) => item.id === selected),
    );
    for (const row of this.rows) row.destroyRecursively();
    this.rows.length = 0;
    for (const [index, item] of this.filtered.entries()) {
      const row = new BoxRenderable(this.renderer, {
        id: `history:${item.id}`,
        height: 2,
        flexShrink: 0,
        minWidth: 0,
        flexDirection: "column",
        onMouseDown: (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          this.list.focus();
          this.cursor = index;
          this.paint();
          this.schedulePreview();
        },
      });
      const title = new TextRenderable(this.renderer, {
        content: `${item.unavailableReason ? "[Unavailable] " : item.openSessionId ? "[Open] " : ""}${item.title}`,
        height: 1,
        wrapMode: "none",
        selectable: false,
      });
      const metadata = new TextRenderable(this.renderer, {
        content: `${item.modified.slice(0, 16).replace("T", " ")} · ${item.messageCount} messages`,
        height: 1,
        wrapMode: "none",
        selectable: false,
      });
      uiTheme(this.renderer).bindStyles(row, (styles) => {
        paintText(title, styles["ui.label"]);
        paintText(metadata, styles["ui.muted"]);
        row.backgroundColor = styles[index === this.cursor ? "ui.selection" : "ui.popup"].bg;
      });
      row.add(title);
      row.add(metadata);
      this.list.add(row);
      this.rows.push(row);
    }
    this.list.scrollTo(0);
    this.message.content =
      this.loadError ??
      (this.loading
        ? "Loading saved sessions…"
        : !this.items.length
          ? "No saved sessions"
          : !matchesQuery.length
            ? "No matching sessions"
            : matchesQuery.length > 200
              ? "Showing first 200; refine search"
              : "");
    const empty = !this.loading && !this.loadError && !this.filtered.length;
    this.layout.results.showEmpty(empty ? this.message.plainText : undefined);
    this.message.visible = !empty && Boolean(this.message.plainText);
    this.listStatus.visible = this.message.visible || this.spinner.root.visible;
    this.paint();
    this.schedulePreview();
  };
  private paint(): void {
    if (!this.rows) return;
    const styles = uiTheme(this.renderer).styles;
    this.rows.forEach((row, index) => {
      row.backgroundColor = styles[index === this.cursor ? "ui.selection" : "ui.popup"].bg;
    });
    const row = this.rows[this.cursor];
    if (row) this.list.scrollChildIntoView(row.id);
    this.actions.onChange?.();
  }
  private cancelPreview(): void {
    this.previewIdentity = undefined;
    this.previewState = undefined;
    if (this.actions.previews) this.previewCache.unselect();
    else this.previewCache.clear();
    this.setPreviewLoading(false);
    this.updatePreview(null, [], "", this.visible);
  }
  private setPreviewLoading(loading: boolean): void {
    if (loading === this.previewLoading) return;
    this.previewLoading = loading;
    if (loading) {
      this.spinner.start();
      this.listStatus.visible = true;
    } else if (!this.loading) this.spinner.stop();
  }
  private previewMessage(message: string): void {
    this.updatePreview(null, undefined, message, this.visible);
  }
  private updatePreview(
    id: string | null,
    sections: readonly TranscriptSection[] | undefined,
    output: string,
    visible: boolean,
    telemetry?: HistoryPreview["telemetry"],
    snapshot?: SessionRecord,
  ): void {
    if (id === null) {
      this.session.empty(output, visible);
      return;
    }
    const sessionId = this.selected?.openSessionId ?? snapshot?.id ?? this.selected?.id ?? id;
    const turn =
      sections?.slice(
        Math.max(
          0,
          sections.findLastIndex(
            (section) => section.kind === "user" || section.request !== undefined,
          ),
        ),
      ) ?? [];
    const answer = turn.findLast(
      (section) =>
        section.kind === "assistant" || (section.kind === "notice" && section.status === "error"),
    );
    const failure = answer?.status === "error" ? answer : undefined;
    const capturedAt = snapshot?.lifecycle === "closed" ? snapshot.updatedAt : undefined;
    const status = snapshot ? snapshot.state.status : failure ? "failure" : "complete";
    const state: ExecutionState = {
      status,
      error: failure?.error ?? null,
      ...snapshot?.state,
      output,
      ...(sections !== undefined ? { sections } : {}),
      ...(telemetry ? { telemetry } : {}),
    };
    const tree = this.worktree ?? {
      id: "history",
      path: "",
      name: "History",
      branch: null,
      sessions: [],
    };
    const descriptor = {
      id: sessionId,
      name: snapshot?.name ?? this.selected?.title ?? "Preview",
      status,
      subagents: snapshot?.subagents ?? [],
    };
    const sessions = tree.sessions.some((session) => session.id === sessionId)
      ? tree.sessions.map((session) => (session.id === sessionId ? descriptor : session))
      : [...tree.sessions, descriptor];
    this.session.show(
      { ...tree, sessions },
      sessionId,
      state,
      visible && this.previewPane.visible,
      capturedAt,
      this.actions.draft?.(sessionId),
    );
  }
  private showPreview(value: HistoryPreview): void {
    if (value.snapshot) {
      const snapshot = value.snapshot;
      const sections = snapshot.state.sections;
      this.updatePreview(
        `history:${value.worktreeId}:${value.id}`,
        value.truncated && sections
          ? [
              ...sections,
              {
                id: "history-preview-truncated",
                kind: "notice",
                title: "Preview truncated",
                text: "Open the session to read the full section content.",
                status: "complete",
              },
            ]
          : sections,
        snapshot.state.output,
        this.visible,
        snapshot.state.telemetry,
        snapshot,
      );
      return;
    }
    const sections: readonly TranscriptSection[] =
      value.sections ??
      (value.text
        ? [
            {
              id: "legacy-preview",
              kind: "notice",
              title: "Saved conversation",
              text: value.text,
              status: "complete",
            },
          ]
        : []);
    this.updatePreview(
      `history:${value.worktreeId}:${value.id}:${sections[0]?.id ?? "empty"}`,
      value.truncated
        ? [
            ...sections,
            {
              id: "history-preview-truncated",
              kind: "notice",
              title: "Preview truncated",
              text: "Open the session to read the full section content.",
              status: "complete",
            },
          ]
        : sections,
      "",
      this.visible,
      value.telemetry,
    );
  }
  private schedulePreview(): void {
    const item = this.selected,
      worktree = this.worktree;
    const identity =
      item && worktree && !this.loading ? JSON.stringify([worktree.id, item.id]) : undefined;
    if (identity && identity === this.previewIdentity) return;
    this.previewIdentity = identity;
    // The session renderer owns scroll restoration; resetting here overwrites the previous session's saved position.
    if (this.loading || this.loadError || !item || !worktree) {
      this.previewCache.unselect();
      this.setPreviewLoading(false);
      this.previewMessage(this.loadError ?? (this.loading ? "" : "Select a saved session"));
      return;
    }
    if (!this.actions.preview && !this.actions.previews) {
      this.previewMessage(
        "Read-only preview is unavailable. Press <CR> to open the session explicitly.",
      );
      return;
    }
    this.previewCache.select(worktree.id, item.id);
    this.renderPreview();
  }
  private renderPreview(): void {
    const item = this.selected,
      worktree = this.worktree;
    if (!this.visible || this.loading || !item || !worktree) return;
    // Responses populate their own slots; the screen only ever reads the selected slot.
    const state =
      this.previewCache.read(worktree.id, item.id) ??
      this.previewCache.select(worktree.id, item.id);
    this.previewState = state;
    this.setPreviewLoading(!state || state.kind === "pending");
    switch (state?.kind) {
      case "ready":
        this.showPreview(state.value);
        break;
      case "error":
        this.previewMessage(`[${state.error.code}] ${state.error.message}`);
        break;
      case "unexpected":
        this.previewMessage(state.message);
        break;
      default:
        this.updatePreview(null, [], "", true);
    }
    this.actions.onChange?.();
  }

  private async openSelected(): Promise<void> {
    const item = this.selected,
      worktree = this.worktree;
    if (!item || !worktree || !this.actions.resume || this.resuming || this.loading) return;
    if (item.unavailableReason) {
      this.failure(item.unavailableReason);
      return;
    }
    const generation = this.generation;
    this.resuming = true;
    this.message.content = "Opening saved session…";
    this.message.visible = this.listStatus.visible = true;
    this.actions.onChange?.();
    let result: Result<string, ExpectedError>;
    try {
      result = await this.actions.resume(worktree.id, item.id);
    } finally {
      this.resuming = false;
      if (this.visible) this.actions.onChange?.();
    }
    if (!this.current(generation)) return;
    if (!result.ok) {
      this.failure(`[${result.error.code}] Resume error: ${result.error.message}`);
      return;
    }
    this.hide(false);
    this.actions.onOpened(worktree.id, result.value);
  }

  command(command: CommandId): void {
    if (!this.visible) return;
    if (command === "history.dismiss") {
      this.hide();
      return;
    }
    if (command === "history.search") {
      this.search.focus();
      return;
    }
    if (command === "history.refresh") {
      this.refreshVisible();
      return;
    }
    if (command === "history.open") {
      this.launch(() => this.openSelected());
      return;
    }
    if (command === "history.preview") {
      if (this.renderer.width < 100) {
        this.compactPreview = !this.compactPreview;
        this.resize();
        (this.compactPreview ? this.previewTarget : this.search).focus();
      } else if (this.session.focused) this.search.focus();
      else this.previewTarget.focus();
      this.actions.onChange?.();
      return;
    }
    if (command === "history.page-up" || command === "history.page-down") {
      this.preview.scrollBy(
        (command === "history.page-up" ? -1 : 1) * Math.max(1, this.preview.viewport.height - 1),
      );
      return;
    }
    if (command === "history.first") this.cursor = 0;
    else if (command === "history.last") this.cursor = this.filtered.length - 1;
    else if (command === "history.previous" || command === "history.next")
      this.cursor += command === "history.previous" ? -1 : 1;
    else if (command === "history.half-page-up" || command === "history.half-page-down") {
      const direction = command === "history.half-page-up" ? -1 : 1;
      if (this.session.focused) {
        this.preview.scrollBy(direction * halfPageStep(this.preview.viewport.height));
        return;
      }
      const height = this.layout.listHeight;
      if (this.search.focused) {
        if (this.compactPreview) {
          this.compactPreview = false;
          this.resize();
        }
        this.list.focus();
      }
      this.cursor += direction * halfPageStep(height, 2);
    } else return;
    this.cursor = Math.max(0, Math.min(this.filtered.length - 1, this.cursor));
    this.paint();
    this.schedulePreview();
  }
  moveFocus(direction: 1 | -1): void {
    if (this.renderer.width < 100) {
      const targets = [this.search, this.list, this.previewTarget];
      const index = this.session.focused
        ? 2
        : targets.indexOf(this.renderer.currentFocusedRenderable!);
      const next = (index + direction + targets.length) % targets.length;
      this.compactPreview = next === 2;
      this.resize();
      (next === 2 ? this.previewTarget : targets[next])?.focus();
    } else {
      const targets = this.focusTargets,
        index = this.session.focused
          ? targets.length - 1
          : targets.indexOf(this.renderer.currentFocusedRenderable!);
      targets[(index + direction + targets.length) % targets.length]?.focus();
    }
    this.actions.onChange?.();
  }
  private resize = (): void => {
    if (this.disposed || this.root.isDestroyed) return;
    const { height } = centerPopup(
      this.panel,
      POPUP_SIZES.expanded,
      this.renderer.width,
      this.renderer.height,
    );
    // Keep at least four body rows for the preview in short dialogs.
    this.search.fit(height - 7);
    this.layout.resize(this.renderer.width >= 100, this.compactPreview);
    if (
      this.visible &&
      ((this.session.focused && !this.previewPane.visible) ||
        (this.list.focused && !this.list.visible))
    )
      this.search.focus();
    if (this.visible) this.renderPreview();
    this.actions.onChange?.();
  };
  dispose(): void {
    if (this.disposed) return;
    this.hide(false);
    this.disposed = true;
    this.generation++;
    this.cancelPreview();
    this.loadRequest?.abort();
    this.spinner.cancel();
    this.search.off(InputRenderableEvents.INPUT, this.filter);
    this.renderer.off("resize", this.resize);
    this.unsubscribePreviews?.();
    this.session.dispose();
    if (!this.root.isDestroyed) this.root.destroyRecursively();
    if (this.listenerBudget)
      this.renderer.setMaxListeners(
        Math.max(1, this.renderer.getMaxListeners() - this.listenerBudget),
      );
  }
}
