import { expect, test } from "bun:test";
import { Terminal } from "@xterm/headless";
import { terminalText } from "./text.ts";

async function write(screen: Terminal, text: string): Promise<void> {
  await new Promise<void>((resolve) => screen.write(text, resolve));
}

test("Text snapshots strip ANSI, join soft wraps, and retain actual newlines", async () => {
  // Narrow screens soft-wrap long commands and show wide characters on following rows.
  const screen = new Terminal({ cols: 10, rows: 4, scrollback: 20, allowProposedApi: true });
  try {
    await write(screen, "\x1b[31m0123456789abc\x1b[0m\r\n한글 e\u0301");

    const snapshot = terminalText(screen);

    expect(snapshot.text).toStartWith("0123456789abc\n한글 é");
    expect(snapshot.text).not.toContain("\x1b");
    expect(snapshot.cursor).toEqual({ row: 1, column: 6 });
  } finally {
    screen.dispose();
  }
});

test("Scrollback reads never move actual viewports or execution cursors", async () => {
  // Begin navigation at scrolled viewports while including unseen recent output.
  const screen = new Terminal({ cols: 20, rows: 3, scrollback: 20, allowProposedApi: true });
  try {
    await write(screen, Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\r\n"));
    screen.scrollLines(-4);
    const before = {
      viewport: screen.buffer.active.viewportY,
      row: screen.buffer.active.cursorY,
      col: screen.buffer.active.cursorX,
    };

    const snapshot = terminalText(screen);

    expect(snapshot.text).toStartWith("line 0\n");
    expect(snapshot.text).toEndWith("line 11");
    expect(snapshot.cursor).toEqual({ row: before.viewport, column: 0 });
    expect({
      viewport: screen.buffer.active.viewportY,
      row: screen.buffer.active.cursorY,
      col: screen.buffer.active.cursorX,
    }).toEqual(before);
  } finally {
    screen.dispose();
  }
});

test("Alternate-screen reads expose only current programs, not hidden primary screens", async () => {
  // Copying full-screen programs must not include earlier shell logs.
  const screen = new Terminal({ cols: 20, rows: 3, scrollback: 20, allowProposedApi: true });
  try {
    await write(screen, "SHELL HISTORY\r\n\x1b[?1049h\x1b[HFULL SCREEN");

    const snapshot = terminalText(screen);

    expect(snapshot.text).toStartWith("FULL SCREEN");
    expect(snapshot.text).not.toContain("SHELL HISTORY");
    expect(screen.buffer.active.type).toBe("alternate");
  } finally {
    screen.dispose();
  }
});
