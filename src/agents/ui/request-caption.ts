import type { RequestSummary } from "../request-summary.ts";
import type { TranscriptSection } from "../transcript.ts";
import { singleLine, truncateCells } from "../../ui/text.ts";

// Legacy sections retain their text but supply no guessed attachment counts.
export function requestForSection(section: TranscriptSection | undefined): RequestSummary | undefined {
  if (section?.image) return section.request;
  if (!section || section.kind !== "user" && section.skillName === undefined) return undefined;
  return section.request ?? { text: section.skillName !== undefined ? `/skill:${section.skillName}` : singleLine(section.text), images: 0, files: 0 };
}

export function formatRequestCaption(request: RequestSummary, width: number): string {
  if (width <= 0) return "";
  const text = singleLine(request.text);
  const image = request.images ? `[${request.images} ${request.images === 1 ? "image" : "images"}]` : "";
  const file = request.files ? `[${request.files} ${request.files === 1 ? "file" : "files"}]` : "";
  const namedFile = request.files === 1 && request.fileName ? `[File: ${singleLine(request.fileName)}]` : file;
  let badges = [image, namedFile].filter(Boolean).join(" ");
  if (Bun.stringWidth(badges) > width) badges = [image, file].filter(Boolean).join(" ");
  if (Bun.stringWidth(badges) > width) {
    badges = `[${[request.images ? `${request.images}I` : "", request.files ? `${request.files}F` : ""].filter(Boolean).join(" ")}]`;
    return truncateCells(badges, width);
  }
  if (!badges) return truncateCells(text, width);
  const excerpt = truncateCells(text, width - Bun.stringWidth(badges) - 2);
  return excerpt ? `${excerpt}  ${badges}` : badges;
}
