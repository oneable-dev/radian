import { BoxRenderable, RenderableEvents, StyledText, TextAttributes, TextRenderable, type CliRenderer } from "@opentui/core";
import type { ExecutionState } from "../session-registry.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import { singleLine, truncateCells } from "../../ui/text.ts";
import { uiTheme, type UiColors } from "../../ui/theme.ts";
import type { RequestSummary } from "../request-summary.ts";
import { formatRequestCaption, requestForSection } from "./request-caption.ts";
import { formatRunDuration } from "./run-completion.ts";

type Display = { label: string; detail: string; color: "accent" | "error" | "warning" | "muted"; request?: RequestSummary; durationMs?: number };

function display(state: ExecutionState | null | undefined): Display {
  if (state?.status === "working" && state.activity === "compacting") return { label: "Compacting context", detail: "", color: "accent" };
  const sections = state?.sections ?? [];
  const index = sections.findLastIndex((section) => requestForSection(section) !== undefined);
  const section = index >= 0 ? sections[index] : undefined;
  const summary = requestForSection(section), request = summary?.text ?? "";
  const detail = request ? ` “${request}”` : "";
  if (state?.status === "working") return { label: "Working", detail, color: "accent", ...(summary ? { request: summary } : {}) };
  if (state?.status === "failure") return { label: "Failed", detail: state.error ? `: ${singleLine(state.error)}` : detail, color: "error" };
  // Timing/status metadata must belong to this request, not an earlier completed turn.
  const turn = sections.slice(Math.max(0, index));
  const completion = turn.findLast((item) => item.completion)?.completion;
  const outcome = completion?.outcome;
  const assistant = turn.findLast((item) => item.kind === "assistant" || item.kind === "notice" && item.status === "cancelled"
    && (item.title === "Agent error" || !item.text));
  if (outcome === "cancelled" || !outcome && assistant?.status === "cancelled") return { label: "Cancelled", detail, color: "warning",
    ...(summary ? { request: summary } : {}), ...(completion ? { durationMs: completion.durationMs } : {}) };
  if (outcome === "unfinished" || !outcome && assistant?.status === "unfinished") return { label: "Stopped", detail, color: "warning" };
  if (outcome === "error" || state?.error) return { label: "Failed", detail: state?.error ? `: ${singleLine(state.error)}` : detail, color: "error" };
  return { label: "", detail: "", color: "muted" };
}

// Only runtime transcript requests can label the work; drafts, admissions and lookup results cannot.
export class RunStatus {
  readonly root: BoxRenderable;
  private readonly text: TextRenderable;
  private readonly spinner: LoadingSpinner;
  private current: Display = display(undefined);
  private scope: string | null = null;
  private running = false;
  private disposed = false;
  private timer: ReturnType<CliRenderer["clock"]["setInterval"]> | undefined;
  private elapsed = 0;
  private sampledAt = 0;
  private timing: ExecutionState["runTiming"];

  constructor(private readonly renderer: CliRenderer, private readonly interruptKey: () => string = () => "esc") {
    this.root = new BoxRenderable(renderer, { id: "agent-run-status", width: "auto", height: 1, minWidth: 0,
      flexGrow: 1, flexShrink: 1, flexDirection: "row", gap: 1, onSizeChange: () => this.paint() });
    this.spinner = new LoadingSpinner(renderer, { id: "agent-run-loading" });
    this.text = new TextRenderable(renderer, { id: "agent-run-status-text", width: "auto", height: 1, minWidth: 0,
      flexGrow: 1, flexShrink: 1, selectable: false, wrapMode: "none", onSizeChange: () => this.paint() });
    // Hidden loading feedback must not leave a fixed slot or a gap before static text.
    this.root.add(this.spinner.root); this.root.add(this.text);
    uiTheme(renderer).bind(this.root, () => this.paint());
    this.root.once(RenderableEvents.DESTROYED, () => this.dispose());
  }

  get hasContent(): boolean { return this.root.visible && (!!this.current.label || this.spinner.root.visible); }

  update(sessionId: string | null, state: ExecutionState | null | undefined, visible: boolean): void {
    if (this.disposed || this.root.isDestroyed) return;
    const scope = sessionId ? JSON.stringify([sessionId, state?.conversationId]) : null;
    if (scope !== this.scope || !visible) { this.spinner.cancel(); this.running = false; this.stopTimer(); this.timing = undefined; }
    this.scope = scope; this.root.visible = visible; this.current = display(state);
    const running = visible && state?.status === "working";
    if (running && !this.running) { this.spinner.start(); this.elapsed = 0; this.sampledAt = this.renderer.clock.now(); }
    else if (!running && this.running) this.spinner.stop();
    if (running && state?.runTiming && (this.timing?.startedAt !== state.runTiming.startedAt || this.timing.elapsedMs !== state.runTiming.elapsedMs)) {
      this.timing = state.runTiming; this.elapsed = state.runTiming.elapsedMs; this.sampledAt = this.renderer.clock.now();
    }
    this.running = running;
    if (running && this.timer === undefined) this.timer = this.renderer.clock.setInterval(() => this.paint(), 1000);
    else if (!running) this.stopTimer();
    this.paint();
  }

  private paint(): void {
    if (!this.root || this.root.isDestroyed || !this.text || this.disposed) return;
    const colors: UiColors = uiTheme(this.renderer).colors;
    this.spinner.root.fg = colors.accent;
    this.text.visible = !!this.current.label;
    const width = Math.max(0, this.root.width - (this.spinner.root.visible ? 2 : 0));
    const seconds = Math.floor((this.elapsed + Math.max(0, this.renderer.clock.now() - this.sampledAt)) / 1000);
    const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const key = this.running ? this.interruptKey().toLowerCase() : "";
    const duration = this.running ? elapsed : this.current.durationMs === undefined ? "" : formatRunDuration(this.current.durationMs);
    const timedLabel = duration ? `${this.current.label} (${duration}` : this.current.label;
    const requestReserve = this.current.request ? this.current.request.images || this.current.request.files ? 28 : 12 : 0;
    const showHint = !!key && Bun.stringWidth(`${timedLabel} · ${key} to interrupt)`) + requestReserve <= width;
    const label = truncateCells(timedLabel + (duration && !showHint ? ")" : ""), width);
    const hint = showHint ? ` · ${key} to interrupt)` : "";
    const remaining = width - Bun.stringWidth(label + hint), request = this.current.request;
    const caption = request ? formatRequestCaption({ ...request, text: request.text ? `“${request.text}”` : "" }, remaining - 1) : "";
    const statusLabel = label.slice(0, this.current.label.length);
    const elapsedLabel = label.slice(this.current.label.length);
    this.text.content = new StyledText([
      { __isChunk: true, text: statusLabel, fg: colors[this.current.color] },
      ...(elapsedLabel ? [{ __isChunk: true as const, text: elapsedLabel, fg: colors.muted }] : []),
      ...(showHint ? [
        { __isChunk: true as const, text: " · ", fg: colors.muted },
        { __isChunk: true as const, text: key, fg: colors.text, attributes: TextAttributes.BOLD },
        { __isChunk: true as const, text: " to interrupt)", fg: colors.muted },
      ] : []),
      { __isChunk: true, text: request ? caption ? ` ${caption}` : "" : truncateCells(this.current.detail, remaining), fg: colors.text },
    ]);
  }

  private stopTimer(): void { if (this.timer !== undefined) this.renderer.clock.clearInterval(this.timer); this.timer = undefined; }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.spinner.cancel(); this.stopTimer(); }
}
