import { BoxRenderable, RenderableEvents, StyledText, TextRenderable, type CliRenderer, type TextChunk } from "@opentui/core";
import type { SessionTelemetry } from "../telemetry.ts";
import { blendColors, uiTheme, type UiColors } from "../../ui/theme.ts";

type Meter = { label: string; percent: number | null };
const cellWidth = (text: string) => Bun.stringWidth(text);
const percentage = (value: number | null) => value === null ? "-" : `${Math.round(value)}%`;
const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

function meterChunks(meter: Meter, width: number, colors: UiColors): TextChunk[] {
  const chunks: TextChunk[] = [{ __isChunk: true, text: `${meter.label} `, fg: colors.muted }];
  if (width && meter.percent !== null) {
    const filled = meter.percent * width / 100;
    const partials = ["░", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];
    for (let cell = 0; cell < width; cell++) {
      const amount = Math.max(0, Math.min(1, filled - cell));
      const part = Math.floor(amount * 8);
      chunks.push({ __isChunk: true, text: partials[part]!,
        fg: part > 0 ? blendColors(colors.panel, colors.accent, 1 - 0.45 * cell / Math.max(1, width - 1))
          : blendColors(colors.panel, colors.text, 0.2) });
    }
    chunks.push({ __isChunk: true, text: " ", fg: colors.muted });
  }
  chunks.push({ __isChunk: true, text: percentage(meter.percent), fg: meter.percent === null ? colors.muted : colors.text });
  return chunks;
}

// Passive metadata above, and outside, the composer. Unknown meters never draw placeholder bars.
export class SessionStatus {
  readonly root: BoxRenderable;
  private readonly text: TextRenderable;
  private telemetry: SessionTelemetry | null = null;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private visible = false;
  private disposed = false;
  private lastPaint = "";

  constructor(private readonly renderer: CliRenderer) {
    this.root = new BoxRenderable(renderer, { id: "session-status", width: "100%", height: 1, flexShrink: 0,
      onSizeChange: () => this.paint() });
    this.text = new TextRenderable(renderer, { width: "100%", height: 1, wrapMode: "none", selectable: false });
    this.root.add(this.text);
    uiTheme(renderer).bind(this.root, () => { this.lastPaint = ""; this.paint(); });
    this.root.once(RenderableEvents.DESTROYED, () => this.dispose());
  }

  update(telemetry: SessionTelemetry | undefined, visible: boolean): void {
    this.telemetry = telemetry ?? null; this.visible = visible; this.root.visible = visible;
    this.cancelExpiry();
    const reset = telemetry?.weekly?.resetsAt;
    if (visible && reset !== undefined && reset > Date.now()) {
      this.expiry = setTimeout(() => { this.expiry = undefined; this.paint(); }, Math.min(2 ** 31 - 1, reset - Date.now()));
    }
    this.paint();
  }

  private paint(): void {
    if (this.disposed || !this.visible || !this.root || this.root.isDestroyed) return;
    const colors = uiTheme(this.renderer).colors;
    this.root.backgroundColor = colors.panel; this.text.bg = colors.panel;
    const width = Math.max(0, this.root.width);
    const telemetry = this.telemetry;
    const context = telemetry?.context;
    const weekly = telemetry?.weekly;
    const signature = JSON.stringify([width, telemetry, weekly !== null && weekly !== undefined && weekly.resetsAt > Date.now()]);
    if (signature === this.lastPaint) return;
    this.lastPaint = signature;
    const meters: Meter[] = [
      { label: "context", percent: context?.usedTokens !== null && context?.usedTokens !== undefined && context.maxTokens > 0
        ? clampPercent((1 - context.usedTokens / context.maxTokens) * 100) : null },
      { label: "weekly", percent: weekly && weekly.resetsAt > Date.now() ? weekly.remainingPercent : null },
    ];
    const model = telemetry?.model ?? "model —";
    const effort = telemetry?.effort ?? "—";
    const fast = telemetry?.fast === true ? "on" : telemetry?.fast === false ? "off" : "—";
    const identities = [`${model} · ${effort} · Fast ${fast}`, `${model} ${effort} F${fast === "on" ? "+" : fast === "off" ? "−" : "?"}`,
      model, ""];
    const base = meters.reduce((size, meter) => size + cellWidth(`${meter.label} ${percentage(meter.percent)}`), 2);
    for (const identity of identities) {
      for (const barWidth of [8, 6, 4, 2, 0]) {
        const meterWidth = base + meters.reduce((size, meter) => size + (barWidth && meter.percent !== null ? barWidth + 1 : 0), 0);
        const identityWidth = identity ? cellWidth(identity) + 2 : 0;
        if (meterWidth + identityWidth > width) continue;
        const chunks: TextChunk[] = identity ? [{ __isChunk: true, text: identity + " ".repeat(width - meterWidth - cellWidth(identity)), fg: colors.muted }] : [];
        chunks.push(...meterChunks(meters[0]!, barWidth, colors), { __isChunk: true, text: "  ", fg: colors.muted },
          ...meterChunks(meters[1]!, barWidth, colors));
        this.text.content = new StyledText(chunks);
        return;
      }
    }
    // Extremely narrow panels still omit whole values, never truncate a percentage into another meaning.
    const compact = meters.map((meter) => `${meter.label} ${percentage(meter.percent)}`).join(" ");
    this.text.content = cellWidth(compact) <= width ? compact : width >= 9 ? "context -" : "-";
    this.text.fg = colors.muted;
  }

  private cancelExpiry(): void { if (this.expiry) clearTimeout(this.expiry); this.expiry = undefined; }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.visible = false; this.cancelExpiry(); }
}
