import type { Terminal } from "@xterm/headless";
import type { TerminalText } from "../protocol.ts";

// A copy-mode snapshot is read on demand, never streamed or persisted. Join soft
// wraps so copying a long command does not invent line breaks from terminal width.
export function terminalText(screen: Terminal): TerminalText {
  const buffer = screen.buffer.active;
  const target = buffer.viewportY < buffer.baseY ? buffer.viewportY : buffer.baseY + buffer.cursorY;
  const cursor = { row: 0, column: 0 };
  let text = "";
  let row = 0;
  let column = 0;
  for (let index = 0; index < buffer.length; index++) {
    const line = buffer.getLine(index)!;
    if (index && !line.isWrapped) {
      text += "\n";
      row++;
      column = 0;
    }
    if (index === target) {
      cursor.row = row;
      cursor.column = column + (buffer.viewportY < buffer.baseY ? 0 : buffer.cursorX);
    }

    const continued = buffer.getLine(index + 1)?.isWrapped ?? false;
    text += line.translateToString(!continued);
    column += line.length;
  }

  return { text, cursor };
}
