import { BoxRenderable, RenderableEvents, StyledText, TextRenderable, type CliRenderer } from "@opentui/core";
import type { ExecutionState } from "../session-registry.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import { singleLine, truncateCells } from "../../ui/text.ts";
import { uiTheme, type UiColors } from "../../ui/theme.ts";
import type { RequestSummary } from "../request-summary.ts";
import { formatRequestCaption, requestForSection } from "./request-caption.ts";

type Display = { label: string; detail: string; color: "accent" | "error" | "warning" | "muted"; request?: RequestSummary };

function display(state: ExecutionState | null | undefined): Display {
  const sections = state?.sections ?? [];
  const index = sections.findLastIndex((section) => section.kind === "user" || section.skillName !== undefined);
  const section = index >= 0 ? sections[index] : undefined;
  const summary = requestForSection(section), request = summary?.text ?? "";
  const detail = request ? ` “${request}”` : "";
  if (state?.status === "working") return { label: summary && (request || summary.images || summary.files) ? "Working on" : "Working…", detail, color: "accent", ...(summary ? { request: summary } : {}) };
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

  constructor(private readonly renderer: CliRenderer) {
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
    if (scope !== this.scope || !visible) { this.spinner.cancel(); this.running = false; }
    this.scope = scope; this.root.visible = visible; this.current = display(state);
    const running = visible && state?.status === "working";
    if (running && !this.running) this.spinner.start();
    else if (!running && this.running) this.spinner.stop();
    this.running = running; this.paint();
  }

  private paint(): void {
    if (!this.root || this.root.isDestroyed || !this.text || this.disposed) return;
    const colors: UiColors = uiTheme(this.renderer).colors;
    this.spinner.root.fg = colors.accent;
    this.text.visible = !!this.current.label;
    const width = Math.max(0, this.root.width - 2), label = truncateCells(this.current.label, width);
    const remaining = width - Bun.stringWidth(label), request = this.current.request;
    const caption = request ? formatRequestCaption({ ...request, text: request.text ? `“${request.text}”` : "" }, remaining - 1) : "";
    this.text.content = new StyledText([
      { __isChunk: true, text: label, fg: colors[this.current.color] },
      { __isChunk: true, text: request ? caption ? ` ${caption}` : "" : truncateCells(this.current.detail, remaining), fg: colors.text },
    ]);
  }

  dispose(): void { if (this.disposed) return; this.disposed = true; this.spinner.cancel(); }
}
