import { expect, jest, spyOn, test } from "bun:test";
import { RuntimeClient } from "./client.ts";
import {
  emptyPreferences,
  maxFrameBytes,
  protocolVersion,
  type RuntimeSnapshot,
  type PtyFrame,
} from "./protocol.ts";
import { runtimePaths } from "./storage.ts";
import { expectError, expectOk } from "../testing/results.ts";

const paths = runtimePaths("/fixture/.git", true, "/tmp/radian-reconnect-unit-test");
const snapshot = (): RuntimeSnapshot => ({
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
  capabilities: ["history"],
});
const encoder = new TextEncoder();

type RuntimeRequestOptions = Omit<NonNullable<Parameters<typeof fetch>[1]>, "body"> & {
  body?: string | null;
};

function stubFetch(
  implementation: (input: string | URL, options?: RuntimeRequestOptions) => Promise<Response>,
) {
  // The runtime wire protocol uses explicit URLs and serialized JSON, not Request or streaming bodies.
  const request = (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    if (input instanceof Request) {
      throw new TypeError("Expected an explicit runtime request URL.");
    }
    if (!options) {
      return implementation(input);
    }

    const { body, ...init } = options;
    if (body != null && typeof body !== "string") {
      throw new TypeError("Expected a serialized runtime request body.");
    }

    return implementation(input, { ...init, ...(body === undefined ? {} : { body }) });
  };

  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(request, { preconnect: fetch.preconnect }),
  );
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await Promise.resolve();
  }
}

async function advance(milliseconds: number): Promise<void> {
  jest.advanceTimersByTime(milliseconds);
  await settle();
}

function events(value: unknown, signal?: AbortSignal | null, chunkBytes = Number.MAX_SAFE_INTEGER) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let open = true;
  const remove = () => {
    open = false;
    signal?.removeEventListener("abort", aborted);
  };
  const aborted = () => {
    if (open) {
      remove();
      controller.error(signal?.reason);
    }
  };
  const enqueue = (value: unknown) => {
    const bytes = encoder.encode(JSON.stringify(value) + "\n");
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      controller.enqueue(bytes.subarray(offset, offset + chunkBytes));
    }
  };
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(stream) {
        controller = stream;
        signal?.addEventListener("abort", aborted, { once: true });
        if (signal?.aborted) {
          aborted();
        } else if (value !== undefined) {
          enqueue(value);
        }
      },
      cancel: remove,
    }),
  );

  return {
    response,
    frame(value: unknown) {
      if (open) {
        enqueue(value);
      }
    },
    end() {
      if (open) {
        remove();
        controller.close();
      }
    },
    fail(error: unknown) {
      if (open) {
        remove();
        controller.error(error);
      }
    },
  };
}

test("Raw history never becomes model prompts or other requests even on legacy services", async () => {
  // Protect host commands in popup-free API calls and legacy services.
  const state = snapshot();
  state.capabilities = [];

  const mocked = stubFetch(async () => {
    throw new Error("History commands must not transmit");
  });
  const client = new RuntimeClient(paths, state);
  try {
    // Reject valid commands and invalid arguments before transport.
    const history = await client.prompt("session", "/history");
    const invalid = await client.prompt("session", "/history recent");

    // Distinguish rejection reasons without model submission or automatic restart.
    expect(expectError(history).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(expectError(invalid).code).toBe("INVALID_INPUT");
    expect(mocked).not.toHaveBeenCalled();
  } finally {
    await client.disconnect();
    mocked.mockRestore();
  }
});

test("Legacy account services reject label edits before transport without restarting or changing state", async () => {
  // Existing account-switching services may still be running jobs on an older version.
  const state = { ...snapshot(), capabilities: ["accounts"] };
  const before = structuredClone(state);
  const mocked = stubFetch(async () => {
    throw new Error("Legacy services must not receive label edits");
  });
  const client = new RuntimeClient(paths, state);
  try {
    const renamed = await client.accounts({
      type: "rename",
      worktreeId: "one",
      provider: "openai",
      accountId: null,
      label: "ONEABLE",
      revision: 1,
    });

    // Require an explicit owner-controlled restart instead of guessing mutation support.
    expect(expectError(renamed).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(expectError(renamed).message).toContain("explicitly restart");
    expect(mocked).not.toHaveBeenCalled();
    expect(client.snapshot).toEqual(before);
  } finally {
    await client.disconnect();
    mocked.mockRestore();
  }
});

test("Session state above 8 MiB preserves conversations, drafts, and History connections", async () => {
  // Fragment real-failure-like snapshots exceeding 9 MiB from individually small sections.
  const large: RuntimeSnapshot = {
    ...snapshot(),
    preferences: { ...structuredClone(emptyPreferences), drafts: { unsent: "keep this draft" } },
    details: {
      conversation: {
        status: "working",
        output: "",
        error: null,
        sections: Array.from({ length: 2200 }, (_, index) => ({
          id: `section-${index}`,
          kind: "assistant",
          title: "Agent",
          text: `${index}:한글👩🏽‍💻 ${"x".repeat(4096)}`,
          status: "complete",
        })),
      },
    },
  };
  expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(maxFrameBytes);

  const requests: string[] = [];
  const fetchMock = stubFetch(async (input, options) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);

    return path === "/events" ? events(large, options?.signal, 65533).response : Response.json([]);
  });
  const client = new RuntimeClient(paths, snapshot());
  try {
    expectOk(await client.attach());
    expect(client.snapshot.details.conversation?.sections).toHaveLength(2200);
    expect(client.snapshot.details.conversation?.sections?.at(-1)?.text).toBe(
      large.details.conversation!.sections!.at(-1)!.text,
    );
    expect(client.snapshot.preferences.drafts).toEqual({ unsent: "keep this draft" });
    expect(expectOk(await client.listHistory("worktree"))).toEqual([]);
    expect(client.connected).toBe(true);
    expect(client.snapshot.notice).toBe("");
    expect(requests).toEqual(["/events", "/history"]);
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

test("Legacy new, clear, exit, and compact never fall back to model prompts or automatic restarts", async () => {
  // The old service would treat an unknown slash command as paid model input.
  const fetchMock = stubFetch(async () => {
    throw new Error("Must not transmit unsupported session commands");
  });
  const client = new RuntimeClient(paths, snapshot());
  try {
    for (const text of ["/new", "/clear", "/exit", "/compact", "/compact preserve this plan"]) {
      expect(expectError(await client.prompt("session", text)).code).toBe("UNSUPPORTED_CAPABILITY");
    }

    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

test("Session-controls-only services never receive destructive legacy new for new/clear", async () => {
  const state: RuntimeSnapshot = {
    ...snapshot(),
    capabilities: ["session-controls"],
    details: {
      session: { conversationId: "old", status: "working", output: "Retained", error: null },
    },
  };
  const fetchMock = stubFetch(async () => {
    throw new Error("Legacy replacement must not run");
  });
  const client = new RuntimeClient(paths, state);
  try {
    for (const text of ["/new", "/clear"]) {
      expect(expectError(await client.prompt("session", text)).code).toBe("UNSUPPORTED_CAPABILITY");
    }

    expect(expectError(await client.newTab("session")).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

test.each(["newTab", "create"] as const)(
  "%s waits for tab snapshots after creation responses before returning fresh IDs",
  async (action) => {
    // The command reply can arrive before the event stream exposes the created session.
    const state: RuntimeSnapshot = {
      ...snapshot(),
      capabilities: ["session-controls", "session-tab-commands"],
      repositories: [
        {
          id: "/fixture/.git",
          name: "Fixture",
          worktrees: [
            {
              id: "tree",
              name: "Tree",
              path: "/fixture",
              branch: "main",
              sessions: [{ id: "session", name: "Original", status: "working", subagents: [] }],
            },
          ],
        },
      ],
      details: {
        session: { conversationId: "old", status: "working", output: "Retained work", error: null },
      },
    };
    let stream: ReturnType<typeof events> | undefined;
    const sent: unknown[] = [];
    const fetchMock = stubFetch(async (input, options) => {
      if (new URL(String(input)).pathname === "/events") {
        stream = events(state, options?.signal);

        return stream.response;
      }

      sent.push(JSON.parse(String(options?.body)));

      return Response.json({ ok: true, value: "created" });
    });
    const client = new RuntimeClient(paths, state);
    try {
      expectOk(await client.attach());

      let resolved = false;
      // A caller must be able to select the returned session immediately after creation resolves.
      const creating = (
        action === "create" ? client.create("tree") : client.newTab("session")
      ).then((result) => {
        resolved = true;

        return result;
      });

      await settle();
      expect(resolved).toBe(false);
      stream!.frame({
        ...state,
        repositories: state.repositories.map((repo) => ({
          ...repo,
          worktrees: repo.worktrees.map((tree) => ({
            ...tree,
            sessions: [
              ...tree.sessions,
              { id: "created", name: "New", status: null, subagents: [] },
            ],
          })),
        })),
        details: {
          ...state.details,
          created: { conversationId: "fresh", status: null, output: "", error: null },
        },
      });
      // Both entry points preserve the original conversation while waiting for the new tab.
      expect(expectOk(await creating)).toBe("created");
      expect(
        client.snapshot.repositories[0]?.worktrees[0]?.sessions.map((session) => session.id),
      ).toEqual(["session", "created"]);
      expect(sent).toEqual(
        action === "create"
          ? [{ type: "create", worktreeId: "tree" }]
          : [
              {
                type: "session-control",
                sessionId: "session",
                conversationId: "old",
                action: "new-tab",
              },
            ],
      );
      expect(client.snapshot.details.session?.conversationId).toBe("old");
      expect(client.snapshot.details.session?.output).toBe("Retained work");
    } finally {
      await client.disconnect();
      fetchMock.mockRestore();
    }
  },
);

test("Interrupt validates capabilities/current conversation IDs and targets only exact sessions", async () => {
  // An older service must not receive an unknown command or be restarted automatically.
  const details: Record<string, RuntimeSnapshot["details"][string]> = {};
  const state = { ...snapshot(), details };
  const sent: unknown[] = [];
  const fetchMock = stubFetch(async (_input, options) => {
    sent.push(JSON.parse(String(options?.body)));

    return Response.json({ ok: true, value: null });
  });
  const client = new RuntimeClient(paths, state);
  try {
    expect(expectError(await client.interrupt("session")).code).toBe("UNSUPPORTED_CAPABILITY");
    state.capabilities = ["agent-interrupt"];
    expect(expectError(await client.interrupt("session")).code).toBe("PROTOCOL_ERROR");
    details.session = {
      conversationId: "conversation",
      status: "working",
      output: "",
      error: null,
    };

    expectOk(await client.interrupt("session"));

    expect(sent).toEqual([
      { type: "interrupt", sessionId: "session", conversationId: "conversation" },
    ]);
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

test("exit sends no close requests with only old tab capabilities or missing conversation IDs", async () => {
  // Existing new/clear support does not imply support for new exit commands.
  const state = { ...snapshot(), capabilities: ["session-controls", "session-tab-commands"] };
  const fetchMock = stubFetch(async () => {
    throw new Error("Unfenced exit must not transmit");
  });
  const client = new RuntimeClient(paths, state);
  try {
    // Check close capabilities and conversation IDs separately.
    const unsupported = await client.prompt("session", "/exit");
    state.capabilities.push("session-exit");

    const missingConversation = await client.prompt("session", "/exit");

    // Never fall back to unconditional closure of legacy services or replaced conversations.
    expect(expectError(unsupported).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(expectError(missingConversation).code).toBe("PROTOCOL_ERROR");
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

test("clear/exit/compact and ordinary input target current conversation IDs without invalid attachments/arguments", async () => {
  // A stable tab ID alone cannot fence an operation after /clear replaces its conversation.
  const state: RuntimeSnapshot = {
    ...snapshot(),
    capabilities: ["session-controls", "session-tab-commands", "session-exit", "prompt-images"],
    details: {
      session: { conversationId: "conversation-1", status: null, output: "", error: null },
    },
  };
  const sent: unknown[] = [];
  const fetchMock = stubFetch(async (_input, options) => {
    sent.push(JSON.parse(String(options?.body)));

    return Response.json({ ok: true, value: null });
  });
  const client = new RuntimeClient(paths, state);
  try {
    expectOk(await client.prompt("session", "/compact keep the plan"));
    expectOk(await client.prompt("session", "/clear"));
    expectOk(await client.prompt("session", "ordinary prompt"));
    expectOk(await client.prompt("session", "/exit"));
    expect(expectError(await client.prompt("session", "/new not supported")).code).toBe(
      "INVALID_INPUT",
    );
    expect(expectError(await client.prompt("session", "/new", ["/image.png"])).code).toBe(
      "INVALID_INPUT",
    );
    expect(expectError(await client.prompt("session", "/clear extra")).code).toBe("INVALID_INPUT");
    expect(expectError(await client.prompt("session", "/clear", ["/image.png"])).code).toBe(
      "INVALID_INPUT",
    );
    expect(expectError(await client.prompt("session", "/compact", ["/image.png"])).code).toBe(
      "INVALID_INPUT",
    );
    expect(expectError(await client.prompt("session", "/exit extra")).code).toBe("INVALID_INPUT");
    expect(expectError(await client.prompt("session", "/exit", ["/image.png"])).code).toBe(
      "INVALID_INPUT",
    );

    expect(sent).toEqual([
      {
        type: "session-control",
        sessionId: "session",
        conversationId: "conversation-1",
        action: "compact",
        instructions: "keep the plan",
      },
      {
        type: "session-control",
        sessionId: "session",
        conversationId: "conversation-1",
        action: "clear",
      },
      {
        type: "prompt",
        sessionId: "session",
        conversationId: "conversation-1",
        text: "ordinary prompt",
      },
      {
        type: "session-control",
        sessionId: "session",
        conversationId: "conversation-1",
        action: "exit",
      },
    ]);
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

test("Legacy runtime images and large input fail preservably without sending or restarting", async () => {
  const fetchMock = stubFetch(async () => {
    throw new Error("Must not send unsupported input");
  });
  const client = new RuntimeClient(paths, snapshot());
  try {
    expect(expectError(await client.prompt("session", "[Image #1]", ["/tmp/image.png"])).code).toBe(
      "UNSUPPORTED_CAPABILITY",
    );
    expect(expectError(await client.prompt("session", "x".repeat(1000001))).code).toBe(
      "UNSUPPORTED_CAPABILITY",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

test("Image-capable runtimes receive explicit image references in the same prompt command", async () => {
  const state = snapshot();
  state.capabilities = ["prompt-images"];

  const sent: unknown[] = [];
  const fetchMock = stubFetch(async (_input, options) => {
    sent.push(JSON.parse(String(options?.body)));

    return Response.json({ ok: true, value: null });
  });
  const client = new RuntimeClient(paths, state);
  try {
    expectOk(await client.prompt("session", "Inspect [Image #1]", ["/tmp/image.png"]));
    expect(sent).toEqual([
      {
        type: "prompt",
        sessionId: "session",
        text: "Inspect [Image #1]",
        images: ["/tmp/image.png"],
      },
    ]);
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

test("Legacy runtime /fast is explicitly rejected instead of becoming model input", async () => {
  const fetchMock = stubFetch(async () => {
    throw new Error("Settings must not become model input");
  });
  const client = new RuntimeClient(paths, snapshot());
  try {
    const result = await client.prompt("session", "/fast on");

    expect(expectError(result).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

for (const registered of [false, true]) {
  test(`Existing /fast registration ${registered} is checked read-only and commands send only when registered`, async () => {
    const state = snapshot();
    state.capabilities = ["prompt-completion"];

    const requests: string[] = [];
    const fetchMock = stubFetch(async (input) => {
      const path = new URL(String(input)).pathname;
      requests.push(path);

      return path === "/completions"
        ? Response.json({
            items: registered
              ? [{ kind: "command", value: "fast", description: "Existing Fast control" }]
              : [],
            truncated: false,
          })
        : Response.json({ ok: true, value: null });
    });
    const client = new RuntimeClient(paths, state);
    try {
      const result = await client.prompt("session", "/fast off");

      if (registered) {
        expectOk(result);
      } else {
        expect(expectError(result).code).toBe("UNSUPPORTED_CAPABILITY");
      }

      expect(requests).toEqual(registered ? ["/completions", "/command"] : ["/completions"]);
    } finally {
      await client.disconnect();
      fetchMock.mockRestore();
    }
  });
}

test("Legacy completion returns unsupported Results without requests or restarts", async () => {
  const fetchMock = stubFetch(async () => {
    throw new Error("Must not contact an older service");
  });
  const client = new RuntimeClient(paths, snapshot());
  try {
    expect(expectError(await client.complete("session", { kind: "command", query: "" })).code).toBe(
      "UNSUPPORTED_CAPABILITY",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

test("Legacy services never receive catalogs, reload, or dollar syntax as prompts or restarts", async () => {
  // Prevent settings commands from becoming paid prompts on servers lacking new syntax.
  const fetchMock = stubFetch(async () => {
    throw new Error("No request should be sent");
  });
  const client = new RuntimeClient(paths, snapshot());
  try {
    const catalog = await client.catalog("session");
    const reload = await client.prompt("session", "/reload");
    const skill = await client.prompt("session", "$review-code");

    expect(expectError(catalog).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(expectError(reload).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(expectError(skill).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

test("Full catalogs validate beyond 100 entries and reject wrong conversations or responses", async () => {
  // Search-page limits do not cap full catalogs; connection identity remains validated.
  const details = {
    session: { conversationId: "conversation", status: null, output: "", error: null },
  };
  const state = { ...snapshot(), capabilities: ["completion-catalog"], details };
  let mode: "valid" | "malformed" | "replaced" = "valid";
  const fetchMock = stubFetch(async (input, options) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe("/completion-catalog");
    expect(url.searchParams.get("conversationId")).toBe("conversation");
    expect(new Headers(options?.headers).get("X-Radian-Instance")).toBe("first");
    if (mode === "replaced") {
      details.session.conversationId = "replacement";
    }

    return Response.json(
      mode === "malformed"
        ? { conversationId: "wrong", items: [] }
        : {
            conversationId: "conversation",
            revision: 0,
            items: Array.from({ length: 150 }, (_, i) => ({
              kind: "command",
              value: `command-${i}`,
              description: "Command",
            })),
          },
    );
  });
  const client = new RuntimeClient(paths, state);
  try {
    const catalog = expectOk(await client.catalog("session"));
    mode = "malformed";

    const malformed = await client.catalog("session");
    mode = "replaced";

    const replaced = await client.catalog("session");

    expect(catalog.items).toHaveLength(150);
    expect(expectError(malformed).code).toBe("PROTOCOL_ERROR");
    expect(expectError(replaced).code).toBe("CANCELLED");
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

test("Completion uses instance-fenced read requests and rejects invalid candidates", async () => {
  const state = snapshot();
  state.capabilities = ["prompt-completion"];

  let malformed = false;
  const requests: string[] = [];
  const fetchMock = stubFetch(async (input, options) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    expect(url.searchParams.get("query")).toBe("문서/a b");
    expect(new Headers(options?.headers).get("X-Radian-Instance")).toBe("first");

    return Response.json(
      malformed
        ? { items: [{ value: "missing-kind" }], truncated: false }
        : {
            items: [{ kind: "file", value: "문서/a b.ts", description: "File" }],
            truncated: false,
          },
    );
  });
  const client = new RuntimeClient(paths, state);
  try {
    expect(
      expectOk(await client.complete("session", { kind: "file", query: "문서/a b" })).items[0]
        ?.value,
    ).toBe("문서/a b.ts");
    malformed = true;
    expect(
      expectError(await client.complete("session", { kind: "file", query: "문서/a b" })).code,
    ).toBe("PROTOCOL_ERROR");
    expect(requests).toEqual(["/completions", "/completions"]);
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

test("User-cancelled completion fetches return CANCELLED instead of exceptions or empty success", async () => {
  const state = snapshot();
  state.capabilities = ["prompt-completion"];

  const fetchMock = stubFetch(
    async (_input, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      }),
  );
  const client = new RuntimeClient(paths, state);
  const abort = new AbortController();
  try {
    const request = client.complete("session", { kind: "command", query: "" }, abort.signal);
    abort.abort();
    expect(expectError(await request).code).toBe("CANCELLED");
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

for (const failure of ["eof", "reset"] as const) {
  test(`Event ${failure} recovers with fresh snapshots without replaying mutations`, async () => {
    // Only the transport boundary is replaced; public client actions and stream parsing remain real.
    jest.useFakeTimers();

    const initial = snapshot();
    initial.capabilities = [];

    const fresh = snapshot();
    fresh.instance = "restarted";
    fresh.preferences.drafts = { session: "restored" };

    const streams: ReturnType<typeof events>[] = [];
    const commands: string[] = [];
    const fetchMock = stubFetch(async (input, options) => {
      const path = new URL(String(input)).pathname;
      if (path === "/events") {
        const stream = events(streams.length ? fresh : initial, options?.signal);
        streams.push(stream);

        return stream.response;
      }
      if (path === "/history") {
        return Response.json([]);
      }

      const command = JSON.parse(String(options?.body));
      commands.push(command.type);
      if (command.type === "prompt") {
        throw Object.assign(new Error("Acknowledgement lost"), { code: "ECONNRESET" });
      }
      if (command.type === "create") {
        streams[0]!.frame({
          ...initial,
          repositories: [
            {
              id: "/fixture/.git",
              name: "Fixture",
              worktrees: [
                {
                  id: "worktree",
                  name: "Worktree",
                  path: "/fixture",
                  branch: "main",
                  sessions: [{ id: "session", name: "Session", status: null, subagents: [] }],
                },
              ],
            },
          ],
          details: {
            session: { conversationId: "original", status: null, output: "", error: null },
          },
        });
      }

      return Response.json({ ok: true, value: command.type === "create" ? "session" : null });
    });
    const client = new RuntimeClient(paths, initial);
    try {
      expectOk(await client.attach());
      expectOk(await client.create("worktree"));
      expect(expectError(await client.prompt("session", "run")).message).toContain(
        "outcome is unknown",
      );
      expectOk(await client.closeSession("session"));

      // EOF and reset both permit read-only resubscription, never a replay of an uncertain action.
      if (failure === "eof") {
        streams[0]!.end();
      } else {
        streams[0]!.fail(Object.assign(new Error("stream reset"), { code: "ECONNRESET" }));
      }

      await settle();
      expect(client.snapshot.notice).toContain("Reconnecting");
      expect(expectError(await client.create("worktree")).code).toBe("CONNECTION_FAILED");
      await advance(250);

      // The fresh service identity/capabilities replace the stale snapshot and history works again.
      expect(streams).toHaveLength(2);
      expect(client.snapshot.instance).toBe("restarted");
      expect(client.snapshot.preferences.drafts).toEqual({ session: "restored" });
      expect(expectOk(await client.listHistory("worktree"))).toEqual([]);
      expect(commands).toEqual(["create", "prompt", "close"]);
    } finally {
      await client.disconnect();
      fetchMock.mockRestore();
      jest.useRealTimers();
    }
  });
}

test("Short repeated connections never reset retry budgets indefinitely after one snapshot", async () => {
  // A peer that accepts a stream and immediately closes must not cause an endless reconnect loop.
  jest.useFakeTimers();

  const streams: ReturnType<typeof events>[] = [];
  const fetchMock = stubFetch(async (_input, options) => {
    const stream = events(snapshot(), options?.signal);
    streams.push(stream);

    return stream.response;
  });
  const client = new RuntimeClient(paths, snapshot());
  try {
    expectOk(await client.attach());

    // Four retries use increasing delays; short successful handshakes do not reset that budget.
    for (const delay of [250, 500, 1000, 2000]) {
      streams.at(-1)!.end();
      await settle();
      await advance(delay);
    }

    streams.at(-1)!.end();
    await settle();
    await advance(60000);

    expect(streams).toHaveLength(5);
    expect(client.snapshot.notice).toContain("Reconnection stopped");
    expect(client.snapshot.notice).toContain("configured detach command");
    expect(client.snapshot.notice).not.toContain("Ctrl+C");
    expect(expectError(await client.listHistory("worktree")).code).toBe("CONNECTION_FAILED");
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
    jest.useRealTimers();
  }
});

test("Services without initial snapshots obey connection deadlines and retry budgets", async () => {
  // HTTP headers alone do not prove that a valid event subscription is ready.
  jest.useFakeTimers();

  const streams: ReturnType<typeof events>[] = [];
  const fetchMock = stubFetch(async (_input, options) => {
    const stream = events(streams.length ? undefined : snapshot(), options?.signal);
    streams.push(stream);

    return stream.response;
  });
  const client = new RuntimeClient(paths, snapshot());
  try {
    expectOk(await client.attach());
    streams[0]!.end();
    await settle();

    // Every retry bounds both headers and the first snapshot, not the established idle connection.
    for (const delay of [250, 500, 1000, 2000]) {
      await advance(delay);
      await advance(2000);
    }

    await advance(60000);

    expect(streams).toHaveLength(5);
    expect(client.snapshot.notice).toContain("Reconnection stopped");
    expect(client.snapshot.notice).toContain("timed out");
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
    jest.useRealTimers();
  }
});

test("UI detach cancels reconnect waits and prevents further connections", async () => {
  // Detaching is a terminal client action, unlike an accidental transport failure.
  jest.useFakeTimers();

  const stream = events(snapshot());
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(stream.response);
  const client = new RuntimeClient(paths, snapshot());
  try {
    expectOk(await client.attach());
    stream.end();
    await settle();

    await client.disconnect();
    await advance(60000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(expectError(await client.attach()).code).toBe("CONNECTION_FAILED");
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
    jest.useRealTimers();
  }
});

test("Detaching while awaiting first snapshots ends connection work and timers", async () => {
  // A stalled initial handshake must not prevent the configured detach action from disposing the client.
  jest.useFakeTimers();

  const fetchMock = stubFetch(
    async (_input, options) => events(undefined, options?.signal).response,
  );
  const client = new RuntimeClient(paths, snapshot());
  try {
    const attached = client.attach();
    await settle();

    await client.disconnect();

    const result = await attached;
    await advance(60000);

    expect(expectError(result).code).toBe("CONNECTION_FAILED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
    jest.useRealTimers();
  }
});

for (const mismatch of ["repository", "mode"] as const) {
  test(`Reconnect target ${mismatch} mismatches block commands and retries`, async () => {
    // A replacement instance is allowed only within the original workspace identity and live/test mode.
    jest.useFakeTimers();

    const first = events(snapshot());
    const other = snapshot();
    if (mismatch === "repository") {
      other.repositoryId = "/other/.git";
    } else {
      other.mode = "live";
    }

    const fetchMock = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(events(other).response);
    const client = new RuntimeClient(paths, snapshot());
    try {
      expectOk(await client.attach());
      first.end();
      await settle();

      await advance(250);
      await advance(60000);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(client.snapshot.instance).toBe("first");
      expect(client.snapshot.notice).toContain("identity");
      expect(expectError(await client.prompt("session", "run")).code).toBe("CONNECTION_FAILED");
    } finally {
      await client.disconnect();
      fetchMock.mockRestore();
      jest.useRealTimers();
    }
  });
}

test("Stable connections grant fresh reconnect budgets after later disconnects", async () => {
  // A previous brief outage should not permanently consume the budget for later independent outages.
  jest.useFakeTimers();

  const streams: ReturnType<typeof events>[] = [];
  const fetchMock = stubFetch(async (_input, options) => {
    const stream = events(snapshot(), options?.signal);
    streams.push(stream);

    return stream.response;
  });
  const client = new RuntimeClient(paths, snapshot());
  try {
    expectOk(await client.attach());
    streams[0]!.end();
    await settle();
    await advance(250);

    // The recovered connection stays healthy through the stability window before another outage.
    await advance(10000);
    streams[1]!.end();
    await settle();
    await advance(250);

    expect(streams).toHaveLength(3);
    expect(client.connected).toBe(true);
    expect(client.snapshot.notice).toBe("");
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
    jest.useRealTimers();
  }
});

test("Event-connection permission failures return typed errors without retries", async () => {
  // Retrying a permission denial cannot repair ownership and must not launch another service.
  jest.useFakeTimers();

  const original = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(original);
  const client = new RuntimeClient(paths, snapshot());
  try {
    const result = await client.attach();
    await advance(60000);

    expect(expectError(result).code).toBe("CONNECTION_FAILED");
    expect(expectError(result).cause).toBe(original);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
    jest.useRealTimers();
  }
});

test("Initial connection bugs propagate identical exceptions without reconnecting", async () => {
  // The initiating caller owns diagnostics until a client is attached successfully.
  jest.useFakeTimers();

  const defect = new TypeError("initial attachment defect");
  const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(defect);
  const client = new RuntimeClient(paths, snapshot());
  try {
    await expect(client.attach()).rejects.toBe(defect);
    await advance(60000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
    jest.useRealTimers();
  }
});

test("Unexpected stream errors log original causes instead of hiding behind retries", async () => {
  // An internal defect is not a transient connection error even if it occurs while reading a stream.
  jest.useFakeTimers();

  const defect = new TypeError("unexpected stream defect");
  const stream = events(snapshot());
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(stream.response);
  const log = spyOn(console, "error").mockImplementation(() => {});
  const client = new RuntimeClient(paths, snapshot());
  try {
    expectOk(await client.attach());

    stream.fail(defect);
    await settle();
    await advance(60000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.some((args) => args.includes(defect))).toBe(true);
    expect(client.snapshot.notice).toContain("Unexpected");
  } finally {
    await client.disconnect();
    log.mockRestore();
    fetchMock.mockRestore();
    jest.useRealTimers();
  }
});

test("Recovery to identical runtimes never replays disconnected PTY input or detach", async () => {
  // One input is already in flight; later keys have not crossed the transport boundary.
  jest.useFakeTimers();

  const state = snapshot();
  state.capabilities = ["history", "terminal-tabs"];

  const mainStreams: ReturnType<typeof events>[] = [];
  const commands: { type: string; data?: string; lease?: string }[] = [];
  const acknowledgement = Promise.withResolvers<Response>();
  let inputs = 0;
  const fetchMock = stubFetch(async (input, options) => {
    const path = new URL(String(input)).pathname;
    if (path === "/events") {
      const stream = events(state, options?.signal);
      mainStreams.push(stream);

      return stream.response;
    }
    if (path === "/terminal/events") {
      const frame: PtyFrame = {
        id: "shell",
        worktreeId: "tree",
        pid: 123,
        exited: false,
        exitCode: null,
        cols: 80,
        rows: 24,
        revision: 0,
        ansi: "",
      };
      expect(new Headers(options?.headers).get("X-Radian-Instance")).toBe("first");

      return events(frame, options?.signal).response;
    }

    const command = JSON.parse(String(options?.body));
    commands.push(command);
    if (command.type === "terminal-input" && ++inputs === 1) {
      return acknowledgement.promise;
    }

    return Response.json({ ok: true, value: null });
  });
  const client = new RuntimeClient(paths, state);
  const failures: unknown[] = [];
  try {
    expectOk(await client.attach());

    const old = expectOk(
      await client.attachTerminal(
        "shell",
        () => {},
        (error) => failures.push(error),
      ),
    );
    old.input(encoder.encode("sent-once"));
    old.input(encoder.encode("must-not-run"));
    await settle();
    expect(commands).toHaveLength(1);

    mainStreams[0]!.end();
    await settle();
    await advance(250);
    expect(client.connected).toBe(true);
    acknowledgement.resolve(Response.json({ ok: true, value: null }));
    await old.closed;
    old.input(encoder.encode("old-handle"));
    await settle();

    expect(commands.map((command) => command.type)).toEqual(["terminal-input"]);
    expect(Buffer.from(commands[0]!.data!, "base64").toString()).toBe("sent-once");
    expect(failures).toHaveLength(1);

    const fresh = expectOk(
      await client.attachTerminal(
        "shell",
        () => {},
        () => {},
      ),
    );
    expect(fresh.lease).not.toBe(old.lease);
    fresh.input(encoder.encode("explicit-new-input"));
    await settle();
    expect(
      commands
        .filter((command) => command.type === "terminal-input")
        .map((command) => Buffer.from(command.data!, "base64").toString()),
    ).toEqual(["sent-once", "explicit-new-input"]);
  } finally {
    acknowledgement.resolve(Response.json({ ok: true, value: null }));
    await client.disconnect();
    fetchMock.mockRestore();
    jest.useRealTimers();
  }
});

test("Detach during pending PTY input stops reconnection immediately and flushes only final preferences", async () => {
  jest.useFakeTimers();

  const state = snapshot();
  state.capabilities = ["terminal-tabs"];

  const acknowledgement = Promise.withResolvers<Response>();
  const commands: string[] = [];
  let subscriptions = 0;
  const fetchMock = stubFetch(async (input, options) => {
    const path = new URL(String(input)).pathname;
    if (path === "/events") {
      subscriptions++;

      return events(state, options?.signal).response;
    }
    if (path === "/terminal/events") {
      return events(
        {
          id: "shell",
          worktreeId: "tree",
          pid: 123,
          exited: false,
          exitCode: null,
          cols: 80,
          rows: 24,
          revision: 0,
          ansi: "",
        },
        options?.signal,
      ).response;
    }

    const command = JSON.parse(String(options?.body));
    commands.push(command.type);

    return command.type === "terminal-input"
      ? acknowledgement.promise
      : Response.json({ ok: true, value: null });
  });
  const client = new RuntimeClient(paths, state);
  try {
    expectOk(await client.attach());

    const terminal = expectOk(
      await client.attachTerminal(
        "shell",
        () => {},
        () => {},
      ),
    );
    terminal.input(encoder.encode("accepted-before-detach"));
    await settle();

    client.beginDetach();
    client.beginDetach();
    terminal.input(encoder.encode("too-late"));
    await advance(10000);
    expect(client.connected).toBe(false);
    expect(subscriptions).toBe(1);
    expect(expectError(await client.create("tree")).code).toBe("CONNECTION_FAILED");
    expectOk(
      await client.savePreferences({ ...state.preferences, drafts: { saved: "last draft" } }),
    );
    acknowledgement.resolve(Response.json({ ok: true, value: null }));
    await client.disconnect();

    expect(commands).toEqual(["terminal-input", "preferences", "terminal-detach"]);
    expect(expectError(await client.savePreferences(state.preferences)).code).toBe(
      "CONNECTION_FAILED",
    );
  } finally {
    acknowledgement.resolve(Response.json({ ok: true, value: null }));
    await client.disconnect();
    fetchMock.mockRestore();
    jest.useRealTimers();
  }
});

test.each(["supported", "unsupported", "malformed"] as const)(
  "%s terminal reads validate capabilities/responses while preserving shell input after failures",
  async (mode) => {
    // Replace only transport to verify actual capability checks and snapshot decoding.
    const state = snapshot();
    state.capabilities = [
      "terminal-tabs",
      ...(mode === "unsupported" ? [] : ["terminal-copy-mode"]),
    ];

    const commands: string[] = [];
    const fetchMock = stubFetch(async (input, options) => {
      const path = new URL(String(input)).pathname;
      if (path === "/events") {
        return events(state, options?.signal).response;
      }
      if (path === "/terminal/events") {
        return events(
          {
            id: "shell",
            worktreeId: "tree",
            pid: 123,
            exited: false,
            exitCode: null,
            cols: 80,
            rows: 24,
            revision: 0,
            ansi: "",
          },
          options?.signal,
        ).response;
      }

      const command = JSON.parse(String(options?.body));
      commands.push(command.type);

      return Response.json({
        ok: true,
        value:
          command.type === "terminal-read"
            ? mode === "malformed"
              ? "{bad json"
              : JSON.stringify({ text: "old output", cursor: { row: 0, column: 0 } })
            : null,
      });
    });
    const client = new RuntimeClient(paths, state);
    const failures: unknown[] = [];
    try {
      expectOk(await client.attach());

      const terminal = expectOk(
        await client.attachTerminal(
          "shell",
          () => {},
          (error) => failures.push(error),
        ),
      );

      const result = await terminal.read();
      if (mode === "supported") {
        expect(expectOk(result).text).toBe("old output");
      } else {
        expect(expectError(result).code).toBe(
          mode === "unsupported" ? "UNSUPPORTED_CAPABILITY" : "PROTOCOL_ERROR",
        );
      }

      terminal.input(encoder.encode("still interactive"));
      await settle();

      expect(commands.includes("terminal-read")).toBe(mode !== "unsupported");
      expect(commands).toContain("terminal-input");
      expect(failures).toEqual([]);
      expect(client.connected).toBe(true);
    } finally {
      await client.disconnect();
      fetchMock.mockRestore();
    }
  },
);

test("Detach while awaiting first PTY headers returns cancellation without sending commands", async () => {
  const state = snapshot();
  state.capabilities = ["terminal-tabs"];

  const commands: string[] = [];
  const fetchMock = stubFetch(async (input, options) => {
    if (new URL(String(input)).pathname === "/events") {
      return events(state, options?.signal).response;
    }
    if (new URL(String(input)).pathname === "/terminal/events") {
      return new Promise((_resolve, reject) => {
        const aborted = () => reject(options?.signal?.reason);
        if (options?.signal?.aborted) {
          aborted();
        } else {
          options?.signal?.addEventListener("abort", aborted, { once: true });
        }
      });
    }

    commands.push(String(options?.body));

    return Response.json({ ok: true, value: null });
  });
  const client = new RuntimeClient(paths, state);
  try {
    expectOk(await client.attach());

    const pending = client.attachTerminal(
      "shell",
      () => {},
      () => {},
    );
    await settle();
    await client.disconnect();
    expect(expectError(await pending).code).toBe("CONNECTION_FAILED");
    expect(commands).toEqual([]);
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

test("Programming bugs concurrent with handshake timeouts never become timeout errors", async () => {
  jest.useFakeTimers();

  const defect = new TypeError("defect racing timeout");
  const fetchMock = stubFetch(
    async (_input, options) =>
      new Promise((_resolve, reject) => {
        if (options?.signal?.aborted) {
          reject(defect);
        } else {
          options?.signal?.addEventListener("abort", () => reject(defect), { once: true });
        }
      }),
  );
  const client = new RuntimeClient(paths, snapshot());
  try {
    const attached = client.attach().catch((error: unknown) => error);
    await settle();
    await advance(2000);
    expect(await attached).toBe(defect);
    await advance(60000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
    jest.useRealTimers();
  }
});

test("Instance changes within one stream are rejected without retries", async () => {
  jest.useFakeTimers();

  const stream = events(snapshot());
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(stream.response);
  const client = new RuntimeClient(paths, snapshot());
  try {
    expectOk(await client.attach());
    stream.frame({ ...snapshot(), instance: "unexpected" });
    await settle();
    await advance(60000);
    expect(client.snapshot.instance).toBe("first");
    expect(client.connected).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.snapshot.notice).toContain("within the event stream");
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
    jest.useRealTimers();
  }
});
