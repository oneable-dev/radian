import { expect, test } from "bun:test";
import { OptimizedBuffer, RGBA, TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { monochromeFrame } from "./monochrome.ts";
import { uiTheme } from "./theme.ts";

// 용도별 배경이 달라도 단색 모드에서는 선택을 식별할 수 있어야 한다.
test("단색 모드는 메뉴·텍스트 선택의 개별 배경색도 반전 강조로 보존한다", async () => {
  const app = await createTestRenderer({ width: 3, height: 1 });
  const theme = uiTheme(app.renderer);
  const buffer = OptimizedBuffer.create(3, 1, "unicode", { owner: app.renderer.nativeScene! });
  try {
    theme.configure({ palette: [], defaultForeground: null, defaultBackground: null, cursorColor: null,
      mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null,
      highlightForeground: null, highlightBackground: null }, { styles: {
      "completion.selected": { bg: "#123456" }, "transcript.selection": { bg: "#654321" },
    } });
    buffer.drawText("A", 0, 0, theme.styles["ui.label"].fg, theme.styles["completion.selected"].bg!);
    buffer.drawText("B", 1, 0, theme.styles["ui.label"].fg, theme.styles["transcript.selection"].bg!);
    buffer.drawText("C", 2, 0, theme.colors.text, theme.colors.panel);

    monochromeFrame(buffer, theme.colors, theme.styles);

    buffer.withBuffers(({ attributes }) => {
      expect(attributes[0]! & TextAttributes.INVERSE).not.toBe(0);
      expect(attributes[1]! & TextAttributes.INVERSE).not.toBe(0);
      expect(attributes[2]! & TextAttributes.INVERSE).toBe(0);
    });
  } finally { buffer.destroy(); await app.dispose(); }
});

test("단색 후처리는 문자를 바꾸지 않고 기본 색상 의도와 선택의 반전 강조를 보존한다",async()=>{
  const app=await createTestRenderer({width:3,height:1});
  const colors=uiTheme(app.renderer).colors;
  const buffer=OptimizedBuffer.create(3,1,"unicode",{owner:app.renderer.nativeScene!});
  try {
    buffer.drawText("ABC",0,0,RGBA.fromHex("#FF0000"),colors.selected,TextAttributes.BOLD);
    const before=Buffer.from(buffer.getRealCharBytes()).toString();
    monochromeFrame(buffer,colors);

    expect(Buffer.from(buffer.getRealCharBytes()).toString()).toBe(before);
    buffer.withBuffers(({fg,bg,attributes})=>{
      for(let offset=0;offset<fg.length;offset+=4) {
        expect(RGBA.fromArray(fg.subarray(offset,offset+4)).intent).toBe("default");
        expect(RGBA.fromArray(bg.subarray(offset,offset+4)).intent).toBe("default");
      }
      expect(attributes[0]!&TextAttributes.BOLD).not.toBe(0);expect(attributes[0]!&TextAttributes.INVERSE).not.toBe(0);
    });
  }finally{buffer.destroy();await app.dispose();}
});
