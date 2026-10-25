import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { contrastingText } from "./color.ts";

// Cross-role colors must be concrete RGB, not terminal-default escape-code intent.
test.each([
  { background: "#73B4BC", panel: "#202328", text: "#ABB2BF", expected: "#202328" },
  { background: "#117799", panel: "#141414", text: "#ECECEC", expected: "#FFFFFF" },
  { background: "#111111", panel: "#FEFEFE", text: "#202020", expected: "#FEFEFE" },
  { background: "#222222", panel: "#333333", text: "#444444", expected: "#FFFFFF" },
  { background: "#DDDDDD", panel: "#BBBBBB", text: "#AAAAAA", expected: "#000000" },
])("Block text resolves terminal defaults and chooses readable colors: %j", ({ background, panel, text, expected }) => {
  // Theme text can be too close to an accent, including both supplied candidates.
  const first = RGBA.defaultBackground(panel), second = RGBA.defaultForeground(text);

  const result = contrastingText(RGBA.fromHex(background), first, second);

  // A terminal must emit the chosen RGB rather than reinterpret it as its default foreground.
  expect(result.intent).toBe("rgb"); expect(result.toInts()).toEqual(RGBA.fromHex(expected).toInts());
  expect(first.intent).toBe("default"); expect(second.intent).toBe("default");
});
