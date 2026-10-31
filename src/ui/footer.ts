import {
  BoxRenderable,
  RenderableEvents,
  StyledText,
  TextRenderable,
  type CliRenderer,
  type TextChunk,
} from "@opentui/core";
import { blendColors, uiTheme, type UiTheme } from "./theme.ts";
import { paintText, styleChunk } from "./theme-styles.ts";
import { singleLine, truncateCells } from "./text.ts";
import { ProviderIcon } from "./provider-icon.ts";
import { LoadingSpinner } from "./loading-spinner.ts";
import type { ProviderUsage, UsageWindow } from "../usage/model.ts";
import { icons } from "../icons.ts";

export type FooterMode = "NORMAL" | "VISUAL" | "VISUAL LINE" | "HELP";

// Shortcut descriptions exposed by individual surfaces; not rendered in the footer.
export type FooterShortcut = {
  readonly key: string;
  readonly label: string;
  readonly disabled?: boolean;
};

type Scope = { name: string; branch: string | null };
type ProviderView = {
  readonly layer: BoxRenderable;
  readonly icon: ProviderIcon | null;
  readonly spinner: LoadingSpinner;
  recovering: boolean;
};

const cellWidth = (text: string) => Bun.stringWidth(text);
const percentage = (value: number) => `${Math.round(Math.max(0, Math.min(100, value)))}%`;

function usageWindow(usage: ProviderUsage | undefined, now: number): UsageWindow | undefined {
  if (!usage || usage.status === "unavailable") {
    return undefined;
  }

  return usage.windows
    .filter((window) => window.resetsAt === null || window.resetsAt > now)
    .toSorted((a, b) => (b.periodMs ?? 0) - (a.periodMs ?? 0))[0];
}

function resetTime(resetsAt: number | null | undefined, now: number): string {
  if (resetsAt === null || resetsAt === undefined || resetsAt <= now) {
    return "";
  }

  const minutes = Math.ceil((resetsAt - now) / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) {
    return `${days}d ${hours}h`;
  }
  if (hours) {
    return `${hours}h ${minutes % 60}m`;
  }

  return `${minutes}m`;
}

// One passive row: view/workspace identity on the left, account-wide provider usage on the right.
export class Footer {
  readonly root: BoxRenderable;
  readonly bar: BoxRenderable;
  private readonly identity: TextRenderable;
  private readonly context: TextRenderable;
  private readonly workspace: TextRenderable;
  private readonly usageRow: BoxRenderable;
  private readonly usageText: TextRenderable;
  private readonly providers = new Map<string, ProviderView>();
  private snapshots: Readonly<Record<string, ProviderUsage>> = {};
  private providerOrder: string[] = [];
  private contextText = "";
  private viewText = "AGENT";
  private scope: Scope | null = null;
  private tick: ReturnType<CliRenderer["clock"]["setTimeout"]> | undefined;
  private lastUsagePaint = "";
  private lastPaint = "";
  private readonly theme: UiTheme;

  constructor(private readonly renderer: CliRenderer) {
    this.theme = uiTheme(renderer);
    this.root = new BoxRenderable(renderer, {
      id: "app-footer",
      width: "100%",
      height: 1,
      flexShrink: 0,
    });
    this.bar = new BoxRenderable(renderer, {
      id: "footer-bar",
      width: "100%",
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      alignItems: "center",
      onSizeChange: () => this.render(),
      renderBefore: () => this.render(),
    });

    const text = (id: string) =>
      new TextRenderable(renderer, {
        id,
        height: 1,
        flexShrink: 0,
        wrapMode: "none",
        selectable: false,
      });
    this.identity = text("footer-identity");
    this.context = text("footer-context");
    this.workspace = text("footer-workspace");
    this.usageRow = new BoxRenderable(renderer, {
      id: "footer-usage",
      height: 1,
      flexShrink: 0,
    });
    this.usageText = text("footer-usage-text");
    this.usageText.width = "100%";
    this.usageRow.add(this.usageText);
    this.bar.add(this.identity);
    this.bar.add(this.workspace);
    this.bar.add(this.context);
    this.bar.add(this.usageRow);
    this.root.add(this.bar);
    renderer.on("resize", this.render);
    this.root.once(RenderableEvents.DESTROYED, () => {
      renderer.off("resize", this.render);
      this.cancelTick();
      for (const view of this.providers.values()) {
        view.spinner.cancel();
      }
    });
    this.theme.bindStyles(this.root, () => {
      this.lastPaint = "";
      this.lastUsagePaint = "";
      this.render();
    });
  }

  setView(text: string): void {
    if (text !== this.viewText) {
      this.viewText = text;
      this.render();
    }
  }

  setContext(text: string): void {
    if (text !== this.contextText) {
      this.contextText = text;
      this.render();
    }
  }

  setWorkspace(scope: Scope | null): void {
    this.scope = scope;
    this.render();
  }

  setUsage(snapshots: Readonly<Record<string, ProviderUsage>>, providers: readonly string[]): void {
    if (this.root.isDestroyed) {
      return;
    }

    this.snapshots = snapshots;
    this.providerOrder = [...new Set([...providers, ...Object.keys(snapshots)])];
    for (const [provider, view] of this.providers) {
      if (!this.providerOrder.includes(provider)) {
        view.spinner.cancel();
        view.layer.destroyRecursively();
        this.providers.delete(provider);
      }
    }
    for (const provider of this.providerOrder) {
      let view = this.providers.get(provider);
      if (!view) {
        const layer = new BoxRenderable(this.renderer, {
          position: "absolute",
          left: 0,
          top: 0,
          width: 2,
          height: 1,
          visible: false,
        });
        this.usageRow.add(layer);
        let icon: ProviderIcon | null = new ProviderIcon(this.renderer, "footer.identity");
        if (icon.setProvider(provider)) {
          icon.id = `footer-provider-icon-${provider}`;
          layer.add(icon);
        } else {
          icon.destroy();
          icon = null;
        }
        const spinner = new LoadingSpinner(this.renderer, {
          id: `footer-usage-loading-${provider}`,
        });
        spinner.root.position = "absolute";
        spinner.root.top = 0;
        layer.add(spinner.root);
        view = { layer, icon, spinner, recovering: false };
        this.providers.set(provider, view);
      }

      const status = snapshots[provider]?.status;
      const recovering = status === "loading" || status === "error";
      if (recovering && !view.recovering && view.layer.visible) {
        view.spinner.start();
      } else if (!recovering && view.recovering) {
        view.spinner.stop();
      }
      view.recovering = recovering;
    }

    this.cancelTick();
    this.render();
    this.scheduleTick();
  }

  private cancelTick(): void {
    if (this.tick !== undefined) {
      this.renderer.clock.clearTimeout(this.tick);
      this.tick = undefined;
    }
  }

  private scheduleTick(): void {
    const now = Date.now();
    const resets = Object.values(this.snapshots)
      .flatMap((usage) => usage.windows)
      .flatMap((window) =>
        window.resetsAt !== null && window.resetsAt > now ? [window.resetsAt] : [],
      );
    if (this.root.isDestroyed || !resets.length) {
      return;
    }

    this.tick = this.renderer.clock.setTimeout(
      () => {
        this.tick = undefined;
        this.render();
        this.scheduleTick();
      },
      Math.min(60000, Math.min(...resets) - now),
    );
  }

  private render = (): void => {
    if (this.root.isDestroyed) {
      return;
    }

    const width = Math.max(0, this.bar.width);
    const signature = JSON.stringify([
      width,
      this.viewText,
      this.contextText,
      this.scope,
      this.snapshots,
      this.providerOrder,
      this.providerOrder.map((provider) => {
        const view = this.providers.get(provider)!;
        const window = usageWindow(this.snapshots[provider], Date.now());
        return [view.spinner.root.visible, window?.id, resetTime(window?.resetsAt, Date.now())];
      }),
    ]);
    if (signature === this.lastPaint) {
      return;
    }
    this.lastPaint = signature;

    const styles = this.theme.styles;
    const view = ` ${singleLine(this.viewText).toUpperCase()} `;
    const identityWidth = Math.min(width, cellWidth(view));
    this.identity.width = identityWidth;
    this.identity.content = truncateCells(view, identityWidth);
    paintText(this.identity, styles["footer.mode"]);
    this.bar.backgroundColor = styles["footer.identity"].bg;

    let remaining = Math.max(0, width - identityWidth);
    // Keep known account ratios before spending cells on workspace names or extension status.
    const usageMinimum = this.providerOrder.reduce(
      (sum, provider) => {
        const view = this.providers.get(provider)!;
        const window = usageWindow(this.snapshots[provider], Date.now());
        const label = view.icon ? 2 : cellWidth(icons.robot);
        const detail = view.recovering
          ? 1
          : 1 +
            cellWidth(window ? percentage(window.usedPercent) : "-") +
            (view.spinner.root.visible ? 2 : 0);

        return sum + label + detail;
      },
      Math.max(0, this.providerOrder.length - 1) * 2 + (this.providerOrder.length ? 1 : 0),
    );
    const scopeWidth = this.scope
      ? Math.min(Math.max(0, remaining - usageMinimum), Math.floor(width * 0.5))
      : 0;
    const worktreePrefix = ` ${icons.folder} `;
    const separator = " · ";
    const branchPrefix = `${icons.branch} `;
    const suffix = " ";
    const budget = scopeWidth - cellWidth(worktreePrefix + separator + branchPrefix + suffix);
    this.workspace.visible = !!this.scope && budget >= 2;

    let workspaceWidth = 0;
    if (this.scope && this.workspace.visible) {
      const name = singleLine(this.scope.name);
      const branch = singleLine(this.scope.branch ?? "detached HEAD");
      const branchBudget = Math.min(cellWidth(branch), Math.ceil(budget / 2));
      const worktree = truncateCells(name, budget - branchBudget);
      const ref = truncateCells(branch, budget - cellWidth(worktree));
      const left = worktreePrefix + worktree;
      const right = branchPrefix + ref + suffix;
      workspaceWidth = cellWidth(left + separator + right);
      this.workspace.content = new StyledText([
        styleChunk(left, styles["footer.worktree"]),
        styleChunk(separator, styles["ui.muted"]),
        styleChunk(right, styles["footer.branch"]),
      ]);
    }

    this.workspace.width = workspaceWidth;
    remaining -= workspaceWidth;
    const context = singleLine(this.contextText);
    const contextWidth = Math.min(
      Math.max(0, remaining - Math.max(2, usageMinimum)),
      context ? cellWidth(context) + 2 : 0,
    );
    this.context.width = contextWidth;
    this.context.visible = contextWidth > 0;
    this.context.content = truncateCells(` ${context} `, contextWidth);
    paintText(this.context, styles["footer.accent"]);
    this.usageRow.width = Math.max(0, remaining - contextWidth);
    this.renderUsage(Math.max(0, remaining - contextWidth));
  };

  private renderUsage(available: number): void {
    const { colors, styles } = this.theme;
    const now = Date.now();
    const providers = this.providerOrder.map((provider) => {
      const view = this.providers.get(provider)!;
      const window = usageWindow(this.snapshots[provider], now);
      return { view, window, label: view.icon ? "  " : icons.robot };
    });
    const signature = JSON.stringify([
      available,
      this.snapshots,
      this.providerOrder,
      providers.map(({ view, window }) => [
        view.spinner.root.visible,
        resetTime(window?.resetsAt, now),
        window?.id,
      ]),
    ]);
    if (signature === this.lastUsagePaint) {
      return;
    }
    this.lastUsagePaint = signature;
    for (const { view } of providers) {
      view.layer.visible = false;
    }

    // Keep every provider identity before spending space on bars, reset times or verbose values.
    for (let count = providers.length; count >= 0; count--) {
      const shown = providers.slice(0, count);
      const hidden = providers.length - count;
      const suffix = hidden ? `+${hidden}` : "";
      for (const format of ["full", "ratios", "icons"] as const) {
        for (const barWidth of format === "full" ? [6, 4, 2, 0] : [0]) {
          for (const countdown of [true, false]) {
            const meters = shown.map(({ view, window, label }) => {
              const reset = countdown && !view.recovering ? resetTime(window?.resetsAt, now) : "";
              const value = view.recovering
                ? ""
                : window
                  ? percentage(window.usedPercent) + (format === "full" ? " used" : "")
                  : "-";
              const detail = format === "icons" ? "" : [value, reset].filter(Boolean).join(" ");
              const bar = barWidth && window ? "▉".repeat(barWidth) + " " : "";
              const spinnerWidth = view.recovering ? 1 : view.spinner.root.visible ? 2 : 0;
              const text = `${label}${detail || bar ? " " : ""}${bar}${detail}`;
              return { view, window, text, bar, detail, label, spinnerWidth };
            });
            const required =
              meters.reduce((sum, meter) => sum + cellWidth(meter.text) + meter.spinnerWidth, 0) +
              Math.max(0, meters.length - 1) * 2 +
              (suffix && meters.length ? 2 : 0) +
              cellWidth(suffix);
            if (required > Math.max(0, available - 1)) {
              continue;
            }

            let offset = available - required - (required ? 1 : 0);
            const chunks: TextChunk[] = [
              styleChunk(" ".repeat(Math.max(0, offset)), styles["ui.muted"]),
            ];
            for (const [index, meter] of meters.entries()) {
              const { view, window, label, bar, detail, spinnerWidth } = meter;
              if (index) {
                chunks.push(styleChunk("  ", styles["ui.muted"]));
                offset += 2;
              }
              view.layer.left = offset;
              view.layer.width = cellWidth(meter.text) + spinnerWidth;
              view.layer.visible = true;
              if (view.icon) {
                view.icon.visible = true;
              }
              if (view.recovering && !view.spinner.root.visible) {
                view.spinner.start();
              } else if (!view.recovering) {
                view.spinner.stop();
              }
              view.spinner.root.left = cellWidth(meter.text) + (view.recovering ? 0 : 1);
              paintText(view.spinner.root, styles["ui.muted"]);
              const labelStyle = styles[view.recovering ? "ui.muted" : "ui.label"];
              chunks.push(styleChunk(`${label}${detail || bar ? " " : ""}`, labelStyle));
              if (bar && window) {
                const filled = Math.round(
                  (Math.max(0, Math.min(100, window.usedPercent)) * barWidth) / 100,
                );
                for (let cell = 0; cell < barWidth; cell++) {
                  chunks.push({
                    ...styleChunk("▉", styles["metadata.meter"]),
                    fg:
                      cell >= filled
                        ? blendColors(colors.panel, labelStyle.fg, 0.2)
                        : view.recovering
                          ? styles["ui.muted"].fg
                          : blendColors(
                              colors.panel,
                              styles["metadata.meter"].fg,
                              1 - (0.45 * cell) / Math.max(1, barWidth - 1),
                            ),
                  });
                }
                chunks.push(styleChunk(" ", styles["ui.muted"]));
              }
              chunks.push(
                styleChunk(detail, styles[view.recovering || !window ? "ui.muted" : "ui.label"]),
              );
              chunks.push(styleChunk(" ".repeat(spinnerWidth), styles["ui.muted"]));
              offset += cellWidth(meter.text) + spinnerWidth;
            }
            chunks.push(
              styleChunk(`${suffix && meters.length ? "  " : ""}${suffix}`, styles["ui.label"]),
            );
            this.usageText.content = new StyledText(chunks);
            for (const { view } of providers) {
              if (!view.layer.visible) {
                view.spinner.cancel();
              }
            }

            return;
          }
        }
      }
    }

    this.usageText.content = "";
    for (const { view } of providers) {
      view.spinner.cancel();
    }
  }
}
