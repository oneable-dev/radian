import {
  BoxRenderable,
  RenderableEvents,
  StyledText,
  TextRenderable,
  type CliRenderer,
  type TextChunk,
} from "@opentui/core";
import type { SessionTelemetry } from "../telemetry.ts";
import type { McpStatus } from "../mcp-status.ts";
import { blendColors, uiTheme, type UiColors } from "../../ui/theme.ts";
import { paintText, styleChunk, type StyleGroup, type UiStyles } from "../../ui/theme-styles.ts";
import { ProviderIcon } from "../../ui/provider-icon.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import type { UsageWindow } from "../../usage/model.ts";
import { icons } from "../../icons.ts";

type Meter = { label: string; percent: number | null; value: string; muted?: boolean };
const cellWidth = (text: string) => Bun.stringWidth(text);
const percentage = (value: number | null) => (value === null ? "-" : `${Math.round(value)}%`);
const clampPercent = (value: number) => Math.max(0, Math.min(100, value));
function providerLabel(
  provider: string | null | undefined,
  sessionProvider: string | null | undefined,
): string | null {
  if (provider === "openai" || provider === "openai-codex")
    return provider === "openai-codex" || sessionProvider === "openai-codex" ? "chatgpt" : "openai";
  return provider === "anthropic" ? "claude" : null;
}

function resetTime(resetsAt: number | null, now: number): string {
  if (resetsAt === null || resetsAt <= now) return "";
  const minutes = Math.ceil((resetsAt - now) / 60000);
  const days = Math.floor(minutes / 1440),
    hours = Math.floor((minutes % 1440) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function usageWindow(telemetry: SessionTelemetry | null, now: number): UsageWindow | null {
  const usage = telemetry?.usage;
  if (usage !== undefined) {
    if (usage.status !== "ready" && usage.status !== "error") return null;
    // The compact view follows the longest returned window, rather than a provider-specific weekly slot.
    return (
      usage.windows
        .filter((window) => window.resetsAt === null || window.resetsAt > now)
        .toSorted((a, b) => (b.periodMs ?? 0) - (a.periodMs ?? 0))[0] ?? null
    );
  }
  // Additive compatibility with earlier runtimes that only observed a weekly response header.
  const weekly = telemetry?.weekly;
  return weekly && weekly.resetsAt > now
    ? {
        id: "legacy-weekly",
        usedPercent: 100 - weekly.remainingPercent,
        periodMs: 7 * 24 * 60 * 60000,
        resetsAt: weekly.resetsAt,
      }
    : null;
}

function meterChunks(meter: Meter, width: number, colors: UiColors, styles: UiStyles): TextChunk[] {
  const labelStyle = styles[meter.muted ? "ui.muted" : "ui.label"];
  const chunks: TextChunk[] = [styleChunk(`${meter.label} `, labelStyle)];
  if (width && meter.percent !== null) {
    const filled = Math.round((meter.percent * width) / 100);
    const empty = blendColors(colors.panel, labelStyle.fg, 0.2);
    for (let cell = 0; cell < width; cell++) {
      // Fixed seven-eighths blocks keep uniform gaps; fill only changes their color, not their shape or background.
      chunks.push({
        ...styleChunk("▉", styles["metadata.meter"]),
        fg:
          cell >= filled
            ? empty
            : meter.muted
              ? styles["ui.muted"].fg
              : blendColors(
                  colors.panel,
                  styles["metadata.meter"].fg,
                  1 - (0.45 * cell) / Math.max(1, width - 1),
                ),
      });
    }
    chunks.push(styleChunk(" ", styles["ui.muted"]));
  }
  chunks.push(
    styleChunk(
      meter.value,
      styles[meter.muted || meter.percent === null ? "ui.muted" : "ui.label"],
    ),
  );
  return chunks;
}

// Passive metadata below the composer. No manual refresh, network requests or credentials in the UI.
export class SessionStatus {
  readonly root: BoxRenderable;
  private readonly text: TextRenderable;
  private readonly providerIcon: ProviderIcon;
  private readonly spinner: LoadingSpinner;
  private recovering = false;
  private telemetry: SessionTelemetry | null = null;
  private mcp: McpStatus | undefined;
  private capturedAt: number | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private visible = false;
  private disposed = false;
  private lastPaint = "";

  constructor(private readonly renderer: CliRenderer) {
    this.root = new BoxRenderable(renderer, {
      id: "session-status",
      width: "100%",
      height: 3,
      paddingY: 1,
      flexShrink: 0,
      onSizeChange: () => this.paint(),
    });
    const row = new BoxRenderable(renderer, {
      id: "session-status-line",
      width: "100%",
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      gap: 2,
      renderBefore: () => this.paint(),
    });
    this.root.add(row);
    this.text = new TextRenderable(renderer, {
      width: "auto",
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      height: 1,
      wrapMode: "none",
      selectable: false,
    });
    row.add(this.text);
    this.providerIcon = new ProviderIcon(renderer);
    row.add(this.providerIcon);
    this.spinner = new LoadingSpinner(renderer, { id: "usage-loading" });
    this.spinner.root.position = "absolute";
    this.spinner.root.right = 0;
    this.spinner.root.top = 0;
    row.add(this.spinner.root);
    uiTheme(renderer).bind(this.root, () => {
      this.lastPaint = "";
      this.paint();
    });
    this.root.once(RenderableEvents.DESTROYED, () => this.dispose());
  }

  update(telemetry: SessionTelemetry | undefined, visible: boolean, capturedAt?: number): void {
    if (this.disposed) return;
    this.telemetry = telemetry ?? null;
    this.capturedAt = capturedAt;
    this.visible = visible;
    this.root.visible = visible;
    const recovering =
      telemetry?.usage?.status === "loading" || telemetry?.usage?.status === "error";
    if (!visible || capturedAt !== undefined) this.spinner.cancel();
    else if (recovering && !this.recovering) this.spinner.start();
    else if (!recovering && this.recovering) this.spinner.stop();
    this.recovering = visible && capturedAt === undefined && recovering;
    this.cancelExpiry();
    this.paint();
    this.scheduleTick();
  }

  updateMcp(status: McpStatus | undefined): void {
    if (this.disposed) return;
    this.mcp = status;
    this.paint();
  }

  private scheduleTick(): void {
    if (this.disposed || !this.visible || this.capturedAt !== undefined) return;
    const now = Date.now(),
      reset = usageWindow(this.telemetry, now)?.resetsAt;
    if (reset === undefined || reset === null || reset <= now) return;
    this.expiry = setTimeout(
      () => {
        this.expiry = undefined;
        this.paint();
        this.scheduleTick();
      },
      Math.min(60000, reset - now),
    );
  }

  private paint(): void {
    if (this.disposed || !this.visible || !this.root || this.root.isDestroyed) return;
    const theme = uiTheme(this.renderer),
      colors = theme.colors,
      styles = theme.styles;
    const telemetry = this.telemetry;
    const recovering =
      telemetry?.usage?.status === "loading" || telemetry?.usage?.status === "error";
    const spinning = this.spinner.root.visible;
    // Reserve a separate slot for the shared spinner's minimum-visible tail without delaying new values.
    const spinnerWidth = spinning ? (recovering ? 1 : 2) : 0;
    const totalWidth = Math.max(0, this.root.width - spinnerWidth),
      now = this.capturedAt ?? Date.now();
    const context = telemetry?.context;
    const window = usageWindow(telemetry, now);
    const countdown = resetTime(window?.resetsAt ?? null, now);
    const provider = telemetry?.usage?.provider ?? telemetry?.provider;
    const hasIcon = this.providerIcon.setProvider(provider),
      providerName = providerLabel(provider, telemetry?.provider);
    const signature = JSON.stringify([
      totalWidth,
      spinning,
      telemetry,
      this.mcp,
      window?.id,
      countdown,
    ]);
    if (signature === this.lastPaint) return;
    this.lastPaint = signature;
    this.root.backgroundColor = styles["ui.text"].bg;
    this.text.bg = styles["ui.text"].bg;
    paintText(this.spinner.root, styles["ui.muted"]);
    const remaining =
      context?.usedTokens !== null && context?.usedTokens !== undefined && context.maxTokens > 0
        ? clampPercent((1 - context.usedTokens / context.maxTokens) * 100)
        : null;
    const contextMeter: Meter = {
      label: "context",
      percent: remaining,
      value: remaining === null ? "-" : `${percentage(remaining)} left`,
    };
    const usage: Meter = {
      label: hasIcon ? "  " : "usage",
      percent: window?.usedPercent ?? null,
      muted: recovering,
      value: recovering
        ? this.capturedAt === undefined
          ? ""
          : "-"
        : window
          ? `${percentage(window.usedPercent)} used`
          : "-",
    };
    const presentations = [
      [
        { ...contextMeter, label: `${icons.context} context` },
        { ...usage, label: providerName ? `   ${providerName}` : usage.label },
      ],
      [contextMeter, usage],
    ] as const;
    const width = totalWidth;
    const details =
      !recovering && window && countdown
        ? [
            `${usage.value} ${countdown}`,
            `${usage.value} ${countdown.replaceAll(" ", "")}`,
            usage.value,
          ]
        : [usage.value];
    const model = telemetry?.model ?? "model —",
      effort = telemetry?.effort ?? "—";
    const fast = telemetry?.fast === true ? "on" : telemetry?.fast === false ? "off" : "—";
    const chunk = (text: string, group: StyleGroup): TextChunk => styleChunk(text, styles[group]);
    const modelChunk = chunk(
      `${icons.model} ${model}`,
      telemetry?.model ? "metadata.model" : "ui.muted",
    );
    const effortChunk = chunk(
      `${icons.brain} ${effort}`,
      telemetry?.effort ? "metadata.effort" : "ui.muted",
    );
    const fastStyle =
      telemetry?.fast === true
        ? "metadata.fastOn"
        : telemetry?.fast === false
          ? "metadata.fastOff"
          : "ui.muted";
    const fullIdentity = [
      modelChunk,
      chunk(" · ", "ui.muted"),
      effortChunk,
      chunk(" · ", "ui.muted"),
      chunk(`${icons.bolt} fast ${fast}`, fastStyle),
    ];
    const mcpChunks: TextChunk[] = [];
    if (this.mcp && this.mcp.servers > 0) {
      const { servers, needsAuth, errors } = this.mcp;
      mcpChunks.push(chunk(` · ${icons.mcp} mcp ${servers}`, "ui.muted"));
      if (needsAuth || errors) {
        mcpChunks.push(chunk(" (", "ui.muted"));
        if (needsAuth)
          mcpChunks.push(
            chunk(`${needsAuth} ${needsAuth === 1 ? "needs" : "need"} auth`, "status.warning"),
          );
        if (needsAuth && errors) mcpChunks.push(chunk(" · ", "ui.muted"));
        if (errors)
          mcpChunks.push(chunk(`${errors} ${errors === 1 ? "error" : "errors"}`, "status.error"));
        mcpChunks.push(chunk(")", "ui.muted"));
      }
    }
    const identities = [
      ...(mcpChunks.length ? [[...fullIdentity, ...mcpChunks]] : []),
      fullIdentity,
      [
        modelChunk,
        chunk(" ", "ui.muted"),
        effortChunk,
        chunk(" ", "ui.muted"),
        chunk(`${icons.bolt} ${fast}`, fastStyle),
      ],
      [modelChunk],
      [],
    ].map((chunks) => ({ chunks, text: chunks.map((part) => part.text).join("") }));
    // Keep configuration and known percentages before spending cells on bars or provider detail.
    for (const identity of identities) {
      for (const presentation of presentations) {
        for (const detail of new Set(details)) {
          const meters = [presentation[0], { ...presentation[1], value: detail }];
          const base = meters.reduce(
            (size, meter) => size + cellWidth(`${meter.label} ${meter.value}`),
            2,
          );
          for (const barWidth of [8, 6, 4, 2, 0]) {
            const meterWidth =
              base +
              meters.reduce(
                (size, meter) => size + (barWidth && meter.percent !== null ? barWidth + 1 : 0),
                0,
              );
            const identityWidth = identity.text ? cellWidth(identity.text) + 2 : 0;
            if (meterWidth + identityWidth > width) continue;
            const chunks: TextChunk[] = identity.text
              ? [
                  ...identity.chunks,
                  chunk(" ".repeat(width - meterWidth - cellWidth(identity.text)), "ui.muted"),
                ]
              : [];
            const separation = identity.text ? 2 : 2 + width - meterWidth;
            chunks.push(
              ...meterChunks(meters[0]!, barWidth, colors, styles),
              chunk(" ".repeat(separation), "ui.muted"),
              ...meterChunks(meters[1]!, barWidth, colors, styles),
            );
            this.text.content = new StyledText(chunks);
            const usageWidth =
              cellWidth(`${meters[1]!.label} ${meters[1]!.value}`) +
              (barWidth && meters[1]!.percent !== null ? barWidth + 1 : 0);
            this.providerIcon.left = width - usageWidth;
            this.providerIcon.visible = hasIcon;
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

  private cancelExpiry(): void {
    if (this.expiry !== undefined) clearTimeout(this.expiry);
    this.expiry = undefined;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.visible = false;
    this.cancelExpiry();
    this.spinner.cancel();
    this.providerIcon.destroy();
  }
}
