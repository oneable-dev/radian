import { expect, test } from "bun:test";
import { ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { LoadingSpinner } from "./loading-spinner.ts";
import { PopupFrame } from "./popup-frame.ts";
import { SearchInput } from "./search-input.ts";
import { SearchPopupLayout, attachPopupActivity } from "./popup-layout.ts";

async function mount() {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 80, height: 20, clock });
  const panel = new PopupFrame(app.renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    border: false,
    paddingX: 0,
  });
  const search = new SearchInput(app.renderer, { id: "search", title: "Models" });
  const list = new ScrollBoxRenderable(app.renderer, { flexGrow: 1, minHeight: 0 });
  const layout = new SearchPopupLayout(app.renderer, { id: "picker", search, list });
  const spinner = new LoadingSpinner(app.renderer, { id: "activity" });
  const feedback = attachPopupActivity(app.renderer, panel, spinner.root, () => ({
    pending: true,
    hasContent: false,
    message: "Loading candidates…",
    title: search.field,
  }));
  panel.add(layout.root);
  app.renderer.root.add(panel);
  search.value = "literal query";
  search.cursorOffset = 4;
  search.focus();
  const render = async () => {
    await app.renderOnce();
    await app.renderOnce();
  };
  return { ...app, clock, panel, search, list, spinner, feedback, render };
}

test("Search title activity precedes the label without body text, spacing changes or input resets", async () => {
  // Initial I/O has no candidates, but neither the title nor the body needs loading prose.
  const app = await mount();
  const timers = app.clock.pendingTimerCount;
  try {
    app.spinner.start();
    await app.render();
    expect(app.captureCharFrame()).toContain(" ⠋ Models ");
    expect(app.captureCharFrame()).not.toContain("Loading candidates");
    expect(app.spinner.root.y).toBe(app.search.field.y);
    expect(app.list.y).toBe(app.search.field.y + app.search.field.height);

    // New frames and title changes stay fixed above scrollable results without touching native editing.
    app.clock.advance(80);
    app.search.setTitle("History");
    app.list.add(new TextRenderable(app.renderer, { content: "Ready candidate", height: 1 }));
    app.search.setCounts({ matched: 1, total: 1 });
    app.spinner.stop();
    await app.render();
    expect(app.captureCharFrame()).toContain(" ⠙ History ");
    expect(app.captureCharFrame()).toContain("Ready candidate");
    expect(app.search.value).toBe("literal query");
    expect(app.search.cursorOffset).toBe(4);
    expect(app.renderer.currentFocusedRenderable).toBe(app.search);

    // The shared minimum-visible tail changes only title ink, not candidate height or availability.
    app.clock.advance(420);
    await app.render();
    expect(app.feedback.visible).toBe(false);
    expect(app.search.field.title).toBe(" History ");
    expect(app.list.y).toBe(app.search.field.y + app.search.field.height);
    expect(app.clock.pendingTimerCount).toBe(timers);
  } finally {
    app.spinner.cancel();
    await app.dispose();
  }
});

test("Title activity stays within resized fields, including Unicode and borderless compact inputs", async () => {
  // Extension picker titles can exceed the available cell width and contain wide Unicode characters.
  const app = await mount();
  app.search.setTitle("검색 👩🏽‍💻 ".repeat(20));
  app.spinner.start();
  try {
    for (const [width, fieldHeight] of [
      [80, 3],
      [24, 3],
      [12, 1],
      [80, 3],
    ] as const) {
      app.resize(width, 20);
      app.search.fit(fieldHeight);
      await app.render();

      // The single indicator remains visible instead of leaking onto a preview or covering query text.
      expect(app.feedback.visible).toBe(true);
      expect(app.spinner.root.x).toBeGreaterThanOrEqual(app.search.field.x);
      expect(app.spinner.root.x + app.spinner.root.width).toBeLessThanOrEqual(
        app.search.field.x + app.search.field.width,
      );
      expect(app.spinner.root.y).toBe(app.search.field.y);
      expect(app.captureCharFrame().split("\n")[app.spinner.root.y]).toContain("⠋");
      expect(app.search.value).toBe("literal query");
      expect(app.search.cursorOffset).toBe(4);
      expect(app.renderer.currentFocusedRenderable).toBe(app.search);
      expect(app.captureCharFrame()).not.toContain("Loading candidates");
    }
  } finally {
    app.spinner.cancel();
    await app.dispose();
  }
});
