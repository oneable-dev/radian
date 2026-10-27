import { detectLinks, stringToStyledText } from "@opentui/core";

export type TextLink = { start: number; end: number; url: string };

// Literal text has no concealed labels. Do not reinterpret it as Markdown source.
export function textLinks(text: string): TextLink[] {
  const chunks = detectLinks(stringToStyledText(text).chunks, { content: text, highlights: [] });
  const links: TextLink[] = [];
  let start = 0;
  for (const chunk of chunks) {
    const end = start + chunk.text.length;
    if (chunk.link) links.push({ start, end, url: chunk.link.url });
    start = end;
  }
  return links;
}

export function textLinkAt(text: string, offset: number): string | null {
  if (offset < 0 || offset >= text.length) return null;
  return textLinks(text).find((link) => offset >= link.start && offset < link.end)?.url ?? null;
}
