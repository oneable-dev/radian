import { expect, test } from "bun:test";
import { createPrefixMatcher, createSubstringMatcher, createTextMatcher } from "./search.ts";

const matchers = [["prefix", createPrefixMatcher], ["substring", createSubstringMatcher], ["text", createTextMatcher]] as const;

test.each(matchers)("%s matching normalizes Unicode representations and case", (_name, createMatcher) => {
  // Compatibility characters and decomposed accents must share the same search spelling.
  const matches = createMatcher("ＣＡＦÉ");

  const result = matches("Cafe\u0301.log");

  // Normalization must cover both the query and the candidate.
  expect(result).toBe(true);
});

test.each(matchers)("%s matching accepts all candidates for empty queries", (_name, createMatcher) => {
  // Clearing a query must restore candidates, including empty fallback labels.
  const matches = createMatcher("");

  const results = [matches(""), matches("Review-code")];

  // No caller needs a separate empty-query matching policy.
  expect(results).toEqual([true, true]);
});

test("Prefix matching rejects middle substrings and noncontiguous characters", () => {
  // Command discovery must use a contiguous prefix, not another search mode.
  const prefix = createPrefixMatcher("rev"), middle = createPrefixMatcher("view"), fuzzy = createPrefixMatcher("rvc");

  const results = [prefix("Review-code"), prefix("code-review"), middle("review-code"), fuzzy("review-code")];

  // Only the candidate whose leading characters match may be offered for execution.
  expect(results).toEqual([true, false, false, false]);
});

test("Literal matching preserves path spaces instead of splitting AND conditions", () => {
  // Quoted paths can contain significant leading, trailing and internal spaces.
  const prefix = createPrefixMatcher(" file "), substring = createSubstringMatcher(" file ");

  const results = [prefix(" file .ts"), prefix("file .ts"), substring("src/문서 file .ts"), substring("src/문서 file.ts"), substring("src/fi le .ts")];

  // Whitespace is part of the literal token and must remain contiguous.
  expect(results).toEqual([true, false, true, false, false]);
});

test("Substring matching finds mid-name text without regex or fuzzy expansion", () => {
  // File discovery permits basenames while treating punctuation as literal text.
  const substring = createSubstringMatcher("a.b");

  const results = [substring("src/a.b.ts"), substring("src/aXb.ts"), substring("src/a-.b.ts")];

  // A dot must neither become a wildcard nor allow gaps between characters.
  expect(results).toEqual([true, false, false]);
});

test("General search requires all whitespace-separated words regardless of order", () => {
  // General search may combine terms from several caller-selected metadata fields.
  const matches = createTextMatcher("  CODE\tＲＥＶ  ");

  const results = [matches("Review-code"), matches("Review only"), matches("Code only"), createTextMatcher("rvc")("Review-code"), createTextMatcher(" \t ")("anything")];

  // Missing terms and scattered letters are rejected; whitespace-only queries clear the filter.
  expect(results).toEqual([true, false, false, false, true]);
});
