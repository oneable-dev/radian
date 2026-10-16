import { expect, test } from "bun:test";
import { completionTarget, filterCompletions, insertCompletion } from "./completion.ts";

test.each([
  ["/", 1, "command", ""], ["/mc", 3, "command", "mc"], ["/mcp arg", 3, "command", "mc"],
  ["/mcp arg", 8, null, null], [" /mc", 4, null, null], ["text /mc", 8, null, null],
  ["@", 1, "file", ""], ["check @src/", 11, "file", "src/"], ["한글 @문서", 6, "file", "문서"],
  ["user@example.com", 16, null, null], ["prefix@src", 10, null, null],
  ['check @"folder @name/a b"', 24, "file", "folder @name/a b"],
  ['@"a\\\\b', 6, "file", "a\\b"], ["plain", 0, null, null],
] as const)("입력 %s의 커서 %i에서는 %s 후보만 감지한다", (text, cursor, kind, query) => {
  // Cursor-local tokens must distinguish slash commands, file mentions and ordinary prose.
  const target = completionTarget(text, cursor);
  expect(target?.kind ?? null).toBe(kind); expect(target?.query ?? null).toBe(query);
});

test("후보 삽입은 커서가 속한 토큰 전체만 교체하고 한글·이모지와 뒤의 문장을 보존한다", () => {
  // The cursor is inside an existing mention, not at the end of the prompt.
  const text = "한글 👩‍💻 @src/old.ts 뒤의 요청";
  const target = completionTarget(text, text.indexOf("old"))!;

  const result = insertCompletion(text, target, { kind: "file", value: "문서/a b.ts", description: "" });

  expect(result.text).toBe('한글 👩‍💻 @"문서/a b.ts" 뒤의 요청');
  expect(result.text.slice(0, result.cursor)).toBe('한글 👩‍💻 @"문서/a b.ts"');
});

test("명령어와 공백·따옴표가 있는 경로는 실행 없이 완성할 텍스트와 커서만 반환한다", () => {
  // Appending one space lets the user type arguments; it does not submit anything.
  const command = insertCompletion("/mc", completionTarget("/mc", 3)!, { kind: "command", value: "mcp", description: "" });
  const file = insertCompletion("@", completionTarget("@", 1)!, { kind: "file", value: 'a "b"\\c.ts', description: "" });
  expect(command).toEqual({ text: "/mcp ", cursor: 5 });
  expect(file.text).toBe('@"a \\"b\\"\\\\c.ts" ');
  expect(file.cursor).toBe(file.text.length);
});

test("필터는 대소문자를 구분하지 않고 접두사 일치를 우선하며 잘린 목록을 명시한다", () => {
  // The server bounds the wire response instead of returning an unmarked partial list.
  const items = ["xMCP", "mcp", ...Array.from({ length: 110 }, (_, index) => `mcp-${index}`)].map((value) => ({ kind: "command" as const, value, description: "" }));
  const result = filterCompletions(items, "MCP");
  expect(result.items[0]?.value).toBe("mcp"); expect(result.items).toHaveLength(100); expect(result.truncated).toBe(true);
  expect(filterCompletions(items, "no match")).toEqual({ items: [], truncated: false });
});
