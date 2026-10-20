import { CodeRenderable, MarkdownRenderable, RenderableEvents, SyntaxStyle, TextAttributes, TextBufferRenderable, type CliRenderer, type Renderable, type StyleDefinitionInput } from "@opentui/core";
import { reportUnexpected } from "../../errors.ts";
import { uiTheme, type UiColors } from "../../ui/theme.ts";
import { transcriptThinkingColor } from "./transcript-style.ts";

function descendants(root: Renderable): Renderable[] {
  return root.getChildren().flatMap((child) => [child, ...descendants(child)]);
}

// One pair of styles belongs to the panel, not to every message in a long transcript.
export function updateTranscriptMarkdownStyles(syntax: SyntaxStyle, colors: UiColors, thinking: boolean): void {
  const fg = thinking ? transcriptThinkingColor(colors) : colors.text;
  const base = { fg, italic: thinking };
  const register = (name: string, style: StyleDefinitionInput = {}) => syntax.registerStyle(name, { ...base, ...style });
  register("default"); register("markup"); register("conceal", { fg: thinking ? fg : colors.muted });
  register("markup.heading", { bold: true });
  for (let depth = 1; depth <= 6; depth++) register(`markup.heading.${depth}`, { bold: true });
  register("markup.strong", { bold: true }); register("markup.italic", { italic: true });
  for (const name of ["markup.raw", "markup.raw.block", "markup.link", "markup.link.url", "markup.link.label"]) {
    register(name, { fg: thinking ? fg : colors.info, ...(name.startsWith("markup.link") ? { underline: true } : {}) });
  }
  for (const [name, color] of [["keyword", colors.keyword], ["string", colors.success], ["number", colors.number], ["comment", colors.muted]] as const) {
    register(name, { fg: thinking ? fg : color });
  }
}

// Markdown owns the display only. The panel retains a separate read-only source
// buffer for exact Vim cursor offsets, logical-line selection and raw copying.
export class TranscriptMarkdown {
  readonly root: MarkdownRenderable;
  private revision = 0;
  private settling: number | undefined;
  private source = "";
  private streaming = true;
  private colors: UiColors;

  constructor(renderer: CliRenderer, syntax: SyntaxStyle, private readonly thinking: boolean, private readonly changing: () => void, private readonly notice: (message: string) => void) {
    const theme = uiTheme(renderer); this.colors = theme.colors;
    this.root = new MarkdownRenderable(renderer, { width: "100%", minWidth: 0, minHeight: 1, flexShrink: 0,
      syntaxStyle: syntax, streaming: true, conceal: true, concealCode: false, internalBlockMode: "top-level",
      tableOptions: { style: "grid", widthMode: "content", wrapMode: "word", cellPaddingX: 1, cellPaddingY: 0 },
      renderBefore: () => this.paintLeaves(theme.colors), renderAfter: () => this.settle(),
    });
    this.root.once(RenderableEvents.DESTROYED, () => { this.revision++; });
    theme.bind(this.root, (colors) => {
      this.changing(); this.colors = colors;
      this.root.fg = this.thinking ? transcriptThinkingColor(colors) : colors.text;
      this.root.bg = colors.panel; this.root.refreshStyles();
    });
  }

  update(source: string, streaming: boolean): void {
    if (this.root.isDestroyed || source === this.source && streaming === this.streaming) return;
    this.changing(); this.source = source; this.streaming = streaming; this.revision++; this.settling = undefined;
    // Native incremental inline styling paints immediately while bundled grammar
    // highlighting warms up; completed messages must not start as blank blocks.
    this.root.streaming = true; this.root.content = source; this.paintLeaves(this.colors);
  }

  private paintLeaves(colors: UiColors): void {
    for (const child of descendants(this.root)) if (child instanceof TextBufferRenderable) {
      child.attributes = this.thinking ? TextAttributes.ITALIC : TextAttributes.NONE;
      if (this.thinking) child.fg = transcriptThinkingColor(colors);
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
