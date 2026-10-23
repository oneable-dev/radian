import { CodeRenderable, MarkdownRenderable, RenderableEvents, SyntaxStyle, TextBufferRenderable, TextTableRenderable, type CliRenderer, type Renderable, type StyleDefinitionInput } from "@opentui/core";
import { reportUnexpected } from "../../errors.ts";
import { uiTheme } from "../../ui/theme.ts";
import { codeStyles, syntaxDefinition, type UiStyles } from "../../ui/theme-styles.ts";
import { TranscriptBody, TranscriptTable } from "./transcript-reader.ts";

function descendants(root: Renderable): Renderable[] {
  return root.getChildren().flatMap((child) => [child, ...descendants(child)]);
}

// One pair of styles belongs to the panel, not to every message in a long transcript.
export function updateTranscriptMarkdownStyles(syntax: SyntaxStyle, styles: UiStyles, thinking: boolean): void {
  const thought = syntaxDefinition(styles["transcript.thinking"]);
  // Token backgrounds inherit the owner surface; baking terminal-default snapshots into
  // syntax runs would keep an old background after a palette change.
  const register = (name: string, value: StyleDefinitionInput) => syntax.registerStyle(name,
    thinking ? { fg: styles["transcript.thinking"].fg, bold: value.bold ?? false, underline: value.underline ?? false,
      italic: thought.italic ?? false, dim: value.dim ?? false } : value);
  for (const [name, value] of Object.entries(codeStyles(styles))) register(name, value);
  register("markup", syntaxDefinition(styles["syntax.text"]));
  register("conceal", syntaxDefinition(styles["markup.tableBorder"]));
  register("markup.heading", syntaxDefinition(styles["markup.heading"]));
  for (const depth of [1, 2, 3, 4, 5, 6] as const) register(`markup.heading.${depth}`, syntaxDefinition(styles[`markup.heading.${depth}`]));
  register("markup.strong", syntaxDefinition(styles["markup.strong"])); register("markup.italic", syntaxDefinition(styles["markup.italic"]));
  for (const name of ["markup.raw", "markup.raw.block"]) register(name, syntaxDefinition(styles["markup.inlineCode"]));
  for (const name of ["markup.link", "markup.link.url", "markup.link.label"]) register(name, syntaxDefinition(styles["markup.link"]));
}

// Markdown always owns the display. The reader projects native visible text and
// layout into a read-only navigation buffer without exposing Markdown source.
export class TranscriptMarkdown {
  readonly root: MarkdownRenderable;
  private revision = 0;
  private settling: number | undefined;
  private source = "";
  private streaming = true;
  private styles: UiStyles;

  constructor(private readonly renderer: CliRenderer, syntax: SyntaxStyle, private readonly thinking: boolean, private readonly changing: () => void, private readonly notice: (message: string) => void) {
    const theme = uiTheme(renderer); this.styles = theme.styles;
    this.root = new MarkdownRenderable(renderer, { width: "100%", minWidth: 0, minHeight: 1, flexShrink: 0,
      syntaxStyle: syntax, streaming: true, conceal: true, concealCode: false, internalBlockMode: "top-level",
      tableOptions: { style: "grid", widthMode: "content", wrapMode: "word", cellPaddingX: 1, cellPaddingY: 0 },
      renderNode: (token, context) => {
        if (token.type !== "table") return undefined;
        const original = context.defaultRender();
        if (!(original instanceof TextTableRenderable)) return original;
        const selection = theme.styles["transcript.selection"];
        const table = new TranscriptTable(renderer, { width: "100%", flexShrink: 0, content: original.content, selectable: original.selectable,
          columnWidthMode: original.columnWidthMode, columnFitter: original.columnFitter, wrapMode: original.wrapMode,
          cellPaddingX: original.cellPaddingX, cellPaddingY: original.cellPaddingY, columnGap: original.columnGap,
          showBorders: original.showBorders, border: original.border, outerBorder: original.outerBorder,
          borderStyle: original.borderStyle, borderColor: original.borderColor, fg: original.fg,
          ...(selection.bg ? { selectionBg: selection.bg } : {}), selectionFg: selection.fg });
        original.destroyRecursively(); return table;
      },
      renderBefore: () => this.paintLeaves(theme.styles), renderAfter: () => this.settle(),
    });
    this.root.selectable = true;
    this.root.once(RenderableEvents.DESTROYED, () => { this.revision++; });
    theme.bindStyles(this.root, (styles) => {
      this.changing(); this.styles = styles;
      const value = styles[this.thinking ? "transcript.thinking" : "ui.text"];
      this.root.fg = value.fg; this.root.bg = value.bg;
      this.root.tableOptions = { ...this.root.tableOptions, borderColor: styles[this.thinking ? "transcript.thinking" : "markup.tableBorder"].fg };
      this.root.refreshStyles();
    });
  }

  update(source: string, streaming: boolean): void {
    if (this.root.isDestroyed || source === this.source && streaming === this.streaming) return;
    this.changing(); this.source = source; this.streaming = streaming; this.revision++; this.settling = undefined;
    // Native incremental inline styling paints immediately while bundled grammar
    // highlighting warms up; completed messages must not start as blank blocks.
    this.root.streaming = true; this.root.content = source; this.paintLeaves(this.styles);
  }

  read(body: TranscriptBody): boolean {
    return body.project(this.renderer, this.root,
      descendants(this.root).filter((node): node is TextBufferRenderable | TranscriptTable => node instanceof TextBufferRenderable || node instanceof TranscriptTable),
      this.source.includes("]") || /https?:/iu.test(this.source), this.source);
  }

  private paintLeaves(styles: UiStyles): void {
    for (const child of descendants(this.root)) if (child instanceof TextBufferRenderable) {
      child.attributes = this.thinking ? styles["transcript.thinking"].attributes : styles["ui.text"].attributes;
      child.selectionBg = styles["transcript.selection"].bg; child.selectionFg = styles["transcript.selection"].fg;
      if (this.thinking) child.fg = styles["transcript.thinking"].fg;
      if (child instanceof CodeRenderable) {
        child.wrapMode = "word";
        // Fenced contents are already plain code, so paint them before syntax highlighting settles.
        if (child.filetype !== "markdown") child.drawUnstyledText = true;
      }
    }
  }

  private settle(): void {
    if (this.streaming || !this.root.streaming || this.settling === this.revision) return;
    const revision = this.settling = this.revision;
    // Code highlight work begins in the native lifecycle pass, before this
    // after-paint hook. Finalize only the same completed revision afterward.
    const highlights = descendants(this.root).filter((child): child is CodeRenderable => child instanceof CodeRenderable).map((child) => child.highlightingDone);
    void Promise.all(highlights).then(() => {
      if (this.root.isDestroyed || revision !== this.revision) return;
      this.changing(); this.root.streaming = false;
    }).catch((error: unknown) => {
      if (!this.root.isDestroyed && revision === this.revision) this.notice(reportUnexpected(error, "transcript markdown"));
    });
  }
}
