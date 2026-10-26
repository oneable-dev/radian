import { BoxRenderable, InputRenderableEvents, ScrollBoxRenderable, TextRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import type { Repository } from "../../workspace/model.ts";
import type { ExecutionState } from "../session-registry.ts";
import { monitoredSessions, type MonitoredSession } from "../session-monitor.ts";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import { footerKeyHint } from "../../keybindings/footer.ts";
import type { FooterShortcut } from "../../ui/footer.ts";
import type { Notice } from "../../ui/messages.ts";
import { uiTheme } from "../../ui/theme.ts";
import { PopupFrame } from "../../ui/popup-frame.ts";
import { SearchPopupLayout, centerPopup } from "../../ui/popup-layout.ts";
import { paintText } from "../../ui/theme-styles.ts";
import { singleLine } from "../../ui/text.ts";
import { SearchInput } from "../../ui/search-input.ts";
import { halfPageStep } from "../../ui/navigation.ts";
import { SessionPreview } from "./session-preview.ts";
import { StatusIndicator } from "./status-indicator.ts";
import type { PromptDraft } from "../prompt-input.ts";
import type { TranscriptImageProvider } from "../transcript-images.ts";

type Actions = {
  details(id: string): ExecutionState | null;
  open(worktreeId: string, sessionId: string): void;
  changed(): void;
  fallback(): void;
  notice: Notice;
  warning?(): string;
  keyHint(command: CommandId, context: KeyContext): string;
  draft?(id: string): PromptDraft | string | undefined;
  image?: TranscriptImageProvider;
};
type Candidate = { root: BoxRenderable; title: TextRenderable; metadata: TextRenderable; status: StatusIndicator };
const maximumCandidates = 200;

// This popup owns browsing only. Preview and candidate movement never acknowledge a result.
export class SessionMonitor {
  readonly root: BoxRenderable;
  readonly search: SearchInput;
  readonly list: ScrollBoxRenderable;
  private readonly panel: BoxRenderable;
  private readonly body: BoxRenderable;
  private readonly layout: SearchPopupLayout;
  private readonly message: TextRenderable;
  private readonly previewPane: BoxRenderable;
  private readonly previewSurface: SessionPreview;
  private readonly rows: Candidate[] = [];
  private readonly headings: TextRenderable[] = [];
  private repositories: readonly Repository[] = [];
  private items: readonly MonitoredSession[] = [];
  private cursor = 0;
  private owner: Renderable | undefined;
  private signature = "";
  private compactPreview = false;
  private disposed = false;
  private readonly listenerBudget: number;

  constructor(private readonly renderer: CliRenderer, private readonly actions: Actions) {
    this.listenerBudget = renderer.getMaxListeners() === 0 ? 0 : 8;
    if (this.listenerBudget) renderer.setMaxListeners(renderer.getMaxListeners() + this.listenerBudget);
    this.root = new BoxRenderable(renderer, { id: "session-monitor", position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 4900, visible: false,
      onMouseDown: event => event.stopPropagation(), onMouseScroll: event => event.stopPropagation() });
    this.panel = new PopupFrame(renderer, { id: "monitor-dialog", position: "absolute", border: true, paddingX: 1, minWidth: 0, minHeight: 0, flexDirection: "column" });
    this.search = new SearchInput(renderer, { id: "monitor-search", placeholder: "Search tasks, repositories or worktrees…" });
    this.message = new TextRenderable(renderer, { id: "monitor-message", height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    this.list = new ScrollBoxRenderable(renderer, { id: "monitor-list", width: "100%", flexGrow: 1, minHeight: 0, minWidth: 0, scrollX: false,
      contentOptions: { flexDirection: "column" }, onMouseDown: () => this.list.focus() });
    this.previewSurface = new SessionPreview(renderer, "monitor", { notice: actions.notice, changed: actions.changed,
      focusList: () => this.search.focus(), keyHint: actions.keyHint, details: actions.details, ...(actions.image ? { image: actions.image } : {}) });
    this.previewPane = this.previewSurface.body.root;
    this.layout = new SearchPopupLayout(renderer, { id: "monitor", search: this.search, message: this.message, list: this.list,
      preview: { body: this.previewSurface.body, width: 58 } });
    this.body = this.layout.root;
    this.panel.add(this.body); this.root.add(this.panel);
    const theme = uiTheme(renderer);
    theme.scrollbars(this.list);
    theme.bindStyles(this.root, styles => {
      this.root.backgroundColor = styles["ui.backdrop"].bg;
      this.panel.backgroundColor = styles["ui.popup"].bg; this.panel.borderColor = styles["ui.popupBorder"].fg;
      this.previewPane.borderColor = styles["ui.border"].fg;
      paintText(this.message, styles["ui.muted"]); this.paint();
    });
    this.search.on(InputRenderableEvents.INPUT, this.filter);
    renderer.on("resize", this.resize); this.resize();
  }

  get visible(): boolean { return !this.disposed && this.root.visible; }
  get context(): KeyContext { return this.search.focused ? "monitor-search" : "monitor"; }
  get focusTargets(): Renderable[] { return [this.search, ...(this.list.visible ? [this.list] : []), ...(this.previewPane.visible ? [this.previewSurface.focusTarget] : [])]; }
  get shortcuts(): readonly FooterShortcut[] {
    const hint = (command: CommandId, label: string) => ({ key: footerKeyHint(command, this.context, this.actions.keyHint(command, this.context)), label });
    return [...(this.items.length ? [hint("monitor.open", "Open")] : []), hint("monitor.dismiss", "Close"), hint("monitor.next", "Next"), hint("monitor.previous", "Previous"), hint("monitor.half-page-down", "½ page"), hint("monitor.preview", "Preview"), hint("monitor.page-down", "Page")];
  }

  update(repositories: readonly Repository[]): void {
    this.repositories = repositories;
    if (this.visible) this.refresh();
  }
  show(): void {
    if (this.disposed) return;
    if (this.visible) { this.search.focus(); return; }
    this.owner = this.renderer.currentFocusedRenderable ?? undefined;
    this.root.visible = true; this.signature = ""; this.compactPreview = false; this.search.value = "";
    this.resize(); this.refresh(); this.search.focus(); this.actions.changed();
    const warning = this.actions.warning?.(); if (warning) this.actions.notice(warning, { level: "warning" });
  }
  hide(restoreFocus = true): void {
    if (!this.visible) return;
    this.root.visible = false; this.previewSurface.hide();
    for (const row of this.rows) row.status.dispose();
    const owner = this.owner; this.owner = undefined;
    if (restoreFocus) {
      let visible = !!owner && !owner.isDestroyed;
      for (let node: Renderable | null = owner ?? null; node; node = node.parent as Renderable | null) visible &&= node.visible;
      if (visible && owner) owner.focus(); else this.actions.fallback();
    }
    this.actions.changed();
  }

  private filter = (): void => { this.signature = ""; this.list.scrollTo(0); this.refresh(); };
  private refresh(): void {
    const selected = this.items[this.cursor]?.session.id;
    const matches = monitoredSessions(this.repositories, this.search.value);
    this.items = matches.slice(0, maximumCandidates);
    const index = this.items.findIndex(item => item.session.id === selected);
    this.cursor = index >= 0 ? index : Math.max(0, Math.min(this.cursor, this.items.length - 1));
    const signature = JSON.stringify(this.items.map(item => [item.session.id, item.title, item.worktree, item.repository, item.branch, item.working,
      item.session.attention?.id, item.session.result?.outcome, item.session.status, item.session.subagents.map(child => child.status)]));
    if (signature !== this.signature) {
      this.signature = signature;
      for (const row of this.rows) { row.status.dispose(); row.root.destroyRecursively(); } this.rows.length = 0;
      for (const heading of this.headings) heading.destroy(); this.headings.length = 0;
      let group: boolean | undefined;
      for (const [index, item] of this.items.entries()) {
        const unread = !!item.session.attention;
        if (unread !== group) {
          group = unread;
          const heading = new TextRenderable(this.renderer, { content: unread ? "Needs attention" : "Working", height: 1, flexShrink: 0, selectable: false, wrapMode: "none" });
          this.headings.push(heading); this.list.add(heading);
        }
        const root = new BoxRenderable(this.renderer, { id: `monitor:${item.session.id}`, height: 3, flexShrink: 0, minWidth: 0, flexDirection: "column",
          onMouseDown: event => { if (event.button === 0) { event.preventDefault(); event.stopPropagation(); this.list.focus(); this.cursor = index; this.paint(); this.preview(); } } });
        const line = new BoxRenderable(this.renderer, { height: 1, minWidth: 0, flexDirection: "row", gap: 1 });
        const status = new StatusIndicator(this.renderer); status.root.id = `monitor-status:${item.session.id}`;
        const title = new TextRenderable(this.renderer, { content: singleLine(item.title), height: 1, flexGrow: 1, minWidth: 0, wrapMode: "none", selectable: false });
        const outcome = item.session.result?.outcome;
        const state = item.working ? "Working" : outcome === "error" || item.session.status === "failure" ? "Failed" : outcome === "unfinished" ? "? Stopped" : outcome === "cancelled" ? "Cancelled" : "Completed";
        const metadata = new TextRenderable(this.renderer, { content: singleLine(`${item.repository} / ${item.worktree} · ${item.branch ?? "detached HEAD"} · ${state}`), height: 1, wrapMode: "none", selectable: false });
        line.add(status.root); line.add(title); root.add(line); root.add(metadata); this.list.add(root); this.rows.push({ root, title, metadata, status });
      }
    }
    this.message.content = matches.length > maximumCandidates ? `Showing first ${maximumCandidates} of ${matches.length} sessions; refine search`
      : this.items.length ? `${this.items.length} sessions · Preview does not mark results as read` : this.search.value ? "No matching sessions" : "No working sessions or unread results";
    this.layout.results.showEmpty(!this.items.length ? this.message.plainText : undefined);
    this.message.visible = this.items.length > 0;
    this.paint(); this.preview();
  }
  private paint(): void {
    if (!this.rows) return;
    const styles = uiTheme(this.renderer).styles;
    for (const heading of this.headings) paintText(heading, styles["ui.muted"]);
    this.rows.forEach((row, index) => {
      row.root.backgroundColor = styles[index === this.cursor ? "ui.selection" : "ui.popup"].bg;
      paintText(row.title, styles["ui.label"]); paintText(row.metadata, styles["ui.muted"]);
      const item = this.items[index]; if (item) row.status.update(item.working ? "working" : item.session.status, this.visible, item.session);
    });
    const row = this.rows[this.cursor]; if (row) this.list.scrollChildIntoView(row.root.id);
    this.actions.changed();
  }
  private preview(): void {
    if (!this.visible || !this.previewPane.visible) { this.previewSurface.hide(); return; }
    const item = this.items[this.cursor], state = item ? this.actions.details(item.session.id) : null;
    const tree = item ? this.repositories.flatMap(repository => repository.worktrees).find(tree => tree.id === item.worktreeId) : undefined;
    if (!item || !state || !tree) {
      this.previewSurface.empty(item ? "Session details are unavailable. Open the session to inspect it." : "Select a session", this.visible); return;
    }
    this.previewSurface.show(tree, item.session.id, state, this.visible, undefined, this.actions.draft?.(item.session.id));
  }
  command(command: CommandId): void {
    if (!this.visible) return;
    if (command === "monitor.dismiss") { this.hide(); return; }
    if (command === "monitor.open") {
      const item = this.items[this.cursor]; if (!item) return;
      this.hide(false); this.actions.open(item.worktreeId, item.session.id); return;
    }
    if (command === "monitor.preview") {
      if (this.renderer.width < 100) { this.compactPreview = !this.compactPreview; this.resize(); }
      else if (this.previewSurface.focused) this.search.focus(); else this.previewSurface.focusTarget.focus();
      return;
    }
    if (command === "monitor.page-up" || command === "monitor.page-down") {
      const scroll = this.previewSurface.transcript;
      scroll.scrollBy((command === "monitor.page-up" ? -1 : 1) * Math.max(1, scroll.viewport.height - 1)); return;
    }
    if (command === "monitor.first") this.cursor = 0;
    else if (command === "monitor.last") this.cursor = this.items.length - 1;
    else if (command === "monitor.next" || command === "monitor.previous") this.cursor += command === "monitor.next" ? 1 : -1;
    else if (command === "monitor.half-page-up" || command === "monitor.half-page-down") {
      const direction = command === "monitor.half-page-up" ? -1 : 1;
      if (this.previewSurface.focused) { this.previewSurface.transcript.scrollBy(direction * halfPageStep(this.previewSurface.transcript.viewport.height)); return; }
      const height = this.layout.listHeight;
      if (this.search.focused) {
        if (this.compactPreview) { this.compactPreview = false; this.resize(); }
        this.list.focus();
      }
      this.cursor += direction * halfPageStep(height, 3);
    } else return;
    this.cursor = Math.max(0, Math.min(this.items.length - 1, this.cursor)); this.paint(); this.preview();
  }
  private resize = (): void => {
    if (this.disposed) return;
    const width = Math.max(1, Math.floor(this.renderer.width * 0.9)), height = Math.max(1, Math.floor(this.renderer.height * 0.8));
    this.search.fit(height - 4);
    centerPopup(this.panel, width, height, this.renderer.width, this.renderer.height);
    this.layout.resize(this.renderer.width >= 100, this.compactPreview);
    if (this.visible && (this.previewSurface.focused && !this.previewPane.visible || this.list.focused && !this.list.visible)) this.search.focus();
    this.preview(); this.actions.changed();
  };
  dispose(): void {
    if (this.disposed) return;
    this.hide(false); this.disposed = true; this.previewSurface.dispose();
    for (const row of this.rows) row.status.dispose();
    this.search.off(InputRenderableEvents.INPUT, this.filter); this.renderer.off("resize", this.resize);
    if (!this.root.isDestroyed) this.root.destroyRecursively();
    if (this.listenerBudget) this.renderer.setMaxListeners(Math.max(1, this.renderer.getMaxListeners() - this.listenerBudget));
  }
}
