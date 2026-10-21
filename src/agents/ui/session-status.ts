import { BoxRenderable, RenderableEvents, StyledText, TextRenderable, type CliRenderer, type TextChunk } from "@opentui/core";
import type { SessionTelemetry } from "../telemetry.ts";
import { blendColors, uiTheme, type UiColors } from "../../ui/theme.ts";
import { paintText, styleChunk, type StyleGroup, type UiStyles } from "../../ui/theme-styles.ts";
import { ProviderIcon } from "../../ui/provider-icon.ts";
import type { UsageWindow } from "../../usage/model.ts";
import type { Worktree } from "../../workspace/model.ts";
import { singleLine, truncateCells } from "../../ui/text.ts";
import { icons } from "../../icons.ts";

type Meter = { label: string; percent: number | null; value: string };
const cellWidth = (text: string) => Bun.stringWidth(text);
const percentage = (value: number | null) => value === null ? "-" : `${Math.round(value)}%`;
const clampPercent = (value: number) => Math.max(0, Math.min(100, value));
type WorkspaceScope = Pick<Worktree, "name" | "branch">;

function scopeChunks(scope: WorkspaceScope, width: number, styles: UiStyles): TextChunk[] {
  const name = singleLine(scope.name), branch = singleLine(scope.branch ?? "detached");
  const open = "[ ", worktreePrefix = `${icons.folder} `, separator = " · ", branchPrefix = `${icons.branch} `, close = " ]";
  const budget = width - cellWidth(open + worktreePrefix + separator + branchPrefix + close);
  // Keep the group intact, with at least an ellipsis for each name, or hide it entirely.
  if (budget < 2) return [];
  const branchWidth = Math.min(cellWidth(branch), Math.ceil(budget / 2));
  const label = truncateCells(name, budget - branchWidth);
  return [
    styleChunk(open, styles["ui.muted"]),
    styleChunk(worktreePrefix + label, styles["ui.label"]),
    styleChunk(separator, styles["ui.muted"]),
    styleChunk(branchPrefix + truncateCells(branch, budget - cellWidth(label)), styles["git.currentRef"]),
    styleChunk(close, styles["ui.muted"]),
  ];
}

function providerLabel(provider: string | null | undefined, sessionProvider: string | null | undefined): string | null {
  if (provider === "openai" || provider === "openai-codex") return provider === "openai-codex" || sessionProvider === "openai-codex" ? "chatgpt" : "openai";
  return provider === "anthropic" ? "claude" : null;
}

function resetTime(resetsAt: number | null, now: number): string {
  if (resetsAt === null || resetsAt <= now) return "";
  const minutes = Math.ceil((resetsAt - now) / 60000);
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function usageWindow(telemetry: SessionTelemetry | null, now: number): UsageWindow | null {
  const usage = telemetry?.usage;
  if (usage !== undefined) {
    if (usage.status !== "ready") return null;
    // The compact view follows the longest returned window, rather than a provider-specific weekly slot.
    return usage.windows.filter((window) => window.resetsAt === null || window.resetsAt > now)
      .toSorted((a, b) => (b.periodMs ?? 0) - (a.periodMs ?? 0))[0] ?? null;
  }
  // Additive compatibility with earlier runtimes that only observed a weekly response header.
  const weekly = telemetry?.weekly;
  return weekly && weekly.resetsAt > now ? { id: "legacy-weekly", usedPercent: 100 - weekly.remainingPercent,
    periodMs: 7 * 24 * 60 * 60000, resetsAt: weekly.resetsAt } : null;
}

function meterChunks(meter: Meter, width: number, colors: UiColors, styles: UiStyles): TextChunk[] {
  const chunks: TextChunk[] = [styleChunk(`${meter.label} `, styles["ui.label"])];
  if (width && meter.percent !== null) {
    const filled = Math.round(meter.percent * width / 100);
    const empty = blendColors(colors.panel, styles["ui.label"].fg, 0.2);
    for (let cell = 0; cell < width; cell++) {
      // Fixed seven-eighths blocks keep uniform gaps; fill only changes their color, not their shape or background.
      chunks.push({ ...styleChunk("▉", styles["metadata.meter"]),
        fg: cell < filled ? blendColors(colors.panel, styles["metadata.meter"].fg, 1 - 0.45 * cell / Math.max(1, width - 1)) : empty });
    }
    chunks.push(styleChunk(" ", styles["ui.muted"]));
  }
  chunks.push(styleChunk(meter.value, styles[meter.percent === null ? "ui.muted" : "ui.label"]));
  return chunks;
}

// Passive metadata below the composer. No manual refresh, network requests or credentials in the UI.
export class SessionStatus {
  readonly root: BoxRenderable;
  private readonly text: TextRenderable;
  private readonly scopeText: TextRenderable;
  private worktree: WorkspaceScope | null = null;
  private readonly providerIcon: ProviderIcon;
  private telemetry: SessionTelemetry | null = null;
  private capturedAt: number | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private visible = false;
  private disposed = false;
  private lastPaint = "";

  constructor(private readonly renderer: CliRenderer) {
    this.root = new BoxRenderable(renderer, { id: "session-status", width: "100%", height: 3, paddingY: 1, flexShrink: 0,
      onSizeChange: () => this.paint() });
    const row = new BoxRenderable(renderer, { id: "session-status-line", width: "100%", height: 1, flexShrink: 0, flexDirection: "row", gap: 2 });
    this.root.add(row);
    this.scopeText = new TextRenderable(renderer, { id: "session-worktree-context", height: 1, flexShrink: 0, wrapMode: "none", selectable: false, visible: false });
    this.text = new TextRenderable(renderer, { width: "auto", flexGrow: 1, flexShrink: 1, minWidth: 0, height: 1, wrapMode: "none", selectable: false });
    row.add(this.scopeText); row.add(this.text);
    this.providerIcon = new ProviderIcon(renderer); row.add(this.providerIcon);
    uiTheme(renderer).bind(this.root, () => { this.lastPaint = ""; this.paint(); });
    this.root.once(RenderableEvents.DESTROYED, () => this.dispose());
  }

  update(telemetry: SessionTelemetry | undefined, visible: boolean, worktree: WorkspaceScope | null = null, capturedAt?: number): void {
    this.telemetry = telemetry ?? null; this.worktree = worktree; this.capturedAt = capturedAt; this.visible = visible; this.root.visible = visible;
    this.cancelExpiry(); this.paint(); this.scheduleTick();
  }

  private scheduleTick(): void {
    if (this.disposed || !this.visible || this.capturedAt !== undefined) return;
    const now = Date.now(), reset = usageWindow(this.telemetry, now)?.resetsAt;
    if (reset === undefined || reset === null || reset <= now) return;
    this.expiry = setTimeout(() => { this.expiry = undefined; this.paint(); this.scheduleTick(); }, Math.min(60000, reset - now));
  }

  private paint(): void {
    if (this.disposed || !this.visible || !this.root || this.root.isDestroyed) return;
    const theme = uiTheme(this.renderer), colors = theme.colors, styles = theme.styles;
    this.root.backgroundColor = styles["ui.text"].bg; this.text.bg = styles["ui.text"].bg;
    const totalWidth = Math.max(0, this.root.width), now = this.capturedAt ?? Date.now();
    const telemetry = this.telemetry;
    const context = telemetry?.context;
    const window = usageWindow(telemetry, now);
    const countdown = resetTime(window?.resetsAt ?? null, now);
    const provider = telemetry?.usage?.provider ?? telemetry?.provider;
    const hasIcon = this.providerIcon.setProvider(provider), providerName = providerLabel(provider, telemetry?.provider);
    const signature = JSON.stringify([totalWidth, this.worktree?.name, this.worktree?.branch, telemetry, window?.id, countdown]);
    if (signature === this.lastPaint) return;
    this.lastPaint = signature;
    const remaining = context?.usedTokens !== null && context?.usedTokens !== undefined && context.maxTokens > 0
      ? clampPercent((1 - context.usedTokens / context.maxTokens) * 100) : null;
    const contextMeter: Meter = { label: "context", percent: remaining, value: remaining === null ? "-" : `${percentage(remaining)} left` };
    const usage: Meter = { label: hasIcon ? "  " : "usage", percent: window?.usedPercent ?? null,
      value: window ? `${percentage(window.usedPercent)} used` : "-" };
    const presentations = [
      [{ ...contextMeter, label: `${icons.context} context` }, { ...usage, label: providerName ? `   ${providerName}` : usage.label }],
      [contextMeter, usage],
    ] as const;
    // Reserve known resource percentages before fitting workspace/model detail. The scope
    // gets at most a third of the row and shrinks on grapheme boundaries when space is tight.
    const minimumMeters = cellWidth(`${contextMeter.label} ${contextMeter.value}`) + cellWidth(`${usage.label} ${usage.value}`) + 2;
    const scopeWidth = Math.max(0, Math.min(Math.floor(totalWidth / 3), totalWidth - minimumMeters - 2));
    const scope = this.worktree ? scopeChunks(this.worktree, scopeWidth, styles) : [];
    const scopeSize = scope.reduce((size, part) => size + cellWidth(part.text), 0);
    this.scopeText.visible = scopeSize > 0; this.scopeText.content = new StyledText(scope); this.scopeText.width = scopeSize; paintText(this.scopeText, styles["ui.muted"]);
    const scopePrefix = scopeSize ? scopeSize + 2 : 0, width = totalWidth - scopePrefix;
    const details = window && countdown ? [`${usage.value} ${countdown}`, `${usage.value} ${countdown.replaceAll(" ", "")}`, usage.value] : [usage.value];
    const model = telemetry?.model ?? "model —", effort = telemetry?.effort ?? "—";
    const fast = telemetry?.fast === true ? "on" : telemetry?.fast === false ? "off" : "—";
    const chunk = (text: string, group: StyleGroup): TextChunk => styleChunk(text, styles[group]);
    const modelChunk = chunk(`${icons.model} ${model}`, telemetry?.model ? "metadata.model" : "ui.muted");
    const effortChunk = chunk(`${icons.brain} ${effort}`, telemetry?.effort ? "metadata.effort" : "ui.muted");
    const fastStyle = telemetry?.fast === true ? "metadata.fastOn" : telemetry?.fast === false ? "metadata.fastOff" : "ui.muted";
    const identities = [
      [modelChunk, chunk(" · ", "ui.muted"), effortChunk, chunk(" · ", "ui.muted"), chunk(`${icons.bolt} fast ${fast}`, fastStyle)],
      [modelChunk, chunk(" ", "ui.muted"), effortChunk, chunk(" ", "ui.muted"), chunk(`${icons.bolt} ${fast}`, fastStyle)],
      [modelChunk], [],
    ].map((chunks) => ({ chunks, text: chunks.map((part) => part.text).join("") }));
    // Keep configuration and known percentages before spending cells on bars or provider detail.
    for (const identity of identities) {
      for (const presentation of presentations) {
        for (const detail of new Set(details)) {
          const meters = [presentation[0], { ...presentation[1], value: detail }];
          const base = meters.reduce((size, meter) => size + cellWidth(`${meter.label} ${meter.value}`), 2);
          for (const barWidth of [8, 6, 4, 2, 0]) {
            const meterWidth = base + meters.reduce((size, meter) => size + (barWidth && meter.percent !== null ? barWidth + 1 : 0), 0);
            const identityWidth = identity.text ? cellWidth(identity.text) + 2 : 0;
            if (meterWidth + identityWidth > width) continue;
            const chunks: TextChunk[] = identity.text ? [...identity.chunks, chunk(" ".repeat(width - meterWidth - cellWidth(identity.text)), "ui.muted")] : [];
            const separation = identity.text ? 2 : 2 + width - meterWidth;
            chunks.push(...meterChunks(meters[0]!, barWidth, colors, styles), chunk(" ".repeat(separation), "ui.muted"), ...meterChunks(meters[1]!, barWidth, colors, styles));
            this.text.content = new StyledText(chunks);
            const usageWidth = cellWidth(`${meters[1]!.label} ${meters[1]!.value}`)
              + (barWidth && meters[1]!.percent !== null ? barWidth + 1 : 0);
            this.providerIcon.left = scopePrefix + width - usageWidth; this.providerIcon.visible = hasIcon;
            return;
          }
        }
      }
    }
    const compact = `${contextMeter.value} ${usage.value}`;
    this.text.content = cellWidth(compact) <= width ? compact : "-";
    this.providerIcon.visible = false;
    paintText(this.text, styles["ui.muted"]);
  }

  private cancelExpiry(): void { if (this.expiry !== undefined) clearTimeout(this.expiry); this.expiry = undefined; }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.visible = false; this.cancelExpiry(); this.providerIcon.destroy();
  }
}
