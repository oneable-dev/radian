import { expect, test } from "bun:test";
import { TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { SearchInput } from "./search-input.ts";

test.each([120, 48, 24])("Titled search at %i columns distinguishes unknown counts and preserves native editing", async width => {
  // An unloaded picker must not look like an empty catalog or show placeholder instructions.
  const app = await createTestRenderer({ width, height: 10 });
  const input = new SearchInput(app.renderer, { id: "query", title: "Models" });
  app.renderer.root.add(input.field); input.fit(3); input.focus();
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  try {
    await render();
    const count = input.field.findDescendantById("query-count");
    if (!(count instanceof TextRenderable)) throw new Error("Missing result count");
    expect(input.placeholder).toBe(""); expect(input.value).toBe(""); expect(count.visible).toBe(false);
    expect(app.captureCharFrame()).toContain("Models"); expect(app.captureCharFrame()).toContain(">");

    // Known empty data is different from pending data, and subsequent updates must not reset text or caret.
    input.setCounts({ matched: 0, total: 0 }); await render();
    expect(count.visible).toBe(true); expect(app.captureCharFrame()).toContain("0/0");
    input.value = "hjkl"; input.cursorOffset = 2;
    input.setTitle("History"); input.setCounts({ matched: 2, total: 300 }); await render();

    expect(app.captureCharFrame()).toContain("History"); expect(app.captureCharFrame()).toContain("2/300");
    expect(count.x + count.width).toBeLessThan(input.field.x + input.field.width);
    expect(input.value).toBe("hjkl"); expect(input.cursorOffset).toBe(2); expect(app.renderer.currentFocusedRenderable).toBe(input);
    input.setCounts(null); await render();
    expect(count.visible).toBe(false); expect(app.captureCharFrame()).not.toContain("2/300");
    expect(input.value).toBe("hjkl"); expect(input.cursorOffset).toBe(2);
  } finally { await app.dispose(); }
});
