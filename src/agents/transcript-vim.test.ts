import { expect, test } from "bun:test";
import { VimText, maximumVimCount } from "./transcript-vim-text.ts";
import { TranscriptVim, type VimContext, type VimEffect } from "./transcript-vim.ts";

const context = (text: string, cursor = 0, visual = false): VimContext => ({ model: new VimText(text), cursor, visual });
function selected(model: VimText, effect: VimEffect): string {
  if (effect.type !== "select" && effect.type !== "yank") throw new Error(`Expected range, received ${effect.type}`);
  return model.text.slice(effect.range.start, effect.range.end);
}

test.each([
  { text: "alpha beta gamma", cursor: 8, object: "w", around: false, count: 1, expected: "beta" },
  { text: "alpha beta gamma", cursor: 8, object: "w", around: true, count: 1, expected: "beta " },
  { text: "alpha beta gamma", cursor: 13, object: "w", around: true, count: 1, expected: " gamma" },
  { text: "alpha beta gamma", cursor: 5, object: "w", around: false, count: 1, expected: " " },
  { text: "alpha beta gamma", cursor: 5, object: "w", around: true, count: 1, expected: " beta" },
  { text: "alpha beta gamma", cursor: 8, object: "w", around: false, count: 2, expected: "beta " },
  { text: "alpha beta gamma", cursor: 8, object: "w", around: false, count: 3, expected: "beta gamma" },
  { text: "alpha beta gamma delta", cursor: 8, object: "w", around: true, count: 2, expected: "beta gamma " },
  { text: "alpha beta gamma delta", cursor: 5, object: "w", around: true, count: 2, expected: " beta gamma" },
  { text: "one.two next", cursor: 3, object: "w", around: false, count: 1, expected: "." },
  { text: "one.two next", cursor: 3, object: "W", around: false, count: 1, expected: "one.two" },
  { text: "한글 é 👨‍👩‍👧‍👦 끝", cursor: 1, object: "w", around: false, count: 1, expected: "한글" },
  { text: "한글 é 👨‍👩‍👧‍👦 끝", cursor: 4, object: "w", around: false, count: 1, expected: "é" },
  { text: "한글 é 👨‍👩‍👧‍👦 끝", cursor: 6, object: "w", around: false, count: 1, expected: "👨‍👩‍👧‍👦" },
  { text: "outer (one (two) three) tail", cursor: 13, object: "(", around: false, count: 1, expected: "two" },
  { text: "outer (one (two) three) tail", cursor: 13, object: ")", around: true, count: 1, expected: "(two)" },
  { text: "outer (one (two) three) tail", cursor: 13, object: "b", around: false, count: 2, expected: "one (two) three" },
  { text: "before [value] after", cursor: 9, object: "[", around: false, count: 1, expected: "value" },
  { text: "before {value} after", cursor: 9, object: "B", around: true, count: 1, expected: "{value}" },
  { text: "before <value> after", cursor: 9, object: ">", around: false, count: 1, expected: "value" },
  { text: 'before "hello world" after', cursor: 12, object: '"', around: false, count: 1, expected: "hello world" },
  { text: "before 'hello' after", cursor: 10, object: "'", around: true, count: 1, expected: "'hello' " },
  { text: 'before "hello"', cursor: 10, object: '"', around: true, count: 1, expected: ' "hello"' },
  { text: "outer (\n  one\n  two\n) tail", cursor: 11, object: "(", around: false, count: 1, expected: "  one\n  two\n" },
  { text: 'before "say \\"hi\\" now" after', cursor: 16, object: '"', around: false, count: 1, expected: 'say \\"hi\\" now' },
  { text: "first line\nsecond\n\nthird\n\n", cursor: 5, object: "p", around: false, count: 1, expected: "first line\nsecond\n" },
  { text: "first line\nsecond\n\nthird\n\n", cursor: 5, object: "p", around: true, count: 1, expected: "first line\nsecond\n\n" },
])("텍스트 객체 [$object] 내부/주변 범위를 커서 중간에서도 정확히 선택한다: $expected", ({ text, cursor, object, around, count, expected }) => {
  // 이동 범위가 아니라 커서를 포함하는 객체 전체가 선택 대상이다.
  const model = new VimText(text);

  const range = model.object(cursor, object, around, count);

  expect(range).not.toBeNull(); expect(text.slice(range!.start, range!.end)).toBe(expected);
});

test.each([
  { motion: "word-next", cursor: 0, count: 1, expected: "alpha " },
  { motion: "word-next", cursor: 6, count: 1, expected: "beta" },
  { motion: "word-next", cursor: 0, count: 2, expected: "alpha beta" },
  { motion: "word-next", cursor: 0, count: 3, expected: "alpha beta\ngamma " },
  { motion: "word-end", cursor: 8, count: 1, expected: "ta" },
  { motion: "word-previous", cursor: 8, count: 1, expected: "be" },
  { motion: "line-end", cursor: 6, count: 1, expected: "beta" },
] as const)("y + [$motion] 이동의 포함/제외 및 줄 끝 규칙을 지킨다", ({ motion, cursor, count, expected }) => {
  // Visual의 inclusive 선택과 yank 연산자의 exclusive 범위를 혼동하지 않는다.
  const model = new VimText("alpha beta\ngamma delta");

  const move = model.move(cursor, motion, count), range = model.motionRange(cursor, move);

  expect(model.text.slice(range.start, range.end)).toBe(expected);
});

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
] as const)("모션 [$motion] 구두점·WORD·논리 줄 경계와 횟수를 구분한다", ({ motion, cursor, count, explicit, expected }) => {
  // w와 W는 구두점을 다르게 처리하고 숫자는 줄 번호에도 적용된다.
  const model = new VimText("one.two next\n  last");

  const result = model.move(cursor, motion, count, explicit);

  expect(result.position).toBe(expected);
});

test("w/b는 빈 줄을 한 단어로 세되 공백뿐인 줄은 건너뛴다", () => {
  // Vim의 빈 줄 경계는 단순한 whitespace 토큰 분리와 다르다.
  const model = new VimText("alpha\n\nbeta"), spaced = new VimText("alpha\n   \nbeta");

  const first = model.move(0, "word-next"), second = model.move(0, "word-next", 2), back = model.move(7, "word-previous");

  expect(first.position).toBe(6); expect(second.position).toBe(7); expect(back.position).toBe(6);
  expect(spaced.move(0, "word-next").position).toBe(10); expect(model.move(4, "word-end").position).toBe(10);
});

test("viw와 yiw는 같은 객체를 사용하되 선택과 복사 효과를 분리한다", () => {
  // 단어 중간에서 v + i + w를 눌러도 다음 단어 첫 글자가 섞이면 안 된다.
  const visual = context("alpha beta gamma", 8, true), normal = context(visual.model.text, 8), vim = new TranscriptVim();

  vim.command("inner", visual); const selection = vim.character("w", visual);
  vim.command("yank", normal); vim.command("inner", normal); const yank = vim.character("w", normal);

  expect(selection.type).toBe("select"); expect(yank.type).toBe("yank");
  expect(selected(visual.model, selection)).toBe("beta"); expect(selected(normal.model, yank)).toBe("beta"); expect(vim.pending).toBe(false);
});

test("연산자 앞뒤의 횟수는 곱하고 yy는 현재 줄부터 실제 개행까지 복사한다", () => {
  // 2y2w는 네 단어 범위이며 커서나 텍스트를 직접 수정하지 않는다.
  const state = context("one two three four five\nsecond line", 0), vim = new TranscriptVim();

  vim.digit("2"); vim.command("yank", state); vim.digit("2"); const words = vim.command("word-next", state);
  vim.digit("2"); vim.command("yank", state); const lines = vim.command("yank", state);

  expect(selected(state.model, words)).toBe("one two three four ");
  expect(selected(state.model, lines)).toBe(state.model.text); expect(state.cursor).toBe(0);
});

test("정상적인 모션 횟수와 잘못된 접두어 취소는 상태를 다음 명령에 누출하지 않는다", () => {
  // 입력하지 않은 편집 동작이나 이전 연산자가 뒤의 이동을 복사로 바꾸면 안 된다.
  const state = context("one two three four"), vim = new TranscriptVim();

  vim.digit("3"); const move = vim.command("word-next", state);
  vim.command("yank", state); vim.cancel(); const next = vim.command("word-next", state);
  for (let index = 0; index < 20; index++) vim.digit("9");

  expect(move).toEqual({ type: "move", position: 14 }); expect(next).toEqual({ type: "move", position: 4 });
  expect(vim.status).toBe(String(maximumVimCount)); vim.cancel(); expect(vim.status).toBe("");
});

test("스트리밍으로 결합문자가 생겨도 yank는 현재 grapheme 경계에서 시작한다", () => {
  // pending 단계에 저장한 옛 UTF-16 인덱스는 새 결합문자 내부가 될 수 있다.
  const vim = new TranscriptVim(); vim.command("yank", context("e", 1));
  const updated = context("é tail", 2);

  const effect = vim.command("word-next", updated);

  expect(selected(updated.model, effect)).toBe(" "); expect(updated.model.text).toBe("é tail");
});

test("f/t 찾기와 세미콜론·쉼표 반복은 인접한 대상에 갇히지 않는다", () => {
  // t의 반복은 바로 옆의 이전 대상이 아닌 다음 대상까지 진행해야 한다.
  const model = new VimText("a.b.c.d"), vim = new TranscriptVim();

  vim.command("till-forward", { model, cursor: 0, visual: false }); const first = vim.character(".", { model, cursor: 0, visual: false });
  const next = vim.command("find-repeat", { model, cursor: 0, visual: false });
  const back = vim.command("find-reverse", { model, cursor: 2, visual: false });

  expect(first).toEqual({ type: "move", position: 0 }); expect(next).toEqual({ type: "move", position: 2 });
  expect(back).toEqual({ type: "move", position: 2 });
  expect(model.find(0, { kind: "f", character: "z" })).toBeNull();
});

test("검색은 현재 위치 다음부터 양방향으로 순환하며 단어 경계를 구분한다", () => {
  // literal 검색의 마침표와 단어 검색의 부분 일치 제한을 독립적으로 검증한다.
  const model = new VimText("alpha beta alpha betamax alpha"), literal = new VimText("a.b aXb");

  const forward = model.search(0, "alpha", 1, 2), backward = model.search(0, "alpha", -1);
  const word = model.search(0, "beta", 1, 1, true), dot = literal.search(0, "a.b", 1);

  expect(forward).toBe(25); expect(backward).toBe(25); expect(word).toBe(6); expect(dot).toBe(0);
  expect(model.search(0, "absent", 1)).toBeNull();
});

test("n/N은 검색 원래 방향을 보존하고 빈 검색은 직전 검색을 반복한다", () => {
  // 역방향 반복을 실행해도 마지막 검색 자체의 방향을 뒤집지 않는다.
  const vim = new TranscriptVim(), state = context("one two one two one", 8);

  const first = vim.submitSearch("one", -1, state), reverse = vim.command("search-previous", state);
  const next = vim.command("search-next", state), empty = vim.submitSearch("", 1, state);

  expect(first).toEqual({ type: "move", position: 0 }); expect(reverse).toEqual({ type: "move", position: 16 });
  expect(next).toEqual({ type: "move", position: 0 }); expect(empty).toEqual({ type: "move", position: 16 });
});
