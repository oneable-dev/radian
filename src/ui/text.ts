const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function singleLine(text: string): string { return text.replace(/[\s\x00-\x1f\x7f-\x9f]+/gu, " ").trim(); }

export function truncateCells(text: string, width: number, suffix = "…"): string {
  if (width <= 0) return "";
  if (Bun.stringWidth(text) <= width) return text;
  const budget = width - Bun.stringWidth(suffix);
  if (budget < 0) return "";
  let result = "", used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const cells = Bun.stringWidth(segment);
    if (used + cells > budget) break;
    result += segment; used += cells;
  }
  return result.trimEnd() + suffix;
}
