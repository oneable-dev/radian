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

test("실제 이미지 블록과 파일 참조 요약은 실시간·저장 복원에서 같고 원문과 이미지 데이터는 분리한다", () => {
  const manager = SessionManager.inMemory("/fixture"), live = new SessionTranscript([]);
  const message: Message = { role: "user", timestamp: 1, content: [
    { type: "text", text: 'Inspect [Image #1] [Image #2] @"/private/workspace/panel.ts"' },
    { type: "image", mimeType: "image/png", data: "OPAQUE_IMAGE_BYTES_ONE" },
    { type: "image", mimeType: "image/jpeg", data: "OPAQUE_IMAGE_BYTES_TWO" },
  ] };
  manager.appendMessage(message); complete(live, message);
  const restored = new SessionTranscript(manager.getBranch());
  for (const transcript of [live, restored]) {
    expect(transcript.sections[0]?.request).toEqual({ text: "Inspect", images: 2, files: 1, fileName: "panel.ts" });
    expect(transcript.sections[0]?.text).toContain('@"/private/workspace/panel.ts"');
    expect(transcript.sections[0]?.text).toContain("[Image: image/png]");
    expect(JSON.stringify(transcript.sections)).not.toContain("OPAQUE_IMAGE_BYTES");
  }
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

test("이미지가 있는 스킬 요청도 내부 지침이나 생성된 이미지 placeholder를 요약으로 복제하지 않는다", () => {
  const transcript = new SessionTranscript([]);
  complete(transcript, { role: "user", timestamp: 1, content: [
    { type: "text", text: '<skill name="review-code" location="/private/SKILL.md">\nRead @"/private/internal.ts"\n</skill>\n\nReview [Image #1]' },
    { type: "image", mimeType: "image/png", data: "PRIVATE_IMAGE_BYTES" },
  ] });
  expect(transcript.sections.at(-1)?.request).toEqual({ text: "Review", images: 1, files: 0 });
  expect(JSON.stringify(transcript.sections)).not.toContain("internal.ts");
  expect(JSON.stringify(transcript.sections)).not.toContain("PRIVATE_IMAGE_BYTES");
});

test.each([120, 0.5, undefined, 0, -1, Infinity, "120"])("bash timeout은 명시한 유효 초 단위 값만 표시 데이터에 보존한다: %j", (timeout) => {
  // timeout이 없는 명령이나 유효하지 않은 값에 임의 제한을 만들어 붙이지 않는다.
  const manager = SessionManager.inMemory("/fixture"), assistant = fixtureMessage("openai-responses", "openai", "fixture");
  assistant.content = [{ type: "toolCall", id: "shell", name: "bash", arguments: { command: "printf '한글'\nprintf done", ...(timeout !== undefined ? { timeout } : {}) } }];
  manager.appendMessage(assistant);
  // 저장 기록과 실시간 이벤트가 동일한 명령 요약과 제한 값을 투영한다.
  const live = new SessionTranscript([]); complete(live, assistant);
  const restored = new SessionTranscript(manager.getBranch());
  for (const section of [live.sections[0]!, restored.sections[0]!]) {
    expect(section.command).toBe("printf '한글'\nprintf done");
    expect(section.timeoutSeconds).toBe(typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? timeout : undefined);
    expect(section.text).toContain('"command":');
  }
});

test("긴 명령 미리보기는 Unicode를 깨뜨리지 않고 자르되 timeout과 원문을 보존한다", () => {
  // UTF-16 제한 경계에 이모지가 걸려도 고립된 surrogate를 만들지 않는다.
  const assistant = fixtureMessage("openai-responses", "openai", "fixture"), transcript = new SessionTranscript([]);
  const command = "a".repeat(4094) + "😀 tail";
  assistant.content = [{ type: "toolCall", id: "long-shell", name: "bash", arguments: { command, timeout: 120 } }];
  complete(transcript, assistant);
  // 미리보기 제한과 실행 인수는 별도 계약이므로 원문이나 시간 제한을 잘라 버리지 않는다.
  expect(transcript.sections[0]?.command).toBe("a".repeat(4094) + "…");
  expect(transcript.sections[0]?.timeoutSeconds).toBe(120); expect(transcript.sections[0]?.text).toContain(command);
});

test("일반 도구는 timeout 단위를 추측하지 않고 read 대상과 시작 줄을 간결하게 보존한다", () => {
  // 확장 도구의 timeout 필드가 밀리초인지 초인지 알 수 없으므로 Bash 계약과 혼동하지 않는다.
  const assistant = fixtureMessage("openai-responses", "openai", "fixture"), transcript = new SessionTranscript([]);
  assistant.content = [
    { type: "toolCall", id: "read", name: "read", arguments: { path: "/fixture/SKILL.md", offset: 7 } },
    { type: "toolCall", id: "extension", name: "custom_bridge", arguments: { timeout: 120 } },
  ];
  complete(transcript, assistant);
  // 일반 파일 읽기는 스킬 호출로 바꾸지 않으며 확장 인수 원문은 계속 남긴다.
  expect(transcript.sections[0]?.summary).toBe("/fixture/SKILL.md:7");
  expect(transcript.sections[0]?.skillName).toBeUndefined();
  expect(transcript.sections[1]?.timeoutSeconds).toBeUndefined(); expect(transcript.sections[1]?.summary).toContain('"timeout":120');
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
