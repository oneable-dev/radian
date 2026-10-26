import { expect, test } from "bun:test";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { LoadingSpinner } from "./loading-spinner.ts";
import { uiTheme } from "./theme.ts";

const glyph = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
async function mount() {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 30, height: 4, clock });
  const heading = new BoxRenderable(app.renderer, { height: 1, flexDirection: "row" });
  const spinner = new LoadingSpinner(app.renderer);
  heading.add(new TextRenderable(app.renderer, { content: "Loading ", height: 1 }));
  heading.add(spinner.root); app.renderer.root.add(heading);
  await app.renderOnce();
  return { ...app, clock, heading, spinner,
    spinning: () => glyph.test(app.captureCharFrame()),
    async advance(ms: number) { clock.advance(ms); await app.renderOnce(); },
  };
}

test("Shared spinners still rotate at 499ms for immediate work and disappear at 500ms", async () => {
  // Completion may happen before the first paint; the indicator still needs a readable display interval.
  const app = await mount();
  try {
    app.spinner.start(); app.spinner.stop(); await app.renderOnce();
    expect(app.captureCharFrame()).toContain("⠋");

    // Only visual feedback is delayed, using the renderer clock rather than wall-clock sleeps.
    await app.advance(80); expect(app.captureCharFrame()).toContain("⠙");
    await app.advance(419); expect(app.spinning()).toBe(true);
    await app.advance(1);

    expect(app.spinning()).toBe(false);
  } finally { await app.dispose(); }
});

test("Fast spinners cycle yellow arrows rightward inside fixed three-cell slots", async () => {
  // Only priority work changes the shared spinner's presentation; normal loaders retain their frames.
  const app = await mount();
  try {
    app.spinner.setStyle("fast"); app.spinner.start(); await app.renderOnce();
    const x = app.spinner.root.x, width = app.spinner.root.width;

    for (const expected of ["▶▷▷", "▷▶▷", "▷▷▶", "▶▷▷"]) {
      expect(app.spinner.root.plainText).toBe(expected);
      expect(app.spinner.root.x).toBe(x); expect(app.spinner.root.width).toBe(3); expect(width).toBe(3);
      const spans = app.captureSpans().lines[app.spinner.root.y]!.spans;
      expect(spans.find(span => span.text.includes("▶"))!.fg.toInts()).toEqual(uiTheme(app.renderer).colors.number.toInts());
      expect(spans.find(span => span.text.includes("▷"))!.fg.toInts()).toEqual(uiTheme(app.renderer).colors.muted.toInts());
      await app.advance(80);
    }
  } finally { await app.dispose(); }
});

test.each(["fast", "pulse"] as const)("Switching to %s preserves minimum display duration and cancellation lifetime", async style => {
  // Changing animation style is not a new operation and cannot reset its 500ms visibility window.
  const app = await mount();
  try {
    app.spinner.start(); await app.advance(120);

    app.spinner.setStyle(style); app.spinner.stop(); await app.advance(379);

    expect(app.spinner.root.visible).toBe(true); expect(app.spinner.root.width).toBe(3);
    await app.advance(1); expect(app.spinner.root.visible).toBe(false);
    app.spinner.setStyle("default"); app.spinner.start(); await app.renderOnce();
    expect(app.spinner.root.plainText).toBe("⠋"); expect(app.spinner.root.width).toBe(1);
    app.spinner.cancel(); await app.renderOnce(); expect(app.clock.pendingTimerCount).toBe(0);
  } finally { await app.dispose(); }
});

test("Pulse spinners stagger three cells and loop without resetting on repeated style updates", async () => {
  // Compaction flows across the same three-cell slot as Fast instead of pulsing every cell in unison.
  const app = await mount();
  try {
    app.spinner.setStyle("pulse"); app.spinner.start(); await app.renderOnce();
    const x = app.spinner.root.x;

    // Adjacent cells are two frames apart throughout a full pulse cycle and its wraparound.
    for (const expected of ["⣀⣶⣿", "⣤⣾⣾", "⣶⣿⣶", "⣾⣾⣤", "⣿⣶⣀", "⣾⣤⣤", "⣶⣀⣶", "⣤⣤⣾", "⣀⣶⣿"]) {
      app.spinner.setStyle("pulse"); await app.renderOnce();

      expect(app.spinner.root.plainText).toBe(expected);
      expect(app.spinner.root.width).toBe(3); expect(app.spinner.columns).toBe(3); expect(app.spinner.root.x).toBe(x);
      await app.advance(80);
    }
    app.spinner.cancel(); await app.renderOnce(); expect(app.clock.pendingTimerCount).toBe(0);
  } finally { await app.dispose(); }
});

test("Work exceeding 500ms hides spinners immediately on completion", async () => {
  // A minimum display interval is not an extra delay appended to every operation.
  const app = await mount();
  try {
    app.spinner.start(); await app.advance(800);
    expect(app.spinning()).toBe(true);

    app.spinner.stop(); await app.renderOnce();

    expect(app.spinning()).toBe(false);
  } finally { await app.dispose(); }
});

test("New work during hide delays prevents old timers from clearing fresh spinners", async () => {
  // Two consecutive requests share the same view while the first indicator is still visible.
  const app = await mount();
  try {
    app.spinner.start(); app.spinner.stop(); await app.advance(400);

    // The second operation owns a new 500 ms interval, without waiting on the first timer.
    app.spinner.start(); app.spinner.stop(); await app.advance(100);
    expect(app.spinning()).toBe(true);
    await app.advance(399); expect(app.spinning()).toBe(true);
    await app.advance(1);

    expect(app.spinning()).toBe(false);
  } finally { await app.dispose(); }
});

test("Duplicate completions never extend spinner minimums unnecessarily", async () => {
  // Multiple completion notifications must not create or extend a delayed-hide timer.
  const app = await mount();
  try {
    app.spinner.start(); app.spinner.stop(); await app.advance(400);

    app.spinner.stop(); await app.advance(100);

    expect(app.spinning()).toBe(false);
  } finally { await app.dispose(); }
});

test("Leaving screens cancels immediately without waiting 500ms and subsequent work displays again", async () => {
  // Visibility guarantees apply only while the owning screen remains visible.
  const app = await mount();
  try {
    app.spinner.start(); app.spinner.stop(); await app.advance(100);

    app.spinner.cancel(); await app.renderOnce();
    expect(app.spinning()).toBe(false);
    app.spinner.start(); await app.advance(400);

    expect(app.spinning()).toBe(true);
    app.spinner.stop(); await app.advance(100);
    expect(app.spinning()).toBe(false);
  } finally { await app.dispose(); }
});

for (const completed of [false, true]) {
  test(`Removing parent screens during ${completed ? "minimum display waits" : "active work"} cleans all spinner timers`, async () => {
    // Shared components must clean up when their renderable parent is destroyed, without a host-specific hook.
    const app = await mount();
    try {
      app.spinner.start(); if (completed) app.spinner.stop();
      await app.advance(100);

      app.heading.destroyRecursively();
      // A leaked timer would attempt to write to the destroyed native text buffer.
      expect(() => app.clock.advance(1000)).not.toThrow(); await app.renderOnce();
      app.spinner.start(); app.spinner.stop(); app.spinner.cancel();

      expect(app.spinning()).toBe(false);
      expect(app.spinner.root.isDestroyed).toBe(true);
    } finally { await app.dispose(); }
  });
}

test("Independent UI spinners each honor their own 500ms minimum", async () => {
  // The shared policy must not couple independent screens or loading indicators through global state.
  const app = await mount();
  const second = new LoadingSpinner(app.renderer);
  app.renderer.root.add(second.root);
  try {
    app.spinner.start(); app.spinner.stop(); await app.advance(200);

    second.start(); second.stop(); await app.advance(300);

    expect(app.spinner.root.visible).toBe(false);
    expect(second.root.visible).toBe(true);
    await app.advance(200);
    expect(second.root.visible).toBe(false);
  } finally { await app.dispose(); }
});
