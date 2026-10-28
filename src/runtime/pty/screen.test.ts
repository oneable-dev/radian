import { expect, test } from "bun:test";
import { Terminal } from "@xterm/headless";
import { terminalScreen } from "./screen.ts";

const write = (terminal: Terminal, text: string) =>
  new Promise<void>((resolve) => terminal.write(text, resolve));

test("Narrow screen restoration never emits hidden old cells that shift first rows", async () => {
  // xterm can retain 84-cell backing rows after its visible width shrinks to 64.
  const original = new Terminal({ cols: 84, rows: 24, scrollback: 0, allowProposedApi: true });
  const restored = new Terminal({ cols: 64, rows: 24, scrollback: 0, allowProposedApi: true });
  try {
    await write(original, `\x1b[?1049hfirst-line\x1b[23;1H${"s".repeat(84)}\x1b[1;5H`);
    original.resize(64, 24);

    await write(restored, terminalScreen(original));

    expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe("first-line");
    expect(restored.buffer.active.getLine(22)?.translateToString(true)).toBe("s".repeat(64));
    expect(restored.buffer.active.cursorX).toBe(4);
    expect(restored.buffer.active.cursorY).toBe(0);
  } finally {
    original.dispose();
    restored.dispose();
  }
});

test("Full-screen snapshots preserve wide characters, colors, styles, input modes, and cursor positions", async () => {
  const original = new Terminal({ cols: 40, rows: 8, scrollback: 0, allowProposedApi: true });
  const restored = new Terminal({ cols: 40, rows: 8, scrollback: 0, allowProposedApi: true });
  try {
    await write(
      original,
      "\x1b[?1049h\x1b[1;3;4;38;2;18;52;86;48;5;7m편집🙂\x1b[4;7H\x1b[?1h\x1b[?2004h\x1b[?1002h",
    );

    await write(restored, terminalScreen(original));

    expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe("편집🙂");

    const cell = restored.buffer.active.getLine(0)!.getCell(0)!;
    expect(cell.getFgColor()).toBe(0x123456);
    expect(cell.getBgColor()).toBe(7);
    expect(Boolean(cell.isBold())).toBe(true);
    expect(Boolean(cell.isItalic())).toBe(true);
    expect(Boolean(cell.isUnderline())).toBe(true);
    expect(restored.buffer.active.cursorX).toBe(6);
    expect(restored.buffer.active.cursorY).toBe(3);
    expect(restored.modes.applicationCursorKeysMode).toBe(true);
    expect(restored.modes.bracketedPasteMode).toBe(true);
    expect(restored.modes.mouseTrackingMode).toBe("drag");
  } finally {
    original.dispose();
    restored.dispose();
  }
});
