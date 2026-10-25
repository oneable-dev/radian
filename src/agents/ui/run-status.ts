import { BoxRenderable, RenderableEvents, StyledText, TextAttributes, TextRenderable, type CliRenderer, type TextChunk } from "@opentui/core";
import type { ExecutionState } from "../session-registry.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import { FastModeAnimation } from "../../ui/fast-mode-animation.ts";
import { singleLine, truncateCells } from "../../ui/text.ts";
import { blendColors, uiTheme } from "../../ui/theme.ts";
import { paintText, styleChunk, type StyleGroup, type UiStyles } from "../../ui/theme-styles.ts";
import type { RequestSummary } from "../request-summary.ts";
import { formatWorkRequest, requestForSection } from "./request-caption.ts";
import { formatRunDuration } from "./run-completion.ts";

type Display = { label: string; detail: string; color: StyleGroup; request?: RequestSummary; durationMs?: number };

function display(state: ExecutionState | null | undefined): Display {
  if (state?.status === "working" && state.activity === "compacting") return { label: "Compacting context", detail: "", color: "status.working" };
  const sections = state?.sections ?? [];
  const index = sections.findLastIndex((section) => requestForSection(section) !== undefined);
  const section = index >= 0 ? sections[index] : undefined;
  const summary = requestForSection(section), request = summary?.text ?? "";
  const detail = request ? ` “${request}”` : "";
  if (state?.status === "working") return { label: "Working", detail, color: "status.working", ...(summary ? { request: summary } : {}) };
  if (state?.status === "failure") return { label: "Failed", detail: state.error ? `: ${singleLine(state.error)}` : detail, color: "status.error" };
  const turn = sections.slice(Math.max(0, index));
  const completion = turn.findLast((item) => item.completion)?.completion;
  const outcome = state?.result?.outcome ?? completion?.outcome;
  const assistant = turn.findLast((item) => item.kind === "assistant" || item.kind === "notice" && item.status === "cancelled"
    && (item.title === "Agent error" || !item.text));
  if (outcome === "cancelled" || !outcome && assistant?.status === "cancelled") return { label: "Cancelled", detail, color: "ui.muted",
    ...(summary ? { request: summary } : {}), ...(completion ? { durationMs: completion.durationMs } : {}) };
  if (outcome === "unfinished" || !outcome && assistant?.status === "unfinished") return { label: "Stopped", detail, color: "status.error" };
  if (outcome === "error" || state?.error) return { label: "Failed", detail: state?.error ? `: ${singleLine(state.error)}` : detail, color: "status.error" };
  return { label: "", detail: "", color: "status.unknown" };
}

function workingChunks(label: string, phase: number | null, styles: UiStyles): TextChunk[] {
  const style = styles["metadata.fastOn"];
  if (phase === null || phase <= 0 || phase >= 0.6) return [styleChunk(label, style)];
  const radius = 2, head = (Bun.stringWidth(label) + radius * 2) * phase / 0.6 - radius;
  const highlight = blendColors(style.fg, styles["ui.text"].fg, 0.9);
  return Array.from(label, (glyph, index) => {
    const intensity = Math.max(0, 1 - Math.abs(index + 0.5 - head) / radius);
    return { ...styleChunk(glyph, style), fg: blendColors(style.fg, highlight, intensity * intensity) };
  });
}

// Only runtime transcript requests can label the work; drafts and lookup results cannot.
export class RunStatus {
  readonly root: BoxRenderable;
  private readonly text: TextRenderable;
  private readonly caption: TextRenderable;
  private readonly spinner: LoadingSpinner;
  private readonly animation: FastModeAnimation;
  private current: Display = display(undefined);
  private scope: string | null = null;
  private running = false;
  private fast = false;
  private phase: number | null = null;
  private captionAllowed = true;
  private rowCount = 1;
  private disposed = false;
  private timer: ReturnType<CliRenderer["clock"]["setInterval"]> | undefined;
  private elapsed = 0;
  private sampledAt = 0;
  private timing: ExecutionState["runTiming"];

  constructor(private readonly renderer: CliRenderer, private readonly interruptKey: () => string = () => "<Esc>",
    private readonly beforeResize: () => void = () => {}) {
    this.root = new BoxRenderable(renderer, { id: "agent-run-status", width: "auto", height: 1, minWidth: 0,
      flexGrow: 1, flexShrink: 1, flexDirection: "column", onSizeChange: () => this.paint() });
    const heading = new BoxRenderable(renderer, { width: "100%", height: 1, minWidth: 0, flexShrink: 0, flexDirection: "row", gap: 1 });
    this.spinner = new LoadingSpinner(renderer, { id: "agent-run-loading" });
    this.text = new TextRenderable(renderer, { id: "agent-run-status-text", width: "auto", height: 1, minWidth: 0,
      flexGrow: 1, flexShrink: 1, selectable: false, wrapMode: "none", onSizeChange: () => this.paint() });
    this.caption = new TextRenderable(renderer, { id: "agent-run-request", width: "auto", height: 1, minWidth: 0,
      flexShrink: 0, selectable: false, wrapMode: "none", visible: false });
    heading.add(this.spinner.root); heading.add(this.text); this.root.add(heading); this.root.add(this.caption);
    this.animation = new FastModeAnimation(renderer, this.root, frame => {
      const phase = frame?.phase ?? null;
      if (phase === this.phase) return;
      this.phase = phase; this.paint();
    });
    uiTheme(renderer).bind(this.root, () => this.paint());
    this.root.once(RenderableEvents.DESTROYED, () => this.dispose());
  }

  get hasContent(): boolean { return this.root.visible && (!!this.current.label || this.spinner.root.visible); }
  get rows(): number { return this.hasContent ? this.rowCount : 0; }

  fitRows(available: number): void {
    const allowed = available >= 2;
    if (allowed === this.captionAllowed) return;
    this.captionAllowed = allowed; this.paint();
  }

  update(sessionId: string | null, state: ExecutionState | null | undefined, visible: boolean, animate = true): void {
    if (this.disposed || this.root.isDestroyed) return;
    const scope = sessionId ? JSON.stringify([sessionId, state?.conversationId]) : null;
    if (scope !== this.scope || !visible) { this.spinner.cancel(); this.running = false; this.stopTimer(); this.timing = undefined; }
    this.scope = scope; this.root.visible = visible; this.current = display(state);
    const running = visible && state?.status === "working";
    this.fast = running && this.current.label === "Working" && state?.telemetry?.fast === true;
    this.spinner.setFast(this.fast);
    if (running && !this.running) { this.spinner.start(); this.elapsed = 0; this.sampledAt = this.renderer.clock.now(); }
    else if (!running && this.running) this.spinner.stop();
    if (running && state?.runTiming && (this.timing?.startedAt !== state.runTiming.startedAt || this.timing.elapsedMs !== state.runTiming.elapsedMs)) {
      this.timing = state.runTiming; this.elapsed = state.runTiming.elapsedMs; this.sampledAt = this.renderer.clock.now();
    }
    this.running = running;
    if (running && this.timer === undefined) this.timer = this.renderer.clock.setInterval(() => this.paint(), 1000);
    else if (!running) this.stopTimer();
    this.animation.update(this.fast, animate); this.paint();
  }

  private paint(): void {
    if (!this.root || this.root.isDestroyed || !this.text || !this.caption || this.disposed) return;
    const styles = uiTheme(this.renderer).styles;
    paintText(this.spinner.root, styles["status.working"]);
    this.text.visible = !!this.current.label;
    const prefix = this.spinner.root.visible ? this.spinner.columns + 1 : 0;
    const width = Math.max(0, this.root.width - prefix), request = this.current.request;
    const split = !!(this.running && this.captionAllowed && request && (request.text.trim() || request.images || request.files));
    const rows = split ? 2 : 1;
    if (rows !== this.rowCount) { this.beforeResize(); this.rowCount = rows; this.root.height = rows; }
    const seconds = Math.floor((this.elapsed + Math.max(0, this.renderer.clock.now() - this.sampledAt)) / 1000);
    const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const key = this.running ? this.interruptKey() : "";
    const duration = this.running ? elapsed : this.current.durationMs === undefined ? "" : formatRunDuration(this.current.durationMs);
    const timedLabel = duration ? `${this.current.label} (${duration}` : this.current.label;
    const requestReserve = !split && request ? request.images || request.files ? 28 : 12 : 0;
    const showHint = !!key && Bun.stringWidth(`${timedLabel} · ${key} to interrupt)`) + requestReserve <= width;
    const label = truncateCells(timedLabel + (duration && !showHint ? ")" : ""), width);
    const hint = showHint ? ` · ${key} to interrupt)` : "";
    const remaining = width - Bun.stringWidth(label + hint);
    const caption = request ? formatWorkRequest(request, this.root.width, split ? this.root.width : remaining - 1) : "";
    const statusLabel = label.slice(0, this.current.label.length), elapsedLabel = label.slice(this.current.label.length);
    this.text.content = new StyledText([
      ...(this.fast ? workingChunks(statusLabel, this.phase, styles) : [styleChunk(statusLabel, styles[this.current.color])]),
      ...(elapsedLabel ? [styleChunk(elapsedLabel, styles["status.elapsed"])] : []),
      ...(showHint ? [styleChunk(" · ", styles["status.elapsed"]),
        { ...styleChunk(key, styles["ui.label"]), attributes: styles["ui.label"].attributes | TextAttributes.BOLD },
        styleChunk(" to interrupt)", styles["status.elapsed"])] : []),
      ...(!split ? [styleChunk(request ? caption ? ` ${caption}` : "" : truncateCells(this.current.detail, remaining), styles["ui.label"])] : []),
    ]);
    this.caption.visible = split;
    this.caption.content = split ? caption : ""; paintText(this.caption, styles["status.elapsed"]);
  }

  private stopTimer(): void { if (this.timer !== undefined) this.renderer.clock.clearInterval(this.timer); this.timer = undefined; }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.animation.dispose(); this.spinner.cancel(); this.stopTimer(); }
}
