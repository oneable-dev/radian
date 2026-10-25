import { expect, test } from "bun:test";
import { Messages, messageText } from "./messages.ts";

test("Message retention keeps the latest 500 complete originals and ignores blank notices", () => {
  // Retention is bounded by entries, never by a message's visible preview length.
  const messages = new Messages(), original = "Detailed cause\n".repeat(1000);
  for (let index = 0; index < 500; index++) messages.add(`Old ${index}`, index);

  messages.add(original, 1000, { level: "error", source: "Editor" }); messages.add(" \n ", 1001);

  // Only the oldest record is evicted and the full error remains copyable.
  expect(messages.items).toHaveLength(500); expect(messages.items[0]).toMatchObject({ text: original, timestamp: 1000, level: "error", source: "Editor" });
  expect(messages.items.at(-1)?.text).toBe("Old 1");
});

test("Stable session IDs deduplicate delivery while repeated ordinary failures remain separate", () => {
  // Runtime publications may repeat, but two distinct actions can fail with identical text.
  const messages = new Messages();

  messages.add("Session failed", 1, { id: "session-result", level: "error" });
  messages.add("Session failed", 2, { id: "session-result", level: "error" });
  messages.add("Connection failed", 3); messages.add("Connection failed", 4);

  expect(messages.items).toHaveLength(3); expect(messages.items[0]?.id).not.toBe(messages.items[1]?.id);
  expect(messages.items[2]?.timestamp).toBe(1);
});

test("Display sanitization removes terminal controls without losing multiline Unicode text", () => {
  // External messages must not inject terminal commands into read-only UI.
  const original = "\x1b[31m오류\x1b[0m\x07\nDetails\tkept";

  const display = messageText(original);

  expect(display).toBe("오류\nDetails\tkept");
});
