import { BoxRenderable, RenderableEvents, StyledText, TextRenderable, type CliRenderer } from "@opentui/core";
import type { CommandId } from "../../keybindings/commands.ts";
import { reportUnexpected, type ExpectedError } from "../../errors.ts";
import type { Result } from "../../result.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import { uiTheme } from "../../ui/theme.ts";
import { paintText, styleChunk } from "../../ui/theme-styles.ts";
import { singleLine, truncateCells } from "../../ui/text.ts";
import { completionTarget, insertCompletion, type CompletionResult, type CompletionTarget } from "../completion.ts";
import type { CompletionProvider } from "../completion-cache.ts";
export type { CompletionProvider } from "../completion-cache.ts";
import type { PromptInput } from "../../ui/prompt-input.ts";

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
  private requestReady: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  private queued = false;
  private disposed = false;
  private sourceVersion = 0;
  private readVersion = -1;
  private readonly unsubscribeSource: (() => void) | undefined;

  constructor(private readonly renderer: CliRenderer, private readonly input: PromptInput,
    private readonly sessionId: () => string | null, private readonly provider: CompletionProvider | undefined,
    private readonly changed: () => void, private readonly availableRows: () => number = () => 5) {
    this.root = new BoxRenderable(renderer, { id: "prompt-completions", width: "100%", height: 0, flexShrink: 0, visible: false,
      flexDirection: "column", paddingRight: 1, onSizeChange: this.paint });
    this.heading = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", paddingLeft: 2 });
    this.spinner = new LoadingSpinner(renderer, { id: "completion-loading" });
    this.header = new TextRenderable(renderer, { height: 1, flexGrow: 1, minWidth: 0, wrapMode: "none", selectable: false });
    // The spinner uses an existing end cell, never a dedicated loading/header row.
    // Its minimum-duration tail must not delay results or change their geometry.
    this.spinner.root.position = "absolute"; this.spinner.root.right = 1; this.spinner.root.top = 0; this.spinner.root.zIndex = 1;
    this.heading.add(this.header);
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
    this.root.add(this.heading); this.root.add(this.spinner.root);
    uiTheme(renderer).bindStyles(this.root, (styles) => {
      this.root.backgroundColor = styles["completion.item"].bg;
      paintText(this.header, styles["completion.description"]); paintText(this.spinner.root, styles["status.working"]); this.paint();
    });
    input.on("focused", this.refresh); input.on("blurred", this.blur);
    input.onCursorChange = () => { this.refresh(); this.changed(); };
    renderer.on("resize", this.paint);
    this.unsubscribeSource = provider?.subscribe?.(() => { this.sourceVersion++; this.refresh(); });
    this.root.once(RenderableEvents.DESTROYED, () => this.dispose());
  }

  prepare(sessionId: string | null, cwd: string | undefined, retained: ReadonlySet<string>): void {
    this.provider?.retain?.(retained);
    if (sessionId && cwd) this.provider?.prepare?.(sessionId, cwd);
  }
  get open(): boolean { return this.root.visible; }
  // Claim Tab/Esc immediately after a trigger, before the menu's queued render can update focus context.
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
    if (this.open && this.lookup === context.lookup && this.readVersion === this.sourceVersion) return;
    this.readVersion = this.sourceVersion;
    const cached = provider.read?.(context.sessionId, context.target);
    if (cached) {
      const changedQuery = this.lookup !== context.lookup;
      this.cancelRequest(); if (changedQuery) this.generation++;
      if (this.scope !== context.scope) this.clearResults();
      this.scope = context.scope; this.lookup = context.lookup; this.root.visible = true;
      this.spinner.stop(); this.receive(context, cached); return;
    }
    if (this.open && this.lookup === context.lookup && this.pending) return;
    this.cancelRequest();
    const ready = this.requestReady = Promise.withResolvers<void>();
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
        this.spinner.stop(); this.receive(context, result);
      }).catch((error: unknown) => {
        if (!this.current(generation, abort, context.lookup)) return;
        this.pending = false; this.spinner.stop(); this.clearResults();
        this.message = reportUnexpected(error, "prompt completion"); this.paint(); this.changed();
      }).finally(() => ready.resolve());
    }, debounceMs);
  }
  private receive(context: LookupContext, result: Result<CompletionResult, ExpectedError>): void {
    this.pending = false;
    if (result.ok) {
      const previous = this.result.items[this.selected];
      const items = context.target.kind === "skill" ? result.value.items.filter(item => item.kind === "skill").map(item => ({ ...item, value: item.value.replace(/^skill:/u, "") }))
        : context.target.kind === "command" ? result.value.items.filter(item => item.kind !== "skill") : result.value.items;
      this.result = { items, truncated: result.value.truncated }; this.resolvedLookup = context.lookup;
      this.selected = Math.max(0, items.findIndex(item => item.kind === previous?.kind && item.value === previous?.value));
      this.message = items.length ? "" : `No matches${result.value.truncated ? " in the first page · refine search" : ""}`;
    } else if (result.error.code === "CANCELLED") { this.hide(); return; }
    else { this.clearResults(); this.message = `[${result.error.code}] ${result.error.message}`; }
    this.paint(); this.changed();
  }
  private current(generation: number, abort: AbortController, lookup: string): boolean {
    return !this.disposed && generation === this.generation && !abort.signal.aborted && this.context()?.lookup === lookup;
  }
  private clearResults(): void { this.result = { items: [], truncated: false }; this.resolvedLookup = ""; this.selected = 0; this.first = 0; }
  // Enter executes the focused command or Skill; Tab remains insertion-only.
  // Resolve synchronously when possible so ordinary prompt submission captures its draft immediately.
  prepareCommandSubmission(): boolean | Promise<boolean> {
    const context = this.context();
    if (!context || context.target.kind === "file") return true;
    this.update();
    const item = this.result.items[this.selected];
    if (!this.open || this.scope !== context.scope || !item || item.kind === "file") return true;
    if (this.fresh(context)) { this.accept(false); return true; }
    const ready = this.requestReady, generation = this.generation, signature = this.signature();
    if (!ready) return false;
    return ready.promise.then(() => {
      if (this.disposed || generation !== this.generation || signature !== this.signature() || !this.available("completion.accept")) return false;
      const selected = this.result.items[this.selected];
      // Do not turn a pending Enter into execution of a different newly focused command.
      if (selected?.kind !== item.kind || selected.value !== item.value) return false;
      this.accept(false); return true;
    });
  }
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
  private accept(addTrailingSpace = true): void {
    const context = this.context(), item = this.result.items[this.selected];
    if (!context || !this.fresh(context) || !item) return;
    if (item.kind === "file") {
      const trailing = context.target.end === this.input.value.length;
      if (!this.input.attachFile(item.value, context.target.start, context.target.end)) return;
      if (trailing) this.input.insertText(" ");
    } else {
      const inserted = insertCompletion(this.input.value, context.target, item);
      const replacement = inserted.text.slice(context.target.start, inserted.cursor);
      // The spacer helps users continue editing after Tab, but is not part of an immediately sent command.
      const suffix = !addTrailingSpace && context.target.end === this.input.value.length ? replacement.slice(0, -1) : replacement;
      this.input.replaceRange(context.target.start, context.target.end, suffix);
    }
    this.dismissed = this.signature(); this.hide();
  }
  private paint = (): void => {
    if (this.disposed || !this.root || this.root.isDestroyed || !this.open) return;
    const budget = Math.max(1, Math.min(6, Math.floor(this.renderer.height / 4), this.availableRows()));
    const overflow = this.result.items.length > Math.min(this.rows.length, budget);
    const showSummary = !this.result.items.length || budget > 1 && (overflow || this.result.truncated);
    this.heading.visible = showSummary;
    const count = Math.min(this.result.items.length, this.rows.length, budget - Number(showSummary));
    this.first = Math.min(this.first, this.selected);
    if (count > 0 && this.selected >= this.first + count) this.first = Math.max(0, this.selected - count + 1);
    const height = count + Number(showSummary);
    // The native getter may still report the previous layout; the setter ignores unchanged styles.
    this.root.height = height;
    this.header.content = singleLine(this.message || `(${this.selected + 1}/${this.result.items.length}${this.result.truncated ? "+" : ""})${this.result.truncated ? " · refine search" : ""}${this.pending ? " · Updating…" : ""}`);
    const styles = uiTheme(this.renderer).styles;
    // Measure terminal cells, not UTF-16 lengths, so Unicode labels share one description column.
    const width = Math.max(0, this.root.width - 2);
    const labels = this.result.items.map(item => item.kind === "file" ? JSON.stringify(item.value).slice(1, -1) : singleLine(item.value));
    const descriptions = width >= 20;
    const labelWidth = descriptions ? Math.min(Math.max(0, ...labels.map(label => Bun.stringWidth(label))), Math.floor((width - 4) / 2)) : Math.max(0, width - 2);
    for (const [index, row] of this.rows.entries()) {
      const item = this.result.items[this.first + index]; row.visible = index < count && !!item;
      if (!row.visible || !item) continue;
      const selected = this.first + index === this.selected;
      const marker = truncateCells(selected ? "→ " : "  ", width, "");
      const label = truncateCells(labels[this.first + index]!, labelWidth);
      const description = descriptions ? " ".repeat(labelWidth - Bun.stringWidth(label) + 2)
        + truncateCells(singleLine(item.description), Math.max(0, width - labelWidth - 4)) : "";
      row.content = new StyledText([
        styleChunk(marker + label, styles[selected ? "completion.selected" : "completion.item"]),
        styleChunk(description, styles[selected ? "completion.selected" : "completion.description"]),
      ]);
      row.bg = styles[selected ? "completion.selected" : "completion.item"].bg;
    }
  };
  reflow(): void { this.paint(); }
  private cancelRequest(): void {
    if (this.timer !== undefined) this.renderer.clock.clearTimeout(this.timer);
    this.timer = undefined; this.abort?.abort(); this.abort = undefined;
    this.requestReady?.resolve(); this.requestReady = undefined;
  }
  private blur = (): void => { this.hide(); };
  hide(): void {
    this.generation++; this.cancelRequest(); this.pending = false; this.lookup = ""; this.scope = ""; this.clearResults(); this.spinner.cancel();
    const wasOpen = this.open;
    if (!this.root.isDestroyed) { this.root.visible = false; this.root.height = 0; }
    if (wasOpen) this.changed();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.unsubscribeSource?.(); this.hide();
    this.input.off("focused", this.refresh); this.input.off("blurred", this.blur); this.input.onCursorChange = undefined;
    this.renderer.off("resize", this.paint);
  }
}
