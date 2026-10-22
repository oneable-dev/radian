import { expect, test } from "bun:test";
import { createPrefixMatcher, createSubstringMatcher, createTextMatcher } from "./search.ts";

const matchers = [["접두사", createPrefixMatcher], ["부분 문자열", createSubstringMatcher], ["일반 검색", createTextMatcher]] as const;

test.each(matchers)("%s 매칭은 Unicode 표기와 대소문자를 정규화한다", (_name, createMatcher) => {
  // Compatibility characters and decomposed accents must share the same search spelling.
  const matches = createMatcher("ＣＡＦÉ");

  const result = matches("Cafe\u0301.log");

  // Normalization must cover both the query and the candidate.
  expect(result).toBe(true);
});

test.each(matchers)("%s 매칭의 빈 검색어는 모든 후보를 허용한다", (_name, createMatcher) => {
  // Clearing a query must restore candidates, including empty fallback labels.
  const matches = createMatcher("");

  const results = [matches(""), matches("Review-code")];

  // No caller needs a separate empty-query matching policy.
  expect(results).toEqual([true, true]);
});

test("접두사 매칭은 중간 문자열과 떨어진 글자를 허용하지 않는다", () => {
  // Command discovery must use a contiguous prefix, not another search mode.
  const prefix = createPrefixMatcher("rev"), middle = createPrefixMatcher("view"), fuzzy = createPrefixMatcher("rvc");

  const results = [prefix("Review-code"), prefix("code-review"), middle("review-code"), fuzzy("review-code")];

  // Only the candidate whose leading characters match may be offered for execution.
  expect(results).toEqual([true, false, false, false]);
});

test("리터럴 매칭은 경로의 공백을 자르거나 AND 조건으로 분리하지 않는다", () => {
  // Quoted paths can contain significant leading, trailing and internal spaces.
  const prefix = createPrefixMatcher(" file "), substring = createSubstringMatcher(" file ");

  const results = [prefix(" file .ts"), prefix("file .ts"), substring("src/문서 file .ts"), substring("src/문서 file.ts"), substring("src/fi le .ts")];

  // Whitespace is part of the literal token and must remain contiguous.
  expect(results).toEqual([true, false, true, false, false]);
});

test("부분 문자열 매칭은 이름 중간을 찾되 정규식이나 퍼지 검색으로 확장하지 않는다", () => {
  // File discovery permits basenames while treating punctuation as literal text.
  const substring = createSubstringMatcher("a.b");

  const results = [substring("src/a.b.ts"), substring("src/aXb.ts"), substring("src/a-.b.ts")];

  // A dot must neither become a wildcard nor allow gaps between characters.
  expect(results).toEqual([true, false, false]);
});

test("일반 검색은 공백으로 구분한 모든 단어를 순서와 무관하게 포함해야 한다", () => {
  // General search may combine terms from several caller-selected metadata fields.
  const matches = createTextMatcher("  CODE\tＲＥＶ  ");

  const results = [matches("Review-code"), matches("Review only"), matches("Code only"), createTextMatcher("rvc")("Review-code"), createTextMatcher(" \t ")("anything")];

  // Missing terms and scattered letters are rejected; whitespace-only queries clear the filter.
  expect(results).toEqual([true, false, false, false, true]);
});
