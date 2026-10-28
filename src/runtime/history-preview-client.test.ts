import { expect, spyOn, test } from "bun:test";
import { RuntimeClient } from "./client.ts";
import type { SessionRecord } from "../agents/session-registry.ts";
import { emptyPreferences, protocolVersion, type RuntimeSnapshot } from "./protocol.ts";
import { runtimePaths } from "./storage.ts";
import { expectError, expectOk } from "../testing/results.ts";

const paths = runtimePaths("/fixture/.git", true, "/tmp/radian-history-preview-client");
const snapshot = (preview = true): RuntimeSnapshot => ({
  version: protocolVersion,
  pid: process.pid,
  instance: "first",
  repositoryId: "/fixture/.git",
  mode: "offline",
  repositories: [],
  details: {},
  closingCount: 0,
  preferences: structuredClone(emptyPreferences),
  notice: "",
  capabilities: preview ? ["history", "history-preview"] : ["history"],
});

function stub(
  implementation: (
    input: Parameters<typeof fetch>[0],
    options?: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
) {
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(implementation, { preconnect: fetch.preconnect }),
  );
}

test("Legacy previews report unsupported without lookups, restarts, or model requests", async () => {
  const fetchMock = stub(async () => {
    throw new Error("No requests allowed");
  });
  const client = new RuntimeClient(paths, snapshot(false));
  try {
    const result = expectError(await client.previewHistory("tree", "saved"));
    expect(result.code).toBe("UNSUPPORTED_CAPABILITY");
    expect(result.message).toContain("Search and Open remain available");
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

test("Preview instance-fenced GET rejects identity/format errors as protocol failures", async () => {
  const valid = {
    id: "saved",
    worktreeId: "문서/a b",
    text: "You\nQuestion",
    truncated: false,
    sections: [{ id: "q", kind: "user", title: "You", text: "Question", status: "complete" }],
  };
  let response: unknown = valid;
  const requests: string[] = [];
  const fetchMock = stub(async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(url.pathname);
    expect(url.searchParams.get("worktreeId")).toBe("문서/a b");
    expect(url.searchParams.get("savedId")).toBe("saved");
    expect(new Headers(options?.headers).get("X-Radian-Instance")).toBe("first");
    expect(options?.method ?? "GET").toBe("GET");

    return Response.json(response);
  });
  const client = new RuntimeClient(paths, snapshot());
  try {
    const preview = expectOk(await client.previewHistory("문서/a b", "saved"));
    expect(preview.text).toBe("You\nQuestion");
    expect(preview.sections?.[0]).toMatchObject({ kind: "user", text: "Question" });
    response = {
      id: "different",
      worktreeId: "문서/a b",
      text: "Wrong conversation",
      truncated: false,
    };
    expect(expectError(await client.previewHistory("문서/a b", "saved")).code).toBe(
      "PROTOCOL_ERROR",
    );
    response = { text: "Missing identity" };
    expect(expectError(await client.previewHistory("문서/a b", "saved")).code).toBe(
      "PROTOCOL_ERROR",
    );
    response = { ...valid, sections: [{ ...valid.sections[0], kind: "unsupported" }] };
    expect(expectError(await client.previewHistory("문서/a b", "saved")).code).toBe(
      "PROTOCOL_ERROR",
    );
    response = {
      ...valid,
      sections: Array.from({ length: 16 }, (_, i) => ({ ...valid.sections[0], id: `q${i}` })),
    };
    expect(expectError(await client.previewHistory("문서/a b", "saved")).code).toBe(
      "PROTOCOL_ERROR",
    );
    response = { ...valid, sections: [{ ...valid.sections[0], text: "x".repeat(8193) }] };
    expect(expectError(await client.previewHistory("문서/a b", "saved")).code).toBe(
      "PROTOCOL_ERROR",
    );
    response = { id: "saved", worktreeId: "문서/a b", text: "Legacy preview", truncated: false };
    expect(expectOk(await client.previewHistory("문서/a b", "saved")).sections).toBeUndefined();
    expect(requests).toEqual(Array(7).fill("/history/preview"));
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

test("Fifteen sections and saved status cross IPC while invalid telemetry fails", async () => {
  // Validate new status metadata alongside expanded section counts at runtime boundaries.
  const valid = {
    id: "saved",
    worktreeId: "tree",
    text: "",
    truncated: false,
    sections: Array.from({ length: 15 }, (_, index) => ({
      id: `s${index}`,
      kind: "assistant",
      title: "Agent",
      text: `Answer ${index}`,
      status: "complete",
    })),
    telemetry: {
      provider: "fixture",
      model: "saved-model",
      effort: "high",
      fast: null,
      context: null,
      weekly: null,
    },
  };
  let response: unknown = valid;
  const fetchMock = stub(async () => Response.json(response));
  const client = new RuntimeClient(paths, snapshot());
  try {
    // Read preview responses through actual client schema checks.
    const preview = expectOk(await client.previewHistory("tree", "saved"));

    // Accept maximum counts but never display invalid usage as normal state.
    expect(preview.sections).toHaveLength(15);
    expect(preview.telemetry).toEqual(valid.telemetry);
    response = {
      ...valid,
      telemetry: { ...valid.telemetry, context: { usedTokens: -1, maxTokens: 1000 } },
    };
    expect(expectError(await client.previewHistory("tree", "saved")).code).toBe("PROTOCOL_ERROR");
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

test("Shared snapshots match requested conversations/worktrees and obey recent-section limits", async () => {
  // Correct outer IDs cannot permit mismatched inner session snapshots.
  const saved: SessionRecord = {
    id: "old-tab",
    name: "Archived",
    worktreeId: "tree",
    lifecycle: "closed",
    updatedAt: 1700000000000,
    state: {
      conversationId: "saved",
      status: "failure",
      output: "",
      error: "Saved failure",
      sections: [
        { id: "a", kind: "assistant", title: "Agent", text: "Saved answer", status: "complete" },
      ],
    },
    subagents: [],
  };
  let returned: unknown = saved;
  const fetchMock = stub(async () =>
    Response.json({
      id: "saved",
      worktreeId: "tree",
      text: "",
      truncated: false,
      snapshot: returned,
    }),
  );
  const client = new RuntimeClient(paths, snapshot());
  try {
    // The same saved record retains state across wire boundaries.
    expect(expectOk(await client.previewHistory("tree", "saved")).snapshot).toEqual(saved);

    // Wrong identity, dates, and oversized content return explicit protocol errors.
    for (const invalid of [
      { ...saved, worktreeId: "other" },
      { ...saved, state: { ...saved.state, conversationId: "other" } },
      { ...saved, updatedAt: 8640000000000001 },
      {
        ...saved,
        state: {
          ...saved.state,
          sections: Array.from({ length: 16 }, (_, index) => ({
            ...saved.state.sections![0],
            id: `s${index}`,
          })),
        },
      },
    ]) {
      returned = invalid;
      expect(expectError(await client.previewHistory("tree", "saved")).code).toBe("PROTOCOL_ERROR");
    }
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

test("Structured commands/timeouts survive preview IPC while invalid types/limits fail", async () => {
  // New display metadata remains optional without changing existing fields.
  const section = {
    id: "tool",
    kind: "tool",
    title: "bash",
    text: "Arguments:\n{}\n\nResult:\nDone",
    status: "complete",
    command: "printf done",
    timeoutSeconds: 120,
  };
  let returned: unknown = section;
  const fetchMock = stub(async () =>
    Response.json({
      id: "saved",
      worktreeId: "tree",
      text: "",
      truncated: false,
      sections: [returned],
    }),
  );
  const client = new RuntimeClient(paths, snapshot());
  try {
    const preview = expectOk(await client.previewHistory("tree", "saved"));
    expect(preview.sections?.[0]).toMatchObject({ command: "printf done", timeoutSeconds: 120 });
    // Never silently display responses lacking valid units or bounded command previews.
    for (const invalid of [
      { timeoutSeconds: 0 },
      { timeoutSeconds: -1 },
      { timeoutSeconds: "120" },
      { command: "x".repeat(4097) },
    ]) {
      returned = { ...section, ...invalid };
      expect(expectError(await client.previewHistory("tree", "saved")).code).toBe("PROTOCOL_ERROR");
    }

    const { command: _command, timeoutSeconds: _timeout, ...legacy } = section;
    returned = legacy;
    expect(
      expectOk(await client.previewHistory("tree", "saved")).sections?.[0]?.command,
    ).toBeUndefined();
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

test("Completion metadata survives preview IPC while incomplete/invalid times fail", async () => {
  const completion = {
    startedAt: 1000000,
    completedAt: 1090000,
    durationMs: 90000,
    outcome: "complete" as const,
  };
  let returned: unknown = completion;
  const fetchMock = stub(async () =>
    Response.json({
      id: "saved",
      worktreeId: "tree",
      text: "",
      truncated: false,
      sections: [
        {
          id: "a",
          kind: "assistant",
          title: "Agent",
          text: "Answer",
          status: "complete",
          completion: returned,
        },
      ],
    }),
  );
  const client = new RuntimeClient(paths, snapshot());
  try {
    expect(
      expectOk(await client.previewHistory("tree", "saved")).sections?.[0]?.completion,
    ).toEqual(completion);
    for (const invalid of [
      { durationMs: -1 },
      { completedAt: 8640000000000001 },
      { outcome: "working" },
      { warning: "x".repeat(513) },
    ]) {
      returned = { ...completion, ...invalid };
      expect(expectError(await client.previewHistory("tree", "saved")).code).toBe("PROTOCOL_ERROR");
    }
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

test("Closed-popup list requests return CANCELLED and reject other worktree lists", async () => {
  let pending = true;
  const fetchMock = stub(async (_input, options) =>
    pending
      ? new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        })
      : Response.json([
          {
            id: "saved",
            worktreeId: "other",
            title: "Wrong scope",
            modified: "2026-10-14",
            messageCount: 1,
            openSessionId: null,
            unavailableReason: null,
          },
        ]),
  );
  const client = new RuntimeClient(paths, snapshot());
  const controller = new AbortController();
  try {
    const read = client.listHistory("tree", controller.signal);
    controller.abort();
    expect(expectError(await read).code).toBe("CANCELLED");
    pending = false;
    expect(expectError(await client.listHistory("tree")).code).toBe("PROTOCOL_ERROR");
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

test("Cancelled previews return CANCELLED rather than exceptions or empty success", async () => {
  const fetchMock = stub(
    async (_input, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      }),
  );
  const client = new RuntimeClient(paths, snapshot());
  const controller = new AbortController();
  try {
    const pending = client.previewHistory("tree", "saved", controller.signal);
    controller.abort();
    expect(expectError(await pending).code).toBe("CANCELLED");

    const count = fetchMock.mock.calls.length;
    expect(expectError(await client.previewHistory("tree", "saved", controller.signal)).code).toBe(
      "CANCELLED",
    );
    expect(fetchMock).toHaveBeenCalledTimes(count);
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});
