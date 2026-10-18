import { expect, test } from "bun:test";
import { OptimizedBuffer, RGBA, TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { monochromeFrame } from "./monochrome.ts";
import { uiTheme } from "./theme.ts";

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
