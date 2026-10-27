import { expect, test } from "bun:test";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { SessionTranscript } from "./transcript.ts";
import { runCompletionEntryType, type RunClock } from "./run-completion.ts";
import { fixtureMessage } from "../testing/offline-runtime.ts";

type Message = AgentSession["messages"][number];
const message = (transcript: SessionTranscript, value: Message) => {
  transcript.handle({ type: "message_start", message: value });
  transcript.handle({ type: "message_end", message: value });
};
function fixture() {
  let wall = 1000000,
    mono = 100;
  const clock: RunClock = { wallTime: () => wall, monotonicTime: () => mono };
  const transcript = new SessionTranscript([], clock);
  const assistant = fixtureMessage("openai-responses", "fixture", "fixture");
  assistant.content = [{ type: "text", text: "Final answer" }];
  return {
    transcript,
    assistant,
    advance(ms: number) {
      wall += ms;
      mono += ms;
    },
    jumpWall(ms: number) {
      wall += ms;
    },
  };
}

test("Response and tool completion do not create final metadata until settlement fixes total duration once", () => {
  // Individual tool results and model responses do not complete the whole request.
  const app = fixture(),
    t = app.transcript;
  t.handle({ type: "agent_start" });
  message(t, { role: "user", content: "Do work", timestamp: 1 });
  app.advance(30000);
  message(t, app.assistant);
  t.handle({ type: "agent_end", messages: [], willRetry: false });
  expect(t.sections.some((section) => section.completion)).toBe(false);
  // Fix the full 90 seconds, including retries, only at the final event.
  app.advance(60000);
  const completion = t.handle({ type: "agent_settled", aborted: false });
  expect(completion).toMatchObject({
    startedAt: 1000000,
    completedAt: 1090000,
    durationMs: 90000,
    outcome: "complete",
  });
  expect(t.sections.at(-1)?.completion).toEqual(completion);
  app.advance(5000);
  expect(t.handle({ type: "agent_settled", aborted: false })).toBeUndefined();
  expect(t.sections.at(-1)?.completion?.durationMs).toBe(90000);
});

test("Retries and subsequent agent_start events preserve the initial start time and suppress intermediate completion", () => {
  const app = fixture(),
    t = app.transcript;
  t.handle({ type: "agent_start" });
  message(t, { role: "user", content: "Retry", timestamp: 1 });
  message(t, { ...app.assistant, stopReason: "error", errorMessage: "Retryable failure" });
  app.advance(30000);
  t.handle({ type: "agent_start" });
  expect(t.sections.some((section) => section.completion)).toBe(false);
  message(t, app.assistant);
  app.advance(60000);
  t.handle({ type: "agent_settled", aborted: false });
  expect(t.sections.filter((section) => section.completion)).toHaveLength(1);
  expect(t.sections.at(-1)?.completion).toMatchObject({ durationMs: 90000, outcome: "complete" });
});

test.each(["error", "cancelled", "unfinished"] as const)(
  "Failure, cancellation, and unsettled termination never become normal completion: %s",
  (outcome) => {
    const app = fixture(),
      t = app.transcript;
    t.handle({ type: "agent_start" });
    message(t, { role: "user", content: "Do work", timestamp: 1 });
    message(t, {
      ...app.assistant,
      stopReason: outcome === "error" ? "error" : outcome === "cancelled" ? "aborted" : "toolUse",
    });
    app.advance(1200);
    t.handle({ type: "agent_settled", aborted: outcome === "cancelled" });
    expect(t.sections.at(-1)?.completion?.outcome).toBe(outcome);
  },
);

test("Elapsed time uses a monotonic clock and excludes later request waits and session age", () => {
  const app = fixture(),
    t = app.transcript;
  t.handle({ type: "agent_start" });
  message(t, app.assistant);
  app.advance(90000);
  app.jumpWall(-60000);
  t.handle({ type: "agent_settled", aborted: false });
  expect(t.sections.at(-1)?.completion?.durationMs).toBe(90000);
  app.advance(120000);
  t.handle({ type: "agent_start" });
  message(t, app.assistant);
  app.advance(1000);
  t.handle({ type: "agent_settled", aborted: false });
  expect(
    t.sections
      .filter((section) => section.completion)
      .map((section) => section.completion?.durationMs),
  ).toEqual([90000, 1000]);
});

test("Commands and legacy history without runs never acquire inferred completion times or current dates", () => {
  const app = fixture();
  message(app.transcript, app.assistant);
  app.transcript.handle({ type: "agent_settled", aborted: false });
  expect(app.transcript.sections.at(-1)?.completion).toBeUndefined();
  const manager = SessionManager.inMemory("/fixture");
  manager.appendMessage(app.assistant);
  expect(new SessionTranscript(manager.getBranch()).sections.at(-1)?.completion).toBeUndefined();
});

test("Versioned SDK metadata restores answer completion without changing source text or model conversation", () => {
  const manager = SessionManager.inMemory("/fixture"),
    app = fixture();
  manager.appendMessage({ role: "user", content: "First", timestamp: 1 });
  manager.appendMessage(app.assistant);
  const completion = {
    startedAt: 1000000,
    completedAt: 1090000,
    durationMs: 90000,
    outcome: "complete" as const,
  };
  manager.appendCustomEntry(runCompletionEntryType, completion);
  manager.appendMessage({ role: "user", content: "Next question", timestamp: 2 });
  const sections = new SessionTranscript(manager.getBranch()).sections;
  expect(sections.map((section) => section.text)).toEqual([
    "First",
    "Final answer",
    "Next question",
  ]);
  expect(sections[1]?.completion).toEqual(completion);
  expect(sections[2]?.completion).toBeUndefined();
});

test("Invalid internal metadata reports corruption without fabricating completion", () => {
  const manager = SessionManager.inMemory("/fixture"),
    app = fixture();
  manager.appendMessage(app.assistant);
  manager.appendCustomEntry(runCompletionEntryType, { durationMs: -1 });
  const sections = new SessionTranscript(manager.getBranch()).sections;
  expect(sections.some((section) => section.completion)).toBe(false);
  expect(sections.at(-1)?.text).toContain("HISTORY_CORRUPT");
});
