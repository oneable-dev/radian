import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readHistoryPreview, previewSessionSnapshot, historyPreviewLimit, historyPreviewSectionLimit } from "./history-preview.ts";
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
    expect(preview.sections?.map((section) => section.kind)).toEqual(["user", "user", "notice", "thinking", "assistant", "tool"]);
    expect(preview.text).toContain("Current answer"); expect(preview.text).toContain("Original question"); expect(preview.text).not.toContain("ABANDONED BRANCH");
    expect(preview.worktreeId).toBe("tree"); expect(preview.id).toBe("saved"); expect(preview.truncated).toBe(false);
    expect(opened).not.toHaveBeenCalled(); expect(await readFile(app.path, "utf8")).toBe(before);
  } finally { opened.mockRestore(); await app.close(); }
});

test("최신 15개 섹션만 Agent와 같은 도구·오류·redaction 표현으로 반환한다", async () => {
  // Several earlier turns and intermediate blocks must not displace the latest question/answer.
  const entries: unknown[] = [header, message("old-q", null, "user", "OLD QUESTION"), message("old-a", "old-q", "assistant", [{ type: "text", text: "OLD ANSWER" }]), message("q", "old-a", "user", "Latest request")];
  let parent = "q";
  for (let i = 1; i <= 14; i++) { entries.push(message(`a${i}`, parent, "assistant", [{ type: "text", text: `Step ${i}` }])); parent = `a${i}`; }
  entries.push(message("work", parent, "assistant", [{ type: "thinking", thinking: "HIDDEN THOUGHT", redacted: true, thinkingSignature: "SECRET SIGNATURE" }, { type: "toolCall", id: "call", name: "read", arguments: { path: "fixture.ts" } }]));
  entries.push({ ...message("result", "work", "toolResult", []), message: { role: "toolResult", toolCallId: "call", toolName: "read", isError: true, content: [{ type: "text", text: "Read failed" }] } });
  entries.push(message("final", "result", "assistant", [{ type: "text", text: "Latest answer" }]));
  const app = await fixture(entries);
  try {
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(preview.sections).toHaveLength(15);
    expect(preview.sections?.map((section) => section.text.split("\n")[0])).toEqual([
      ...Array.from({ length: 12 }, (_, index) => `Step ${index + 3}`), "[Thinking redacted]", "Arguments:", "Latest answer",
    ]);
    expect(preview.sections?.at(-2)).toMatchObject({ kind: "tool", title: "read", status: "error", error: "Read failed" });
    expect(preview.sections?.at(-2)?.text).toContain("Read failed"); expect(preview.truncated).toBe(false);
    expect(JSON.stringify(preview)).not.toMatch(/OLD QUESTION|OLD ANSWER|HIDDEN THOUGHT|SECRET SIGNATURE/);
  } finally { await app.close(); }
});

test("최근 15개 섹션은 이전 턴까지 시간순으로 포함하고 저장된 모델·effort만 복원한다", async () => {
  // 마지막 요청만으로는 15개가 되지 않는 여러 턴을 준비한다.
  const entries: unknown[] = [header];
  let parent: string | null = null;
  for (let turn = 1; turn <= 9; turn++) {
    entries.push(message(`q${turn}`, parent, "user", `Question ${turn}`));
    parent = `q${turn}`;
    if (turn === 9) {
      entries.push({ type: "thinking_level_change", id: "effort", parentId: parent, timestamp: header.timestamp, thinkingLevel: "high" });
      parent = "effort";
    }
    entries.push({ ...message(`a${turn}`, parent, "assistant", [{ type: "text", text: `Answer ${turn}` }]),
      message: { role: "assistant", content: [{ type: "text", text: `Answer ${turn}` }], provider: "fixture", model: "saved-model" } });
    parent = `a${turn}`;
  }
  const app = await fixture(entries);
  try {
    const before = await readFile(app.path, "utf8");

    // 최신 요청을 경계로 멈추지 않고 한정된 대화 꼬리를 읽는다.
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));

    // 잘린 시작은 두 번째 답변이며 현재 계정 사용량이나 Fast 설정은 추정하지 않는다.
    expect(preview.sections).toHaveLength(15);
    expect(preview.sections?.[0]?.text).toBe("Answer 2"); expect(preview.sections?.at(-1)?.text).toBe("Answer 9");
    expect(preview.sections?.slice(1, 5).map(section => section.text)).toEqual(["Question 3", "Answer 3", "Question 4", "Answer 4"]);
    expect(preview.telemetry).toEqual({ provider: "fixture", model: "saved-model", effort: "high", fast: null, context: null, weekly: null });
    expect(await readFile(app.path, "utf8")).toBe(before);
  } finally { await app.close(); }
});

test("공유 스냅샷의 미리보기 제한은 저장된 대화·실행 상태·telemetry를 수정하지 않는다", () => {
  // 공유 저장 record는 복구에도 쓰이므로 preview를 만든다고 본문을 잘라 저장하면 안 된다.
  const snapshot = { id: "tab", name: "Archived", worktreeId: "tree", lifecycle: "closed" as const, updatedAt: 1000,
    state: { conversationId: "saved", status: "failure" as const, error: "Saved failure", output: "Saved output",
      sections: Array.from({ length: 20 }, (_, index) => ({ id: `s${index}`, kind: "assistant" as const, title: "Agent", text: `Answer ${index} ` + "x".repeat(9000), status: "complete" as const })),
      telemetry: { provider: "fixture", model: "model", effort: "high", fast: true, context: { usedTokens: 100, maxTokens: 1000 }, weekly: null } }, subagents: [] };
  const before = JSON.stringify(snapshot);

  // 같은 record에서 IPC로 보낼 읽기 전용 projection만 만든다.
  const preview = previewSessionSnapshot(snapshot, "saved");

  // 최근 15개만 표시하고 복구용 원본이나 상태줄 정보는 손대지 않는다.
  expect(preview.snapshot?.state.sections).toHaveLength(15); expect(preview.snapshot?.state.sections?.[0]?.id).toBe("s5");
  expect(preview.snapshot?.state.sections?.[0]?.text).toHaveLength(historyPreviewSectionLimit); expect(preview.truncated).toBe(true);
  expect(preview.snapshot?.state.status).toBe("failure"); expect(preview.snapshot?.state.error).toBe("Saved failure");
  expect(preview.telemetry).toEqual(snapshot.state.telemetry); expect(JSON.stringify(snapshot)).toBe(before);
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

test("최근 대화의 완료 메타데이터를 유지하지만 새 미응답 요청에는 옛 완료를 붙이지 않는다", async () => {
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
    expect(next.sections?.map(section => section.text)).toEqual(["Question", "Answer", "Unanswered"]);
    expect(next.sections?.[1]?.completion).toEqual(completion); expect(next.sections?.at(-1)?.completion).toBeUndefined();
  } finally { await app.close(); }
});

test("선택한 분기의 손상된 완료 메타데이터는 실패 Result로 명시한다", async () => {
  const app = await fixture([header, message("q", null, "user", "Question"),
    { type: "custom", id: "bad", parentId: "q", timestamp: header.timestamp, customType: runCompletionEntryType, data: { durationMs: -1 } }]);
  try { expect(expectError(await readHistoryPreview(app.path, "tree", "saved")).code).toBe("HISTORY_CORRUPT"); }
  finally { await app.close(); }
});

test("최근 대화에 새 스킬 요청을 이어서 표시하되 스킬 지침은 노출하지 않는다", async () => {
  const skill = '<skill name="good-code" location="/private/SKILL.md">\nHIDDEN INSTRUCTIONS\n</skill>\n\nLatest skill request';
  const app = await fixture([header, message("q", null, "user", "OLD PROMPT"), message("a", "q", "assistant", [{ type: "text", text: "OLD ANSWER" }]), message("new", "a", "user", skill)]);
  try {
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(preview.sections).toHaveLength(4);
    expect(preview.sections?.[2]).toMatchObject({ kind: "notice", skillName: "good-code", text: "good-code" });
    expect(preview.sections?.[3]).toMatchObject({ kind: "user", text: "Latest skill request" });
    expect(JSON.stringify(preview)).not.toMatch(/HIDDEN INSTRUCTIONS|\/private/);
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

test("오래된 대형 기록이 안전 제한을 넘으면 완성된 최근 턴을 잘림 표시와 함께 반환한다", async () => {
  // A large old turn must not block the small recent turn or be loaded into the preview model.
  const app = await fixture([header, message("old", null, "user", "OLD PAYLOAD " + "x".repeat(20 * 1024 * 1024)),
    message("current-q", "old", "user", "CURRENT QUESTION"),
    message("current-a", "current-q", "assistant", [{ type: "thinking", thinking: "Current plan" }, { type: "text", text: "CURRENT ANSWER" }])]);
  try {
    const before = await readFile(app.path, "utf8");
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(preview.sections?.map((section) => section.text)).toEqual(["CURRENT QUESTION", "Current plan", "CURRENT ANSWER"]);
    expect(JSON.stringify(preview)).not.toContain("OLD PAYLOAD"); expect(preview.truncated).toBe(true);
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
    expect(preview.sections?.map((section) => section.text)).toEqual(["Root", "Current question", "Current answer"]);
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
    expect(preview.sections?.map((section) => section.toolCallId)).toEqual([undefined, "a", "b", "c"]);
    expect(preview.sections?.[1]?.text).toContain('"path": "a"'); expect(preview.sections?.[1]?.text).toContain("RESULT a");
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
