import { expect, spyOn, test } from "bun:test";
import { BoxRenderable, OptimizedBuffer } from "@opentui/core";
import { createTestRenderer, setRendererCapabilities } from "@opentui/core/testing";
import { ProviderIcon } from "./provider-icon.ts";
import { uiTheme } from "./theme.ts";
import { styleBackground } from "./theme-styles.ts";
import { icons } from "../icons.ts";

type Paint = { pixels: Uint8Array; imageWidth: number; imageHeight: number; width: number; height: number; pixelWidth: number; pixelHeight: number };
function inkWidth(paint: Paint): number {
  const background = paint.pixels.subarray(0, 3); let min = paint.imageWidth, max = -1;
  for (let index = 0; index < paint.pixels.length / 4; index++) {
    if (paint.pixels[index * 4] === background[0] && paint.pixels[index * 4 + 1] === background[1] && paint.pixels[index * 4 + 2] === background[2]) continue;
    min = Math.min(min, index % paint.imageWidth); max = Math.max(max, index % paint.imageWidth);
  }
  return (max - min + 1) / paint.imageWidth * paint.pixelWidth;
}
for (const protocol of ["kitty", "sixel"] as const) for (const light of [false, true]) {
  test.each(["openai", "anthropic"] as const)(`${protocol} 로고 %s는 light=${light} 팝업에서도 확대 크기를 유지하고 색상만 배경과 함께 어두워진다`, async provider => {
    // 이미지 전송 경계만 대체하고 실제 픽셀 데이터와 네이티브 반투명 합성을 사용한다.
    const app = await createTestRenderer({ width: 80, height: 8 });
    const theme = uiTheme(app.renderer), glyph = provider === "openai" ? icons.openai : icons.claude;
    if (light) app.renderer.emit("palette", { palette: [], defaultForeground: "#202020", defaultBackground: "#FAFAF6",
      cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null,
      highlightForeground: null, highlightBackground: null });
    const background = new BoxRenderable(app.renderer, { width: "100%", height: "100%", backgroundColor: styleBackground(theme.styles["ui.text"]) });
    const icon = new ProviderIcon(app.renderer); icon.left = 4; icon.top = 2; icon.setProvider(provider); icon.visible = true;
    background.add(icon); app.renderer.root.add(background);
    const popup = new BoxRenderable(app.renderer, { id: "popup-backdrop", position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 5600,
      visible: false, backgroundColor: styleBackground(theme.styles["ui.backdrop"]) }); app.renderer.root.add(popup);
    const paints: Paint[] = [];
    const draw = spyOn(OptimizedBuffer.prototype, "drawImage").mockImplementation((image, _x, _y, width, height, pixelWidth, pixelHeight) => {
      paints.push({ pixels: image.raw().data.slice(), imageWidth: image.width, imageHeight: image.height, width, height, pixelWidth: pixelWidth!, pixelHeight: pixelHeight! }); return true;
    });
    setRendererCapabilities(app.renderer, { kitty_graphics: protocol === "kitty", sixel: protocol === "sixel", image_protocol: protocol });
    Object.defineProperty(app.renderer, "resolution", { configurable: true, get: () => ({ width: 800, height: 160 }) });
    const render = async () => { await app.renderOnce(); await app.renderOnce(); };
    try {
      await render(); const original = paints.at(-1)!;
      expect(original).toBeDefined(); expect(inkWidth(original) / 10).toBeCloseTo(1.5, 2);

      // 팝업에서 작은 글꼴로 바꾸지 않고 동일한 이미지 기하에 합성된 색상을 적용한다.
      popup.visible = true; await render(); const dimmed = paints.at(-1)!;
      expect(dimmed.pixels).not.toEqual(original.pixels);
      expect([dimmed.width, dimmed.height, dimmed.pixelWidth, dimmed.pixelHeight, dimmed.imageWidth, dimmed.imageHeight])
        .toEqual([original.width, original.height, original.pixelWidth, original.pixelHeight, original.imageWidth, original.imageHeight]);
      expect(inkWidth(dimmed)).toBe(inkWidth(original));
      expect(Math.max(...dimmed.pixels.filter((_, i) => i % 4 !== 3))).toBeLessThan(Math.max(...original.pixels.filter((_, i) => i % 4 !== 3)));
      expect(Array.from(dimmed.pixels.slice(0, 3))).toEqual(app.captureSpans().lines[2]!.spans[0]!.bg.toInts().slice(0, 3));
      expect(dimmed.pixels.filter((_, i) => i % 4 === 3).every(alpha => alpha === 255)).toBe(true);
      expect(app.captureCharFrame().split("\n")[2]).not.toContain(glyph);
      const cached = draw.mock.calls.at(-1)![0]; await render(); expect(draw.mock.calls.at(-1)![0]).toBe(cached);

      // 불투명한 팝업 본문은 가려진 로고를 위로 뚫고 다시 그리지 않는다.
      popup.backgroundColor = styleBackground(theme.styles["ui.popup"]); const beforeOpaque = paints.length; await render();
      expect(paints).toHaveLength(beforeOpaque);

      // 팝업을 닫으면 크기 변화 없이 원래의 색상을 되찾는다.
      popup.visible = false; await render(); expect(paints.at(-1)!.pixels).toEqual(original.pixels);
    } finally { draw.mockRestore(); Reflect.deleteProperty(app.renderer, "resolution"); await app.dispose(); }
  });
}
