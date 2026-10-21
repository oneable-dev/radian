import { BoxRenderable, InputRenderableEvents, ScrollBoxRenderable, TextRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import type { HistoryItem } from "../history.ts";
import type { HistoryPreview } from "../history-preview.ts";
import { HistoryPreviewCache } from "../history-preview-cache.ts";
import { singleLine } from "../../ui/text.ts";
import { SearchInput } from "../../ui/search-input.ts";
import type { Worktree } from "../../workspace/model.ts";
import { reportUnexpected, type ExpectedError } from "../../errors.ts";
import type { Result } from "../../result.ts";
import type { FooterShortcut } from "../../ui/footer.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import { uiTheme } from "../../ui/theme.ts";
import { paintText } from "../../ui/theme-styles.ts";
import { AgentPanel } from "./agent-panel.ts";
import type { ExecutionState, SessionRecord } from "../session-registry.ts";
import { halfPageStep } from "../../ui/navigation.ts";
import type { TranscriptSection } from "../transcript.ts";

export type HistoryActions = {
  list?: (worktreeId: string, signal?: AbortSignal) => Promise<Result<readonly HistoryItem[], ExpectedError>>;
  preview?: (worktreeId: string, savedId: string, signal?: AbortSignal) => Promise<Result<HistoryPreview, ExpectedError>>;
  resume?: (worktreeId: string, savedId: string) => Promise<Result<string, ExpectedError>>;
  onOpened: (worktreeId: string, sessionId: string) => void;
  onError: (message: string) => void;
  onCloseFallback?: () => void;
  onChange?: () => void;
  keyHint: (command: Extract<CommandId, `history.${string}`>, context: KeyContext) => string;
};

function matches(title: string, query: string): boolean {
  const text = title.normalize("NFKC").toLowerCase();
  return query.normalize("NFKC").toLowerCase().trim().split(/\s+/).every((word) => {
    let offset = 0;
    for (const char of word) { const at = text.indexOf(char, offset); if (at < 0) return false; offset = at + char.length; }
    return true;
  });
}

// The popup owns only a query and a candidate cursor. Canonical session selection changes on Open.
export class SessionHistoryPanel {
  readonly root: BoxRenderable;
  readonly search: SearchInput;
  readonly list: ScrollBoxRenderable;
  readonly preview: ScrollBoxRenderable;
  private readonly panel: BoxRenderable;
  private readonly title: TextRenderable;
  private readonly spinner: LoadingSpinner;
  private readonly previewLabel: TextRenderable;
  private readonly previewCache: HistoryPreviewCache;
  private readonly message: TextRenderable;
  private readonly previewPane: BoxRenderable;
  private readonly session: AgentPanel;
  private previewState: ExecutionState | null = null;
  private previewCapturedAt: number | undefined;
  private readonly rows: BoxRenderable[] = [];
  private items: readonly HistoryItem[] = [];
  private filtered: readonly HistoryItem[] = [];
  private worktree: Worktree | null = null;
  private owner: Renderable | undefined;
  private cursor = 0;
  private generation = 0;
  private previewIdentity: string | undefined;
  private loadRequest: AbortController | undefined;
  private resuming = false;
  private loading = false;
  private loadError: string | undefined;
  private compactPreview = false;
  private disposed = false;
  private readonly listenerBudget: number;

  constructor(private readonly renderer: CliRenderer, private readonly actions: HistoryActions) {
    // The list and shared session surface own native scroll/layout subscriptions.
    this.listenerBudget = renderer.getMaxListeners() === 0 ? 0 : 8;
    if (this.listenerBudget) renderer.setMaxListeners(renderer.getMaxListeners() + this.listenerBudget);
    const theme = uiTheme(renderer);
    this.root = new BoxRenderable(renderer, { id: "session-history", position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 5000,
      visible: false,
      onMouseDown: (event) => { event.stopPropagation(); }, onMouseScroll: (event) => event.stopPropagation() });
    this.panel = new BoxRenderable(renderer, { id: "history-dialog", position: "absolute", border: true,
      paddingX: 1, flexDirection: "column", minWidth: 0, minHeight: 0 });
    const heading = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", gap: 1 });
    this.title = new TextRenderable(renderer, { height: 1, flexGrow: 1, flexShrink: 1, minWidth: 0, wrapMode: "none", selectable: false });
    this.spinner = new LoadingSpinner(renderer, { id: "history-loading" });
    heading.add(this.title);
    const activity = new BoxRenderable(renderer, { width: 1, height: 1, flexShrink: 0 }); activity.add(this.spinner.root); heading.add(activity);
    const close = new TextRenderable(renderer, { content: "×", width: 1, height: 1, selectable: false,
      onMouseDown: (event) => { if (event.button === 0) { event.preventDefault(); event.stopPropagation(); this.hide(); } } }); heading.add(close);
    this.search = new SearchInput(renderer, { id: "history-search", placeholder: "Search session titles…" });
    this.message = new TextRenderable(renderer, { id: "history-message", content: "", height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    const body = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 0, minWidth: 0, flexDirection: "row" });
    this.list = new ScrollBoxRenderable(renderer, { id: "history-list", flexGrow: 1, minHeight: 0, minWidth: 0, scrollX: false,
      contentOptions: { flexDirection: "column" }, onMouseDown: () => this.list.focus() });
    this.previewPane = new BoxRenderable(renderer, { id: "history-preview-pane", width: "58%", minWidth: 0, minHeight: 0, flexDirection: "column", border: ["left"], paddingLeft: 1 });
    const previewHeading = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", gap: 1 });
    this.previewLabel = new TextRenderable(renderer, { content: "Preview · read only", height: 1, flexGrow: 1, flexShrink: 1, minWidth: 0, selectable: false, wrapMode: "none" });
    previewHeading.add(this.previewLabel);
    this.session = new AgentPanel(renderer, { onNewSession: () => {}, getSessionDetails: () => this.previewState },
      (label) => { const button = new BoxRenderable(renderer, {}); button.add(new TextRenderable(renderer, { content: label })); return button; },
      actions.onError, () => actions.onChange?.(), () => this.search.focus(), {}, () => {},
      { readOnly: true, idPrefix: "history-preview-", initialPosition: "end", emptyLogo: false, snapshotTime: () => this.previewCapturedAt });
    this.session.update(null, null, new Set(), false);
    this.previewCache = new HistoryPreviewCache((tree, id, signal) => actions.preview!(tree, id, signal),
      () => this.renderPreview(), error => reportUnexpected(error, "history preview"));
    this.preview = this.session.transcriptScroll; this.preview.id = "history-preview";
    this.previewPane.add(previewHeading); this.previewPane.add(this.session.root);
    body.add(this.list); body.add(this.previewPane);
    this.panel.add(heading); this.panel.add(this.search.field); this.panel.add(this.message); this.panel.add(body); this.root.add(this.panel);
    theme.scrollbars(this.list); theme.scrollbars(this.preview);
    theme.bindStyles(this.root, (styles) => {
      this.root.backgroundColor = styles["ui.backdrop"].bg;
      this.panel.backgroundColor = styles["ui.popup"].bg; this.panel.borderColor = styles["ui.popupBorder"].fg; paintText(this.title, styles["ui.popupTitle"]);
      for (const text of [this.message, this.previewLabel, close]) paintText(text, styles["ui.muted"]);
      this.previewPane.borderColor = styles["ui.border"].fg;
      this.session.root.backgroundColor = styles["ui.text"].bg;
      paintText(this.spinner.root, styles["status.working"]);
      this.paint();
    });
    this.search.on(InputRenderableEvents.INPUT, this.filter);
    renderer.on("resize", this.resize); this.resize();
  }

  get visible(): boolean { return this.root.visible && !this.disposed && !this.root.isDestroyed; }
  get context(): KeyContext { return this.search.focused ? "history-search" : "history"; }
  get focusTargets(): Renderable[] { return [this.search, ...(this.list.visible ? [this.list] : []), ...(this.previewPane.visible ? [this.preview] : [])]; }
  get shortcuts(): readonly FooterShortcut[] {
    const hint = (command: Extract<CommandId, `history.${string}`>, label: string) => ({ key: this.actions.keyHint(command, this.context), label });
    return [...(this.selected && !this.selected.unavailableReason && this.actions.resume && !this.resuming && !this.loading ? [hint("history.open", "Open")] : []),
      hint("history.dismiss", "Close"), hint("history.preview", "Preview"), hint("history.previous", "Previous"), hint("history.next", "Next"), hint("history.refresh", "Refresh"), hint("history.half-page-down", "½ page")].filter((item) => item.key);
  }
  private get selected(): HistoryItem | undefined { return this.filtered[this.cursor]; }

  show(worktree: Worktree | null): void {
    if (this.disposed || this.root.isDestroyed) return;
    if (this.visible) { this.search.focus(); return; }
    this.owner = this.renderer.currentFocusedRenderable ?? undefined;
    this.worktree = worktree; this.compactPreview = false; this.root.visible = true;
    this.items = []; this.filtered = []; this.loadError = undefined; this.search.value = ""; this.filter(); this.resize();
    this.search.focus(); this.launch(() => this.refresh());
  }
  hide(restoreFocus = true): void {
    if (!this.visible) return;
    this.generation++; this.loading = false; this.cancelPreview(); this.loadRequest?.abort(); this.spinner.cancel();
    this.updatePreview(null, [], "", false);
    this.root.visible = false;
    if (this.resuming && restoreFocus) this.actions.onError("Open is still settling. Closing history does not cancel an accepted request; check the session tabs before retrying.");
    const owner = this.owner; this.owner = undefined;
    let restored = false;
    if (restoreFocus && owner && !owner.isDestroyed) {
      let visible = true; for (let node: Renderable | null = owner; node; node = node.parent as Renderable | null) visible &&= node.visible;
      if (visible) { owner.focus(); restored = this.renderer.currentFocusedRenderable === owner; }
    }
    if (restoreFocus && !restored) this.actions.onCloseFallback?.();
    this.actions.onChange?.();
  }
  updateScope(worktree: Worktree | null): void { if (this.visible && this.worktree?.id !== worktree?.id) this.hide(); }
  refreshVisible(): void { if (this.visible) this.launch(() => this.refresh()); }
  private launch(operation: () => Promise<void>): void {
    const pending = operation(), generation = this.generation;
    void pending.catch((error: unknown) => {
      const message = reportUnexpected(error, "history");
      if (!this.current(generation)) return;
      this.failure(message, true);
    });
  }
  private current(generation: number): boolean { return this.visible && this.generation === generation; }
  private failure(message: string, notify = false): void {
    this.message.content = message;
    if (notify) this.actions.onError(message);
    this.actions.onChange?.();
  }

  private async refresh(): Promise<void> {
    const generation = ++this.generation, worktree = this.worktree;
    this.loadRequest?.abort(); this.cancelPreview(); this.spinner.cancel(); this.loading = false; this.loadError = undefined;
    this.title.content = worktree ? `History · ${worktree.name}` : "History";
    if (!worktree || !this.actions.list) {
      this.loadError = worktree ? "Session history is unavailable in this preview." : "No worktree selected";
      this.items = []; this.filter(); return;
    }
    const request = this.loadRequest = new AbortController(); this.loading = true; this.spinner.start(); this.message.content = "Loading saved sessions…";
    this.actions.onChange?.();
    let result: Result<readonly HistoryItem[], ExpectedError>;
    try { result = await this.actions.list(worktree.id, request.signal); }
    finally { if (this.current(generation)) { this.loading = false; this.spinner.stop(); this.actions.onChange?.(); } }
    if (!this.current(generation)) return;
    if (!result.ok) {
      this.loadError = `[${result.error.code}] History error: ${result.error.message}`;
      this.items = []; this.filter(); return;
    }
    this.items = result.value; this.filter();
  }

  private filter = (): void => {
    if (!this.visible) return;
    const selected = this.selected?.id;
    const matchesQuery = this.items.filter((item) => matches(item.title, this.search.value));
    this.filtered = matchesQuery.slice(0, 200);
    this.cursor = Math.max(0, this.filtered.findIndex((item) => item.id === selected));
    for (const row of this.rows) row.destroyRecursively(); this.rows.length = 0;
    for (const [index, item] of this.filtered.entries()) {
      const row = new BoxRenderable(this.renderer, { id: `history:${item.id}`, height: 2, flexShrink: 0, minWidth: 0, flexDirection: "column",
        onMouseDown: (event) => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); this.list.focus(); this.cursor = index; this.paint(); this.schedulePreview(); } });
      const title = new TextRenderable(this.renderer, { content: `${item.unavailableReason ? "[Unavailable] " : item.openSessionId ? "[Open] " : ""}${item.title}`, height: 1, wrapMode: "none", selectable: false });
      const metadata = new TextRenderable(this.renderer, { content: `${item.modified.slice(0, 16).replace("T", " ")} · ${item.messageCount} messages`, height: 1, wrapMode: "none", selectable: false });
      uiTheme(this.renderer).bindStyles(row, (styles) => { paintText(title, styles["ui.label"]); paintText(metadata, styles["ui.muted"]); row.backgroundColor = styles[index === this.cursor ? "ui.selection" : "ui.popup"].bg; });
      row.add(title); row.add(metadata); this.list.add(row); this.rows.push(row);
    }
    this.list.scrollTo(0);
    this.message.content = this.loadError ?? (this.loading ? "Loading saved sessions…" : !this.items.length ? "No saved sessions" : !matchesQuery.length ? "No matching sessions"
      : `${matchesQuery.length} ${matchesQuery.length === 1 ? "session" : "sessions"}${matchesQuery.length > 200 ? " · showing first 200; refine search" : ""}`);
    this.paint(); this.schedulePreview();
  };
  private paint(): void {
    if (!this.rows) return;
    const styles = uiTheme(this.renderer).styles;
    this.rows.forEach((row, index) => { row.backgroundColor = styles[index === this.cursor ? "ui.selection" : "ui.popup"].bg; });
    const row = this.rows[this.cursor]; if (row) this.list.scrollChildIntoView(row.id);
    this.actions.onChange?.();
  }
  private cancelPreview(): void {
    this.previewIdentity = undefined; this.previewCache.clear();
    this.updatePreview(null, [], "", this.visible);
  }
  private previewMessage(message: string): void {
    this.updatePreview(null, undefined, message, this.visible);
  }
  private updatePreview(id: string | null, sections: readonly TranscriptSection[] | undefined, output: string, visible: boolean, telemetry?: HistoryPreview["telemetry"], snapshot?: SessionRecord): void {
    const sessionId = id ?? "history:empty";
    const turn = sections?.slice(Math.max(0, sections.findLastIndex(section => section.kind === "user" || section.request !== undefined))) ?? [];
    const answer = turn.findLast(section => section.kind === "assistant" || section.kind === "notice" && section.status === "error");
    const failure = answer?.status === "error" ? answer : undefined;
    this.previewCapturedAt = snapshot?.lifecycle === "closed" ? snapshot.updatedAt : undefined;
    const status = snapshot ? snapshot.state.status : failure ? "failure" : "complete";
    this.previewState = { status, error: failure?.error ?? null, ...snapshot?.state, output, ...(sections !== undefined ? { sections } : {}), ...(telemetry ? { telemetry } : {}) };
    const tree = this.worktree ?? { id: "history", path: "", name: "History", branch: null, sessions: [] };
    this.session.update({ ...tree, sessions: [{ id: sessionId, name: this.selected?.title ?? "Preview", status, subagents: snapshot?.subagents ?? [] }] },
      sessionId, new Set([sessionId]), visible && this.previewPane.visible);
  }
  private showPreview(value: HistoryPreview): void {
    if (value.snapshot) {
      const snapshot = value.snapshot;
      const sections = snapshot.state.sections;
      const savedAt = snapshot.updatedAt === undefined ? "" : ` · saved ${new Date(snapshot.updatedAt).toISOString().slice(0, 16).replace("T", " ")}`;
      this.previewLabel.content = `Preview · ${singleLine(this.selected?.title ?? snapshot.name)} · read only${savedAt}`;
      this.updatePreview(`history:${value.worktreeId}:${value.id}`, value.truncated && sections ? [...sections, {
        id: "history-preview-truncated", kind: "notice", title: "Preview truncated", text: "Open the session to read the full section content.", status: "complete",
      }] : sections, snapshot.state.output, this.visible, snapshot.state.telemetry, snapshot);
      return;
    }
    const sections: readonly TranscriptSection[] = value.sections ?? (value.text ? [{ id: "legacy-preview", kind: "notice", title: "Saved conversation", text: value.text, status: "complete" }] : []);
    if (!sections.length) { this.updatePreview(`history:${value.worktreeId}:${value.id}`, undefined, "No saved sections in this branch.", this.visible, value.telemetry); return; }
    this.updatePreview(`history:${value.worktreeId}:${value.id}:${sections[0]!.id}`, value.truncated ? [...sections, {
      id: "history-preview-truncated", kind: "notice", title: "Preview truncated", text: "Open the session to read the full section content.", status: "complete",
    }] : sections, "", this.visible, value.telemetry);
  }
  private schedulePreview(): void {
    const item = this.selected, worktree = this.worktree;
    const identity = item && worktree && !this.loading ? JSON.stringify([worktree.id, item.id]) : undefined;
    if (identity && identity === this.previewIdentity) return;
    this.previewIdentity = identity; this.preview.scrollTo(0);
    this.previewLabel.content = item ? `Preview · ${singleLine(item.title)} · read only` : "Preview · read only";
    if (this.loading || this.loadError || !item || !worktree) {
      this.previewCache.unselect(); this.previewMessage(this.loadError ?? (this.loading ? "" : "Select a saved session")); return;
    }
    if (!this.actions.preview) { this.previewMessage("Read-only preview is unavailable. Press Enter to open the session explicitly."); return; }
    this.previewCache.select(worktree.id, item.id); this.renderPreview();
  }
  private renderPreview(): void {
    const item = this.selected, worktree = this.worktree;
    if (!this.visible || this.loading || !item || !worktree) return;
    // Responses populate their own slots; the screen only ever reads the selected slot.
    const state = this.previewCache.read(worktree.id, item.id);
    switch (state?.kind) {
      case "ready": this.showPreview(state.value); break;
      case "error": this.previewMessage(`[${state.error.code}] ${state.error.message}`); break;
      case "unexpected": this.previewMessage(state.message); break;
      default: this.updatePreview(null, [], "", true);
    }
    this.actions.onChange?.();
  }

  private async openSelected(): Promise<void> {
    const item = this.selected, worktree = this.worktree;
    if (!item || !worktree || !this.actions.resume || this.resuming || this.loading) return;
    if (item.unavailableReason) { this.message.content = item.unavailableReason; return; }
    const generation = this.generation; this.resuming = true; this.message.content = "Opening saved session…"; this.actions.onChange?.();
    let result: Result<string, ExpectedError>;
    try { result = await this.actions.resume(worktree.id, item.id); }
    finally { this.resuming = false; if (this.visible) this.actions.onChange?.(); }
    if (!this.current(generation)) return;
    if (!result.ok) { this.failure(`[${result.error.code}] Resume error: ${result.error.message}`); return; }
    this.hide(false); this.actions.onOpened(worktree.id, result.value);
  }

  command(command: CommandId): void {
    if (!this.visible) return;
    if (command === "history.dismiss") { this.hide(); return; }
    if (command === "history.refresh") { this.refreshVisible(); return; }
    if (command === "history.open") { this.launch(() => this.openSelected()); return; }
    if (command === "history.preview") {
      if (this.renderer.width < 100) { this.compactPreview = !this.compactPreview; this.resize(); }
      else if (this.session.transcriptFocused) this.search.focus(); else this.preview.focus();
      this.actions.onChange?.(); return;
    }
    if (command === "history.page-up" || command === "history.page-down") {
      this.preview.scrollBy((command === "history.page-up" ? -1 : 1) * Math.max(1, this.preview.viewport.height - 1)); return;
    }
    if (command === "history.first") this.cursor = 0;
    else if (command === "history.last") this.cursor = this.filtered.length - 1;
    else if (command === "history.previous" || command === "history.next") this.cursor += command === "history.previous" ? -1 : 1;
    else if (command === "history.half-page-up" || command === "history.half-page-down") {
      const direction = command === "history.half-page-up" ? -1 : 1;
      if (this.session.transcriptFocused) { this.preview.scrollBy(direction * halfPageStep(this.preview.viewport.height)); return; }
      const height = this.list.visible ? this.list.viewport.height : this.list.parent?.height ?? this.list.viewport.height;
      if (this.search.focused) {
        if (this.compactPreview) { this.compactPreview = false; this.resize(); }
        this.list.focus();
      }
      this.cursor += direction * halfPageStep(height, 2);
    } else return;
    this.cursor = Math.max(0, Math.min(this.filtered.length - 1, this.cursor)); this.paint(); this.schedulePreview();
  }
  private resize = (): void => {
    if (this.disposed || this.root.isDestroyed) return;
    const width = Math.max(1, Math.min(this.renderer.width, Math.floor(this.renderer.width * 0.9)));
    const height = Math.max(1, Math.min(this.renderer.height, Math.max(8, Math.floor(this.renderer.height * 0.8))));
    // Keep at least four body rows for the preview in short dialogs.
    this.search.fit(height - 8);
    this.panel.width = width; this.panel.height = height; this.panel.left = Math.floor((this.renderer.width - width) / 2); this.panel.top = Math.floor((this.renderer.height - height) / 2);
    const wide = this.renderer.width >= 100;
    this.list.visible = wide || !this.compactPreview; this.previewPane.visible = wide || this.compactPreview;
    this.list.width = wide ? "42%" : "100%";
    this.previewPane.width = wide ? "58%" : "100%";
    this.previewPane.border = wide ? ["left"] : false; this.previewPane.paddingLeft = wide ? 1 : 0;
    if (this.visible && ((this.session.root.hasFocusedDescendant && !this.previewPane.visible) || (this.list.focused && !this.list.visible))) this.search.focus();
    if (this.visible) this.renderPreview();
    this.actions.onChange?.();
  };
  dispose(): void {
    if (this.disposed) return;
    this.hide(false); this.disposed = true; this.generation++; this.cancelPreview(); this.loadRequest?.abort(); this.spinner.cancel();
    this.search.off(InputRenderableEvents.INPUT, this.filter); this.renderer.off("resize", this.resize); this.session.dispose();
    if (!this.root.isDestroyed) this.root.destroyRecursively();
    if (this.listenerBudget) this.renderer.setMaxListeners(Math.max(1, this.renderer.getMaxListeners() - this.listenerBudget));
  }
}
