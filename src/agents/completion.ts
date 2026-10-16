export type CompletionQuery = { readonly kind: "command" | "file"; readonly query: string };
export type CompletionItem = { readonly kind: "command" | "skill" | "template" | "file"; readonly value: string; readonly description: string };
export type CompletionResult = { readonly items: readonly CompletionItem[]; readonly truncated: boolean };
export type CompletionTarget = CompletionQuery & { readonly start: number; readonly end: number };
export const completionLimit = 100;

// Offsets are JavaScript string indices. The UI converts native display-cell offsets at its boundary.
export function completionTarget(text: string, cursor: number): CompletionTarget | null {
  if (cursor < 1 || cursor > text.length) return null;
  for (let start = 0; start < text.length;) {
    if (/\s/u.test(text[start]!)) { start++; continue; }
    let end = start;
    const quoted = text.startsWith('@"', start);
    let closed = false;
    if (quoted) {
      end = start + 2;
      while (end < text.length) {
        if (text[end] === "\\") { end = Math.min(text.length, end + 2); continue; }
        if (text[end++] === '"') { closed = true; break; }
      }
    } else while (end < text.length && !/\s/u.test(text[end]!)) end++;
    if (cursor > start && cursor <= end) {
      if (start === 0 && text[start] === "/") return { kind: "command", start, end, query: text.slice(1, cursor) };
      if (text[start] !== "@") return null;
      const raw = text.slice(start + (quoted ? 2 : 1), Math.min(cursor, closed ? end - 1 : end));
      return { kind: "file", start, end, query: quoted ? decodeQuotedPrefix(raw) : raw };
    }
    start = end;
  }
  return null;
}

function decodeQuotedPrefix(raw: string): string {
  let value = "";
  const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] !== "\\") { value += raw[index]; continue; }
    const next = raw[++index];
    if (next === undefined) break;
    if (next === "u" && /^[\da-f]{4}$/iu.test(raw.slice(index + 1, index + 5))) {
      value += String.fromCharCode(parseInt(raw.slice(index + 1, index + 5), 16)); index += 4;
    } else value += escapes[next] ?? next;
  }
  return value;
}

export function insertCompletion(text: string, target: CompletionTarget, item: CompletionItem): { text: string; cursor: number } {
  const value = item.kind === "file" ? `@${/[\s"\\]/u.test(item.value) ? JSON.stringify(item.value) : item.value}` : `/${item.value}`;
  const insertion = value + (target.end === text.length ? " " : "");
  return { text: text.slice(0, target.start) + insertion + text.slice(target.end), cursor: target.start + insertion.length };
}

export function filterCompletions(items: readonly CompletionItem[], query: string): CompletionResult {
  const needle = query.toLowerCase();
  const matches = items.filter((item) => item.value.toLowerCase().includes(needle));
  matches.sort((a, b) => Number(b.value.toLowerCase().startsWith(needle)) - Number(a.value.toLowerCase().startsWith(needle))
    || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  return { items: matches.slice(0, completionLimit), truncated: matches.length > completionLimit };
}
