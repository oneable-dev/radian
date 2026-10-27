// Pure, read-only Vim text semantics. Positions are UTF-16 indices; the UI converts
// them to native display-cell offsets at its boundary, never splitting graphemes.
export type VimRange = { start: number; end: number; linewise?: boolean };
export type VimFind = { kind: "f" | "F" | "t" | "T"; character: string; repeat?: boolean };
export type VimMotion =
  | "left"
  | "right"
  | "up"
  | "down"
  | "word-next"
  | "word-previous"
  | "word-end"
  | "WORD-next"
  | "WORD-previous"
  | "WORD-end"
  | "line-start"
  | "line-first-nonblank"
  | "line-end"
  | "buffer-start"
  | "buffer-end";
export type VimMove = {
  position: number;
  inclusive?: boolean;
  linewise?: boolean;
  wordEnd?: number;
};
export const maximumVimCount = 9999;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const keyword = /[\p{L}\p{N}_]/u;
const blank = /^[ \t]*$/u;

export class VimText {
  readonly boundaries: number[];
  readonly lines = [0];
  private searchCache: { query: string; wholeWord: boolean; matches: number[] } | undefined;
  constructor(readonly text: string) {
    this.boundaries = [];
    for (const segment of segmenter.segment(text)) this.boundaries.push(segment.index);
    this.boundaries.push(text.length);
    for (let index = 0; index < text.length; index++)
      if (text[index] === "\n") this.lines.push(index + 1);
  }
  private index(position: number): number {
    let left = 0,
      right = this.boundaries.length - 1;
    while (left < right) {
      const middle = Math.ceil((left + right) / 2);
      if (this.boundaries[middle]! <= position) left = middle;
      else right = middle - 1;
    }
    return left;
  }
  private character(index: number): string {
    return index < 0 || index >= this.boundaries.length - 1
      ? ""
      : this.text.slice(this.boundaries[index], this.boundaries[index + 1]);
  }
  private group(index: number, big = false): number {
    const character = this.character(index);
    return !character || /\s/u.test(character) ? 0 : big || keyword.test(character) ? 1 : 2;
  }
  endOfCharacter(position: number): number {
    return this.boundaries[Math.min(this.boundaries.length - 1, this.index(position) + 1)]!;
  }
  previousCharacter(position: number): number {
    return this.boundaries[Math.max(0, this.index(position) - 1)]!;
  }
  line(position: number): number {
    let left = 0,
      right = this.lines.length - 1;
    while (left < right) {
      const middle = Math.ceil((left + right) / 2);
      if (this.lines[middle]! <= position) left = middle;
      else right = middle - 1;
    }
    return left;
  }
  lineEnd(line: number): number {
    return line + 1 < this.lines.length ? this.lines[line + 1]! - 1 : this.text.length;
  }
  lineRange(first: number, last = first): VimRange {
    return {
      start: this.lines[Math.max(0, first)]!,
      end: this.lines[Math.min(this.lines.length, last + 1)] ?? this.text.length,
      linewise: true,
    };
  }
  private firstNonblank(line: number): number {
    const start = this.lines[line]!,
      end = this.lineEnd(line);
    let position = start;
    while (position < end && /[ \t]/u.test(this.text[position]!)) position++;
    return position === end && end > start ? this.previousCharacter(end) : position;
  }
  private emptyLine(position: number): boolean {
    const line = this.line(position);
    return this.lines[line] === position && this.lineEnd(line) === position;
  }
  private wordNext(position: number, big: boolean): number {
    let index = this.index(position);
    const group = this.group(index, big);
    if (group)
      while (index < this.boundaries.length - 1 && this.group(index, big) === group) index++;
    else if (this.emptyLine(position) && index < this.boundaries.length - 1) index++;
    while (index < this.boundaries.length - 1 && this.group(index, big) === 0) {
      if (this.emptyLine(this.boundaries[index]!)) break;
      index++;
    }
    return this.boundaries[index]!;
  }
  move(position: number, motion: VimMotion, count = 1, explicitCount = false): VimMove {
    count = Math.max(1, Math.min(maximumVimCount, count));
    const line = this.line(position),
      start = this.lines[line]!,
      end = this.lineEnd(line);
    let index = this.index(position);
    switch (motion) {
      case "left":
        return { position: Math.max(start, this.boundaries[Math.max(0, index - count)]!) };
      case "right":
        return {
          position: Math.min(
            end > start ? this.previousCharacter(end) : start,
            this.boundaries[Math.min(this.boundaries.length - 1, index + count)]!,
          ),
        };
      case "up":
      case "down": {
        const target = Math.max(
          0,
          Math.min(this.lines.length - 1, line + (motion === "down" ? count : -count)),
        );
        return {
          position: Math.min(this.lineEnd(target), this.lines[target]! + position - start),
          linewise: true,
        };
      }
      case "word-next":
      case "WORD-next": {
        let cursor = position,
          wordEnd = position;
        for (let step = 0; step < count; step++) {
          const previous = cursor;
          cursor = this.wordNext(cursor, motion === "WORD-next");
          // The last w of a yank stops at EOL instead of swallowing the next line.
          wordEnd =
            this.group(this.index(previous)) !== 0 && this.line(cursor) > this.line(previous)
              ? this.lineEnd(this.line(previous))
              : cursor;
          if (cursor === this.text.length) break;
        }
        return { position: cursor, wordEnd };
      }
      case "word-previous":
      case "WORD-previous": {
        const big = motion === "WORD-previous";
        for (let step = 0; step < count; step++) {
          if (index > 0) index--;
          while (
            index > 0 &&
            this.group(index, big) === 0 &&
            !this.emptyLine(this.boundaries[index]!)
          )
            index--;
          const group = this.group(index, big);
          while (index > 0 && this.group(index - 1, big) === group && group !== 0) index--;
        }
        return { position: this.boundaries[index]! };
      }
      case "word-end":
      case "WORD-end": {
        const big = motion === "WORD-end";
        for (let step = 0; step < count; step++) {
          if (index < this.boundaries.length - 2) index++;
          while (index < this.boundaries.length - 2 && this.group(index, big) === 0) index++;
          const group = this.group(index, big);
          while (
            index < this.boundaries.length - 2 &&
            this.group(index + 1, big) === group &&
            group !== 0
          )
            index++;
        }
        return { position: this.boundaries[index]!, inclusive: true };
      }
      case "line-start":
        return { position: start };
      case "line-first-nonblank":
        return { position: this.firstNonblank(line) };
      case "line-end": {
        const target = Math.min(this.lines.length - 1, line + count - 1),
          targetEnd = this.lineEnd(target);
        return {
          position: targetEnd > this.lines[target]! ? this.previousCharacter(targetEnd) : targetEnd,
          inclusive: true,
        };
      }
      case "buffer-start":
        return {
          position: explicitCount
            ? this.firstNonblank(Math.min(this.lines.length - 1, count - 1))
            : 0,
          linewise: true,
        };
      // Keep Radian's existing G/C-End section-end behavior; an explicit count selects a line.
      case "buffer-end":
        return {
          position: explicitCount
            ? this.firstNonblank(Math.min(this.lines.length - 1, count - 1))
            : this.text.length,
          inclusive: true,
          linewise: true,
        };
    }
  }
  find(position: number, find: VimFind, count = 1): VimMove | null {
    const line = this.line(position),
      start = this.lines[line]!,
      end = this.lineEnd(line);
    const backwards = find.kind === "F" || find.kind === "T",
      till = find.kind === "t" || find.kind === "T";
    let index = this.index(position),
      found = -1;
    if (find.repeat && till && this.character(index + (backwards ? -1 : 1)) === find.character)
      index += backwards ? -1 : 1;
    for (let step = 0; step < count; step++) {
      found = -1;
      for (
        index += backwards ? -1 : 1;
        index >= 0 && index < this.boundaries.length - 1;
        index += backwards ? -1 : 1
      ) {
        const point = this.boundaries[index]!;
        if (point < start || point >= end) break;
        if (this.character(index) === find.character) {
          found = index;
          break;
        }
      }
      if (found < 0) return null;
    }
    return {
      position: this.boundaries[found + (till ? (backwards ? 1 : -1) : 0)]!,
      inclusive: true,
    };
  }
  motionRange(position: number, move: VimMove): VimRange {
    if (move.linewise)
      return this.lineRange(
        Math.min(this.line(position), this.line(move.position)),
        Math.max(this.line(position), this.line(move.position)),
      );
    const target = move.wordEnd ?? move.position;
    if (target >= position)
      return { start: position, end: move.inclusive ? this.endOfCharacter(target) : target };
    return { start: target, end: move.inclusive ? this.endOfCharacter(position) : position };
  }
  object(position: number, object: string, around: boolean, count = 1): VimRange | null {
    if (object === "w" || object === "W")
      return this.wordObject(position, object === "W", around, count);
    if (object === "p") return this.paragraph(position, around, count);
    if (['"', "'", "`"].includes(object)) return this.quote(position, object, around);
    const pairs: Record<string, readonly [string, string]> = {
      "(": ["(", ")"],
      ")": ["(", ")"],
      b: ["(", ")"],
      "[": ["[", "]"],
      "]": ["[", "]"],
      "{": ["{", "}"],
      "}": ["{", "}"],
      B: ["{", "}"],
      "<": ["<", ">"],
      ">": ["<", ">"],
    };
    const pair = pairs[object];
    if (!pair) return null;
    const [open, close] = pair;
    const stack: number[] = [],
      enclosing: { start: number; end: number }[] = [];
    for (let index = 0; index < this.text.length; index++) {
      if (this.text[index] === "\\") {
        index++;
        continue;
      }
      if (this.text[index] === open) stack.push(index);
      else if (this.text[index] === close && stack.length) {
        const start = stack.pop()!;
        if (start <= position && position <= index) enclosing.push({ start, end: index + 1 });
      }
    }
    enclosing.sort((a, b) => a.end - a.start - (b.end - b.start));
    const range = enclosing[count - 1];
    if (!range || around) return range ?? null;
    let start = range.start + 1,
      end = range.end - 1;
    if (this.text[start] === "\n") start++;
    const closingLine = this.lines[this.line(end)]!;
    if (closingLine >= start && blank.test(this.text.slice(closingLine, end))) end = closingLine;
    return { start, end };
  }
  private wordObject(
    position: number,
    big: boolean,
    around: boolean,
    count: number,
  ): VimRange | null {
    if (position >= this.text.length) return null;
    let first = this.index(position),
      last = first;
    const group = this.group(first, big);
    while (first > 0 && this.group(first - 1, big) === group && this.character(first - 1) !== "\n")
      first--;
    last = this.groupEnd(last, big);
    if (around && group === 0) {
      let next = last + 1;
      while (next < this.boundaries.length - 1 && this.group(next, big) === 0) next++;
      if (next < this.boundaries.length - 1) last = this.groupEnd(next, big);
    }
    for (let step = 1; step < count; step++) {
      let next = last + 1;
      // Inner-word counts include whitespace runs; around-word counts include words.
      if (around) while (next < this.boundaries.length - 1 && this.group(next, big) === 0) next++;
      if (next >= this.boundaries.length - 1) break;
      last = this.groupEnd(next, big);
    }
    if (around && group !== 0) {
      const previous = last;
      while (last + 1 < this.boundaries.length - 1 && /^[ \t]+$/u.test(this.character(last + 1)))
        last++;
      if (last === previous)
        while (first > 0 && /^[ \t]+$/u.test(this.character(first - 1))) first--;
    }
    return { start: this.boundaries[first]!, end: this.boundaries[last + 1]! };
  }
  private groupEnd(index: number, big: boolean): number {
    const kind = this.group(index, big);
    if (this.character(index) === "\n") return index;
    while (
      index + 1 < this.boundaries.length - 1 &&
      this.group(index + 1, big) === kind &&
      this.character(index + 1) !== "\n"
    )
      index++;
    return index;
  }
  private quote(position: number, quote: string, around: boolean): VimRange | null {
    const line = this.line(position),
      positions: number[] = [];
    for (let index = this.lines[line]!; index < this.lineEnd(line); index++) {
      if (this.text[index] === "\\") {
        index++;
        continue;
      }
      if (this.text[index] === quote) positions.push(index);
    }
    for (let index = 0; index + 1 < positions.length; index += 2) {
      const start = positions[index]!,
        end = positions[index + 1]!;
      if (end < position) continue;
      if (!around) return { start: start + 1, end };
      let first = start,
        last = end + 1;
      while (last < this.lineEnd(line) && /[ \t]/u.test(this.text[last]!)) last++;
      if (last === end + 1)
        while (first > this.lines[line]! && /[ \t]/u.test(this.text[first - 1]!)) first--;
      return { start: first, end: last };
    }
    return null;
  }
  private paragraph(position: number, around: boolean, count: number): VimRange {
    const isBlank = (line: number) =>
      blank.test(this.text.slice(this.lines[line], this.lineEnd(line)));
    let first = this.line(position),
      last = first;
    const empty = isBlank(first);
    while (first > 0 && isBlank(first - 1) === empty) first--;
    while (last + 1 < this.lines.length && isBlank(last + 1) === empty) last++;
    for (let step = empty && around ? 0 : 1; step < count; step++) {
      let next = last + 1;
      while (next < this.lines.length && isBlank(next)) next++;
      if (next >= this.lines.length) break;
      last = next;
      while (last + 1 < this.lines.length && !isBlank(last + 1)) last++;
    }
    if (around && !empty) {
      const previous = last;
      while (last + 1 < this.lines.length && isBlank(last + 1)) last++;
      if (last === previous) while (first > 0 && isBlank(first - 1)) first--;
    }
    return this.lineRange(first, last);
  }
  wordAt(position: number): string | null {
    const end = this.lineEnd(this.line(position));
    let cursor = position;
    while (cursor < end && !keyword.test(this.text.slice(cursor, this.endOfCharacter(cursor))))
      cursor = this.endOfCharacter(cursor);
    if (cursor >= end) return null;
    const range = this.wordObject(cursor, false, false, 1);
    return range ? this.text.slice(range.start, range.end) : null;
  }
  search(
    position: number,
    query: string,
    direction: 1 | -1,
    count = 1,
    wholeWord = false,
  ): number | null {
    if (!query) return null;
    let matches =
      this.searchCache?.query === query && this.searchCache.wholeWord === wholeWord
        ? this.searchCache.matches
        : undefined;
    if (!matches) {
      matches = [];
      for (
        let index = this.text.indexOf(query);
        index >= 0;
        index = this.text.indexOf(query, index + 1)
      ) {
        if (
          this.boundaries[this.index(index)] !== index ||
          this.boundaries[this.index(index + query.length)] !== index + query.length
        )
          continue;
        if (
          wholeWord &&
          (keyword.test(this.text.slice(this.previousCharacter(index), index)) ||
            keyword.test(
              this.text.slice(index + query.length, this.endOfCharacter(index + query.length)),
            ))
        )
          continue;
        matches.push(index);
      }
      this.searchCache = { query, wholeWord, matches };
    }
    if (!matches.length) return null;
    const next =
      direction > 0
        ? matches.findIndex((match) => match > position)
        : matches.findLastIndex((match) => match < position);
    const first = next < 0 ? (direction > 0 ? 0 : matches.length - 1) : next;
    return matches[
      (((first + direction * (count - 1)) % matches.length) + matches.length) % matches.length
    ]!;
  }
}
