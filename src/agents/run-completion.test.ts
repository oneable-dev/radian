import { expect, test } from "bun:test";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { SessionTranscript } from "./transcript.ts";
import { runCompletionEntryType, type RunClock } from "./run-completion.ts";
import { fixtureMessage } from "../testing/offline-runtime.ts";

type Message = AgentSession["messages"][number];
const message = (transcript: SessionTranscript, value: Message) => { transcript.handle({ type: "message_start", message: value }); transcript.handle({ type: "message_end", message: value }); };
function fixture() {
  let wall = 1000000, mono = 100;
  const clock: RunClock = { wallTime: () => wall, monotonicTime: () => mono };
  const transcript = new SessionTranscript([], clock);
  const assistant = fixtureMessage("openai-responses", "fixture", "fixture"); assistant.content = [{ type: "text", text: "Final answer" }];
  return { transcript, assistant, advance(ms: number) { wall += ms; mono += ms; }, jumpWall(ms: number) { wall += ms; } };
}

test("응답·도구가 끝나도 settled 전에는 완료 정보를 만들지 않고 전체 실행 시간을 한 번만 확정한다", () => {
  // 도구 결과와 개별 모델 응답의 종료는 요청 전체의 완료가 아니다.
  const app = fixture(), t = app.transcript;
  t.handle({ type: "agent_start" }); message(t, { role: "user", content: "Do work", timestamp: 1 });
  app.advance(30000); message(t, app.assistant);
  t.handle({ type: "agent_end", messages: [], willRetry: false });
  expect(t.sections.some((section) => section.completion)).toBe(false);
  // 재시도 등 후속 구간까지 포함한 90초를 최종 이벤트에서만 고정한다.
  app.advance(60000); const completion = t.handle({ type: "agent_settled", aborted: false });
  expect(completion).toMatchObject({ startedAt: 1000000, completedAt: 1090000, durationMs: 90000, outcome: "complete" });
  expect(t.sections.at(-1)?.completion).toEqual(completion);
  app.advance(5000); expect(t.handle({ type: "agent_settled", aborted: false })).toBeUndefined();
  expect(t.sections.at(-1)?.completion?.durationMs).toBe(90000);
});

test("재시도와 이어진 agent_start는 첫 실행 시각을 초기화하지 않고 중간 실패에 완료 표시를 붙이지 않는다", () => {
  const app = fixture(), t = app.transcript;
  t.handle({ type: "agent_start" }); message(t, { role: "user", content: "Retry", timestamp: 1 });
  message(t, { ...app.assistant, stopReason: "error", errorMessage: "Retryable failure" }); app.advance(30000);
  t.handle({ type: "agent_start" }); expect(t.sections.some((section) => section.completion)).toBe(false);
  message(t, app.assistant); app.advance(60000); t.handle({ type: "agent_settled", aborted: false });
  expect(t.sections.filter((section) => section.completion)).toHaveLength(1);
  expect(t.sections.at(-1)?.completion).toMatchObject({ durationMs: 90000, outcome: "complete" });
});

test.each(["error", "cancelled", "unfinished"] as const)("실패·취소·미확정 종료는 정상 완료로 만들지 않는다: %s", (outcome) => {
  const app = fixture(), t = app.transcript;
  t.handle({ type: "agent_start" }); message(t, { role: "user", content: "Do work", timestamp: 1 });
  message(t, { ...app.assistant, stopReason: outcome === "error" ? "error" : outcome === "cancelled" ? "aborted" : "toolUse" });
  app.advance(1200); t.handle({ type: "agent_settled", aborted: outcome === "cancelled" });
  expect(t.sections.at(-1)?.completion?.outcome).toBe(outcome);
});

test("실제 처리 시간은 monotonic clock을 쓰고 다음 요청의 대기·세션 경과 시간은 더하지 않는다", () => {
  const app = fixture(), t = app.transcript;
  t.handle({ type: "agent_start" }); message(t, app.assistant); app.advance(90000); app.jumpWall(-60000);
  t.handle({ type: "agent_settled", aborted: false }); expect(t.sections.at(-1)?.completion?.durationMs).toBe(90000);
  app.advance(120000); t.handle({ type: "agent_start" }); message(t, app.assistant); app.advance(1000);
  t.handle({ type: "agent_settled", aborted: false });
  expect(t.sections.filter((section) => section.completion).map((section) => section.completion?.durationMs)).toEqual([90000, 1000]);
});

test("실행을 시작하지 않은 명령·옛 기록에는 완료 시간이나 현재 날짜를 추측해 붙이지 않는다", () => {
  const app = fixture(); message(app.transcript, app.assistant); app.transcript.handle({ type: "agent_settled", aborted: false });
  expect(app.transcript.sections.at(-1)?.completion).toBeUndefined();
  const manager = SessionManager.inMemory("/fixture"); manager.appendMessage(app.assistant);
  expect(new SessionTranscript(manager.getBranch()).sections.at(-1)?.completion).toBeUndefined();
});

test("버전이 명시된 SDK 메타데이터는 원문이나 모델 대화를 바꾸지 않고 해당 답변의 완료 정보를 복원한다", () => {
  const manager = SessionManager.inMemory("/fixture"), app = fixture();
  manager.appendMessage({ role: "user", content: "First", timestamp: 1 }); manager.appendMessage(app.assistant);
  const completion = { startedAt: 1000000, completedAt: 1090000, durationMs: 90000, outcome: "complete" as const };
  manager.appendCustomEntry(runCompletionEntryType, completion);
  manager.appendMessage({ role: "user", content: "Next question", timestamp: 2 });
  const sections = new SessionTranscript(manager.getBranch()).sections;
  expect(sections.map((section) => section.text)).toEqual(["First", "Final answer", "Next question"]);
  expect(sections[1]?.completion).toEqual(completion); expect(sections[2]?.completion).toBeUndefined();
});

test("잘못된 자체 메타데이터는 완료를 조작하지 않고 명시적인 손상 안내로 표시한다", () => {
  const manager = SessionManager.inMemory("/fixture"), app = fixture(); manager.appendMessage(app.assistant);
  manager.appendCustomEntry(runCompletionEntryType, { durationMs: -1 });
  const sections = new SessionTranscript(manager.getBranch()).sections;
  expect(sections.some((section) => section.completion)).toBe(false);
  expect(sections.at(-1)?.text).toContain("HISTORY_CORRUPT");
});
