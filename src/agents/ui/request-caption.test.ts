import { expect, test } from "bun:test";
import { formatRequestCaption, requestForSection } from "./request-caption.ts";

test("요청은 한 줄로 정리하고 첨부 배지의 폭을 먼저 확보한다", () => {
  const request = { text: "A long request\nwith all original details ".repeat(10), images: 2, files: 3 };
  const caption = formatRequestCaption(request, 44);
  expect(caption).toContain("…  [2 images] [3 files]"); expect(Bun.stringWidth(caption)).toBeLessThanOrEqual(44);
  expect(request.text).toContain("\n");
});

test("텍스트 없는 첨부 요청은 배지만 표시하고 파일 하나는 이름을 쓴다", () => {
  expect(formatRequestCaption({ text: "", images: 2, files: 0 }, 50)).toBe("[2 images]");
  expect(formatRequestCaption({ text: "", images: 0, files: 1, fileName: "panel.ts" }, 50)).toBe("[File: panel.ts]");
});

test("아주 좁으면 긴 파일명을 개수로 축약하고 어떤 경우에도 화면 너비를 넘지 않는다", () => {
  const request = { text: "Details", images: 2, files: 1, fileName: "A very long filename.ts" };
  expect(formatRequestCaption(request, 20)).toBe("[2 images] [1 file]");
  expect(formatRequestCaption(request, 8)).toBe("[2I 1F]");
  for (const width of [0, 1, 2, 5, 8, 20, 100]) expect(Bun.stringWidth(formatRequestCaption(request, width))).toBeLessThanOrEqual(width);
});

test("한글·결합 문자·emoji는 grapheme 경계에서 표시만 줄인다", () => {
  expect(formatRequestCaption({ text: "한글👩‍💻 이어지는 요청", images: 0, files: 0 }, 7)).toBe("한글👩‍💻…");
  expect(formatRequestCaption({ text: "A e\u0301 ZZZ", images: 0, files: 0 }, 4)).toBe("A e\u0301…");
});

test("옛 섹션은 텍스트만 사용하고 첨부 개수를 만들거나 스킬 지침을 노출하지 않는다", () => {
  expect(requestForSection({ id: "old", kind: "user", title: "You", text: "diagram.png", status: "complete" })).toEqual({ text: "diagram.png", images: 0, files: 0 });
  expect(requestForSection({ id: "skill", kind: "notice", title: "Skill", skillName: "review-code", text: "PRIVATE INSTRUCTIONS", status: "complete" })?.text).toBe("/skill:review-code");
});
