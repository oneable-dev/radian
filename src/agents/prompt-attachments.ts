import { createHash } from "node:crypto";
import { open, stat, writeFile } from "node:fs/promises";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageContent } from "@earendil-works/pi-ai";
import { capture, InputError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { privateDirectory } from "../runtime/storage.ts";

const imageExtensions = /\.(png|jpe?g|gif|webp)$/iu;
const mimeExtensions: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
// Resource safety, not a text-editor character limit. Oversized input is rejected whole.
const maximumImageBytes = 16 * 1024 * 1024;

export type FileInput = { kind: "image" | "file"; path: string };

function localPath(value: string, cwd: string): string | null {
  if (value.startsWith("file://")) {
    // Node and Bun differ on malformed percent escapes; validate the URI grammar
    // before decoding rather than interpreting an invalid URL as a literal path.
    if (/%(?![\da-f]{2})/iu.test(value)) {
      return null;
    }

    let url: URL;
    try {
      url = new URL(value);
    } catch (error) {
      if (error instanceof TypeError) {
        return null;
      }

      throw error;
    }
    if (
      url.protocol !== "file:" ||
      (url.hostname && url.hostname !== "localhost") ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    try {
      const path = fileURLToPath(url);

      return path.includes("\0") ? null : path;
    } catch (error) {
      if (error instanceof TypeError || error instanceof URIError) {
        return null;
      }

      throw error;
    }
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }

  return isAbsolute(value) || value.startsWith("./") || value.startsWith("../")
    ? resolve(cwd, value)
    : null;
}

export function pastedFiles(text: string, cwd: string): FileInput[] | null {
  const value = text.trim();
  if (!value || value.includes("\0")) {
    return null;
  }

  // Terminal file drops quote or escape paths. Parse only path data, never execute a shell.
  const words: string[] = [];
  let word = "";
  let quote = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      word += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) {
        quote = "";
      } else {
        word += character;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (word) {
        words.push(word);
        word = "";
      }
    } else {
      word += character;
    }
  }
  if (quote || escaped) {
    return null;
  }
  if (word) {
    words.push(word);
  }

  const paths = words.map((item) => localPath(item, cwd));
  // Unquoted prose or command arguments are text, not a guessed filename.
  // Paths containing spaces must use the quotes/escapes supplied by terminal drops.
  const selected = paths.length && paths.every((path) => path !== null) ? paths : null;

  return (
    selected?.map((path) => ({ kind: imageExtensions.test(path) ? "image" : "file", path })) ?? null
  );
}

export function fileInput(path: string, cwd: string): FileInput {
  const absolute = resolve(cwd, path);

  return { kind: imageExtensions.test(absolute) ? "image" : "file", path: absolute };
}

function imageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    Buffer.from(bytes.subarray(1, 8)).equals(Buffer.from("PNG\r\n\x1a\n"))
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    /^GIF8[79]a$/.test(Buffer.from(bytes.subarray(0, 6)).toString("ascii"))
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

export async function loadPromptImages(
  paths: readonly string[],
): Promise<Result<ImageContent[], ExpectedError>> {
  const images: ImageContent[] = [];
  let bytesRead = 0;
  for (const path of paths) {
    if (!path || path.includes("\0")) {
      return err(new InputError("Image paths must be nonempty and contain no NUL bytes."));
    }

    const info = await capture(() => stat(path));
    if (!info.ok) {
      return info;
    }
    if (!info.value.isFile()) {
      return err(new InputError("Image attachment is not a file."));
    }
    if (bytesRead + info.value.size > maximumImageBytes) {
      return err(
        new InputError(
          "Image attachments exceed the 16 MiB safety limit. Input was retained; resize or remove an image.",
        ),
      );
    }

    const loaded = await capture(async () => {
      const file = await open(path, "r");
      try {
        const buffer = Buffer.alloc(info.value.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const chunk = await file.read(buffer, offset, buffer.length - offset, offset);
          if (!chunk.bytesRead) {
            break;
          }

          offset += chunk.bytesRead;
        }

        return buffer.subarray(0, offset);
      } finally {
        await file.close();
      }
    });
    if (!loaded.ok) {
      return loaded;
    }
    if (loaded.value.length > info.value.size) {
      return err(
        new InputError(
          "Image attachment changed while being read; retry after the file finishes writing.",
        ),
      );
    }

    bytesRead += loaded.value.length;
    if (bytesRead > maximumImageBytes) {
      return err(
        new InputError(
          "Image attachments changed size and exceed the 16 MiB safety limit. Input was retained.",
        ),
      );
    }

    const mimeType = imageMime(loaded.value);
    if (!mimeType) {
      return err(new InputError("Unsupported image data. Attach a PNG, JPEG, GIF or WebP image."));
    }

    const image = await resizeImage(loaded.value, mimeType);
    if (!image) {
      return err(
        new InputError(
          "Image could not be decoded within the model input limits. Input was retained.",
        ),
      );
    }

    // Validation must not lock in a generic resize profile. AgentSession applies
    // the actual model/extension-selected profile when this input is consumed.
    images.push({ type: "image", data: loaded.value.toString("base64"), mimeType });
  }

  return ok(images);
}

export async function cacheClipboardImage(
  bytes: Uint8Array,
  mimeType: string,
  cacheRoot = join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
    "radian",
    "attachments",
  ),
): Promise<Result<FileInput, ExpectedError>> {
  if (!mimeExtensions[mimeType] || imageMime(bytes) !== mimeType) {
    return err(new InputError("Clipboard image data is unsupported or malformed."));
  }
  if (bytes.byteLength > maximumImageBytes) {
    return err(
      new InputError("Clipboard image exceeds the 16 MiB safety limit; no data was inserted."),
    );
  }

  const path = join(
    resolve(cacheRoot),
    `${createHash("sha256").update(bytes).digest("hex")}-${crypto.randomUUID()}.${mimeExtensions[mimeType]}`,
  );
  const saved = await capture(async () => {
    await privateDirectory(cacheRoot);
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  });

  return saved.ok ? ok({ kind: "image", path }) : saved;
}
