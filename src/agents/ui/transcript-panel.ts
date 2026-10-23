import {
  BoxRenderable, InputRenderable, InputRenderableEvents, ScrollBoxRenderable, SyntaxStyle, TextAttributes, TextRenderable,
  type CliRenderer, type KeyEvent, type MouseEvent, type OptimizedBuffer, type Renderable,
} from "@opentui/core";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import { keyToken, type Keymap } from "../../keybindings/config.ts";
import { footerKeyHint } from "../../keybindings/footer.ts";
import type { FooterShortcut } from "../../ui/footer.ts";
import { Clipboard } from "../../ui/clipboard.ts";
import { halfPageStep } from "../../ui/navigation.ts";
import { uiTheme } from "../../ui/theme.ts";
import { transcriptBackground, transcriptSpacing } from "./transcript-style.ts";
import { TranscriptMarkdown, updateTranscriptMarkdownStyles } from "./transcript-markdown.ts";
import { paintText, syntaxDefinition } from "../../ui/theme-styles.ts";
import { formatRunCompletion, sameRunCompletion } from "./run-completion.ts";
import { reportUnexpected, type ExpectedError } from "../../errors.ts";
import type { Result } from "../../result.ts";
import type { TranscriptSection } from "../transcript.ts";
import { emptyTranscriptView, type TranscriptViewState } from "../transcript-preferences.ts";
import { sameRequestSummary, type RequestSummary } from "../request-summary.ts";
import { formatRequestCaption, requestForSection } from "./request-caption.ts";
import { RadianLogo } from "../../ui/radian-logo.ts";
import { maximumPreviewImageBytes, type TranscriptImageProvider } from "../transcript-images.ts";
import { TranscriptImagePreview } from "./transcript-image.ts";
import { validateBrowserUrl, openBrowserUrl } from "../../browser.ts";
import { transcriptLinkAt } from "../transcript-links.ts";

import { TranscriptBody } from "./transcript-reader.ts";
import { VimText, type VimRange } from "../transcript-vim-text.ts";
import { TranscriptVim, type VimContext, type VimEffect } from "../transcript-vim.ts";
import { transcriptVimAction, vimCharacter, vimPendingHint } from "./transcript-vim-bindings.ts";
type Row = { section: TranscriptSection; request: RequestSummary | undefined; box: BoxRenderable; heading: BoxRenderable;
  header: TranscriptBody; error: TextRenderable; bodyRow: BoxRenderable; skillTag: TextRenderable; body: TranscriptBody;
  markdown: TranscriptMarkdown | undefined; markdownKind: "assistant" | "thinking" | undefined; completion: TextRenderable; completionWidth: number; preview?: TranscriptImagePreview };
type CachedTranscript = { rows: Map<string, Row>; order: string[]; source: readonly TranscriptSection[]; legacy: boolean; bytes: number };
// Bound detached native trees as well as source text, not just the number of sessions.
const maximumCachedSessions = 2;
const maximumCachedSections = 600;
const maximumCachedTextBytes = 2 * 1024 * 1024;

type Target = { position: number } | { id: string; offset: number } | { reveal: true };
type LinkPress = { x: number; y: number; sessionId: string | null; url: string | null; reader: TranscriptBody | undefined; source: string | undefined };
function sameSection(a: TranscriptSection, b: TranscriptSection): boolean {
  return a === b || a.id === b.id && a.text === b.text && a.title === b.title && a.kind === b.kind
    && a.status === b.status && a.error === b.error && a.summary === b.summary && a.skillName === b.skillName
    && a.command === b.command && a.timeoutSeconds === b.timeoutSeconds
    && sameRunCompletion(a.completion, b.completion) && sameRequestSummary(a.request, b.request)
    && a.image?.id === b.image?.id && a.image?.name === b.image?.name && a.image?.byteLength === b.image?.byteLength;
}
function compactionNotice(section: TranscriptSection): boolean {
  return section.kind === "notice" && section.skillName === undefined && section.title === "Context compacted";
}
function cancellationNotice(section: TranscriptSection): boolean {
  // Also recognize old runtime snapshots that rendered a cancelled request as Agent error.
  return section.kind === "notice" && section.status === "cancelled" && !section.image && !section.skillName
    && (section.title === "Agent error" || !section.text);
}
function hiddenCancellation(section: TranscriptSection): boolean {
  return cancellationNotice(section) && !section.completion?.warning;
}
export type TranscriptOptions = {
  notice(message: string): void;
  changed(): void;
  focusPrompt(): void;
  initialScroll: Readonly<Record<string, number>>;
  initialPosition?: "start" | "end";
  saveScroll(id: string, position: number): void;
  initialViews?: Readonly<Record<string, TranscriptViewState>>;
  saveView?(id: string, state: TranscriptViewState): void;
  keyHint?(command: CommandId, context: KeyContext): string;
  copy?(text: string): Promise<Result<string, ExpectedError>>;
  openUrl?(url: string): Promise<Result<void, ExpectedError>>;
  image?: TranscriptImageProvider;
  cacheSessions?: boolean;
  emptyLogo?: boolean;
};

export class TranscriptPanel {
  readonly scroll: ScrollBoxRenderable;
  private readonly help: TextRenderable;
  private readonly empty: RadianLogo;
  private readonly vim = new TranscriptVim();
  private vimModel: VimText | undefined;
  private readonly searchLine: BoxRenderable;
  private readonly searchInput: InputRenderable;
  private readonly searchPrefix: TextRenderable;
  private searchDirection: 1 | -1 = 1;
  private helpPosition = 0;
  private helpFollow = false;
  private rows = new Map<string, Row>();
  private readonly cached = new Map<string, CachedTranscript>();
  private source: readonly TranscriptSection[] = [];
  private readonly imagePreviews = new Set<Row>();
  private readonly readers = new WeakSet<Renderable>();
  private order: string[] = [];
  private readonly views: Record<string, TranscriptViewState>;
  private readonly positions: Record<string, number>;
  private readonly clipboard: Clipboard;
  private linkPress: LinkPress | undefined;
  private formattedSelection: ReturnType<CliRenderer["getSelection"]> = null;
  private formattedSelectionKey = "";
  private sessionId: string | null = null;
  private readonly conversations = new Map<string, string>();
  private visible = false;
  private legacy = false;
  private syncing = false;
  private disposed = false;
  private pending: Target | null = null;
  private positionIntent = false;
  private selectionHeldFor: string | null = null;
  private geometry: { id: string | null; content: number; viewport: number } | undefined;
  private lastSavedView = "";
  private lastStatus = "";
  private readonly theme;
  private readonly headerSyntax: SyntaxStyle;
  private readonly proseSyntax: SyntaxStyle;
  private readonly thinkingSyntax: SyntaxStyle;

  constructor(private readonly renderer: CliRenderer, private readonly options: TranscriptOptions) {
    this.views = structuredClone(options.initialViews ?? {});
    this.positions = { ...options.initialScroll };
    this.clipboard = new Clipboard(renderer);
    this.theme = uiTheme(renderer);
    this.headerSyntax = SyntaxStyle.create(renderer.nativeScene!);
    this.proseSyntax = SyntaxStyle.create(renderer.nativeScene!); this.thinkingSyntax = SyntaxStyle.create(renderer.nativeScene!);
    this.scroll = new ScrollBoxRenderable(renderer, { id: "session-transcript", flexGrow: 1, minHeight: 0, scrollX: false,
      contentOptions: { flexDirection: "column" }, renderBefore: this.finishLayout,
      onMouseDown: this.linkDown, onMouseUp: this.linkUp, onMouseDrag: () => { this.linkPress = undefined; },
      onMouseScroll: (event) => {
        this.linkPress = undefined;
        if (event.modifiers.shift || this.help.visible) return;
        if (event.scroll?.direction === "down" && this.atBottom()) this.syncFollowingFromPosition();
        else if (event.scroll?.direction === "down" || event.scroll?.direction === "up" && this.scroll.scrollTop > 0) this.scrollIntent();
      },
      verticalScrollbarOptions: { onMouseDown: (event) => { if (event.button === 0) this.scrollIntent(); } },
    });
    this.help = new TextRenderable(renderer, { width: "100%", flexShrink: 0, wrapMode: "word", selectable: false, visible: false });
    this.empty = new RadianLogo(renderer);
    this.scroll.add(this.help);
    // Viewport decorations must not become scrollable or selectable transcript content.
    this.scroll.viewport.add(this.empty);
    this.searchLine = new BoxRenderable(renderer, { id: "transcript-search-line", position: "absolute", left: 0, bottom: 0, width: "100%", height: 1,
      flexDirection: "row", visible: false, zIndex: 20,
      onMouseDown: event => { event.stopPropagation(); if (event.button === 0) { event.preventDefault(); this.searchInput.focus(); } } });
    this.searchPrefix = new TextRenderable(renderer, { width: 1, height: 1, selectable: false, content: "/" });
    this.searchInput = new InputRenderable(renderer, { id: "transcript-search", flexGrow: 1, minWidth: 0, maxLength: 4096, placeholder: "Search current section" });
    this.searchLine.add(this.searchPrefix); this.searchLine.add(this.searchInput); this.scroll.viewport.add(this.searchLine);
    this.theme.input(this.searchInput, "ui.input", "ui.inputFocused");
    this.theme.bindStyles(this.searchLine, styles => { this.searchLine.backgroundColor = styles["ui.inputFocused"].bg; paintText(this.searchPrefix, styles["ui.inputFocused"]); });
    this.searchInput.on(InputRenderableEvents.INPUT, () => this.options.changed());
    this.scroll.verticalScrollBar.on("change", this.rememberScroll);
    this.scroll.content.on("resize", this.applyTarget);
    this.scroll.viewport.on("resize", this.resize);
    renderer.on("focused_renderable", this.focusChanged);
    renderer.keyInput.on("paste", this.readPaste);
    renderer.on("resize", this.resize);
    renderer.addPostProcessFn(this.reflowCompletions);
    this.theme.scrollbars(this.scroll);
    this.theme.bind(this.scroll, () => {
      const styles = this.theme.styles;
      this.headerSyntax.registerStyle("tag", syntaxDefinition(styles["transcript.skill"]));
      this.headerSyntax.registerStyle("hint", syntaxDefinition(styles["ui.muted"]));
      this.headerSyntax.registerStyle("error", syntaxDefinition(styles["status.error"]));
      updateTranscriptMarkdownStyles(this.proseSyntax, styles, false); updateTranscriptMarkdownStyles(this.thinkingSyntax, styles, true);
      paintText(this.help, styles["ui.muted"]);
      this.paint();
    });
  }

  private get state(): TranscriptViewState | undefined { return this.sessionId ? this.views[this.sessionId] : undefined; }
  private get selected(): Row | undefined { return this.state?.selectedId ? this.rows.get(this.state.selectedId) : undefined; }
  private reader(row: Row): TranscriptBody {
    return this.folded(row) || row.section.image || this.selected === row && this.state?.readingHeading && row.heading.visible ? row.header : row.body;
  }
  private readerText(row: Row): string {
    if (this.reader(row) === row.header) return row.header.plainText;
    if (!row.body.formatted || row.body.plainText === row.section.text.replaceAll("\r\n", "\n")) return row.section.text;
    return row.body.plainText;
  }
  private rememberCursor(row: Row): void {
    const state = this.state; if (!state) return;
    if (this.reader(row) === row.header) (state.headingCursors ??= {})[row.section.id] = row.header.cursorOffset;
    else state.cursors[row.section.id] = row.body.cursorOffset;
  }
  get focused(): boolean {
    const focused = this.renderer.currentFocusedRenderable;
    return focused === this.scroll || this.searchLine.visible && focused === this.searchInput || !!focused && this.readers.has(focused);
  }
  get focusTarget(): Renderable { return this.searchLine.visible ? this.searchInput : !this.help.visible && this.state?.mode !== "sections" && this.selected ? this.reader(this.selected) : this.scroll; }
  keyContext(): KeyContext | null {
    if (!this.visible || !this.focused) return null;
    if (this.searchLine.visible) return "transcript-search";
    if (this.help.visible) return "transcript";
    return this.state?.mode === "visual" ? "transcript-visual" : this.state?.mode === "text" ? "transcript-text" : "transcript";
  }
  private hint(command: CommandId, context = this.keyContext() ?? "transcript"): string { return this.options.keyHint?.(command, context) ?? ""; }
  get shortcuts(): readonly FooterShortcut[] {
    const context = this.keyContext(); if (!context) return [];
    const hint = (command: CommandId, label: string): FooterShortcut => ({ key: footerKeyHint(command, context, this.hint(command, context)), label });
    if (context === "transcript-search") return [hint("transcript.search-submit", "Find"), hint("transcript.search-clear", "Clear"), hint("transcript.search-cancel", "Cancel")];
    if (this.help.visible) return [hint("transcript.next", "Scroll help"), hint("transcript.page-down", "Page"), hint("transcript.back", "Close help")];
    return context === "transcript" ? [hint("transcript.next", "Section"),
      hint("transcript.enter", "Text"),
      ...(this.foldable(this.selected) ? [hint("transcript.fold", "Fold")] : []),
      hint("transcript.copy", "Copy section"), hint("transcript.half-page-down", "½ page"), hint("transcript.help", "Help"), hint("transcript.back", "Input")]
      : [hint("transcript.right", "Cursor"), hint("transcript.visual", "Select"), hint("transcript.visual-line", "Lines"),
        hint("transcript.copy", context === "transcript-visual" ? this.state?.linewise ? "Copy lines" : "Copy selection" : "Yank motion"),
        hint("transcript.open-link", "Open link"), hint("transcript.half-page-down", "½ page"), hint("transcript.help", "Help"), hint("transcript.back", "Back")];
  }

  update(id: string | null, sections: readonly TranscriptSection[] | undefined, output: string, visible: boolean, conversationId?: string): void {
    if (this.disposed || this.scroll.isDestroyed) return;
    this.reconcileSelection(); this.rememberScroll();
    const previousConversation = id ? this.conversations.get(id) : undefined;
    const replaced = !!id && !!conversationId && previousConversation !== undefined && previousConversation !== conversationId;
    if (id && conversationId) this.conversations.set(id, conversationId);
    if (replaced && id) {
      this.views[id] = emptyTranscriptView(); this.positions[id] = 0;
      this.options.saveScroll(id, 0); this.options.saveView?.(id, structuredClone(this.views[id]!));
    }
    const switched = id !== this.sessionId || replaced, returning = visible && !this.visible;
    const visibilityChanged = visible !== this.visible, hadFocus = this.focused;
    if (switched || !visible) { this.linkPress = undefined; this.clearFormattedSelection(); this.cancelPending(); this.vimModel = undefined; }
    if (switched) {
      this.positionIntent = false; this.selectionHeldFor = null; this.geometry = undefined;
      this.switchRows(id, replaced, hadFocus);
    }
    const legacyChanged = this.legacy !== (sections === undefined);
    const source: readonly TranscriptSection[] = sections ?? (output
      ? [{ id: "legacy-output", kind: "notice", title: "Transcript", text: output, status: "complete" }] : []);
    // Compare values, not references: every IPC snapshot reconstructs its section objects.
    // Include hidden outcomes because they can change a later completion's request caption.
    const changed = switched || legacyChanged || source.length !== this.source.length
      || source.some((section, index) => !sameSection(section, this.source[index]!));
    if (!switched && changed && !this.help.visible && !this.state?.follow && this.pending === null) this.pending = this.viewportAnchor();
    this.sessionId = id; this.visible = visible; this.legacy = sections === undefined;
    if (!visible) this.help.visible = false;
    if (id && !this.views[id]) {
      this.views[id] = emptyTranscriptView();
      if (Object.hasOwn(this.positions, id) || this.options.initialPosition === "start") this.views[id]!.follow = false;
    }
    const state = this.state, previousSelected = state?.selectedId;
    const previousIndex = this.order.indexOf(previousSelected ?? "");
    const dirty = new Set<Row>();
    let normalized = false;
    if (switched || returning) this.pending = { position: id ? this.positions[id] ?? (this.options.initialPosition === "start" ? 0 : Infinity) : 0 };
    if (changed) {
      const incoming = source.filter(section => !hiddenCancellation(section));
      const ids = new Set(incoming.map(section => section.id));
      for (const [key, row] of this.rows) if (!ids.has(key)) {
        if (row.body.focused || row.header.focused) this.scroll.focus();
        row.preview?.dispose(); row.box.destroyRecursively(); this.imagePreviews.delete(row); this.rows.delete(key);
      }
      let request: RequestSummary | undefined;
      for (const section of source) {
        if (hiddenCancellation(section)) { if (section.completion) request = undefined; continue; }
        const delivered = requestForSection(section);
        if (delivered) request = delivered;
        const existing = this.rows.get(section.id);
        const row = existing ?? this.createRow(section);
        if (!existing || !sameSection(row.section, section) || !sameRequestSummary(row.request, request)) dirty.add(row);
        const previousText = row.section.text;
        row.section = section; row.request = request;
        if (section.completion) request = undefined;
        if (previousText !== section.text) this.replaceBody(row, section.text, previousText);
        if (state && section.kind === "thinking" && Object.hasOwn(state.folded, section.id)) {
          // Old heading selections cannot be applied to the now always-visible body.
          if (state.folded[section.id] && state.selectedId === section.id && state.mode === "visual") {
            state.mode = "text"; state.anchor = null; delete state.linewise;
          }
          if (state.selectedId === section.id && state.mode !== "sections") {
            row.body.cursorOffset = state.cursors[section.id] ?? 0;
            this.applySelection(row);
          }
          delete state.folded[section.id]; normalized = true; dirty.add(row);
        }
      }
      const next = incoming.map(section => section.id);
      if (next.some((key, index) => this.order[index] !== key)) {
        for (const key of next) this.scroll.add(this.rows.get(key)!.box);
      }
      this.order = next; this.source = source;
      if (state && !this.rows.has(state.selectedId ?? "")) {
        normalized = state.selectedId !== null;
        const initialIndex = this.options.initialPosition === "start" ? 0 : this.order.length - 1;
        state.selectedId = this.order[previousIndex < 0 ? initialIndex : Math.min(previousIndex, this.order.length - 1)] ?? null;
        state.mode = "sections"; state.anchor = null; delete state.linewise; delete state.readingHeading;
      }
      if (state?.follow && !this.help.visible && !this.positionIntent) {
        // Viewport following must not replace the section/cursor being read.
        if (state.mode === "sections") {
          const latest = this.order.at(-1) ?? null;
          normalized ||= state.selectedId !== latest; state.selectedId = latest;
        }
        if (!switched && !returning) this.pending = { position: Infinity };
      }
    }
    if (state && !state.selectedId) state.selectedId = this.order.at(-1) ?? null;
    if (previousSelected !== state?.selectedId) {
      this.cancelPending(); this.vimModel = undefined;
      const previous = previousSelected ? this.rows.get(previousSelected) : undefined;
      if (previous) dirty.add(previous);
      if (this.selected) dirty.add(this.selected);
    }
    if (switched || visibilityChanged || legacyChanged) this.paint();
    else if (changed || normalized) {
      this.paintLayout();
      for (const row of dirty) this.paintRow(row);
    }
    this.applyTarget();
    if (normalized) this.save();
    if (switched && hadFocus && visible) this.restoreFocus();
    this.refreshStatus();
  }

  // Closed tabs must release detached native trees, not wait for the LRU limit.
  retainSessions(openIds: ReadonlySet<string>): void {
    for (const [id, cached] of this.cached) if (!openIds.has(id)) {
      this.cached.delete(id); this.destroyRows(cached.rows);
    }
  }

  private switchRows(id: string | null, replaced: boolean, hadFocus: boolean): void {
    this.syncing = true;
    try {
      if (hadFocus) this.scroll.focus();
      if (this.hasSelection()) this.renderer.clearSelection();
      this.releasePreviews();
      const bytes = this.source.reduce((total, section) => total + Buffer.byteLength(section.text), 0);
      if (this.options.cacheSessions && this.sessionId && (id !== this.sessionId || !replaced)
        && this.source.length <= maximumCachedSections && bytes <= maximumCachedTextBytes) {
        for (const row of this.rows.values()) this.scroll.remove(row.box);
        this.cached.set(this.sessionId, { rows: this.rows, order: this.order, source: this.source, legacy: this.legacy, bytes });
      } else this.destroyRows(this.rows);
      this.rows = new Map(); this.order = []; this.source = [];
      const cached = id ? this.cached.get(id) : undefined;
      if (cached && id) {
        this.cached.delete(id);
        if (replaced) this.destroyRows(cached.rows);
        else {
          this.rows = cached.rows; this.order = cached.order; this.source = cached.source; this.legacy = cached.legacy;
          for (const key of this.order) this.scroll.add(this.rows.get(key)!.box);
        }
      }
      let sections = 0, textBytes = 0;
      for (const entry of this.cached.values()) { sections += entry.source.length; textBytes += entry.bytes; }
      for (const [key, entry] of this.cached) {
        if (this.cached.size <= maximumCachedSessions && sections <= maximumCachedSections && textBytes <= maximumCachedTextBytes) break;
        this.cached.delete(key); sections -= entry.source.length; textBytes -= entry.bytes; this.destroyRows(entry.rows);
      }
    } finally { this.syncing = false; }
    this.help.visible = false; this.lastSavedView = "";
  }

  private releasePreviews(): void {
    // Cache text buffers, never image requests/pixels (including unsupported previews).
    for (const row of this.rows.values()) if (row.preview) {
      row.preview.dispose(); row.preview.root.destroyRecursively(); delete row.preview;
    }
    this.imagePreviews.clear();
  }
  private destroyRows(rows: Map<string, Row>): void {
    for (const row of rows.values()) {
      row.preview?.dispose();
      if (!row.header.isDestroyed) row.header.syntaxStyle = null;
      row.box.destroyRecursively();
    }
    rows.clear();
  }
  private isCurrentRow(row: Row): boolean { return this.rows.get(row.section.id) === row; }

  private createRow(section: TranscriptSection): Row {
    const box = new BoxRenderable(this.renderer, { width: "100%", flexShrink: 0, flexDirection: "column" });
    const heading = new BoxRenderable(this.renderer, { width: "100%", flexShrink: 0, minWidth: 0, minHeight: 1, flexDirection: "row", alignItems: "flex-start",
      onMouseDown: (event) => {
        if (event.button !== 0) return;
        if (!this.isCurrentRow(row)) return;
        event.preventDefault(); event.stopPropagation(); this.select(section.id); this.scroll.focus();
        if (compactionNotice(row.section) || row.section.image) this.command("transcript.fold");
        else this.options.changed();
      } });
    const header = new TranscriptBody(this.renderer, { width: "auto", height: "auto", flexGrow: 1, minWidth: 0, wrapMode: "word",
      cursorStyle: { style: "block", blinking: false }, scrollMargin: 0 });
    header.syntaxStyle = this.headerSyntax; heading.add(header);
    const error = new TextRenderable(this.renderer, { width: "100%", flexShrink: 0, wrapMode: "word", selectable: false, visible: false });
    const bodyRow = new BoxRenderable(this.renderer, { width: "100%", minWidth: 0, minHeight: 1, flexShrink: 0, flexDirection: "row" });
    const skillTag = new TextRenderable(this.renderer, { width: 8, height: 1, flexShrink: 0, wrapMode: "none", selectable: false, content: "[skill] ", attributes: TextAttributes.BOLD });
    const body = new TranscriptBody(this.renderer, { width: "auto", height: "auto", minWidth: 0, minHeight: 1, flexGrow: 1, flexShrink: 0,
      wrapMode: "word", cursorStyle: { style: "block", blinking: false }, scrollMargin: 0 });
    body.setText(section.text); bodyRow.add(skillTag); bodyRow.add(body);
    const completion = new TextRenderable(this.renderer, { width: "100%", flexShrink: 0, wrapMode: "word", selectable: false, visible: false });
    const row: Row = { section, request: undefined, box, heading, header, error, bodyRow, skillTag, body, markdown: undefined, markdownKind: undefined, completion, completionWidth: 0 };
    box.add(heading); box.add(error); box.add(bodyRow); box.add(completion); this.scroll.add(box); this.rows.set(section.id, row);
    for (const reader of [header, body]) {
      this.readers.add(reader);
      reader.on("focused", () => {
        const state = this.state;
        if (!state || this.disposed || !this.isCurrentRow(row)) return;
        state.selectedId = section.id;
        if (reader === header) state.readingHeading = true; else delete state.readingHeading;
        if (state.mode === "sections") state.mode = "text";
        this.save(); this.paint(); this.options.changed();
      });
      reader.on("resize", () => {
        if (this.isCurrentRow(row) && reader.focused && this.pending === null) { this.pending = { reveal: true }; this.applyTarget(); }
      });
    }
    this.theme.bind(box, () => this.paintRow(row));
    return row;
  }
  private replaceBody(row: Row, text: string, previous: string): void {
    if (this.selected === row) {
      if (!text.startsWith(previous)) this.vim.cancel();
      this.vimModel = undefined;
    }
    if (row.body.formatted) return;
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
  private foldable(row: Row | undefined): boolean {
    return !!row && row.section.skillName === undefined && row.section.kind !== "thinking";
  }
  private folded(row: Row): boolean {
    if (!this.foldable(row)) return false;
    return this.state?.folded[row.section.id] ?? (!this.legacy && (row.section.kind === "tool" || !!row.section.image || compactionNotice(row.section)));
  }
  private headingText(section: TranscriptSection, folded: boolean): string {
    let label: string;
    if (section.image) {
      const key = this.hint("transcript.fold", "transcript");
      return `[read] ${section.image.name}` + (key ? ` (${key} to ${folded ? "expand" : "collapse"})` : "");
    }
    switch (section.kind) {
      case "tool": label = section.command !== undefined ? `$ ${section.command}` : `[${section.title}]${section.summary ? ` ${section.summary}` : ""}`; break;
      case "thinking": return "";
      case "notice": label = `[${section.title}]`; break;
      case "user": case "assistant": label = "[message]"; break;
    }
    const timeout = section.timeoutSeconds !== undefined ? ` (timeout ${section.timeoutSeconds}s)` : "";
    const key = this.hint("transcript.fold", "transcript");
    const action = folded ? "expand" : compactionNotice(section) ? "collapse" : "";
    return label + timeout + (action && key ? ` (${key} to ${action})` : "") + (folded && section.error ? `\n\n${section.error}` : "");
  }
  private highlightHeader(row: Row): void {
    row.header.clearAllHighlights();
    const width = (text: string) => row.header.editBuffer.measureText(text);
    const lines = row.header.plainText.split("\n");
    const errorStart = this.folded(row) && row.section.error ? lines.length - row.section.error.split("\n").length : Infinity;
    for (const [lineIndex, line] of lines.entries()) {
      const mark = (start: number, end: number, style: string) => row.header.addHighlight(lineIndex, {
        start: width(line.slice(0, start)), end: width(line.slice(0, end)), styleId: this.headerSyntax.getStyleId(style)!,
      });
      const tag = lineIndex === 0 ? /^\[[^\]\n]+\]/.exec(line) : null;
      if (tag) mark(0, tag[0].length, "tag");
      for (const hint of line.matchAll(/\((?:timeout [\d.]+s|[^()]+ to (?:expand|collapse))\)/g)) mark(hint.index, hint.index + hint[0].length, "hint");
      if (lineIndex >= errorStart) mark(0, line.length, "error");
    }
  }
  private paintRow(row: Row): void {
    if (this.disposed || row.box.isDestroyed || !this.isCurrentRow(row)) return;
    row.box.visible = !this.help.visible;
    const colors = this.theme.colors, styles = this.theme.styles, section = row.section;
    const selected = this.state?.selectedId === section.id, skill = section.skillName !== undefined;
    const cancelled = cancellationNotice(section);
    const folded = this.folded(row), spacing = transcriptSpacing();
    const plain = this.legacy || section.kind === "assistant" || section.kind === "thinking";
    const background = this.legacy ? styles["ui.text"].bg ?? colors.panel : transcriptBackground(section.image ? "tool" : section.kind, styles, colors.panel);
    row.box.backgroundColor = background; row.box.border = false;
    row.box.paddingX = plain ? 0 : 1;
    row.box.paddingY = plain ? 0 : spacing.verticalInset;
    // One owner separates visible content without leaving margins beside hidden headings or errors.
    row.box.gap = this.legacy ? 0 : spacing.bodyGap;
    row.heading.visible = !cancelled && !skill && (folded || !this.legacy && (section.kind === "tool" || section.kind === "notice"));
    const markdownKind = !this.legacy && !skill && (section.kind === "assistant" || section.kind === "thinking") ? section.kind : undefined;
    if (row.markdownKind !== markdownKind) {
      if (this.selected === row) this.vim.cancel();
      if (row.markdown && row.bodyRow.parent === row.markdown.root) { row.markdown.root.remove(row.bodyRow); row.box.add(row.bodyRow); }
      row.markdown?.root.destroyRecursively(); row.markdown = undefined; row.markdownKind = markdownKind;
      if (markdownKind) {
        row.markdown = new TranscriptMarkdown(this.renderer, markdownKind === "thinking" ? this.thinkingSyntax : this.proseSyntax, markdownKind === "thinking",
          () => { if (this.isCurrentRow(row)) this.markdownChanging(); },
          (message) => { if (this.isCurrentRow(row)) this.options.notice(message); });
        row.box.remove(row.bodyRow); row.markdown.root.add(row.bodyRow);
        row.box.remove(row.completion); row.box.add(row.markdown.root); row.box.add(row.completion);
        row.markdown.root.on("resize", () => {
          if (this.isCurrentRow(row) && this.visible && !this.help.visible && this.state?.follow && !this.positionIntent && !this.hasSelection()) { this.pending = { position: Infinity }; this.applyTarget(); }
        });
      }
    }
    const reading = selected && this.state?.mode !== "sections";
    if (row.markdown) {
      row.markdown.update(section.text, section.status === "streaming");
      row.markdown.root.visible = !folded;
      row.bodyRow.position = "absolute"; row.bodyRow.zIndex = -1;
      row.bodyRow.left = 0; row.bodyRow.top = 0;
      row.bodyRow.height = Math.max(1, row.markdown.root.height);
      if (reading && !folded && !row.body.formatted) this.syncReader(row);
    } else {
      if (row.body.formatted) { row.body.clearProjection(); row.body.setText(section.text); }
      row.bodyRow.position = "relative"; row.bodyRow.zIndex = 0; row.bodyRow.top = 0; row.bodyRow.height = "auto";
    }
    row.bodyRow.visible = row.body.visible = !cancelled && !section.image && !folded && (!row.markdown || reading);
    const preview = section.image && !folded && this.visible && !this.help.visible;
    if (preview) {
      if (!row.preview) {
        row.preview = new TranscriptImagePreview(this.renderer, `image-preview:${section.id}`, this.options.image,
          () => this.prepareLayoutChange(), () => Math.max(1, this.scroll.viewport.height - 5));
        row.box.remove(row.completion); row.box.add(row.preview.root); row.box.add(row.completion);
      }
      this.updatePreview(row);
    } else if (row.preview) { row.preview.dispose(); row.preview.root.destroyRecursively(); this.imagePreviews.delete(row); delete row.preview; }
    row.body.height = row.markdown ? Math.max(1, row.markdown.root.height) : skill ? 1 : "auto";
    row.body.wrapMode = row.markdown || skill ? "none" : "word";
    row.skillTag.visible = skill;
    const headingText = this.headingText(section, folded);
    if (row.header.plainText !== headingText) {
      const cursor = row.header.cursorOffset;
      row.header.setText(headingText); row.header.cursorOffset = cursor;
      if (selected && this.reader(row) === row.header) this.applySelection(row);
    }
    row.error.visible = !cancelled && !skill && !folded && !!section.error;
    row.error.content = section.error ?? ""; row.error.fg = styles["status.error"].fg; row.error.attributes = styles["status.error"].attributes; row.error.bg = background;
    row.heading.backgroundColor = row.header.backgroundColor = background;
    row.header.textColor = styles[section.kind === "thinking" ? "ui.muted" : section.kind === "tool" && (section.title === "bash" || section.title === "Shell") ? "transcript.toolHeader" : "ui.text"].fg;
    row.header.cursorColor = styles["ui.focusBorder"].fg;
    row.header.selectionBg = styles["transcript.selection"].bg; row.header.selectionFg = styles["transcript.selection"].fg;
    this.highlightHeader(row);
    const bodyStyle = styles[section.kind === "thinking" ? "transcript.thinking" : "ui.text"];
    row.body.textColor = bodyStyle.fg; row.body.attributes = bodyStyle.attributes;
    row.bodyRow.backgroundColor = row.body.backgroundColor = background;
    row.skillTag.bg = row.body.backgroundColor; row.skillTag.fg = styles["transcript.skill"].fg; row.skillTag.attributes = styles["transcript.skill"].attributes;
    row.body.cursorColor = styles["ui.focusBorder"].fg;
    const selectionStyle = styles[this.legacy ? "ui.selection" : "transcript.selection"];
    row.body.selectionBg = selectionStyle.bg; row.body.selectionFg = selectionStyle.fg;
    this.paintCompletion(row);
  }
  private paintCompletion(row: Row): void {
    if (this.disposed || row.box.isDestroyed) return;
    const completion = row.section.completion;
    row.completionWidth = row.completion.width;
    const request = row.request;
    const caption = request ? formatRequestCaption({ ...request, text: request.text ? `“${request.text}”` : "" }, row.completion.width) : "";
    const timing = completion && completion.outcome !== "cancelled" ? formatRunCompletion(completion) + (caption ? `\n${caption}` : "") : "";
    // Cancellation is shown above the prompt, but persistence warnings must remain explicit.
    const text = [timing, completion?.warning].filter(Boolean).join("\n");
    row.completion.visible = !!text;
    if (row.completion.plainText !== text) row.completion.content = text;
    const style = this.theme.styles[completion?.warning ? "status.warning" : "transcript.elapsed"];
    row.completion.fg = style.fg; row.completion.attributes = style.attributes;
    row.completion.bg = style.bg ?? this.theme.styles["ui.text"].bg;
  }
  // Native widths settle after size callbacks; repaint only completion rows whose measured width changed.
  private reflowCompletions = (): void => {
    if (this.disposed || this.scroll.isDestroyed || !this.visible) return;
    for (const row of this.rows.values()) {
      this.updatePreview(row);
      if (row.section.completion && row.completion.width !== row.completionWidth) { this.prepareLayoutChange(); this.paintCompletion(row); }
    }
    const row = this.selected;
    if (!row?.markdown || this.folded(row) || this.help.visible || this.state?.mode === "sections") { this.clearFormattedSelection(); return; }
    this.syncReader(row);
    row.bodyRow.top = 0;
    row.bodyRow.height = row.body.height = Math.max(1, row.markdown.root.height);
    this.syncFormattedSelection(row);
    if (row.body.focused) {
      const cursor = row.body.visualCursor, x = row.markdown.root.x + cursor.visualCol, y = row.markdown.root.y + cursor.visualRow;
      const viewport = this.scroll.viewport;
      this.renderer.setCursorStyle({ style: "block", blinking: false }); this.renderer.setCursorColor(row.body.cursorColor);
      this.renderer.setCursorPosition(x + 1, y + 1, x >= viewport.x && x < viewport.x + viewport.width && y >= viewport.y && y < viewport.y + viewport.height);
    }
  };
  private syncReader(row: Row): void {
    if (!row.markdown?.read(row.body)) return;
    const state = this.state;
    if (state && (row.body.plainText || !row.section.text.trim()) && !state.renderedCursors?.[row.section.id]) {
      // Old source offsets can point at hidden syntax. Do not apply them to a
      // different coordinate space, especially an old visual-selection anchor.
      if (row.body.plainText !== row.section.text.replaceAll("\r\n", "\n")) {
        delete state.cursors[row.section.id]; row.body.cursorOffset = 0;
        if (state.selectedId === row.section.id && state.mode === "visual") { state.mode = "text"; state.anchor = null; delete state.linewise; }
      }
      (state.renderedCursors ??= {})[row.section.id] = true;
    }
    this.applySelection(row);
  }
  private clearFormattedSelection(): void {
    if (this.formattedSelection && this.renderer.getSelection() === this.formattedSelection) this.renderer.clearSelection();
    this.formattedSelection = null; this.formattedSelectionKey = "";
  }
  private syncFormattedSelection(row: Row): void {
    const selection = row.body.getSelection(), root = row.markdown!.root;
    if (!selection || this.state?.mode !== "visual" || !row.body.focused && !this.searchLine.visible) { this.clearFormattedSelection(); return; }
    const start = row.body.pointAt(Math.min(selection.start, selection.end)), end = row.body.pointAt(Math.max(selection.start, selection.end) - 1);
    if (!start || !end) return;
    const key = JSON.stringify([root.num, row.body.displayRevision, root.x, root.y, start, end]);
    if (key === this.formattedSelectionKey && this.renderer.getSelection() === this.formattedSelection) return;
    this.renderer.startSelection(root, root.x + start.x, root.y + start.y);
    this.renderer.updateSelection(root, root.x + end.x, root.y + end.y, { finishDragging: true });
    this.formattedSelection = this.renderer.getSelection(); this.formattedSelectionKey = key;
  }
  private updatePreview(row: Row): void {
    if (!row.preview || !row.section.image) return;
    let count = 0, bytes = 0;
    for (const other of this.imagePreviews) {
      if (!other.preview?.retaining) { this.imagePreviews.delete(other); continue; }
      if (other !== row) { count++; bytes += other.section.image?.byteLength ?? 0; }
    }
    // Unfold-all must not retain an unbounded number of binary responses or native decodes.
    const allowed = row.preview.retaining || count < 8 && bytes + row.section.image.byteLength <= maximumPreviewImageBytes * 2;
    row.preview.update(this.sessionId, row.section.image, allowed);
    if (row.preview.retaining) this.imagePreviews.add(row); else this.imagePreviews.delete(row);
  }
  private markdownChanging = (): void => {
    if (!this.visible || this.disposed || this.help.visible || this.pending) return;
    this.reconcileSelection();
    this.pending = this.state?.follow && !this.positionIntent ? { position: Infinity } : this.viewportAnchor();
  };
  // The owning pane paints its outer inset; the scroll viewport clips that cell away.
  paintFocusGutter(buffer: OptimizedBuffer): void {
    if (this.disposed || !this.visible || !this.scroll.visible || this.help.visible || !this.focused) return;
    const row = this.selected, viewport = this.scroll.viewport;
    if (!row || !row.box.visible || viewport.width < 1 || viewport.height < 1) return;
    const top = Math.max(row.box.screenY, viewport.screenY);
    const bottom = Math.min(row.box.screenY + row.box.height, viewport.screenY + viewport.height);
    if (bottom > top) buffer.fillRect(viewport.screenX - 1, top, 1, bottom - top, this.theme.styles["ui.focusBorder"].fg);
  }
  private paint(): void {
    this.paintLayout();
    for (const row of this.rows.values()) this.paintRow(row);
  }
  private paintLayout(): void {
    this.empty.visible = this.options.emptyLogo !== false && !this.order.length && !this.help.visible;
    // Only tinted cards keep internal padding; plain prose uses the column's separation.
    const spacing = transcriptSpacing();
    this.scroll.content.gap = this.legacy ? 0 : spacing.sectionGap;
    // AgentPanel owns the bottom boundary to status/input; it must not be padded again here.
    this.scroll.content.paddingTop = !this.legacy && !this.help.visible && this.order.length && this.scroll.viewport.height > 1 ? spacing.sectionGap : 0;
  }
  get latestVisible(): boolean {
    return !this.disposed && this.visible && this.scroll.visible && this.scroll.viewport.height > 0
      && !this.help.visible && this.atBottom() && !this.hasSelection();
  }
  get canFollowLatest(): boolean {
    return !this.disposed && !this.scroll.isDestroyed && this.visible && this.scroll.visible && !this.help.visible
      && this.options.initialPosition !== "start" && this.order.length > 0 && !this.atBottom();
  }
  get footerStatus(): string {
    if (!this.visible) return "";
    const labels: string[] = [];
    if (this.focused) {
      if (this.help.visible) labels.push("HELP");
      else if (this.searchLine.visible) labels.push("SEARCH · section");
      else if (this.state?.mode === "visual") labels.push(this.state.linewise ? "VISUAL LINE" : "VISUAL");
      else if (this.state?.mode === "text") labels.push("TEXT");
    }
    if (this.vim.status && this.focused && !this.help.visible) labels.push(vimPendingHint(this.vim.status,
      command => this.hint(command, this.state?.mode === "visual" ? "transcript-visual" : "transcript-text")));
    if (this.state && !this.state.follow && !this.help.visible) labels.push("Paused");
    if (this.focused && this.legacy) labels.push("legacy preview");
    return labels.join(" · ");
  }
  private refreshStatus(): void {
    if (this.disposed) return;
    const status = this.footerStatus;
    if (status === this.lastStatus) return;
    this.lastStatus = status; this.options.changed();
  }
  private focusChanged = (): void => {
    if (this.disposed || this.syncing || !this.visible) return;
    if (!this.focused) this.cancelPending();
    this.paint(); this.refreshStatus();
  };
  private resize = (): void => {
    if (this.disposed || this.scroll.isDestroyed) return;
    this.pending ??= this.focused && this.state?.mode !== "sections" ? { reveal: true } : this.viewportAnchor();
    this.paint(); this.applyTarget();
  };
  private save(): void {
    const state = this.state; if (!state || !this.sessionId || this.disposed) return;
    const row = this.selected;
    if (row && state.mode !== "sections" && this.reader(row).focused) this.rememberCursor(row);
    const key = JSON.stringify(state);
    if (key !== this.lastSavedView) { this.lastSavedView = key; this.options.saveView?.(this.sessionId, structuredClone(state)); }
    this.refreshStatus();
  }

  private atBottom(): boolean {
    return this.scroll.scrollTop >= Math.max(0, this.scroll.scrollHeight - this.scroll.viewport.height) - 0.01;
  }
  private hasSelection(): boolean {
    if (this.state?.mode === "visual") return true;
    const selection = this.renderer.getSelection();
    if (!selection?.isActive) return false;
    return selection.selectedRenderables.some((selected) => {
      for (let node: Renderable | null = selected; node; node = node.parent) if (node === this.scroll) return true;
      return false;
    }) || selection.isDragging && selection.anchor.x >= this.scroll.viewport.x && selection.anchor.x < this.scroll.viewport.x + this.scroll.viewport.width
      && selection.anchor.y >= this.scroll.viewport.y && selection.anchor.y < this.scroll.viewport.y + this.scroll.viewport.height;
  }
  private setFollowing(follow: boolean): void {
    const state = this.state; if (!state || state.follow === follow) return;
    state.follow = follow; this.save(); this.options.changed();
  }
  private syncFollowingFromPosition(): void {
    if (!this.visible || this.disposed || this.help.visible || this.options.initialPosition === "start") return;
    this.setFollowing(this.atBottom() && !this.hasSelection());
  }
  private reconcileSelection(): void {
    if (!this.visible || this.disposed || this.help.visible || !this.state) return;
    if (this.hasSelection()) {
      this.selectionHeldFor = this.sessionId; this.setFollowing(false);
      if (this.pending && "position" in this.pending && this.pending.position === Infinity) this.pending = null;
    } else if (this.selectionHeldFor === this.sessionId && this.selectionHeldFor !== null) {
      this.selectionHeldFor = null; this.syncFollowingFromPosition();
    }
  }
  private scrollIntent = (): void => {
    if (!this.visible || this.disposed || this.help.visible) return;
    // Cancel the old automatic target, then derive follow from where the user's movement lands.
    this.pending = null; this.positionIntent = true;
  };

  followLatest(): void {
    this.cancelPending();
    const state = this.state; if (!state || this.disposed) return;
    if (this.selected && state.mode !== "sections") this.rememberCursor(this.selected);
    state.mode = "sections"; state.anchor = null; delete state.linewise; delete state.readingHeading;
    state.selectedId = this.order.at(-1) ?? null; state.follow = true; this.help.visible = false;
    this.positionIntent = false; this.selectionHeldFor = null;
    for (const row of this.rows.values()) { row.header.clearSelection(); row.body.clearSelection(); }
    // Submitting from Input must not steal focus. A hidden reading cursor, if any,
    // returns to section focus without triggering the normal user-navigation pause.
    this.syncing = true;
    try { if (this.focused) this.scroll.focus(); }
    finally { this.syncing = false; }
    this.pending = { position: Infinity }; this.paint(); this.applyTarget(); this.save(); this.options.changed();
  }

  focus(): void {
    if (!this.visible || !this.state) return;
    const reveal = !this.state.follow || this.state.mode !== "sections";
    this.restoreFocus();
    if (reveal) { this.positionIntent = true; this.pending = { reveal: true }; this.applyTarget(); }
    this.save(); this.options.changed();
  }
  private restoreFocus(): void {
    if (!this.help.visible && this.state?.mode !== "sections" && this.selected) {
      const row = this.selected;
      if (row.markdown && !this.folded(row)) this.syncReader(row);
      const reader = this.reader(row);
      reader.cursorOffset = reader === row.header ? this.state?.headingCursors?.[row.section.id] ?? 0 : this.state?.cursors[row.section.id] ?? 0;
      this.applySelection(row);
      reader.focus();
    } else this.scroll.focus();
  }
  private select(id: string): void {
    this.cancelPending(); this.vimModel = undefined;
    if (!this.state || !this.rows.has(id)) return;
    if (this.selected) this.reader(this.selected).clearSelection();
    this.state.selectedId = id; this.state.mode = "sections"; this.state.anchor = null; delete this.state.linewise; delete this.state.readingHeading;
    this.positionIntent = true; this.pending = { reveal: true }; this.paint(); this.applyTarget(); this.save();
  }
  private jumpSections(direction: -1 | 1, distance: number): void {
    const row = this.selected; if (!row) return;
    const index = this.order.indexOf(row.section.id);
    let target = index;
    for (let next = index + direction; next >= 0 && next < this.order.length; next += direction) {
      const candidate = this.rows.get(this.order[next]!)!;
      const delta = Math.abs(candidate.box.y - row.box.y);
      // Count rendered heights/gaps, but reach at least the adjacent section across oversized cards.
      if (delta > distance && target !== index) break;
      target = next;
      if (delta >= distance) break;
    }
    this.select(this.order[target]!);
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
    if (this.searchLine.visible) return ["transcript.search-submit", "transcript.search-cancel", "transcript.search-clear"].includes(command);
    if (["transcript.search-submit", "transcript.search-cancel", "transcript.search-clear"].includes(command)) return false;
    if (command === "transcript.fold" && !this.foldable(this.selected)) return false;
    if (command === "transcript.open-link" && (this.help.visible || this.state?.mode === "sections")) return false;
    return this.help.visible || command === "transcript.help" || command === "transcript.back" || !!this.selected;
  }
  command(command: CommandId, key?: KeyEvent): void {
    const state = this.state; if (!state || !this.available(command)) return;
    if (this.searchLine.visible) {
      if (command === "transcript.search-clear") { this.searchInput.value = ""; this.options.changed(); return; }
      const query = this.searchInput.value, context = this.vimContext();
      this.searchLine.visible = false; this.restoreFocus();
      if (command === "transcript.search-submit" && context) this.applyVim(this.vim.submitSearch(query, this.searchDirection, context));
      else { this.vim.cancel(); this.save(); this.options.changed(); }
      return;
    }
    if (!this.help.visible && state.mode !== "sections" && this.selected) {
      if (command === "transcript.back" && this.vim.pending) { this.vim.cancel(); this.save(); this.options.changed(); return; }
      if (command === "transcript.count" || command === "transcript.line-start" && key && keyToken(key) === "0" && this.vim.hasCount) {
        this.vim.digit(key ? vimCharacter(key) ?? "" : ""); this.save(); this.options.changed(); return;
      }
      if (command === "transcript.copy" && state.mode === "text" && !this.vim.pending && (this.reader(this.selected).hasSelection() || this.mouseSelectionText() !== null)) {
        this.copy(false); this.save(); this.options.changed(); return;
      }
      const action = transcriptVimAction(command), context = this.vimContext();
      if (action && context) { this.applyVim(this.vim.command(action, context)); return; }
    }
    this.vim.cancel();
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
        case "transcript.half-page-up": this.scroll.scrollBy(-halfPageStep(this.scroll.viewport.height)); break;
        case "transcript.half-page-down": this.scroll.scrollBy(halfPageStep(this.scroll.viewport.height)); break;
      }
      this.options.changed(); return;
    }
    const row = this.selected;
    const index = this.order.indexOf(state.selectedId ?? "");
    switch (command) {
      case "transcript.previous": case "transcript.next": case "transcript.first": case "transcript.last": {
        const next = command === "transcript.first" ? 0 : command === "transcript.last" ? this.order.length - 1 : index + (command === "transcript.next" ? 1 : -1);
        const id = this.order[Math.max(0, Math.min(this.order.length - 1, next))]; if (id) this.select(id);
        break;
      }
      case "transcript.enter":
        if (row) { state.mode = "text"; this.positionIntent = true; this.paint(); this.restoreFocus(); this.pending = { reveal: true }; }
        break;
      case "transcript.back":
        if (state.mode === "visual") { state.mode = "text"; state.anchor = null; delete state.linewise; if (row) this.reader(row).clearSelection(); }
        else if (state.mode === "text") { state.mode = "sections"; delete state.readingHeading; this.positionIntent = true; this.scroll.focus(); this.pending = { reveal: true }; }
        else {
          // This is an explicit reader exit, not a popup/focus round-trip or wheel pause.
          // Finish reading at live output instead of leaving a clipped, paused tail behind.
          if (this.hasSelection()) this.renderer.clearSelection();
          this.followLatest(); this.options.focusPrompt();
        }
        break;
      case "transcript.fold": case "transcript.fold-all": case "transcript.unfold-all": {
        const targets = command === "transcript.fold" ? row ? [row] : [] : [...this.rows.values()];
        const previouslyFolded = row ? this.folded(row) : false;
        if (row && state.mode !== "sections") this.rememberCursor(row);
        for (const target of targets) if (this.foldable(target) && target.section.text) state.folded[target.section.id] = command === "transcript.fold" ? !this.folded(target) : command === "transcript.fold-all";
        if (row && previouslyFolded !== this.folded(row)) {
          const reading = state.mode !== "sections";
          state.anchor = null; delete state.linewise; delete state.readingHeading;
          row.header.clearSelection(); row.body.clearSelection(); this.clearFormattedSelection();
          if (reading) {
            state.mode = "text"; this.paint(); this.restoreFocus();
          } else this.scroll.focus();
        }
        this.positionIntent = true; this.pending = { reveal: true }; break;
      }
      case "transcript.visual": case "transcript.visual-line":
        if (row) this.toggleVisual(row, command === "transcript.visual-line");
        break;
      case "transcript.copy": case "transcript.copy-section": this.copy(command === "transcript.copy-section"); break;
      case "transcript.open-link": {
        if (row) this.openCursorLink(this.reader(row), true);
        return;
      }
      case "transcript.latest": this.followLatest(); return;
      case "transcript.help": this.toggleHelp(); break;
      case "transcript.page-up": case "transcript.page-down": case "transcript.half-page-up": case "transcript.half-page-down": {
        const half = command === "transcript.half-page-up" || command === "transcript.half-page-down";
        const direction = command === "transcript.page-up" || command === "transcript.half-page-up" ? -1 : 1;
        const distance = half ? halfPageStep(this.scroll.viewport.height) : Math.max(1, this.scroll.viewport.height - 1);
        if (state.mode === "sections") this.jumpSections(direction, distance);
        else if (row) for (let i = 0; i < distance; i++) this.move(this.selected ?? row, direction < 0 ? "transcript.up" : "transcript.down", true);
        break;
      }
      default: if (row) this.move(row, command);
    }
    this.reconcileSelection(); this.paint(); this.applyTarget(); this.save(); this.options.changed();
  }
  private crossReadingBoundary(row: Row, reader: TranscriptBody, direction: -1 | 1): boolean {
    if (this.state?.mode !== "text") return false;
    let target = row, heading: boolean;
    if (direction < 0 && reader === row.body && row.heading.visible) heading = true;
    else if (direction > 0 && reader === row.header && !this.folded(row) && !row.section.image) heading = false;
    else {
      const next = this.order[this.order.indexOf(row.section.id) + direction];
      if (!next) return false;
      target = this.rows.get(next)!;
      heading = this.folded(target) || !!target.section.image || direction > 0 && target.heading.visible;
    }
    this.rememberCursor(row); this.cancelPending(); this.vimModel = undefined;
    const state = this.state!;
    state.selectedId = target.section.id;
    if (heading) state.readingHeading = true; else delete state.readingHeading;
    this.positionIntent = true; this.pending = { reveal: true };
    this.paint();
    if (target.markdown && !heading && !this.folded(target)) this.syncReader(target);
    const body = this.reader(target);
    if (direction < 0) body.gotoBufferEnd(); else body.gotoBufferHome();
    body.focus(); this.rememberCursor(target);
    return true;
  }
  private move(row: Row, command: CommandId, visualRows = false): void {
    const body = this.reader(row);
    if (command !== "transcript.up" && command !== "transcript.down") body.resetVerticalGoal();
    // Native editor shortcuts collapse an existing selection before moving. This
    // reader owns its visual anchor, so move the cursor first, then reapply it.
    body.clearSelection();
    switch (command) {
      case "transcript.left": body.moveCursorLeft(); break;
      case "transcript.right": body.moveCursorRight(); break;
      case "transcript.up": case "transcript.down": {
        const before = body.cursorOffset;
        if (this.state?.mode === "visual" && this.state.linewise && !visualRows) {
          const { row: current, col } = body.logicalCursor;
          body.setCursor(Math.max(0, Math.min(body.lineCount - 1, current + (command === "transcript.up" ? -1 : 1))), col);
        } else if (command === "transcript.up") body.moveCursorUp(); else body.moveCursorDown();
        if (body.cursorOffset === before && this.crossReadingBoundary(row, body, command === "transcript.up" ? -1 : 1)) return;
        break;
      }
      case "transcript.word-next": body.moveWordForward(); break;
      case "transcript.word-previous": body.moveWordBackward(); break;
      case "transcript.line-start": body.gotoLineStart(); break;
      case "transcript.line-first-nonblank": {
        const row = body.logicalCursor.row, line = body.plainText.split("\n")[row] ?? "";
        const leading = /^[ \t]*/u.exec(line)![0];
        body.setCursor(row, body.editBuffer.measureText(leading));
        // Vim's ^ stops on the last blank when a nonempty line is all whitespace.
        if (line && leading.length === line.length) body.moveCursorLeft();
        break;
      }
      case "transcript.line-end": body.gotoLineTextEnd(); break;
      case "transcript.buffer-start": body.gotoBufferHome(); break;
      case "transcript.buffer-end": body.gotoBufferEnd(); break;
      default: return;
    }
    this.applySelection(row);
    this.positionIntent = true; this.pending = { reveal: true };
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
  private copy(whole: boolean, range?: VimRange): void {
    const row = this.selected, state = this.state;
    if (!row || !state) return;
    const reader = this.reader(row), visibleText = this.readerText(row);
    const mouseText = !whole && !range && state.mode !== "sections" ? this.mouseSelectionText() : null;
    const text = range ? this.copyRange(row, range) : whole || state.mode === "sections" ? row.section.text : state.mode === "visual" || reader.hasSelection() ? this.selectedText(row)
      : mouseText ?? visibleText.split("\n")[reader.logicalCursor.row] ?? "";
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
        state.mode = "text"; state.anchor = null; delete state.linewise; reader.clearSelection(); this.reconcileSelection(); this.save(); this.options.changed();
      }
    }).catch((error: unknown) => { const message = reportUnexpected(error, "transcript copy"); if (!this.disposed) this.options.notice(message); });
  }
  private mouseSelectionText(): string | null {
    const selection = this.renderer.getSelection();
    if (!selection?.isActive || selection === this.formattedSelection || !selection.selectedRenderables.length) return null;
    const owned = selection.selectedRenderables.every(renderable => {
      for (let node: Renderable | null = renderable; node; node = node.parent) if (node === this.scroll.content) return true;
      return false;
    });
    return owned ? selection.getSelectedText() || null : null;
  }
  private vimContext(): VimContext | null {
    const row = this.selected; if (!row || !this.state || this.state.mode === "sections") return null;
    const reader = this.reader(row), panel = this;
    // Prefixes and native visual-row motion need no document segmentation/copy.
    return {
      get model() {
        const text = reader.plainText;
        if (panel.vimModel?.text !== text) panel.vimModel = new VimText(text);
        return panel.vimModel;
      },
      get cursor() { return reader.getTextRange(0, reader.cursorOffset).length; },
      visual: this.state.mode === "visual",
    };
  }
  captureKey(key: KeyEvent, keymap: Keymap): boolean {
    const context = this.keyContext();
    if (!context || context === "transcript-search" || context === "transcript" || this.help.visible) return false;
    if (this.vim.awaitingCharacter) {
      const character = vimCharacter(key), state = this.vimContext();
      if (character !== null && state) { this.applyVim(this.vim.character(character, state)); return true; }
      if (key.name === "escape") return false;
      this.vim.cancel(); this.save(); this.options.changed();
      // Preserve configured global controls, but consume unbound cancel/edit keys
      // through release so repeats cannot edit a subsequently focused prompt.
      return !keymap.bound(keyToken(key), context);
    }
    if (this.vim.pending && !keymap.bound(keyToken(key), context)) {
      const digit = this.vim.hasCount ? vimCharacter(key) : null;
      if (digit !== null && /^[0-9]$/u.test(digit)) this.vim.digit(digit);
      else this.vim.cancel();
      this.save(); this.options.changed(); return true;
    }
    return false;
  }
  private readPaste = (): void => {
    const context = this.keyContext();
    if (context === "transcript-text" || context === "transcript-visual") { this.vim.cancel(); this.save(); this.options.changed(); }
  };
  cancelPending(): void {
    this.vim.cancel(); this.searchLine.visible = false;
    if (!this.disposed) this.refreshStatus();
  }
  private applyVim(effect: VimEffect): void {
    const row = this.selected, state = this.state;
    if (!row || !state) return;
    const reader = this.reader(row), context = this.vimContext(); if (!context) return;
    const offset = (position: number) => reader.editBuffer.measureText(reader.plainText.slice(0, position));
    if (effect.type === "move" || effect.type === "native" || effect.type === "select") reader.focus();
    switch (effect.type) {
      case "none": break;
      case "notice": this.options.notice(effect.message); break;
      case "search":
        this.rememberCursor(row);
        this.searchDirection = effect.direction; this.searchPrefix.content = effect.direction === 1 ? "/" : "?";
        this.searchInput.value = ""; this.searchLine.visible = true; this.searchInput.focus(); break;
      case "copy-selection": this.copy(false); break;
      case "yank": this.copy(false, effect.range); break;
      case "native":
        for (let index = 0; index < effect.count; index++) {
          const current: Row | undefined = this.selected; if (!current) break;
          const body = this.reader(current), before = body.cursorOffset;
          this.move(current, effect.motion === "up" ? "transcript.up" : "transcript.down");
          if (this.selected === current && this.reader(current) === body && body.cursorOffset === before) break;
        }
        break;
      case "move":
        reader.clearSelection(); reader.resetVerticalGoal(); reader.cursorOffset = offset(effect.position);
        this.applySelection(row); this.positionIntent = true; this.pending = { reveal: true }; break;
      case "select":
        if (effect.range.end <= effect.range.start) { this.options.notice("No text in object"); break; }
        state.mode = "visual"; state.anchor = offset(effect.range.start);
        if (effect.range.linewise) state.linewise = true; else delete state.linewise;
        reader.clearSelection(); reader.cursorOffset = offset(context.model.previousCharacter(effect.range.end));
        this.applySelection(row); this.positionIntent = true; this.pending = { reveal: true }; break;
    }
    this.reconcileSelection(); this.paint(); this.applyTarget(); this.save(); this.options.changed();
  }
  private copyRange(row: Row, range: VimRange): string {
    const reader = this.reader(row), text = reader.plainText.slice(range.start, range.end), source = this.readerText(row);
    if (!source.includes("\r\n")) return text;
    let line = reader.plainText.slice(0, range.start).split("\n").length - 1;
    const original = source.split("\n");
    return text.replace(/\n/gu, () => original[line++]?.endsWith("\r") ? "\r\n" : "\n");
  }
  private linkDown = (event: MouseEvent): void => {
    this.cancelPending(); this.linkPress = undefined;
    if (!this.visible || this.help.visible || event.button !== 0 || event.modifiers.ctrl || event.modifiers.alt || event.modifiers.shift) return;
    const url = this.renderer.getLinkAt(event.x, event.y);
    const reader = event.target instanceof TranscriptBody ? event.target : undefined;
    if (url || reader) this.linkPress = { x: event.x, y: event.y, sessionId: this.sessionId, url, reader, source: reader?.plainText };
  };
  private linkUp = (event: MouseEvent): void => {
    const press = this.linkPress; this.linkPress = undefined;
    if (!press || !this.visible || this.help.visible || event.button !== 0 || event.x !== press.x || event.y !== press.y
      || event.modifiers.ctrl || event.modifiers.alt || event.modifiers.shift || press.sessionId !== this.sessionId) return;
    if (press.url) {
      if (this.renderer.getLinkAt(event.x, event.y) === press.url) void this.openLink(press.url).catch(this.linkFailure);
      return;
    }
    const reader = press.reader, row = this.selected;
    if (!reader || reader.isDestroyed || reader !== event.target || reader.plainText !== press.source || !row || this.reader(row) !== reader) return;
    // A native cursor clamps clicks beyond EOL. Do not treat blank margins as links.
    const cursor = reader.visualCursor;
    if (event.x !== reader.x + cursor.visualCol || event.y !== reader.y + cursor.visualRow) return;
    this.openCursorLink(reader, false);
  };
  private linkFailure = (error: unknown): void => {
    const message = reportUnexpected(error, "transcript link");
    if (!this.disposed) this.options.notice(message);
  };
  private openCursorLink(reader: TranscriptBody, notify: boolean): void {
    const offset = reader.getTextRange(0, reader.cursorOffset).length;
    const url = reader.linkAtCursor() ?? transcriptLinkAt(reader.plainText, offset);
    if (url) void this.openLink(url).catch(this.linkFailure);
    else if (notify) this.options.notice("No HTTP(S) link under the cursor");
  }
  private async openLink(url: string): Promise<void> {
    const checked = validateBrowserUrl(url);
    if (!checked.ok) { this.options.notice(`[${checked.error.code}] ${checked.error.message}`); return; }
    const result = await (this.options.openUrl ?? openBrowserUrl)(checked.value);
    if (!this.disposed && !result.ok) this.options.notice(`[${result.error.code}] ${result.error.message}`);
  }
  private toggleHelp(): void {
    if (this.help.visible) {
      this.help.visible = false; this.paint();
      this.positionIntent = !this.helpFollow; this.setFollowing(this.helpFollow && !this.hasSelection());
      this.pending = { position: this.state?.follow ? Infinity : this.helpPosition }; this.restoreFocus(); this.applyTarget(); return;
    }
    this.helpPosition = this.scroll.scrollTop; this.helpFollow = this.state?.follow ?? false;
    this.setFollowing(false); this.positionIntent = false;
    this.help.visible = true;
    const textHint = (command: CommandId) => this.hint(command, "transcript-text");
    const wordCommands = ["transcript.word-next", "transcript.word-previous", "transcript.word-end", "transcript.big-word-next", "transcript.big-word-previous", "transcript.big-word-end"] as const;
    const wordKeys = wordCommands.map(textHint).filter(Boolean).join("/");
    const yank = textHint("transcript.copy"), inner = textHint("transcript.inner-object"), around = textHint("transcript.around-object"), count = textHint("transcript.count");
    this.help.content = `Sections: ${this.hint("transcript.previous", "transcript")}/${this.hint("transcript.next", "transcript")} move · ${this.hint("transcript.enter", "transcript")} cursor in formatted / visible text · ${this.hint("transcript.fold", "transcript")} fold/unfold\n`
      + `Text/visual: ${this.hint("transcript.left", "transcript-text")}/${this.hint("transcript.right", "transcript-text")} characters · ${wordKeys} words · ${this.hint("transcript.line-start", "transcript-text")}/${this.hint("transcript.line-first-nonblank", "transcript-text")}/${this.hint("transcript.line-end", "transcript-text")} line start/first nonblank/end · ${this.hint("transcript.buffer-start", "transcript-text")}/${this.hint("transcript.buffer-end", "transcript-text")} section\n`
      + `${this.hint("transcript.open-link", "transcript-text")} open HTTP(S) link under the cursor in the default browser; click a rendered link to open it.\n`
      + `${this.hint("transcript.visual", "transcript-text")} select (inclusive) · ${this.hint("transcript.visual-line", "transcript-text")} select logical lines · ${this.hint("transcript.copy", "transcript")} copy section/selection; in Text starts a yank operator · ${this.hint("transcript.copy-section", "transcript")} raw whole section\n`
      + (yank ? `${yank}${yank} yank logical line (real newline only); combine ${yank} with a motion/object. ` : "")
      + (inner ? `${inner}w inner word, ${inner}W WORD, ${inner}p paragraph; ${inner} followed by a quote/bracket selects its inside. ` : "")
      + (around ? `${around} selects the same objects including surrounding whitespace/delimiters.\n` : "\n")
      + (count ? `${count}… starts a count before motions or on either side of yank (maximum 9999). ` : "Numeric count input is unbound. ")
      + `${this.hint("transcript.back", "transcript-text")} cancels unfinished commands first.\n`
      + `${textHint("transcript.find-forward")}/${textHint("transcript.find-backward")}/${textHint("transcript.till-forward")}/${textHint("transcript.till-backward")} + character finds within the logical line; ${textHint("transcript.find-repeat")}/${textHint("transcript.find-reverse")} repeat/reverse.\n`
      + `${textHint("transcript.search-forward")}/${textHint("transcript.search-backward")} literal search in the current reading section; ${this.hint("transcript.search-submit", "transcript-search")} accepts, ${this.hint("transcript.search-cancel", "transcript-search")} cancels, ${this.hint("transcript.search-clear", "transcript-search")} clears only the query. ${textHint("transcript.search-next")}/${textHint("transcript.search-previous")} repeat; ${textHint("transcript.search-word-forward")}/${textHint("transcript.search-word-backward")} search whole word.\n`
      + `${this.hint("transcript.half-page-down", "transcript")}/${this.hint("transcript.half-page-up", "transcript")} half-page section jump; ${this.hint("transcript.page-down", "transcript")}/${this.hint("transcript.page-up", "transcript")} full-page section jump. Text/Visual moves the cursor.\n`
      + `Text up/down crosses visible headings and adjacent sections; Visual selections stay within the active text surface. Folding keeps Text mode and restores each surface's cursor.\n`
      + `Following resumes at the viewport bottom and pauses above it; selections protect the view.\n`
      + `Markdown stays formatted while reading and selecting; copy lines/selections as displayed, or copy the whole raw section.\n`
      + `Context compacted summaries start folded; click their heading or use ${this.hint("transcript.fold", "transcript")} to expand/collapse.\n`
      + `Image attachments show [read] filename, start folded, and preview on header click or ${this.hint("transcript.fold", "transcript")}.\n`
      + `Thinking is always visible as gray italic text and never folds.\n`
      + `Skills show [skill] name only and never fold; copying excludes the decorative tag.\n`
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
    if (!this.visible || !this.scroll.visible || this.disposed || this.scroll.isDestroyed || !this.pending) return;
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
        const top = this.scroll.viewport.y;
        const bottom = top + this.scroll.viewport.height - 1;
        const end = !reading && row.box.height <= bottom - top + 1 ? row.box.y + row.box.height - 1 : y;
        if (y < top) this.scroll.scrollBy(y - top);
        else if (end > bottom) this.scroll.scrollBy(end - bottom);
      }
    } finally { this.syncing = false; }
  };
  prepareLayoutChange(): void {
    if (!this.visible || this.disposed || this.scroll.isDestroyed) return;
    this.pending ??= this.state?.follow ? { position: Infinity } : this.viewportAnchor();
  }
  private finishLayout = (): void => {
    this.reconcileSelection();
    if (this.positionIntent) {
      this.applyTarget(); this.pending = null; this.positionIntent = false; this.syncFollowingFromPosition();
    } else {
      // New content increases the bottom: preserve the pre-growth follow intent instead of
      // mistaking that geometry change for the user scrolling away from the bottom.
      if (this.visible && !this.help.visible && this.state?.follow && !this.hasSelection()) this.pending = { position: Infinity };
      this.applyTarget(); this.pending = null;
      if (this.atBottom()) this.syncFollowingFromPosition();
    }
    this.rememberScroll();
    this.geometry = { id: this.sessionId, content: this.scroll.scrollHeight, viewport: this.scroll.viewport.height };
  };
  rememberScroll = (): void => {
    if (this.disposed || this.scroll.isDestroyed || this.syncing || this.pending || this.help.visible || !this.sessionId || !this.visible || !this.scroll.visible) return;
    const position = Math.max(0, Math.round(this.scroll.scrollTop));
    if (this.positions[this.sessionId] === position) return;
    this.positions[this.sessionId] = position; this.options.saveScroll(this.sessionId, position);
    const sameGeometry = this.geometry?.id === this.sessionId && this.geometry.content === this.scroll.scrollHeight && this.geometry.viewport === this.scroll.viewport.height;
    if (sameGeometry || this.positionIntent) { this.syncFollowingFromPosition(); this.positionIntent = false; }
  };
  dispose(): void {
    if (this.disposed) return;
    this.rememberScroll(); this.disposed = true; this.vimModel = undefined;
    this.renderer.off("focused_renderable", this.focusChanged);
    this.renderer.keyInput.off("paste", this.readPaste);
    this.renderer.off("resize", this.resize);
    this.clearFormattedSelection();
    this.renderer.removePostProcessFn(this.reflowCompletions);
    this.scroll.verticalScrollBar.off("change", this.rememberScroll);
    this.scroll.content.off("resize", this.applyTarget); this.scroll.viewport.off("resize", this.resize);
    this.destroyRows(this.rows);
    for (const cached of this.cached.values()) this.destroyRows(cached.rows);
    this.cached.clear(); this.imagePreviews.clear(); this.source = [];
    this.headerSyntax.destroy(); this.proseSyntax.destroy(); this.thinkingSyntax.destroy();
    void this.clipboard.dispose().catch((error: unknown) => reportUnexpected(error, "transcript clipboard cleanup"));
  }
}
