import { expect, test } from "bun:test";
import { transcriptLinkAt } from "./transcript-links.ts";

test.each([
  {
    text: "See https://example.invalid/docs, next",
    at: "example",
    url: "https://example.invalid/docs",
  },
  { text: "(http://localhost:3000/a_(b)).", at: "localhost", url: "http://localhost:3000/a_(b)" },
  { text: "Use `http://localhost:3000`", at: "localhost", url: "http://localhost:3000" },
])(
  "Literal-body URLs under cursors stay distinct from sentence punctuation: $text",
  ({ text, at, url }) => {
    // Distinguish URL parentheses from trailing sentence punctuation.
    const offset = text.indexOf(at);

    // Use the native renderer's plain-URL detection rules.
    const result = transcriptLinkAt(text, offset);

    // Never pass surrounding markers to the browser.
    expect(result).toBe(url);
  },
);

test.each([-1, 0, 6, 43])("Cursor positions %i outside links never open another link", (offset) => {
  // A URL elsewhere on the line is not a link under the cursor.
  const text = "Before https://example.invalid after";

  const result = transcriptLinkAt(text, offset);

  expect(result).toBeNull();
});

test("Markdown-like strings in literal bodies never turn labels into links", () => {
  // Never apply Markdown presentation rules to tool output or raw user input.
  const text = "[Docs](https://example.invalid/docs)";

  const result = transcriptLinkAt(text, text.indexOf("Docs"));

  expect(result).toBeNull();
});
