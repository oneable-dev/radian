import type { IBufferCell, Terminal } from "@xterm/headless";

function style(cell: IBufferCell): string {
  const codes = [0];
  for (const [enabled, code] of [[cell.isBold(), 1], [cell.isDim(), 2], [cell.isItalic(), 3], [cell.isUnderline(), 4],
    [cell.isBlink(), 5], [cell.isInverse(), 7], [cell.isInvisible(), 8], [cell.isStrikethrough(), 9], [cell.isOverline(), 53]]) {
    if (enabled && code !== undefined) codes.push(code);
  }
  const color = (value: number, rgb: boolean, palette: boolean, foreground: boolean) => {
    const channel = foreground ? 38 : 48;
    if (rgb) codes.push(channel, 2, value >> 16 & 255, value >> 8 & 255, value & 255);
    else if (palette) codes.push(channel, 5, value);
  };
  color(cell.getFgColor(), cell.isFgRGB(), cell.isFgPalette(), true);
  color(cell.getBgColor(), cell.isBgRGB(), cell.isBgPalette(), false);
  return `\x1b[${codes.join(";")}m`;
}

// Serialize only visible cells. xterm's buffers can retain wider hidden rows after a
// shrink; serializing line.length instead of cols wraps those cells and loses row 1.
// Every frame is complete, so the client never needs hidden buffers or scrollback.
export function terminalScreen(screen: Terminal): string {
  const buffer = screen.buffer.active;
  let output = `\x1bc${buffer.type === "alternate" ? "\x1b[?1049h" : ""}\x1b[?7l`;
  let previousStyle = "";
  let emptyCells = 0;
  const flushEmpty = () => {
    if (emptyCells) { output += `\x1b[${emptyCells}X\x1b[${emptyCells}C`; emptyCells = 0; }
  };
  const reusable = buffer.getNullCell();
  for (let row = 0; row < screen.rows; row++) {
    output += `\x1b[${row + 1};1H`;
    const line = buffer.getLine(buffer.viewportY + row);
    for (let column = 0; column < screen.cols; column++) {
      const cell = line?.getCell(column, reusable);
      if (!cell) { emptyCells++; continue; }
      if (cell.getWidth() === 0) continue;
      const nextStyle = style(cell);
      if (nextStyle !== previousStyle) { flushEmpty(); output += nextStyle; previousStyle = nextStyle; }
      const text = column + cell.getWidth() <= screen.cols ? cell.getChars() : "";
      if (text) { flushEmpty(); output += text; } else emptyCells++;
    }
    flushEmpty();
  }
  output += `\x1b[0m\x1b[${buffer.cursorY + 1};${Math.min(screen.cols - 1, buffer.cursorX) + 1}H`;
  const modes = screen.modes;
  for (const [enabled, mode] of [[modes.applicationCursorKeysMode, 1], [modes.applicationKeypadMode, 66],
    [modes.bracketedPasteMode, 2004], [modes.originMode, 6], [modes.reverseWraparoundMode, 45],
    [modes.sendFocusMode, 1004], [modes.wraparoundMode, 7]]) {
    if (enabled) output += `\x1b[?${mode}h`;
  }
  if (modes.insertMode) output += "\x1b[4h";
  const mouseMode = { none: 0, x10: 9, vt200: 1000, drag: 1002, any: 1003 }[modes.mouseTrackingMode];
  if (mouseMode) output += `\x1b[?${mouseMode}h`;
  return output;
}
