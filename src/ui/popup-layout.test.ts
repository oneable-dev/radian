import { expect, test } from "bun:test";
import { BoxRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import {
  POPUP_SIZES,
  PopupBody,
  SearchPopupLayout,
  attachPopupActivity,
  centerPopup,
} from "./popup-layout.ts";
import { LoadingSpinner } from "./loading-spinner.ts";
import { PopupFrame } from "./popup-frame.ts";
import { SearchInput } from "./search-input.ts";

test("Empty popup bodies center guidance through resize without replacing the focused viewport", async () => {
  // The viewport must remain the keyboard owner even while it has no candidates.
  const app = await createTestRenderer({ width: 81, height: 21 });
  const list = new ScrollBoxRenderable(app.renderer, { flexGrow: 1, minHeight: 0 });
  const body = new PopupBody(app.renderer, "results", list);

  app.renderer.root.add(body.root);
  try {
    body.showEmpty("No matching results");
    list.focus();

    // Odd cell sizes and compact bodies use the same centered empty-state component.
    for (const [width, height] of [
      [81, 21],
      [120, 30],
      [40, 12],
      [11, 3],
    ] as const) {
      app.resize(width, height);
      await app.renderOnce();
      await app.renderOnce();

      const title = app.renderer.root.findDescendantById("results-empty:title")!;

      // Guidance neither changes focus nor creates scrollable placeholder rows.
      expect(Math.abs(title.x + title.width / 2 - width / 2)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(title.y + title.height / 2 - height / 2)).toBeLessThanOrEqual(0.5);
      expect(app.renderer.currentFocusedRenderable).toBe(list);
      expect(list.getChildren().some((node) => node instanceof TextRenderable)).toBe(false);
    }

    body.showEmpty();
    await app.renderOnce();
    expect(body.empty.root.visible).toBe(false);
  } finally {
    await app.dispose();
  }
});

test.each([
  { status: "absent", rows: 0, visible: false },
  { status: "one-line", rows: 1, visible: true },
  { status: "two-line", rows: 2, visible: true },
  { status: "hidden", rows: 1, visible: false },
])(
  "Search layouts remove the search gap and inset results with $status status",
  async ({ rows, visible }) => {
    // Status and candidates follow search immediately, with one cell of horizontal list padding.
    const app = await createTestRenderer({ width: 120, height: 20 });
    const search = new SearchInput(app.renderer, { id: "search", title: "Search" });
    const list = new ScrollBoxRenderable(app.renderer, { flexGrow: 1, minHeight: 0 });

    list.add(
      new TextRenderable(app.renderer, { content: "First candidate", height: 1, flexShrink: 0 }),
    );

    const message = rows
      ? new TextRenderable(app.renderer, {
          content: "Result status",
          height: rows,
          flexShrink: 0,
          visible,
        })
      : undefined;
    const layout = new SearchPopupLayout(app.renderer, {
      id: "search-layout",
      search,
      list,
      ...(message ? { message } : {}),
    });

    app.renderer.root.add(layout.root);
    try {
      // Narrow terminals and hidden search fields must not duplicate or leave behind spacing.
      for (const [width, height] of [
        [120, 20],
        [60, 12],
      ] as const) {
        app.resize(width, height);
        search.field.visible = true;
        await app.renderOnce();
        await app.renderOnce();

        const next = message?.visible ? message : layout.results.root;
        const nextY = search.field.y + search.field.height;

        expect(next.y).toBe(nextY);
        expect(list.y).toBe(nextY + (visible ? rows : 0));
        expect(list.x).toBe(search.field.x + 1);
        expect(list.width).toBe(search.field.width - 2);
        if (message?.visible) {
          expect(message.x).toBe(list.x);
          expect(message.width).toBe(list.width);
        }

        expect(list.height).toBe(height - search.field.height - (visible ? rows : 0));

        search.field.visible = false;
        await app.renderOnce();
        await app.renderOnce();

        expect(next.y).toBe(layout.root.y);
        expect(list.height).toBe(height - (visible ? rows : 0));
      }
    } finally {
      await app.dispose();
    }
  },
);

test.each([false, true])(
  "Search layouts preserve queries and viewport ownership with preview=%s",
  async (previewEnabled) => {
    // Both popup shapes use the same query/list layout without owning feature commands.
    const app = await createTestRenderer({ width: 140, height: 30 });
    const search = new SearchInput(app.renderer, { id: "search", title: "Search" });
    const list = new ScrollBoxRenderable(app.renderer, { flexGrow: 1, minHeight: 0 });
    const message = new TextRenderable(app.renderer, {
      content: "Results",
      height: 1,
      flexShrink: 0,
    });
    const preview = new PopupBody(
      app.renderer,
      "preview",
      new BoxRenderable(app.renderer, { flexGrow: 1 }),
    );
    const layout = new SearchPopupLayout(app.renderer, {
      id: "search-layout",
      search,
      message,
      list,
      ...(previewEnabled ? { preview: { body: preview, width: 58 } } : {}),
    });

    app.renderer.root.add(layout.root);
    search.value = "hjkl query";
    search.cursorOffset = 4;
    search.focus();
    try {
      // Switching layouts must not reset input or keep a hidden candidate viewport in the layout.
      for (const [width, compactPreview] of [
        [140, false],
        [60, false],
        [60, true],
        [140, false],
      ] as const) {
        app.resize(width, 30);
        layout.resize(width >= 100, compactPreview);
        await app.renderOnce();
        await app.renderOnce();

        expect(search.value).toBe("hjkl query");
        expect(search.cursorOffset).toBe(4);
        expect(app.renderer.currentFocusedRenderable).toBe(search);
        expect(list.visible).toBe(!previewEnabled || width >= 100 || !compactPreview);
        if (previewEnabled) {
          expect(preview.root.visible).toBe(width >= 100 || compactPreview);
          if (preview.root.visible) {
            const content = preview.root.getChildren()[0]!;
            expect(content.x).toBe(preview.root.x + Number(width >= 100));
            expect(content.x + content.width).toBe(preview.root.x + preview.root.width);
          }
          if (width >= 100) {
            expect(preview.root.y).toBe(search.field.y);
            expect(search.field.x + search.field.width).toBe(preview.root.x);
          }
        }

        // Compact preview jumps use the same candidate height as visible lists, without a reserved search gap.
        expect(layout.listHeight).toBe(layout.root.height - search.field.height - message.height);
      }
    } finally {
      if (!previewEnabled) {
        preview.root.destroyRecursively();
      }

      await app.dispose();
    }
  },
);

test("Popup refresh activity stays inside the body without reserving a header or hiding content", async () => {
  // Available content remains usable while a refresh or spinner tail is settling.
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 80, height: 20, clock });
  const panel = new PopupFrame(app.renderer, {
    position: "absolute",
    border: true,
    paddingX: 1,
    title: "Unused popup title",
    bottomTitle: "Unused popup footer",
  });
  const content = new TextRenderable(app.renderer, { content: "First content line", flexGrow: 1 });
  const spinner = new LoadingSpinner(app.renderer, { id: "popup-loading" });

  panel.add(content);
  attachPopupActivity(app.renderer, panel, spinner.root, () => ({
    pending: false,
    hasContent: true,
    message: "Refreshing…",
    body: content,
  }));
  app.renderer.root.add(panel);
  try {
    centerPopup(panel, { width: 60, height: 14 }, 80, 20);
    spinner.start();
    spinner.stop();
    await app.renderOnce();
    await app.renderOnce();

    // Neither border titles nor spinner-only headers take space from the popup body.
    expect(content.y).toBe(panel.y + 1);
    expect(spinner.root.y).toBe(content.y);
    expect(spinner.root.x).toBeGreaterThan(panel.x);
    expect(spinner.root.x).toBeLessThan(panel.x + panel.width - 1);
    expect(app.captureCharFrame()).toContain("First content line");
    expect(app.captureCharFrame()).not.toContain("Unused popup");
    expect(spinner.root.visible).toBe(true);
    clock.advance(500);
    await app.renderOnce();
    expect(spinner.root.visible).toBe(false);
    expect(content.y).toBe(panel.y + 1);
  } finally {
    await app.dispose();
  }
});

test("Popup activity centers empty loads, follows selected rows and immediately reveals ready or failed data", async () => {
  // The same owner handles initial I/O, refresh, selection and its minimum-visible tail.
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 81, height: 21, clock });
  const body = new BoxRenderable(app.renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
  });
  const first = new TextRenderable(app.renderer, { content: "First candidate", height: 1 });
  const selected = new TextRenderable(app.renderer, { content: "Selected candidate", height: 1 });

  body.add(first);
  body.add(selected);

  const spinner = new LoadingSpinner(app.renderer, { id: "activity" });
  let pending = true;
  let hasContent = false;
  const feedback = attachPopupActivity(app.renderer, body, spinner.root, () => ({
    pending,
    hasContent,
    message: "Loading candidates…",
    anchor: selected,
  }));

  app.renderer.root.add(body);
  try {
    first.visible = selected.visible = false;
    spinner.start();
    for (const [width, height] of [
      [81, 21],
      [40, 12],
    ] as const) {
      app.resize(width, height);
      await app.renderOnce();
      await app.renderOnce();
      expect(feedback.x).toBe(Math.floor((width - feedback.width) / 2));
      expect(feedback.y).toBe(Math.floor((height - 1) / 2));
      expect(app.captureCharFrame()).toContain("Loading candidates…");
    }

    // A selected result keeps its own focus and receives only a small activity marker.
    hasContent = true;
    first.visible = selected.visible = true;
    selected.focusable = true;
    selected.focus();
    await app.renderOnce();
    await app.renderOnce();
    expect(spinner.root.y).toBe(selected.y);
    expect(app.captureCharFrame()).not.toContain("Loading candidates…");
    expect(app.captureCharFrame()).toContain("Selected candidate");
    expect(app.renderer.currentFocusedRenderable).toBe(selected);

    // Completion and errors never wait for the animation's minimum interval.
    pending = false;
    selected.content = "Lookup failed";
    spinner.stop();
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("Lookup failed");
    expect(app.captureCharFrame()).not.toContain("Loading candidates…");
    expect(spinner.root.visible).toBe(true);
    clock.advance(500);
    await app.renderOnce();
    expect(feedback.visible).toBe(false);
  } finally {
    spinner.cancel();
    await app.dispose();
  }
});

test("Activity for an offscreen popup body never leaks onto the workbench", async () => {
  // Scrollable details can leave the viewport while their operation or minimum-visible tail continues.
  const app = await createTestRenderer({ width: 60, height: 20 });
  const panel = new PopupFrame(app.renderer, { width: 40, height: 12, border: true });
  const body = new BoxRenderable(app.renderer, {
    position: "absolute",
    top: -20,
    width: 30,
    height: 10,
  });

  panel.add(body);

  const spinner = new LoadingSpinner(app.renderer, { id: "offscreen-loading" });
  const feedback = attachPopupActivity(app.renderer, panel, spinner.root, () => ({
    pending: true,
    hasContent: true,
    message: "Refreshing…",
    body,
  }));

  app.renderer.root.add(panel);
  try {
    spinner.start();
    await app.renderOnce();
    await app.renderOnce();
    expect(feedback.visible).toBe(false);

    // Returning to the popup body reveals the same operation without restarting it or stealing focus.
    body.top = 2;
    await app.renderOnce();
    await app.renderOnce();
    expect(feedback.visible).toBe(true);
    expect(spinner.root.y).toBe(body.y);
  } finally {
    spinner.cancel();
    await app.dispose();
  }
});

test("Large popups use more of ordinary terminals and keep a larger maximum size", async () => {
  // Enlarging only the maximum would leave ordinary terminals stuck at the previous viewport cap.
  const app = await createTestRenderer({ width: 160, height: 32 });
  const panel = new PopupFrame(app.renderer, { position: "absolute", border: false });
  app.renderer.root.add(panel);
  try {
    centerPopup(panel, POPUP_SIZES.expanded, 160, 32);
    await app.renderOnce();
    expect([panel.width, panel.height]).toEqual([144, 25]);

    // Only the large preset gets narrower margins; other preset geometry stays unchanged.
    centerPopup(panel, POPUP_SIZES.large, 160, 32);
    await app.renderOnce();
    expect([panel.x, panel.y, panel.width, panel.height]).toEqual([4, 2, 152, 28]);

    app.resize(320, 90);
    centerPopup(panel, POPUP_SIZES.large, 320, 90);
    await app.renderOnce();
    expect([panel.x, panel.y, panel.width, panel.height]).toEqual([40, 13, 240, 64]);
  } finally {
    await app.dispose();
  }
});

test.each([undefined, false, true])(
  "Popup frames share rounded corners without enabling omitted or false borders: %s",
  async (border) => {
    // A shared border style must not add outer frames back to borderless pickers.
    const app = await createTestRenderer({ width: 60, height: 20 });
    const panel = new PopupFrame(app.renderer, {
      position: "absolute",
      left: 2,
      top: 2,
      width: 20,
      height: 6,
      ...(border === undefined ? {} : { border }),
    });
    app.renderer.root.add(panel);
    try {
      await app.renderOnce();
      expect(panel.border).toBe(border ?? false);
      expect(panel.borderStyle).toBe("rounded");
      if (border) {
        const lines = app.captureCharFrame().split("\n");
        expect(lines[panel.y]!.slice(panel.x, panel.x + panel.width)).toBe(
          "╭" + "─".repeat(18) + "╮",
        );
        expect(lines[panel.y + panel.height - 1]!.slice(panel.x, panel.x + panel.width)).toBe(
          "╰" + "─".repeat(18) + "╯",
        );
      } else {
        expect(app.captureCharFrame()).not.toMatch(/[╭╮╰╯]/u);
      }
    } finally {
      await app.dispose();
    }
  },
);

test.each(Object.entries(POPUP_SIZES))(
  "The %s popup preset fits even a one-cell terminal",
  async (_name, size) => {
    // Minimal terminal dimensions must never produce zero-sized or offscreen popup frames.
    const app = await createTestRenderer({ width: 80, height: 20 });
    const panel = new PopupFrame(app.renderer, { position: "absolute", border: false });

    app.renderer.root.add(panel);
    try {
      for (const [width, height] of [
        [2, 2],
        [1, 1],
        [80, 20],
      ] as const) {
        // Shrink and restore each role using the same sizing path as real popups.
        app.resize(width, height);
        centerPopup(panel, size, width, height);
        await app.renderOnce();

        expect(panel.width).toBeGreaterThanOrEqual(1);
        expect(panel.height).toBeGreaterThanOrEqual(1);
        expect(panel.x).toBeGreaterThanOrEqual(0);
        expect(panel.y).toBeGreaterThanOrEqual(0);
        expect(panel.x + panel.width).toBeLessThanOrEqual(width);
        expect(panel.y + panel.height).toBeLessThanOrEqual(height);
      }
    } finally {
      await app.dispose();
    }
  },
);

test.each([false, true])(
  "Popup color updates preserve explicitly configured borders: %s",
  async (border) => {
    // Theme changes must not recreate outer borders on a borderless popup.
    const app = await createTestRenderer({ width: 60, height: 20 });
    const panel = new PopupFrame(app.renderer, { width: 40, height: 12, border });
    app.renderer.root.add(panel);
    try {
      await app.renderOnce();
      const before = app.captureCharFrame();
      panel.borderColor = "#FF0000";
      panel.focusedBorderColor = "#00FF00";
      await app.renderOnce();

      // Ink changes leave both the requested sides and the cell geometry intact.
      expect(panel.border).toBe(border);
      expect([panel.width, panel.height]).toEqual([40, 12]);
      expect(app.captureCharFrame()).toBe(before);
    } finally {
      await app.dispose();
    }
  },
);

test("Popup placement uses requested dimensions rather than stale native resize geometry", async () => {
  // Native getters still report the last frame when the terminal begins shrinking.
  const app = await createTestRenderer({ width: 140, height: 30 });
  const panel = new PopupFrame(app.renderer, { position: "absolute", border: true });

  app.renderer.root.add(panel);
  try {
    centerPopup(panel, POPUP_SIZES.expanded, 140, 30);
    await app.renderOnce();

    // A compact resize must not move the popup offscreen using its previous larger width.
    app.resize(46, 12);
    centerPopup(panel, POPUP_SIZES.standard, 46, 12);
    await app.renderOnce();

    expect(panel.x).toBe(2);
    expect(panel.y).toBe(1);
    expect(panel.width).toBe(41);
    expect(panel.height).toBe(9);
  } finally {
    await app.dispose();
  }
});
