import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheClipboardImage, loadPromptImages } from "./prompt-attachments.ts";
import { expectError, expectOk } from "../testing/results.ts";

import { tinyPng } from "../testing/image.ts";
const pixelPng = tinyPng();

test("클립보드 이미지는 비공개 파일로 보관하고 실제 이미지 블록으로 읽는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "radian-image-input-"));
  try {
    // 실제 OS 클립보드 대신 전달받은 PNG 바이트만 사용한다.
    const cached = expectOk(await cacheClipboardImage(pixelPng, "image/png", join(root, "cache")));
    expect(cached.kind).toBe("image"); expect((await stat(cached.path)).mode & 0o777).toBe(0o600);
    expect(await readFile(cached.path)).toEqual(pixelPng);
    const images = expectOk(await loadPromptImages([cached.path]));

    expect(images).toHaveLength(1); expect(images[0]!.type).toBe("image"); expect(images[0]!.mimeType).toBe("image/png");
    expect(images[0]!.data.length).toBeGreaterThan(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("이미지 사전 검증은 실제 모델의 resize 설정 전에 원본 바이트를 낮은 해상도로 고정하지 않는다", async () => {
  const root=await mkdtemp(join(tmpdir(),"radian-image-profile-"));
  try {
    const original=tinyPng(3000),path=join(root,"wide.png");await writeFile(path,original);
    const images=expectOk(await loadPromptImages([path]));
    expect(Buffer.from(images[0]!.data,"base64")).toEqual(original);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("존재하지 않거나 잘못된 이미지는 빈 첨부 성공이 아닌 실패 Result로 반환한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "radian-image-errors-"));
  try {
    await writeFile(join(root, "fake.png"), "not an image");

    expect(expectError(await loadPromptImages([join(root, "missing.png")])).code).toBe("STORAGE_FAILED");
    expect(expectError(await loadPromptImages([root])).code).toBe("INVALID_INPUT");
    expect(expectError(await loadPromptImages([join(root, "fake.png")])).code).toBe("INVALID_INPUT");
    expect(expectError(await cacheClipboardImage(Buffer.from("invalid"), "image/png", root)).code).toBe("INVALID_INPUT");
  } finally { await rm(root, { recursive: true, force: true }); }
});
