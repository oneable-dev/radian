import { expect, spyOn, test } from "bun:test";
import { ImageError, NativeImage, OptimizedBuffer, TextAttributes, type TerminalCapabilities, type CliRendererErrorEvent } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { ProviderIcon } from "./provider-icon.ts";
import { icons } from "../icons.ts";
import { uiTheme } from "./theme.ts";

async function mount() {
  const app = await createTestRenderer({ width: 80, height: 6 });
  const icon = new ProviderIcon(app.renderer); icon.left = 4; icon.top = 2;
  icon.setProvider("openai"); icon.visible = true; app.renderer.root.add(icon);
  return { ...app, icon, async close() { await app.dispose(); } };
}
const capabilities: TerminalCapabilities = { kitty_keyboard: false, kitty_graphics: true, rgb: true, ansi256: true,
  unicode: "wcwidth", sgr_pixels: false, color_scheme_updates: false, explicit_width: false, scaled_text: false,
  sixel: false, focus_tracking: false, sync: false, bracketed_paste: false, hyperlinks: false, osc52: false,
  osc52_support: "unsupported", notifications: false, explicit_cursor_positioning: false, remote: false,
  multiplexer: "none", image_protocol: "kitty", terminal: { name: "test", version: "1", from_xtversion: false } };

test("일반 터미널은 두 셀을 예약하되 지원하지 않는 그래픽 대신 굵은 Nerd Font 로고를 그린다", async () => {
  const app = await mount();
  try {
    await app.renderOnce();

    expect(app.icon.width).toBe(2); expect(app.icon.height).toBe(1);
    const line = app.captureCharFrame().split("\n")[2]!;
    expect(line.indexOf(icons.openai)).toBe(4);
    const span = app.captureSpans().lines[2]!.spans.find((value) => value.text.includes(icons.openai))!;
    expect(span.attributes & TextAttributes.BOLD).not.toBe(0);

    app.icon.setProvider("anthropic"); await app.renderOnce();
    expect(app.captureCharFrame().split("\n")[2]).toContain(icons.claude);
    expect(app.icon.setProvider("unsupported")).toBe(false); expect(app.icon.visible).toBe(false);
  } finally { await app.close(); }
});

test("그래픽 지원 터미널에서는 실제 잉크 너비가 글자 셀의 1.5배인 테마색 이미지를 OpenTUI로 전달한다", async () => {
  const app = await mount();
  const paints: { width: number; height: number; pixelWidth: number; pixelHeight: number; pixels: Uint8Array; imageWidth: number; protocol: string }[] = [];
  const draw = spyOn(OptimizedBuffer.prototype, "drawImage").mockImplementation((image, _x, _y, width, height, pixelWidth, pixelHeight, _sx, _sy, _sw, _sh, protocol) => {
    paints.push({ width, height, pixelWidth: pixelWidth!, pixelHeight: pixelHeight!, pixels: image.raw().data.slice(), imageWidth: image.width, protocol: protocol! });
    return true;
  });
  // Only the terminal capability/transport boundary is substituted; image creation and raster data are real.
  Object.defineProperty(app.renderer, "capabilities", { configurable: true, get: () => capabilities });
  Object.defineProperty(app.renderer, "resolution", { configurable: true,
    get: () => ({ width: app.renderer.terminalWidth * 10, height: app.renderer.terminalHeight * 20 }) });
  try {
    app.renderer.emit("capabilities", capabilities); await app.renderOnce();

    const paint = paints.at(-1)!;
    expect(paint.protocol).toBe("kitty"); expect(paint.width).toBe(2); expect(paint.height).toBe(1);
    expect(paint.pixelWidth).toBe(20); expect(paint.pixelHeight).toBe(20);
    let min = paint.imageWidth, max = -1;
    for (let index = 0; index < paint.pixels.length / 4; index++) if (paint.pixels[index * 4 + 3]) {
      min = Math.min(min, index % paint.imageWidth); max = Math.max(max, index % paint.imageWidth);
    }
    const inkPixels = (max - min + 1) / paint.imageWidth * paint.pixelWidth;
    expect(inkPixels / 10).toBeCloseTo(1.5, 2);
    expect(Math.max(...paint.pixels.filter((_, index) => index % 4 === 3))).toBe(255);
    const first = paint.pixels.findIndex((_, index) => index % 4 === 3 && paint.pixels[index]! > 0) - 3;
    expect(Array.from(paint.pixels.slice(first, first + 3))).toEqual(uiTheme(app.renderer).colors.text.toInts().slice(0, 3));

    app.renderer.emit("palette", { palette: [], defaultForeground: "#112233", defaultBackground: "#FAFAF6",
      cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null,
      highlightForeground: null, highlightBackground: null });
    await app.renderOnce();
    const retinted = paints.at(-1)!;
    const colored = retinted.pixels.findIndex((_, index) => index % 4 === 3 && retinted.pixels[index]! > 0) - 3;
    expect(Array.from(retinted.pixels.slice(colored, colored + 3))).toEqual([17, 34, 51]);

    // Replacing a provider and destroying its owner must not leak renderer subscriptions or buffers.
    const before = app.renderer.listenerCount("capabilities"), frames = app.renderer.listenerCount("frame");
    app.icon.setProvider("anthropic"); await app.renderOnce(); app.icon.destroy();
    expect(app.renderer.listenerCount("capabilities")).toBe(before - 1);
    expect(app.renderer.listenerCount("frame")).toBe(frames - 1);
  } finally {
    draw.mockRestore(); Reflect.deleteProperty(app.renderer, "capabilities"); Reflect.deleteProperty(app.renderer, "resolution"); await app.close();
  }
});

test("픽셀 크기 응답이 늦게 와도 다음 프레임에서 확대 이미지를 활성화한다", async () => {
  const app = await mount(); let resolution: { width: number; height: number } | null = null;
  const draw = spyOn(OptimizedBuffer.prototype, "drawImage").mockReturnValue(true);
  Object.defineProperty(app.renderer, "capabilities", { configurable: true, get: () => capabilities });
  Object.defineProperty(app.renderer, "resolution", { configurable: true, get: () => resolution });
  try {
    await app.renderOnce(); expect(draw).not.toHaveBeenCalled();

    resolution = { width: 800, height: 120 }; await app.renderOnce(); await app.renderOnce();

    expect(draw).toHaveBeenCalled();
  } finally {
    draw.mockRestore(); Reflect.deleteProperty(app.renderer, "capabilities"); Reflect.deleteProperty(app.renderer, "resolution"); await app.close();
  }
});

for (const [status, code, fallback] of [[6, "memory-limit", true], [7, "invalid-argument", false]] as const) {
  test(`native 이미지 ${code}는 ${fallback ? "안전한 글리프 대체" : "원래 예외 보고"}로 구분한다`, async () => {
    const app = await mount(), failure = new ImageError(status);
    const errors: Error[] = [], capture = (event: CliRendererErrorEvent) => { errors.push(event.error); };
    const allocation = spyOn(NativeImage, "fromRgba").mockImplementation(() => { throw failure; });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    Object.defineProperty(app.renderer, "capabilities", { configurable: true, get: () => capabilities });
    Object.defineProperty(app.renderer, "resolution", { configurable: true, get: () => ({ width: 800, height: 120 }) });
    app.renderer.on("render:error", capture);
    try {
      expect(failure.code).toBe(code);

      await app.renderOnce();

      if (fallback) {
        expect(errors).toEqual([]); expect(warn).toHaveBeenCalled();
        expect(app.captureCharFrame().split("\n")[2]).toContain(icons.openai);
      } else {
        expect(errors).toContain(failure); expect(warn).not.toHaveBeenCalled();
      }
    } finally {
      allocation.mockRestore(); warn.mockRestore(); app.renderer.off("render:error", capture);
      Reflect.deleteProperty(app.renderer, "capabilities"); Reflect.deleteProperty(app.renderer, "resolution"); await app.close();
    }
  });
}

test("그래픽 전송을 사용할 수 없으면 같은 자리의 글리프로 안전하게 대체한다", async () => {
  const app = await mount();
  const draw = spyOn(OptimizedBuffer.prototype, "drawImage").mockReturnValue(false);
  Object.defineProperty(app.renderer, "capabilities", { configurable: true, get: () => capabilities });
  Object.defineProperty(app.renderer, "resolution", { configurable: true, get: () => ({ width: 800, height: 120 }) });
  try {
    app.renderer.emit("capabilities", capabilities); await app.renderOnce();

    expect(draw).toHaveBeenCalled(); expect(app.captureCharFrame().split("\n")[2]).toContain(icons.openai);
  } finally {
    draw.mockRestore(); Reflect.deleteProperty(app.renderer, "capabilities"); Reflect.deleteProperty(app.renderer, "resolution"); await app.close();
  }
});
