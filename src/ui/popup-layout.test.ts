import { expect, test } from "bun:test";
import { BoxRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { PopupBody, SearchPopupLayout, centerPopup } from "./popup-layout.ts";
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

test.each([false, true])("Search layouts preserve queries and viewport ownership with preview=%s", async previewEnabled => {
  // Both popup shapes use the same query/list layout without owning feature commands.
  const app = await createTestRenderer({ width: 140, height: 30 });
  const search = new SearchInput(app.renderer, { id: "search", placeholder: "Search" });
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
        if (width >= 100) {
          expect(preview.root.y).toBe(search.field.y);
          expect(search.field.x + search.field.width).toBe(preview.root.x);
        }
      }
      expect(layout.listHeight).toBeGreaterThan(0);
    }
  } finally { if (!previewEnabled) preview.root.destroyRecursively(); await app.dispose(); }
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
