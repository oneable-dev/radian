import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheClipboardImage, loadPromptImages } from "./prompt-attachments.ts";
import { expectError, expectOk } from "../testing/results.ts";

import { tinyPng } from "../testing/image.ts";
const pixelPng = tinyPng();

test("Clipboard images are stored privately and read as actual image blocks", async () => {
  const root = await mkdtemp(join(tmpdir(), "radian-image-input-"));
  try {
    // Use supplied PNG bytes instead of the real OS clipboard.
    const cached = expectOk(await cacheClipboardImage(pixelPng, "image/png", join(root, "cache")));
    expect(cached.kind).toBe("image");
    expect((await stat(cached.path)).mode & 0o777).toBe(0o600);
    expect(await readFile(cached.path)).toEqual(pixelPng);

    const images = expectOk(await loadPromptImages([cached.path]));

    expect(images).toHaveLength(1);
    expect(images[0]!.type).toBe("image");
    expect(images[0]!.mimeType).toBe("image/png");
    expect(images[0]!.data.length).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Image prevalidation never fixes original bytes to low resolution before model resize settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "radian-image-profile-"));
  try {
    const original = tinyPng(3000);
    const path = join(root, "wide.png");

    await writeFile(path, original);

    const images = expectOk(await loadPromptImages([path]));
    expect(Buffer.from(images[0]!.data, "base64")).toEqual(original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Missing or invalid images return failure Results rather than empty attachments", async () => {
  const root = await mkdtemp(join(tmpdir(), "radian-image-errors-"));
  try {
    await writeFile(join(root, "fake.png"), "not an image");

    expect(expectError(await loadPromptImages([join(root, "missing.png")])).code).toBe(
      "STORAGE_FAILED",
    );
    expect(expectError(await loadPromptImages([root])).code).toBe("INVALID_INPUT");
    expect(expectError(await loadPromptImages([join(root, "fake.png")])).code).toBe(
      "INVALID_INPUT",
    );
    expect(
      expectError(await cacheClipboardImage(Buffer.from("invalid"), "image/png", root)).code,
    ).toBe("INVALID_INPUT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
