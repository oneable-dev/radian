import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { commandDisplay, commandDisplayEntryType, parseCommandDisplay } from "./command-display.ts";
import { SessionTranscript } from "./transcript.ts";
import { expectError } from "../testing/results.ts";

test.each([
  ["/review", [{ commandName: "review", text: "/review" }]],
  [
    '/review src/agents\nkeep "quoted args"',
    [{ commandName: "review", text: "/review" }, { text: 'src/agents\nkeep "quoted args"' }],
  ],
  ["/unknown args", undefined],
  ["ordinary /review", undefined],
] as const)(
  "Only loaded prompt templates retain their literal invocation: %s",
  (input, expected) => {
    // Only actual file-based commands may replace expanded instructions in the display.
    const templates = ["review"];

    const display = commandDisplay(input, templates);

    // Quotes and multiline user arguments remain literal, unlike template substitutions.
    expect(display).toEqual(expected);
  },
);

test("Command display metadata hides instructions live and after restoring message identities", () => {
  // The SDK history contains instructions, while the annotation contains only operator input.
  const message = { role: "user" as const, content: "PRIVATE_TEMPLATE_INSTRUCTIONS", timestamp: 1 };
  const parts = commandDisplay("/review src/agents", ["review"])!;
  const live = new SessionTranscript([]);

  live.handle({ type: "message_start", message }, parts);
  live.handle({ type: "message_end", message });
  const manager = SessionManager.inMemory("/fixture");
  const messageId = manager.appendMessage(message);
  manager.appendCustomEntry(commandDisplayEntryType, { messageId, parts });
  const restored = new SessionTranscript(manager.getBranch());

  // Display persistence never injects UI annotations into the model context.
  for (const transcript of [live, restored]) {
    expect(transcript.sections.map(({ text, commandName }) => ({ text, commandName }))).toEqual([
      { text: "/review", commandName: "review" },
      { text: "src/agents", commandName: undefined },
    ]);
    expect(transcript.sections.at(-1)?.request?.text).toBe("/review src/agents");
    expect(JSON.stringify(transcript.sections)).not.toContain("PRIVATE_TEMPLATE_INSTRUCTIONS");
  }
  expect(JSON.stringify(manager.buildSessionContext().messages)).toContain(
    "PRIVATE_TEMPLATE_INSTRUCTIONS",
  );
  expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain(
    commandDisplayEntryType,
  );
});

test("Identical ordinary prompts are not mistaken for commands with the same expanded body", () => {
  // A normal message must not inherit another message's display annotation.
  const manager = SessionManager.inMemory("/fixture");
  const command = manager.appendMessage({ role: "user", content: "Same body", timestamp: 1 });
  manager.appendCustomEntry(commandDisplayEntryType, {
    messageId: command,
    parts: commandDisplay("/review", ["review"]),
  });
  manager.appendMessage({ role: "user", content: "Same body", timestamp: 1 });

  const transcript = new SessionTranscript(manager.getBranch());

  // Message IDs, not timestamps or body matching, determine invocation identity.
  expect(transcript.sections.map((section) => section.text)).toEqual(["/review", "Same body"]);
  expect(transcript.sections[1]?.commandName).toBeUndefined();
});

test("Invalid saved command metadata returns a stable history error", () => {
  // Persisted custom entries are an untyped disk boundary.
  const invalid = { messageId: "message", parts: [{ commandName: 42, text: "/review" }] };

  const result = parseCommandDisplay(invalid);

  // Invalid annotations must not silently hide ordinary user messages.
  expect(expectError(result).code).toBe("HISTORY_CORRUPT");
});
