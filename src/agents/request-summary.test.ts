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

test.each([
  "[Image: original 3000x4000, displayed at 1500x2000. Multiply coordinates by 2.00 to map to original image.]",
  "[Image converted from image/heic to image/png.]",
  "[Image converted from image/heic to image/png.]\n[Image: original 3000x4000, displayed at 1500x2000. Multiply coordinates by 2.00 to map to original image.]\n[Image: original 4000x3000, displayed at 2000x1500. Multiply coordinates by 2.00 to map to original image.]",
])("이미지 처리 안내는 요청 요약에서 숨기고 첨부 개수와 원문은 보존한다: %#", (hints) => {
  // SDK는 사용자가 입력한 요청 뒤에 이미지 처리 안내를 덧붙인다.
  const text = `이거 두 개 확인해봐 [Image #1] [Image #2]\n@"/tmp/a.ts" @"/tmp/b.ts"\n\n${hints}`;

  // 실제 이미지와 파일이 함께 있는 요청의 표시용 요약을 만든다.
  const summary = summarizeRequest(text, 2);

  // 내부 안내만 사라지고 기존 첨부 배지의 집계와 SDK 원문은 유지된다.
  expect(summary).toEqual({ text: "이거 두 개 확인해봐", images: 2, files: 2 });
  expect(text).toEndWith(hints);
});

test("이미지 처리 안내와 같은 일반 입력과 코드 예제는 임의로 숨기지 않는다", () => {
  // 실제 이미지가 없거나 코드 안에 인용한 안내는 사용자 입력이다.
  const hint = "[Image: original 3000x4000, displayed at 1500x2000. Multiply coordinates by 2.00 to map to original image.]";
  const literal = `Explain this message:\n\n${hint}`;
  const example = `Explain this example:\n\n\`\`\`text\n${hint}\n\`\`\``;

  const plainSummary = summarizeRequest(literal, 0);
  const exampleSummary = summarizeRequest(example, 1);

  // 대괄호 안의 내용을 통째로 지우는 방식으로 사용자 입력을 손상시키지 않는다.
  expect(plainSummary.text).toContain(hint);
  expect(exampleSummary.text).toContain(hint);
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
