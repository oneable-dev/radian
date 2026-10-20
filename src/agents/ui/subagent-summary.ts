import { BoxRenderable, StyledText, TextRenderable, fg, type CliRenderer } from "@opentui/core";
import type { Subagent } from "../model.ts";
import { icons } from "../../icons.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import { uiTheme } from "../../ui/theme.ts";

const count = (value: number) => (value > 99 ? "99+" : String(value)).padStart(3);

export class SubagentSummary {
  readonly root: BoxRenderable;
  private readonly label: TextRenderable;
  private readonly counts: TextRenderable;
  private readonly spinner: LoadingSpinner;
  private children: readonly Subagent[] = [];
  private active = false;
  private width = 0;
  private running = false;

  constructor(private readonly renderer: CliRenderer) {
    this.root = new BoxRenderable(renderer, { id: "subagent-summary", height: 1, flexShrink: 0, flexDirection: "row", visible: false });
    this.label = new TextRenderable(renderer, { height: 1, wrapMode: "none", selectable: false });
    this.counts = new TextRenderable(renderer, { height: 1, wrapMode: "none", selectable: false });
    const slot = new BoxRenderable(renderer, { width: 1, height: 1, flexShrink: 0 });
    this.spinner = new LoadingSpinner(renderer); slot.add(this.spinner.root);
    this.root.add(this.label); this.root.add(slot); this.root.add(this.counts);
    uiTheme(renderer).bind(this.root, (colors) => {
      this.label.fg = colors.muted; this.counts.fg = colors.text; this.spinner.root.fg = colors.accent;
      this.paint();
    });
  }
  // Reserve the row before its first measured width (or while returning from a hidden zero-width pane).
  get hasContent(): boolean { return this.active && this.children.length > 0 && (this.width === 0 || this.width >= 22); }

  update(children: readonly Subagent[], active: boolean): void {
    this.children = children; this.active = active; this.paint();
  }
  resize(width: number): void { this.width = width; this.paint(); }
  private paint(): void {
    if (this.root.isDestroyed) return;
    const visible = this.hasContent && this.width > 0;
    this.root.visible = visible;
    const working = this.children.filter((child) => child.status === "working").length;
    const complete = this.children.filter((child) => child.status === "complete").length;
    const failure = this.children.filter((child) => child.status === "failure").length;
    const unknown = this.children.length - working - complete - failure;
    if (!visible) { this.spinner.cancel(); this.running = false; return; }
    if (working && !this.running) this.spinner.start();
    if (!working) this.spinner.stop();
    this.running = working > 0;
    const full = this.width >= 58, medium = this.width >= 38;
    this.label.content = full ? "Subagents " : medium ? "Sub " : "";
    const text = `${count(working)} ${icons.error}${count(failure)}`
      + (medium ? ` ${icons.pass}${count(complete)}` : "") + (full ? ` ${icons.unknown}${count(unknown)}` : "");
    const colors = uiTheme(this.renderer).colors;
    this.counts.content = new StyledText([
      fg(working ? colors.accent : colors.muted)(count(working)),
      fg(failure ? colors.error : colors.muted)(` ${icons.error}${count(failure)}`),
      ...(medium ? [fg(complete ? colors.success : colors.muted)(` ${icons.pass}${count(complete)}`)] : []),
      ...(full ? [fg(colors.muted)(` ${icons.unknown}${count(unknown)}`)] : []),
    ]);
    this.root.width = (full ? 10 : medium ? 4 : 0) + 1 + text.length;
  }
  dispose(): void { this.spinner.cancel(); }
}
