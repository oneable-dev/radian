import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import type { AgentStatus, OpenSession } from "../model.ts";
import { icons } from "../../icons.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import { uiTheme } from "../../ui/theme.ts";
import { paintText } from "../../ui/theme-styles.ts";

// Execution and unread results are independent: acknowledging a result never changes its outcome.
export class StatusIndicator {
  readonly root: BoxRenderable;
  private readonly spinner: LoadingSpinner;
  private readonly animation: BoxRenderable;
  private readonly outcome: TextRenderable;
  private readonly attention: TextRenderable;
  private status: AgentStatus | null | undefined;
  private stopped = false;
  private unread = false;
  private visible = false;

  constructor(private readonly renderer: CliRenderer, private readonly changed?: () => void) {
    this.root = new BoxRenderable(renderer, { width: 2, height: 1, flexShrink: 0, flexDirection: "row", visible: false,
      renderBefore: () => this.syncVisibility() });
    this.animation = new BoxRenderable(renderer, { width: 1, height: 1, flexShrink: 0 });
    this.spinner = new LoadingSpinner(renderer);
    this.outcome = new TextRenderable(renderer, { width: 1, height: 1, wrapMode: "none", selectable: false, visible: false });
    this.attention = new TextRenderable(renderer, { width: 1, height: 1, wrapMode: "none", selectable: false, visible: false, content: icons.bell });
    this.animation.add(this.spinner.root); this.root.add(this.outcome); this.root.add(this.attention); this.root.add(this.animation);
    uiTheme(renderer).bindStyles(this.root, styles => {
      paintText(this.outcome, styles[this.stopped ? "status.warning" : "status.error"]);
      paintText(this.attention, styles["status.attention"]); paintText(this.spinner.root, styles["status.working"]);
    });
  }

  update(status: AgentStatus | null, visible: boolean, session?: Pick<OpenSession, "result" | "attention">): void {
    if (this.root.isDestroyed) return;
    const changed = status !== this.status || visible !== this.visible;
    this.status = status; this.visible = visible;
    this.stopped = status !== "working" && session?.result?.outcome === "unfinished";
    this.unread = !!session?.attention;
    if (!visible) this.spinner.cancel();
    else if (changed && status === "working") this.spinner.start();
    else if (status !== "working") this.spinner.stop();
    this.outcome.content = this.stopped ? "?" : status === "failure" ? icons.error : "";
    paintText(this.outcome, uiTheme(this.renderer).styles[this.stopped ? "status.warning" : "status.error"]);
    this.syncVisibility();
  }

  private syncVisibility(): void {
    if (this.root.isDestroyed) return;
    this.outcome.visible = this.visible && (this.stopped || this.status === "failure");
    this.animation.visible = this.visible && this.spinner.root.visible;
    this.attention.visible = this.visible && this.unread;
    const width = Number(this.outcome.visible) + Number(this.animation.visible) + Number(this.attention.visible);
    const visible = this.visible && width > 0;
    if (this.root.visible === visible && this.root.width === Math.max(2, width)) return;
    this.root.visible = visible; this.root.width = Math.max(2, width);
    this.changed?.(); this.renderer.requestRender();
  }

  dispose(): void { this.spinner.cancel(); }
}
