import { expect, test } from "bun:test";
import { formatRequestCaption, requestForSection } from "./request-caption.ts";

test("Request captions normalize to one line and reserve attachment badge width first", () => {
  const request = { text: "A long request\nwith all original details ".repeat(10), images: 2, files: 3 };
  const caption = formatRequestCaption(request, 44);
  expect(caption).toContain("…  [2 images] [3 files]"); expect(Bun.stringWidth(caption)).toBeLessThanOrEqual(44);
  expect(request.text).toContain("\n");
});

test("Text-free attachment requests show only badges and single files show their names", () => {
  expect(formatRequestCaption({ text: "", images: 2, files: 0 }, 50)).toBe("[2 images]");
  expect(formatRequestCaption({ text: "", images: 0, files: 1, fileName: "panel.ts" }, 50)).toBe("[File: panel.ts]");
});

test("Narrow captions replace long filenames with counts and never exceed viewport width", () => {
  const request = { text: "Details", images: 2, files: 1, fileName: "A very long filename.ts" };
  expect(formatRequestCaption(request, 20)).toBe("[2 images] [1 file]");
  expect(formatRequestCaption(request, 8)).toBe("[2I 1F]");
  for (const width of [0, 1, 2, 5, 8, 20, 100]) expect(Bun.stringWidth(formatRequestCaption(request, width))).toBeLessThanOrEqual(width);
});

test("Korean, combining characters, and emoji truncate visually only at grapheme boundaries", () => {
  expect(formatRequestCaption({ text: "한글👩‍💻 이어지는 요청", images: 0, files: 0 }, 7)).toBe("한글👩‍💻…");
  expect(formatRequestCaption({ text: "A e\u0301 ZZZ", images: 0, files: 0 }, 4)).toBe("A e\u0301…");
});

test("Legacy sections use text only without inventing attachments or exposing skill instructions", () => {
  expect(requestForSection({ id: "old", kind: "user", title: "You", text: "diagram.png", status: "complete" })).toEqual({ text: "diagram.png", images: 0, files: 0 });
  expect(requestForSection({ id: "skill", kind: "notice", title: "Skill", skillName: "review-code", text: "PRIVATE INSTRUCTIONS", status: "complete" })?.text).toBe("/skill:review-code");
});
