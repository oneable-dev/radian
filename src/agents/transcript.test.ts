import { expect, test } from "bun:test";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { fixtureMessage } from "../testing/offline-runtime.ts";
import { SessionTranscript } from "./transcript.ts";

type Message = AgentSession["messages"][number];
function complete(transcript: SessionTranscript, message: Message): void {
  transcript.handle({ type: "message_start", message });
  transcript.handle({ type: "message_end", message });
}

test("Parallel tool calls pair reversed results by call ID and preserve unknown arguments", () => {
  // Identical tool names must not cause the second result to overwrite the first call.
  const transcript = new SessionTranscript([]);
  const assistant = fixtureMessage("openai-responses", "openai", "fixture");
  assistant.stopReason = "toolUse";
  assistant.content = [
    { type: "thinking", thinking: "Plan the request" },
    { type: "text", text: "Reading both nodes" },
    { type: "toolCall", id: "a", name: "unknown_bridge", arguments: { arbitrary: "first" } },
    { type: "toolCall", id: "b", name: "unknown_bridge", arguments: { nested: { key: "second" } } },
  ];
  complete(transcript, assistant);

  complete(transcript, {
    role: "toolResult",
    toolCallId: "b",
    toolName: "unknown_bridge",
    content: [{ type: "text", text: "second result" }],
    isError: true,
    timestamp: 2,
  });
  complete(transcript, {
    role: "toolResult",
    toolCallId: "a",
    toolName: "unknown_bridge",
    content: [{ type: "text", text: "first result" }],
    isError: false,
    timestamp: 3,
  });

  expect(transcript.sections.map((section) => section.kind)).toEqual([
    "thinking",
    "assistant",
    "tool",
    "tool",
  ]);
  const tools = transcript.sections.filter((section) => section.kind === "tool");
  expect(tools[0]?.toolCallId).toBe("a");
  expect(tools[0]?.status).toBe("complete");
  expect(tools[0]?.text).toContain('"arbitrary": "first"');
  expect(tools[0]?.text).toContain("first result");
  expect(tools[1]?.toolCallId).toBe("b");
  expect(tools[1]?.status).toBe("error");
  expect(tools[1]?.error).toBe("second result");
  expect(tools[1]?.text).toContain('"nested"');
});

test("Streaming blocks retain section IDs through completion and include intermediate tool results", () => {
  const transcript = new SessionTranscript([]);
  const partial = fixtureMessage("openai-responses", "openai", "fixture");
  partial.content = [
    { type: "text", text: "first" },
    { type: "toolCall", id: "call", name: "bash", arguments: { command: "probe" } },
  ];
  transcript.handle({ type: "message_start", message: partial });
  const ids = transcript.sections.map((section) => section.id);

  // Public message_end arrives before SDK persistence; it must update, not duplicate, the live row.
  const final = {
    ...partial,
    content: [{ type: "text" as const, text: "first and final" }, partial.content[1]!],
  };
  transcript.handle({ type: "message_end", message: final });
  transcript.handle({
    type: "tool_execution_start",
    toolCallId: "call",
    toolName: "bash",
    args: { command: "probe" },
  });
  transcript.handle({
    type: "tool_execution_update",
    toolCallId: "call",
    toolName: "bash",
    args: { command: "probe" },
    partialResult: { content: [{ type: "text", text: "progress" }] },
  });

  expect(transcript.sections.map((section) => section.id)).toEqual(ids);
  expect(transcript.sections[0]?.text).toBe("first and final");
  expect(transcript.sections[1]?.status).toBe("running");
  expect(transcript.sections[1]?.text).toContain("progress");
  transcript.handle({ type: "agent_settled", aborted: true });
  expect(transcript.sections[1]?.status).toBe("cancelled");
});

test("Saved conversations restore full source and entry IDs without 12-section or preview truncation", () => {
  // SessionManager is in-memory; this test never writes to the user's JSONL history.
  const manager = SessionManager.inMemory("/fixture");
  const first = manager.appendMessage({ role: "user", content: "x".repeat(14000), timestamp: 1 });
  for (let index = 0; index < 20; index++)
    manager.appendMessage({ role: "user", content: `message ${index}`, timestamp: index + 2 });

  const transcript = new SessionTranscript(manager.getBranch());

  expect(transcript.sections).toHaveLength(21);
  expect(transcript.sections[0]?.id).toBe(first);
  expect(transcript.sections[0]?.text).toBe("x".repeat(14000));
});

test("Live and restored image/file summaries match while keeping source text separate from image data", () => {
  const manager = SessionManager.inMemory("/fixture"),
    live = new SessionTranscript([]);
  const message: Message = {
    role: "user",
    timestamp: 1,
    content: [
      { type: "text", text: 'Inspect [Image #1] [Image #2] @"/private/workspace/panel.ts"' },
      { type: "image", mimeType: "image/png", data: "OPAQUE_IMAGE_BYTES_ONE" },
      { type: "image", mimeType: "image/jpeg", data: "OPAQUE_IMAGE_BYTES_TWO" },
    ],
  };
  manager.appendMessage(message);
  complete(live, message);
  const restored = new SessionTranscript(manager.getBranch());
  for (const transcript of [live, restored]) {
    expect(transcript.sections[0]?.request).toEqual({
      text: "Inspect",
      images: 2,
      files: 1,
      fileName: "panel.ts",
    });
    expect(transcript.sections[0]?.text).toContain('@"/private/workspace/panel.ts"');
    expect(transcript.sections[0]?.text).not.toContain("[Image");
    expect(
      transcript.sections.filter((section) => section.image).map((section) => section.image?.name),
    ).toEqual(["clipboard-1.png", "clipboard-2.jpg"]);
    expect(JSON.stringify(transcript.sections)).not.toContain("OPAQUE_IMAGE_BYTES");
  }
});

test("Redacted Thinking hides signatures and provides readable image and error fallbacks", () => {
  const transcript = new SessionTranscript([]);
  const assistant = fixtureMessage("openai-responses", "openai", "fixture");
  assistant.content = [
    {
      type: "thinking",
      thinking: "not visible",
      redacted: true,
      thinkingSignature: "opaque-secret",
    },
  ];
  complete(transcript, assistant);
  complete(transcript, {
    role: "user",
    content: [{ type: "image", mimeType: "image/png", data: "opaque-image" }],
    timestamp: 2,
  });
  const error = {
    ...assistant,
    content: [],
    stopReason: "error" as const,
    errorMessage: "Provider failed",
  };

  complete(transcript, error);

  expect(transcript.sections.map((section) => section.text)).toEqual([
    "[Thinking redacted]",
    "clipboard-1.png",
    "Provider failed",
  ]);
  expect(JSON.stringify(transcript.sections)).not.toContain("opaque-secret");
  expect(transcript.sections.at(-1)?.status).toBe("error");
});

test.each([false, true])(
  "Cancellation preserves partial %s responses without error cards or duplicate error text",
  (partial) => {
    // The SDK puts cancellation text in errorMessage too; stopReason is authoritative.
    let now = 1000;
    const transcript = new SessionTranscript([], { wallTime: () => now, monotonicTime: () => now });
    const assistant = fixtureMessage("openai-responses", "fixture", "fixture");
    assistant.stopReason = "aborted";
    assistant.errorMessage = "Request was aborted";
    assistant.content = partial ? [{ type: "text", text: "Keep the partial response" }] : [];
    transcript.handle({ type: "agent_start" });
    complete(transcript, { role: "user", content: "/ne", timestamp: now });

    complete(transcript, assistant);
    now += 1200;
    const completion = transcript.handle({ type: "agent_settled", aborted: true });

    expect(completion).toMatchObject({ outcome: "cancelled", durationMs: 1200 });
    expect(transcript.sections.at(-1)?.completion).toEqual(completion);
    expect(
      transcript.sections.some(
        (section) => section.title === "Agent error" || section.error !== undefined,
      ),
    ).toBe(false);
    expect(JSON.stringify(transcript.sections)).not.toContain("Request was aborted");
    if (partial)
      expect(transcript.sections.find((section) => section.kind === "assistant")?.text).toBe(
        "Keep the partial response",
      );

    // Saved JSONL retains the original SDK result; rebuilding display metadata must behave identically.
    const manager = SessionManager.inMemory("/fixture");
    manager.appendMessage({ role: "user", content: "/ne", timestamp: 1000 });
    manager.appendMessage(assistant);
    manager.appendCustomEntry("radian.run-completion.v1", completion);
    const restored = new SessionTranscript(manager.getBranch());
    expect(restored.sections.at(-1)?.completion).toEqual(completion);
    expect(JSON.stringify(restored.sections)).not.toContain("Request was aborted");
  },
);

test("SDK skill calls show names while preserving trailing user requests as separate sections", () => {
  // Explicit invocation metadata is authoritative; hidden instructions and paths are not display text.
  const transcript = new SessionTranscript([]);
  const text =
    '<skill name="write-good-code" location="/private/skills/write-good-code/SKILL.md">\nInternal skill instructions\n</skill>\n\nImplement the button';

  complete(transcript, { role: "user", content: text, timestamp: 1 });

  expect(transcript.sections).toHaveLength(2);
  expect(transcript.sections[0]).toMatchObject({
    kind: "notice",
    title: "write-good-code",
    text: "write-good-code",
    skillName: "write-good-code",
  });
  expect(transcript.sections[1]).toMatchObject({ kind: "user", text: "Implement the button" });
  expect(JSON.stringify(transcript.sections)).not.toContain("Internal skill instructions");
  expect(JSON.stringify(transcript.sections)).not.toContain("/private/");
});

test("Image skill requests never duplicate internal instructions or generated placeholders into summaries", () => {
  const transcript = new SessionTranscript([]);
  complete(transcript, {
    role: "user",
    timestamp: 1,
    content: [
      {
        type: "text",
        text: '<skill name="review-code" location="/private/SKILL.md">\nRead @"/private/internal.ts"\n</skill>\n\nReview [Image #1]',
      },
      { type: "image", mimeType: "image/png", data: "PRIVATE_IMAGE_BYTES" },
    ],
  });
  expect(transcript.sections.find((section) => section.kind === "user")?.request).toEqual({
    text: "Review",
    images: 1,
    files: 0,
  });
  expect(transcript.sections.at(-1)?.image?.name).toBe("clipboard-1.png");
  expect(JSON.stringify(transcript.sections)).not.toContain("internal.ts");
  expect(JSON.stringify(transcript.sections)).not.toContain("PRIVATE_IMAGE_BYTES");
});

test.each([120, 0.5, undefined, 0, -1, Infinity, "120"])(
  "Bash timeout projection preserves only explicitly valid seconds: %j",
  (timeout) => {
    // Never invent limits for commands with missing or invalid timeout values.
    const manager = SessionManager.inMemory("/fixture"),
      assistant = fixtureMessage("openai-responses", "openai", "fixture");
    assistant.content = [
      {
        type: "toolCall",
        id: "shell",
        name: "bash",
        arguments: {
          command: "printf '한글'\nprintf done",
          ...(timeout !== undefined ? { timeout } : {}),
        },
      },
    ];
    manager.appendMessage(assistant);
    // Saved history and live events project identical command summaries and limits.
    const live = new SessionTranscript([]);
    complete(live, assistant);
    const restored = new SessionTranscript(manager.getBranch());
    for (const section of [live.sections[0]!, restored.sections[0]!]) {
      expect(section.command).toBe("printf '한글'\nprintf done");
      expect(section.timeoutSeconds).toBe(
        typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
          ? timeout
          : undefined,
      );
      expect(section.text).toContain('"command":');
    }
  },
);

test("Long command previews preserve Unicode, timeouts, and original text while truncating display", () => {
  // Emoji at UTF-16 boundaries must not produce isolated surrogates.
  const assistant = fixtureMessage("openai-responses", "openai", "fixture"),
    transcript = new SessionTranscript([]);
  const command = "a".repeat(4094) + "😀 tail";
  assistant.content = [
    { type: "toolCall", id: "long-shell", name: "bash", arguments: { command, timeout: 120 } },
  ];
  complete(transcript, assistant);
  // Preview limits and execution arguments are separate contracts; retain source and timeout.
  expect(transcript.sections[0]?.command).toBe("a".repeat(4094) + "…");
  expect(transcript.sections[0]?.timeoutSeconds).toBe(120);
  expect(transcript.sections[0]?.text).toContain(command);
});

test("Generic tools never infer timeout units and preserve concise read targets and start lines", () => {
  // Extension timeout units are unknown and must not inherit Bash semantics.
  const assistant = fixtureMessage("openai-responses", "openai", "fixture"),
    transcript = new SessionTranscript([]);
  assistant.content = [
    {
      type: "toolCall",
      id: "read",
      name: "read",
      arguments: { path: "/fixture/SKILL.md", offset: 7 },
    },
    { type: "toolCall", id: "extension", name: "custom_bridge", arguments: { timeout: 120 } },
  ];
  complete(transcript, assistant);
  // Ordinary reads remain tools, not skills, and retain original extension arguments.
  expect(transcript.sections[0]?.summary).toBe("/fixture/SKILL.md:7");
  expect(transcript.sections[0]?.skillName).toBeUndefined();
  expect(transcript.sections[1]?.timeoutSeconds).toBeUndefined();
  expect(transcript.sections[1]?.summary).toContain('"timeout":120');
});

test("Ordinary SKILL.md reads remain tool executions rather than inferred skill calls", () => {
  const transcript = new SessionTranscript([]);
  const assistant = fixtureMessage("openai-responses", "openai", "fixture");
  assistant.content = [
    { type: "toolCall", id: "read-skill", name: "read", arguments: { path: "/fixture/SKILL.md" } },
  ];

  complete(transcript, assistant);
  complete(transcript, {
    role: "toolResult",
    toolName: "read",
    toolCallId: "read-skill",
    content: [{ type: "text", text: "Ordinary file contents" }],
    isError: false,
    timestamp: 2,
  });

  expect(transcript.sections).toHaveLength(1);
  expect(transcript.sections[0]?.kind).toBe("tool");
  expect(transcript.sections[0]?.skillName).toBeUndefined();
  expect(transcript.sections[0]?.text).toContain("Ordinary file contents");
});
