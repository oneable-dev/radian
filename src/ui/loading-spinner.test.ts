import { expect, test } from "bun:test";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { LoadingSpinner } from "./loading-spinner.ts";

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

test("공통 스피너는 즉시 완료된 작업도 499ms에는 회전하고 500ms에 사라진다", async () => {
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

test("500ms보다 오래 걸린 작업은 완료 후 추가 대기 없이 스피너가 사라진다", async () => {
  // A minimum display interval is not an extra delay appended to every operation.
  const app = await mount();
  try {
    app.spinner.start(); await app.advance(800);
    expect(app.spinning()).toBe(true);

    app.spinner.stop(); await app.renderOnce();

    expect(app.spinning()).toBe(false);
  } finally { await app.dispose(); }
});

test("숨김 대기 중 새 작업이 시작되면 이전 타이머가 새 스피너를 지우지 않는다", async () => {
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

test("완료 통지가 중복되어도 스피너의 최소 표시 시간을 불필요하게 늘리지 않는다", async () => {
  // Multiple completion notifications must not create or extend a delayed-hide timer.
  const app = await mount();
  try {
    app.spinner.start(); app.spinner.stop(); await app.advance(400);

    app.spinner.stop(); await app.advance(100);

    expect(app.spinning()).toBe(false);
  } finally { await app.dispose(); }
});

test("화면을 떠날 때 취소하면 500ms를 기다리지 않고 숨기며 다음 작업은 다시 표시한다", async () => {
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
  test(`${completed ? "최소 표시 대기" : "작업 진행"} 중 부모 화면을 제거하면 스피너의 모든 타이머가 정리된다`, async () => {
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

test("서로 다른 UI의 스피너는 각자의 500ms 표시 시간을 독립적으로 지킨다", async () => {
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
