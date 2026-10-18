import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readHistoryPreview, historyPreviewLimit, historyPreviewSectionLimit } from "./history-preview.ts";
import { runCompletionEntryType } from "./run-completion.ts";
import { expectError, expectOk } from "../testing/results.ts";

const header = { type: "session", version: 3, id: "saved", cwd: "/fixture", timestamp: "2026-10-14T00:00:00Z" };
const message = (id: string, parentId: string | null, role: string, content: unknown) => ({ type: "message", id, parentId, timestamp: header.timestamp, message: { role, content } });
async function fixture(records: unknown[]) {
  const directory = await mkdtemp(join(tmpdir(), "radian-history-preview-")), path = join(directory, "session.jsonl");
  await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return { path, async close() { await rm(directory, { recursive: true, force: true }); } };
}

test("미리보기는 현재 분기의 최신 SDK 섹션만 읽고 writer나 파일을 바꾸지 않는다", async () => {
  // The previous branch and tool/thinking payload must not be mistaken for the chosen conversation.
  const app = await fixture([header, message("q", null, "user", "Original question"), message("old", "q", "assistant", [{ type: "text", text: "ABANDONED BRANCH" }]),
    message("new", "q", "user", [{ type: "text", text: "Current branch" }, { type: "image", data: "not rendered" }]),
    message("answer", "new", "assistant", [{ type: "thinking", thinking: "PRIVATE THINKING" }, { type: "text", text: "Current answer" }]),
    { ...message("tool", "answer", "toolResult", []), message: { role: "toolResult", toolCallId: "call", toolName: "read", isError: false, content: [{ type: "text", text: "TOOL OUTPUT" }] } }]);
  const opened = spyOn(SessionManager, "open");
  try {
    const before = await readFile(app.path, "utf8");
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(preview.sections?.map((section) => section.kind)).toEqual(["thinking", "assistant", "tool"]);
    expect(preview.text).toContain("Current answer"); expect(preview.text).not.toContain("Original question"); expect(preview.text).not.toContain("ABANDONED BRANCH");
    expect(preview.worktreeId).toBe("tree"); expect(preview.id).toBe("saved"); expect(preview.truncated).toBe(false);
    expect(opened).not.toHaveBeenCalled(); expect(await readFile(app.path, "utf8")).toBe(before);
  } finally { opened.mockRestore(); await app.close(); }
});

test("최신 3개 섹션만 Agent와 같은 도구·오류·redaction 표현으로 반환한다", async () => {
  // Several earlier turns and intermediate blocks must not displace the latest question/answer.
  const entries: unknown[] = [header, message("old-q", null, "user", "OLD QUESTION"), message("old-a", "old-q", "assistant", [{ type: "text", text: "OLD ANSWER" }]), message("q", "old-a", "user", "Latest request")];
  let parent = "q";
  for (let i = 1; i <= 4; i++) { entries.push(message(`a${i}`, parent, "assistant", [{ type: "text", text: `Step ${i}` }])); parent = `a${i}`; }
  entries.push(message("work", parent, "assistant", [{ type: "thinking", thinking: "HIDDEN THOUGHT", redacted: true, thinkingSignature: "SECRET SIGNATURE" }, { type: "toolCall", id: "call", name: "read", arguments: { path: "fixture.ts" } }]));
  entries.push({ ...message("result", "work", "toolResult", []), message: { role: "toolResult", toolCallId: "call", toolName: "read", isError: true, content: [{ type: "text", text: "Read failed" }] } });
  entries.push(message("final", "result", "assistant", [{ type: "text", text: "Latest answer" }]));
  const app = await fixture(entries);
  try {
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(preview.sections?.map((section) => section.text.split("\n")[0])).toEqual(["[Thinking redacted]", "Arguments:", "Latest answer"]);
    expect(preview.sections?.[1]).toMatchObject({ kind: "tool", title: "read", status: "error", error: "Read failed" });
    expect(preview.sections?.[1]?.text).toContain("Read failed"); expect(preview.truncated).toBe(false);
    expect(JSON.stringify(preview)).not.toMatch(/OLD QUESTION|OLD ANSWER|Step 1|Step 2|Step 3|Step 4|HIDDEN THOUGHT|SECRET SIGNATURE/);
  } finally { await app.close(); }
});

test("저장 미리보기에도 Bash 명령·timeout을 보존하며 기존 요약 길이로 명령을 자르지 않는다", async () => {
  // 미리보기의 512자 요약 제한과 별개로 구조화한 실행 명령을 보존한다.
  const command = "printf '한글'\n" + "printf done; ".repeat(60);
  const app = await fixture([header, message("q", null, "user", "Show command"),
    message("call", "q", "assistant", [{ type: "toolCall", id: "shell", name: "bash", arguments: { command, timeout: 120 } }])]);
  try {
    const before = await readFile(app.path, "utf8");
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    // 제한 시간이나 명령 복원 때문에 writer를 열거나 저장 기록을 바꾸지 않는다.
    expect(preview.sections?.at(-1)).toMatchObject({ kind: "tool", command, timeoutSeconds: 120 });
    expect(await readFile(app.path, "utf8")).toBe(before);
  } finally { await app.close(); }
});

test("최신 3개 미리보기는 완료 메타데이터를 유지하지만 새 미응답 요청에는 옛 완료를 붙이지 않는다", async () => {
  const completion = { startedAt: 1000000, completedAt: 1090000, durationMs: 90000, outcome: "complete" as const };
  const app = await fixture([header, message("q", null, "user", "Question"), message("a", "q", "assistant", [{ type: "text", text: "Answer" }]),
    { type: "custom", id: "completed", parentId: "a", timestamp: header.timestamp, customType: runCompletionEntryType, data: completion }]);
  try {
    const before = await readFile(app.path, "utf8");
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(preview.sections).toHaveLength(2); expect(preview.sections?.at(-1)?.completion).toEqual(completion);
    expect(await readFile(app.path, "utf8")).toBe(before);
    await writeFile(app.path, before + JSON.stringify(message("next", "completed", "user", "Unanswered")) + "\n");
    const next = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(next.sections).toHaveLength(1); expect(next.sections?.[0]?.completion).toBeUndefined();
  } finally { await app.close(); }
});

test("선택한 분기의 손상된 완료 메타데이터는 실패 Result로 명시한다", async () => {
  const app = await fixture([header, message("q", null, "user", "Question"),
    { type: "custom", id: "bad", parentId: "q", timestamp: header.timestamp, customType: runCompletionEntryType, data: { durationMs: -1 } }]);
  try { expect(expectError(await readHistoryPreview(app.path, "tree", "saved")).code).toBe("HISTORY_CORRUPT"); }
  finally { await app.close(); }
});

test("새 프롬프트만 저장됐으면 이전 답변을 섞지 않고 스킬은 이름만 표시한다", async () => {
  const skill = '<skill name="good-code" location="/private/SKILL.md">\nHIDDEN INSTRUCTIONS\n</skill>\n\nLatest skill request';
  const app = await fixture([header, message("q", null, "user", "OLD PROMPT"), message("a", "q", "assistant", [{ type: "text", text: "OLD ANSWER" }]), message("new", "a", "user", skill)]);
  try {
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(preview.sections).toHaveLength(2);
    expect(preview.sections?.[0]).toMatchObject({ kind: "notice", skillName: "good-code", text: "good-code" });
    expect(preview.sections?.[1]).toMatchObject({ kind: "user", text: "Latest skill request" });
    expect(JSON.stringify(preview)).not.toMatch(/OLD PROMPT|OLD ANSWER|HIDDEN INSTRUCTIONS|\/private/);
  } finally { await app.close(); }
});

test("이전 SDK 기록은 메모리에서만 변환하고 원본 바이트를 보존한다", async () => {
  const app = await fixture([{ ...header, version: 1 }, { type: "message", message: { role: "user", content: "Legacy question" } }, { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Legacy answer" }] } }]);
  try {
    const before = await readFile(app.path, "utf8");
    expect(expectOk(await readHistoryPreview(app.path, "tree", "saved")).text).toContain("Legacy answer");
    expect(await readFile(app.path, "utf8")).toBe(before);
  } finally { await app.close(); }
});

test("v2 hook 메시지도 메모리에서만 변환해 최근 섹션으로 표시한다", async () => {
  const app = await fixture([{ ...header, version: 2 }, message("q", null, "user", "Legacy question"),
    { ...message("hook", "q", "hookMessage", "Legacy visible note"), message: { role: "hookMessage", customType: "Legacy extension", content: "Legacy visible note", display: true } }]);
  try {
    const before = await readFile(app.path, "utf8");
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(preview.sections?.at(-1)).toMatchObject({ kind: "notice", title: "Legacy extension", text: "Legacy visible note" });
    expect(await readFile(app.path, "utf8")).toBe(before);
  } finally { await app.close(); }
});

test.each([
  [header, null],
  [header, message("a", "missing", "user", "broken")],
  [header, message("a", "a", "user", "cycle")],
  [header, message("a", null, "user", [{ type: "text", text: 1 }])],
  [{ ...header, id: "different" }],
])("손상된 메시지·분기·신원은 부분 성공으로 숨기지 않는다: %j", async (...records) => {
  const app = await fixture(records);
  try { expect(expectError(await readHistoryPreview(app.path, "tree", "saved")).code).toBe("HISTORY_CORRUPT"); }
  finally { await app.close(); }
});

test("잘못된 JSON과 빈 파일도 예상 가능한 기록 오류로 반환한다", async () => {
  const app = await fixture([header]);
  try {
    await writeFile(app.path, JSON.stringify(header) + "\ninvalid JSON");
    expect(expectError(await readHistoryPreview(app.path, "tree", "saved")).code).toBe("HISTORY_CORRUPT");
    await writeFile(app.path, ""); expect(expectError(await readHistoryPreview(app.path, "tree", "saved")).code).toBe("HISTORY_CORRUPT");
  } finally { await app.close(); }
});

test("전체 파일이 4MiB를 넘어도 뒤쪽 최신 3개 섹션만 읽어 미리보기를 반환한다", async () => {
  // A large old turn must not block the small recent turn or be loaded into the preview model.
  const app = await fixture([header, message("old", null, "user", "OLD PAYLOAD " + "x".repeat(20 * 1024 * 1024)),
    message("current-q", "old", "user", "CURRENT QUESTION"),
    message("current-a", "current-q", "assistant", [{ type: "thinking", thinking: "Current plan" }, { type: "text", text: "CURRENT ANSWER" }])]);
  try {
    const before = await readFile(app.path, "utf8");
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(preview.sections?.map((section) => section.text)).toEqual(["CURRENT QUESTION", "Current plan", "CURRENT ANSWER"]);
    expect(JSON.stringify(preview)).not.toContain("OLD PAYLOAD"); expect(preview.truncated).toBe(false);
    expect(await readFile(app.path, "utf8")).toBe(before);
  } finally { await app.close(); }
});

test("최신 도구 결과 한 줄이 4MiB를 넘어도 섹션만 잘라 반환하고 호출 인수를 연결한다", async () => {
  // The total-file fix must also handle a large relevant record rather than just old payloads.
  const app = await fixture([header, message("q", null, "user", "Read the file"),
    message("call", "q", "assistant", [{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "fixture.ts" } }]),
    { ...message("result", "call", "toolResult", []), message: { role: "toolResult", toolCallId: "read-call", toolName: "read", isError: false,
      content: [{ type: "text", text: "LATEST RESULT " + "x".repeat(5 * 1024 * 1024) }] } },
    message("answer", "result", "assistant", [{ type: "text", text: "Latest answer" }])]);
  try {
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(preview.sections?.map((section) => section.kind)).toEqual(["user", "tool", "assistant"]);
    expect(preview.sections?.[1]?.text).toContain('"path": "fixture.ts"'); expect(preview.sections?.[1]?.text).toContain("LATEST RESULT");
    expect(preview.sections?.[1]?.text.length).toBe(historyPreviewSectionLimit); expect(preview.truncated).toBe(true);
  } finally { await app.close(); }
});

test("물리적으로 뒤에 있는 다른 분기는 건너뛰고 최신 분기만 표시한다", async () => {
  const app = await fixture([header, message("root", null, "user", "Root"), message("q", "root", "user", "Current question"),
    message("other", "root", "assistant", [{ type: "text", text: "OTHER BRANCH " + "x".repeat(20 * 1024 * 1024) }]),
    message("answer", "q", "assistant", [{ type: "text", text: "Current answer" }])]);
  try {
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(preview.sections?.map((section) => section.text)).toEqual(["Current question", "Current answer"]);
    expect(JSON.stringify(preview)).not.toContain("OTHER BRANCH");
  } finally { await app.close(); }
});

test("호출이 없는 최근 도구 결과 때문에 큰 이전 턴까지 읽지 않는다", async () => {
  const app = await fixture([header, message("old", null, "user", "x".repeat(20 * 1024 * 1024)), message("q", "old", "user", "Current question"),
    { ...message("result", "q", "toolResult", []), message: { role: "toolResult", toolCallId: "external-call", toolName: "read", isError: false, content: [{ type: "text", text: "Orphan result" }] } },
    message("answer", "result", "assistant", [{ type: "text", text: "Current answer" }])]);
  try {
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(preview.sections?.map((section) => section.kind)).toEqual(["user", "tool", "assistant"]);
    expect(preview.sections?.[1]?.text).toContain("Orphan result");
  } finally { await app.close(); }
});

test("도구 결과 세 개가 역순 완료돼도 호출을 찾고 Agent와 같은 섹션 순서를 유지한다", async () => {
  const entries: unknown[] = [header, message("q", null, "user", "Question"), message("calls", "q", "assistant", ["a", "b", "c"].map((id) => ({ type: "toolCall", id, name: "read", arguments: { path: id } })))];
  let parent = "calls";
  for (const id of ["c", "b", "a"]) {
    entries.push({ ...message(`result-${id}`, parent, "toolResult", []), message: { role: "toolResult", toolCallId: id, toolName: "read", isError: false, content: [{ type: "text", text: `RESULT ${id}` }] } });
    parent = `result-${id}`;
  }
  const app = await fixture(entries);
  try {
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(preview.sections?.map((section) => section.toolCallId)).toEqual(["a", "b", "c"]);
    expect(preview.sections?.[0]?.text).toContain('"path": "a"'); expect(preview.sections?.[0]?.text).toContain("RESULT a");
  } finally { await app.close(); }
});

test("CRLF와 마지막 LF 없는 기록도 Unicode를 보존하고 진행 중 취소는 CANCELLED로 반환한다", async () => {
  const app = await fixture([header, message("q", null, "user", "한글 😀\nsecond line"), message("answer", "q", "assistant", [{ type: "text", text: "답변 👨‍👩‍👧‍👦" }])]);
  try {
    await writeFile(app.path, (await readFile(app.path, "utf8")).replace(/\n/g, "\r\n").trimEnd());
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(preview.sections?.map((section) => section.text)).toEqual(["한글 😀\nsecond line", "답변 👨‍👩‍👧‍👦"]);
    const abort = new AbortController(), pending = readHistoryPreview(app.path, "tree", "saved", abort.signal); abort.abort();
    expect(expectError(await pending).code).toBe("CANCELLED");
  } finally { await app.close(); }
});

test("반환 섹션은 크기 제한과 잘림 여부를 명시하고 취소를 구분한다", async () => {
  const app = await fixture([header, message("q", null, "user", "x".repeat(historyPreviewLimit + 20))]);
  try {
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(preview.sections?.[0]?.text.length).toBe(historyPreviewSectionLimit); expect(preview.text.length).toBeLessThanOrEqual(historyPreviewLimit); expect(preview.truncated).toBe(true);
    await writeFile(app.path, [header, message("q", null, "user", "x".repeat(historyPreviewSectionLimit - 1) + "😀tail")].map((value) => JSON.stringify(value)).join("\n"));
    const unicode = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(unicode.sections?.[0]?.text.length).toBe(historyPreviewSectionLimit - 1); expect(unicode.sections?.[0]?.text.endsWith("x")).toBe(true); expect(unicode.truncated).toBe(true);
    await writeFile(app.path, Buffer.alloc(4 * 1024 * 1024 + 1, 32));
    expect(expectError(await readHistoryPreview(app.path, "tree", "saved")).code).toBe("HISTORY_CORRUPT");
    const abort = new AbortController(); abort.abort();
    expect(expectError(await readHistoryPreview(app.path, "tree", "saved", abort.signal)).code).toBe("CANCELLED");
  } finally { await app.close(); }
});
