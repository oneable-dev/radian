import { BoxRenderable, RenderableEvents, StyledText, TextAttributes, TextRenderable, type CliRenderer } from "@opentui/core";
import type { ExecutionState } from "../session-registry.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import { singleLine, truncateCells } from "../../ui/text.ts";
import { uiTheme, type UiColors } from "../../ui/theme.ts";
import type { RequestSummary } from "../request-summary.ts";
import { formatRequestCaption, requestForSection } from "./request-caption.ts";

type Display = { label: string; detail: string; color: "accent" | "error" | "warning" | "muted"; request?: RequestSummary };

function display(state: ExecutionState | null | undefined): Display {
  if (state?.status === "working" && state.activity === "compacting") return { label: "Compacting context", detail: "", color: "accent" };
  const sections = state?.sections ?? [];
  const index = sections.findLastIndex((section) => section.kind === "user" || section.skillName !== undefined);
  const section = index >= 0 ? sections[index] : undefined;
  const summary = requestForSection(section), request = summary?.text ?? "";
  const detail = request ? ` “${request}”` : "";
  if (state?.status === "working") return { label: "Working", detail, color: "accent", ...(summary ? { request: summary } : {}) };
  if (state?.status === "failure") return { label: "Failed", detail: state.error ? `: ${singleLine(state.error)}` : detail, color: "error" };
  // Timing/status metadata must belong to this request, not an earlier completed turn.
  const turn = sections.slice(Math.max(0, index));
  const outcome = turn.findLast((item) => item.completion)?.completion?.outcome;
  const assistant = turn.findLast((item) => item.kind === "assistant");
  if (outcome === "cancelled" || !outcome && assistant?.status === "cancelled") return { label: "Cancelled", detail, color: "warning" };
  if (outcome === "unfinished" || !outcome && assistant?.status === "unfinished") return { label: "Stopped", detail, color: "warning" };
  if (outcome === "error" || state?.error) return { label: "Failed", detail: state?.error ? `: ${singleLine(state.error)}` : detail, color: "error" };
  if (outcome === "complete" || state?.status === "complete") return { label: "", detail: "", color: "muted" };
  const hasTranscript = state?.sections !== undefined ? sections.length > 0 : !!state?.output;
  return { label: hasTranscript ? "Ready" : "", detail: "", color: "muted" };
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
    const slot = new BoxRenderable(renderer, { width: 1, height: 1, flexShrink: 0 });
    this.spinner = new LoadingSpinner(renderer, { id: "agent-run-loading" }); slot.add(this.spinner.root);
    this.text = new TextRenderable(renderer, { id: "agent-run-status-text", width: "auto", height: 1, minWidth: 0,
      flexGrow: 1, flexShrink: 1, selectable: false, wrapMode: "none" });
    this.root.add(slot); this.root.add(this.text);
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
    const width = Math.max(0, this.root.width - 2);
    const seconds = Math.floor((this.elapsed + Math.max(0, this.renderer.clock.now() - this.sampledAt)) / 1000);
    const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const key = this.running ? this.interruptKey().toLowerCase() : "";
    const timedLabel = this.running ? `${this.current.label} (${elapsed}` : this.current.label;
    const requestReserve = this.current.request ? this.current.request.images || this.current.request.files ? 28 : 12 : 0;
    const showHint = !!key && Bun.stringWidth(`${timedLabel} · ${key} to interrupt)`) + requestReserve <= width;
    const label = truncateCells(timedLabel + (this.running && !showHint ? ")" : ""), width);
    const hint = showHint ? ` · ${key} to interrupt)` : "";
    const remaining = width - Bun.stringWidth(label + hint), request = this.current.request;
    const caption = request ? formatRequestCaption({ ...request, text: request.text ? `“${request.text}”` : "" }, remaining - 1) : "";
    const statusLabel = this.running ? label.slice(0, this.current.label.length) : label;
    const elapsedLabel = this.running ? label.slice(this.current.label.length) : "";
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
