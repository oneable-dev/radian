type SearchMatcher = (value: string) => boolean;

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

// Literal matchers preserve whitespace, including spaces inside quoted file paths.
export function createPrefixMatcher(query: string): SearchMatcher {
  const needle = normalize(query);
  return (value) => normalize(value).startsWith(needle);
}

export function createSubstringMatcher(query: string): SearchMatcher {
  const needle = normalize(query);
  return (value) => normalize(value).includes(needle);
}

// General search requires every whitespace-delimited term as a contiguous substring.
// Callers own searchable fields and result ordering; queries are prepared once per filter.
export function createTextMatcher(query: string): SearchMatcher {
  const words = normalize(query).trim().split(/\s+/u).filter(Boolean);
  if (!words.length) return () => true;
  return (value) => {
    const text = normalize(value);
    return words.every((word) => text.includes(word));
  };
}
