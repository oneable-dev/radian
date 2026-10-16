import { expect, test } from "bun:test";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { fixtureMessage } from "../testing/offline-runtime.ts";
import { SessionTranscript } from "./transcript.ts";

type Message = AgentSession["messages"][number];
function complete(transcript: SessionTranscript, message: Message): void {
  transcript.handle({ type: "message_start", message }); transcript.handle({ type: "message_end", message });
}

test("같은 도구의 병렬 호출과 역순 결과를 호출 ID로 묶고 알 수 없는 인수를 보존한다", () => {
  // Identical tool names must not cause the second result to overwrite the first call.
  const transcript = new SessionTranscript([]);
  const assistant = fixtureMessage("openai-responses", "openai", "fixture");
  assistant.stopReason = "toolUse";
  assistant.content = [
    { type: "thinking", thinking: "Plan the request" }, { type: "text", text: "Reading both nodes" },
    { type: "toolCall", id: "a", name: "unknown_bridge", arguments: { arbitrary: "first" } },
    { type: "toolCall", id: "b", name: "unknown_bridge", arguments: { nested: { key: "second" } } },
  ];
  complete(transcript, assistant);

  complete(transcript, { role: "toolResult", toolCallId: "b", toolName: "unknown_bridge", content: [{ type: "text", text: "second result" }], isError: true, timestamp: 2 });
  complete(transcript, { role: "toolResult", toolCallId: "a", toolName: "unknown_bridge", content: [{ type: "text", text: "first result" }], isError: false, timestamp: 3 });

  expect(transcript.sections.map((section) => section.kind)).toEqual(["thinking", "assistant", "tool", "tool"]);
  const tools = transcript.sections.filter((section) => section.kind === "tool");
  expect(tools[0]?.toolCallId).toBe("a"); expect(tools[0]?.status).toBe("complete");
  expect(tools[0]?.text).toContain('"arbitrary": "first"'); expect(tools[0]?.text).toContain("first result");
  expect(tools[1]?.toolCallId).toBe("b"); expect(tools[1]?.status).toBe("error");
  expect(tools[1]?.error).toBe("second result"); expect(tools[1]?.text).toContain('"nested"');
});

test("스트리밍 블록은 완료까지 같은 섹션 ID를 유지하며 도구 중간 결과도 반영한다", () => {
  const transcript = new SessionTranscript([]);
  const partial = fixtureMessage("openai-responses", "openai", "fixture");
  partial.content = [{ type: "text", text: "first" }, { type: "toolCall", id: "call", name: "bash", arguments: { command: "probe" } }];
  transcript.handle({ type: "message_start", message: partial });
  const ids = transcript.sections.map((section) => section.id);

  // Public message_end arrives before SDK persistence; it must update, not duplicate, the live row.
  const final = { ...partial, content: [{ type: "text" as const, text: "first and final" }, partial.content[1]!] };
  transcript.handle({ type: "message_end", message: final });
  transcript.handle({ type: "tool_execution_start", toolCallId: "call", toolName: "bash", args: { command: "probe" } });
  transcript.handle({ type: "tool_execution_update", toolCallId: "call", toolName: "bash", args: { command: "probe" }, partialResult: { content: [{ type: "text", text: "progress" }] } });

  expect(transcript.sections.map((section) => section.id)).toEqual(ids);
  expect(transcript.sections[0]?.text).toBe("first and final");
  expect(transcript.sections[1]?.status).toBe("running"); expect(transcript.sections[1]?.text).toContain("progress");
  transcript.handle({ type: "agent_settled", aborted: true });
  expect(transcript.sections[1]?.status).toBe("cancelled");
});

test("저장 대화는 최근 12개나 미리보기 길이로 잘리지 않고 원문과 저장 엔트리 ID를 복원한다", () => {
  // SessionManager is in-memory; this test never writes to the user's JSONL history.
  const manager = SessionManager.inMemory("/fixture");
  const first = manager.appendMessage({ role: "user", content: "x".repeat(14000), timestamp: 1 });
  for (let index = 0; index < 20; index++) manager.appendMessage({ role: "user", content: `message ${index}`, timestamp: index + 2 });

  const transcript = new SessionTranscript(manager.getBranch());

  expect(transcript.sections).toHaveLength(21);
  expect(transcript.sections[0]?.id).toBe(first);
  expect(transcript.sections[0]?.text).toBe("x".repeat(14000));
});

test("redacted Thinking은 서명을 노출하지 않고 이미지와 실패 메시지에 읽을 수 있는 대체 표시를 둔다", () => {
  const transcript = new SessionTranscript([]);
  const assistant = fixtureMessage("openai-responses", "openai", "fixture");
  assistant.content = [{ type: "thinking", thinking: "not visible", redacted: true, thinkingSignature: "opaque-secret" }];
  complete(transcript, assistant);
  complete(transcript, { role: "user", content: [{ type: "image", mimeType: "image/png", data: "opaque-image" }], timestamp: 2 });
  const error = { ...assistant, content: [], stopReason: "error" as const, errorMessage: "Provider failed" };

  complete(transcript, error);

  expect(transcript.sections.map((section) => section.text)).toEqual(["[Thinking redacted]", "[Image: image/png]", "Provider failed"]);
  expect(JSON.stringify(transcript.sections)).not.toContain("opaque-secret");
  expect(transcript.sections.at(-1)?.status).toBe("error");
});

test("SDK 스킬 호출은 이름만 남기고 뒤따르는 사용자 요청을 별도 섹션으로 보존한다", () => {
  // Explicit invocation metadata is authoritative; hidden instructions and paths are not display text.
  const transcript = new SessionTranscript([]);
  const text = '<skill name="write-good-code" location="/private/skills/write-good-code/SKILL.md">\nInternal skill instructions\n</skill>\n\nImplement the button';

  complete(transcript, { role: "user", content: text, timestamp: 1 });

  expect(transcript.sections).toHaveLength(2);
  expect(transcript.sections[0]).toMatchObject({ kind: "notice", title: "write-good-code", text: "write-good-code", skillName: "write-good-code" });
  expect(transcript.sections[1]).toMatchObject({ kind: "user", text: "Implement the button" });
  expect(JSON.stringify(transcript.sections)).not.toContain("Internal skill instructions");
  expect(JSON.stringify(transcript.sections)).not.toContain("/private/");
});

test("일반 SKILL.md 읽기를 스킬 호출로 추측하지 않고 도구 실행으로 유지한다", () => {
  const transcript = new SessionTranscript([]);
  const assistant = fixtureMessage("openai-responses", "openai", "fixture");
  assistant.content = [{ type: "toolCall", id: "read-skill", name: "read", arguments: { path: "/fixture/SKILL.md" } }];

  complete(transcript, assistant);
  complete(transcript, { role: "toolResult", toolName: "read", toolCallId: "read-skill", content: [{ type: "text", text: "Ordinary file contents" }], isError: false, timestamp: 2 });

  expect(transcript.sections).toHaveLength(1);
  expect(transcript.sections[0]?.kind).toBe("tool");
  expect(transcript.sections[0]?.skillName).toBeUndefined();
  expect(transcript.sections[0]?.text).toContain("Ordinary file contents");
});
