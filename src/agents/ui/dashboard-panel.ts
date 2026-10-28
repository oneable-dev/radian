import {
  BoxRenderable,
  ScrollBoxRenderable,
  StyledText,
  TextRenderable,
  type CliRenderer,
  type Renderable,
} from "@opentui/core";
import type {
  DashboardCategory,
  DashboardMetric,
  DashboardPeriod,
  DashboardSnapshot,
} from "../dashboard.ts";
import type { Result } from "../../result.ts";
import { reportUnexpected, type ExpectedError } from "../../errors.ts";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import { footerKeyHint } from "../../keybindings/footer.ts";
import type { FooterShortcut } from "../../ui/footer.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import { uiTheme } from "../../ui/theme.ts";
import { PopupBody, attachPopupActivity } from "../../ui/popup-layout.ts";
import { paintText, styleChunk } from "../../ui/theme-styles.ts";
import { singleLine, truncateCells } from "../../ui/text.ts";
import { halfPageStep } from "../../ui/navigation.ts";
import { dashboardBars, dashboardTrend, dashboardValue } from "./dashboard-charts.ts";
import { ResourcePanel } from "./resource-panel.ts";
import type { ResourceLoader } from "../../usage/process-resources.ts";
import type { WorkspaceResourceLoader } from "../../usage/workspace-resources.ts";
import type { DialogContent } from "../../ui/text-dialog.ts";

type Project = { id: string; name: string };

type Strip = {
  root: BoxRenderable;
  text: TextRenderable[];
  labels: string[];
  index: number;
  change: (index: number) => void;
  compact?: boolean;
};

export type DashboardActions = {
  resources?: ResourceLoader;
  workspaces?: WorkspaceResourceLoader;
  details?: (content: DialogContent) => void;
  load?: (
    days: DashboardPeriod,
    repositoryId?: string,
    signal?: AbortSignal,
  ) => Promise<Result<DashboardSnapshot, ExpectedError>>;
  projects: () => readonly Project[];
  changed: () => void;
  visibilityChanged?: () => void;
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
  private readonly resources: ResourcePanel;
  private readonly historyBody: BoxRenderable;
  private readonly historyHeading: TextRenderable;
  private readonly summary: TextRenderable;
  private readonly graph: TextRenderable;
  private readonly ranking: TextRenderable;
  private readonly rankingBody: PopupBody;
  private readonly message: TextRenderable;
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
  private revealRankingPending = false;
  private revealErrorPending = false;
  private contentWidth = 1;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly actions: DashboardActions,
  ) {
    const theme = uiTheme(renderer);
    this.root = new BoxRenderable(renderer, {
      id: "agent-dashboard",
      width: "100%",
      flexGrow: 1,
      minWidth: 0,
      minHeight: 0,
      flexDirection: "column",
      visible: false,
      onMouseDown: (event) => event.stopPropagation(),
      onMouseScroll: (event) => event.stopPropagation(),
    });
    this.panel = new BoxRenderable(renderer, {
      id: "dashboard-panel",
      width: "100%",
      height: "100%",
      paddingX: 1,
      flexDirection: "column",
      minWidth: 0,
      minHeight: 0,
    });
    this.spinner = new LoadingSpinner(renderer, { id: "dashboard-loading" });
    this.period = this.strip("dashboard-period", ["Today", "7 days", "30 days"], () =>
      this.reload(),
    );
    this.period.index = 1;
    this.project = this.strip("dashboard-project", ["All projects"], () => this.reload(), true);
    this.message = this.text("dashboard-message");
    this.scroll = new ScrollBoxRenderable(renderer, {
      id: "dashboard-body",
      flexGrow: 1,
      minHeight: 0,
      minWidth: 0,
      scrollX: false,
      contentOptions: { flexDirection: "column", paddingRight: 1 },
      onMouseDown: () => this.scroll.focus(),
    });
    this.resources = new ResourcePanel(renderer, actions.resources, actions.workspaces);
    this.scroll.add(this.resources.root);
    this.historyHeading = this.text("dashboard-history-heading");
    this.historyHeading.content = "Usage history";
    this.scroll.add(this.historyHeading);
    this.scroll.add(this.period.root);
    this.scroll.add(this.project.root);
    this.historyBody = new BoxRenderable(renderer, {
      id: "dashboard-history-body",
      width: "100%",
      height: "auto",
      flexShrink: 0,
      flexDirection: "column",
    });
    this.scroll.add(this.historyBody);
    this.historyBody.add(this.message);
    this.summary = this.text("dashboard-summary", 2);
    this.historyBody.add(this.summary);
    this.metric = this.strip("dashboard-metric", ["Tokens", "Runs", "Run time"], () =>
      this.paint(),
    );
    this.historyBody.add(this.metric.root);
    this.graph = this.text("dashboard-trend", 6);
    this.historyBody.add(this.graph);
    this.category = this.strip(
      "dashboard-category",
      ["Skills", "Models", "MCP", "Subagents"],
      () => {
        this.paint();
        this.revealRankingPending = true;
      },
    );
    this.historyBody.add(this.category.root);
    this.ranking = this.text("dashboard-ranking");
    this.rankingBody = new PopupBody(renderer, "dashboard-ranking-body", this.ranking);
    this.rankingBody.root.flexGrow = 0;
    this.rankingBody.root.flexShrink = 0;
    this.historyBody.add(this.rankingBody.root);
    this.panel.add(this.scroll);
    attachPopupActivity(renderer, this.panel, this.spinner.root, () => ({
      pending: this.loading,
      hasContent: this.snapshot !== undefined || Boolean(this.error),
      message: "Loading saved session statistics…",
      body: this.historyBody,
    }));
    this.root.add(this.panel);
    theme.scrollbars(this.scroll);
    theme.bindStyles(this.root, (styles) => {
      this.root.backgroundColor = styles["ui.text"].bg;
      this.panel.backgroundColor = styles["ui.text"].bg;
      paintText(this.spinner.root, styles["status.working"]);
      paintText(this.historyHeading, styles["ui.label"]);
      paintText(this.message, styles["ui.muted"]);
      paintText(this.graph, styles["metadata.meter"]);
      paintText(this.ranking, styles["ui.label"]);
      this.paint();
    });
    renderer.on("resize", this.resize);
    renderer.addPostProcessFn(this.revealRanking);
    this.resize();
  }

  private text(id: string, height = 1): TextRenderable {
    return new TextRenderable(this.renderer, {
      id,
      width: "100%",
      height,
      flexShrink: 0,
      selectable: false,
      wrapMode: "none",
    });
  }

  private strip(id: string, labels: string[], change: Strip["change"], compact = false): Strip {
    const root = new BoxRenderable(this.renderer, {
      id,
      height: 1,
      width: "100%",
      flexShrink: 0,
      focusable: true,
      flexDirection: "row",
      overflow: "hidden",
    });
    const strip: Strip = { root, labels, index: 0, change, text: [], compact };
    const count = compact ? 1 : labels.length;
    for (let index = 0; index < count; index++) {
      const text = new TextRenderable(this.renderer, {
        height: 1,
        flexShrink: 0,
        wrapMode: "none",
        selectable: false,
        onMouseDown: (event) => {
          if (event.button !== 0) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();
          root.focus();
          strip.index = compact ? (strip.index + 1) % strip.labels.length : index;
          strip.change(strip.index);
          this.paint();
        },
      });
      root.add(text);
      strip.text.push(text);
    }

    root.on("focused", () => {
      this.paint();
      this.scroll?.scrollChildIntoView(root.id);
      if (root === this.category?.root) {
        this.revealRankingPending = true;
      }
    });
    root.on("blurred", () => this.paint());

    return strip;
  }

  get visible(): boolean {
    return !this.disposed && this.root.visible;
  }

  get context(): KeyContext {
    return this.focusedStrip() ? "dashboard-tabs" : "dashboard";
  }

  get focusTargets(): Renderable[] {
    return [this.scroll, this.period.root, this.project.root, this.metric.root, this.category.root];
  }

  get shortcuts(): readonly FooterShortcut[] {
    return (
      [
        ["dashboard.previous", this.focusedStrip() ? "Previous" : "Up"],
        ["dashboard.next", this.focusedStrip() ? "Next" : "Down"],
        ["focus.next", "Section"],
        ["dashboard.half-page-down", "½ page"],
        ["dashboard.refresh", "Refresh"],
        ["dashboard.details", "Details"],
        ["dashboard.dismiss", "Back"],
      ] as const
    ).map(([command, label]) => ({
      key: footerKeyHint(command, this.context, this.actions.keyHint(command, this.context)),
      label,
    }));
  }

  show(): void {
    if (this.disposed) {
      return;
    }
    if (!this.visible) {
      this.owner = this.renderer.currentFocusedRenderable ?? undefined;
    }

    const selectedId = this.projects[this.project.index - 1]?.id;
    this.projects = this.actions.projects();
    this.project.labels = ["All projects", ...this.projects.map((project) => project.name)];
    this.project.index = selectedId
      ? Math.max(0, this.projects.findIndex((project) => project.id === selectedId) + 1)
      : 0;
    this.root.visible = true;
    this.actions.visibilityChanged?.();
    this.resize();
    this.scroll.focus();
    this.scroll.scrollTo(0);
    this.resources.start();
    this.reload();
  }

  hide(restoreFocus = true): void {
    if (!this.visible) {
      return;
    }

    this.root.visible = false;
    this.revision++;
    this.request?.abort();
    this.spinner.cancel();
    this.resources.stop();
    this.loading = false;
    this.revealRankingPending = false;
    this.actions.visibilityChanged?.();

    const owner = this.owner;
    this.owner = undefined;
    if (restoreFocus) {
      let visible = !!owner && !owner.isDestroyed;
      for (let node = owner; node; node = node.parent as Renderable | undefined) {
        visible &&= node.visible;
      }

      if (visible && owner) {
        owner.focus();
      } else {
        this.actions.fallback();
      }
    }

    this.actions.changed();
  }

  private focusedStrip(): Strip | undefined {
    return [this.period, this.project, this.metric, this.category].find(
      (strip) => strip?.root.focused,
    );
  }

  command(command: CommandId): void {
    if (command === "dashboard.details") {
      this.actions.details?.({
        title: "Usage details",
        text: [
          "Resources",
          "CPU is measured over sampling intervals; all logical CPUs together are 100%. RAM is resident memory (RSS); shared pages can be counted in more than one process. Trends cover the last 60 seconds.",
          "Shared includes this UI and the Runtime. Workspace processes include Radian's editors, terminals and their descendants. In-process Agent work and other shared services remain in Runtime; they cannot be accurately divided by workspace. Unavailable readings are shown as —, not zero.",
          "",
          "Usage history",
          "Saved sessions are grouped by local calendar days. Tokens include input, output and cache. Runs/time include recorded settled runs; overlapping durations are summed. Skills combine explicit calls and successful loads. Only observed MCP/subagent calls are counted.",
          ...(this.snapshot?.warnings.length
            ? ["", "Coverage warnings", ...this.snapshot.warnings]
            : []),
        ].join("\n\n"),
      });

      return;
    }
    if (command === "dashboard.dismiss") {
      this.hide();

      return;
    }
    if (command === "dashboard.refresh") {
      this.resources.refresh();
      this.reload();

      return;
    }

    const strip = this.focusedStrip();
    if (command === "dashboard.next" || command === "dashboard.previous") {
      const direction = command === "dashboard.next" ? 1 : -1;
      if (strip) {
        strip.index = (strip.index + direction + strip.labels.length) % strip.labels.length;
        strip.change(strip.index);
        this.paint();
      } else {
        this.scroll.scrollBy(direction);
      }
    } else if (command === "dashboard.half-page-down" || command === "dashboard.half-page-up") {
      this.scroll.focus();
      this.scroll.scrollBy(
        (command === "dashboard.half-page-down" ? 1 : -1) *
          halfPageStep(this.scroll.viewport.height),
      );
    } else if (command === "dashboard.first") {
      this.scroll.scrollTo(0);
    } else if (command === "dashboard.last") {
      this.scroll.scrollTo(this.scroll.scrollHeight);
    }

    this.actions.changed();
  }

  private reload(): void {
    const revision = ++this.revision;
    this.request?.abort();

    const request = (this.request = new AbortController());
    this.error = "";
    this.revealErrorPending = false;
    this.loading = !!this.actions.load;
    if (this.loading) {
      this.spinner.start();
    } else {
      this.error = "Dashboard data is unavailable in this view.";
    }

    this.paint();
    if (!this.actions.load) {
      return;
    }

    const pending = this.actions.load(
      periods[this.period.index]!,
      this.projects[this.project.index - 1]?.id,
      request.signal,
    );
    void pending
      .then((result) => {
        if (!this.visible || revision !== this.revision) {
          return;
        }
        if (result.ok) {
          this.snapshot = result.value;
        } else {
          this.error = `[${result.error.code}] ${result.error.message}`;
          this.revealErrorPending = true;
        }
      })
      .catch((error) => {
        const message = reportUnexpected(error, "agent dashboard");
        if (this.visible && revision === this.revision) {
          this.error = message;
          this.revealErrorPending = true;
        }
      })
      .finally(() => {
        if (this.visible && revision === this.revision) {
          this.loading = false;
          this.spinner.stop();
          this.paint();
        }
      });
  }

  private paint(): void {
    if (!this.summary || this.disposed) {
      return;
    }

    const styles = uiTheme(this.renderer).styles;
    const width = this.contentWidth;
    for (const strip of [this.period, this.project, this.metric, this.category]) {
      const slot = Math.max(1, Math.floor(width / strip.text.length));
      strip.text.forEach((text, index) => {
        const active = strip.compact || index === strip.index;
        const label = strip.compact
          ? `Project ‹ ${singleLine(strip.labels[strip.index] ?? "All projects")} ›`
          : ` ${strip.labels[index]} `;

        text.width = strip.compact ? width : slot;
        text.content = truncateCells(label, strip.compact ? width : slot);

        let role: "ui.buttonFocused" | "ui.tabActive" | "ui.tab" = "ui.tab";
        if (active) {
          role = strip.root.focused ? "ui.buttonFocused" : "ui.tabActive";
        }

        paintText(text, styles[role]);
      });
    }

    const snapshot = this.snapshot;
    this.message.content = this.loading ? "" : this.error;
    paintText(this.message, styles["status.warning"]);
    this.message.visible = Boolean(this.message.plainText);

    const contentVisible = !!snapshot || !this.loading;
    // Keep an empty data region below the editable strips for centered initial feedback.
    this.historyBody.minHeight = contentVisible ? 0 : 7;
    for (const node of [this.summary, this.graph, this.rankingBody.root]) {
      node.visible = contentVisible;
    }

    const totals = snapshot?.totals;
    const values = [
      totals ? dashboardValue(totals.tokens) : "—",
      totals ? dashboardValue(totals.runs, "runs") : "—",
      totals ? dashboardValue(totals.durationMs, "durationMs") : "—",
    ];
    const labels = ["Total tokens", "Runs", "Total run time"];
    const slot = Math.max(1, Math.floor(width / 3));
    const chunks = [
      styleChunk(
        labels.map((label) => truncateCells(label, slot - 1).padEnd(slot)).join("") + "\n",
        styles["ui.muted"],
      ),
      styleChunk(
        values.map((value) => truncateCells(value, slot - 1).padEnd(slot)).join("") + "\n",
        styles["ui.popupTitle"],
      ),
    ];

    this.summary.content = new StyledText(chunks);

    const metric = metrics[this.metric.index]!;
    const graph = snapshot
      ? dashboardTrend(snapshot.daily, metric, width, this.renderer.height < 25 ? 2 : 4)
      : [];

    this.graph.height = Math.max(2, graph.length + 1);
    this.graph.content = graph.join("\n");

    const category = categories[this.category.index]!;
    const rows = snapshot?.[category] ?? [];
    const ranking = snapshot
      ? dashboardBars(rows, width)
      : [this.loading ? "" : "No statistics available."];
    const empty = !!snapshot && !rows.length;

    this.ranking.height = empty ? 0 : ranking.length + 1;
    this.rankingBody.root.height = empty ? (this.renderer.height < 25 ? 3 : 6) : ranking.length + 1;
    this.rankingBody.showEmpty(empty ? "No recorded usage in this period." : undefined);
    this.ranking.content = empty
      ? ""
      : new StyledText([
          styleChunk(
            category === "models" ? "Model usage · tokens\n" : "Resource usage · calls\n",
            styles["ui.muted"],
          ),
          styleChunk(ranking.join("\n"), styles["ui.label"]),
        ]);

    this.actions.changed();
  }

  private revealRanking = (): void => {
    if (!this.visible || this.root.isDestroyed) {
      return;
    }
    if (this.revealErrorPending) {
      this.revealErrorPending = false;
      this.revealRankingPending = false;
      this.scroll.scrollChildIntoView(this.message.id);

      return;
    }
    if (!this.revealRankingPending) {
      return;
    }

    this.revealRankingPending = false;
    // Wait for the ranking body's new height before revealing the selected resource category.
    this.scroll.scrollChildIntoView(this.rankingBody.root.id);
  };

  private resize = (): void => {
    if (this.disposed) {
      return;
    }

    // Use the incoming work-area width before layout settles; retain only content/scrollbar padding.
    this.contentWidth = Math.max(1, this.renderer.width - 3);
    this.resources.fit(this.contentWidth);
    this.paint();
  };

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.hide(false);
    this.disposed = true;
    this.spinner.cancel();
    this.request?.abort();
    this.resources.dispose();
    this.renderer.off("resize", this.resize);
    this.renderer.removePostProcessFn(this.revealRanking);
    if (!this.root.isDestroyed) {
      this.root.destroyRecursively();
    }
  }
}
