import { expect, test } from "bun:test";
import { transcriptLinkAt } from "./transcript-links.ts";

test.each([
  { text: "See https://example.invalid/docs, next", at: "example", url: "https://example.invalid/docs" },
  { text: "(http://localhost:3000/a_(b)).", at: "localhost", url: "http://localhost:3000/a_(b)" },
  { text: "Use `http://localhost:3000`", at: "localhost", url: "http://localhost:3000" },
])("리터럴 본문의 커서 아래 URL을 문장 기호와 구분한다: $text", ({ text, at, url }) => {
  // 실제 주소 안의 괄호와 문장 뒤의 구두점을 구분해야 한다.
  const offset = text.indexOf(at);

  // 네이티브 렌더러와 같은 일반 URL 감지 규칙을 사용한다.
  const result = transcriptLinkAt(text, offset);

  // 주변 표식은 실제 브라우저 대상으로 전달하지 않는다.
  expect(result).toBe(url);
});

test.each([-1, 0, 6, 43])("링크 바깥의 커서 위치 %i에서는 다른 링크를 대신 열지 않는다", offset => {
  // 같은 줄에 주소가 있어도 현재 위치가 링크가 아니면 열지 않는다.
  const text = "Before https://example.invalid after";

  const result = transcriptLinkAt(text, offset);

  expect(result).toBeNull();
});

test("리터럴 본문의 Markdown 모양 문자열은 라벨을 링크로 해석하지 않는다", () => {
  // 도구 출력과 사용자 원문에는 Markdown 표시 규칙을 임의 적용하지 않는다.
  const text = "[Docs](https://example.invalid/docs)";

  const result = transcriptLinkAt(text, text.indexOf("Docs"));

  expect(result).toBeNull();
});
