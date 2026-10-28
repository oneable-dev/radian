import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  readHistoryPreview,
  previewSessionSnapshot,
  historyPreviewLimit,
  historyPreviewSectionLimit,
} from "./history-preview.ts";
import { runCompletionEntryType } from "./run-completion.ts";
import { expectError, expectOk } from "../testing/results.ts";

const header = {
  type: "session",
  version: 3,
  id: "saved",
  cwd: "/fixture",
  timestamp: "2026-10-14T00:00:00Z",
};
const message = (id: string, parentId: string | null, role: string, content: unknown) => ({
  type: "message",
  id,
  parentId,
  timestamp: header.timestamp,
  message: { role, content },
});

async function fixture(records: unknown[]) {
  const directory = await mkdtemp(join(tmpdir(), "radian-history-preview-"));
  const path = join(directory, "session.jsonl");

  await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");

  return {
    path,
    async close() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("Previews read only the current branch's latest SDK sections without changing writers or files", async () => {
  // The previous branch and tool/thinking payload must not be mistaken for the chosen conversation.
  const app = await fixture([
    header,
    message("q", null, "user", "Original question"),
    message("old", "q", "assistant", [{ type: "text", text: "ABANDONED BRANCH" }]),
    message("new", "q", "user", [
      { type: "text", text: "Current branch" },
      { type: "image", data: "not rendered" },
    ]),
    message("answer", "new", "assistant", [
      { type: "thinking", thinking: "PRIVATE THINKING" },
      { type: "text", text: "Current answer" },
    ]),
    {
      ...message("tool", "answer", "toolResult", []),
      message: {
        role: "toolResult",
        toolCallId: "call",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "TOOL OUTPUT" }],
      },
    },
  ]);
  const opened = spyOn(SessionManager, "open");
  try {
    const before = await readFile(app.path, "utf8");
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));

    expect(preview.sections?.map((section) => section.kind)).toEqual([
      "user",
      "user",
      "notice",
      "thinking",
      "assistant",
      "tool",
    ]);
    expect(preview.text).toContain("Current answer");
    expect(preview.text).toContain("Original question");
    expect(preview.text).not.toContain("ABANDONED BRANCH");
    expect(preview.worktreeId).toBe("tree");
    expect(preview.id).toBe("saved");
    expect(preview.truncated).toBe(false);
    expect(opened).not.toHaveBeenCalled();
    expect(await readFile(app.path, "utf8")).toBe(before);
  } finally {
    opened.mockRestore();
    await app.close();
  }
});

test("Return only the latest 15 sections using Agent tool, error, and redaction presentation", async () => {
  // Several earlier turns and intermediate blocks must not displace the latest question/answer.
  const entries: unknown[] = [
    header,
    message("old-q", null, "user", "OLD QUESTION"),
    message("old-a", "old-q", "assistant", [{ type: "text", text: "OLD ANSWER" }]),
    message("q", "old-a", "user", "Latest request"),
  ];
  let parent = "q";
  for (let i = 1; i <= 14; i++) {
    entries.push(message(`a${i}`, parent, "assistant", [{ type: "text", text: `Step ${i}` }]));
    parent = `a${i}`;
  }

  entries.push(
    message("work", parent, "assistant", [
      {
        type: "thinking",
        thinking: "HIDDEN THOUGHT",
        redacted: true,
        thinkingSignature: "SECRET SIGNATURE",
      },
      { type: "toolCall", id: "call", name: "read", arguments: { path: "fixture.ts" } },
    ]),
  );
  entries.push({
    ...message("result", "work", "toolResult", []),
    message: {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      isError: true,
      content: [{ type: "text", text: "Read failed" }],
    },
  });
  entries.push(message("final", "result", "assistant", [{ type: "text", text: "Latest answer" }]));

  const app = await fixture(entries);
  try {
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(preview.sections).toHaveLength(15);
    expect(preview.sections?.map((section) => section.text.split("\n")[0])).toEqual([
      ...Array.from({ length: 12 }, (_, index) => `Step ${index + 3}`),
      "[Thinking redacted]",
      "Arguments:",
      "Latest answer",
    ]);
    expect(preview.sections?.at(-2)).toMatchObject({
      kind: "tool",
      title: "read",
      status: "error",
      error: "Read failed",
    });
    expect(preview.sections?.at(-2)?.text).toContain("Read failed");
    expect(preview.truncated).toBe(false);
    expect(JSON.stringify(preview)).not.toMatch(
      /OLD QUESTION|OLD ANSWER|HIDDEN THOUGHT|SECRET SIGNATURE/,
    );
  } finally {
    await app.close();
  }
});

test("The latest 15 sections span earlier turns and restore only saved model and effort", async () => {
  // Prepare multiple turns whose final request has fewer than 15 sections.
  const entries: unknown[] = [header];
  let parent: string | null = null;
  for (let turn = 1; turn <= 9; turn++) {
    entries.push(message(`q${turn}`, parent, "user", `Question ${turn}`));
    parent = `q${turn}`;
    if (turn === 9) {
      entries.push({
        type: "thinking_level_change",
        id: "effort",
        parentId: parent,
        timestamp: header.timestamp,
        thinkingLevel: "high",
      });
      parent = "effort";
    }

    entries.push({
      ...message(`a${turn}`, parent, "assistant", [{ type: "text", text: `Answer ${turn}` }]),
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Answer ${turn}` }],
        provider: "fixture",
        model: "saved-model",
      },
    });
    parent = `a${turn}`;
  }

  const app = await fixture(entries);
  try {
    const before = await readFile(app.path, "utf8");

    // Read the bounded conversation tail without stopping at the latest request.
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));

    // Start at the second answer; never infer current account usage or Fast settings.
    expect(preview.sections).toHaveLength(15);
    expect(preview.sections?.[0]?.text).toBe("Answer 2");
    expect(preview.sections?.at(-1)?.text).toBe("Answer 9");
    expect(preview.sections?.slice(1, 5).map((section) => section.text)).toEqual([
      "Question 3",
      "Answer 3",
      "Question 4",
      "Answer 4",
    ]);
    expect(preview.telemetry).toEqual({
      provider: "fixture",
      model: "saved-model",
      effort: "high",
      fast: null,
      context: null,
      weekly: null,
    });
    expect(await readFile(app.path, "utf8")).toBe(before);
  } finally {
    await app.close();
  }
});

test("Shared snapshot preview limits never modify saved conversations, run state, or telemetry", () => {
  // Shared records also support recovery; preview truncation must not alter persisted bodies.
  const snapshot = {
    id: "tab",
    name: "Archived",
    worktreeId: "tree",
    lifecycle: "closed" as const,
    updatedAt: 1000,
    state: {
      conversationId: "saved",
      status: "failure" as const,
      error: "Saved failure",
      output: "Saved output",
      sections: Array.from({ length: 20 }, (_, index) => ({
        id: `s${index}`,
        kind: "assistant" as const,
        title: "Agent",
        text: `Answer ${index} ` + "x".repeat(9000),
        status: "complete" as const,
      })),
      telemetry: {
        provider: "fixture",
        model: "model",
        effort: "high",
        fast: true,
        context: { usedTokens: 100, maxTokens: 1000 },
        weekly: null,
      },
    },
    subagents: [],
  };
  const before = JSON.stringify(snapshot);

  // Build only a read-only IPC projection from the same record.
  const preview = previewSessionSnapshot(snapshot, "saved");

  // Show the latest 15 sections without touching recovery data or status metadata.
  expect(preview.snapshot?.state.sections).toHaveLength(15);
  expect(preview.snapshot?.state.sections?.[0]?.id).toBe("s5");
  expect(preview.snapshot?.state.sections?.[0]?.text).toHaveLength(historyPreviewSectionLimit);
  expect(preview.truncated).toBe(true);
  expect(preview.snapshot?.state.status).toBe("failure");
  expect(preview.snapshot?.state.error).toBe("Saved failure");
  expect(preview.telemetry).toEqual(snapshot.state.telemetry);
  expect(JSON.stringify(snapshot)).toBe(before);
});

test("Saved previews preserve Bash commands and timeouts without applying summary truncation", async () => {
  // Preserve structured commands independently of the 512-character summary limit.
  const command = "printf '한글'\n" + "printf done; ".repeat(60);
  const app = await fixture([
    header,
    message("q", null, "user", "Show command"),
    message("call", "q", "assistant", [
      { type: "toolCall", id: "shell", name: "bash", arguments: { command, timeout: 120 } },
    ]),
  ]);
  try {
    const before = await readFile(app.path, "utf8");
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));

    // Restoring commands and timeouts must not open writers or modify history.
    expect(preview.sections?.at(-1)).toMatchObject({ kind: "tool", command, timeoutSeconds: 120 });
    expect(await readFile(app.path, "utf8")).toBe(before);
  } finally {
    await app.close();
  }
});

test("Recent completion metadata is retained but never attached to new unanswered requests", async () => {
  const completion = {
    startedAt: 1000000,
    completedAt: 1090000,
    durationMs: 90000,
    outcome: "complete" as const,
  };
  const app = await fixture([
    header,
    message("q", null, "user", "Question"),
    message("a", "q", "assistant", [{ type: "text", text: "Answer" }]),
    {
      type: "custom",
      id: "completed",
      parentId: "a",
      timestamp: header.timestamp,
      customType: runCompletionEntryType,
      data: completion,
    },
  ]);
  try {
    const before = await readFile(app.path, "utf8");
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));

    expect(preview.sections).toHaveLength(2);
    expect(preview.sections?.at(-1)?.completion).toEqual(completion);
    expect(await readFile(app.path, "utf8")).toBe(before);
    await writeFile(
      app.path,
      before + JSON.stringify(message("next", "completed", "user", "Unanswered")) + "\n",
    );

    const next = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(next.sections?.map((section) => section.text)).toEqual([
      "Question",
      "Answer",
      "Unanswered",
    ]);
    expect(next.sections?.[1]?.completion).toEqual(completion);
    expect(next.sections?.at(-1)?.completion).toBeUndefined();
  } finally {
    await app.close();
  }
});

test("Corrupt completion metadata on the selected branch returns a failure Result", async () => {
  const app = await fixture([
    header,
    message("q", null, "user", "Question"),
    {
      type: "custom",
      id: "bad",
      parentId: "q",
      timestamp: header.timestamp,
      customType: runCompletionEntryType,
      data: { durationMs: -1 },
    },
  ]);
  try {
    expect(expectError(await readHistoryPreview(app.path, "tree", "saved")).code).toBe(
      "HISTORY_CORRUPT",
    );
  } finally {
    await app.close();
  }
});

test("Recent skill requests appear without exposing skill instructions", async () => {
  const skill =
    '<skill name="good-code" location="/private/SKILL.md">\nHIDDEN INSTRUCTIONS\n</skill>\n\nLatest skill request';
  const app = await fixture([
    header,
    message("q", null, "user", "OLD PROMPT"),
    message("a", "q", "assistant", [{ type: "text", text: "OLD ANSWER" }]),
    message("new", "a", "user", skill),
  ]);
  try {
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(preview.sections).toHaveLength(4);
    expect(preview.sections?.[2]).toMatchObject({
      kind: "notice",
      skillName: "good-code",
      text: "good-code",
    });
    expect(preview.sections?.[3]).toMatchObject({ kind: "user", text: "Latest skill request" });
    expect(JSON.stringify(preview)).not.toMatch(/HIDDEN INSTRUCTIONS|\/private/);
  } finally {
    await app.close();
  }
});

test("Legacy SDK records convert only in memory and preserve original bytes", async () => {
  const app = await fixture([
    { ...header, version: 1 },
    { type: "message", message: { role: "user", content: "Legacy question" } },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Legacy answer" }] },
    },
  ]);
  try {
    const before = await readFile(app.path, "utf8");
    expect(expectOk(await readHistoryPreview(app.path, "tree", "saved")).text).toContain(
      "Legacy answer",
    );
    expect(await readFile(app.path, "utf8")).toBe(before);
  } finally {
    await app.close();
  }
});

test("Version 2 hook messages convert in memory into recent sections", async () => {
  const app = await fixture([
    { ...header, version: 2 },
    message("q", null, "user", "Legacy question"),
    {
      ...message("hook", "q", "hookMessage", "Legacy visible note"),
      message: {
        role: "hookMessage",
        customType: "Legacy extension",
        content: "Legacy visible note",
        display: true,
      },
    },
  ]);
  try {
    const before = await readFile(app.path, "utf8");
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));

    expect(preview.sections?.at(-1)).toMatchObject({
      kind: "notice",
      title: "Legacy extension",
      text: "Legacy visible note",
    });
    expect(await readFile(app.path, "utf8")).toBe(before);
  } finally {
    await app.close();
  }
});

test.each([
  [header, null],
  [header, message("a", "missing", "user", "broken")],
  [header, message("a", "a", "user", "cycle")],
  [header, message("a", null, "user", [{ type: "text", text: 1 }])],
  [{ ...header, id: "different" }],
])(
  "Corrupt messages, branches, and identities never become partial success: %j",
  async (...records) => {
    const app = await fixture(records);
    try {
      expect(expectError(await readHistoryPreview(app.path, "tree", "saved")).code).toBe(
        "HISTORY_CORRUPT",
      );
    } finally {
      await app.close();
    }
  },
);

test("Malformed JSON and empty files return expected history errors", async () => {
  const app = await fixture([header]);
  try {
    await writeFile(app.path, JSON.stringify(header) + "\ninvalid JSON");
    expect(expectError(await readHistoryPreview(app.path, "tree", "saved")).code).toBe(
      "HISTORY_CORRUPT",
    );
    await writeFile(app.path, "");
    expect(expectError(await readHistoryPreview(app.path, "tree", "saved")).code).toBe(
      "HISTORY_CORRUPT",
    );
  } finally {
    await app.close();
  }
});

test("Oversized legacy histories return completed recent turns with truncation indicators", async () => {
  // A large old turn must not block the small recent turn or be loaded into the preview model.
  const app = await fixture([
    header,
    message("old", null, "user", "OLD PAYLOAD " + "x".repeat(20 * 1024 * 1024)),
    message("current-q", "old", "user", "CURRENT QUESTION"),
    message("current-a", "current-q", "assistant", [
      { type: "thinking", thinking: "Current plan" },
      { type: "text", text: "CURRENT ANSWER" },
    ]),
  ]);
  try {
    const before = await readFile(app.path, "utf8");
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));

    expect(preview.sections?.map((section) => section.text)).toEqual([
      "CURRENT QUESTION",
      "Current plan",
      "CURRENT ANSWER",
    ]);
    expect(JSON.stringify(preview)).not.toContain("OLD PAYLOAD");
    expect(preview.truncated).toBe(true);
    expect(await readFile(app.path, "utf8")).toBe(before);
  } finally {
    await app.close();
  }
});

test("Tool results exceeding 4 MiB truncate only sections and retain call arguments", async () => {
  // The total-file fix must also handle a large relevant record rather than just old payloads.
  const app = await fixture([
    header,
    message("q", null, "user", "Read the file"),
    message("call", "q", "assistant", [
      { type: "toolCall", id: "read-call", name: "read", arguments: { path: "fixture.ts" } },
    ]),
    {
      ...message("result", "call", "toolResult", []),
      message: {
        role: "toolResult",
        toolCallId: "read-call",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "LATEST RESULT " + "x".repeat(5 * 1024 * 1024) }],
      },
    },
    message("answer", "result", "assistant", [{ type: "text", text: "Latest answer" }]),
  ]);
  try {
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(preview.sections?.map((section) => section.kind)).toEqual(["user", "tool", "assistant"]);
    expect(preview.sections?.[1]?.text).toContain('"path": "fixture.ts"');
    expect(preview.sections?.[1]?.text).toContain("LATEST RESULT");
    expect(preview.sections?.[1]?.text.length).toBe(historyPreviewSectionLimit);
    expect(preview.truncated).toBe(true);
  } finally {
    await app.close();
  }
});

test("Skip physically later branches and show only the latest branch", async () => {
  const app = await fixture([
    header,
    message("root", null, "user", "Root"),
    message("q", "root", "user", "Current question"),
    message("other", "root", "assistant", [
      { type: "text", text: "OTHER BRANCH " + "x".repeat(20 * 1024 * 1024) },
    ]),
    message("answer", "q", "assistant", [{ type: "text", text: "Current answer" }]),
  ]);
  try {
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(preview.sections?.map((section) => section.text)).toEqual([
      "Root",
      "Current question",
      "Current answer",
    ]);
    expect(JSON.stringify(preview)).not.toContain("OTHER BRANCH");
  } finally {
    await app.close();
  }
});

test("Orphan recent tool results do not force reading large earlier turns", async () => {
  const app = await fixture([
    header,
    message("old", null, "user", "x".repeat(20 * 1024 * 1024)),
    message("q", "old", "user", "Current question"),
    {
      ...message("result", "q", "toolResult", []),
      message: {
        role: "toolResult",
        toolCallId: "external-call",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "Orphan result" }],
      },
    },
    message("answer", "result", "assistant", [{ type: "text", text: "Current answer" }]),
  ]);
  try {
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(preview.sections?.map((section) => section.kind)).toEqual(["user", "tool", "assistant"]);
    expect(preview.sections?.[1]?.text).toContain("Orphan result");
  } finally {
    await app.close();
  }
});

test("Out-of-order tool results find their calls and preserve Agent section order", async () => {
  const entries: unknown[] = [
    header,
    message("q", null, "user", "Question"),
    message(
      "calls",
      "q",
      "assistant",
      ["a", "b", "c"].map((id) => ({
        type: "toolCall",
        id,
        name: "read",
        arguments: { path: id },
      })),
    ),
  ];
  let parent = "calls";
  for (const id of ["c", "b", "a"]) {
    entries.push({
      ...message(`result-${id}`, parent, "toolResult", []),
      message: {
        role: "toolResult",
        toolCallId: id,
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: `RESULT ${id}` }],
      },
    });
    parent = `result-${id}`;
  }

  const app = await fixture(entries);
  try {
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(preview.sections?.map((section) => section.toolCallId)).toEqual([
      undefined,
      "a",
      "b",
      "c",
    ]);
    expect(preview.sections?.[1]?.text).toContain('"path": "a"');
    expect(preview.sections?.[1]?.text).toContain("RESULT a");
  } finally {
    await app.close();
  }
});

test("CRLF and missing final LF preserve Unicode while active cancellation returns CANCELLED", async () => {
  const app = await fixture([
    header,
    message("q", null, "user", "한글 😀\nsecond line"),
    message("answer", "q", "assistant", [{ type: "text", text: "답변 👨‍👩‍👧‍👦" }]),
  ]);
  try {
    await writeFile(app.path, (await readFile(app.path, "utf8")).replace(/\n/g, "\r\n").trimEnd());

    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(preview.sections?.map((section) => section.text)).toEqual([
      "한글 😀\nsecond line",
      "답변 👨‍👩‍👧‍👦",
    ]);

    const abort = new AbortController();
    const pending = readHistoryPreview(app.path, "tree", "saved", abort.signal);

    abort.abort();
    expect(expectError(await pending).code).toBe("CANCELLED");
  } finally {
    await app.close();
  }
});

test("Returned sections report size limits, truncation, and cancellation explicitly", async () => {
  const app = await fixture([
    header,
    message("q", null, "user", "x".repeat(historyPreviewLimit + 20)),
  ]);
  try {
    const preview = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(preview.sections?.[0]?.text.length).toBe(historyPreviewSectionLimit);
    expect(preview.text.length).toBeLessThanOrEqual(historyPreviewLimit);
    expect(preview.truncated).toBe(true);
    await writeFile(
      app.path,
      [header, message("q", null, "user", "x".repeat(historyPreviewSectionLimit - 1) + "😀tail")]
        .map((value) => JSON.stringify(value))
        .join("\n"),
    );

    const unicode = expectOk(await readHistoryPreview(app.path, "tree", "saved"));
    expect(unicode.sections?.[0]?.text.length).toBe(historyPreviewSectionLimit - 1);
    expect(unicode.sections?.[0]?.text.endsWith("x")).toBe(true);
    expect(unicode.truncated).toBe(true);
    await writeFile(app.path, Buffer.alloc(4 * 1024 * 1024 + 1, 32));
    expect(expectError(await readHistoryPreview(app.path, "tree", "saved")).code).toBe(
      "HISTORY_CORRUPT",
    );

    const abort = new AbortController();
    abort.abort();
    expect(
      expectError(await readHistoryPreview(app.path, "tree", "saved", abort.signal)).code,
    ).toBe("CANCELLED");
  } finally {
    await app.close();
  }
});
