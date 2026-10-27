import { expect, test } from "bun:test";
import { BoxRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { PopupBody, SearchPopupLayout, attachPopupActivity, centerPopup } from "./popup-layout.ts";
import { LoadingSpinner } from "./loading-spinner.ts";
import { PopupFrame } from "./popup-frame.ts";
import { SearchInput } from "./search-input.ts";

test("Empty popup bodies center guidance through resize without replacing the focused viewport", async () => {
  // The viewport must remain the keyboard owner even while it has no candidates.
  const app = await createTestRenderer({ width: 81, height: 21 });
  const list = new ScrollBoxRenderable(app.renderer, { flexGrow: 1, minHeight: 0 });
  const body = new PopupBody(app.renderer, "results", list); app.renderer.root.add(body.root);
  try {
    body.showEmpty("No matching results"); list.focus();

    // Odd cell sizes and compact bodies use the same centered empty-state component.
    for (const [width, height] of [[81, 21], [120, 30], [40, 12], [11, 3]] as const) {
      app.resize(width, height); await app.renderOnce(); await app.renderOnce();
      const title = app.renderer.root.findDescendantById("results-empty:title")!;

      // Guidance neither changes focus nor creates scrollable placeholder rows.
      expect(Math.abs(title.x + title.width / 2 - width / 2)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(title.y + title.height / 2 - height / 2)).toBeLessThanOrEqual(0.5);
      expect(app.renderer.currentFocusedRenderable).toBe(list);
      expect(list.getChildren().some(node => node instanceof TextRenderable)).toBe(false);
    }
    body.showEmpty(); await app.renderOnce();
    expect(body.empty.root.visible).toBe(false);
  } finally { await app.dispose(); }
});

test.each([
  { status: "absent", rows: 0, visible: false },
  { status: "one-line", rows: 1, visible: true },
  { status: "two-line", rows: 2, visible: true },
  { status: "hidden", rows: 1, visible: false },
])("Search layouts remove the search gap and inset results with $status status", async ({ rows, visible }) => {
  // Status and candidates follow search immediately, with one cell of horizontal list padding.
  const app = await createTestRenderer({ width: 120, height: 20 });
  const search = new SearchInput(app.renderer, { id: "search", title: "Search" });
  const list = new ScrollBoxRenderable(app.renderer, { flexGrow: 1, minHeight: 0 });
  list.add(new TextRenderable(app.renderer, { content: "First candidate", height: 1, flexShrink: 0 }));
  const message = rows ? new TextRenderable(app.renderer, { content: "Result status", height: rows, flexShrink: 0, visible }) : undefined;
  const layout = new SearchPopupLayout(app.renderer, { id: "search-layout", search, list, ...(message ? { message } : {}) });
  app.renderer.root.add(layout.root);
  try {
    // Narrow terminals and hidden search fields must not duplicate or leave behind spacing.
    for (const [width, height] of [[120, 20], [60, 12]] as const) {
      app.resize(width, height); search.field.visible = true;
      await app.renderOnce(); await app.renderOnce();

      const next = message?.visible ? message : layout.results.root, nextY = search.field.y + search.field.height;
      expect(next.y).toBe(nextY);
      expect(list.y).toBe(nextY + (visible ? rows : 0));
      expect(list.x).toBe(search.field.x + 1); expect(list.width).toBe(search.field.width - 2);
      if (message?.visible) { expect(message.x).toBe(list.x); expect(message.width).toBe(list.width); }
      expect(list.height).toBe(height - search.field.height - (visible ? rows : 0));

      search.field.visible = false; await app.renderOnce(); await app.renderOnce();

      expect(next.y).toBe(layout.root.y);
      expect(list.height).toBe(height - (visible ? rows : 0));
    }
  } finally { await app.dispose(); }
});

test.each([false, true])("Search layouts preserve queries and viewport ownership with preview=%s", async previewEnabled => {
  // Both popup shapes use the same query/list layout without owning feature commands.
  const app = await createTestRenderer({ width: 140, height: 30 });
  const search = new SearchInput(app.renderer, { id: "search", title: "Search" });
  const list = new ScrollBoxRenderable(app.renderer, { flexGrow: 1, minHeight: 0 });
  const message = new TextRenderable(app.renderer, { content: "Results", height: 1, flexShrink: 0 });
  const preview = new PopupBody(app.renderer, "preview", new BoxRenderable(app.renderer, { flexGrow: 1 }));
  const layout = new SearchPopupLayout(app.renderer, { id: "search-layout", search, message, list,
    ...(previewEnabled ? { preview: { body: preview, width: 58 } } : {}) });
  app.renderer.root.add(layout.root); search.value = "hjkl query"; search.cursorOffset = 4; search.focus();
  try {
    // Switching layouts must not reset input or keep a hidden candidate viewport in the layout.
    for (const [width, compactPreview] of [[140, false], [60, false], [60, true], [140, false]] as const) {
      app.resize(width, 30); layout.resize(width >= 100, compactPreview);
      await app.renderOnce(); await app.renderOnce();

      expect(search.value).toBe("hjkl query"); expect(search.cursorOffset).toBe(4);
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
  } finally { if (!previewEnabled) preview.root.destroyRecursively(); await app.dispose(); }
});

test("Headerless popup activity stays on the frame edge without reserving or covering a content row", async () => {
  // Loading feedback must survive title removal without stealing the first content cell.
  const clock = new ManualClock(), app = await createTestRenderer({ width: 80, height: 20, clock });
  const panel = new PopupFrame(app.renderer, { position: "absolute", border: true, paddingX: 1,
    title: "Unused popup title", bottomTitle: "Unused popup footer" });
  const content = new TextRenderable(app.renderer, { content: "First content line", flexGrow: 1 });
  const spinner = new LoadingSpinner(app.renderer, { id: "popup-loading" });
  panel.add(content); attachPopupActivity(panel, spinner.root); app.renderer.root.add(panel);
  try {
    centerPopup(panel, 60, 14, 80, 20); spinner.start(); spinner.stop();
    await app.renderOnce(); await app.renderOnce();

    // Neither border titles nor spinner-only headers take space from the popup body.
    expect(content.y).toBe(panel.y + 1); expect(spinner.root.y).toBe(panel.y);
    expect(spinner.root.x).toBeGreaterThan(panel.x); expect(spinner.root.x).toBeLessThan(panel.x + panel.width - 1);
    expect(app.captureCharFrame()).toContain("First content line");
    expect(app.captureCharFrame()).not.toContain("Unused popup");
    expect(spinner.root.visible).toBe(true);
    clock.advance(500); await app.renderOnce();
    expect(spinner.root.visible).toBe(false); expect(content.y).toBe(panel.y + 1);
  } finally { await app.dispose(); }
});

test("Popup placement uses requested dimensions rather than stale native resize geometry", async () => {
  // Native getters still report the last frame when the terminal begins shrinking.
  const app = await createTestRenderer({ width: 140, height: 30 });
  const panel = new PopupFrame(app.renderer, { position: "absolute", border: true }); app.renderer.root.add(panel);
  try {
    centerPopup(panel, 120, 26, 140, 30); await app.renderOnce();

    // A compact resize must not move the popup offscreen using its previous larger width.
    app.resize(46, 12); centerPopup(panel, 100, 24, 46, 12); await app.renderOnce();

    expect(panel.x).toBe(0); expect(panel.y).toBe(0);
    expect(panel.width).toBe(46); expect(panel.height).toBe(12);
  } finally { await app.dispose(); }
});
