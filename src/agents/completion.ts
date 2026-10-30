import { createPrefixMatcher, createSubstringMatcher } from "../search.ts";

export type CompletionQuery = {
  readonly kind: "command" | "skill" | "file" | "argument";
  readonly query: string;
  readonly command?: string;
};

export type CompletionCatalog = {
  readonly conversationId: string;
  readonly revision: number;
  readonly items: readonly CompletionItem[];
};

export type CompletionItem = {
  readonly kind: "command" | "skill" | "template" | "file" | "argument";
  readonly value: string;
  readonly description: string;
  readonly hasArguments?: boolean;
};

export type CompletionResult = {
  readonly items: readonly CompletionItem[];
  readonly truncated: boolean;
};

export type CompletionTarget = CompletionQuery & { readonly start: number; readonly end: number };

export const completionLimit = 100;

// Offsets are JavaScript string indices. The UI converts native display-cell offsets at its boundary.
export function completionTarget(text: string, cursor: number): CompletionTarget | null {
  if (cursor < 1 || cursor > text.length) {
    return null;
  }
  for (let start = 0; start < text.length;) {
    if (/\s/u.test(text[start]!)) {
      start++;
      continue;
    }

    let end = start;
    const quoted = text.startsWith('@"', start);
    let closed = false;
    if (quoted) {
      end = start + 2;
      while (end < text.length) {
        if (text[end] === "\\") {
          end = Math.min(text.length, end + 2);
          continue;
        }
        if (text[end++] === '"') {
          closed = true;
          break;
        }
      }
    } else {
      while (end < text.length && !/\s/u.test(text[end]!)) {
        end++;
      }
    }
    if (cursor > start && cursor <= end) {
      if (start === 0 && (text[start] === "/" || text[start] === "$")) {
        return {
          kind: text[start] === "$" ? "skill" : "command",
          start,
          end,
          query: text.slice(1, cursor),
        };
      }
      if (text[start] !== "@") {
        break;
      }

      const raw = text.slice(start + (quoted ? 2 : 1), Math.min(cursor, closed ? end - 1 : end));

      return { kind: "file", start, end, query: quoted ? decodeQuotedPrefix(raw) : raw };
    }

    start = end;
  }

  const invocation = /^\/([^\s]+)\s+/u.exec(text);
  if (invocation && cursor >= invocation[0].length) {
    let end = cursor;
    while (end < text.length && !/\s/u.test(text[end]!)) end++;
    return {
      kind: "argument",
      command: invocation[1]!,
      query: text.slice(invocation[0].length, cursor),
      start: invocation[0].length,
      end,
    };
  }
  return null;
}

function decodeQuotedPrefix(raw: string): string {
  let value = "";
  const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] !== "\\") {
      value += raw[index];
      continue;
    }

    const next = raw[++index];
    if (next === undefined) {
      break;
    }
    if (next === "u" && /^[\da-f]{4}$/iu.test(raw.slice(index + 1, index + 5))) {
      value += String.fromCharCode(parseInt(raw.slice(index + 1, index + 5), 16));
      index += 4;
    } else {
      value += escapes[next] ?? next;
    }
  }

  return value;
}

export function insertCompletion(
  text: string,
  target: CompletionTarget,
  item: CompletionItem,
): { text: string; cursor: number } {
  const value =
    target.kind === "argument"
      ? item.value
      : item.kind === "file"
        ? `@${/[\s"\\]/u.test(item.value) ? JSON.stringify(item.value) : item.value}`
        : target.kind === "skill"
          ? `$${item.value.replace(/^skill:/u, "")}`
          : `/${item.value}`;
  const insertion = value + (target.end === text.length && !/\s$/u.test(value) ? " " : "");

  return {
    text: text.slice(0, target.start) + insertion + text.slice(target.end),
    cursor: target.start + insertion.length,
  };
}

// Only a leading skill token is an invocation; shell variables and inline prose stay literal.
export function expandSkillInvocation(text: string, knownSkills: readonly string[] = []): string {
  const token = /^\$([^\s]+)/u.exec(text);
  if (token && knownSkills.includes(token[1]!)) {
    return `/skill:${token[1]}${text.slice(token[0].length)}`;
  }

  return text.replace(/^\$([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/u, "/skill:$1");
}

export function filterCatalog(
  items: readonly CompletionItem[],
  query: CompletionQuery,
): CompletionResult {
  if (query.kind === "argument") return { items: [], truncated: false };
  const candidates =
    query.kind === "skill"
      ? items
          .filter((item) => item.kind === "skill")
          .map((item) => ({ ...item, value: item.value.replace(/^skill:/u, "") }))
      : items.filter((item) => item.kind !== "skill" && item.kind !== "file");

  return filterCompletions(candidates, query.query);
}

export function filterCompletions(
  items: readonly CompletionItem[],
  query: string,
): CompletionResult {
  const prefix = createPrefixMatcher(query);
  const substring = createSubstringMatcher(query);
  const matches = items.filter((item) =>
    item.kind === "file" ? substring(item.value) : prefix(item.value),
  );

  matches.sort(
    (a, b) =>
      Number(prefix(b.value)) - Number(prefix(a.value)) ||
      (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
  );

  return { items: matches.slice(0, completionLimit), truncated: matches.length > completionLimit };
}
