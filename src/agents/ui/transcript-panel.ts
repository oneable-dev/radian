import {
  BoxRenderable, EditBufferRenderable, ScrollBoxRenderable, TextAttributes, TextRenderable,
  type CliRenderer, type KeyEvent, type PasteEvent, type Renderable,
} from "@opentui/core";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import type { FooterShortcut } from "../../ui/footer.ts";
import { Clipboard } from "../../ui/clipboard.ts";
import { blendColors, uiTheme } from "../../ui/theme.ts";
import { transcriptBackground, transcriptSpacing } from "./transcript-style.ts";
import { reportUnexpected, type ExpectedError } from "../../errors.ts";
import type { Result } from "../../result.ts";
import type { TranscriptSection } from "../transcript.ts";
import { emptyTranscriptView, type TranscriptViewState } from "../transcript-preferences.ts";

// Reuse native grapheme-aware cursor/selection/layout, but never install editing or
// paste handlers. Unbound keys (including a timed-out keymap prefix) are inert.
class TranscriptBody extends EditBufferRenderable {
  handleKeyPress(_key: KeyEvent): boolean { return true; }
  handlePaste(_event: PasteEvent): void {}
}
type Row = { section: TranscriptSection; box: BoxRenderable; heading: BoxRenderable; marker: TextRenderable;
  header: TranscriptBody; error: TextRenderable; body: TranscriptBody };
type Target = { position: number } | { id: string; offset: number } | { reveal: true };
export type TranscriptOptions = {
  notice(message: string): void;
  changed(): void;
  focusPrompt(): void;
  initialScroll: Readonly<Record<string, number>>;
  saveScroll(id: string, position: number): void;
  initialViews?: Readonly<Record<string, TranscriptViewState>>;
  saveView?(id: string, state: TranscriptViewState): void;
  keyHint?(command: CommandId, context: KeyContext): string;
  copy?(text: string): Promise<Result<string, ExpectedError>>;
};

export class TranscriptPanel {
  readonly scroll: ScrollBoxRenderable;
  readonly status: TextRenderable;
  private readonly help: TextRenderable;
  private readonly empty: TextRenderable;
  private helpPosition = 0;
  private readonly rows = new Map<string, Row>();
  private readonly readers = new WeakSet<Renderable>();
  private order: string[] = [];
  private readonly views: Record<string, TranscriptViewState>;
  private readonly positions: Record<string, number>;
  private readonly clipboard: Clipboard;
  private sessionId: string | null = null;
  private visible = false;
  private legacy = false;
  private syncing = false;
  private disposed = false;
  private pending: Target | null = null;
  private lastSavedView = "";
  private readonly theme;

  constructor(private readonly renderer: CliRenderer, private readonly options: TranscriptOptions) {
    this.views = structuredClone(options.initialViews ?? {});
    this.positions = { ...options.initialScroll };
    this.clipboard = new Clipboard(renderer);
    this.theme = uiTheme(renderer);
    this.scroll = new ScrollBoxRenderable(renderer, { id: "session-transcript", flexGrow: 1, minHeight: 0, scrollX: false,
      contentOptions: { flexDirection: "column" }, renderBefore: this.finishLayout });
    this.status = new TextRenderable(renderer, { height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    this.help = new TextRenderable(renderer, { width: "100%", flexShrink: 0, wrapMode: "word", selectable: false, visible: false });
    this.empty = new TextRenderable(renderer, { width: "100%", flexShrink: 0, wrapMode: "word", selectable: false,
      content: "No messages yet. Enter a prompt to start this session explicitly." });
    this.scroll.add(this.help); this.scroll.add(this.empty);
    this.scroll.verticalScrollBar.on("change", this.rememberScroll);
    this.scroll.content.on("resize", this.applyTarget);
    this.scroll.viewport.on("resize", this.applyTarget);
    renderer.on("focused_renderable", this.focusChanged);
    renderer.on("resize", this.resize);
    this.scroll.on("focused", () => {
      if (this.visible && this.state && !this.syncing) { this.state.follow = false; this.save(); this.options.changed(); }
    });
    this.theme.scrollbars(this.scroll);
    this.theme.bind(this.scroll, () => this.paint());
    this.theme.bind(this.status, (colors) => { this.status.fg = colors.accent; this.help.fg = colors.muted; this.empty.fg = colors.muted; });
  }

  private get state(): TranscriptViewState | undefined { return this.sessionId ? this.views[this.sessionId] : undefined; }
  private get selected(): Row | undefined { return this.state?.selectedId ? this.rows.get(this.state.selectedId) : undefined; }
  private reader(row: Row): TranscriptBody { return this.folded(row) ? row.header : row.body; }
  private readerText(row: Row): string { return this.folded(row) ? row.header.plainText : row.section.text; }
  private rememberCursor(row: Row): void {
    const state = this.state; if (!state) return;
    if (this.folded(row)) (state.headingCursors ??= {})[row.section.id] = row.header.cursorOffset;
    else state.cursors[row.section.id] = row.body.cursorOffset;
  }
  get focused(): boolean {
    const focused = this.renderer.currentFocusedRenderable;
    return focused === this.scroll || !!focused && this.readers.has(focused);
  }
  get focusTarget(): Renderable { return !this.help.visible && this.state?.mode !== "sections" && this.selected ? this.reader(this.selected) : this.scroll; }
  keyContext(): KeyContext | null {
    if (!this.visible || !this.focused) return null;
    if (this.help.visible) return "transcript";
    return this.state?.mode === "visual" ? "transcript-visual" : this.state?.mode === "text" ? "transcript-text" : "transcript";
  }
  private hint(command: CommandId, context = this.keyContext() ?? "transcript"): string { return this.options.keyHint?.(command, context) ?? ""; }
  get shortcuts(): readonly FooterShortcut[] {
    const context = this.keyContext(); if (!context) return [];
    const hint = (command: CommandId, label: string): FooterShortcut => ({ key: this.hint(command, context), label });
    if (this.help.visible) return [hint("transcript.next", "Scroll help"), hint("transcript.page-down", "Page"), hint("transcript.back", "Close help")];
    return context === "transcript" ? [hint("transcript.next", "Section"),
      hint("transcript.enter", "Text"),
      ...(this.selected?.section.skillName === undefined ? [hint("transcript.fold", "Fold")] : []),
      hint("transcript.copy", "Copy section"), hint("transcript.half-page-down", "½ page"), hint("transcript.help", "Help"), hint("transcript.back", "Input")]
      : [hint("transcript.right", "Cursor"), hint("transcript.visual", "Select"), hint("transcript.visual-line", "Lines"),
        hint("transcript.copy", context === "transcript-visual" ? this.state?.linewise ? "Copy lines" : "Copy selection" : "Copy line"),
        hint("transcript.half-page-down", "½ page"), hint("transcript.help", "Help"), hint("transcript.back", "Back")];
  }

  update(id: string | null, sections: readonly TranscriptSection[] | undefined, output: string, visible: boolean): void {
    if (this.disposed || this.scroll.isDestroyed) return;
    this.rememberScroll();
    const switched = id !== this.sessionId, returning = visible && !this.visible;
    const hadFocus = this.focused;
    const previousIndex = this.order.indexOf(this.state?.selectedId ?? "");
    const incoming = sections ?? [{ id: "legacy-output", kind: "notice", title: "Transcript", text: output, status: "complete" }];
    const changed = switched || incoming.length !== this.order.length || incoming.some((section, index) => {
      const previous = this.rows.get(this.order[index] ?? "")?.section;
      return !previous || section.id !== previous.id || section.text !== previous.text || section.title !== previous.title
        || section.status !== previous.status || section.error !== previous.error || section.summary !== previous.summary
        || section.kind !== previous.kind || section.skillName !== previous.skillName;
    });
    if (!switched && changed && !this.help.visible && !this.state?.follow && this.pending === null) this.pending = this.viewportAnchor();
    this.sessionId = id; this.visible = visible;
    this.legacy = sections === undefined;
    if (id && !this.views[id]) {
      this.views[id] = emptyTranscriptView();
      if (Object.hasOwn(this.positions, id)) this.views[id]!.follow = false;
    }
    const state = this.state;
    let normalized = false;
    if (switched || returning) this.pending = { position: id ? this.positions[id] ?? Infinity : 0 };
    if (switched) {
      this.syncing = true;
      try {
        if (hadFocus) this.scroll.focus();
        for (const row of this.rows.values()) row.box.destroyRecursively();
      } finally { this.syncing = false; }
      this.help.visible = false;
      this.rows.clear(); this.order = []; this.lastSavedView = "";
    }
    if (changed) {
      const ids = new Set(incoming.map((section) => section.id));
      for (const [key, row] of this.rows) if (!ids.has(key)) {
        if (row.body.focused || row.header.focused) this.scroll.focus();
        row.box.destroyRecursively(); this.rows.delete(key);
      }
      for (const section of incoming) {
        const row = this.rows.get(section.id) ?? this.createRow(section);
        const previousText = row.section.text;
        row.section = section;
        if (previousText !== section.text) this.replaceBody(row, section.text);
      }
      // Append-only streaming normally preserves every native renderable and focus.
      const next = incoming.map((section) => section.id);
      if (next.some((key, index) => this.order[index] !== key)) {
        for (const key of next) this.scroll.add(this.rows.get(key)!.box);
      }
      this.order = next;
      if (state && !this.rows.has(state.selectedId ?? "")) {
        normalized = state.selectedId !== null;
        state.selectedId = this.order[previousIndex < 0 ? this.order.length - 1 : Math.min(previousIndex, this.order.length - 1)] ?? null;
        state.mode = "sections"; state.anchor = null; delete state.linewise;
      }
      if (state?.follow) {
        const latest = this.order.at(-1) ?? null;
        normalized ||= state.selectedId !== latest;
        state.selectedId = latest;
        if (!switched && !returning) this.pending = { position: Infinity };
      }
    }
    if (state && !state.selectedId) state.selectedId = this.order.at(-1) ?? null;
    this.paint(); this.applyTarget();
    if (normalized) this.save();
    if (switched && hadFocus && visible) this.restoreFocus();
    if (!visible) this.help.visible = false;
    this.refreshStatus();
  }

  private createRow(section: TranscriptSection): Row {
    const box = new BoxRenderable(this.renderer, { width: "100%", flexShrink: 0, flexDirection: "column" });
    const heading = new BoxRenderable(this.renderer, { width: "100%", flexShrink: 0, minWidth: 0, flexDirection: "row", alignItems: "flex-start",
      onMouseDown: (event) => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation(); this.select(section.id); this.scroll.focus(); this.options.changed();
      } });
    const marker = new TextRenderable(this.renderer, { width: 4, height: 1, flexShrink: 0, wrapMode: "none", selectable: false, attributes: TextAttributes.BOLD });
    const header = new TranscriptBody(this.renderer, { width: "auto", height: 1, flexGrow: 1, minWidth: 0, wrapMode: "none", attributes: TextAttributes.BOLD,
      cursorStyle: { style: "block", blinking: false }, scrollMargin: 0 });
    heading.add(marker); heading.add(header);
    const error = new TextRenderable(this.renderer, { width: "100%", flexShrink: 0, wrapMode: "word", selectable: false, visible: false });
    const body = new TranscriptBody(this.renderer, { width: "100%", height: "auto", minHeight: 1, flexShrink: 0,
      wrapMode: "word", cursorStyle: { style: "block", blinking: false }, scrollMargin: 0 });
    body.setText(section.text);
    const row: Row = { section, box, heading, marker, header, error, body };
    box.add(heading); box.add(error); box.add(body); this.scroll.add(box); this.rows.set(section.id, row);
    for (const reader of [header, body]) {
      this.readers.add(reader);
      reader.on("focused", () => {
        const state = this.state;
        if (!state || this.disposed || !this.rows.has(section.id)) return;
        state.selectedId = section.id; state.follow = false;
        if (state.mode === "sections") state.mode = "text";
        this.save(); this.paint(); this.options.changed();
      });
      reader.on("resize", () => {
        if (reader.focused && this.pending === null) { this.pending = { reveal: true }; this.applyTarget(); }
      });
    }
    this.theme.bind(box, () => this.paintRow(row));
    return row;
  }
  private replaceBody(row: Row, text: string): void {
    const cursor = row.body.cursorOffset;
    row.body.setText(text); row.body.cursorOffset = cursor;
    if (this.state?.selectedId === row.section.id) this.applySelection(row);
  }
  private applySelection(row: Row): void {
    const state = this.state;
    if (state?.mode !== "visual" || state.anchor === null) return;
    const body = this.reader(row);
    if (!state.linewise) { body.setSelectionInclusive(state.anchor, body.cursorOffset); return; }
    const buffer = body.editBuffer;
    const anchorRow = buffer.offsetToPosition(state.anchor)?.row ?? body.lineCount - 1;
    const first = Math.min(anchorRow, body.logicalCursor.row), last = Math.max(anchorRow, body.logicalCursor.row);
    const start = buffer.getLineStartOffset(first);
    const end = last + 1 < body.lineCount ? buffer.getLineStartOffset(last + 1) : buffer.measureText(body.plainText);
    // Native offsets are display cells, not JS string indices. Half-open line bounds
    // include real newlines without selecting the next line's first grapheme.
    body.setSelection(start, end);
  }
  private folded(row: Row): boolean {
    if (row.section.skillName !== undefined) return false;
    return this.state?.folded[row.section.id] ?? (!this.legacy && (row.section.kind === "tool" || row.section.kind === "thinking"));
  }
  private paintRow(row: Row): void {
    if (row.box.isDestroyed) return;
    row.box.visible = !this.help.visible;
    const colors = this.theme.colors, section = row.section;
    const selected = this.state?.selectedId === section.id;
    const skill = section.skillName !== undefined;
    const folded = this.folded(row), spacing = transcriptSpacing(this.renderer.height);
    const background = this.legacy ? colors.panel : transcriptBackground(section.kind, colors);
    row.box.backgroundColor = background;
    row.box.border = this.legacy ? false : ["left"];
    // Setting a border color enables a default border in OpenTUI; legacy output stays borderless.
    if (!this.legacy) row.box.borderColor = selected && this.focused ? colors.accent : blendColors(background, colors.text, 0.15);
    row.box.paddingX = this.legacy ? 0 : 1;
    row.box.paddingBottom = this.legacy || folded || skill ? 0 : spacing.bottomInset;
    row.heading.visible = !skill && (!this.legacy || folded);
    row.header.height = folded ? "auto" : 1;
    row.header.wrapMode = folded ? "word" : "none";
    row.box.marginBottom = this.legacy ? 0 : spacing.sectionGap;
    row.body.visible = !folded;
    row.body.height = skill ? 1 : "auto";
    row.body.wrapMode = skill ? "none" : "word";
    row.body.marginTop = this.legacy || folded || skill ? 0 : spacing.bodyGap;
    row.error.marginTop = this.legacy ? 0 : spacing.bodyGap;
    row.marker.content = `${selected ? "›" : " "} ${folded ? "▸" : "▾"} `;
    const headingText = `${section.title} · ${section.status}${section.summary && !section.error ? ` · ${section.summary}` : ""}`
      + (folded && section.error ? `\n${section.error}` : "");
    if (row.header.plainText !== headingText) {
      const cursor = row.header.cursorOffset;
      row.header.setText(headingText); row.header.cursorOffset = cursor;
      if (selected && folded) this.applySelection(row);
    }
    row.error.visible = !skill && !folded && !!section.error;
    row.error.content = section.error ?? ""; row.error.fg = colors.error; row.error.bg = background;
    let headingBackground = background;
    if (selected) headingBackground = this.legacy ? this.focused ? colors.selected : colors.surface
      : blendColors(background, colors.selected, this.focused ? 0.7 : 0.35);
    row.heading.backgroundColor = headingBackground;
    row.marker.bg = headingBackground; row.header.backgroundColor = headingBackground;
    row.marker.fg = section.status === "error" ? colors.error : section.status === "cancelled" ? colors.warning : colors.accent;
    row.header.textColor = row.marker.fg;
    row.header.cursorColor = colors.accent;
    row.header.selectionBg = blendColors(background, colors.accent, 0.38); row.header.selectionFg = colors.text;
    row.body.textColor = section.kind === "thinking" ? colors.muted : colors.text;
    row.body.backgroundColor = skill ? headingBackground : background; row.body.cursorColor = colors.accent;
    row.body.selectionBg = this.legacy ? colors.selected : blendColors(background, colors.accent, 0.38);
    row.body.selectionFg = colors.text;
  }
  private paint(): void {
    this.empty.visible = !this.order.length && !this.help.visible;
    for (const row of this.rows.values()) this.paintRow(row);
  }
  private modeLabel(): string {
    if (this.help.visible) return "HELP";
    if (!this.focused) return this.renderer.currentFocusedRenderable?.id === "session-prompt" ? "INPUT" : "TRANSCRIPT";
    if (this.state?.mode === "visual" && this.state.linewise) return "VISUAL LINE";
    return this.state?.mode.toUpperCase() ?? "SECTIONS";
  }
  private refreshStatus(): void {
    if (this.disposed || this.status.isDestroyed) return;
    const mode = this.modeLabel();
    const index = this.order.indexOf(this.state?.selectedId ?? "");
    let content = `${mode} · ${Math.max(0, index + 1)}/${this.order.length}${this.state?.follow ? " · following" : " · paused"}${this.legacy ? " · legacy preview" : ""}`;
    const selected = this.selected;
    if (!this.help.visible && this.focused && selected && this.state?.mode !== "sections") {
      const cursor = this.reader(selected).logicalCursor;
      content += `${this.folded(selected) ? " · summary" : ""} · ${cursor.row + 1}:${cursor.col + 1}`;
    }
    this.status.content = content;
  }
  private focusChanged = (): void => { this.paint(); this.refreshStatus(); };
  private resize = (): void => {
    if (this.disposed || this.scroll.isDestroyed) return;
    this.pending ??= this.focused && this.state?.mode !== "sections" ? { reveal: true } : this.viewportAnchor();
    this.paint(); this.applyTarget();
  };
  private save(): void {
    const state = this.state; if (!state || !this.sessionId || this.disposed) return;
    const row = this.selected;
    if (row && state.mode !== "sections") this.rememberCursor(row);
    const key = JSON.stringify(state);
    if (key !== this.lastSavedView) { this.lastSavedView = key; this.options.saveView?.(this.sessionId, structuredClone(state)); }
    this.refreshStatus();
  }

  focus(): void {
    if (!this.visible || !this.state) return;
    this.state.follow = false; this.restoreFocus(); this.pending = { reveal: true }; this.applyTarget(); this.save(); this.options.changed();
  }
  private restoreFocus(): void {
    if (!this.help.visible && this.state?.mode !== "sections" && this.selected) {
      const row = this.selected, reader = this.reader(row);
      reader.cursorOffset = this.folded(row) ? this.state?.headingCursors?.[row.section.id] ?? 0 : this.state?.cursors[row.section.id] ?? 0;
      this.applySelection(row);
      reader.focus();
    } else this.scroll.focus();
  }
  private select(id: string): void {
    if (!this.state || !this.rows.has(id)) return;
    if (this.selected) this.reader(this.selected).clearSelection();
    this.state.selectedId = id; this.state.mode = "sections"; this.state.anchor = null; delete this.state.linewise; this.state.follow = false;
    this.pending = { reveal: true }; this.paint(); this.applyTarget(); this.save();
  }
  private toggleVisual(row: Row, linewise: boolean): void {
    const state = this.state; if (!state) return;
    const visual = state.mode === "visual";
    if (visual && Boolean(state.linewise) === linewise) {
      state.mode = "text"; state.anchor = null; delete state.linewise; this.reader(row).clearSelection(); return;
    }
    if (!visual || state.anchor === null) state.anchor = this.reader(row).cursorOffset;
    state.mode = "visual";
    if (linewise) state.linewise = true; else delete state.linewise;
    this.applySelection(row);
  }
  available(command: CommandId): boolean {
    if (!this.visible || !this.sessionId) return false;
    if (command === "transcript.fold" && this.selected?.section.skillName !== undefined) return false;
    return this.help.visible || command === "transcript.help" || command === "transcript.back" || !!this.selected;
  }
  command(command: CommandId): void {
    const state = this.state; if (!state || !this.available(command)) return;
    if (this.help.visible && command !== "transcript.help") {
      const page = Math.max(1, this.scroll.viewport.height - 1);
      if (command !== "transcript.back") this.pending = null;
      switch (command) {
        case "transcript.back": this.toggleHelp(); break;
        case "transcript.previous": this.scroll.scrollBy(-1); break;
        case "transcript.next": this.scroll.scrollBy(1); break;
        case "transcript.first": this.scroll.scrollTo(0); break;
        case "transcript.last": this.scroll.scrollTo(Infinity); break;
        case "transcript.page-up": this.scroll.scrollBy(-page); break;
        case "transcript.page-down": this.scroll.scrollBy(page); break;
        case "transcript.half-page-up": this.scroll.scrollBy(-Math.max(1, Math.floor(this.scroll.viewport.height / 2))); break;
        case "transcript.half-page-down": this.scroll.scrollBy(Math.max(1, Math.floor(this.scroll.viewport.height / 2))); break;
      }
      this.options.changed(); return;
    }
    const row = this.selected;
    if (command !== "transcript.latest" && command !== "transcript.help") state.follow = false;
    const index = this.order.indexOf(state.selectedId ?? "");
    switch (command) {
      case "transcript.previous": case "transcript.next": case "transcript.first": case "transcript.last": {
        const next = command === "transcript.first" ? 0 : command === "transcript.last" ? this.order.length - 1 : index + (command === "transcript.next" ? 1 : -1);
        const id = this.order[Math.max(0, Math.min(this.order.length - 1, next))]; if (id) this.select(id);
        break;
      }
      case "transcript.enter":
        if (row) { state.mode = "text"; this.paint(); this.restoreFocus(); this.pending = { reveal: true }; }
        break;
      case "transcript.back":
        if (state.mode === "visual") { state.mode = "text"; state.anchor = null; delete state.linewise; if (row) this.reader(row).clearSelection(); }
        else if (state.mode === "text") { state.mode = "sections"; this.scroll.focus(); this.pending = { reveal: true }; }
        else { this.help.visible = false; this.options.focusPrompt(); }
        break;
      case "transcript.fold": case "transcript.fold-all": case "transcript.unfold-all": {
        const targets = command === "transcript.fold" ? row ? [row] : [] : [...this.rows.values()];
        const previouslyFolded = row ? this.folded(row) : false;
        if (row && state.mode !== "sections") this.rememberCursor(row);
        for (const target of targets) if (target.section.skillName === undefined && target.section.text) state.folded[target.section.id] = command === "transcript.fold" ? !this.folded(target) : command === "transcript.fold-all";
        if (row && previouslyFolded !== this.folded(row)) {
          state.mode = "sections"; state.anchor = null; delete state.linewise;
          row.header.clearSelection(); row.body.clearSelection(); this.scroll.focus();
        }
        this.pending = { reveal: true }; break;
      }
      case "transcript.visual": case "transcript.visual-line":
        if (row) this.toggleVisual(row, command === "transcript.visual-line");
        break;
      case "transcript.copy": case "transcript.copy-section": this.copy(command === "transcript.copy-section"); break;
      case "transcript.latest":
        state.mode = "sections"; state.anchor = null; delete state.linewise; state.selectedId = this.order.at(-1) ?? null;
        for (const item of this.rows.values()) { item.header.clearSelection(); item.body.clearSelection(); }
        this.scroll.focus(); state.follow = true; this.pending = { position: Infinity }; break;
      case "transcript.help": this.toggleHelp(); break;
      case "transcript.page-up": case "transcript.page-down": case "transcript.half-page-up": case "transcript.half-page-down": {
        const half = command === "transcript.half-page-up" || command === "transcript.half-page-down";
        const direction = command === "transcript.page-up" || command === "transcript.half-page-up" ? -1 : 1;
        const distance = Math.max(1, half ? Math.floor(this.scroll.viewport.height / 2) : this.scroll.viewport.height - 1);
        if (state.mode === "sections") { this.pending = null; this.scroll.scrollBy(direction * distance); }
        else if (row) for (let i = 0; i < distance; i++) this.move(row, direction < 0 ? "transcript.up" : "transcript.down", true);
        break;
      }
      default: if (row) this.move(row, command);
    }
    this.paint(); this.applyTarget(); this.save(); this.options.changed();
  }
  private move(row: Row, command: CommandId, visualRows = false): void {
    const body = this.reader(row);
    // Native editor shortcuts collapse an existing selection before moving. This
    // reader owns its visual anchor, so move the cursor first, then reapply it.
    body.clearSelection();
    switch (command) {
      case "transcript.left": body.moveCursorLeft(); break;
      case "transcript.right": body.moveCursorRight(); break;
      case "transcript.up": case "transcript.down": {
        if (this.state?.mode === "visual" && this.state.linewise && !visualRows) {
          const { row: current, col } = body.logicalCursor;
          body.setCursor(Math.max(0, Math.min(body.lineCount - 1, current + (command === "transcript.up" ? -1 : 1))), col);
        } else if (command === "transcript.up") body.moveCursorUp(); else body.moveCursorDown();
        break;
      }
      case "transcript.word-next": body.moveWordForward(); break;
      case "transcript.word-previous": body.moveWordBackward(); break;
      case "transcript.line-start": body.gotoLineStart(); break;
      case "transcript.line-end": body.gotoLineTextEnd(); break;
      case "transcript.buffer-start": body.gotoBufferHome(); break;
      case "transcript.buffer-end": body.gotoBufferEnd(); break;
      default: return;
    }
    this.applySelection(row);
    this.pending = { reveal: true };
  }
  private selectedText(row: Row): string {
    const reader = this.reader(row), source = this.readerText(row);
    const text = reader.getSelectedText(), selection = reader.getSelection();
    if (!selection || !source.includes("\r\n")) return text;
    // The native editor normalizes CRLF. Restore each original line ending without
    // mapping Unicode display-cell offsets to JavaScript character indices.
    let line = reader.editBuffer.offsetToPosition(Math.min(selection.start, selection.end))?.row ?? 0;
    const original = source.split("\n");
    return text.replace(/\r?\n/g, () => original[line++]?.endsWith("\r") ? "\r\n" : "\n");
  }
  private copy(whole: boolean): void {
    const row = this.selected, state = this.state;
    if (!row || !state) return;
    const reader = this.reader(row), visibleText = this.readerText(row);
    const text = whole || state.mode === "sections" ? row.section.text : state.mode === "visual" || reader.hasSelection() ? this.selectedText(row)
      : visibleText.split("\n")[reader.logicalCursor.row] ?? "";
    if (!text) { this.options.notice("No text to copy"); return; }
    const sessionId = this.sessionId, selectedId = state.selectedId, anchor = state.anchor, cursor = reader.cursorOffset;
    const linewise = state.linewise, source = row.section.text;
    void Promise.resolve().then(() => this.options.copy?.(text) ?? this.clipboard.copy(text)).then((result) => {
      if (this.disposed) return;
      if (!result.ok) { this.options.notice(`[${result.error.code}] ${result.error.message}`); return; }
      this.options.notice(result.value);
      if (this.sessionId === sessionId && this.state === state && this.selected === row && !reader.isDestroyed && this.reader(row) === reader
        && state.selectedId === selectedId && state.anchor === anchor && state.mode === "visual" && reader.cursorOffset === cursor
        && state.linewise === linewise && row.section.text === source && this.readerText(row) === visibleText) {
        state.mode = "text"; state.anchor = null; delete state.linewise; reader.clearSelection(); this.save(); this.options.changed();
      }
    }).catch((error: unknown) => { const message = reportUnexpected(error, "transcript copy"); if (!this.disposed) this.options.notice(message); });
  }
  private toggleHelp(): void {
    if (this.help.visible) {
      this.help.visible = false; this.paint(); this.pending = { position: this.helpPosition }; this.restoreFocus(); this.applyTarget(); return;
    }
    this.helpPosition = this.scroll.scrollTop;
    this.help.visible = true;
    this.help.content = `Sections: ${this.hint("transcript.previous", "transcript")}/${this.hint("transcript.next", "transcript")} move · ${this.hint("transcript.enter", "transcript")} cursor in visible text · ${this.hint("transcript.fold", "transcript")} fold/unfold\n`
      + `Text/visual: ${this.hint("transcript.left", "transcript-text")}/${this.hint("transcript.right", "transcript-text")} characters · ${this.hint("transcript.word-next", "transcript-text")}/${this.hint("transcript.word-previous", "transcript-text")} words · ${this.hint("transcript.line-start", "transcript-text")}/${this.hint("transcript.line-end", "transcript-text")} line · ${this.hint("transcript.buffer-start", "transcript-text")}/${this.hint("transcript.buffer-end", "transcript-text")} section\n`
      + `${this.hint("transcript.visual", "transcript-text")} select (inclusive) · ${this.hint("transcript.visual-line", "transcript-text")} select logical lines · ${this.hint("transcript.copy", "transcript")} copy section/line/selection by mode · ${this.hint("transcript.copy-section", "transcript")} whole section\n`
      + `${this.hint("transcript.half-page-down", "transcript")}/${this.hint("transcript.half-page-up", "transcript")} half page · linewise selection follows logical lines, not soft wraps\n`
      + `Skills show their names only and never fold.\n`
      + `${this.hint("transcript.fold-all", "transcript")}/${this.hint("transcript.unfold-all", "transcript")} fold/unfold all · ${this.hint("transcript.latest", "transcript")} follow latest · ${this.hint("transcript.back", "transcript")} back · ${this.hint("focus.prompt", "transcript")} input · ${this.hint("transcript.help", "transcript")} close help`;
    this.paint(); this.scroll.focus(); this.pending = { position: 0 }; this.applyTarget();
  }

  private viewportAnchor(): Target | null {
    const top = this.scroll.viewport.y;
    if (this.focused && this.state?.mode !== "sections" && this.selected) return { id: this.selected.section.id, offset: top - this.selected.box.y };
    for (const id of this.order) {
      const row = this.rows.get(id)!;
      if (row.box.y + row.box.height > top) return { id, offset: top - row.box.y };
    }
    return null;
  }
  private applyTarget = (): void => {
    if (!this.visible || this.disposed || this.scroll.isDestroyed || !this.pending) return;
    this.syncing = true;
    try {
      if ("position" in this.pending) this.scroll.scrollTo(this.pending.position);
      else if ("id" in this.pending) {
        const row = this.rows.get(this.pending.id);
        if (row) this.scroll.scrollTo(this.scroll.scrollTop + row.box.y - this.scroll.viewport.y + this.pending.offset);
      } else {
        const row = this.selected; if (!row) return;
        const reading = this.state?.mode !== "sections";
        const reader = this.reader(row);
        const y = reading ? reader.y + reader.visualCursor.visualRow : row.box.y;
        const top = this.scroll.viewport.y, bottom = top + this.scroll.viewport.height - 1;
        const end = !reading && row.box.height <= this.scroll.viewport.height ? row.box.y + row.box.height - 1 : y;
        if (y < top) this.scroll.scrollBy(y - top);
        else if (end > bottom) this.scroll.scrollBy(end - bottom);
      }
    } finally { this.syncing = false; }
  };
  private finishLayout = (): void => {
    this.applyTarget(); this.pending = null; this.rememberScroll();
  };
  rememberScroll = (): void => {
    if (this.disposed || this.scroll.isDestroyed || this.syncing || this.pending || this.help.visible || !this.sessionId || !this.visible) return;
    const position = Math.max(0, Math.round(this.scroll.scrollTop));
    if (this.positions[this.sessionId] === position) return;
    this.positions[this.sessionId] = position; this.options.saveScroll(this.sessionId, position);
    if (position < this.scroll.scrollHeight - this.scroll.viewport.height - 1 && this.state?.follow) { this.state.follow = false; this.save(); }
  };
  dispose(): void {
    if (this.disposed) return;
    this.rememberScroll(); this.disposed = true;
    this.renderer.off("focused_renderable", this.focusChanged);
    this.renderer.off("resize", this.resize);
    this.scroll.verticalScrollBar.off("change", this.rememberScroll);
    this.scroll.content.off("resize", this.applyTarget); this.scroll.viewport.off("resize", this.applyTarget);
    void this.clipboard.dispose().catch((error: unknown) => reportUnexpected(error, "transcript clipboard cleanup"));
  }
}
