import { BoxRenderable, InputRenderableEvents, ScrollBoxRenderable, TextRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import type { Repository } from "../../workspace/model.ts";
import type { ExecutionState } from "../session-registry.ts";
import { monitoredSessions, type MonitoredSession } from "../session-monitor.ts";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import { footerKeyHint } from "../../keybindings/footer.ts";
import type { FooterShortcut } from "../../ui/footer.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import type { Notice } from "../../ui/messages.ts";
import { uiTheme } from "../../ui/theme.ts";
import { paintText } from "../../ui/theme-styles.ts";
import { singleLine } from "../../ui/text.ts";
import { SearchInput } from "../../ui/search-input.ts";
import { halfPageStep } from "../../ui/navigation.ts";
import { icons } from "../../icons.ts";
import { TranscriptPanel } from "./transcript-panel.ts";
import type { TranscriptSection } from "../transcript.ts";

type Actions = {
  details(id: string): ExecutionState | null;
  open(worktreeId: string, sessionId: string): void;
  changed(): void;
  fallback(): void;
  notice: Notice;
  warning?(): string;
  keyHint(command: CommandId, context: KeyContext): string;
};
type Candidate = { root: BoxRenderable; title: TextRenderable; metadata: TextRenderable; marker: TextRenderable };
const maximumCandidates = 200;
const previewTail = (text: string): string => text.slice(-8192).replace(/^[\uDC00-\uDFFF]/u, "");

// This popup owns browsing only. Preview and candidate movement never acknowledge a result.
export class SessionMonitor {
  readonly root: BoxRenderable;
  readonly search: SearchInput;
  readonly list: ScrollBoxRenderable;
  private readonly panel: BoxRenderable;
  private readonly body: BoxRenderable;
  private readonly candidates: BoxRenderable;
  private readonly message: TextRenderable;
  private readonly previewPane: BoxRenderable;
  private readonly transcript: TranscriptPanel;
  private readonly spinner: LoadingSpinner;
  private readonly rows: Candidate[] = [];
  private readonly headings: TextRenderable[] = [];
  private repositories: readonly Repository[] = [];
  private items: readonly MonitoredSession[] = [];
  private cursor = 0;
  private owner: Renderable | undefined;
  private signature = "";
  private compactPreview = false;
  private running = false;
  private disposed = false;
  private readonly listenerBudget: number;

  constructor(private readonly renderer: CliRenderer, private readonly actions: Actions) {
    this.listenerBudget = renderer.getMaxListeners() === 0 ? 0 : 4;
    if (this.listenerBudget) renderer.setMaxListeners(renderer.getMaxListeners() + this.listenerBudget);
    this.root = new BoxRenderable(renderer, { id: "session-monitor", position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 4900, visible: false,
      onMouseDown: event => event.stopPropagation(), onMouseScroll: event => event.stopPropagation() });
    this.panel = new BoxRenderable(renderer, { id: "monitor-dialog", position: "absolute", border: true, paddingX: 1, minWidth: 0, minHeight: 0, flexDirection: "column" });
    const heading = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", gap: 1 });
    const title = new TextRenderable(renderer, { content: "AI Sessions", height: 1, flexGrow: 1, wrapMode: "none", selectable: false });
    this.spinner = new LoadingSpinner(renderer, { id: "monitor-loading" });
    heading.add(title); heading.add(this.spinner.root);
    this.search = new SearchInput(renderer, { id: "monitor-search", placeholder: "Search tasks, repositories or worktrees…" });
    this.message = new TextRenderable(renderer, { id: "monitor-message", height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    this.body = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 0, minWidth: 0, flexDirection: "row" });
    this.candidates = new BoxRenderable(renderer, { width: "42%", minHeight: 0, minWidth: 0, flexDirection: "column", overflow: "hidden" });
    this.list = new ScrollBoxRenderable(renderer, { id: "monitor-list", width: "100%", flexGrow: 1, minHeight: 0, minWidth: 0, scrollX: false,
      contentOptions: { flexDirection: "column" }, onMouseDown: () => this.list.focus() });
    this.previewPane = new BoxRenderable(renderer, { id: "monitor-preview-pane", width: "58%", minWidth: 0, minHeight: 0, flexDirection: "column", border: ["left"], paddingLeft: 1 });
    const label = new TextRenderable(renderer, { content: "Live preview · read only", height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    this.transcript = new TranscriptPanel(renderer, { initialScroll: {}, initialPosition: "end", saveScroll() {},
      focusPrompt: () => this.search.focus(), notice: actions.notice, changed: actions.changed });
    this.transcript.scroll.id = "monitor-preview";
    this.previewPane.add(label); this.previewPane.add(this.transcript.scroll);
    this.candidates.add(this.search.field); this.candidates.add(this.message); this.candidates.add(this.list);
    this.body.add(this.candidates); this.body.add(this.previewPane);
    this.panel.add(heading); this.panel.add(this.body); this.root.add(this.panel);
    const theme = uiTheme(renderer);
    theme.scrollbars(this.list); theme.scrollbars(this.transcript.scroll);
    theme.bindStyles(this.root, styles => {
      this.root.backgroundColor = styles["ui.backdrop"].bg;
      this.panel.backgroundColor = styles["ui.popup"].bg; this.panel.borderColor = styles["ui.popupBorder"].fg;
      this.previewPane.borderColor = styles["ui.border"].fg;
      paintText(title, styles["ui.popupTitle"]); paintText(label, styles["ui.muted"]);
      paintText(this.message, styles["ui.muted"]); paintText(this.spinner.root, styles["status.working"]); this.paint();
    });
    this.search.on(InputRenderableEvents.INPUT, this.filter);
    renderer.on("resize", this.resize); this.resize();
  }

  get visible(): boolean { return !this.disposed && this.root.visible; }
  get context(): KeyContext { return this.search.focused ? "monitor-search" : "monitor"; }
  get focusTargets(): Renderable[] { return [this.search, ...(this.list.visible ? [this.list] : []), ...(this.previewPane.visible ? [this.transcript.scroll] : [])]; }
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
    this.root.visible = false; this.spinner.cancel(); this.running = false;
    this.transcript.update(null, [], "", false);
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
      for (const row of this.rows) row.root.destroyRecursively(); this.rows.length = 0;
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
        const marker = new TextRenderable(this.renderer, { content: unread ? icons.bell : "", width: 1, height: 1, selectable: false });
        const title = new TextRenderable(this.renderer, { content: singleLine(item.title), height: 1, flexGrow: 1, minWidth: 0, wrapMode: "none", selectable: false });
        const outcome = item.session.result?.outcome;
        const state = item.working ? "Working" : outcome === "error" || item.session.status === "failure" ? "Failed" : outcome === "unfinished" ? "? Stopped" : outcome === "cancelled" ? "Cancelled" : "Completed";
        const metadata = new TextRenderable(this.renderer, { content: singleLine(`${item.repository} / ${item.worktree} · ${item.branch ?? "detached HEAD"} · ${state}`), height: 1, wrapMode: "none", selectable: false });
        line.add(marker); line.add(title); root.add(line); root.add(metadata); this.list.add(root); this.rows.push({ root, title, metadata, marker });
      }
    }
    this.message.content = matches.length > maximumCandidates ? `Showing first ${maximumCandidates} of ${matches.length} sessions; refine search`
      : this.items.length ? `${this.items.length} sessions · Preview does not mark results as read` : this.search.value ? "No matching sessions" : "No working sessions or unread results";
    const running = this.items.some(item => item.working);
    if (running && !this.running) this.spinner.start(); else if (!running) this.spinner.stop();
    this.running = running; this.paint(); this.preview();
  }
  private paint(): void {
    if (!this.rows) return;
    const styles = uiTheme(this.renderer).styles;
    for (const heading of this.headings) paintText(heading, styles["ui.muted"]);
    this.rows.forEach((row, index) => {
      row.root.backgroundColor = styles[index === this.cursor ? "ui.selection" : "ui.popup"].bg;
      paintText(row.title, styles["ui.label"]); paintText(row.metadata, styles["ui.muted"]); paintText(row.marker, styles["status.attention"]);
    });
    const row = this.rows[this.cursor]; if (row) this.list.scrollChildIntoView(row.root.id);
    this.actions.changed();
  }
  private preview(): void {
    if (!this.visible || !this.previewPane.visible) { this.transcript.update(null, [], "", false); return; }
    const item = this.items[this.cursor], state = item ? this.actions.details(item.session.id) : null;
    // Bound native preview work to six recent sections and 8,192 UTF-16 units per section.
    const source = state?.sections ?? [];
    const sections: TranscriptSection[] = source.slice(-6).map(section => ({ ...section, text: previewTail(section.text) }));
    if (source.length > 6 || source.slice(-6).some(section => section.text.length > 8192)) sections.push({ id: "monitor-preview-limit", kind: "notice", title: "Preview truncated", text: "Open the session to read the full conversation.", status: "complete" });
    this.transcript.update(item ? `monitor:${item.session.id}` : null, sections.length ? sections : undefined,
      (state ? previewTail(state.output) : "") || (item ? "Session details are unavailable. Open the session to inspect it." : "Select a session"), this.visible, state?.conversationId);
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
      else if (this.transcript.focused) this.search.focus(); else this.transcript.scroll.focus();
      return;
    }
    if (command === "monitor.page-up" || command === "monitor.page-down") {
      this.transcript.scroll.scrollBy((command === "monitor.page-up" ? -1 : 1) * Math.max(1, this.transcript.scroll.viewport.height - 1)); return;
    }
    if (command === "monitor.first") this.cursor = 0;
    else if (command === "monitor.last") this.cursor = this.items.length - 1;
    else if (command === "monitor.next" || command === "monitor.previous") this.cursor += command === "monitor.next" ? 1 : -1;
    else if (command === "monitor.half-page-up" || command === "monitor.half-page-down") {
      const direction = command === "monitor.half-page-up" ? -1 : 1;
      if (this.transcript.focused) { this.transcript.scroll.scrollBy(direction * halfPageStep(this.transcript.scroll.viewport.height)); return; }
      const height = this.list.visible ? this.list.viewport.height : this.body.height - this.search.field.height - this.message.height;
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
    this.search.fit(height - 5);
    this.panel.width = width; this.panel.height = height; this.panel.left = Math.floor((this.renderer.width - width) / 2); this.panel.top = Math.floor((this.renderer.height - height) / 2);
    const wide = this.renderer.width >= 100;
    this.list.visible = wide || !this.compactPreview; this.previewPane.visible = wide || this.compactPreview;
    this.body.flexDirection = wide ? "row" : "column";
    this.candidates.width = wide ? "42%" : "100%"; this.candidates.flexGrow = this.list.visible ? 1 : 0;
    this.previewPane.width = wide ? "58%" : "100%"; this.previewPane.flexGrow = wide ? 0 : 1;
    this.previewPane.border = wide ? ["left"] : false; this.previewPane.paddingLeft = wide ? 1 : 0;
    if (this.visible && (this.transcript.focused && !this.previewPane.visible || this.list.focused && !this.list.visible)) this.search.focus();
    this.preview(); this.actions.changed();
  };
  dispose(): void {
    if (this.disposed) return;
    this.hide(false); this.disposed = true; this.spinner.cancel(); this.transcript.dispose();
    this.search.off(InputRenderableEvents.INPUT, this.filter); this.renderer.off("resize", this.resize);
    if (!this.root.isDestroyed) this.root.destroyRecursively();
    if (this.listenerBudget) this.renderer.setMaxListeners(Math.max(1, this.renderer.getMaxListeners() - this.listenerBudget));
  }
}
