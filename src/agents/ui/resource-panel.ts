import {
  BoxRenderable,
  RenderableEvents,
  StyledText,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core";
import { CapabilityError, reportUnexpected } from "../../errors.ts";
import { err } from "../../result.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import { attachPopupActivity } from "../../ui/popup-layout.ts";
import { uiTheme } from "../../ui/theme.ts";
import { paintText, styleChunk } from "../../ui/theme-styles.ts";
import { singleLine, truncateCells } from "../../ui/text.ts";
import type { WorkspaceResourceLoader } from "../../usage/workspace-resources.ts";
import {
  readProcessResources,
  ResourceHistory,
  type ResourceLoader,
  type ResourceSnapshot,
} from "../../usage/process-resources.ts";
import { resourceCpu, resourceMemory, resourceSparkline } from "./resource-charts.ts";

// This read-only body owns no focus. Sampling must never move the enclosing view's cursor or scroll.
export class ResourcePanel {
  readonly root: BoxRenderable;
  private readonly title: TextRenderable;
  private readonly table: TextRenderable;
  private readonly workspaces: TextRenderable;
  private readonly message: TextRenderable;
  private readonly spinner: LoadingSpinner;
  private history = new ResourceHistory();
  private snapshot: ResourceSnapshot | undefined;
  private owner: AbortController | undefined;
  private timer: ReturnType<CliRenderer["clock"]["setTimeout"]> | undefined;
  private pending = false;
  private error = "";
  private width = 0;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly load?: ResourceLoader,
    private readonly loadWorkspaces?: WorkspaceResourceLoader,
  ) {
    this.root = new BoxRenderable(renderer, {
      id: "dashboard-resources",
      width: "100%",
      height: "auto",
      flexShrink: 0,
      flexDirection: "column",
      marginBottom: 1,
    });
    this.root.on(RenderableEvents.DESTROYED, () => this.stop());
    this.title = new TextRenderable(renderer, {
      content: "Radian resources · live",
      height: 1,
      width: "100%",
      flexShrink: 0,
      minWidth: 0,
      wrapMode: "none",
      selectable: false,
    });
    this.spinner = new LoadingSpinner(renderer, { id: "dashboard-resources-loading" });
    this.root.add(this.title);
    this.table = new TextRenderable(renderer, {
      id: "dashboard-resources-table",
      width: "100%",
      height: 4,
      flexShrink: 0,
      wrapMode: "none",
      selectable: false,
    });
    this.workspaces = new TextRenderable(renderer, {
      id: "dashboard-workspace-resources",
      width: "100%",
      height: "auto",
      flexShrink: 0,
      marginTop: 1,
      wrapMode: "none",
      selectable: false,
      visible: false,
    });
    this.message = new TextRenderable(renderer, {
      id: "dashboard-resources-error",
      width: "100%",
      height: "auto",
      flexShrink: 0,
      wrapMode: "word",
      selectable: false,
      visible: false,
    });
    this.root.add(this.table);
    this.root.add(this.workspaces);
    this.root.add(this.message);
    attachPopupActivity(renderer, this.root, this.spinner.root, () => ({
      pending: this.pending,
      hasContent: this.snapshot !== undefined || Boolean(this.error),
      message: "Reading process resources…",
      body: this.snapshot !== undefined || this.error ? this.root : this.table,
      anchor: this.title,
    }));
    uiTheme(renderer).bindStyles(this.root, (styles) => {
      paintText(this.title, styles["ui.label"]);
      paintText(this.workspaces, styles["ui.label"]);
      paintText(this.message, styles["status.warning"]);
      paintText(this.spinner.root, styles["status.working"]);
      this.paint();
    });
  }

  fit(width: number): void {
    this.width = Math.max(1, width);
    this.paint();
  }

  start(): void {
    if (this.owner || this.root.isDestroyed) {
      return;
    }

    this.history = new ResourceHistory();
    this.snapshot = undefined;
    this.error = "";

    const owner = (this.owner = new AbortController());
    this.spinner.start();
    this.paint();
    void this.poll(owner);
  }

  stop(): void {
    this.owner?.abort();
    this.owner = undefined;
    this.pending = false;
    if (this.timer !== undefined) {
      this.renderer.clock.clearTimeout(this.timer);
    }

    this.timer = undefined;
    this.spinner.cancel();
  }

  refresh(): void {
    if (!this.owner || this.pending) {
      return;
    }
    if (this.timer !== undefined) {
      this.renderer.clock.clearTimeout(this.timer);
    }

    this.timer = undefined;
    void this.poll(this.owner);
  }

  private async poll(owner: AbortController): Promise<void> {
    this.pending = true;
    try {
      const [runtime, workspaces] = await Promise.all([
        this.load
          ? this.load(owner.signal)
          : err(new CapabilityError("Runtime resource metrics are unavailable in this view.")),
        this.loadWorkspaces?.(owner.signal),
      ]);
      if (this.owner !== owner || owner.signal.aborted) {
        return;
      }

      const ui = readProcessResources();
      this.snapshot = this.history.add(
        ui.ok ? ui.value : null,
        runtime.ok ? runtime.value : null,
        this.renderer.clock.now(),
        workspaces?.ok ? workspaces.value : null,
      );
      this.error = [
        ...(!ui.ok ? [`UI [${ui.error.code}]: ${ui.error.message}`] : []),
        ...(!runtime.ok ? [`Runtime [${runtime.error.code}]: ${runtime.error.message}`] : []),
        ...(workspaces && !workspaces.ok
          ? [`Workspaces [${workspaces.error.code}]: ${workspaces.error.message}`]
          : []),
      ].join(" ");
      this.paint();
    } catch (error) {
      const message = reportUnexpected(error, "process resources");
      if (this.owner === owner && !owner.signal.aborted) {
        const ui = readProcessResources();
        this.snapshot = this.history.add(ui.ok ? ui.value : null, null, this.renderer.clock.now());
        this.error = message;
        this.paint();
      }
    } finally {
      if (this.owner === owner && !owner.signal.aborted) {
        this.pending = false;
        this.spinner.stop();
        this.timer = this.renderer.clock.setTimeout(() => {
          this.timer = undefined;
          void this.poll(owner);
        }, 1000);
      }
    }
  }

  private paint(): void {
    if (!this.table || this.root.isDestroyed) {
      return;
    }

    const styles = uiTheme(this.renderer).styles;
    const sparkWidth = this.width >= 66 ? Math.min(16, Math.floor((this.width - 38) / 2)) : 0;
    const cpuWidth = 8;
    const memoryWidth = 11;
    const labelWidth = Math.max(
      1,
      Math.min(
        40,
        this.width - cpuWidth - memoryWidth - 2 - (sparkWidth ? 2 * (sparkWidth + 1) : 0),
      ),
    );
    const labelText = (text: string) => {
      const clipped = truncateCells(
        (text.startsWith("  ") ? "  " : "") + singleLine(text),
        labelWidth,
      );

      return clipped + " ".repeat(labelWidth - Bun.stringWidth(clipped));
    };
    const column = (value: string, size: number) => value.padStart(size);
    const historyGap = sparkWidth ? " ".repeat(sparkWidth + 1) : "";
    const heading =
      " ".repeat(labelWidth) +
      column("CPU", cpuWidth) +
      historyGap +
      "  " +
      column("RAM", memoryWidth) +
      "\n";
    const rows = (
      [
        ["Shared", this.snapshot?.total],
        ["  UI", this.snapshot?.ui],
        ["  Runtime", this.snapshot?.runtime],
      ] as const
    ).map(([label, value], index) => {
      const graph = (metric: "cpuPercent" | "rssBytes") =>
        !sparkWidth
          ? ""
          : " " +
            (index === 0
              ? resourceSparkline(
                  this.history.recent,
                  metric,
                  sparkWidth,
                  this.renderer.clock.now(),
                )
              : " ".repeat(sparkWidth));
      const row =
        labelText(label) +
        column(resourceCpu(value?.cpuPercent), cpuWidth) +
        graph("cpuPercent") +
        "  " +
        column(resourceMemory(value?.rssBytes), memoryWidth) +
        graph("rssBytes");

      return styleChunk(
        truncateCells(row, this.width) + (index < 2 ? "\n" : ""),
        styles[index === 0 ? "ui.popupTitle" : "ui.label"],
      );
    });

    this.table.content = new StyledText([
      styleChunk(truncateCells(heading.trimEnd(), this.width) + "\n", styles["ui.muted"]),
      ...rows,
    ]);
    const workspaces = this.snapshot?.workspaces ?? [];
    this.workspaces.visible = workspaces.length > 0;
    this.workspaces.content = new StyledText([
      styleChunk("Workspace processes\n", styles["ui.muted"]),
      ...workspaces.map((workspace, index) =>
        styleChunk(
          truncateCells(
            labelText(workspace.name) +
              column(resourceCpu(workspace.value?.cpuPercent), cpuWidth) +
              historyGap +
              "  " +
              column(resourceMemory(workspace.value?.rssBytes), memoryWidth),
            this.width,
          ) + (index < workspaces.length - 1 ? "\n" : ""),
          styles["ui.label"],
        ),
      ),
    ]);
    this.message.content = this.error;
    this.message.visible = Boolean(this.error);
  }

  dispose(): void {
    this.stop();
    if (!this.root.isDestroyed) {
      this.root.destroyRecursively();
    }
  }
}
