import type { Terminal } from "@xterm/headless";
import { textLinks } from "../../text-links.ts";
import type { TerminalLink } from "../protocol.ts";

// Resolve complete logical URLs before clipping to the visible cells. The first
// or last visible row can be in the middle of a link retained in scrollback.
export function terminalLinks(screen: Terminal): TerminalLink[] {
  const buffer = screen.buffer.active,
    top = buffer.viewportY,
    bottom = top + screen.rows;
  const links: TerminalLink[] = [];
  let first = top;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  const reusable = buffer.getNullCell();
  while (first < bottom) {
    let text = "",
      next = first;
    const cells: { row: number; column: number; width: number; start: number; end: number }[] = [];
    do {
      const line = buffer.getLine(next);
      if (!line) break;
      for (let column = 0; column < line.length; column++) {
        const cell = line.getCell(column, reusable);
        if (!cell || cell.getWidth() === 0) continue;
        const start = text.length;
        text += cell.getChars() || " ";
        if (next >= top && next < bottom && column + cell.getWidth() <= screen.cols) {
          cells.push({ row: next - top, column, width: cell.getWidth(), start, end: text.length });
        }
      }
      next++;
    } while (buffer.getLine(next)?.isWrapped);
    // Most terminal rows contain no URL; avoid running the rich-text detector there.
    if (/https?:\/\//iu.test(text)) {
      let index = 0;
      for (const range of textLinks(text)) {
        const spans: TerminalLink["cells"] = [];
        while (cells[index] && cells[index]!.end <= range.start) index++;
        while (cells[index] && cells[index]!.start < range.end) {
          const cell = cells[index++]!,
            previous = spans.at(-1);
          if (previous && previous.row === cell.row && previous.end === cell.column)
            previous.end += cell.width;
          else spans.push({ row: cell.row, start: cell.column, end: cell.column + cell.width });
        }
        // Send a long wrapped target once, rather than once per visible row.
        if (spans.length) links.push({ url: range.url, cells: spans });
      }
    }
    if (next === first) break;
    first = next;
  }
  return links;
}
