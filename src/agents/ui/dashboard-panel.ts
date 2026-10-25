import { BoxRenderable, ScrollBoxRenderable, StyledText, TextRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import type { DashboardCategory, DashboardMetric, DashboardPeriod, DashboardSnapshot } from "../dashboard.ts";
import type { Result } from "../../result.ts";
import { reportUnexpected, type ExpectedError } from "../../errors.ts";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import { footerKeyHint } from "../../keybindings/footer.ts";
import type { FooterShortcut } from "../../ui/footer.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import { uiTheme } from "../../ui/theme.ts";
import { PopupFrame } from "../../ui/popup-frame.ts";
import { paintText, styleChunk } from "../../ui/theme-styles.ts";
import { singleLine, truncateCells } from "../../ui/text.ts";
import { halfPageStep } from "../../ui/navigation.ts";
import { dashboardBars, dashboardTrend, dashboardValue } from "./dashboard-charts.ts";

type Project = { id: string; name: string };
type Strip = { root: BoxRenderable; text: TextRenderable[]; labels: string[]; index: number; change: (index: number) => void; compact?: boolean };
export type DashboardActions = {
  load?: (days: DashboardPeriod, repositoryId?: string, signal?: AbortSignal) => Promise<Result<DashboardSnapshot, ExpectedError>>;
  projects: () => readonly Project[];
  changed: () => void;
  fallback: () => void;
  keyHint: (command: CommandId, context: KeyContext) => string;
};
const categories: DashboardCategory[] = ["skills", "models", "mcp", "subagents"];
const metrics: DashboardMetric[] = ["tokens", "runs", "durationMs"];
const periods: DashboardPeriod[] = [1, 7, 30];

// A read-only statistics surface. Filters and tab strips own input; SDK writers stay in the runtime.
export class DashboardPanel {
  readonly root: BoxRenderable;
  private readonly panel: BoxRenderable;
  private readonly scroll: ScrollBoxRenderable;
  private readonly summary: TextRenderable;
  private readonly graph: TextRenderable;
  private readonly ranking: TextRenderable;
  private readonly message: TextRenderable;
  private readonly notes: TextRenderable;
  private readonly spinner: LoadingSpinner;
  private readonly period: Strip;
  private readonly project: Strip;
  private readonly metric: Strip;
  private readonly category: Strip;
  private projects: readonly Project[] = [];
  private snapshot: DashboardSnapshot | undefined;
  private owner: Renderable | undefined;
  private request: AbortController | undefined;
  private revision = 0;
  private disposed = false;
  private loading = false;
  private error = "";

  constructor(private readonly renderer: CliRenderer, private readonly actions: DashboardActions) {
    const theme = uiTheme(renderer);
    this.root = new BoxRenderable(renderer, { id: "agent-dashboard", position: "absolute", width: "100%", height: "100%", zIndex: 5300, visible: false,
      onMouseDown: event => event.stopPropagation(), onMouseScroll: event => event.stopPropagation() });
    this.panel = new PopupFrame(renderer, { id: "dashboard-dialog", position: "absolute", border: true, paddingX: 1, flexDirection: "column", minWidth: 0, minHeight: 0 });
    const header = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", gap: 1 });
    const title = new TextRenderable(renderer, { content: "Agent Dashboard", height: 1, flexGrow: 1, minWidth: 0, wrapMode: "none", selectable: false });
    this.spinner = new LoadingSpinner(renderer, { id: "dashboard-loading" });
    header.add(title); header.add(this.spinner.root); this.panel.add(header);
    this.period = this.strip("dashboard-period", ["Today", "7 days", "30 days"], () => this.reload()); this.period.index = 1;
    this.project = this.strip("dashboard-project", ["All projects"], () => this.reload(), true);
    this.panel.add(this.period.root); this.panel.add(this.project.root);
    this.message = this.text("dashboard-message"); this.panel.add(this.message);
    this.scroll = new ScrollBoxRenderable(renderer, { id: "dashboard-body", flexGrow: 1, minHeight: 0, minWidth: 0, scrollX: false,
      contentOptions: { flexDirection: "column", paddingRight: 1 }, onMouseDown: () => this.scroll.focus() });
    this.summary = this.text("dashboard-summary", 3); this.scroll.add(this.summary);
    this.metric = this.strip("dashboard-metric", ["Tokens", "Runs", "Run time"], () => this.paint()); this.scroll.add(this.metric.root);
    this.graph = this.text("dashboard-trend", 6); this.scroll.add(this.graph);
    this.category = this.strip("dashboard-category", ["Skills", "Models", "MCP", "Subagents"], () => { this.paint(); this.scroll.scrollChildIntoView(this.ranking.id); });
    this.scroll.add(this.category.root);
    this.ranking = this.text("dashboard-ranking"); this.scroll.add(this.ranking);
    this.notes = new TextRenderable(renderer, { id: "dashboard-notes", width: "100%", height: "auto", minHeight: 1, flexShrink: 0, selectable: false, wrapMode: "word", marginTop: 1 }); this.scroll.add(this.notes);
    this.panel.add(this.scroll); this.root.add(this.panel);
    theme.scrollbars(this.scroll);
    theme.bindStyles(this.root, styles => {
      this.root.backgroundColor = styles["ui.backdrop"].bg; this.panel.backgroundColor = styles["ui.popup"].bg; this.panel.borderColor = styles["ui.popupBorder"].fg;
      paintText(title, styles["ui.popupTitle"]); paintText(this.spinner.root, styles["status.working"]);
      paintText(this.message, styles["ui.muted"]); paintText(this.graph, styles["metadata.meter"]); paintText(this.ranking, styles["ui.label"]); paintText(this.notes, styles["ui.muted"]);
      this.paint();
    });
    renderer.on("resize", this.resize); renderer.on("focused_renderable", this.keepFocus); this.resize();
  }
  private text(id: string, height = 1): TextRenderable {
    return new TextRenderable(this.renderer, { id, width: "100%", height, flexShrink: 0, selectable: false, wrapMode: "none" });
  }
  private strip(id: string, labels: string[], change: Strip["change"], compact = false): Strip {
    const root = new BoxRenderable(this.renderer, { id, height: 1, width: "100%", flexShrink: 0, focusable: true, flexDirection: "row", overflow: "hidden" });
    const strip: Strip = { root, labels, index: 0, change, text: [], compact };
    const count = compact ? 1 : labels.length;
    for (let index = 0; index < count; index++) {
      const text = new TextRenderable(this.renderer, { height: 1, flexShrink: 0, wrapMode: "none", selectable: false,
        onMouseDown: event => {
          if (event.button !== 0) return;
          event.preventDefault(); event.stopPropagation(); root.focus();
          strip.index = compact ? (strip.index + 1) % strip.labels.length : index; strip.change(strip.index); this.paint();
        } });
      root.add(text); strip.text.push(text);
    }
    root.on("focused", () => { this.paint(); this.scroll?.scrollChildIntoView(root.id); }); root.on("blurred", () => this.paint());
    return strip;
  }
  get visible(): boolean { return !this.disposed && this.root.visible; }
  get context(): KeyContext { return this.focusedStrip() ? "dashboard-tabs" : "dashboard"; }
  get focusTargets(): Renderable[] { return [this.period.root, this.project.root, this.metric.root, this.category.root, this.scroll]; }
  get shortcuts(): readonly FooterShortcut[] {
    return ([ ["dashboard.previous", this.focusedStrip() ? "Previous" : "Up"], ["dashboard.next", this.focusedStrip() ? "Next" : "Down"],
      ["focus.next", "Section"], ["dashboard.half-page-down", "½ page"], ["dashboard.refresh", "Refresh"], ["dashboard.dismiss", "Close"] ] as const)
      .map(([command, label]) => ({ key: footerKeyHint(command, this.context, this.actions.keyHint(command, this.context)), label }));
  }
  show(): void {
    if (this.disposed) return;
    if (!this.visible) this.owner = this.renderer.currentFocusedRenderable ?? undefined;
    const selectedId = this.projects[this.project.index - 1]?.id;
    this.projects = this.actions.projects(); this.project.labels = ["All projects", ...this.projects.map(project => project.name)];
    this.project.index = selectedId ? Math.max(0, this.projects.findIndex(project => project.id === selectedId) + 1) : 0;
    this.root.visible = true; this.resize(); this.category.root.focus(); this.reload();
  }
  hide(restoreFocus = true): void {
    if (!this.visible) return;
    this.root.visible = false; this.revision++; this.request?.abort(); this.spinner.cancel(); this.loading = false;
    const owner = this.owner; this.owner = undefined;
    if (restoreFocus) {
      let visible = !!owner && !owner.isDestroyed;
      for (let node = owner; node; node = node.parent as Renderable | undefined) visible &&= node.visible;
      if (visible && owner) owner.focus(); else this.actions.fallback();
    }
    this.actions.changed();
  }
  private focusedStrip(): Strip | undefined { return [this.period, this.project, this.metric, this.category].find(strip => strip?.root.focused); }
  command(command: CommandId): void {
    if (command === "dashboard.dismiss") { this.hide(); return; }
    if (command === "dashboard.refresh") { this.reload(); return; }
    const strip = this.focusedStrip();
    if (command === "dashboard.next" || command === "dashboard.previous") {
      const direction = command === "dashboard.next" ? 1 : -1;
      if (strip) { strip.index = (strip.index + direction + strip.labels.length) % strip.labels.length; strip.change(strip.index); this.paint(); }
      else this.scroll.scrollBy(direction);
    } else if (command === "dashboard.half-page-down" || command === "dashboard.half-page-up") {
      this.scroll.focus(); this.scroll.scrollBy((command === "dashboard.half-page-down" ? 1 : -1) * halfPageStep(this.scroll.viewport.height));
    } else if (command === "dashboard.first") this.scroll.scrollTo(0);
    else if (command === "dashboard.last") this.scroll.scrollTo(this.scroll.scrollHeight);
    this.actions.changed();
  }
  private reload(): void {
    const revision = ++this.revision; this.request?.abort(); const request = this.request = new AbortController();
    this.snapshot = undefined; this.error = ""; this.loading = !!this.actions.load; this.scroll.scrollTo(0);
    if (this.loading) this.spinner.start(); else this.error = "Dashboard data is unavailable in this view.";
    this.paint();
    if (!this.actions.load) return;
    const pending = this.actions.load(periods[this.period.index]!, this.projects[this.project.index - 1]?.id, request.signal);
    void pending.then(result => {
      if (!this.visible || revision !== this.revision) return;
      if (result.ok) this.snapshot = result.value; else this.error = `[${result.error.code}] ${result.error.message}`;
    }).catch(error => {
      const message = reportUnexpected(error, "agent dashboard");
      if (this.visible && revision === this.revision) this.error = message;
    }).finally(() => {
      if (this.visible && revision === this.revision) { this.loading = false; this.spinner.stop(); this.paint(); }
    });
  }
  private paint(): void {
    if (!this.summary || this.disposed) return;
    const styles = uiTheme(this.renderer).styles, width = Math.max(1, this.panel.width - 5);
    for (const strip of [this.period, this.project, this.metric, this.category]) {
      const slot = Math.max(1, Math.floor(width / strip.text.length));
      strip.text.forEach((text, index) => {
        const active = strip.compact || index === strip.index;
        const label = strip.compact ? `Project ‹ ${singleLine(strip.labels[strip.index] ?? "All projects")} ›` : ` ${strip.labels[index]} `;
        text.width = strip.compact ? width : slot; text.content = truncateCells(label, strip.compact ? width : slot);
        paintText(text, styles[active ? strip.root.focused ? "ui.buttonFocused" : "ui.tabActive" : "ui.tab"]);
      });
    }
    const snapshot = this.snapshot;
    this.message.content = this.loading ? "Loading saved session statistics…" : this.error || (snapshot?.warnings.length ? `Partial data · ${snapshot.warnings.join(" ")}` : "Saved history · local calendar days");
    paintText(this.message, styles[this.error || snapshot?.warnings.length ? "status.warning" : "ui.muted"]);
    const totals = snapshot?.totals;
    const values = [totals ? dashboardValue(totals.tokens) : "—", totals ? dashboardValue(totals.runs, "runs") : "—", totals ? dashboardValue(totals.durationMs, "durationMs") : "—"];
    const labels = ["Total tokens", "Runs", "Total run time"], slot = Math.max(1, Math.floor(width / 3));
    const chunks = [styleChunk(labels.map(label => truncateCells(label, slot - 1).padEnd(slot)).join("") + "\n", styles["ui.muted"]),
      styleChunk(values.map(value => truncateCells(value, slot - 1).padEnd(slot)).join("") + "\n", styles["ui.popupTitle"])];
    this.summary.content = new StyledText(chunks);
    const metric = metrics[this.metric.index]!, graph = snapshot ? dashboardTrend(snapshot.daily, metric, width, this.renderer.height < 25 ? 2 : 4) : [];
    this.graph.height = Math.max(2, graph.length + 1); this.graph.content = graph.join("\n");
    const category = categories[this.category.index]!, rows = snapshot?.[category] ?? [];
    const ranking = snapshot ? dashboardBars(rows, width) : [this.loading ? "Loading…" : "No statistics available."];
    this.ranking.height = ranking.length + 1;
    this.ranking.content = new StyledText([styleChunk(category === "models" ? "Model usage · tokens\n" : "Resource usage · calls\n", styles["ui.muted"]), styleChunk(ranking.join("\n"), styles["ui.label"])]);
    this.notes.content = "Tokens include input, output and cache. Runs/time include recorded settled runs; overlapping durations are summed. Skills combine explicit calls and successful loads. Only observed MCP/subagent calls are counted."
      + (snapshot?.warnings.length ? `\n\nCoverage warnings\n${snapshot.warnings.join("\n")}` : "");
    this.actions.changed();
  }
  private keepFocus = (): void => {
    if (!this.visible) return;
    for (let node = this.renderer.currentFocusedRenderable; node; node = node.parent as Renderable | null) if (node === this.root) return;
    this.category.root.focus();
  };
  private resize = (): void => {
    if (this.disposed) return;
    const width = Math.max(1, Math.min(120, this.renderer.width - 4)), height = Math.max(1, this.renderer.height - 3);
    this.panel.width = width; this.panel.height = height; this.panel.left = Math.floor((this.renderer.width - width) / 2); this.panel.top = Math.floor((this.renderer.height - height) / 2);
    this.paint();
  };
  dispose(): void {
    if (this.disposed) return;
    this.hide(false); this.disposed = true; this.spinner.cancel(); this.request?.abort();
    this.renderer.off("resize", this.resize); this.renderer.off("focused_renderable", this.keepFocus);
    if (!this.root.isDestroyed) this.root.destroyRecursively();
  }
}
