import { expect, spyOn, test } from "bun:test";
import { ManualClock } from "@opentui/core/testing";
import { UsageMonitor } from "../usage/monitor.ts";
import { err, ok } from "../result.ts";
import { UsageError } from "../errors.ts";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type Api,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offlineRuntime, fixtureMessage } from "../testing/offline-runtime.ts";
import { expectOk, expectError } from "../testing/results.ts";
import { FastMode } from "./fast-mode.ts";
import { CommandDiagnostics } from "./session-commands.ts";
import { PiSessionExecutor } from "./pi-session-adapter.ts";

type Script = (request: SimpleStreamOptions | undefined, model: Model<Api>) => Promise<void>;

async function mount(
  script: Script,
  extensions: InlineExtension[] = [],
  usage?: UsageMonitor,
  fast?: FastMode,
) {
  const directory = await mkdtemp(join(tmpdir(), "radian-telemetry-"));
  const options = await offlineRuntime(directory);
  const modelRuntime = options.modelRuntime!;

  modelRuntime.registerProvider("telemetry-fixture", {
    api: "openai-codex-responses",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "offline",
    models: [
      {
        id: "model-fixture",
        name: "Telemetry fixture",
        reasoning: true,
        input: ["text"],
        contextWindow: 200000,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });

  const model = modelRuntime.getModel("telemetry-fixture", "model-fixture")!;
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [...(fast ? [fast.extension] : []), ...extensions],
  });

  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime,
    model,
    thinkingLevel: "high",
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(directory),
  });
  session.agent.streamFunction = async (model, _context, request) => {
    await script(request, model);

    const stream = createAssistantMessageEventStream();
    const message = fixtureMessage(model.api, model.provider, model.id);

    message.content = [{ type: "text", text: "Fixture completed without a network request." }];
    message.usage.input = 72000;
    message.usage.totalTokens = 72000;
    stream.push({ type: "done", reason: "stop", message });
    stream.end();

    return stream;
  };

  const diagnostics = new CommandDiagnostics();
  await session.bindExtensions({ onError: diagnostics.report });

  const original = {
    payload: session.agent.onPayload,
    response: session.agent.onResponse,
    event: session.agent.onProviderStreamEvent,
  };
  const executor = new PiSessionExecutor(session, usage, diagnostics, fast);

  return {
    executor,
    session,
    original,
    async close() {
      expectOk(await executor.close());
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const futureReset = () => Math.floor(Date.now() / 1000) + 3600;
const headers = (reset: number): Record<string, string> => ({
  "x-codex-secondary-used-percent": "18",
  "x-codex-secondary-window-minutes": "10080",
  "x-codex-secondary-reset-at": String(reset),
});

test("Fast defaults off before model calls and changes state and transport tier only through explicit commands", async () => {
  const fast = new FastMode();
  let requests = 0;
  let outgoing: unknown;
  const app = await mount(
    async (request, model) => {
      requests++;
      outgoing = await request?.onPayload?.({ model: model.id, service_tier: "priority" }, model);
    },
    [],
    undefined,
    fast,
  );
  try {
    expect(app.executor.state.telemetry?.fast).toBe(false);
    expect(app.executor.commands().filter((command) => command.value === "fast")).toHaveLength(1);

    const before = app.session.messages.length;

    expectOk(await app.executor.prompt("/fast on"));
    expect(app.executor.state.telemetry?.fast).toBe(true);
    expect(requests).toBe(0);
    expect(app.session.messages).toHaveLength(before);
    expectOk(await app.executor.prompt("ordinary request"));
    expect(outgoing).toEqual({ model: "model-fixture", service_tier: "priority" });

    expectOk(await app.executor.prompt("/fast off"));
    expect(app.executor.state.telemetry?.fast).toBe(false);
    expect(requests).toBe(1);
    expectOk(await app.executor.prompt("ordinary standard request"));
    expect(outgoing).toEqual({ model: "model-fixture" });
    expect(requests).toBe(2);
    expect(app.executor.state.telemetry?.effort).toBe("high");
  } finally {
    await app.close();
  }
});

test.each([false, true])(
  "Fast commands never create intermediate Working states or runs after %s conversations",
  async (seeded) => {
    // Fast only changes request configuration, including before the first model turn.
    const fast = new FastMode();
    let requests = 0;
    const app = await mount(
      async () => {
        requests++;
      },
      [],
      undefined,
      fast,
    );
    const statuses: ("working" | "complete" | "failure" | null)[] = [];
    let unsubscribe = () => {};
    try {
      if (seeded) {
        expectOk(await app.executor.prompt("Previous actual request"));
      }

      const expected = seeded ? "complete" : null;
      const messages = app.session.messages.length;

      expect(app.executor.state.status).toBe(expected);
      unsubscribe = app.executor.subscribe(() => statuses.push(app.executor.state.status));

      // Observe every published snapshot, not only the restored state after command completion.
      for (const action of ["on", "off", "status"]) {
        statuses.length = 0;
        expectOk(await app.executor.prompt(`/fast ${action}`));

        expect(statuses.length).toBeGreaterThan(0);
        expect(statuses.every((status) => status === expected)).toBe(true);
        expect(app.executor.state.status).toBe(expected);
        expect(app.executor.state.telemetry?.fast).toBe(action === "on");
        expect(requests).toBe(seeded ? 1 : 0);
        expect(app.session.messages).toHaveLength(messages);
        expect(app.executor.state.runTiming).toBeUndefined();
      }
    } finally {
      unsubscribe();
      await app.close();
    }
  },
);

test("Fast validation sends no requests and isolates state by model and session", async () => {
  const fast = new FastMode();
  let requests = 0;
  const app = await mount(
    async () => {
      requests++;
    },
    [],
    undefined,
    fast,
  );
  const other = await mount(
    async () => {
      requests++;
    },
    [],
    undefined,
    new FastMode(),
  );
  try {
    expect(expectError(fast.command("invalid", app.session.model)).code).toBe("INVALID_INPUT");
    expectOk(await app.executor.prompt("/fast on"));
    expect(app.executor.state.telemetry?.fast).toBe(true);
    expect(other.executor.state.telemetry?.fast).toBe(false);
    expect(fast.read({ ...app.session.model!, id: "another-model" })).toBe(false);

    const redirected = { model: "another-model" };
    expect(fast.apply(redirected, app.session.model!)).toBe(redirected);
    expect(
      expectError(fast.command("on", { ...app.session.model!, api: "openai-completions" })).code,
    ).toBe("UNSUPPORTED_CAPABILITY");
    expectOk(await app.executor.prompt("/fast status"));
    expect(requests).toBe(0);
  } finally {
    await app.close();
    await other.close();
  }
});

test("Installed /fast extensions override Radian defaults and preserve request transforms", async () => {
  let handled = false;
  const app = await mount(
    async (request, model) => {
      await request?.onPayload?.({}, model);
    },
    [
      (pi) => {
        pi.registerCommand("fast", {
          description: "Existing Fast control",
          handler: async () => {
            handled = true;
          },
        });
        pi.on("before_provider_request", () => ({ service_tier: "priority" }));
      },
    ],
    undefined,
    new FastMode(),
  );
  try {
    expect(app.executor.commands().filter((command) => command.value === "fast")).toHaveLength(1);
    expect(app.executor.state.telemetry?.fast).toBeNull();
    expectOk(await app.executor.prompt("/fast on"));
    expect(handled).toBe(true);
    expectOk(await app.executor.prompt("ordinary request"));
    expect(app.executor.state.telemetry?.fast).toBe(true);
  } finally {
    await app.close();
  }
});

test("Existing hooks returning null never fall back to original payloads", async () => {
  let outgoing: unknown = "not observed";
  const app = await mount(
    async (request, model) => {
      outgoing = await request?.onPayload?.({ model: model.id }, model);
    },
    [
      (pi) => {
        pi.on("before_provider_request", () => null);
      },
    ],
    undefined,
    new FastMode(),
  );
  try {
    expectOk(await app.executor.prompt("/fast on"));

    expectOk(await app.executor.prompt("scripted request"));

    expect(outgoing).toBeNull();
  } finally {
    await app.close();
  }
});

test("SDK sessions receive usage before prompts and refresh after final completion", async () => {
  // A real SDK session observes an injected account source without making a model request for usage.
  const clock = new ManualClock();
  let lookups = 0;
  let prompts = 0;
  const usage = new UsageMonitor(
    async () =>
      ok({
        key: "private-account",
        provider: "acme",
        load: async () => {
          lookups++;

          return ok([{ id: "period", usedPercent: 10, periodMs: 604800000, resetsAt: 604800000 }]);
        },
      }),
    clock,
  );
  const app = await mount(
    async () => {
      prompts++;
    },
    [],
    usage,
  );
  const settle = async () => {
    for (let i = 0; i < 70; i++) {
      await Promise.resolve();
    }
  };
  try {
    expect(app.executor.state.telemetry?.usage?.status).toBe("loading");
    await settle();
    expect(app.executor.state.telemetry?.usage?.windows[0]?.usedPercent).toBe(10);
    expect(prompts).toBe(0);
    expect(lookups).toBe(1);

    clock.advance(2500);
    expectOk(await app.executor.prompt("ordinary model request"));
    await settle();

    expect(prompts).toBe(1);
    expect(lookups).toBe(2);
  } finally {
    await app.close();
    await usage.stop();
  }
});

test.each(["authentication", "usage"] as const)(
  "Only /reload bypasses %s backoff while completion refreshes respect existing delays",
  async (stage) => {
    // SDK management commands and completion events require different refresh policies.
    const clock = new ManualClock();
    let lookups = 0;
    let prompts = 0;
    const succeeds = () => ++lookups > 1;
    const failure = err(new UsageError("USAGE_QUERY_FAILED", "Temporary failure"));
    const usage = new UsageMonitor(
      async () =>
        stage === "authentication" && !succeeds()
          ? failure
          : ok({
              key: "account",
              provider: "fixture",
              load: async () =>
                stage === "usage" && !succeeds()
                  ? failure
                  : ok([
                      { id: "weekly", usedPercent: 42, periodMs: 604800000, resetsAt: 604800000 },
                    ]),
            }),
      clock,
      () => 0,
    );
    const app = await mount(
      async () => {
        prompts++;
      },
      [],
      usage,
    );
    const settle = async () => {
      for (let i = 0; i < 70; i++) {
        await Promise.resolve();
      }
    };
    try {
      expect(app.executor.state.telemetry?.usage?.status).toBe("loading");
      await settle();
      expect(app.executor.state.telemetry?.usage?.status).toBe("error");
      expect(lookups).toBe(1);

      // Automatic refresh cannot bypass failure backoff even when work completes now.
      expectOk(await app.executor.prompt("ordinary work"));
      await settle();
      expect(lookups).toBe(1);

      const before = app.session.messages.length;
      expectOk(await app.executor.reload());
      await settle();

      // Only reload recovers usage immediately without extra model requests or messages.
      expect(lookups).toBe(2);
      expect(app.executor.state.telemetry?.usage?.status).toBe("ready");
      expect(app.executor.state.telemetry?.usage?.windows[0]?.usedPercent).toBe(42);
      expect(prompts).toBe(1);
      expect(app.session.messages).toHaveLength(before);
    } finally {
      await app.close();
      await usage.stop();
    }
  },
);

test("SDK model, effort, and context propagate without implicitly enabling Fast", async () => {
  // The real SDK supplies context accounting; only the provider boundary is scripted.
  const outgoing = { model: "model-fixture" };
  let sent: unknown;
  const app = await mount(async (request, model) => {
    sent = await request?.onPayload?.(outgoing, model);
  });
  try {
    expect(app.executor.state.telemetry?.fast).toBeNull();

    expectOk(await app.executor.prompt("observe metadata"));

    const telemetry = app.executor.state.telemetry!;
    expect(telemetry.model).toBe("model-fixture");
    expect(telemetry.effort).toBe("high");
    expect(telemetry.context).toEqual({ usedTokens: 72000, maxTokens: 200000 });
    expect(telemetry.fast).toBe(false);
    expect(telemetry.weekly).toBeNull();
    expect(sent).toBe(outgoing);
    expect(outgoing).toEqual({ model: "model-fixture" });
  } finally {
    await app.close();
  }
});

test("Post-compaction context uses local estimates until the next normal response supplies usage", async () => {
  // Sum only system, summary, and retained messages, not deleted history or pre-compaction usage.
  let requests = 0;
  const app = await mount(async () => {
    requests++;
  });
  const manager = app.session.sessionManager;
  try {
    manager.appendMessage({ role: "system", content: "s".repeat(800), timestamp: 0 });
    manager.appendMessage({ role: "user", content: "omitted".repeat(40000), timestamp: 1 });

    const kept = manager.appendMessage({
      role: "user",
      content: [
        { type: "text", text: "u".repeat(4000) },
        { type: "image", data: "AA==", mimeType: "image/png" },
      ],
      timestamp: 2,
    });
    const assistant = fixtureMessage(
      "openai-codex-responses",
      "telemetry-fixture",
      "model-fixture",
    );

    assistant.content = [{ type: "text", text: "a".repeat(400) }];
    assistant.usage.input = 72000;
    assistant.usage.totalTokens = 72000;
    manager.appendMessage(assistant);
    manager.appendCompaction("c".repeat(8000), kept, 72000);
    expect(app.session.getContextUsage()?.tokens).toBeNull();

    // Provide post-compaction size without another model call when SDK usage is unknown.
    const context = app.executor.state.telemetry?.context;

    // Total: system 200 + summary 2000 + input 1000 + images 1200 + answer 100 tokens.
    expect(context).toEqual({ usedTokens: 4500, maxTokens: 200000 });
    expect(requests).toBe(0);

    // Replace local estimates and old cache once fresh response usage is available.
    expectOk(await app.executor.prompt("Continue with measured usage"));
    expect(app.executor.state.telemetry?.context).toEqual({ usedTokens: 72000, maxTokens: 200000 });
    expect(requests).toBe(1);
  } finally {
    await app.close();
  }
});

test("Estimated context is cached until committed messages, content, or system prompts change", async () => {
  // Do not rebuild all context on every render while awaiting post-compaction usage.
  const app = await mount(async () => {});
  const manager = app.session.sessionManager;

  manager.appendCompaction("c".repeat(400), null, 72000);

  const projection = spyOn(manager, "buildSessionProjection");
  try {
    expect(app.executor.state.telemetry?.context).toEqual({ usedTokens: 100, maxTokens: 200000 });

    const reads = projection.mock.calls.length;

    // Snapshots at the same conversation position reuse estimates.
    for (let i = 0; i < 50; i++) {
      expect(app.executor.state.telemetry?.context?.usedTokens).toBe(100);
    }

    expect(projection.mock.calls.length).toBe(reads);

    // Committed input and append-only edits change position and update immediately.
    const user = manager.appendMessage({ role: "user", content: "u".repeat(400), timestamp: 1 });
    expect(app.executor.state.telemetry?.context?.usedTokens).toBe(200);
    manager.appendContextEdit(user, { content: "u".repeat(800) });
    expect(app.executor.state.telemetry?.context?.usedTokens).toBe(300);

    // System patches use the current effective prompt without accumulating old content.
    manager.appendMessage({
      role: "system",
      content: "",
      sections: { instruction: "s".repeat(400) },
      timestamp: 2,
    });
    expect(app.executor.state.telemetry?.context?.usedTokens).toBe(400);
    manager.appendMessage({
      role: "system",
      content: "",
      sections: { instruction: "s".repeat(800) },
      timestamp: 3,
    });
    expect(app.executor.state.telemetry?.context?.usedTokens).toBe(500);
  } finally {
    projection.mockRestore();
    await app.close();
  }
});

test("Real SDK manual compaction refreshes remaining context without another request", async () => {
  // Replace only the provider boundary offline; use real SDK compaction and checkpoints.
  const app = await mount(async () => {});
  try {
    app.session.settingsManager.applyOverrides({
      compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 128 },
    });
    expectOk(await app.executor.prompt("Compact this conversation"));

    // SDK token counts are null immediately after compaction; Radian estimates the checkpoint.
    expectOk(await app.executor.compact());

    const context = app.executor.state.telemetry?.context;
    expect(app.session.getContextUsage()?.tokens).toBeNull();
    expect(context?.usedTokens).toBeGreaterThan(0);
    expect(context?.usedTokens).toBeLessThan(72000);
    expect(context?.maxTokens).toBe(200000);
    expect(app.executor.state.status).toBe("complete");
    expect(app.executor.state.sections?.at(-1)?.title).toBe("Context compacted");
  } finally {
    await app.close();
  }
});

test("Missing model limits never produce invented context ratios after compaction", async () => {
  // Estimated tokens cannot define a remaining ratio without a known model limit.
  const app = await mount(async () => {});
  app.session.sessionManager.appendCompaction("c".repeat(400), null, 72000);

  const usage = spyOn(app.session, "getContextUsage").mockReturnValue(undefined);
  try {
    // Missing model metadata must not become 100% or an arbitrary total.
    const context = app.executor.state.telemetry?.context;

    expect(context).toBeNull();
  } finally {
    usage.mockRestore();
    await app.close();
  }
});

test("Fast and weekly headers preserve existing extension request transforms and response observers", async () => {
  // Priority comes from an existing extension, not the Radian status display.
  let responses = 0;
  let events = 0;
  let sent: unknown;
  const reset = futureReset();
  const outgoing = { model: "model-fixture" };
  const app = await mount(
    async (request, model) => {
      sent = await request?.onPayload?.(outgoing, model);
      await request?.onResponse?.({ status: 200, headers: headers(reset) }, model);
      await request?.onProviderStreamEvent?.({ type: "response.created" }, model);
    },
    [
      (pi) => {
        pi.on("before_provider_request", (event) => ({
          ...(event.payload as object),
          service_tier: "priority",
        }));
        pi.on("after_provider_response", () => {
          responses++;
        });
        pi.on("provider_stream_event", () => {
          events++;
        });
      },
    ],
  );
  try {
    expectOk(await app.executor.prompt("observe extension"));

    expect(sent).toEqual({ model: "model-fixture", service_tier: "priority" });
    expect(outgoing).toEqual({ model: "model-fixture" });
    expect(responses).toBe(1);
    expect(events).toBe(1);
    expect(app.executor.state.telemetry?.fast).toBe(true);
    expect(app.executor.state.telemetry?.weekly?.remainingPercent).toBe(82);
    expect(app.executor.state.telemetry?.weekly?.resetsAt).toBe(reset * 1000);
    expectOk(await app.executor.close());
    expect(app.session.agent.onPayload).toBe(app.original.payload);
    expect(app.session.agent.onResponse).toBe(app.original.response);
    expect(app.session.agent.onProviderStreamEvent).toBe(app.original.event);
  } finally {
    await app.close();
  }
});

test("Raw WebSocket quota events identify weekly windows by duration, not primary/secondary order", async () => {
  // A primary seven-day window and secondary five-hour window reverse the common ordering.
  const reset = futureReset();
  const app = await mount(async (request, model) => {
    await request?.onPayload?.({}, model);
    await request?.onProviderStreamEvent?.(
      {
        type: "codex.rate_limits",
        rate_limits: {
          primary: { used_percent: 36, window_minutes: 10080, reset_at: reset },
          secondary: { used_percent: 99, window_minutes: 300, reset_at: reset },
        },
      },
      model,
    );
  });
  try {
    expectOk(await app.executor.prompt("observe websocket quota"));

    expect(app.executor.state.telemetry?.weekly?.remainingPercent).toBe(64);
    expect(app.executor.state.telemetry?.weekly?.resetsAt).toBe(reset * 1000);
  } finally {
    await app.close();
  }
});

test("Missing, corrupt, or expired quotas never become stale or zero remaining usage and runs continue", async () => {
  // Optional quota failures must neither reject a valid response nor invent a full or exhausted allowance.
  const reset = futureReset();
  let responseHeaders = headers(reset);
  const app = await mount(async (request, model) => {
    await request?.onPayload?.({}, model);
    await request?.onResponse?.({ status: 200, headers: responseHeaders }, model);
  });
  try {
    expectOk(await app.executor.prompt("known quota"));
    expect(app.executor.state.telemetry?.weekly?.remainingPercent).toBe(82);

    for (const next of [
      {},
      { ...headers(reset), "x-codex-secondary-used-percent": "NaN" },
      { ...headers(reset), "x-codex-secondary-used-percent": "101" },
      { ...headers(reset), "x-codex-secondary-used-percent": "-1" },
      { ...headers(reset), "x-codex-secondary-reset-at": String(Number.MAX_SAFE_INTEGER) },
      { ...headers(reset), "x-codex-secondary-window-minutes": "300" },
      headers(Math.floor(Date.now() / 1000) - 1),
    ]) {
      responseHeaders = next;
      expectOk(await app.executor.prompt("unknown quota"));

      expect(app.executor.state.telemetry?.weekly).toBeNull();
      expect(app.executor.state.status).toBe("complete");
    }
  } finally {
    await app.close();
  }
});
