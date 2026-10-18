import { BoxRenderable, RenderableEvents, TextRenderable, type CliRenderer } from "@opentui/core";
import type { CommandId } from "../../keybindings/commands.ts";
import { reportUnexpected, type ExpectedError } from "../../errors.ts";
import type { Result } from "../../result.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import { uiTheme } from "../../ui/theme.ts";
import { completionTarget, insertCompletion, type CompletionQuery, type CompletionResult, type CompletionTarget } from "../completion.ts";
import type { PromptInput } from "./prompt-input.ts";

export type CompletionProvider = (sessionId: string, query: CompletionQuery, signal: AbortSignal) => Promise<Result<CompletionResult, ExpectedError>>;
type LookupContext = { sessionId: string; target: CompletionTarget; lookup: string; scope: string };
const debounceMs = 150;

// The input keeps focus. This menu owns only suggestions and never submits a prompt or executes a command.
export class CompletionMenu {
  readonly root: BoxRenderable;
  private readonly header: TextRenderable;
  private readonly spinner: LoadingSpinner;
  private readonly rows: TextRenderable[] = [];
  private readonly heading: BoxRenderable;
  private result: CompletionResult = { items: [], truncated: false };
  private target: CompletionTarget | null = null;
  private selected = 0;
  private first = 0;
  private generation = 0;
  private lookup = "";
  private resolvedLookup = "";
  private scope = "";
  private dismissed = "";
  private message = "";
  private pending = false;
  private timer: ReturnType<CliRenderer["clock"]["setTimeout"]> | undefined;
  private abort: AbortController | undefined;
  private queued = false;
  private disposed = false;

  constructor(private readonly renderer: CliRenderer, private readonly input: PromptInput,
    private readonly sessionId: () => string | null, private readonly provider: CompletionProvider | undefined,
    private readonly changed: () => void, private readonly availableRows: () => number = () => 5) {
    this.root = new BoxRenderable(renderer, { id: "prompt-completions", width: "100%", height: 1, flexShrink: 0, visible: false, flexDirection: "column", paddingX: 1 });
    this.heading = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", gap: 1 });
    this.spinner = new LoadingSpinner(renderer);
    this.header = new TextRenderable(renderer, { height: 1, flexGrow: 1, minWidth: 0, wrapMode: "none", selectable: false });
    const indicator = new BoxRenderable(renderer, { width: 1, height: 1, flexShrink: 0 });
    // Anchor activity to the menu, not the optional header: a one-row menu can
    // show its result immediately while the shared spinner finishes its 500ms tail.
    this.spinner.root.position = "absolute"; this.spinner.root.left = 1; this.spinner.root.top = 0; this.spinner.root.zIndex = 1;
    this.heading.add(indicator); this.heading.add(this.header); this.root.add(this.heading);
    for (let index = 0; index < 5; index++) {
      const row = new TextRenderable(renderer, { id: `completion-option-${index}`, width: "100%", height: 1, flexShrink: 0, wrapMode: "none", selectable: false,
        onMouseDown: (event) => {
          if (event.button !== 0) return;
          event.preventDefault(); event.stopPropagation();
          if (!this.available("completion.accept")) return;
          this.selected = this.first + index; this.accept();
        } });
      this.rows.push(row); this.root.add(row);
    }
    this.root.add(this.spinner.root);
    uiTheme(renderer).bind(this.root, (colors) => {
      this.root.backgroundColor = colors.surface; this.header.fg = colors.muted; this.spinner.root.fg = colors.accent; this.paint();
    });
    input.on("focused", this.refresh); input.on("blurred", this.blur);
    input.onCursorChange = () => { this.refresh(); this.changed(); };
    renderer.on("resize", this.paint);
    this.root.once(RenderableEvents.DESTROYED, () => this.dispose());
  }

  get open(): boolean { return this.root.visible; }
  // Include a freshly typed trigger before its queued render, so a burst of / + Enter cannot submit it.
  get engaged(): boolean { return this.context() !== null; }
  private signature(): string { return JSON.stringify([this.sessionId(), this.input.value, this.input.cursorOffset]); }
  private context(): LookupContext | null {
    if (this.disposed || this.root.isDestroyed || this.input.isDestroyed || !this.provider || !this.input.focused || this.signature() === this.dismissed) return null;
    const sessionId = this.sessionId();
    const target = completionTarget(this.input.value, this.input.editBuffer.getTextRange(0, this.input.cursorOffset).length);
    return sessionId && target ? { sessionId, target, lookup: JSON.stringify([sessionId, target.kind, target.query]), scope: JSON.stringify([sessionId, target.kind]) } : null;
  }
  private fresh(context: LookupContext): boolean { return this.open && !this.pending && this.resolvedLookup === context.lookup; }
  refresh = (): void => {
    if (this.queued || this.disposed || this.root.isDestroyed || this.input.isDestroyed) return;
    this.queued = true;
    queueMicrotask(() => { this.queued = false; if (!this.disposed) this.update(); });
  };
  private update(): void {
    const context = this.context(), provider = this.provider;
    if (!context || !provider) { this.hide(); return; }
    this.target = context.target;
    if (this.open && this.lookup === context.lookup) return;
    this.cancelRequest();
    const abort = this.abort = new AbortController(), generation = ++this.generation;
    if (this.scope !== context.scope) { this.result = { items: [], truncated: false }; this.selected = 0; this.first = 0; this.resolvedLookup = ""; }
    this.scope = context.scope; this.lookup = context.lookup;
    if (!this.pending) this.spinner.start();
    this.pending = true; this.message = this.result.items.length ? "" : "Loading…";
    this.root.visible = true; this.paint(); this.changed();
    this.timer = this.renderer.clock.setTimeout(() => {
      this.timer = undefined;
      void Promise.resolve().then(async () => {
        if (!this.current(generation, abort, context.lookup)) return;
        const result = await provider(context.sessionId, context.target, abort.signal);
        if (!this.current(generation, abort, context.lookup)) return;
        this.pending = false; this.spinner.stop();
        if (result.ok) {
          const previous = this.result.items[this.selected];
          this.result = result.value; this.resolvedLookup = context.lookup;
          this.selected = Math.max(0, this.result.items.findIndex((item) => item.kind === previous?.kind && item.value === previous?.value));
          this.message = result.value.items.length ? "" : `No matches${result.value.truncated ? " in the first page · refine search" : ""}`;
        } else if (result.error.code === "CANCELLED") { this.hide(); return; }
        else { this.clearResults(); this.message = `[${result.error.code}] ${result.error.message}`; }
        this.paint(); this.changed();
      }).catch((error: unknown) => {
        if (!this.current(generation, abort, context.lookup)) return;
        this.pending = false; this.spinner.stop(); this.clearResults();
        this.message = reportUnexpected(error, "prompt completion"); this.paint(); this.changed();
      });
    }, debounceMs);
  }
  private current(generation: number, abort: AbortController, lookup: string): boolean {
    return !this.disposed && generation === this.generation && !abort.signal.aborted && this.context()?.lookup === lookup;
  }
  private clearResults(): void { this.result = { items: [], truncated: false }; this.resolvedLookup = ""; this.selected = 0; this.first = 0; }
  available(command: CommandId): boolean {
    const context = this.context();
    if (!context) return false;
    if (command === "completion.dismiss") return true;
    if (!this.open || !this.result.items.length || this.scope !== context.scope) return false;
    return command === "completion.accept" ? this.fresh(context) : command === "completion.next" || command === "completion.previous";
  }
  command(command: CommandId): void {
    if (!this.available(command)) return;
    if (command === "completion.dismiss") { this.dismissed = this.signature(); this.hide(); return; }
    if (command === "completion.accept") { this.accept(); return; }
    this.selected = (this.selected + (command === "completion.previous" ? -1 : 1) + this.result.items.length) % this.result.items.length;
    this.paint();
  }
  private accept(): void {
    const context = this.context(), item = this.result.items[this.selected];
    if (!context || !this.fresh(context) || !item) return;
    if (item.kind === "file") {
      const trailing = context.target.end === this.input.value.length;
      if (!this.input.attachFile(item.value, context.target.start, context.target.end)) return;
      if (trailing) this.input.insertText(" ");
    } else {
      const inserted = insertCompletion(this.input.value, context.target, item);
      const replacement = inserted.text.slice(context.target.start, inserted.cursor);
      this.input.replaceRange(context.target.start, context.target.end, replacement);
    }
    this.dismissed = this.signature(); this.hide();
  }
  private paint = (): void => {
    if (this.disposed || this.root.isDestroyed || !this.open) return;
    const budget = Math.max(1, Math.min(5, Math.floor(this.renderer.height / 6), this.availableRows()));
    const showHeader = budget > 1 || !this.result.items.length;
    this.heading.visible = showHeader;
    const count = Math.min(this.result.items.length, budget - Number(showHeader));
    this.first = Math.min(this.first, this.selected);
    if (count > 0 && this.selected >= this.first + count) this.first = Math.max(0, this.selected - count + 1);
    // Reserve the same bounded area from opening until dismissal, even for loading, errors or no matches.
    if (this.root.height !== budget) this.root.height = budget;
    this.header.content = (this.message || `${this.target?.kind === "file" ? "Files" : "Commands · SDK resources"} · ${this.selected + 1}/${this.result.items.length}${this.result.truncated ? "+ · refine search" : ""}${this.pending ? " · Updating…" : ""}`).replace(/[\x00-\x1f\x7f]/gu, " ");
    const colors = uiTheme(this.renderer).colors;
    for (const [index, row] of this.rows.entries()) {
      const item = this.result.items[this.first + index]; row.visible = index < count && !!item;
      if (!row.visible || !item) continue;
      const label = item.kind === "file" ? JSON.stringify(item.value).slice(1, -1) : `/${item.value}`;
      row.content = `${this.first + index === this.selected ? "› " : "  "}${label} · ${item.description}`.replace(/[\x00-\x1f\x7f]/gu, " ");
      row.fg = colors.text; row.bg = this.first + index === this.selected ? colors.selected : colors.surface;
    }
  };
  reflow(): void { this.paint(); }
  private cancelRequest(): void {
    if (this.timer !== undefined) this.renderer.clock.clearTimeout(this.timer);
    this.timer = undefined; this.abort?.abort(); this.abort = undefined;
  }
  private blur = (): void => { this.hide(); };
  hide(): void {
    this.generation++; this.cancelRequest(); this.pending = false; this.lookup = ""; this.scope = ""; this.clearResults(); this.spinner.cancel();
    const wasOpen = this.open; if (!this.root.isDestroyed) this.root.visible = false; this.target = null;
    if (wasOpen) this.changed();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.hide();
    this.input.off("focused", this.refresh); this.input.off("blurred", this.blur); this.input.onCursorChange = undefined;
    this.renderer.off("resize", this.paint);
  }
}
