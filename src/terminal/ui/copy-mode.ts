import { EditBufferRenderable, type CliRenderer, type KeyEvent, type PasteEvent } from "@opentui/core";
import { reportUnexpected, type ExpectedError } from "../../errors.ts";
import type { Result } from "../../result.ts";
import type { TerminalText } from "../../runtime/protocol.ts";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import { Clipboard } from "../../ui/clipboard.ts";
import { halfPageStep } from "../../ui/navigation.ts";
import { uiTheme } from "../../ui/theme.ts";
import type { Notice } from "../../ui/messages.ts";

class TerminalReader extends EditBufferRenderable {
  handleKeyPress(_event: KeyEvent): boolean { return true; }
  handlePaste(_event: PasteEvent): void {}
}
type Options = {
  notice: Notice;
  changed(): void;
  input(focus: boolean): void;
  busy(pending: boolean): void;
  copy?(text: string): Promise<Result<string, ExpectedError>>;
};

// The shell continues painting underneath this immutable, read-only snapshot.
// Keeping both at the same geometry avoids resizing a running full-screen job.
export class TerminalCopyMode {
  readonly root: TerminalReader;
  private readonly clipboard: Clipboard;
  private anchor: number | null = null;
  private linewise = false;
  private pending = false;
  private generation = 0;
  private disposed = false;

  constructor(renderer: CliRenderer, private readonly options: Options) {
    this.clipboard = new Clipboard(renderer);
    this.root = new TerminalReader(renderer, { id: "terminal-copy", position: "absolute", top: 0, left: 0,
      width: "100%", height: "100%", visible: false, wrapMode: "char", scrollMargin: 0,
      cursorStyle: { style: "block", blinking: false } });
    uiTheme(renderer).bindStyles(this.root, styles => {
      this.root.textColor = styles["ui.text"].fg; this.root.backgroundColor = styles["ui.text"].bg;
      this.root.selectionBg = styles["transcript.selection"].bg; this.root.selectionFg = styles["transcript.selection"].fg;
      this.root.cursorColor = styles["ui.focusBorder"].fg;
    });
  }
  get active(): boolean { return this.root.visible && !this.disposed; }
  get context(): KeyContext | null { return this.active && this.root.focused ? this.anchor === null ? "terminal-copy" : "terminal-visual" : null; }
  get status(): string { return !this.active ? "" : this.pending ? "Reading output" : `${this.anchor === null ? "NORMAL" : this.linewise ? "VISUAL LINE" : "VISUAL"} · frozen output`; }

  open(read: () => Promise<Result<TerminalText, ExpectedError>>): void {
    if (this.active || this.disposed) return;
    const generation = ++this.generation;
    this.pending = true; this.anchor = null; this.linewise = false;
    this.root.setText(""); this.root.visible = true; this.root.showCursor = false; this.root.focus();
    this.options.busy(true); this.options.changed();
    void read().then(result => {
      if (this.disposed || this.generation !== generation) return;
      if (!result.ok) { this.options.notice(`[${result.error.code}] ${result.error.message}`, { level: "error", source: "Terminal" }); this.close(); return; }
      this.pending = false; this.options.busy(false);
      this.root.setText(result.value.text); this.root.setCursor(result.value.cursor.row, result.value.cursor.column);
      this.root.showCursor = true; this.options.changed();
    }).catch((error: unknown) => {
      const message = reportUnexpected(error, "terminal copy mode");
      if (!this.disposed && this.generation === generation) { this.options.notice(message, { level: "error", source: "Terminal" }); this.close(); }
    });
  }
  command(command: CommandId): void {
    if (!this.active) return;
    if (command === "terminal.copy-input") { this.close(); return; }
    if (command === "terminal.copy-back") {
      if (this.anchor === null) this.close(); else { this.clearSelection(); this.options.changed(); }
      return;
    }
    if (this.pending) return;
    if (command === "terminal.copy-yank") { this.copy(); return; }
    if (command === "terminal.copy-visual" || command === "terminal.copy-visual-line") {
      const linewise = command === "terminal.copy-visual-line";
      if (this.anchor !== null && this.linewise === linewise) this.clearSelection();
      else { this.anchor ??= this.root.cursorOffset; this.linewise = linewise; this.select(); }
      this.options.changed(); return;
    }
    this.root.clearSelection();
    switch (command) {
      case "terminal.copy-left": this.root.moveCursorLeft(); break;
      case "terminal.copy-right": this.root.moveCursorRight(); break;
      case "terminal.copy-up": case "terminal.copy-down": {
        const direction = command === "terminal.copy-up" ? -1 : 1;
        if (this.anchor !== null && this.linewise) this.root.setCursor(Math.max(0, Math.min(this.root.lineCount - 1, this.root.logicalCursor.row + direction)), this.root.logicalCursor.col);
        else if (direction < 0) this.root.moveCursorUp(); else this.root.moveCursorDown();
        break;
      }
      case "terminal.copy-word-next": this.root.moveWordForward(); break;
      case "terminal.copy-word-previous": this.root.moveWordBackward(); break;
      case "terminal.copy-line-start": this.root.gotoLineStart(); break;
      case "terminal.copy-line-end": this.root.gotoLineTextEnd(); break;
      case "terminal.copy-first": this.root.gotoBufferHome(); break;
      case "terminal.copy-last": this.root.gotoBufferEnd(); break;
      case "terminal.copy-page-up": case "terminal.copy-page-down": case "terminal.copy-half-page-up": case "terminal.copy-half-page-down": {
        const distance = command.includes("half-page") ? halfPageStep(this.root.height) : Math.max(1, this.root.height - 1);
        const up = command.endsWith("-up");
        for (let index = 0; index < distance; index++) { if (up) this.root.moveCursorUp(); else this.root.moveCursorDown(); }
        break;
      }
    }
    this.select(); this.options.changed();
  }
  private select(): void {
    if (this.anchor === null) return;
    if (!this.linewise) { this.root.setSelectionInclusive(this.anchor, this.root.cursorOffset); return; }
    const buffer = this.root.editBuffer, row = buffer.offsetToPosition(this.anchor)?.row ?? 0;
    const first = Math.min(row, this.root.logicalCursor.row), last = Math.max(row, this.root.logicalCursor.row);
    this.root.setSelection(buffer.getLineStartOffset(first), last + 1 < this.root.lineCount ? buffer.getLineStartOffset(last + 1) : buffer.measureText(this.root.plainText));
  }
  private clearSelection(): void { this.anchor = null; this.linewise = false; this.root.clearSelection(); }
  private copy(): void {
    const text = this.anchor !== null || this.root.hasSelection() ? this.root.getSelectedText() : this.root.plainText.split("\n")[this.root.logicalCursor.row] ?? "";
    if (!text) { this.options.notice("No text to copy"); return; }
    const generation = this.generation, anchor = this.anchor, cursor = this.root.cursorOffset, linewise = this.linewise;
    void Promise.resolve().then(() => this.options.copy?.(text) ?? this.clipboard.copy(text)).then(result => {
      if (this.disposed || this.generation !== generation) return;
      this.options.notice(result.ok ? result.value : `[${result.error.code}] ${result.error.message}`, { level: result.ok ? "success" : "error", source: "Clipboard" });
      if (result.ok && this.anchor === anchor && this.root.cursorOffset === cursor && this.linewise === linewise) { this.clearSelection(); this.options.changed(); }
    }).catch((error: unknown) => {
      const message = reportUnexpected(error, "terminal copy"); if (!this.disposed) this.options.notice(message, { level: "error", source: "Clipboard" });
    });
  }
  private close(): void {
    const focused = this.root.focused;
    this.generation++; this.pending = false; this.root.visible = false; this.clearSelection(); this.options.busy(false);
    // An asynchronous failure must not steal focus from an overlay opened meanwhile.
    this.options.input(focused);
    this.options.changed();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++;
    this.root.destroyRecursively();
    void this.clipboard.dispose().catch((error: unknown) => reportUnexpected(error, "terminal copy clipboard cleanup"));
  }
}
