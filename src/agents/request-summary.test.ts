import { expect, test } from "bun:test";
import { Value } from "typebox/value";
import { requestSummarySchema, summarizeRequest } from "./request-summary.ts";

test("요청 요약은 실제 이미지 개수와 명시적 파일 참조만 집계하고 원문은 바꾸지 않는다", () => {
  const text = 'Review these [Image #1] [Image #3]\n@"/tmp/some note.md" @"/tmp/panel.ts"';
  const summary = summarizeRequest(text, 2);
  expect(summary).toEqual({ text: "Review these", images: 2, files: 2 });
  expect(text).toContain('@"/tmp/some note.md"');
  expect(Value.Check(requestSummarySchema, summary)).toBe(true);
});

test("파일 하나는 전체 경로 대신 basename만 요약에 넣는다", () => {
  expect(summarizeRequest('@"/private/workspace/한글 note.md"', 0)).toEqual({ text: "", images: 0, files: 1, fileName: "한글 note.md" });
});

test("첨부 이름 같은 일반 텍스트나 잘못된 참조로 첨부 개수를 추측하지 않는다", () => {
  const text = '[Image #1] diagram.png /tmp/panel.ts @"relative.ts" @"/tmp/bad\\q"';
  expect(summarizeRequest(text, 0)).toEqual({ text, images: 0, files: 0 });
});

test.each(["```", "````", "~~~"])("%s 코드 예제의 파일 참조는 세지 않고 코드 밖의 실제 참조만 집계한다", (fence) => {
  const text = `Explain:\n${fence}text\n@"/tmp/example.ts"\n${fence}\n@"/tmp/actual.ts"`;
  const summary = summarizeRequest(text, 0);
  expect(summary.files).toBe(1); expect(summary.fileName).toBe("actual.ts");
  expect(summary.text).toContain('@"/tmp/example.ts"'); expect(summary.text).not.toContain("actual.ts");
});

test("거대한 요청의 표시 메타데이터만 제한하고 grapheme과 원문은 보존한다", () => {
  const text = "x".repeat(4094) + "👩‍💻" + "long tail".repeat(1000);
  const summary = summarizeRequest(text, 0);
  expect(summary.text).toBe("x".repeat(4094) + "…");
  expect(Value.Check(requestSummarySchema, summary)).toBe(true); expect(summary.text).not.toContain("\uFFFD");
  expect(text).toContain("👩‍💻long tail");
});
