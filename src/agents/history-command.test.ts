import { expect, test } from "bun:test";
import { parseHistoryCommand } from "./history-command.ts";
import { expectError, expectOk } from "../testing/results.ts";

test.each(["/history", "/history  ", "/history\n\t"])(
  "history does not treat trailing whitespace as arguments: %j",
  (text) => {
    // Whitespace-only arguments match separators appended by completion.
    const result = parseHistoryCommand(text);

    // Valid commands remain on the popup-only path.
    expect(expectOk(result)).toBe(true);
  },
);

test.each(["/history recent", "/history\nsearch"])(
  "history explicitly rejects arguments instead of ignoring them: %j",
  (text) => {
    // Check requests after newlines so they cannot become model input.
    const result = parseHistoryCommand(text);

    // Return stable input errors while preserving the original text.
    expect(expectError(result).code).toBe("INVALID_INPUT");
  },
);

test.each(["/history-more", "/history/recent", "history", "Explain /history"])(
  "history never intercepts other commands or ordinary prose: %j",
  (text) => {
    // Partial command matches and prose tokens do not open history.
    const result = parseHistoryCommand(text);

    // Other resource commands and conversations keep their original routing.
    expect(expectOk(result)).toBe(false);
  },
);
