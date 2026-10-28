import { expect, test } from "bun:test";
import { ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { uiTheme } from "../../ui/theme.ts";
import { PendingMessages } from "./pending-messages.ts";

async function mount(width = 120, key = "<Esc>") {
  const app = await createTestRenderer({ width, height: 8 });
  const pending = new PendingMessages(app.renderer, () => key);

  app.renderer.root.add(pending.root);

  const render = async () => {
    await app.renderOnce();
    await app.renderOnce();
  };
  const rows = () =>
    app
      .captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd());

  return {
    ...app,
    pending,
    render,
    rows,
    async close() {
      await app.dispose();
    },
  };
}

test("Hints and interrupt help stay on one line across resize while message order and indentation persist", async () => {
  // Wide layouts explain delivery timing; narrow layouts shorten prose but retain shortcuts.
  const app = await mount();
  const messages = [
    { text: "First message", images: 0, files: 0 },
    { text: "Second message", images: 0, files: 0 },
  ];
  try {
    app.pending.update(messages, true, 4);
    await app.render();
    for (const [width, heading] of [
      [
        120,
        "• Messages will be sent after the current response and tools finish (press <Esc> to interrupt and send immediately)",
      ],
      [78, "• Messages waiting to be sent (press <Esc> to interrupt and send immediately)"],
      [76, "• Messages waiting (<Esc>: interrupt & send)"],
      [44, "• Messages waiting (<Esc>: interrupt & send)"],
      [
        120,
        "• Messages will be sent after the current response and tools finish (press <Esc> to interrupt and send immediately)",
      ],
    ] as const) {
      // Resize refreshes hints to the current width without new queued-message data.
      app.resize(width, 8);
      await app.render();

      // Both messages follow the hint; reserve the final row for input.
      expect(app.rows().slice(0, 4)).toEqual([
        heading,
        "  ↳ First message",
        "  ↳ Second message",
        "",
      ]);
      expect(app.pending.rows).toBe(4);
    }
  } finally {
    await app.close();
  }
});

test("Queued hints and messages use normal text while help/connectors dim and only configured interrupt keys highlight", async () => {
  // User overrides follow the same hint and highlighting policy as default Esc.
  const app = await mount(130, "<C-x>");
  try {
    app.pending.update([{ text: "Review changes", images: 0, files: 0 }], true, 3);
    await app.render();

    // Verify title, help, and connector contrast through actual rendered terminal spans.
    const colors = uiTheme(app.renderer).colors;
    const lines = app.captureSpans().lines;
    const heading = lines[0]!.spans;
    const message = lines[1]!.spans;

    expect(app.rows()[0]).toEndWith("(press <C-x> to interrupt and send immediately)");
    expect(heading.find((span) => span.text.includes("Messages"))!.fg.toInts()).toEqual(
      colors.text.toInts(),
    );
    expect(heading.find((span) => span.text.includes("to interrupt"))!.fg.toInts()).toEqual(
      colors.muted.toInts(),
    );
    expect(message.find((span) => span.text.includes("↳"))!.fg.toInts()).toEqual(
      colors.muted.toInts(),
    );
    expect(message.find((span) => span.text.includes("Review changes"))!.fg.toInts()).toEqual(
      colors.text.toInts(),
    );
    expect(
      heading.filter((span) => span.attributes & TextAttributes.BOLD).map((span) => span.text),
    ).toEqual(["<C-x>"]);
  } finally {
    await app.close();
  }
});

test("Long indented queued messages preserve attachment badges without changing source or following rows", async () => {
  // Long Korean/emoji attachment requests truncate only visually, preserving runtime text.
  const app = await mount(32);
  const request = { text: "한글👩‍💻 요청\n자세한 설명 ".repeat(8), images: 1, files: 0 };
  const original = request.text;
  try {
    app.pending.update([request], true, 3);
    await app.render();

    // Ellipsis and attachment badges fit after reserving connector width.
    expect(app.rows()[1]).toStartWith("  ↳ 한글👩‍💻");
    expect(app.rows()[1]).toEndWith("…  [1 image]");
    expect(Bun.stringWidth(app.rows()[1]!)).toBeLessThanOrEqual(32);
    expect(app.rows()[2]).toBe("");
    expect(request.text).toBe(original);
  } finally {
    await app.close();
  }
});

test("Queued-list scrollbars never obscure attachment badges or connectors", async () => {
  // Many queued messages reduce usable width by the scrollbar width.
  const app = await mount(32);
  const request = { text: "A long queued request ".repeat(8), images: 1, files: 0 };
  try {
    app.pending.update(
      Array.from({ length: 20 }, () => request),
      true,
      4,
    );
    await app.render();

    const list = app.renderer.root.findDescendantById("agent-pending-list");
    if (!(list instanceof ScrollBoxRenderable)) {
      throw new Error("Missing pending list");
    }

    // Truncate within the viewport excluding scrollbars, not the full container width.
    const row = app
      .rows()
      [list.viewport.y]!.slice(list.viewport.x, list.viewport.x + list.viewport.width)
      .trimEnd();
    expect(list.viewport.width).toBeLessThan(32);
    expect(row).toStartWith("  ↳ ");
    expect(row).toEndWith("…  [1 image]");
    expect(Bun.stringWidth(row)).toBeLessThanOrEqual(list.viewport.width);
  } finally {
    await app.close();
  }
});

test.each([0, 1, 2, 3])(
  "Queued hints and messages stay within a %i-row height budget",
  async (maximumRows) => {
    // Queued lists must not consume rows allocated to input in small terminals.
    const app = await mount();
    try {
      app.pending.update([{ text: "Waiting message", images: 0, files: 0 }], true, maximumRows);
      await app.render();

      // Even two rows show title then message without a separate help row.
      expect(app.pending.rows).toBe(maximumRows);
      if (maximumRows > 0) {
        expect(app.rows()[0]).toStartWith("• Messages");
      }
      if (maximumRows >= 2) {
        expect(app.rows()[1]).toBe("  ↳ Waiting message");
      }

      expect(
        app
          .rows()
          .slice(maximumRows)
          .every((line) => line === ""),
      ).toBe(true);
    } finally {
      await app.close();
    }
  },
);

test("Delivery and hiding remove queued hints and bottom spacing together", async () => {
  // Queue decorations must disappear for empty snapshots or hidden screens.
  const app = await mount();
  const messages = [{ text: "Waiting message", images: 0, files: 0 }];
  try {
    app.pending.update(messages, true, 3);
    await app.render();
    expect(app.rows()[1]).toBe("  ↳ Waiting message");

    // Delivery completion and hiding each collapse the entire list.
    for (const [next, visible] of [
      [[], true],
      [messages, false],
    ] as const) {
      app.pending.update(next, visible, 3);
      await app.render();

      expect(app.pending.rows).toBe(0);
      expect(app.pending.root.visible).toBe(false);
      expect(app.rows().every((line) => line === "")).toBe(true);
    }
  } finally {
    await app.close();
  }
});
