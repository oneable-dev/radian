import { expect, test } from "bun:test";
import { OptimizedBuffer, RGBA, TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { monochromeFrame } from "./monochrome.ts";
import { uiTheme } from "./theme.ts";

// Monochrome mode must retain selection distinctions across different background roles.
test("Monochrome menus/text selections retain individual backgrounds through inverse emphasis", async () => {
  const app = await createTestRenderer({ width: 3, height: 1 });
  const theme = uiTheme(app.renderer);
  const buffer = OptimizedBuffer.create(3, 1, "unicode", { owner: app.renderer.nativeScene! });
  try {
    theme.configure(
      {
        palette: [],
        defaultForeground: null,
        defaultBackground: null,
        cursorColor: null,
        mouseForeground: null,
        mouseBackground: null,
        tekForeground: null,
        tekBackground: null,
        highlightForeground: null,
        highlightBackground: null,
      },
      {
        styles: {
          "completion.selected": { bg: "#123456" },
          "transcript.selection": { bg: "#654321" },
        },
      },
    );
    buffer.drawText(
      "A",
      0,
      0,
      theme.styles["ui.label"].fg,
      theme.styles["completion.selected"].bg!,
    );
    buffer.drawText(
      "B",
      1,
      0,
      theme.styles["ui.label"].fg,
      theme.styles["transcript.selection"].bg!,
    );
    buffer.drawText("C", 2, 0, theme.colors.text, theme.colors.panel);

    monochromeFrame(buffer, theme.colors, theme.styles);

    buffer.withBuffers(({ attributes }) => {
      expect(attributes[0]! & TextAttributes.INVERSE).not.toBe(0);
      expect(attributes[1]! & TextAttributes.INVERSE).not.toBe(0);
      expect(attributes[2]! & TextAttributes.INVERSE).toBe(0);
    });
  } finally {
    buffer.destroy();
    await app.dispose();
  }
});

test("Monochrome postprocessing preserves characters, default-color intent, and inverse selections", async () => {
  const app = await createTestRenderer({ width: 3, height: 1 });
  const colors = uiTheme(app.renderer).colors;
  const buffer = OptimizedBuffer.create(3, 1, "unicode", { owner: app.renderer.nativeScene! });
  try {
    buffer.drawText("ABC", 0, 0, RGBA.fromHex("#FF0000"), colors.selected, TextAttributes.BOLD);
    const before = Buffer.from(buffer.getRealCharBytes()).toString();
    monochromeFrame(buffer, colors);

    expect(Buffer.from(buffer.getRealCharBytes()).toString()).toBe(before);
    buffer.withBuffers(({ fg, bg, attributes }) => {
      for (let offset = 0; offset < fg.length; offset += 4) {
        expect(RGBA.fromArray(fg.subarray(offset, offset + 4)).intent).toBe("default");
        expect(RGBA.fromArray(bg.subarray(offset, offset + 4)).intent).toBe("default");
      }
      expect(attributes[0]! & TextAttributes.BOLD).not.toBe(0);
      expect(attributes[0]! & TextAttributes.INVERSE).not.toBe(0);
    });
  } finally {
    buffer.destroy();
    await app.dispose();
  }
});
