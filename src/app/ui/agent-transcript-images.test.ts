import { pressLeader } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { EditBufferRenderable, ImageRenderable, TextRenderable, type Renderable, type TerminalCapabilities } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { SessionTranscript } from "../../agents/transcript.ts";
import type { TranscriptImageProvider } from "../../agents/transcript-images.ts";
import { tinyPng } from "../../testing/image.ts";
import { ok } from "../../result.ts";

const capabilities: TerminalCapabilities = { kitty_keyboard: true, kitty_graphics: true, rgb: true, ansi256: true,
  unicode: "wcwidth", sgr_pixels: false, color_scheme_updates: false, explicit_width: false, scaled_text: false,
  sixel: false, focus_tracking: false, sync: false, bracketed_paste: true, hyperlinks: false, osc52: false,
  osc52_support: "unsupported", notifications: false, explicit_cursor_positioning: false, remote: false,
  multiplexer: "none", image_protocol: "kitty", terminal: { name: "test", version: "1", from_xtversion: false } };
const descendants = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(descendants)];
async function mount(provider: TranscriptImageProvider = async () => ok(tinyPng()), graphics = true, imageCount = 1) {
  const app = await createTestRenderer({ width: 120, height: 32, kittyKeyboard: true, clock: new ManualClock() });
  Object.defineProperty(app.renderer, "capabilities", { configurable: true, get: () => graphics ? capabilities : null });
  Object.defineProperty(app.renderer, "resolution", { configurable: true, get: () => graphics ? { width: app.renderer.terminalWidth * 10, height: app.renderer.terminalHeight * 20 } : null });
  const transcript = new SessionTranscript([]);
  const message = { role: "user" as const, timestamp: 1, content: [{ type: "text" as const, text: "[Image #1] Inspect the screenshot" },
    ...Array.from({ length: imageCount }, () => ({ type: "image" as const, data: tinyPng().toString("base64"), mimeType: "image/png" }))] };
  transcript.handle({ type: "message_end", message });
  const selection = new WorkspaceSelection(demoWorkspace()), sections = transcript.sections;
  const image = sections.find((section) => section.image)!;
  const view = new Workbench(app.renderer, selection, { onNewSession() {}, onCloseSession() {}, onPrompt: () => ok(undefined), onImage: provider,
    initialDrafts: { a1: "keep this draft" }, getSessionDetails: (id) => ({ status: "complete", error: null, output: "", sections: id === "a1" ? sections : [] }) });
  const render = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await app.renderOnce(); await app.renderOnce(); };
  await render();
  const header = () => {
    const node = descendants(view.root).find((node) => node instanceof EditBufferRenderable && node.plainText.startsWith("[read]"));
    if (!(node instanceof EditBufferRenderable)) throw new Error("Missing image attachment header");
    return node;
  };
  const bitmap = () => app.renderer.root.findDescendantById(`image-preview:${image.id}:image`);
  return { ...app, view, selection, render, header, bitmap, image,
    async clickHeader() { const node = header(); await app.mockMouse.click(node.x + 2, node.y); await render(); },
    async graphics() { graphics = true; app.renderer.emit("capabilities", capabilities); await render(); },
    async close() { view.dispose(); await app.dispose(); } };
}

test("이미지는 중복 문자열 대신 접힌 read 헤더로 시작하고 클릭·Ctrl+O로 실제 미리보기를 접고 편다", async () => {
  const signals: AbortSignal[] = [];
  const app = await mount(async (session, _id, signal) => { expect(session).toBe("a1"); signals.push(signal); return ok(tinyPng()); });
  try {
    // Collapsed attachments do not fetch pixels or duplicate editor-only placeholder text.
    expect(app.captureCharFrame()).toContain("[read] clipboard-1.png");
    expect(app.captureCharFrame()).not.toContain("[Image"); expect(signals).toHaveLength(0); expect(app.bitmap()).toBeUndefined();
    await app.clickHeader();
    const bitmap = app.bitmap(); if (!(bitmap instanceof ImageRenderable)) throw new Error("Missing native image preview");
    await bitmap.loadPromise; await app.render();

    expect(signals).toHaveLength(1); expect(bitmap.image?.width).toBe(1); expect(bitmap.image?.height).toBe(1);
    const native = bitmap.image!;
    const fitted = bitmap.getFittedSize(bitmap.width, bitmap.height);
    expect(fitted.width / fitted.height).toBeCloseTo(2, 1); expect(bitmap.fit).toBe("fit");
    expect(app.view.promptDrafts.a1).toBe("keep this draft");
    app.selection.replaceSnapshot(app.selection.snapshot); await app.render();
    expect(app.bitmap() === bitmap).toBe(true); expect(signals).toHaveLength(1);
    app.resize(80, 24); await app.render(); expect(bitmap.height).toBeGreaterThan(0);
    app.mockInput.pressKey("o", { ctrl: true }); await app.render();

    expect(app.bitmap()).toBeUndefined(); expect(signals[0]?.aborted).toBe(true); expect(bitmap.isDestroyed).toBe(true);
    expect(() => native.raw()).toThrow();
    expect(app.view.workViewPreferences.agentViews?.a1?.folded[app.image.id]).toBe(true);
    expect(app.captureCharFrame()).toContain("[read] clipboard-1.png");
  } finally { await app.close(); }
});

test("지원하지 않는 터미널은 안내만 표시하고 픽셀 정보가 늦게 도착하면 미리보기를 활성화한다", async () => {
  let calls = 0;
  const app = await mount(async () => { calls++; return ok(tinyPng()); }, false);
  try {
    await app.clickHeader();
    expect(app.captureCharFrame()).toContain("Image preview needs a terminal"); expect(calls).toBe(0);
    await app.graphics(); await app.render();

    const bitmap = app.bitmap(); if (!(bitmap instanceof ImageRenderable)) throw new Error("Missing late graphics preview");
    await bitmap.loadPromise; await app.render();
    expect(calls).toBe(1); expect(bitmap.image?.width).toBe(1);
  } finally { await app.close(); }
});

test("다른 세션으로 이동하면 이미지 조회를 취소하고 늦은 응답으로 새 화면이나 초안을 바꾸지 않는다", async () => {
  const pending = Promise.withResolvers<ReturnType<typeof ok<Uint8Array>>>(); let signal: AbortSignal | undefined;
  const app = await mount(async (_session, _id, abort) => { signal = abort; return pending.promise; });
  try {
    await app.clickHeader(); expect(app.captureCharFrame()).toContain("Loading image");
    app.selection.selectSession("demo:main", "a2"); await app.render();
    pending.resolve(ok(tinyPng())); await app.render();

    expect(signal?.aborted).toBe(true); expect(app.bitmap()).toBeUndefined();
    expect(descendants(app.view.root).some((node) => node instanceof ImageRenderable)).toBe(false);
    expect(app.view.promptDrafts.a1).toBe("keep this draft");
  } finally { pending.resolve(ok(tinyPng())); await app.close(); }
});

test("세션 왕복은 대화 버퍼만 재사용하고 이미지는 새 요청으로 복원해 이전 응답을 무시한다", async () => {
  // A를 다시 열었을 때 이전 이미지 요청의 늦은 응답이 새 미리보기를 차지하지 않아야 한다.
  const first = Promise.withResolvers<ReturnType<typeof ok<Uint8Array>>>();
  const second = Promise.withResolvers<ReturnType<typeof ok<Uint8Array>>>();
  const signals: AbortSignal[] = [];
  const app = await mount(async (_session, _id, signal) => { signals.push(signal); return signals.length === 1 ? first.promise : second.promise; });
  try {
    await app.clickHeader();
    const header = app.header();
    app.selection.selectSession("demo:main", "a2"); await app.render();
    expect(signals[0]?.aborted).toBe(true);

    // 보관된 A에 돌아와 새 조회를 시작한 다음 취소된 조회의 응답을 먼저 전달한다.
    app.selection.selectSession("demo:main", "a1"); await app.render();
    first.resolve(ok(tinyPng())); await app.render();

    // 헤더 버퍼는 재사용하지만 픽셀과 요청은 재사용하지 않으며 오래된 응답은 표시하지 않는다.
    expect(app.header() === header).toBe(true);
    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(false);
    expect(app.bitmap()).toBeUndefined();
    second.resolve(ok(tinyPng())); await app.render();
    const bitmap = app.bitmap();
    if (!(bitmap instanceof ImageRenderable)) throw new Error("Missing restored image preview");
    await bitmap.loadPromise; await app.render();
    expect(bitmap.image?.width).toBe(1);
    expect(app.view.promptDrafts.a1).toBe("keep this draft");
  } finally { first.resolve(ok(tinyPng())); second.resolve(ok(tinyPng())); await app.close(); }
});

test("Expand-all limits concurrent images and collapsing activates waiting previews", async () => {
  let calls = 0, active = 0, maximum = 0;
  const app = await mount(async (_session, _id, signal) => {
    calls++; active++; maximum = Math.max(maximum, active);
    signal.addEventListener("abort", () => { active--; }, { once: true }); return ok(tinyPng());
  }, true, 9);
  try {
    pressLeader(app, "["); app.mockInput.pressKey("HOME");
    app.mockInput.pressKey("z"); app.mockInput.pressKey("r"); await app.render();

    expect(calls).toBe(8); expect(maximum).toBe(8);
    expect(descendants(app.view.root).some((node) => node instanceof TextRenderable && node.plainText.includes("Preview memory limit"))).toBe(true);
    await app.clickHeader(); await app.render();
    expect(calls).toBe(9); expect(maximum).toBe(8);
  } finally { await app.close(); }
  expect(active).toBe(0);
});

test("잘못된 이미지 바이트는 빈 미리보기나 숨겨진 예외 대신 디코딩 오류로 표시한다", async () => {
  const app = await mount(async () => ok(new Uint8Array(tinyPng().byteLength)));
  try {
    await app.clickHeader(); await app.render();

    expect(app.captureCharFrame()).toContain("Image preview could not be decoded");
    expect(app.view.promptDrafts.a1).toBe("keep this draft");
  } finally { await app.close(); }
});
