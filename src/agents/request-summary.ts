import { basename, isAbsolute } from "node:path";
import { Type, type Static } from "typebox";
import { parseJson } from "../errors.ts";
import { singleLine } from "../ui/text.ts";

const maximumPreviewUnits = 4096;
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const requestSummarySchema = Type.Object({
  text: Type.String({ maxLength: maximumPreviewUnits }), images: count, files: count,
  fileName: Type.Optional(Type.String({ maxLength: maximumPreviewUnits })),
}, { additionalProperties: false });
export type RequestSummary = Static<typeof requestSummarySchema>;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Bound this derived display metadata, never the original SDK user message.
function preview(text: string): string {
  const line = singleLine(text);
  if (line.length <= maximumPreviewUnits) return line;
  let result = "";
  for (const { segment } of graphemes.segment(line)) {
    if (result.length + segment.length >= maximumPreviewUnits) break;
    result += segment;
  }
  return result.trimEnd() + "…";
}

export function summarizeRequest(text: string, images: number): RequestSummary {
  let files = 0, fileName: string | undefined;
  // Only Radian's explicit @"absolute path" references count as files. Ordinary
  // filenames, fenced code examples, image extensions and opaque image bytes do not.
  const references = /^ {0,3}(`{3,}|~{3,})[^\n]*|(^|\s)@("(?:[^"\\\x00-\x1f]|\\.)*")(?=\s|$)/gmu;
  let fence: string | undefined;
  let prose = text.replace(references, (match: string, marker: string | undefined, space: string | undefined, encoded: string | undefined) => {
    if (marker !== undefined) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && !match.trimStart().slice(marker.length).trim()) fence = undefined;
      return match;
    }
    if (fence || encoded === undefined) return match;
    const parsed = parseJson(encoded, "request file reference");
    if (!parsed.ok || typeof parsed.value !== "string" || !isAbsolute(parsed.value) || parsed.value.includes("\0")) return match;
    files++; fileName = files === 1 ? preview(basename(parsed.value)) : undefined;
    return space ?? "";
  });
  // These are Radian's rich-input labels, not evidence that an image was sent.
  // Remove them only when the SDK message really contains image content blocks.
  if (images > 0) prose = prose.replace(/\[Image #\d+\]/gu, "");
  return { text: preview(prose), images, files, ...(fileName ? { fileName } : {}) };
}

export function sameRequestSummary(a: RequestSummary | undefined, b: RequestSummary | undefined): boolean {
  return a === b || !!a && !!b && a.text === b.text && a.images === b.images && a.files === b.files && a.fileName === b.fileName;
}
