import { expect, test } from "bun:test";
import { Terminal } from "@xterm/headless";
import { terminalLinks } from "./links.ts";

async function write(screen: Terminal, text: string): Promise<void> {
  await new Promise<void>((resolve) => screen.write(text, resolve));
}

test("Link cells follow terminal widths after Unicode and exclude sentence punctuation", async () => {
  // Wide and combining prefixes have different cell and UTF-16 lengths.
  const screen = new Terminal({ cols: 80, rows: 2, allowProposedApi: true });
  try {
    await write(screen, "한글 é https://example.invalid/a_(b). http://localhost:3000");

    // Resolve literal output rather than treating it as Markdown or ANSI source.
    const links = terminalLinks(screen);

    // Delimiters and trailing punctuation are not clickable URL cells.
    expect(links).toEqual([
      { url: "https://example.invalid/a_(b)", cells: [{ row: 0, start: 7, end: 36 }] },
      { url: "http://localhost:3000", cells: [{ row: 0, start: 38, end: 59 }] },
    ]);
  } finally {
    screen.dispose();
  }
});

test("Wrapped URLs retain complete targets even when both ends are outside the viewport", async () => {
  // A small viewport exposes only the middle of one long logical line.
  const screen = new Terminal({ cols: 12, rows: 2, scrollback: 20, allowProposedApi: true });
  const url = "https://example.invalid/" + "segment/".repeat(8);
  try {
    await write(screen, url);
    screen.scrollToLine(2);

    // Inspect the scrolled screen without changing its execution cursor or viewport.
    const before = screen.buffer.active.viewportY;
    const links = terminalLinks(screen);

    // Both visible row fragments open the original URL, not a truncated address.
    expect(links).toEqual([
      {
        url,
        cells: [
          { row: 0, start: 0, end: 12 },
          { row: 1, start: 0, end: 12 },
        ],
      },
    ]);
    expect(screen.buffer.active.viewportY).toBe(before);
  } finally {
    screen.dispose();
  }
});

test("Hard line breaks keep adjacent URLs separate", async () => {
  // Real newlines are not soft wraps, even when URLs occupy adjacent rows.
  const screen = new Terminal({ cols: 40, rows: 3, allowProposedApi: true });
  try {
    await write(screen, "https://one.invalid\r\nhttp://two.invalid");

    const links = terminalLinks(screen);

    // Each row keeps its own browser target and trailing blank cells stay unlinked.
    expect(links).toEqual([
      { url: "https://one.invalid", cells: [{ row: 0, start: 0, end: 19 }] },
      { url: "http://two.invalid", cells: [{ row: 1, start: 0, end: 18 }] },
    ]);
  } finally {
    screen.dispose();
  }
});

test("Alternate-screen links never expose hidden shell output", async () => {
  // Full-screen jobs replace the primary screen but retain its scrollback internally.
  const screen = new Terminal({ cols: 40, rows: 2, scrollback: 20, allowProposedApi: true });
  try {
    await write(screen, "https://hidden.invalid\x1b[?1049h\x1b[Hhttp://localhost:3000");

    const links = terminalLinks(screen);

    // Only the currently displayed program supplies clickable cells.
    expect(links).toEqual([
      { url: "http://localhost:3000", cells: [{ row: 0, start: 0, end: 21 }] },
    ]);
  } finally {
    screen.dispose();
  }
});
