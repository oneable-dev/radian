import {
  BorderChars,
  CodeRenderable,
  EditBufferRenderable,
  OptimizedBuffer,
  TextBuffer,
  TextBufferView,
  TextBufferRenderable,
  TextTableRenderable,
  getLinkId,
  type CapturedLine,
  type CliRenderer,
  type KeyEvent,
  type PasteEvent,
  type Renderable,
  type VisualCursor,
} from "@opentui/core";

type DisplayRow = { start: number; end: number; x: number; y: number };

type DisplayLink = { start: number; end: number; url: string };

type Projection = { text: string; rows: DisplayRow[]; links: DisplayLink[]; signature: string };

// Expose the native table raster, rather than reimplementing its layout or Markdown styling.
export class TranscriptTable extends TextTableRenderable {
  private painted = false;
  private cellProjection: { key: string; value: { text: string; rows: DisplayRow[] } } | undefined;

  get rasterReady(): boolean {
    // Off-screen tables may not receive a paint hook. Their owned raster can be
    // prepared with the same native table implementation after layout is known.
    if (!this.painted && this.width > 0 && this.height > 0) {
      if (!this.frameBuffer) {
        this.createFrameBuffer();
      }
      if (this.frameBuffer) {
        super.renderSelf(this.frameBuffer);
        this.painted = true;
      }
    }

    return this.painted;
  }

  protected onResize(width: number, height: number): void {
    this.painted = false;
    super.onResize(width, height);
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    super.renderSelf(buffer);
    this.painted = true;
  }

  get lines(): CapturedLine[] {
    return this.frameBuffer?.getSpanLines() ?? [];
  }

  drawToBuffer(buffer: OptimizedBuffer, x: number, y: number): void {
    if (this.frameBuffer) {
      buffer.drawFrameBuffer(x, y, this.frameBuffer);
    }
  }

  readCells(
    body: TranscriptBody,
    renderer: CliRenderer,
  ): { text: string; rows: DisplayRow[] } | undefined {
    const key = JSON.stringify([
      this.width,
      this.height,
      this.cellPaddingX,
      this.cellPaddingY,
      this.wrapMode,
      this.content.map((row) => row.map((cell) => cell?.map((chunk) => chunk.text).join("") ?? "")),
    ]);
    if (key === this.cellProjection?.key) {
      return this.cellProjection.value;
    }

    const lines = this.lines.map((line) => line.spans.map((span) => span.text).join(""));
    const chars = BorderChars[this.borderStyle];
    const columns: number[] = [];
    const boundaries: number[] = [];
    let x = 0;
    for (const char of lines[0] ?? "") {
      if ([chars.topLeft, chars.topT, chars.topRight].includes(char)) {
        columns.push(x);
      }

      x += body.editBuffer.measureText(char);
    }
    for (let y = 0; y < lines.length; y++) {
      if (
        [chars.topLeft, chars.leftT, chars.bottomLeft].some((char) => lines[y]!.startsWith(char))
      ) {
        boundaries.push(y);
      }
    }
    if (columns.length < 2 || boundaries.length < 2) {
      return undefined;
    }

    const buffer = TextBuffer.create(renderer.widthMethod, renderer.nativeScene!);
    const view = TextBufferView.create(buffer);
    const rows: DisplayRow[] = [];
    let text = "";
    let offset = 0;
    let column = 0;
    try {
      view.setWrapMode(this.wrapMode);
      for (let row = 0; row < this.content.length; row++) {
        if (row) {
          text += "\n";
          offset++;
          column = 0;
        }
        for (let col = 0; col < this.content[row]!.length; col++) {
          if (col) {
            const cells = body.editBuffer.getTabWidth() - (column % body.editBuffer.getTabWidth());
            text += "\t";
            offset += cells;
            column += cells;
          }

          const cell = this.content[row]![col]?.map((chunk) => chunk.text).join("") ?? "";
          const left = columns[col];
          const right = columns[col + 1];
          const top = boundaries[row];
          const bottom = boundaries[row + 1];
          if (
            left === undefined ||
            right === undefined ||
            top === undefined ||
            bottom === undefined
          ) {
            continue;
          }

          buffer.setText(cell);
          view.setViewport(
            0,
            0,
            Math.max(1, right - left - 1 - this.cellPaddingX * 2),
            Math.max(1, bottom - top - 1 - this.cellPaddingY * 2),
          );

          const info = view.lineInfo;
          for (let index = 0; index < info.lineStartCols.length; index++) {
            const start = offset + info.lineStartCols[index]!;
            rows.push({
              start,
              end: start + info.lineWidthCols[index]!,
              x: left + 1 + this.cellPaddingX,
              y: top + 1 + this.cellPaddingY + index,
            });
          }

          text += cell;
          offset += body.editBuffer.measureText(cell);
          column = cell.includes("\n")
            ? body.editBuffer.measureText(cell.split("\n").at(-1)!)
            : column + body.editBuffer.measureText(cell);
        }
      }
    } finally {
      view.destroy();
      buffer.destroy();
    }

    const value = { text, rows };
    this.cellProjection = { key, value };

    return value;
  }
}

// Native editing resources own grapheme/word/logical-line movement, but never edit
// the conversation. In formatted mode only Markdown paints; this node owns focus
// and navigation over its visible text, with a projection back to native layout.
export class TranscriptBody extends EditBufferRenderable {
  private projection: Projection | undefined;
  private projectionSource = "";
  private revision = 0;

  get displayRevision(): number {
    return this.revision;
  }

  private verticalGoal: { offset: number; column: number } | undefined;

  resetVerticalGoal(): void {
    this.verticalGoal = undefined;
  }

  get formatted(): boolean {
    return this.projection !== undefined;
  }

  handleKeyPress(_key: KeyEvent): boolean {
    return true;
  }

  handlePaste(_event: PasteEvent): void {}

  blur(): void {
    if (!this.focused) {
      return;
    }

    super.blur();
    // Formatted readers position a session cursor outside native editor painting.
    if (this.formatted) {
      this.ctx.setCursorPosition(0, 0, false);
    }
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    if (!this.projection) {
      super.renderSelf(buffer);
    }
  }

  clearProjection(): void {
    this.projection = undefined;
    this.showCursor = true;
    this.selectable = true;
  }

  get visualCursor(): VisualCursor {
    const cursor = super.visualCursor;
    const point = this.pointAt(cursor.offset);

    return point ? { ...cursor, visualRow: point.y, visualCol: point.x } : cursor;
  }

  pointAt(offset: number): { x: number; y: number } | undefined {
    const rows = this.projection?.rows;
    if (!rows?.length) {
      return undefined;
    }

    let target = rows[0]!;
    for (const row of rows) {
      if (row.start > offset) {
        break;
      }

      target = row;
      if (offset < row.end) {
        break;
      }
    }

    return {
      x: Math.min(
        Math.max(0, this.width - 1),
        target.x + Math.max(0, Math.min(target.end - target.start, offset - target.start)),
      ),
      y: target.y,
    };
  }

  linkAtCursor(): string | null {
    return (
      this.projection?.links.find(
        (link) => this.cursorOffset >= link.start && this.cursorOffset < link.end,
      )?.url ?? null
    );
  }

  moveCursorUp(options?: { select?: boolean }): boolean {
    return this.projection ? this.moveRendered(-1) : super.moveCursorUp(options);
  }

  moveCursorDown(options?: { select?: boolean }): boolean {
    return this.projection ? this.moveRendered(1) : super.moveCursorDown(options);
  }

  private moveRendered(direction: -1 | 1): boolean {
    const logical = this.logicalCursor;
    if (
      direction < 0 &&
      this.projection!.text.endsWith("\n") &&
      logical.row === this.lineCount - 1 &&
      logical.col === 0
    ) {
      this.setCursor(Math.max(0, logical.row - 1), 0);

      return true;
    }

    const rows = this.projection!.rows;
    const point = this.pointAt(this.cursorOffset);
    if (!point || !rows.length) {
      return false;
    }

    const column =
      this.verticalGoal?.offset === this.cursorOffset ? this.verticalGoal.column : point.x;
    const ys = [...new Set(rows.map((row) => row.y))];
    const index = ys.indexOf(point.y);
    const y = ys[Math.max(0, Math.min(ys.length - 1, index + direction))]!;
    const candidates = rows.filter((row) => row.y === y);
    const target =
      candidates.find((row) => column >= row.x && column < row.x + row.end - row.start) ??
      candidates.find((row) => row.x > column) ??
      candidates.at(-1)!;
    const before = this.cursorOffset;

    this.cursorOffset =
      target.start + Math.max(0, Math.min(target.end - target.start, column - target.x));
    this.verticalGoal = { offset: this.cursorOffset, column };

    return before !== this.cursorOffset;
  }

  project(
    renderer: CliRenderer,
    root: Renderable,
    leaves: readonly (TextBufferRenderable | TranscriptTable)[],
    captureLinks: boolean,
    source: string,
  ): boolean {
    if (!this.projection) {
      this.projection = { text: "", rows: [], links: [], signature: "" };
    }

    this.showCursor = false;
    this.selectable = false;
    if (
      root.width < 1 ||
      root.height < 1 ||
      leaves.some((node) => node instanceof TranscriptTable && !node.rasterReady)
    ) {
      return false;
    }

    const visible = leaves.filter((node) => node.visible && node.width > 0 && node.height > 0);
    const signature = JSON.stringify([
      root.width,
      root.height,
      visible.map((node) => [
        node.num,
        node.x - root.x,
        node.y - root.y,
        node.width,
        node.height,
        node instanceof CodeRenderable && node.isHighlighting,
      ]),
    ]);
    if (signature === this.projection.signature && source === this.projectionSource) {
      return false;
    }

    const parts = visible
      .map((node) => {
        const table = node instanceof TranscriptTable ? node.readCells(this, renderer) : undefined;

        return {
          node,
          x: node.x - root.x,
          y: node.y - root.y,
          width: node.width,
          height: node.height,
          text:
            table?.text ??
            (node instanceof TranscriptTable
              ? node.lines
                  .map((line) =>
                    line.spans
                      .map((span) => span.text)
                      .join("")
                      .trimEnd(),
                  )
                  .join("\n")
              : node.plainText),
          tableRows: table?.rows,
          info: node instanceof TextBufferRenderable ? node.lineInfo : undefined,
        };
      })
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const rows: DisplayRow[] = [];
    let text = "";
    let bottom = 0;
    let lastY = -1;
    let column = 0;
    let offset = 0;
    for (const part of parts) {
      if (part.y !== lastY) {
        const breaks = text ? Math.max(1, part.y - bottom + 1) : part.y;
        for (let index = text ? 1 : 0; index < breaks; index++) {
          rows.push({
            start: offset + index,
            end: offset + index,
            x: 0,
            y: text ? bottom + index - 1 : index,
          });
        }

        text += "\n".repeat(breaks);
        offset += breaks;
        column = 0;
      }

      const indent = part.tableRows ? 0 : Math.max(0, part.x - column);
      text += " ".repeat(indent);
      offset += indent;

      const base = offset;
      const lines = part.text.split("\n");
      const lineOffsets = [0];
      for (const line of lines) {
        lineOffsets.push(lineOffsets.at(-1)! + this.editBuffer.measureText(line) + 1);
      }

      text += part.text;
      offset += this.editBuffer.measureText(part.text);
      if (part.tableRows) {
        for (const row of part.tableRows) {
          rows.push({
            start: base + row.start,
            end: base + row.end,
            x: part.x + row.x,
            y: part.y + row.y,
          });
        }
      } else if (part.info) {
        for (let index = 0; index < part.info.lineStartCols.length; index++) {
          const start = base + part.info.lineStartCols[index]!;
          rows.push({
            start,
            end: start + part.info.lineWidthCols[index]!,
            x: part.x,
            y: part.y + index,
          });
        }
      } else {
        for (let index = 0; index < lines.length; index++) {
          const start = base + lineOffsets[index]!;
          rows.push({
            start,
            end: start + this.editBuffer.measureText(lines[index]!),
            x: part.x,
            y: part.y + index,
          });
        }
      }

      lastY = part.y;
      bottom = Math.max(bottom, part.y + part.height);
      column = part.x + this.editBuffer.measureText(lines.at(-1)!);
    }

    // Keep literal trailing whitespace/newlines when formatting did not change the text.
    const normalized = source.replaceAll("\r\n", "\n");
    if (normalized.startsWith(text) && !normalized.slice(text.length).trim()) {
      text = normalized;
    }

    // Capture native hyperlink metadata, including concealed labels and table cells.
    // The scratch raster is temporary and never substitutes for the Markdown display.
    const links: DisplayLink[] = [];
    if (captureLinks) {
      // Bound temporary native storage independently of the document's length.
      const raster = OptimizedBuffer.create(
        root.width,
        Math.min(128, root.height),
        renderer.widthMethod,
        { owner: renderer.nativeScene! },
      );
      const ordered = [...rows].sort((a, b) => a.y - b.y || a.x - b.x);
      let index = 0;
      try {
        for (let top = 0; top < root.height; top += raster.height) {
          const bottom = top + raster.height;
          raster.clear();
          for (const part of parts) {
            if (part.y < bottom && part.y + part.height > top) {
              part.node.drawToBuffer(raster, part.x, part.y - top);
            }
          }

          // Display spans omit hyperlink IDs. Borrow the checked attribute plane
          // synchronously, without retaining or modifying native arrays.
          raster.withBuffers((cells) => {
            while (index < ordered.length && ordered[index]!.y < bottom) {
              const row = ordered[index++]!;
              const y = row.y - top;
              if (y < 0) {
                continue;
              }

              const last = Math.min(cells.width, row.x + row.end - row.start);
              for (let x = Math.max(0, row.x); x < last;) {
                const id = getLinkId(cells.attributes[y * cells.width + x]!);
                let end = x + 1;
                while (end < last && getLinkId(cells.attributes[y * cells.width + end]!) === id) {
                  end++;
                }
                if (id) {
                  links.push({
                    start: row.start + x - row.x,
                    end: row.start + end - row.x,
                    url: raster.lib.contextGetLinkUrl(
                      renderer.nativeScene!.resourceContext.context,
                      id,
                    ),
                  });
                }

                x = end;
              }
            }
          });
        }
      } finally {
        raster.destroy();
      }
    }

    const cursor = this.cursorOffset;
    this.resetVerticalGoal();
    this.projection = { text, rows, links, signature };
    this.projectionSource = source;
    this.revision++;
    if (this.plainText !== text) {
      this.setText(text);
      this.cursorOffset = cursor;
    }

    this.showCursor = false;
    this.selectable = false;

    return true;
  }
}
