import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { ImageContent } from "@earendil-works/pi-ai";
import { HistoryError, InputError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { singleLine, truncateCells } from "../ui/text.ts";

export const maximumPreviewImageBytes = 16 * 1024 * 1024;
export const imageNamesEntryType = "radian.image-names.v1";
const imageId = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const transcriptImageSchema = Type.Object(
  {
    id: imageId,
    name: Type.String({ minLength: 1, maxLength: 1024 }),
    mimeType: Type.String({ minLength: 1, maxLength: 128 }),
    byteLength: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type TranscriptImage = Readonly<Static<typeof transcriptImageSchema>>;
export const transcriptImageQuerySchema = Type.Object(
  { sessionId: Type.String({ minLength: 1, maxLength: 4096 }), imageId },
  { additionalProperties: false },
);
const imageNamesSchema = Type.Array(
  Type.Object(
    { id: imageId, name: Type.String({ minLength: 1, maxLength: 1024 }) },
    { additionalProperties: false },
  ),
);
type ImageName = Static<typeof imageNamesSchema>[number];
export type TranscriptImageData = {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mimeType: string;
};
export type TranscriptImageProvider = (
  sessionId: string,
  imageId: string,
  signal: AbortSignal,
) => Promise<Result<Uint8Array, ExpectedError>>;
const extensions: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
function validBase64(data: string): boolean {
  if (!data.length || data.length % 4 !== 0) return false;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return !/[^A-Za-z0-9+/]/u.test(data.slice(0, data.length - padding));
}

// Descriptors are safe to snapshot; encoded pixels stay in SDK history until explicitly requested.
export class TranscriptImages {
  private readonly identities = new WeakMap<ImageContent, string>();
  private readonly names = new Map<string, string>();
  private readonly images = new Map<string, ImageContent>();

  private identity(image: ImageContent): string {
    let id = this.identities.get(image);
    if (!id) {
      id = createHash("sha256")
        .update(image.mimeType)
        .update("\0")
        .update(image.data)
        .digest("hex");
      this.identities.set(image, id);
    }
    return id;
  }
  restore(value: unknown): Result<void, HistoryError> {
    if (!Value.Check(imageNamesSchema, value))
      return err(
        new HistoryError(
          "HISTORY_CORRUPT",
          "Saved image names are invalid; generated attachment names are shown.",
        ),
      );
    for (const item of value) {
      const name = truncateCells(singleLine(item.name), 256);
      if (name && !this.names.has(item.id)) this.names.set(item.id, name);
    }
    return ok(undefined);
  }
  remember(images: readonly ImageContent[], paths: readonly string[]): readonly ImageName[] {
    const added: ImageName[] = [];
    const cacheRoot = resolve(
      join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "radian", "attachments"),
    );
    for (const [index, image] of images.entries()) {
      const path = paths[index];
      if (!path) continue;
      const id = this.identity(image);
      // Our owned clipboard cache has generated storage names, not original filenames.
      const clipboard = dirname(resolve(path)) === cacheRoot;
      const name =
        this.names.get(id) ??
        (clipboard
          ? `clipboard-${index + 1}.${extensions[image.mimeType] ?? "bin"}`
          : truncateCells(singleLine(basename(path)), 256));
      this.names.set(id, name);
      added.push({ id, name });
    }
    return added;
  }
  describe(image: ImageContent, index: number): TranscriptImage {
    const id = this.identity(image);
    this.images.set(id, image);
    return {
      id,
      name: this.names.get(id) ?? `clipboard-${index + 1}.${extensions[image.mimeType] ?? "bin"}`,
      mimeType: image.mimeType,
      byteLength: Math.max(
        0,
        Math.floor((image.data.length * 3) / 4) -
          (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0),
      ),
    };
  }
  clearReferences(): void {
    this.images.clear();
  }
  read(id: string): Result<TranscriptImageData, InputError> {
    const image = this.images.get(id);
    if (!image)
      return err(new InputError("Image attachment is not available in this conversation."));
    if (!extensions[image.mimeType])
      return err(new InputError("Image preview supports PNG, JPEG, GIF and WebP attachments."));
    if (image.data.length > Math.ceil(maximumPreviewImageBytes / 3) * 4)
      return err(new InputError("Image preview exceeds the 16 MiB safety limit."));
    if (!validBase64(image.data)) return err(new InputError("Stored image data is malformed."));
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.byteLength > maximumPreviewImageBytes)
      return err(new InputError("Image preview exceeds the 16 MiB safety limit."));
    return ok({ bytes, mimeType: image.mimeType });
  }
}
