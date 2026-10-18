import { createExtmarksController, RenderableEvents, SyntaxStyle, TextareaRenderable, InputRenderableEvents, type ExtmarksController, type CliRenderer, type PasteEvent } from "@opentui/core";
import { Value } from "typebox/value";
import { capture, reportUnexpected, type ExpectedError } from "../../errors.ts";
import { rm } from "node:fs/promises";
import type { Result } from "../../result.ts";
import { Clipboard } from "../../ui/clipboard.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import { uiTheme } from "../../ui/theme.ts";
import { maxFrameBytes } from "../../runtime/protocol.ts";
import { cacheClipboardImage, fileInput, pastedFiles } from "../prompt-attachments.ts";
import { collapsedPaste, expandPromptDraft, promptPartLabel, promptPartSchema, validatePromptDraft, type PromptDraft, type PromptPart, type PromptSubmission } from "../prompt-input.ts";
import type { DialogContent } from "../../ui/text-dialog.ts";

type Options = { clipboard?: Pick<Clipboard, "read" | "dispose">; cacheRoot?: string };

export class PromptInput extends TextareaRenderable {
  readonly activity: LoadingSpinner;
  private readonly clipboard: Pick<Clipboard, "read" | "dispose">;
  private readCursor = 0;
  private readonly style: SyntaxStyle;
  private marks: ExtmarksController;
  private tokenType: number;
  private readonly styleId: number;
  private sequence = { paste: 1, image: 1, file: 1 };
  private updating = false;
  private generation = 0;
  private reading = false;
  private readAbort: AbortController | undefined;
  private disposed = false;
  private cwd = process.cwd();

  constructor(renderer: CliRenderer, private readonly notice: (message: string) => void,
    private readonly inspect: (content: DialogContent) => void, private readonly options: Options = {}) {
    super(renderer, { id: "session-prompt", width: "auto", flexGrow: 1, minWidth: 0, height: 1, flexShrink: 0, wrapMode: "word",
      keyBindings: [{ name: "return", shift: true, action: "newline" }, { name: "return", meta: true, action: "newline" },
        { name: "kpenter", shift: true, action: "newline" }, { name: "kpenter", meta: true, action: "newline" }] });
    this.clipboard = options.clipboard ?? new Clipboard(renderer); this.activity = new LoadingSpinner(renderer, { id: "prompt-paste-loading" });
    this.style = SyntaxStyle.create(renderer.nativeScene!); this.syntaxStyle = this.style;
    this.styleId = this.style.registerStyle("attachment", {});
    this.marks = createExtmarksController(this.editBuffer, this.editorView);
    this.tokenType = this.marks.registerType("radian-prompt-attachment");
    uiTheme(renderer).bind(this, (colors) => {
      this.style.registerStyle("attachment", { fg: colors.accent, bg: colors.selected }); this.activity.root.fg = colors.accent;
    });
    this.onContentChange = () => { if (!this.updating) this.changed(); };
    this.on(RenderableEvents.DESTROYED, () => this.dispose());
  }

  override get extmarks(): ExtmarksController { return this.marks; }
  get value(): string { return this.plainText; }
  set value(value: string) {
    this.cancelPaste();
    this.batch(() => { this.replaceBuffer(value); this.sequence = { paste: 1, image: 1, file: 1 }; this.cursorOffset = this.editBuffer.measureText(value); });
  }
  get pending(): boolean { return this.reading; }
  setWorkingDirectory(path: string): void { this.cwd = path; }
  get draft(): PromptDraft {
    const tokens = this.extmarks.getAllForTypeId(this.tokenType).sort((a, b) => a.start - b.start).map((mark) => {
      const part: unknown = this.extmarks.getMetadataFor(mark.id);
      if (!Value.Check(promptPartSchema, part)) throw new Error("Prompt attachment metadata was lost.");
      return { start: this.editBuffer.getTextRange(0, mark.start).length, end: this.editBuffer.getTextRange(0, mark.end).length, part: { ...part } };
    });
    return { value: this.value, tokens, cursor: this.editBuffer.getTextRange(0, this.cursorOffset).length, next: { ...this.sequence } };
  }
  restore(draft: PromptDraft): Result<PromptDraft, ExpectedError> {
    const checked = validatePromptDraft(draft); if (!checked.ok) return checked;
    this.cancelPaste();
    this.batch(() => {
      this.replaceBuffer(draft.value); this.sequence = { ...draft.next };
      for (const token of draft.tokens) this.extmarks.create({ start: this.editBuffer.measureText(draft.value.slice(0, token.start)),
        end: this.editBuffer.measureText(draft.value.slice(0, token.end)), typeId: this.tokenType, virtual: true, styleId: this.styleId, metadata: { ...token.part } });
      this.cursorOffset = this.editBuffer.measureText(draft.value.slice(0, draft.cursor));
    });
    return checked;
  }
  get submission(): PromptSubmission { return expandPromptDraft(this.draft); }
  get legacyText(): string { return expandPromptDraft(this.draft, false).text; }
  replaceRange(start: number, end: number, text: string): void {
    this.batch(() => {
      const from = this.editBuffer.measureText(this.value.slice(0, start)), to = this.editBuffer.measureText(this.value.slice(0, end));
      this.cursorOffset = to; this.setSelection(from, to); this.insertText(text);
    });
  }
  attachFile(path: string, start?: number, end?: number): boolean {
    const file = fileInput(path, this.cwd);
    if (file.path.length > 4096 || file.path.includes("\0")) { this.notice("[INVALID_INPUT] File path exceeds the supported path boundary. Input was retained."); return false; }
    this.insertPart({ ...file, index: this.sequence[file.kind]++ }, start, end);
    return true;
  }
  override handlePaste(event: PasteEvent): void {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(event.bytes); }
    catch (error) { if (error instanceof TypeError) { this.notice("[INVALID_INPUT] Paste is not valid UTF-8. Nothing was inserted."); return; } throw error; }
    this.pasteText(text);
  }
  pasteText(text: string): void {
    if (!text) return;
    if (Buffer.byteLength(text) + Buffer.byteLength(this.legacyText) > maxFrameBytes) { this.notice("Paste exceeds the runtime payload safety limit. Nothing was inserted; input was retained."); return; }
    const files = pastedFiles(text, this.cwd);
    if (files) {
      if (files.some((file) => file.path.length > 4096)) { this.notice("[INVALID_INPUT] A pasted file path exceeds the supported path boundary. Nothing was inserted."); return; }
      this.batch(() => { for (const file of files) { this.insertPart({ ...file, index: this.sequence[file.kind]++ }); this.insertText(" "); } });
    } else if (collapsedPaste(text)) this.insertPart({ kind: "paste", text, index: this.sequence.paste++ });
    else this.insertText(text);
  }
  async pasteClipboard(): Promise<void> {
    if (this.reading || this.disposed) return;
    const generation = this.generation, controller = this.readAbort = new AbortController();
    this.readCursor = this.cursorOffset; this.reading = true; this.activity.start(); this.emit(InputRenderableEvents.INPUT, this.value);
    try {
      const result = await this.clipboard.read(controller.signal);
      if (!this.current(generation, controller)) return;
      if (!result.ok) { this.notice(`[${result.error.code}] ${result.error.message}`); return; }
      const { mimeType, bytes } = result.value;
      if (mimeType.startsWith("image/")) {
        const cached = await cacheClipboardImage(bytes, mimeType, this.options.cacheRoot);
        if (!this.current(generation, controller)) {
          if (cached.ok) { const removed = await capture(() => rm(cached.value.path, { force: true })); if (!removed.ok) this.notice(`[${removed.error.code}] A cancelled clipboard cache file could not be removed.`); }
          return;
        }
        if (!cached.ok) { this.notice(`[${cached.error.code}] ${cached.error.message}`); return; }
        this.insertPart({ ...cached.value, index: this.sequence.image++ });
      } else {
        const text = new TextDecoder().decode(bytes);
        this.pasteText(mimeType === "text/uri-list" ? text.split(/\r?\n/u).filter((line) => line && !line.startsWith("#")).join("\n") : text);
      }
    } finally {
      if (this.readAbort === controller) { this.reading = false; this.readAbort = undefined; this.activity.stop(); if (!this.disposed) this.emit(InputRenderableEvents.INPUT, this.value); }
    }
  }
  private current(generation: number, controller: AbortController): boolean {
    if (this.disposed || controller.signal.aborted) return false;
    if (generation !== this.generation || this.cursorOffset !== this.readCursor) { this.notice("Input changed while reading the clipboard. Nothing was inserted; paste again at the intended position."); return false; }
    return true;
  }
  get canInspect(): boolean { return this.atCursor() !== undefined; }
  inspectAtCursor(): void {
    const mark = this.atCursor(); if (!mark) return;
    const part: unknown = this.extmarks.getMetadataFor(mark.id);
    if (!Value.Check(promptPartSchema, part)) throw new Error("Prompt attachment metadata was lost.");
    const generation = this.generation;
    this.inspect({ title: promptPartLabel(part), text: part.kind === "paste" ? part.text : `${part.kind === "image" ? "Image" : "File"} reference\n\n${part.path}`,
      remove: () => { if (generation === this.generation && !this.disposed && this.extmarks.get(mark.id)) this.batch(() => { this.cursorOffset = mark.end; this.setSelection(mark.start, mark.end); this.editorView.deleteSelectedText(); }); } });
  }
  private atCursor() {
    const marks = this.extmarks.getAllForTypeId(this.tokenType);
    return marks.find((mark) => this.cursorOffset >= mark.start && this.cursorOffset < mark.end)
      ?? marks.find((mark) => this.cursorOffset === mark.end);
  }
  private insertPart(part: PromptPart, start?: number, end?: number): void {
    this.batch(() => {
      if (start !== undefined && end !== undefined) {
        const from = this.editBuffer.measureText(this.value.slice(0, start)), to = this.editBuffer.measureText(this.value.slice(0, end));
        this.cursorOffset = to; this.setSelection(from, to);
      }
      const selection = this.getSelection();
      const offset = selection ? Math.min(selection.start, selection.end) : this.cursorOffset;
      const label = promptPartLabel(part);
      this.insertText(label);
      this.extmarks.create({ start: offset, end: offset + this.editBuffer.measureText(label), virtual: true, typeId: this.tokenType, styleId: this.styleId, metadata: part });
      this.clearSelection(); this.cursorOffset = offset + this.editBuffer.measureText(label);
    });
  }
  private replaceBuffer(value: string): void {
    // Extmark history is separate from native undo history. Reset both together
    // when selecting a different draft so another session's attachments cannot reappear.
    this.marks.destroy(); this.setText(value);
    this.marks = createExtmarksController(this.editBuffer, this.editorView);
    this.tokenType = this.marks.registerType("radian-prompt-attachment");
  }
  private batch(operation: () => void): void {
    const before = this.updating; this.updating = true;
    try { operation(); } finally { this.updating = before; }
    if (!before) this.changed();
  }
  private changed(): void { this.generation++; if (!this.disposed) this.emit(InputRenderableEvents.INPUT, this.value); }
  cancelPaste(): void { this.generation++; this.readAbort?.abort(); this.readAbort = undefined; this.reading = false; this.activity.cancel(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.cancelPaste(); this.marks.destroy(); this.style.destroy();
    void this.clipboard.dispose().catch((error: unknown) => reportUnexpected(error, "prompt clipboard cleanup"));
  }
}
