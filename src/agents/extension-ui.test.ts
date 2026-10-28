import { expect, spyOn, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionRegistry } from "./session-registry.ts";
import { piSessionFactory } from "./pi-session-adapter.ts";
import { offlineRuntime } from "../testing/offline-runtime.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";

async function fixture(handler: string, onStart = "", extension = "") {
  const files = await createWorktreeFixture();
  const agent = join(files.directory, "agent"),
    extensions = join(agent, "extensions");
  await mkdir(extensions, { recursive: true });
  await writeFile(
    join(extensions, "ui.ts"),
    `export default function(pi) {
    pi.on("session_start", async (_event, ctx) => { ${onStart} });
    pi.registerCommand("ui-fixture", { handler: async (_args, ctx) => { ${handler} } });
    ${extension}
  }`,
  );
  const options = await offlineRuntime(agent);
  let models = 0;
  const registry = new SessionRegistry(
    [files.repository],
    piSessionFactory({
      ...options,
      streamFn: (...args) => {
        models++;
        return options.streamFn!(...args);
      },
    }),
  );
  registry.setUiActive(true);
  const id = expectOk(await registry.create(files.repository.worktrees[0]!.id));
  const conversation = registry.details(id)!.conversationId!;
  const current = () => registry.extensionUi.find((state) => state.sessionId === id);
  const waitFor = (predicate: () => boolean) => {
    if (predicate()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("Extension UI condition timed out"));
      }, 2000);
      const unsubscribe = registry.subscribe(() => {
        if (predicate()) {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      });
    });
  };
  return {
    ...files,
    registry,
    id,
    conversation,
    current,
    waitFor,
    models: () => models,
    answer: (response: Parameters<SessionRegistry["answerExtensionUi"]>[2]) =>
      registry.answerExtensionUi(id, conversation, response),
    async cleanup() {
      await registry.shutdown();
      await files.cleanup();
    },
  };
}

test("SDK commands admit interactive dialogs early and return select, confirm and input answers without model work", async () => {
  // Only the extension handles synthetic credentials; it never stores or echoes them.
  const app = await fixture(`
    if (!ctx.hasUI || ctx.mode !== "rpc") throw new Error("Expected hosted RPC UI");
    const selected = await ctx.ui.select("Choose a server", ["one", "two"]);
    const confirmed = await ctx.ui.confirm("Authorize", "Allow access?");
    const answer = await ctx.ui.input("Callback https://example.test/auth", "Paste callback");
    ctx.ui.notify(selected === "two" && confirmed && answer === "private-callback-fixture" ? "Expected answers received" : "Wrong answers", "info");
    ctx.ui.setStatus("fixture", "Ready");
  `);
  try {
    expectOk(await app.registry.prompt(app.id, "read"));
    const before = app.registry.details(app.id)?.sections,
      modelCalls = app.models();
    const accepted = Promise.withResolvers<void>();
    let complete = false;
    const run = app.registry
      .prompt(app.id, "/ui-fixture", () => accepted.resolve())
      .then((result) => {
        complete = true;
        return result;
      });
    await accepted.promise;
    expect(complete).toBe(false);
    expect(app.current()?.dialog?.kind).toBe("select");

    // Answers travel to the existing handler rather than becoming new Agent messages.
    expectOk(app.answer({ requestId: app.current()!.dialog!.id, value: "two" }));
    await app.waitFor(() => app.current()?.dialog?.kind === "confirm");
    expectOk(app.answer({ requestId: app.current()!.dialog!.id, confirmed: true }));
    await app.waitFor(() => app.current()?.dialog?.kind === "input");
    expectOk(
      app.answer({ requestId: app.current()!.dialog!.id, value: "private-callback-fixture" }),
    );
    expectOk(await run);

    // Live UI state is deliberately absent from checkpoint records and SDK history.
    expect(app.current()?.notifications.at(-1)?.message).toBe("Expected answers received");
    expect(app.current()?.statuses).toEqual({ fixture: "Ready" });
    expect(app.models()).toBe(modelCalls);
    expect(app.registry.details(app.id)?.sections).toEqual(before);
    expect(JSON.stringify(app.registry.checkpointRecords)).not.toContain(
      "https://example.test/auth",
    );
    const history = await readFile(app.registry.sessionFile(app.id)!, "utf8");
    expect(history).not.toContain("private-callback-fixture");
    expect(history).not.toContain("https://example.test/auth");
  } finally {
    await app.cleanup();
  }
});

test("SDK extensions style startup statuses and authentication dialogs without a Pi terminal", async () => {
  // MCP formats status text during session_start, before any interactive command runs.
  const app = await fixture(
    `
    const server = await ctx.ui.select(ctx.ui.theme.fg("accent", "Authenticate MCP"), ["vercel"]);
    if (server === "vercel") ctx.ui.notify("Authentication dialog completed");
  `,
    `ctx.ui.setStatus("mcp", ctx.ui.theme.fg("accent", "MCP ready"));`,
  );
  try {
    expect(app.current()?.statuses.mcp).toContain("MCP ready");

    // The same hosted RPC context must remain usable after startup and resource reload.
    for (const reload of [false, true]) {
      if (reload) expectOk(await app.registry.reload(app.id));
      expect(app.current()?.statuses.mcp).toContain("MCP ready");
      const run = app.registry.prompt(app.id, "/ui-fixture");
      await app.waitFor(() => !!app.current()?.dialog);
      expect(app.current()!.dialog!.title).toContain("Authenticate MCP");
      expectOk(app.answer({ requestId: app.current()!.dialog!.id, value: "vercel" }));
      expectOk(await run);

      // Styling and authentication UI must not become model work or transcript content.
      expect(app.current()?.notifications.at(-1)?.message).toBe("Authentication dialog completed");
      expect(app.models()).toBe(0);
      expect(app.registry.details(app.id)?.sections).toEqual([]);
    }
  } finally {
    await app.cleanup();
  }
});

test("MCP summaries count enabled servers and actionable issues without connecting or persisting runtime state", async () => {
  // Cached and lazy servers are enabled; disabled and trust-blocked entries are not available targets.
  const app = await fixture(
    `pi.events.emit("pi-mcp-adapter/status/v1", {
      version: 1, servers: [{ name: "updated", status: "failed", disabled: false }],
    });`,
    `pi.events.emit("pi-mcp-adapter/status/v1", { version: 1, servers: [
      { name: "connected", status: "connected", disabled: false },
      { name: "cached", status: "cached", disabled: false },
      { name: "lazy", status: "not-connected", disabled: false },
      { name: "auth", status: "needs-auth", disabled: false },
      { name: "failed", status: "failed", disabled: false },
      { name: "disabled", status: "disabled", disabled: false },
      { name: "flagged", status: "failed", disabled: true },
      { name: "untrusted", status: "blocked", disabled: false },
      { name: "blocked-reason", status: "needs-auth", disabled: false, blockedReason: "Approval required" },
    ] });`,
  );
  try {
    // A snapshot alone must travel through live UI transport, even without a setStatus call.
    expect(app.current()?.mcp).toEqual({ servers: 5, needsAuth: 1, errors: 1 });
    expect(app.current()?.statuses).toEqual({});
    app.registry.setUiActive(false);
    app.registry.setUiActive(true);
    expect(app.current()?.mcp).toEqual({ servers: 5, needsAuth: 1, errors: 1 });

    expectOk(await app.registry.prompt(app.id, "/ui-fixture"));

    expect(app.current()?.mcp).toEqual({ servers: 1, needsAuth: 0, errors: 1 });
    expectOk(await app.registry.reload(app.id));
    expect(app.current()?.mcp).toEqual({ servers: 5, needsAuth: 1, errors: 1 });
    expect(app.models()).toBe(0);
    expect(app.registry.details(app.id)?.sections).toEqual([]);
    expect(JSON.stringify(app.registry.checkpointRecords)).not.toContain("needsAuth");
    // Runtime snapshots and commands alone must not create a persisted conversation.
    expect(await Bun.file(app.registry.sessionFile(app.id)!).exists()).toBe(false);
  } finally {
    await app.cleanup();
  }
});

test("Malformed MCP events invalidate the previous summary and report a protocol warning", async () => {
  // An incompatible update must not leave a previously healthy summary visible.
  const app = await fixture(
    `pi.events.emit("pi-mcp-adapter/status/v1", { version: 2, servers: [] });`,
    `pi.events.emit("pi-mcp-adapter/status/v1", {
      version: 1, servers: [{ name: "cached", status: "cached", disabled: false }],
    });`,
  );
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(app.current()?.mcp).toEqual({ servers: 1, needsAuth: 0, errors: 0 });

    expectOk(await app.registry.prompt(app.id, "/ui-fixture"));

    expect(app.current()?.mcp).toBeUndefined();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("[radian:mcp] PROTOCOL_ERROR"));
    expect(app.models()).toBe(0);
  } finally {
    warning.mockRestore();
    await app.cleanup();
  }
});

async function mcpFixture(deferred = false, initialize = "publish();", shutdownSnapshot = true) {
  const startup = deferred
    ? shutdownSnapshot
      ? 'pi.events.emit("pi-mcp-adapter/status/v1", { version: 1, servers: [] });'
      : ""
    : "publish();";
  return fixture(
    `publish([{ name: _args, status: "needs-auth", disabled: false }]);`,
    startup,
    `
    let currentServers = [
      { name: "vercel", status: "needs-auth", disabled: false },
      { name: "supabase", status: "cached", disabled: false },
      { name: "disabled", status: "disabled", disabled: true },
      { name: "untrusted", status: "blocked", disabled: false },
    ];
    function publish(servers = currentServers) {
      currentServers = servers; pi.events.emit("pi-mcp-adapter/status/v1", { version: 1, servers });
    }
    pi.registerCommand("mcp-adapter", { handler: async (args, ctx) => {
      if (args !== "status") throw new Error("Expected status discovery");
      ctx.ui.setStatus("discovery", "ready"); ${initialize}
    } });
    pi.registerCommand("mcp-auth", { handler: async (args, ctx) => {
      if (!args) throw new Error("Pi custom picker must not run in RPC mode");
      ctx.ui.setStatus("auth-command", args);
      const callback = await ctx.ui.input("Complete " + args + " OAuth");
      if (callback !== undefined) ctx.ui.notify("Authenticated " + args);
    } });
  `,
  );
}

test.each([false, true])(
  "Bare /mcp-auth selects a server before reusing the adapter OAuth flow with deferred startup %s",
  async (deferred) => {
    // The installed adapter remains responsible for OAuth and credential storage.
    const app = await mcpFixture(deferred);
    try {
      expectOk(await app.registry.prompt(app.id, "read"));
      const before = app.registry.details(app.id)?.sections,
        models = app.models();
      const accepted = Promise.withResolvers<void>();
      const run = app.registry.prompt(app.id, "/mcp-auth   ", () => accepted.resolve());
      await accepted.promise;

      const picker = app.current()!.dialog!;
      expect(picker).toMatchObject({
        kind: "select",
        title: "Authenticate MCP server",
        options: ["vercel", "supabase"],
      });
      expect(app.current()?.statuses["auth-command"]).toBeUndefined();
      expect(app.current()?.statuses.discovery).toBe("ready");
      expectOk(app.answer({ requestId: picker.id, value: "vercel" }));
      await app.waitFor(() => app.current()?.dialog?.kind === "input");
      expect(app.current()?.dialog?.title).toBe("Complete vercel OAuth");
      expectOk(app.answer({ requestId: app.current()!.dialog!.id, value: "private-mcp-callback" }));
      expectOk(await run);

      // Neither host selection nor the callback belongs to model context or saved UI state.
      expect(app.current()?.notifications.at(-1)?.message).toBe("Authenticated vercel");
      expect(app.models()).toBe(models);
      expect(app.registry.details(app.id)?.sections).toEqual(before);
      const history = await readFile(app.registry.sessionFile(app.id)!, "utf8");
      expect(history).not.toContain("private-mcp-callback");
      expect(history).not.toContain("/mcp-auth");
    } finally {
      await app.cleanup();
    }
  },
);

test.each(["escape", "interrupt", "detach", "close"] as const)(
  "Cancelling /mcp-auth with %s never starts adapter authentication",
  async (action) => {
    // Selection alone must not authenticate the initially highlighted candidate.
    const app = await mcpFixture();
    try {
      const run = app.registry.prompt(app.id, "/mcp-auth");
      await app.waitFor(() => app.current()?.dialog?.kind === "select");

      if (action === "escape")
        expectOk(app.answer({ requestId: app.current()!.dialog!.id, cancelled: true }));
      else if (action === "interrupt") expectOk(await app.registry.interrupt(app.id));
      else if (action === "detach") app.registry.setUiActive(false);
      else expectOk(await app.registry.close(app.id));
      await run;

      expect(app.current()?.dialog).toBeUndefined();
      expect(app.current()?.statuses["auth-command"]).toBeUndefined();
      expect(app.models()).toBe(0);
    } finally {
      await app.cleanup();
    }
  },
);

test("Interrupting immediately after MCP selection prevents authentication from starting", async () => {
  // A submitted selection must not escape an interruption before its continuation runs.
  const app = await mcpFixture();
  try {
    const run = app.registry.prompt(app.id, "/mcp-auth");
    await app.waitFor(() => app.current()?.dialog?.kind === "select");

    expectOk(app.answer({ requestId: app.current()!.dialog!.id, value: "vercel" }));
    expectOk(await app.registry.interrupt(app.id));
    expectOk(await run);

    expect(app.current()?.dialog).toBeUndefined();
    expect(app.current()?.statuses["auth-command"]).toBeUndefined();
    expect(app.registry.details(app.id)?.status).toBeNull();
    expect(app.models()).toBe(0);
  } finally {
    await app.cleanup();
  }
});

test("Explicit /mcp-auth server bypasses selection and preserves the existing adapter command", async () => {
  // Explicit arguments remain the escape hatch for adapters without server snapshots.
  const app = await mcpFixture(true);
  try {
    const run = app.registry.prompt(app.id, "/mcp-auth vercel");
    await app.waitFor(() => !!app.current()?.dialog);

    expect(app.current()?.dialog?.kind).toBe("input");
    expect(app.current()?.statuses.discovery).toBeUndefined();
    expectOk(app.answer({ requestId: app.current()!.dialog!.id, cancelled: true }));
    expectOk(await run);
    expect(app.models()).toBe(0);
  } finally {
    await app.cleanup();
  }
});

test("MCP server snapshots stay session-local and reload discards previous choices", async () => {
  // A status update in another conversation must not change the originating picker.
  const app = await mcpFixture();
  try {
    const worktree = app.registry.snapshot[0]!.worktrees[0]!.id;
    const other = expectOk(await app.registry.create(worktree));
    expectOk(await app.registry.prompt(other, "/ui-fixture other-server"));
    expectOk(await app.registry.prompt(app.id, "/ui-fixture old-server"));
    expectOk(await app.registry.reload(app.id));

    const first = app.registry.prompt(app.id, "/mcp-auth"),
      second = app.registry.prompt(other, "/mcp-auth");
    await app.waitFor(
      () =>
        !!app.current()?.dialog &&
        !!app.registry.extensionUi.find((state) => state.sessionId === other)?.dialog,
    );
    const otherUi = app.registry.extensionUi.find((state) => state.sessionId === other)!;

    expect(app.current()?.mcp).toEqual({ servers: 2, needsAuth: 1, errors: 0 });
    expect(otherUi.mcp).toEqual({ servers: 1, needsAuth: 1, errors: 0 });
    expect(app.current()?.dialog).toMatchObject({ options: ["vercel", "supabase"] });
    expect(otherUi.dialog).toMatchObject({ options: ["other-server"] });
    expectOk(app.answer({ requestId: app.current()!.dialog!.id, cancelled: true }));
    expectOk(
      app.registry.answerExtensionUi(other, otherUi.conversationId, {
        requestId: otherUi.dialog!.id,
        cancelled: true,
      }),
    );
    expectOk(await first);
    expectOk(await second);
    expect(app.models()).toBe(0);
  } finally {
    await app.cleanup();
  }
});

test.each(["missing-list", "failed-initialization"])(
  "MCP discovery %s fails explicitly without sending commands to the model",
  async (failure) => {
    // Initialization failure is not permission to guess targets or fall back to model prompting.
    const app = await mcpFixture(
      true,
      failure === "missing-list" ? "" : 'throw new Error("MCP fixture startup failed");',
      false,
    );
    try {
      const result = expectError(await app.registry.prompt(app.id, "/mcp-auth"));

      expect(result.code).toBe(
        failure === "missing-list" ? "UNSUPPORTED_CAPABILITY" : "AGENT_FAILED",
      );
      expect(app.current()?.dialog).toBeUndefined();
      expect(app.models()).toBe(0);
    } finally {
      await app.cleanup();
    }
  },
);

test("Bare /mcp-auth without a configured adapter never becomes a model prompt", async () => {
  const app = await fixture("");
  try {
    const result = expectError(await app.registry.prompt(app.id, "/mcp-auth"));

    expect(result.code).toBe("UNSUPPORTED_CAPABILITY");
    expect(app.models()).toBe(0);
  } finally {
    await app.cleanup();
  }
});

test("Extension responses reject stale conversations, invalid choices and duplicate answers while queuing dialogs", async () => {
  // Concurrent requests must have independent identities even within the same command.
  const app = await fixture(
    `await Promise.all([ctx.ui.select("First", ["allowed"]), ctx.ui.confirm("Second", "Continue?")]);`,
  );
  try {
    const run = app.registry.prompt(app.id, "/ui-fixture");
    await app.waitFor(() => !!app.current()?.dialog);
    const requestId = app.current()!.dialog!.id;

    // Rejected responses must leave the original prompt pending.
    expect(
      expectError(app.registry.answerExtensionUi(app.id, "old", { requestId, value: "allowed" }))
        .code,
    ).toBe("SESSION_CONFLICT");
    expect(expectError(app.answer({ requestId, value: "not-allowed" })).code).toBe("INVALID_INPUT");
    expect(expectError(app.answer({ requestId, confirmed: true })).code).toBe("INVALID_INPUT");
    expect(app.current()?.dialog?.id).toBe(requestId);
    expectOk(app.answer({ requestId, value: "allowed" }));
    expect(expectError(app.answer({ requestId, value: "allowed" })).code).toBe("SESSION_CONFLICT");
    expect(app.current()?.dialog?.kind).toBe("confirm");
    expectOk(app.answer({ requestId: app.current()!.dialog!.id, cancelled: true }));

    expectOk(await run);
    expect(app.current()?.dialog).toBeUndefined();
    expect(app.models()).toBe(0);
  } finally {
    await app.cleanup();
  }
});

test.each(["interrupt", "detach", "close"] as const)(
  "%s cancels extension waits and does not leave sequential dialogs hanging",
  async (action) => {
    // A cancelled command may still execute cleanup that calls another UI method.
    const app = await fixture(`await ctx.ui.input("First"); await ctx.ui.input("Cleanup prompt");`);
    try {
      const run = app.registry.prompt(app.id, "/ui-fixture");
      await app.waitFor(() => !!app.current()?.dialog);

      if (action === "interrupt") expectOk(await app.registry.interrupt(app.id));
      else if (action === "close") expectOk(await app.registry.close(app.id));
      else app.registry.setUiActive(false);
      await run;

      expect(app.current()?.dialog).toBeUndefined();
      expect(app.models()).toBe(0);
    } finally {
      await app.cleanup();
    }
  },
);

test("Extension dialog timeouts return cancellation instead of retaining pending state", async () => {
  // The SDK timeout contract also covers dialogs with an immediate deadline.
  const app = await fixture(
    `const answer = await ctx.ui.input("Timed prompt", undefined, { timeout: 0 }); ctx.ui.notify(answer === undefined ? "Cancelled" : "Unexpected answer");`,
  );
  try {
    expectOk(await app.registry.prompt(app.id, "/ui-fixture"));

    expect(app.current()?.dialog).toBeUndefined();
    expect(app.current()?.notifications.at(-1)?.message).toBe("Cancelled");
    expect(app.models()).toBe(0);
  } finally {
    await app.cleanup();
  }
});

test("Command failures after dialog admission remain visible without echoing entered credentials", async () => {
  // Once admission has returned, a later SDK failure needs a separate UI notification.
  const app = await fixture(
    `const secret = await ctx.ui.input("Callback"); throw new Error("Failure with " + secret);`,
  );
  try {
    const accepted = Promise.withResolvers<void>();
    const run = app.registry.prompt(app.id, "/ui-fixture", () => accepted.resolve());
    await accepted.promise;

    expectOk(app.answer({ requestId: app.current()!.dialog!.id, value: "private-error-callback" }));
    const failure = expectError(await run);

    expect(failure.code).toBe("AGENT_FAILED");
    expect(failure.message).not.toContain("private-error-callback");
    expect(app.current()?.notifications.at(-1)?.level).toBe("error");
    expect(JSON.stringify(app.registry.extensionUi)).not.toContain("private-error-callback");
  } finally {
    await app.cleanup();
  }
});

test("Failed commands retract abandoned dialogs instead of accepting answers for a finished handler", async () => {
  // An extension can fail after opening a dialog without awaiting its result.
  const app = await fixture(
    `void ctx.ui.input("Abandoned callback"); throw new Error("Fixture failure");`,
  );
  try {
    const failure = expectError(await app.registry.prompt(app.id, "/ui-fixture"));

    expect(failure.code).toBe("AGENT_FAILED");
    expect(app.current()?.dialog).toBeUndefined();
    expect(app.current()?.notifications.at(-1)?.level).toBe("error");
  } finally {
    await app.cleanup();
  }
});

test("Pi subagent RPC widgets update only their originating session while detached and clear on retraction or reload", async () => {
  // Use the extension's real RPC widget contract, not a mocked Radian child handle.
  const app = await fixture(`
    if (_args === "clear") { ctx.ui.setWidget("subagent-async", undefined); return; }
    const now = Date.now();
    ctx.ui.setWidget("subagent-async", ["PI_SUBAGENT_ASYNC_JSON:" + JSON.stringify({
      kind: "pi-subagents.async-status-snapshot", version: 1, generatedAt: now,
      runs: [{ id: "pi-fixture", kind: "subagent", label: "Pi reviewer", state: "running", startedAt: now - 24000 }],
    })]);
  `);
  try {
    const worktree = app.registry.snapshot[0]!.worktrees[0]!.id;
    const other = expectOk(await app.registry.create(worktree));
    app.registry.setUiActive(false);

    expectOk(await app.registry.prompt(app.id, "/ui-fixture"));

    // Status continues independently of dialogs, UI attachment, and model turns.
    const sessions = () => app.registry.snapshot[0]!.worktrees[0]!.sessions;
    const children = sessions().find((session) => session.id === app.id)!.subagents;
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ name: "Pi reviewer", status: "working", source: "pi" });
    expect(children[0]?.runTiming?.elapsedMs).toBeGreaterThanOrEqual(24000);
    expect(sessions().find((session) => session.id === other)!.subagents).toEqual([]);
    expect(app.models()).toBe(0);
    expectOk(await app.registry.prompt(app.id, "/ui-fixture clear"));
    expect(sessions().find((session) => session.id === app.id)!.subagents).toEqual([]);
    expectOk(await app.registry.prompt(app.id, "/ui-fixture"));
    expectOk(await app.registry.reload(app.id));
    expect(sessions().find((session) => session.id === app.id)!.subagents).toEqual([]);
  } finally {
    await app.cleanup();
  }
});

test("Late Pi child identity events replace task labels only in their originating session", async () => {
  // A widget can arrive before the exact workflow-child identity is announced.
  const app = await fixture(`
    if (_args === "identity") {
      pi.events.emit("subagent:child-status", { type: "subagent.child-status", version: 1, runId: "workflow", childId: "writer", status: "started", agent: "implementer", ts: Date.now() });
      return;
    }
    const now = Date.now();
    ctx.ui.setWidget("subagent-async", ["PI_SUBAGENT_ASYNC_JSON:" + JSON.stringify({
      kind: "pi-subagents.async-status-snapshot", version: 1, generatedAt: now,
      runs: [{ id: "workflow", kind: "workflow", label: "Workflow", state: "running", children: [
        { id: "writer", kind: "step", label: "Test implementer response", state: "running", startedAt: now - 9000 },
      ] }],
    })]);
  `);
  try {
    const worktree = app.registry.snapshot[0]!.worktrees[0]!.id;
    const other = expectOk(await app.registry.create(worktree));
    const children = (id: string) =>
      app.registry.snapshot[0]!.worktrees[0]!.sessions.find((session) => session.id === id)!
        .subagents;
    app.registry.setUiActive(false);
    expectOk(await app.registry.prompt(app.id, "/ui-fixture"));
    const elapsed = children(app.id)[0]!.runTiming!.elapsedMs;

    expectOk(await app.registry.prompt(app.id, "/ui-fixture identity"));

    // Metadata enrichment must not reset elapsed time, create prompts, or cross session boundaries.
    expect(children(app.id)[0]).toMatchObject({ name: "implementer", status: "working" });
    expect(children(app.id)[0]!.runTiming!.elapsedMs).toBeGreaterThanOrEqual(elapsed);
    expect(children(app.id)[0]!.request).toBeUndefined();
    expect(children(other)).toEqual([]);
    expect(app.models()).toBe(0);
  } finally {
    await app.cleanup();
  }
});

test("Pi custom terminal components fail explicitly without pretending that Radian is a Pi TUI", async () => {
  // Unsupported UI must not look like a successful but invisible command.
  const app = await fixture(
    `await ctx.ui.custom(() => { throw new Error("Should not render"); });`,
  );
  try {
    const failure = expectError(await app.registry.prompt(app.id, "/ui-fixture"));

    expect(failure.code).toBe("AGENT_FAILED");
    expect(failure.message).toContain("custom terminal UI");
    expect(app.models()).toBe(0);
    expect(app.current()?.dialog).toBeUndefined();
  } finally {
    await app.cleanup();
  }
});
