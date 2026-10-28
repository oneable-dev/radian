import { expect, test } from "bun:test";
import { VimText, maximumVimCount } from "./transcript-vim-text.ts";
import { TranscriptVim, type VimContext, type VimEffect } from "./transcript-vim.ts";

const context = (text: string, cursor = 0, visual = false): VimContext => ({
  model: new VimText(text),
  cursor,
  visual,
});

function selected(model: VimText, effect: VimEffect): string {
  if (effect.type !== "select" && effect.type !== "yank") {
    throw new Error(`Expected range, received ${effect.type}`);
  }

  return model.text.slice(effect.range.start, effect.range.end);
}

test.each([
  { text: "alpha beta gamma", cursor: 8, object: "w", around: false, count: 1, expected: "beta" },
  { text: "alpha beta gamma", cursor: 8, object: "w", around: true, count: 1, expected: "beta " },
  { text: "alpha beta gamma", cursor: 13, object: "w", around: true, count: 1, expected: " gamma" },
  { text: "alpha beta gamma", cursor: 5, object: "w", around: false, count: 1, expected: " " },
  { text: "alpha beta gamma", cursor: 5, object: "w", around: true, count: 1, expected: " beta" },
  { text: "alpha beta gamma", cursor: 8, object: "w", around: false, count: 2, expected: "beta " },
  {
    text: "alpha beta gamma",
    cursor: 8,
    object: "w",
    around: false,
    count: 3,
    expected: "beta gamma",
  },
  {
    text: "alpha beta gamma delta",
    cursor: 8,
    object: "w",
    around: true,
    count: 2,
    expected: "beta gamma ",
  },
  {
    text: "alpha beta gamma delta",
    cursor: 5,
    object: "w",
    around: true,
    count: 2,
    expected: " beta gamma",
  },
  { text: "one.two next", cursor: 3, object: "w", around: false, count: 1, expected: "." },
  { text: "one.two next", cursor: 3, object: "W", around: false, count: 1, expected: "one.two" },
  { text: "한글 é 👨‍👩‍👧‍👦 끝", cursor: 1, object: "w", around: false, count: 1, expected: "한글" },
  { text: "한글 é 👨‍👩‍👧‍👦 끝", cursor: 4, object: "w", around: false, count: 1, expected: "é" },
  { text: "한글 é 👨‍👩‍👧‍👦 끝", cursor: 6, object: "w", around: false, count: 1, expected: "👨‍👩‍👧‍👦" },
  {
    text: "outer (one (two) three) tail",
    cursor: 13,
    object: "(",
    around: false,
    count: 1,
    expected: "two",
  },
  {
    text: "outer (one (two) three) tail",
    cursor: 13,
    object: ")",
    around: true,
    count: 1,
    expected: "(two)",
  },
  {
    text: "outer (one (two) three) tail",
    cursor: 13,
    object: "b",
    around: false,
    count: 2,
    expected: "one (two) three",
  },
  {
    text: "before [value] after",
    cursor: 9,
    object: "[",
    around: false,
    count: 1,
    expected: "value",
  },
  {
    text: "before {value} after",
    cursor: 9,
    object: "B",
    around: true,
    count: 1,
    expected: "{value}",
  },
  {
    text: "before <value> after",
    cursor: 9,
    object: ">",
    around: false,
    count: 1,
    expected: "value",
  },
  {
    text: 'before "hello world" after',
    cursor: 12,
    object: '"',
    around: false,
    count: 1,
    expected: "hello world",
  },
  {
    text: "before 'hello' after",
    cursor: 10,
    object: "'",
    around: true,
    count: 1,
    expected: "'hello' ",
  },
  { text: 'before "hello"', cursor: 10, object: '"', around: true, count: 1, expected: ' "hello"' },
  {
    text: "outer (\n  one\n  two\n) tail",
    cursor: 11,
    object: "(",
    around: false,
    count: 1,
    expected: "  one\n  two\n",
  },
  {
    text: 'before "say \\"hi\\" now" after',
    cursor: 16,
    object: '"',
    around: false,
    count: 1,
    expected: 'say \\"hi\\" now',
  },
  {
    text: "first line\nsecond\n\nthird\n\n",
    cursor: 5,
    object: "p",
    around: false,
    count: 1,
    expected: "first line\nsecond\n",
  },
  {
    text: "first line\nsecond\n\nthird\n\n",
    cursor: 5,
    object: "p",
    around: true,
    count: 1,
    expected: "first line\nsecond\n\n",
  },
])(
  "Text object [$object] selects precise inner/around ranges from interior cursors: $expected",
  ({ text, cursor, object, around, count, expected }) => {
    // Select the whole object containing the cursor, not a motion range.
    const model = new VimText(text);

    const range = model.object(cursor, object, around, count);

    expect(range).not.toBeNull();
    expect(text.slice(range!.start, range!.end)).toBe(expected);
  },
);

test.each([
  { motion: "word-next", cursor: 0, count: 1, expected: "alpha " },
  { motion: "word-next", cursor: 6, count: 1, expected: "beta" },
  { motion: "word-next", cursor: 0, count: 2, expected: "alpha beta" },
  { motion: "word-next", cursor: 0, count: 3, expected: "alpha beta\ngamma " },
  { motion: "word-end", cursor: 8, count: 1, expected: "ta" },
  { motion: "word-previous", cursor: 8, count: 1, expected: "be" },
  { motion: "line-end", cursor: 6, count: 1, expected: "beta" },
] as const)(
  "y + [$motion] follows inclusive/exclusive motion and line-end rules",
  ({ motion, cursor, count, expected }) => {
    // Distinguish inclusive Visual selections from exclusive yank ranges.
    const model = new VimText("alpha beta\ngamma delta");

    const move = model.move(cursor, motion, count);
    const range = model.motionRange(cursor, move);

    expect(model.text.slice(range.start, range.end)).toBe(expected);
  },
);

test.each([
  { motion: "word-next", cursor: 0, count: 1, explicit: false, expected: 3 },
  { motion: "WORD-next", cursor: 0, count: 1, explicit: false, expected: 8 },
  { motion: "word-end", cursor: 0, count: 1, explicit: false, expected: 2 },
  { motion: "WORD-end", cursor: 0, count: 1, explicit: false, expected: 6 },
  { motion: "word-previous", cursor: 10, count: 1, explicit: false, expected: 8 },
  { motion: "WORD-previous", cursor: 6, count: 1, explicit: false, expected: 0 },
  { motion: "line-first-nonblank", cursor: 16, count: 1, explicit: false, expected: 15 },
  { motion: "line-end", cursor: 0, count: 2, explicit: false, expected: 18 },
  { motion: "buffer-start", cursor: 0, count: 2, explicit: true, expected: 15 },
  { motion: "buffer-end", cursor: 0, count: 1, explicit: false, expected: 19 },
  { motion: "left", cursor: 0, count: 1, explicit: false, expected: 0 },
  { motion: "right", cursor: 11, count: 1, explicit: false, expected: 11 },
] as const)(
  "Motion [$motion] distinguishes punctuation, WORD, logical lines, and counts",
  ({ motion, cursor, count, explicit, expected }) => {
    // w and W handle punctuation differently; counts also apply to line numbers.
    const model = new VimText("one.two next\n  last");

    const result = model.move(cursor, motion, count, explicit);

    expect(result.position).toBe(expected);
  },
);

test("w/b count empty lines as words but skip whitespace-only lines", () => {
  // Vim empty-line boundaries differ from simple whitespace tokenization.
  const model = new VimText("alpha\n\nbeta");
  const spaced = new VimText("alpha\n   \nbeta");

  const first = model.move(0, "word-next");
  const second = model.move(0, "word-next", 2);
  const back = model.move(7, "word-previous");

  expect(first.position).toBe(6);
  expect(second.position).toBe(7);
  expect(back.position).toBe(6);
  expect(spaced.move(0, "word-next").position).toBe(10);
  expect(model.move(4, "word-end").position).toBe(10);
});

test("viw and yiw share objects while separating selection from copying", () => {
  // v + i + w inside a word must not include the next word's first character.
  const visual = context("alpha beta gamma", 8, true);
  const normal = context(visual.model.text, 8);
  const vim = new TranscriptVim();

  vim.command("inner", visual);

  const selection = vim.character("w", visual);
  vim.command("yank", normal);
  vim.command("inner", normal);

  const yank = vim.character("w", normal);

  expect(selection.type).toBe("select");
  expect(yank.type).toBe("yank");
  expect(selected(visual.model, selection)).toBe("beta");
  expect(selected(normal.model, yank)).toBe("beta");
  expect(vim.pending).toBe(false);
});

test("Operator counts multiply and yy copies from the current line through its actual newline", () => {
  // 2y2w spans four words without directly changing cursor or text.
  const state = context("one two three four five\nsecond line", 0);
  const vim = new TranscriptVim();

  vim.digit("2");
  vim.command("yank", state);
  vim.digit("2");

  const words = vim.command("word-next", state);
  vim.digit("2");
  vim.command("yank", state);

  const lines = vim.command("yank", state);

  expect(selected(state.model, words)).toBe("one two three four ");
  expect(selected(state.model, lines)).toBe(state.model.text);
  expect(state.cursor).toBe(0);
});

test("Motion counts and invalid-prefix cancellation never leak state into later commands", () => {
  // Unsupported edits and stale operators must not turn later motions into copying.
  const state = context("one two three four");
  const vim = new TranscriptVim();

  vim.digit("3");

  const move = vim.command("word-next", state);
  vim.command("yank", state);
  vim.cancel();

  const next = vim.command("word-next", state);
  for (let index = 0; index < 20; index++) {
    vim.digit("9");
  }

  expect(move).toEqual({ type: "move", position: 14 });
  expect(next).toEqual({ type: "move", position: 4 });
  expect(vim.status).toBe(String(maximumVimCount));
  vim.cancel();
  expect(vim.status).toBe("");
});

test("Yank starts at current grapheme boundaries after combining characters stream in", () => {
  // A pending UTF-16 index can end up inside a newly combined grapheme.
  const vim = new TranscriptVim();
  vim.command("yank", context("e", 1));

  const updated = context("é tail", 2);

  const effect = vim.command("word-next", updated);

  expect(selected(updated.model, effect)).toBe(" ");
  expect(updated.model.text).toBe("é tail");
});

test("f/t and semicolon/comma repeats never get stuck on adjacent targets", () => {
  // Repeating t must advance past the adjacent previous target.
  const model = new VimText("a.b.c.d");
  const vim = new TranscriptVim();

  vim.command("till-forward", { model, cursor: 0, visual: false });

  const first = vim.character(".", { model, cursor: 0, visual: false });
  const next = vim.command("find-repeat", { model, cursor: 0, visual: false });
  const back = vim.command("find-reverse", { model, cursor: 2, visual: false });

  expect(first).toEqual({ type: "move", position: 0 });
  expect(next).toEqual({ type: "move", position: 2 });
  expect(back).toEqual({ type: "move", position: 2 });
  expect(model.find(0, { kind: "f", character: "z" })).toBeNull();
});

test("Search wraps bidirectionally after the current position and respects word boundaries", () => {
  // Test literal dots independently from whole-word substring restrictions.
  const model = new VimText("alpha beta alpha betamax alpha");
  const literal = new VimText("a.b aXb");

  const forward = model.search(0, "alpha", 1, 2);
  const backward = model.search(0, "alpha", -1);
  const word = model.search(0, "beta", 1, 1, true);
  const dot = literal.search(0, "a.b", 1);

  expect(forward).toBe(25);
  expect(backward).toBe(25);
  expect(word).toBe(6);
  expect(dot).toBe(0);
  expect(model.search(0, "absent", 1)).toBeNull();
});

test("n/N preserve original search direction and empty searches repeat the previous query", () => {
  // Reverse repetition must not change the original search direction.
  const vim = new TranscriptVim();
  const state = context("one two one two one", 8);

  const first = vim.submitSearch("one", -1, state);
  const reverse = vim.command("search-previous", state);
  const next = vim.command("search-next", state);
  const empty = vim.submitSearch("", 1, state);

  expect(first).toEqual({ type: "move", position: 0 });
  expect(reverse).toEqual({ type: "move", position: 16 });
  expect(next).toEqual({ type: "move", position: 0 });
  expect(empty).toEqual({ type: "move", position: 16 });
});
