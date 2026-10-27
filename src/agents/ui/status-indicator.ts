import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import type { AgentStatus, OpenSession } from "../model.ts";
import type { ExecutionState } from "../session-registry.ts";
import { icons } from "../../icons.ts";
import { LoadingSpinner, type SpinnerStyle } from "../../ui/loading-spinner.ts";
import { uiTheme } from "../../ui/theme.ts";
import { paintText, type StyleGroup } from "../../ui/theme-styles.ts";

type Indicator = { icon: string; color: StyleGroup };

export function sessionSpinnerStyle(state: ExecutionState | null | undefined): SpinnerStyle {
  if (state?.status === "working" && state.activity === "compacting") return "circle-fill";
  return state?.telemetry?.fast === true ? "fast" : "default";
}

function display(
  status: AgentStatus | null,
  session?: Pick<OpenSession, "result" | "attention">,
): Indicator {
  const result = session?.result;
  if (status === "working") return { icon: "", color: "status.working" };
  if (status === "failure" || result?.outcome === "error")
    return { icon: icons.failure, color: "status.error" };
  if (result?.outcome === "unfinished") return { icon: "?", color: "status.error" };
  // Keep older unread results visible when a newer run is intentionally cancelled.
  if (session?.attention) return { icon: icons.bell, color: "status.attention" };
  switch (result?.outcome) {
    case "complete":
      return { icon: icons.pass, color: "status.success" };
    case "cancelled":
      return { icon: icons.cancelled, color: "ui.muted" };
    default:
      return { icon: "", color: "status.unknown" };
  }
}

// One slot: working > failure > stopped > unread > settled result. Only Fast loading uses three fixed cells.
export class StatusIndicator {
  readonly root: BoxRenderable;
  private readonly spinner: LoadingSpinner;
  private readonly animation: BoxRenderable;
  private readonly icon: TextRenderable;
  private iconStyle: StyleGroup = "status.attention";
  private hasIcon = false;
  private status: AgentStatus | null | undefined;
  private visible = false;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly changed?: () => void,
  ) {
    this.root = new BoxRenderable(renderer, {
      width: 1,
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      visible: false,
      renderBefore: () => this.syncVisibility(),
      onSizeChange: () => this.changed?.(),
    });
    this.animation = new BoxRenderable(renderer, { width: 1, height: 1, flexShrink: 0 });
    this.spinner = new LoadingSpinner(renderer);
    this.icon = new TextRenderable(renderer, {
      width: 1,
      height: 1,
      wrapMode: "none",
      selectable: false,
      visible: false,
    });
    this.animation.add(this.spinner.root);
    this.root.add(this.icon);
    this.root.add(this.animation);
    uiTheme(renderer).bindStyles(this.root, (styles) => {
      paintText(this.icon, styles[this.iconStyle]);
      paintText(this.spinner.root, styles["status.working"]);
    });
  }

  update(
    status: AgentStatus | null,
    visible: boolean,
    session?: Pick<OpenSession, "result" | "attention">,
    style: SpinnerStyle = "default",
  ): void {
    if (this.root.isDestroyed) return;
    const changed = status !== this.status || visible !== this.visible;
    this.status = status;
    this.visible = visible;
    this.spinner.setStyle(style);
    this.animation.width = this.spinner.columns;
    const { icon, color } = display(status, session);
    this.iconStyle = color;
    this.hasIcon = icon !== "";
    this.icon.content = icon;
    // A settled badge supersedes the spinner tail immediately. Cancelling the hidden
    // animation also prevents it from returning when a completed result is acknowledged.
    if (!visible || this.hasIcon) this.spinner.cancel();
    else if (changed && status === "working") this.spinner.start();
    else if (status !== "working") this.spinner.stop();
    paintText(this.icon, uiTheme(this.renderer).styles[this.iconStyle]);
    this.syncVisibility();
  }

  private syncVisibility(): void {
    if (this.root.isDestroyed) return;
    this.icon.visible = this.visible && this.hasIcon;
    this.animation.visible = this.visible && !this.hasIcon && this.spinner.root.visible;
    const visible = this.icon.visible || this.animation.visible;
    const width = this.animation.visible ? this.spinner.columns : 1;
    if (this.root.visible === visible && this.root.width === width) return;
    this.root.width = width;
    this.root.visible = visible;
    this.changed?.();
    this.renderer.requestRender();
  }

  dispose(): void {
    this.spinner.cancel();
  }
}
