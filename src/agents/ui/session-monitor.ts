import { BoxRenderable, InputRenderableEvents, ScrollBoxRenderable, TextRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import type { Repository } from "../../workspace/model.ts";
import type { ExecutionState } from "../session-registry.ts";
import { monitoredSessions, type MonitoredSession } from "../session-monitor.ts";
import { icons } from "../../icons.ts";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import { footerKeyHint } from "../../keybindings/footer.ts";
import type { FooterShortcut } from "../../ui/footer.ts";
import type { Notice } from "../../ui/messages.ts";
import { uiTheme } from "../../ui/theme.ts";
import { PopupFrame } from "../../ui/popup-frame.ts";
import { SearchPopupLayout, centerPopup } from "../../ui/popup-layout.ts";
import { paintText } from "../../ui/theme-styles.ts";
import { singleLine, truncateCells } from "../../ui/text.ts";
import { SearchInput } from "../../ui/search-input.ts";
import { halfPageStep } from "../../ui/navigation.ts";
import { StatusIndicator, sessionSpinnerStyle } from "./status-indicator.ts";
import { formatRequestCaption } from "./request-caption.ts";

type Actions = {
  details(id: string): ExecutionState | null;
  open(worktreeId: string, sessionId: string): void;
  changed(): void;
  fallback(): void;
  notice: Notice;
  warning?(): string;
  keyHint(command: CommandId, context: KeyContext): string;
};
type Candidate = { root: BoxRenderable; scope: TextRenderable; text: TextRenderable; status: StatusIndicator; item: MonitoredSession };
const maximumCandidates = 200;

// This popup owns browsing only. Candidate movement never acknowledges a result.
export class SessionMonitor {
  readonly root: BoxRenderable;
  readonly search: SearchInput;
  readonly list: ScrollBoxRenderable;
  private readonly panel: BoxRenderable;
  private readonly layout: SearchPopupLayout;
  private readonly message: TextRenderable;
  private readonly rows: Candidate[] = [];
  private repositories: readonly Repository[] = [];
  private items: readonly MonitoredSession[] = [];
  private cursor = 0;
  private owner: Renderable | undefined;
  private signature = "";
  private disposed = false;
  private readonly listenerBudget: number;

  constructor(private readonly renderer: CliRenderer, private readonly actions: Actions) {
    this.listenerBudget = renderer.getMaxListeners() === 0 ? 0 : 4;
    if (this.listenerBudget) renderer.setMaxListeners(renderer.getMaxListeners() + this.listenerBudget);
    this.root = new BoxRenderable(renderer, { id: "session-monitor", position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 4900, visible: false,
      onMouseDown: event => event.stopPropagation(), onMouseScroll: event => event.stopPropagation() });
    this.panel = new PopupFrame(renderer, { id: "monitor-dialog", position: "absolute", border: false, paddingX: 0, minWidth: 0, minHeight: 0, flexDirection: "column" });
    this.search = new SearchInput(renderer, { id: "monitor-search", title: "Sessions" });
    this.message = new TextRenderable(renderer, { id: "monitor-message", height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    this.list = new ScrollBoxRenderable(renderer, { id: "monitor-list", width: "100%", flexGrow: 1, minHeight: 0, minWidth: 0, scrollX: false,
      contentOptions: { flexDirection: "column" }, onMouseDown: () => this.list.focus() });
    this.layout = new SearchPopupLayout(renderer, { id: "monitor", search: this.search, message: this.message, list: this.list });
    this.panel.add(this.layout.root); this.root.add(this.panel);
    const theme = uiTheme(renderer);
    theme.scrollbars(this.list);
    theme.bindStyles(this.root, styles => {
      this.root.backgroundColor = styles["ui.backdrop"].bg;
      this.panel.backgroundColor = styles["ui.popup"].bg;
      paintText(this.message, styles["ui.muted"]); this.paint();
    });
    this.search.on(InputRenderableEvents.INPUT, this.filter);
    renderer.on("resize", this.resize); this.resize();
  }

  get visible(): boolean { return !this.disposed && this.root.visible; }
  get context(): KeyContext { return this.search.focused ? "monitor-search" : "monitor"; }
  get focusTargets(): Renderable[] { return [this.search, this.list]; }
  get shortcuts(): readonly FooterShortcut[] {
    const hint = (command: CommandId, label: string) => ({ key: footerKeyHint(command, this.context, this.actions.keyHint(command, this.context)), label });
    return [...(this.items.length ? [hint("monitor.open", "Open")] : []), hint("monitor.dismiss", "Close"), hint("monitor.next", "Next"), hint("monitor.previous", "Previous"), hint("monitor.half-page-down", "½ page")];
  }

  update(repositories: readonly Repository[]): void {
    this.repositories = repositories;
    if (this.visible) this.refresh();
  }
  show(): void {
    if (this.disposed) return;
    if (this.visible) { this.search.focus(); return; }
    this.owner = this.renderer.currentFocusedRenderable ?? undefined;
    this.root.visible = true; this.signature = ""; this.search.value = "";
    this.resize(); this.refresh(); this.search.focus(); this.actions.changed();
    const warning = this.actions.warning?.(); if (warning) this.actions.notice(warning, { level: "warning" });
  }
  hide(restoreFocus = true): void {
    if (!this.visible) return;
    this.root.visible = false;
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
    const sessions = monitoredSessions(this.repositories);
    const matches = this.search.value ? monitoredSessions(this.repositories, this.search.value) : sessions;
    this.search.setCounts({ matched: matches.length, total: sessions.length });
    this.items = matches.slice(0, maximumCandidates);
    const index = this.items.findIndex(item => item.session.id === selected);
    this.cursor = index >= 0 ? index : Math.max(0, Math.min(this.cursor, this.items.length - 1));
    const signature = JSON.stringify(this.items.map(item => [item.session.id, item.title, item.worktree, item.repository, item.branch, item.working,
      item.session.attention?.id, item.session.result?.outcome, item.session.status, item.session.subagents.map(child => child.status)]));
    if (signature !== this.signature) {
      this.signature = signature;
      for (const row of this.rows) { row.status.dispose(); row.root.destroyRecursively(); } this.rows.length = 0;
      for (const [index, item] of this.items.entries()) {
        const root = new BoxRenderable(this.renderer, { id: `monitor:${item.session.id}`, height: 2, flexShrink: 0, minWidth: 0, flexDirection: "column",
          onMouseDown: event => { if (event.button === 0) { event.preventDefault(); event.stopPropagation(); this.list.focus(); this.cursor = index; this.paint(); } } });
        const heading = new BoxRenderable(this.renderer, { width: "100%", height: 1, flexShrink: 0, minWidth: 0, flexDirection: "row", gap: 1 });
        let row: Candidate | undefined;
        const status = new StatusIndicator(this.renderer, () => { if (row) this.paintCaption(row); }); status.root.id = `monitor-status:${item.session.id}`;
        const scope = new TextRenderable(this.renderer, { id: `monitor-scope:${item.session.id}`, height: 1, flexGrow: 1, minWidth: 0, wrapMode: "none", selectable: false });
        const text = new TextRenderable(this.renderer, { id: `monitor-caption:${item.session.id}`, width: "100%", height: 1, flexShrink: 0, minWidth: 0, wrapMode: "none", selectable: false });
        row = { root, scope, text, status, item };
        root.onSizeChange = scope.onSizeChange = () => { if (row) this.paintCaption(row); };
        heading.add(status.root); heading.add(scope); root.add(heading); root.add(text); this.list.add(root); this.rows.push(row);
      }
    }
    this.message.content = matches.length > maximumCandidates ? `Showing first ${maximumCandidates} of ${matches.length} sessions; refine search` : "";
    this.message.visible = matches.length > maximumCandidates;
    this.layout.results.showEmpty(!this.items.length ? this.search.value ? "No matching sessions" : "No working sessions or unread results" : undefined);
    this.paint();
  }
  private paint(): void {
    if (!this.rows) return;
    const styles = uiTheme(this.renderer).styles;
    this.rows.forEach((row, index) => {
      row.root.backgroundColor = styles[index === this.cursor ? "ui.selection" : "ui.popup"].bg;
      const item = this.items[index]; if (item) row.status.update(item.working ? "working" : item.session.status, this.visible, item.session,
        sessionSpinnerStyle(this.visible ? this.actions.details(item.session.id) : null));
      this.paintCaption(row);
    });
    const row = this.rows[this.cursor]; if (row) this.list.scrollChildIntoView(row.root.id);
    this.actions.changed();
  }
  private paintCaption(row: Candidate): void {
    if (row.root.isDestroyed) return;
    const width = Math.max(0, row.root.width - (row.status.root.visible ? row.status.root.width + 1 : 0));
    const tree = singleLine(row.item.worktree), branch = singleLine(row.item.branch ?? "detached HEAD");
    // Scope and request each own a line, so long requests cannot squeeze out either scope field.
    const treePrefix = `${icons.folder} `, branchPrefix = `${icons.branch} `, separator = " · ";
    const scopeBudget = Math.max(0, width - Bun.stringWidth(treePrefix + separator + branchPrefix));
    const branchBudget = Math.min(Bun.stringWidth(branch), scopeBudget - Math.min(Bun.stringWidth(tree), Math.ceil(scopeBudget / 2)));
    const treeText = truncateCells(tree, scopeBudget - branchBudget);
    const branchText = truncateCells(branch, scopeBudget - Bun.stringWidth(treeText));
    const styles = uiTheme(this.renderer).styles;
    row.scope.content = truncateCells(`${treePrefix}${treeText}${separator}${branchPrefix}${branchText}`, width);
    paintText(row.scope, styles["ui.label"]);
    row.text.content = formatRequestCaption({ text: row.item.title, images: 0, files: 0 }, row.root.width, true);
    paintText(row.text, styles["ui.muted"]);
  }
  command(command: CommandId): void {
    if (!this.visible) return;
    if (command === "monitor.dismiss") { this.hide(); return; }
    if (command === "monitor.search") { this.search.focus(); return; }
    if (command === "monitor.open") {
      const item = this.items[this.cursor]; if (!item) return;
      this.hide(false); this.actions.open(item.worktreeId, item.session.id); return;
    }
    if (command === "monitor.first") this.cursor = 0;
    else if (command === "monitor.last") this.cursor = this.items.length - 1;
    else if (command === "monitor.next" || command === "monitor.previous") this.cursor += command === "monitor.next" ? 1 : -1;
    else if (command === "monitor.half-page-up" || command === "monitor.half-page-down") {
      const direction = command === "monitor.half-page-up" ? -1 : 1;
      if (this.search.focused) this.list.focus();
      this.cursor += direction * halfPageStep(this.layout.listHeight, 2);
    } else return;
    this.cursor = Math.max(0, Math.min(this.items.length - 1, this.cursor)); this.paint();
  }
  private resize = (): void => {
    if (this.disposed) return;
    const width = Math.max(1, Math.floor(this.renderer.width * 0.8));
    const height = Math.max(1, Math.min(18, Math.floor(this.renderer.height * 0.8)));
    this.search.fit(height - 4);
    centerPopup(this.panel, width, height, this.renderer.width, this.renderer.height);
    this.layout.resize(false); this.actions.changed();
  };
  dispose(): void {
    if (this.disposed) return;
    this.hide(false); this.disposed = true;
    for (const row of this.rows) row.status.dispose();
    this.search.off(InputRenderableEvents.INPUT, this.filter); this.renderer.off("resize", this.resize);
    if (!this.root.isDestroyed) this.root.destroyRecursively();
    if (this.listenerBudget) this.renderer.setMaxListeners(Math.max(1, this.renderer.getMaxListeners() - this.listenerBudget));
  }
}
