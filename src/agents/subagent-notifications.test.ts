import { expect, test } from "bun:test";
import { SubagentNotifications, subagentNotificationText } from "./subagent-notifications.ts";

test("The inbox revalidates observations at consumption and never replays handled events", () => {
  // A report can be observed by a status query while the parent is still working.
  const inbox = new SubagentNotifications();
  let current = true;
  inbox.add(
    {
      id: "run",
      agent: "reviewer",
      type: "progress",
      message: "Important discovery",
      createdAt: 1,
    },
    () => current,
  );

  // The status result supersedes this queued notification before the idle boundary.
  current = false;
  const first = inbox.take();
  const second = inbox.take();

  expect(first).toEqual([]);
  expect(second).toEqual([]);
});

test("Completion supersedes queued progress and questions for the same run", () => {
  // A short child can complete before the busy parent consumes any reports.
  const inbox = new SubagentNotifications();
  inbox.add(
    { id: "run", agent: "reviewer", type: "progress", message: "Earlier report", createdAt: 1 },
    () => true,
  );
  inbox.add(
    {
      id: "run",
      agent: "reviewer",
      type: "question",
      question: { id: "question", message: "Earlier decision", createdAt: 2 },
    },
    () => true,
  );

  // One terminal event replaces obsolete updates rather than producing three model turns.
  inbox.add(
    { id: "run", agent: "reviewer", type: "finished", status: "complete", output: "Final answer" },
    () => true,
  );
  const events = inbox.take();

  expect(events).toEqual([
    { id: "run", agent: "reviewer", type: "finished", status: "complete", output: "Final answer" },
  ]);
  expect(inbox.take()).toEqual([]);
  expect(subagentNotificationText(events)).toContain("not a new user request");
  expect(subagentNotificationText(events)).not.toContain('"type":');
});

test("Answering one question cannot discard a different pending question", () => {
  // Questions have independent identities, even when one agent asks more than once.
  const inbox = new SubagentNotifications();
  let latestPending = true;
  inbox.add(
    {
      id: "run",
      agent: "reviewer",
      type: "question",
      question: { id: "first", message: "First decision", createdAt: 1 },
    },
    () => true,
  );
  inbox.add(
    {
      id: "run",
      agent: "reviewer",
      type: "question",
      question: { id: "second", message: "Second decision", createdAt: 2 },
    },
    () => latestPending,
  );

  latestPending = false;
  const events = inbox.take();

  expect(events).toEqual([
    expect.objectContaining({ question: expect.objectContaining({ id: "first" }) }),
  ]);
});

test("New progress replaces old progress and teardown drops the remaining inbox", () => {
  // Repeated reports from a run must not become an unbounded follow-up queue.
  const inbox = new SubagentNotifications();
  for (let index = 0; index < 100; index++)
    inbox.add(
      {
        id: "run",
        agent: "reviewer",
        type: "progress",
        message: `Report ${index}`,
        createdAt: index,
      },
      () => true,
    );

  const events = inbox.take();
  inbox.add({ id: "run", agent: "reviewer", type: "finished", status: "stopped" }, () => true);
  inbox.clear();

  expect(events).toEqual([expect.objectContaining({ message: "Report 99" })]);
  expect(inbox.size).toBe(0);
});
