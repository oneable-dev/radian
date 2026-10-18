import { expect, test } from "bun:test";
import { collapsedPaste, expandPromptDraft, validatePromptDraft, type PromptDraft } from "./prompt-input.ts";
import { pastedFiles } from "./prompt-attachments.ts";

const draft = (): PromptDraft => ({ value: "검토 [File #1] [Image #1]", cursor: 24,
  tokens: [{ start: 3, end: 12, part: { kind: "file", index: 1, path: "/tmp/file.txt" } }, { start: 13, end: 23, part: { kind: "image", index: 1, path: "/tmp/image.png" } }],
  next: { file: 2, image: 2, paste: 1 } });

test("첨부 표시는 실제 원문 범위와 일치해야 하고 가짜·겹친 저장 항목을 거부한다", () => {
  const valid = draft(); valid.cursor = valid.value.length;
  expect(validatePromptDraft(valid).ok).toBe(true);
  const overlap = structuredClone(valid); overlap.tokens[1]!.start = 4;
  const fake = structuredClone(valid); fake.value = fake.value.replace("File", "Fake");

  expect(validatePromptDraft(overlap).ok).toBe(false); expect(validatePromptDraft(fake).ok).toBe(false);
  expect(validatePromptDraft({ ...valid, cursor: 999 }).ok).toBe(false);
  expect(validatePromptDraft({ ...valid, next: { ...valid.next, image: 1 } }).ok).toBe(false);
});

test("이미지 배열 순서와 파일 참조를 유지하고 구버전 초안에도 실제 경로를 남긴다", () => {
  const input = draft(); input.cursor = input.value.length;
  const original = structuredClone(input);

  expect(expandPromptDraft(input)).toEqual({ text: '검토 @"/tmp/file.txt" [Image #1]', images: ["/tmp/image.png"] });
  expect(expandPromptDraft(input, false)).toEqual({ text: '검토 @"/tmp/file.txt" @"/tmp/image.png"', images: [] });
  expect(input).toEqual(original);
});

test("길거나 여러 줄인 붙여넣기와 제어 문자는 표시만 접고 짧은 일반 문장은 접지 않는다", () => {
  expect(collapsedPaste("x".repeat(1023))).toBe(false); expect(collapsedPaste("x".repeat(1024))).toBe(true);
  expect(collapsedPaste("one\ntwo")).toBe(false); expect(collapsedPaste("x\n".repeat(8))).toBe(true);
  expect(collapsedPaste("\x1b[31msecret")).toBe(true); expect(collapsedPaste("one\r\ntwo")).toBe(true);
});

test("파일 드롭의 인용·이스케이프·file URI와 일반 텍스트를 구분한다", () => {
  expect(pastedFiles('"/tmp/image one.png" /tmp/a\\ b.txt', "/workspace")).toEqual([
    { kind: "image", path: "/tmp/image one.png" }, { kind: "file", path: "/tmp/a b.txt" },
  ]);
  expect(pastedFiles("file:///tmp/%ED%95%9C%EA%B8%80.png", "/workspace")).toEqual([{ kind: "image", path: "/tmp/한글.png" }]);
  expect(pastedFiles("./relative.ts", "/workspace")).toEqual([{ kind: "file", path: "/workspace/relative.ts" }]);
  expect(pastedFiles("Please inspect /tmp/a.ts", "/workspace")).toBeNull();
  expect(pastedFiles("/bin/echo hello", "/workspace")).toBeNull();
  expect(pastedFiles("./script.sh --flag", "/workspace")).toBeNull();
  expect(pastedFiles("file://remote/tmp/a.png", "/workspace")).toBeNull();
  expect(pastedFiles("file:///tmp/%00a.png", "/workspace")).toBeNull();
  expect(pastedFiles("file:///tmp/%ZZ", "/workspace")).toBeNull();
  expect(pastedFiles('"/tmp/unclosed', "/workspace")).toBeNull();
});
