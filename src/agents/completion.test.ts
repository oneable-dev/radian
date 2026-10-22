import { expect, test } from "bun:test";
import { completionTarget, expandSkillInvocation, filterCatalog, filterCompletions, insertCompletion } from "./completion.ts";

test.each([
  ["$", 1, "skill", ""], ["$review-code", 7, "skill", "review"], ["text $review", 12, null, null],
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

test.each(["command", "template", "skill"] as const)("%s 자동완성은 정규화한 접두사만 매칭하고 중간 문자열·퍼지 매칭을 거부한다", (kind) => {
  // Executable resources must not appear just because their name contains the token.
  const items = ["Review-code", "code-review"].map(value => ({ kind, value, description: "Review" }));

  const prefix = filterCompletions(items, "ＲＥＶ");
  const middle = filterCompletions(items, "view");
  const fuzzy = filterCompletions(items, "rvc");

  // Normalization affects matching, not the name inserted into the prompt.
  expect(prefix.items.map(item => item.value)).toEqual(["Review-code"]);
  expect(middle.items).toEqual([]); expect(fuzzy.items).toEqual([]);
});

test("파일 자동완성은 중간 경로를 포함 검색하고 접두사 후보를 먼저 표시한다", () => {
  // File mentions may start from a basename rather than the worktree-relative path.
  const items = ["src/review.ts", "review.ts", "src/r-e-v.ts"].map(value => ({ kind: "file" as const, value, description: "" }));

  const result = filterCompletions(items, "ＲＥＶ");

  // Keep original paths and do not admit fuzzy-only candidates.
  expect(result.items.map(item => item.value)).toEqual(["review.ts", "src/review.ts"]);
});

test("파일 자동완성의 공백은 AND 구분자가 아니라 경로의 일부로 유지한다", () => {
  // Quoted paths distinguish one literal space from separated search terms.
  const items = ["src/문서 file.ts", "src/문서 other file.ts"].map(value => ({ kind: "file" as const, value, description: "" }));

  const result = filterCompletions(items, "문서 file");
  const doubled = filterCompletions(items, "문서  file");

  // A gap in a filename must not be synthesized or collapsed by the matcher.
  expect(result.items.map(item => item.value)).toEqual(["src/문서 file.ts"]);
  expect(doubled.items).toEqual([]);
});

test("필터는 대소문자를 구분하지 않고 접두사 일치를 우선하며 잘린 목록을 명시한다", () => {
  // The server bounds the wire response instead of returning an unmarked partial list.
  const items = ["xMCP", "mcp", ...Array.from({ length: 110 }, (_, index) => `mcp-${index}`)].map((value) => ({ kind: "command" as const, value, description: "" }));
  const result = filterCompletions(items, "MCP");
  expect(result.items[0]?.value).toBe("mcp"); expect(result.items).toHaveLength(100); expect(result.truncated).toBe(true);
  expect(filterCompletions(items, "no match")).toEqual({ items: [], truncated: false });
});

test("전체 카탈로그에서 명령과 스킬을 분리하고 100개 뒤의 항목도 검색한다", () => {
  // 초기 카탈로그를 검색 결과 한 페이지로 잘라 보관하면 뒤쪽 명령이 영원히 사라진다.
  const items = Array.from({ length: 150 }, (_, i) => ({ kind: "command" as const, value: `command-${i}`, description: "Command" }));
  const catalog = [...items, { kind: "skill" as const, value: "skill:review-code", description: "Review" }];

  // 같은 원본에서 슬래시와 달러 검색은 서로 다른 종류만 선택한다.
  const command = filterCatalog(catalog, { kind: "command", query: "command-149" });
  const skill = filterCatalog(catalog, { kind: "skill", query: "review" });

  expect(command.items.map(item => item.value)).toEqual(["command-149"]);
  expect(filterCatalog(catalog, { kind: "command", query: "review" }).items).toEqual([]);
  expect(skill.items).toEqual([{ kind: "skill", value: "review-code", description: "Review" }]);
});

test("달러 자동완성은 달러 표기를 유지하고 호출 시에만 기존 스킬 문법으로 변환한다", () => {
  // 스킬 선택은 입력을 즉시 실행하지 않으며 뒤의 지시문을 손상시키지 않는다.
  const text = "$rev inspect this code", target = completionTarget(text, 4)!;

  const inserted = insertCompletion(text, target, { kind: "skill", value: "review-code", description: "Review" });

  expect(inserted.text).toBe("$review-code inspect this code");
  expect(expandSkillInvocation(inserted.text)).toBe("/skill:review-code inspect this code");
  expect(expandSkillInvocation("$team_skill inspect", ["team_skill"])).toBe("/skill:team_skill inspect");
  for (const ordinary of ["Use $review-code", "$HOME", "${HOME}", "$(pwd)", "/skill:review-code", "````\n$review-code"])
    expect(expandSkillInvocation(ordinary)).toBe(ordinary);
});
