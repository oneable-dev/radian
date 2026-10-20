// Ordered, case-insensitive matching without filesystem access or per-keystroke IPC.
export function fuzzyMatch(value: string, query: string): boolean {
  const normalized = query.normalize("NFKC").toLowerCase().trim();
  if (!normalized) return true;
  const text = value.normalize("NFKC").toLowerCase();
  return normalized.split(/\s+/u).every(word => {
    let offset = 0;
    for (const char of word) {
      const at = text.indexOf(char, offset); if (at < 0) return false;
      offset = at + char.length;
    }
    return true;
  });
}
