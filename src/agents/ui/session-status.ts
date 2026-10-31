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
import { styleChunk, type StyleGroup, type UiStyles } from "../../ui/theme-styles.ts";
import { icons } from "../../icons.ts";

type Meter = { label: string; percent: number | null; value: string };

const cellWidth = (text: string) => Bun.stringWidth(text);
const percentage = (value: number | null) => (value === null ? "-" : `${Math.round(value)}%`);
const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

function meterWidth(meter: Meter, barWidth: number): number {
  return (
    cellWidth(`${meter.label} ${meter.value}`) +
    (barWidth && meter.percent !== null ? barWidth + 1 : 0)
  );
}

function meterChunks(meter: Meter, width: number, colors: UiColors, styles: UiStyles): TextChunk[] {
  const labelStyle = styles["ui.label"];
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
            : blendColors(
                colors.panel,
                styles["metadata.meter"].fg,
                1 - (0.45 * cell) / Math.max(1, width - 1),
              ),
      });
    }

    chunks.push(styleChunk(" ", styles["ui.muted"]));
  }

  chunks.push(styleChunk(meter.value, styles[meter.percent === null ? "ui.muted" : "ui.label"]));

  return chunks;
}

// Passive session metadata below the composer. Account usage belongs to the global footer.
export class SessionStatus {
  readonly root: BoxRenderable;
  private readonly text: TextRenderable;
  private telemetry: SessionTelemetry | null = null;
  private mcp: McpStatus | undefined;
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
    uiTheme(renderer).bind(this.root, () => {
      this.lastPaint = "";
      this.paint();
    });
    this.root.once(RenderableEvents.DESTROYED, () => this.dispose());
  }

  // History still supplies its capture time; session metadata no longer depends on a local clock.
  update(telemetry: SessionTelemetry | undefined, visible: boolean, _capturedAt?: number): void {
    if (this.disposed) {
      return;
    }

    this.telemetry = telemetry ?? null;
    this.visible = visible;
    this.root.visible = visible;
    this.paint();
  }

  updateMcp(status: McpStatus | undefined): void {
    if (this.disposed) {
      return;
    }

    this.mcp = status;
    this.paint();
  }

  private paint(): void {
    if (this.disposed || !this.visible || !this.root || this.root.isDestroyed) {
      return;
    }

    const { colors, styles } = uiTheme(this.renderer);
    const telemetry = this.telemetry;
    const totalWidth = Math.max(0, this.root.width);
    const context = telemetry?.context;
    const signature = JSON.stringify([
      totalWidth,
      telemetry?.model,
      telemetry?.effort,
      telemetry?.fast,
      context,
      this.mcp,
    ]);
    if (signature === this.lastPaint) {
      return;
    }

    this.lastPaint = signature;
    this.root.backgroundColor = styles["ui.text"].bg;
    this.text.bg = styles["ui.text"].bg;

    const remaining =
      context?.usedTokens !== null && context?.usedTokens !== undefined && context.maxTokens > 0
        ? clampPercent((1 - context.usedTokens / context.maxTokens) * 100)
        : null;
    const contextMeter: Meter = {
      label: icons.context,
      percent: remaining,
      value: remaining === null ? "-" : `${percentage(remaining)} left`,
    };
    const model = telemetry?.model ?? "model —";
    const effort = telemetry?.effort ?? "—";
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
        if (needsAuth) {
          mcpChunks.push(
            chunk(`${needsAuth} ${needsAuth === 1 ? "needs" : "need"} auth`, "status.warning"),
          );
        }
        if (needsAuth && errors) {
          mcpChunks.push(chunk(" · ", "ui.muted"));
        }
        if (errors) {
          mcpChunks.push(chunk(`${errors} ${errors === 1 ? "error" : "errors"}`, "status.error"));
        }

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

    // Shrink bars before optional metadata, while keeping known context values at the right edge.
    for (const value of [contextMeter.value, percentage(remaining)]) {
      const meter = { ...contextMeter, value };
      for (const identity of identities) {
        for (const barWidth of [8, 6, 4, 2, 0]) {
          const contextWidth = meterWidth(meter, barWidth);
          const identityWidth = cellWidth(identity.text);
          const gap = identityWidth ? 2 : 0;
          if (identityWidth + gap + contextWidth > totalWidth) {
            continue;
          }

          const padding = totalWidth - contextWidth - identityWidth;
          this.text.content = new StyledText([
            ...identity.chunks,
            chunk(" ".repeat(padding), "ui.muted"),
            ...meterChunks(meter, barWidth, colors, styles),
          ]);

          return;
        }
      }
    }

    const ratio = percentage(remaining);
    const value = cellWidth(ratio) <= totalWidth ? ratio : totalWidth ? "-" : "";
    this.text.content = new StyledText([
      chunk(" ".repeat(totalWidth - cellWidth(value)), "ui.muted"),
      chunk(value, remaining === null ? "ui.muted" : "ui.label"),
    ]);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.visible = false;
  }
}
