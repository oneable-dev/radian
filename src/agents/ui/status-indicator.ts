import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import type { AgentStatus } from "../model.ts";
import { icons } from "../../icons.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import { uiTheme } from "../../ui/theme.ts";

// Keep the primary status in the leading cell. A settled outcome uses the same
// position immediately, with the spinner's minimum-visible tail in the second cell.
export class StatusIndicator {
  readonly root: BoxRenderable;
  private readonly spinner: LoadingSpinner;
  private readonly outcome: TextRenderable;
  private status: AgentStatus | null | undefined;
  private visible = false;

  constructor(private readonly renderer: CliRenderer) {
    this.root = new BoxRenderable(renderer, { width: 2, height: 1, flexShrink: 0, flexDirection: "row" });
    const animation = new BoxRenderable(renderer, { width: 1, height: 1, flexShrink: 0 });
    this.spinner = new LoadingSpinner(renderer);
    this.outcome = new TextRenderable(renderer, { width: 1, height: 1, wrapMode: "none", selectable: false });
    animation.add(this.spinner.root); this.root.add(animation); this.root.add(this.outcome);
    uiTheme(renderer).bind(this.outcome, (colors) => {
      this.outcome.fg = this.status === "failure" ? colors.error : this.status === "complete" ? colors.success : colors.muted;
    });
    uiTheme(renderer).bind(this.spinner.root, (colors) => { this.spinner.root.fg = colors.accent; });
  }

  update(status: AgentStatus | null, visible: boolean): void {
    if (this.root.isDestroyed) return;
    const changed = status !== this.status || visible !== this.visible;
    this.status = status; this.visible = visible;
    this.root.flexDirection = status === "working" ? "row" : "row-reverse";
    if (!visible) this.spinner.cancel();
    else if (changed && status === "working") this.spinner.start();
    else if (status !== "working") this.spinner.stop();
    this.outcome.content = status === "complete" ? icons.pass : status === "failure" ? icons.error : status === null ? icons.unknown : "";
    const colors = uiTheme(this.renderer).colors;
    this.outcome.fg = status === "failure" ? colors.error : status === "complete" ? colors.success : colors.muted;
  }

  dispose(): void { this.spinner.cancel(); }
}
