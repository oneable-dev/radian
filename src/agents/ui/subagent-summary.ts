import {
  BoxRenderable,
  RenderableEvents,
  StyledText,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core";
import type { Subagent } from "../model.ts";
import { icons } from "../../icons.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import { singleLine, truncateCells } from "../../ui/text.ts";
import { uiTheme } from "../../ui/theme.ts";
import { paintText, styleChunk } from "../../ui/theme-styles.ts";
import { formatWorkRequest } from "./request-caption.ts";
import { formatRunDuration } from "./run-completion.ts";

type Row = {
  root: BoxRenderable;
  branch: TextRenderable;
  spinner: LoadingSpinner;
  icon: TextRenderable;
  heading: TextRenderable;
  caption: TextRenderable;
  captionGuide: TextRenderable;
  child: Subagent;
  sampledAt: number;
  running: boolean;
};

export class SubagentSummary {
  readonly root: BoxRenderable;
  private readonly items = new Map<string, Row>();
  private readonly more: TextRenderable;
  private children: readonly Subagent[] = [];
  private active = false;
  private maximumRows = 8;
  private timer: ReturnType<CliRenderer["clock"]["setInterval"]> | undefined;
  private disposed = false;
  private settledKey: string | undefined;
  private expiresAt: number | undefined;
  private expiryTimer: ReturnType<CliRenderer["clock"]["setTimeout"]> | undefined;

  constructor(private readonly renderer: CliRenderer) {
    this.root = new BoxRenderable(renderer, {
      id: "subagent-summary",
      width: "100%",
      height: 0,
      minWidth: 0,
      flexShrink: 0,
      flexDirection: "column",
      visible: false,
      onSizeChange: () => this.paint(),
    });
    this.more = new TextRenderable(renderer, {
      height: 1,
      flexShrink: 0,
      wrapMode: "none",
      selectable: false,
      visible: false,
    });
    this.root.add(this.more);
    uiTheme(renderer).bind(this.root, () => this.paint());
    renderer.addPostProcessFn(this.paint);
    this.root.once(RenderableEvents.DESTROYED, () => this.dispose());
  }

  get hasContent(): boolean {
    return this.rows > 0;
  }

  get rows(): number {
    return this.root.visible ? this.root.height : 0;
  }

  update(children: readonly Subagent[], active: boolean): void {
    if (this.disposed) {
      return;
    }

    this.children = children;
    this.active = active;
    const settled =
      children.length > 0 &&
      children.every(
        (child) =>
          child.status !== "working" && child.phase !== "queued" && child.phase !== "waiting",
      );
    const key = settled
      ? children
          .map((child) => `${child.id}:${child.finishedAt ?? ""}`)
          .sort()
          .join("|")
      : undefined;
    if (key !== this.settledKey) {
      this.settledKey = key;
      if (this.expiryTimer !== undefined) this.renderer.clock.clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined;
      const known = children.every((child) => child.finishedAt !== undefined);
      const delay = known
        ? Math.max(0, Math.max(...children.map((child) => child.finishedAt!)) + 10_000 - Date.now())
        : 10_000;
      this.expiresAt = settled ? this.renderer.clock.now() + delay : undefined;
    }
    if (!active && this.expiryTimer !== undefined) {
      this.renderer.clock.clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined;
    } else if (
      active &&
      this.expiresAt !== undefined &&
      this.expiresAt > this.renderer.clock.now() &&
      this.expiryTimer === undefined
    ) {
      this.expiryTimer = this.renderer.clock.setTimeout(() => {
        this.expiryTimer = undefined;
        this.paint();
        this.renderer.requestRender();
      }, this.expiresAt - this.renderer.clock.now());
    }

    const ids = new Set(children.map((child) => child.id));
    for (const [id, row] of this.items) {
      if (!ids.has(id)) {
        row.spinner.cancel();
        row.root.destroyRecursively();
        this.items.delete(id);
      }
    }
    for (const child of children) {
      let row = this.items.get(child.id);
      if (!row) {
        row = this.createRow(child);
        this.items.set(child.id, row);
      }
      if (
        row.child.runTiming?.startedAt !== child.runTiming?.startedAt ||
        row.child.runTiming?.elapsedMs !== child.runTiming?.elapsedMs ||
        row.child.status !== child.status
      ) {
        row.sampledAt = this.renderer.clock.now();
      }

      row.child = child;
    }

    this.paint();
  }

  fitRows(available: number): void {
    const maximum = Math.max(0, Math.floor(available));
    if (maximum === this.maximumRows) {
      return;
    }

    this.maximumRows = maximum;
    this.paint();
  }

  private createRow(child: Subagent): Row {
    const root = new BoxRenderable(this.renderer, {
      width: "100%",
      height: 1,
      minWidth: 0,
      flexShrink: 0,
      flexDirection: "column",
    });
    const headingRow = new BoxRenderable(this.renderer, {
      width: "100%",
      height: 1,
      minWidth: 0,
      flexShrink: 0,
      flexDirection: "row",
      gap: 1,
    });
    const branch = new TextRenderable(this.renderer, { width: 2, height: 1, selectable: false });
    const slot = new BoxRenderable(this.renderer, { width: 1, height: 1, flexShrink: 0 });
    const spinner = new LoadingSpinner(this.renderer);
    const icon = new TextRenderable(this.renderer, { width: 1, height: 1, selectable: false });

    slot.add(spinner.root);
    slot.add(icon);

    const heading = new TextRenderable(this.renderer, {
      width: "auto",
      height: 1,
      minWidth: 0,
      flexGrow: 1,
      flexShrink: 1,
      wrapMode: "none",
      selectable: false,
    });
    const caption = new TextRenderable(this.renderer, {
      height: 1,
      marginLeft: 5,
      minWidth: 0,
      flexShrink: 0,
      wrapMode: "none",
      selectable: false,
      visible: false,
    });

    const captionGuide = new TextRenderable(this.renderer, {
      position: "absolute",
      left: 0,
      top: 1,
      width: 2,
      height: 1,
      content: "│",
      selectable: false,
      visible: false,
    });

    headingRow.add(branch);
    headingRow.add(slot);
    headingRow.add(heading);
    root.add(headingRow);
    root.add(caption);
    root.add(captionGuide);
    this.root.insertBefore(root, this.more);

    return {
      root,
      branch,
      spinner,
      icon,
      heading,
      caption,
      captionGuide,
      child,
      sampledAt: this.renderer.clock.now(),
      running: false,
    };
  }

  private paint = (): void => {
    if (this.disposed || this.root.isDestroyed || !this.more) {
      return;
    }

    const visible =
      this.active &&
      this.children.length > 0 &&
      this.maximumRows > 0 &&
      (this.expiresAt === undefined || this.renderer.clock.now() < this.expiresAt);
    this.root.visible = visible;

    const styles = uiTheme(this.renderer).styles;
    // Keep active work visible even when the compact height cannot show every settled child.
    const ordered = [
      ...this.children.filter((child) => child.status === "working"),
      ...this.children.filter((child) => child.status !== "working"),
    ];
    const overflowRow = ordered.length > this.maximumRows && this.maximumRows > 1;
    const shown = visible ? ordered.slice(0, this.maximumRows - Number(overflowRow)) : [];
    const hidden = ordered.length - shown.length;
    let captions = Math.max(0, this.maximumRows - shown.length - Number(overflowRow));
    let rows = 0;
    let ticking = false;
    for (const row of this.items.values()) {
      row.root.visible = false;
    }
    for (const [index, child] of shown.entries()) {
      const row = this.items.get(child.id)!;
      // Reordering children changes only passive status rows, never focus or input ownership.
      if (this.root.getChildren()[index] !== row.root) {
        this.root.add(row.root, index);
      }

      row.root.visible = true;

      const working = child.status === "working";
      if (working && !row.running) {
        row.spinner.start();
      } else if (!working && row.running) {
        row.spinner.stop();
      }

      row.running = working;
      const continues = index < shown.length - 1 || overflowRow;
      row.branch.content = continues ? "├─" : "└─";
      paintText(row.branch, styles["ui.muted"]);
      paintText(row.captionGuide, styles["ui.muted"]);
      paintText(row.spinner.root, styles["status.working"]);

      let color: keyof typeof styles;
      if (working) {
        color = "status.working";
      } else if (child.status === "complete") {
        color = "status.success";
      } else if (child.status === "failure") {
        color = "status.error";
      } else {
        color = "status.unknown";
      }
      row.icon.visible = !row.spinner.root.visible;
      row.icon.content =
        child.status === "complete"
          ? icons.pass
          : child.status === "failure"
            ? icons.failure
            : icons.unknown;
      paintText(row.icon, styles[color]);

      const phase = child.phase ? child.phase[0]!.toUpperCase() + child.phase.slice(1) : undefined;
      let label = phase;
      if (label === undefined) {
        if (working) {
          label = "Working";
        } else if (child.status === "complete") {
          label = "Complete";
        } else if (child.status === "failure") {
          label = "Failed";
        } else {
          label = "Unknown";
        }
      }
      const elapsed = child.runTiming
        ? child.runTiming.elapsedMs +
          (working ? Math.max(0, this.renderer.clock.now() - row.sampledAt) : 0)
        : undefined;
      const duration =
        elapsed === undefined ? "" : ` (${elapsed < 1000 ? "0s" : formatRunDuration(elapsed)})`;
      const width = Math.max(0, this.root.width - 5);
      const suffix = ` · ${label}${duration}`;
      const name = truncateCells(
        singleLine(child.name),
        Math.max(0, width - Bun.stringWidth(suffix)),
      );
      const state = truncateCells(suffix, Math.max(0, width - Bun.stringWidth(name)));

      row.heading.content = new StyledText([
        styleChunk(name, styles["ui.label"]),
        styleChunk(
          state.slice(0, state.indexOf(" (") < 0 ? state.length : state.indexOf(" (")),
          styles[color],
        ),
        ...(state.includes(" (")
          ? [styleChunk(state.slice(state.indexOf(" (")), styles["status.elapsed"])]
          : []),
      ]);

      const caption =
        captions > 0
          ? child.progress
            ? truncateCells(
                singleLine(child.progress),
                Math.min(width, 60, Math.floor(this.root.width / 2)),
              )
            : child.request
              ? formatWorkRequest(child.request, this.root.width, width)
              : ""
          : "";
      row.caption.visible = !!caption;
      row.captionGuide.visible = !!caption && continues;
      row.caption.content = caption;
      paintText(row.caption, styles["status.elapsed"]);
      row.root.height = 1 + Number(!!caption);
      rows += row.root.height;
      if (caption) {
        captions--;
      }

      ticking ||= working && !!child.runTiming;
    }
    for (const row of this.items.values()) {
      if (!row.root.visible) {
        row.spinner.cancel();
        row.running = false;
      }
    }

    this.more.visible = visible && overflowRow;
    this.more.content = truncateCells(`└─ … ${hidden} more subagents`, this.root.width);
    paintText(this.more, styles["ui.muted"]);
    this.root.height = rows + Number(this.more.visible);
    if (ticking && this.timer === undefined) {
      this.timer = this.renderer.clock.setInterval(this.paint, 1000);
    } else if (!ticking && this.timer !== undefined) {
      this.renderer.clock.clearInterval(this.timer);
      this.timer = undefined;
    }
  };

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.renderer.removePostProcessFn(this.paint);
    if (this.timer !== undefined) {
      this.renderer.clock.clearInterval(this.timer);
    }

    this.timer = undefined;
    if (this.expiryTimer !== undefined) this.renderer.clock.clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    for (const row of this.items.values()) {
      row.spinner.cancel();
    }
  }
}
