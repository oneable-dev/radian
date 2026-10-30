import { expect, test } from "bun:test";
import { SubagentChannel } from "./subagent-channel.ts";
import { expectError, expectOk } from "../testing/results.ts";

test("Questions accept only a correlated answer once and progress remains nonblocking", async () => {
  // Progress and questions are separate protocols on one owner-scoped channel.
  const events: unknown[] = [];
  const channel = new SubagentChannel((event) => events.push(event));

  expectOk(await channel.contact({ action: "progress", message: "A relevant discovery" }));
  const question = channel.contact({ action: "ask", message: "May I proceed?" });
  const id = channel.questions[0]!.id;
  const wrong = channel.reply("other-id", "Wrong answer");
  expectOk(channel.reply(id, "Proceed within scope"));

  expect(expectError(wrong).code).toBe("INVALID_INPUT");
  expect(expectOk(await question)).toEqual({ questionId: id, message: "Proceed within scope" });
  expect(expectError(channel.reply(id, "Again")).code).toBe("INVALID_INPUT");
  expect(channel.questions).toEqual([]);
  expect(events).toContainEqual(expect.objectContaining({ type: "progress" }));
});

test.each(["abort", "close"])(
  "%s releases pending questions without inventing an answer",
  async (reason) => {
    // Shutdown must release the tool await even when no supervisor can reply.
    const channel = new SubagentChannel(() => {});
    const controller = new AbortController();
    const question = channel.contact(
      { action: "ask", message: "Decision needed" },
      controller.signal,
    );

    if (reason === "abort") controller.abort();
    else channel.close();

    expect(expectError(await question).code).toBe("CANCELLED");
    expect(channel.questions).toEqual([]);
  },
);

test("Progress history is bounded and a closed channel rejects later requests", async () => {
  // Long-running agents cannot accumulate unlimited model context through reports.
  const channel = new SubagentChannel(() => {});
  for (let index = 0; index < 20; index++)
    expectOk(await channel.contact({ action: "progress", message: `Step ${index}` }));

  channel.close();
  const late = await channel.contact({ action: "progress", message: "Too late" });

  expect(channel.progress).toHaveLength(16);
  expect(channel.progress[0]?.message).toBe("Step 4");
  expect(expectError(late).code).toBe("CANCELLED");
});
