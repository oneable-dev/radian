import { expect, test } from "bun:test";
import { formatRequestCaption, formatWorkRequest, requestForSection } from "./request-caption.ts";

test("Request captions normalize to one line and reserve attachment badge width first", () => {
  const request = {
    text: "A long request\nwith all original details ".repeat(10),
    images: 2,
    files: 3,
  };
  const caption = formatRequestCaption(request, 44);
  expect(caption).toContain("…  [2 images] [3 files]");
  expect(Bun.stringWidth(caption)).toBeLessThanOrEqual(44);
  expect(request.text).toContain("\n");
});

test("Text-free attachment requests show only badges and single files show their names", () => {
  expect(formatRequestCaption({ text: "", images: 2, files: 0 }, 50)).toBe("[2 images]");
  expect(formatRequestCaption({ text: "", images: 0, files: 1, fileName: "panel.ts" }, 50)).toBe(
    "[File: panel.ts]",
  );
});

test("Narrow captions replace long filenames with counts and never exceed viewport width", () => {
  const request = { text: "Details", images: 2, files: 1, fileName: "A very long filename.ts" };
  expect(formatRequestCaption(request, 20)).toBe("[2 images] [1 file]");
  expect(formatRequestCaption(request, 8)).toBe("[2I 1F]");
  for (const width of [0, 1, 2, 5, 8, 20, 100])
    expect(Bun.stringWidth(formatRequestCaption(request, width))).toBeLessThanOrEqual(width);
});

test("Korean, combining characters, and emoji truncate visually only at grapheme boundaries", () => {
  expect(formatRequestCaption({ text: "한글👩‍💻 이어지는 요청", images: 0, files: 0 }, 7)).toBe(
    "한글👩‍💻…",
  );
  expect(formatRequestCaption({ text: "A e\u0301 ZZZ", images: 0, files: 0 }, 4)).toBe(
    "A e\u0301…",
  );
});

test.each([
  [30, 15],
  [80, 40],
  [200, 60],
])(
  "Work requests at width %i occupy at most %i cells without altering the original input",
  (width, limit) => {
    // Long Unicode input must remain a preview even on a very wide screen.
    const request = { text: "한글👩‍💻 e\u0301 request ".repeat(40), images: 0, files: 0 };
    const original = request.text;

    const caption = formatWorkRequest(request, width);

    // Both quotes stay visible within the preview budget, even when the text is shortened.
    expect(caption).toStartWith("“");
    expect(caption).toEndWith("…”");
    expect(Bun.stringWidth(caption)).toBeLessThanOrEqual(limit);
    expect(request.text).toBe(original);
    expect(caption).not.toContain("\uFFFD");
    expect(formatWorkRequest(request, width, 7)).toBe("“한글…”");
  },
);

test.each([
  [0, ""],
  [1, ""],
  [2, ""],
  [3, "“…”"],
  [4, "“A…”"],
  [5, "“ABC”"],
] as const)(
  "Work requests with %i available cells never show an unmatched quote",
  (available, expected) => {
    // The preview needs room for both quotes and at least one text or ellipsis cell.
    const request = { text: "ABC", images: 0, files: 0 };

    const caption = formatWorkRequest(request, 120, available);

    // Hide text rather than clipping a quote when the remaining space is too small.
    expect(caption).toBe(expected);
    expect(Bun.stringWidth(caption)).toBeLessThanOrEqual(available);
  },
);

test("Work requests reserve both quotes after attachment badges and omit empty excerpts", () => {
  // Badges must remain outside the quoted text and retain their width priority.
  const request = { text: "A long request", images: 2, files: 3 };

  const caption = formatWorkRequest(request, 50);
  const narrow = formatWorkRequest(request, 48);
  const attachments = formatWorkRequest({ ...request, text: "" }, 50);

  // A three-cell excerpt can show balanced quotes, but a smaller one shows only badges.
  expect(caption).toBe("“…”  [2 images] [3 files]");
  expect(Bun.stringWidth(caption)).toBe(25);
  expect(narrow).toBe("[2 images] [3 files]");
  expect(attachments).toBe(narrow);
});

test("Legacy sections use text only without inventing attachments or exposing skill instructions", () => {
  expect(
    requestForSection({
      id: "old",
      kind: "user",
      title: "You",
      text: "diagram.png",
      status: "complete",
    }),
  ).toEqual({ text: "diagram.png", images: 0, files: 0 });
  expect(
    requestForSection({
      id: "skill",
      kind: "notice",
      title: "Skill",
      skillName: "review-code",
      text: "PRIVATE INSTRUCTIONS",
      status: "complete",
    })?.text,
  ).toBe("/skill:review-code");
});
