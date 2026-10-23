import { detectLinks, stringToStyledText } from "@opentui/core";

// Literal text has no concealed labels. Formatted Markdown uses native hyperlink
// metadata instead, so never reinterpret its displayed text as Markdown source.
export function transcriptLinkAt(text: string, offset: number): string | null {
  if (offset < 0 || offset >= text.length) return null;
  const chunks = detectLinks(stringToStyledText(text).chunks, { content: text, highlights: [] });
  let start = 0;
  for (const chunk of chunks) {
    const end = start + chunk.text.length;
    if (offset >= start && offset < end) return chunk.link?.url ?? null;
    start = end;
  }
  return null;
}
