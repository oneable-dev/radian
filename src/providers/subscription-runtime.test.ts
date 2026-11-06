import { expect, jest, test } from "bun:test";
import { ModelRegistry, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  createProvider,
  InMemoryCredentialStore,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type ClassifierModel,
  type ImageModel,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piSessionFactory } from "../agents/pi-session-adapter.ts";
import type { SessionExecutor } from "../agents/session-registry.ts";
import { fixtureMessage } from "../testing/offline-runtime.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { subscriptionModelRuntime } from "./subscription-policy.ts";

async function fixture(provider = "openai-codex") {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const model: Model<Api> = {
    provider,
    api: provider === "claude-code" ? "claude-code-stream-json" : "openai-codex-responses",
    id: "subscription-fixture",
    name: "Subscription fixture",
    baseUrl:
      provider === "claude-code" ? "process://claude-code" : "https://chatgpt.com/backend-api",
    reasoning: false,
    input: ["text"],
    contextWindow: 1000,
    maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const paid: Model<Api> = {
    ...model,
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  };
  let calls = 0;
  let baseUrl: string | undefined;
  let env: Record<string, string> = {};
  let respond: ((model: Model<Api>, context: TranscriptContext) => AssistantMessage) | undefined;
  const stream = (selected: Model<Api>, context: TranscriptContext) => {
    calls++;
    const output = createAssistantMessageEventStream();
    const message =
      respond?.(selected, context) ?? fixtureMessage(selected.api, selected.provider, selected.id);
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      output.push({ type: "error", reason: message.stopReason, error: message });
    } else if (message.stopReason === "pending") {
      throw new Error("Offline responses must have a terminal stop reason");
    } else {
      output.push({ type: "done", reason: message.stopReason, message });
    }
    output.end();
    return output;
  };
  for (const selected of [model, paid]) {
    const provider = createProvider({
      id: selected.provider,
      name: selected.provider,
      models: [selected],
      auth: {
        apiKey: {
          name: "Offline auth",
          check: async () => ({ type: "api_key" as const }),
          resolve: async () => ({
            auth: { apiKey: "offline-only", ...(baseUrl ? { baseUrl } : {}) },
            env,
          }),
        },
      },
      api: { stream, streamSimple: stream },
    });
    runtime.registerNativeProvider({
      ...provider,
      fetchDeferred: (selected) => stream(selected, normalizeContext({ messages: [] })),
    });
  }
  await runtime.refresh({ allowNetwork: false });
  return {
    runtime,
    guarded: subscriptionModelRuntime(runtime),
    model,
    paid,
    calls: () => calls,
    respond: (handler: NonNullable<typeof respond>) => {
      respond = handler;
    },
    override: (url: string) => {
      baseUrl = url;
    },
    environment: (value: Record<string, string>) => {
      env = value;
    },
  };
}

test.each([
  ["main", "repository"],
  ["subagent", "repository"],
  ["main", "chat"],
  ["subagent", "chat"],
] as const)(
  "%s %s sessions disable idle cache warming without changing user settings",
  async (role, scope) => {
    // An eligible subscription model and costly cached prompt would trigger Pi's idle warmer.
    const app = await fixture();
    app.model.promptCache = { short: 11, long: 11 };
    app.model.cost = { input: 100, output: 1, cacheRead: 1, cacheWrite: 0 };
    app.model.contextWindow = 200000;
    app.respond((model) => {
      const message = fixtureMessage(model.api, model.provider, model.id);
      message.content = [{ type: "text", text: "Offline cached reply" }];
      message.usage.input = 100000;
      message.usage.totalTokens = 100000;
      return message;
    });
    const directory = await realpath(await mkdtemp(join(tmpdir(), "radian-cache-warming-")));
    const agentDir = join(directory, "agent");
    await mkdir(agentDir);
    const settingsPath = join(agentDir, "settings.json");
    const settings = JSON.stringify({ cacheWarming: "idle" });
    await writeFile(settingsPath, settings);
    let executor: SessionExecutor | undefined;
    try {
      expect(SettingsManager.create(directory, agentDir).getCacheWarmingMode()).toBe("idle");
      executor = await piSessionFactory({
        agentDir,
        sessionDir: join(directory, "sessions"),
        defaultPackagePaths: [],
        modelRuntime: app.runtime,
        model: app.model,
        subscriptionsOnly: true,
        settings: { retry: { enabled: false }, compaction: { enabled: false } },
      })({
        cwd: directory,
        role,
        ...(scope === "chat" ? { scope: { kind: "chat" as const } } : {}),
        ...(role === "subagent"
          ? {
              agent: "inherited",
              profile: {
                name: "inherited",
                description: "Offline inherited model",
                skills: [],
                tools: [],
                prompt: "Use the inherited model.",
                path: join(directory, "inherited.md"),
              },
            }
          : {}),
        spawnSubagent: async () => {
          throw new Error("No real child expected");
        },
      });

      // Exercise the real SDK stream and its one-second warming deadline, also after resource reload.
      for (const phase of ["initial", "reloaded"]) {
        if (phase === "reloaded") expectOk(await executor.reload!());
        jest.useFakeTimers();
        try {
          const before = app.calls();
          expectOk(await executor.prompt("Use the eligible subscription cache"));
          expect(app.calls()).toBe(before + 1);
          jest.advanceTimersByTime(1000);
          for (let index = 0; index < 40; index++) await Promise.resolve();

          // No refresh may reach the provider; global mode remains idle for other Pi sessions.
          expect(app.calls()).toBe(before + 1);
        } finally {
          jest.useRealTimers();
        }
      }
      expectOk(await executor.close());
      executor = undefined;
      expect(await readFile(settingsPath, "utf8")).toBe(settings);
      expect(SettingsManager.create(directory, agentDir).getCacheWarmingMode()).toBe("idle");
    } finally {
      jest.useRealTimers();
      await executor?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

for (const role of ["main", "subagent"] as const) {
  test.each([
    ["openai-codex", "SUBSCRIPTION_ROUTE_BLOCKED"],
    ["claude-code", "SUBSCRIPTION_EXTRA_USAGE_ENABLED"],
  ] as const)(
    `${role} prompt preserves %s auth-policy failures from the runtime facade`,
    async (provider, code) => {
      // Auth may resolve a blocked endpoint or usage-credit environment after the stream guard passes.
      const app = await fixture(provider);
      const directory = await realpath(
        await mkdtemp(join(tmpdir(), "radian-subscription-result-")),
      );
      const opened: SessionExecutor[] = [];
      try {
        const factory = piSessionFactory({
          agentDir: join(directory, "agent"),
          sessionDir: join(directory, "sessions"),
          defaultPackagePaths: [],
          modelRuntime: app.runtime,
          model: app.model,
          subscriptionsOnly: true,
          settings: { retry: { enabled: false }, compaction: { enabled: false } },
        });
        const executor = await factory({
          cwd: directory,
          role,
          ...(role === "subagent"
            ? {
                agent: "inherited",
                profile: {
                  name: "inherited",
                  description: "Offline inherited model",
                  skills: [],
                  tools: [],
                  prompt: "Use the inherited model.",
                  path: join(directory, "inherited.md"),
                },
              }
            : {}),
          spawnSubagent: async () => {
            throw new Error("No real child expected");
          },
        });
        opened.push(executor);
        if (provider === "claude-code")
          app.environment({ PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS: " " });
        else app.override("https://api.openai.com/v1");

        const result = await executor.prompt("Do not send");

        // SDK message conversion must not erase the public policy code or actionable UI text.
        const error = expectError(result);
        expect(error.code).toBe(code);
        expect(executor.state.error).toBe(error.message);
        expect(app.calls()).toBe(0);

        // The same source runtime is reusable, and a handled rejection cannot poison a later run.
        app.environment({});
        app.override(app.model.baseUrl);
        expectOk(await executor.prompt("Use the approved offline transport"));
        expect(app.calls()).toBe(1);
      } finally {
        for (const executor of opened) await executor.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

for (const role of ["main", "subagent"] as const) {
  test.each([
    ["handled", "failure"],
    ["handled", "identical-text"],
    ["handled", "success"],
    ["propagated", "success"],
    ["propagated", "failure"],
    ["handled", "blocked"],
  ] as const)(
    `${role} attributes the terminal request after a %s nested rejection and %s continuation`,
    async (handling, outcome) => {
      // A real extension replaces the read tool and calls the guarded registry, not the agent stream.
      const app = await fixture();
      const directory = await realpath(
        await mkdtemp(join(tmpdir(), "radian-subscription-nested-result-")),
      );
      const agentDir = join(directory, "agent");
      const nestedResultPath = join(directory, "nested-result.json");
      await mkdir(join(agentDir, "extensions"), { recursive: true });
      await writeFile(
        join(agentDir, "extensions", "nested.ts"),
        `export default function (pi) {
          pi.registerTool({
            name: "read", label: "Nested read", description: "Offline nested policy probe",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            async execute(_id, _args, _signal, _update, ctx) {
              const paid = ctx.modelRegistry.find("openai", "subscription-fixture");
              const result = await ctx.modelRegistry.complete(paid, { messages: [] });
              const { writeFile } = await import("node:fs/promises");
              await writeFile(${JSON.stringify(nestedResultPath)}, JSON.stringify(result));
              if (${handling === "propagated"}) throw new Error(result.errorMessage);
              return { content: [{ type: "text", text: "Handled nested rejection" }], details: {} };
            },
          });
        }`,
      );
      const toolResults: { isError: boolean; text: string }[] = [];
      const unrelated = "Subscription-only mode blocks an unrelated fixture failure";
      app.respond((model, context) => {
        const message = fixtureMessage(model.api, model.provider, model.id);
        const last = context.messages.at(-1);
        if (last?.role !== "toolResult") {
          message.content = [{ type: "toolCall", id: "nested-read", name: "read", arguments: {} }];
          message.stopReason = "toolUse";
          // Auth was approved for this request; only the next agent request sees the override.
          if (outcome === "blocked") app.override("https://api.openai.com/v1");
        } else {
          toolResults.push({
            isError: last.isError,
            text: last.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(""),
          });
          if (outcome === "failure" || outcome === "identical-text") {
            message.stopReason = "error";
            message.errorMessage =
              outcome === "identical-text"
                ? JSON.parse(readFileSync(nestedResultPath, "utf8")).errorMessage
                : unrelated;
          } else {
            message.content = [{ type: "text", text: "Continued after the tool result" }];
          }
        }
        return message;
      });
      let executor: SessionExecutor | undefined;
      try {
        executor = await piSessionFactory({
          agentDir,
          sessionDir: join(directory, "sessions"),
          defaultPackagePaths: [],
          modelRuntime: app.runtime,
          model: app.model,
          subscriptionsOnly: true,
          settings: { retry: { enabled: false }, compaction: { enabled: false } },
        })({
          cwd: directory,
          role,
          ...(role === "subagent"
            ? {
                agent: "nested-reader",
                profile: {
                  name: "nested-reader",
                  description: "Offline nested read probe",
                  skills: [],
                  tools: ["read"],
                  prompt: "Use the inherited model and read tool.",
                  path: join(directory, "nested-reader.md"),
                },
              }
            : {}),
          spawnSubagent: async () => {
            throw new Error("No real child expected");
          },
        });

        // The same prompt runs the nested rejection, tool result and agent-level continuation.
        const result = await executor.prompt("Read with the nested registry, then continue");

        // Nested calls stay blocked, but only the actual terminal request supplies the public code.
        const nested = JSON.parse(await readFile(nestedResultPath, "utf8"));
        expect(nested.stopReason).toBe("error");
        expect(nested.errorMessage).toContain("Subscription-only mode blocks openai/");
        if (outcome === "blocked") {
          const error = expectError(result);
          expect(error.code).toBe("SUBSCRIPTION_ROUTE_BLOCKED");
          expect(error.message).toContain("openai-codex/");
          expect(executor.state.error).toBe(error.message);
          expect(app.calls()).toBe(1);
        } else {
          expect(toolResults).toHaveLength(1);
          expect(toolResults[0]!.isError).toBe(handling === "propagated");
          expect(toolResults[0]!.text).toContain(
            handling === "propagated"
              ? "Subscription-only mode blocks"
              : "Handled nested rejection",
          );
          expect(app.calls()).toBe(2);
          if (outcome === "failure" || outcome === "identical-text") {
            const error = expectError(result);
            const expected = outcome === "identical-text" ? nested.errorMessage : unrelated;
            expect(error.code).toBe("AGENT_FAILED");
            expect(error.message).toBe(expected);
            expect(executor.state.error).toBe(expected);
          } else {
            expectOk(result);
            expect(executor.state.status).toBe("complete");
          }
        }
      } finally {
        await executor?.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

const operations = [
  "stream",
  "streamSimple",
  "complete",
  "completeSimple",
  "streamDeferred",
  "fetchDeferred",
] as const;
for (const operation of operations) {
  test(`runtime ${operation} guards the final auth resolution without changing the source runtime`, async () => {
    // All transports and credentials are in memory; the source runtime is deliberately reusable.
    const app = await fixture();
    const context = normalizeContext({ messages: [] });
    const handle = {
      provider: app.model.provider,
      modelId: app.model.id,
      api: app.model.api,
      id: "offline-response",
    };
    const invoke = async (runtime: ModelRuntime) => {
      if (operation === "streamDeferred") return runtime.streamDeferred(app.model, handle).result();
      if (operation === "fetchDeferred") return runtime.fetchDeferred(app.model, handle);
      const result = runtime[operation](app.model, context);
      return "result" in result ? result.result() : result;
    };

    // SDK prepareRequest internally calls this.getAuth; it must retain the proxy receiver.
    expect((await invoke(app.guarded)).stopReason).toBe("stop");
    app.override("https://api.openai.com/v1");
    const blocked = await invoke(app.guarded);

    // Rejected generations never reach the provider, while the original fixture stays unchanged.
    expect(blocked.stopReason).toBe("error");
    expect(blocked.errorMessage).toContain("Subscription-only mode blocks");
    expect(app.calls()).toBe(1);
    expect((await invoke(app.runtime)).stopReason).toBe("stop");
    expect(app.calls()).toBe(2);
  });
}

test("extension registry calls and physical virtual-model recursion use the guarded runtime", async () => {
  // The same ModelRegistry facade is supplied to extensions and codemode by Pi.
  const app = await fixture();
  const registry = new ModelRegistry(app.guarded);
  const context = normalizeContext({ messages: [] });
  app.runtime.registerVirtualModel({
    provider: "offline-router",
    id: "router",
    name: "Offline router",
    route: () => ({ model: app.paid, thinkingLevel: "off" }),
  });
  const virtual = app.runtime.getModel("offline-router", "router")!;

  // Nested completions and recursive streamSimple calls must not use the unwrapped source.
  const direct = await registry.stream(app.paid, context).result();
  const complete = await registry.complete(app.paid, context);
  const routed = await registry.streamSimple(virtual, context).result();

  // Provider-string auth remains independent of generation eligibility and never sends a request.
  expect(direct.errorMessage).toContain("Subscription-only mode blocks");
  expect(complete.errorMessage).toContain("Subscription-only mode blocks");
  expect(routed.errorMessage).toContain("Subscription-only mode blocks");
  expect(await registry.getProviderAuth("openai")).toBeDefined();
  expect(app.calls()).toBe(0);
});

test("session extensions receive the guarded registry during binding and reload", async () => {
  // A real SDK extension calls the registry directly, outside agent.streamFunction.
  const app = await fixture();
  const directory = await realpath(await mkdtemp(join(tmpdir(), "radian-subscription-extension-")));
  const agentDir = join(directory, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  const resultsPath = join(directory, "nested-results.jsonl");
  await writeFile(
    join(agentDir, "extensions", "nested.ts"),
    `
    import { appendFile } from "node:fs/promises";
    export default function (pi) {
      pi.registerProvider("offline-api-alias", {
        api: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: "offline-only",
        models: [{ id: "alias", name: "API alias", reasoning: false, input: ["text"],
          contextWindow: 1000, maxTokens: 100,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        streamSimple() { throw new Error("Unexpected extension transport invocation"); },
      });
      pi.registerCommand("nested-route", {
        description: "Offline nested generation probe",
        handler: async (_, ctx) => {
          const model = ctx.modelRegistry.find("offline-api-alias", "alias");
          const result = await ctx.modelRegistry.complete(model, { messages: [] });
          await appendFile(${JSON.stringify(resultsPath)}, JSON.stringify({ reason: result.stopReason, error: result.errorMessage }) + "\\n");
        },
      });
    }
  `,
  );
  let executor: SessionExecutor | undefined;
  try {
    executor = await piSessionFactory({
      agentDir,
      sessionDir: join(directory, "sessions"),
      defaultPackagePaths: [],
      modelRuntime: app.runtime,
      model: app.model,
      subscriptionsOnly: true,
      settings: { retry: { enabled: false }, compaction: { enabled: false } },
    })({
      cwd: directory,
      role: "main",
      spawnSubagent: async () => {
        throw new Error("No child expected");
      },
    });

    // Reload builds a fresh extension runtime; neither binding may expose the source facade.
    expectOk(await executor.prompt("/nested-route"));
    expectOk(await executor.reload!());
    expectOk(await executor.prompt("/nested-route"));
    const entries = (await readFile(resultsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    // Both commands finish with explicit failures and never call a model transport.
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.reason).toBe("error");
      expect(entry.error).toContain("Subscription-only mode blocks");
    }
    expect(app.calls()).toBe(0);
  } finally {
    await executor?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("classifier and image generations fail closed through the extension registry", async () => {
  // Auxiliary non-chat models are not subscription generation routes even when credentials exist.
  const app = await fixture();
  let calls = 0;
  const image: ImageModel<"openrouter-images"> = {
    ...app.paid,
    type: "image",
    api: "openrouter-images",
    output: ["image"],
  };
  const classifier: ClassifierModel<"openai-decisions"> = {
    ...app.paid,
    type: "classifier",
    api: "openai-decisions",
  };
  const provider = app.runtime.getProvider("openai")!;
  app.runtime.registerNativeProvider({
    ...provider,
    getAllModels: () => [app.paid, image, classifier],
    generateImages: async () => {
      calls++;
      throw new Error("Unexpected paid image call");
    },
    classify: async () => {
      calls++;
      throw new Error("Unexpected paid classifier call");
    },
  });
  const registry = new ModelRegistry(app.guarded);

  // Pi's one-shot APIs return error results, rather than rejecting their documented contracts.
  const images = await registry.generateImages(image, {
    input: [{ type: "text", text: "fixture" }],
  });
  const classified = await registry.classify(classifier, { state: {}, questions: {} });

  // Both calls stop before generation and preserve provider-owned non-chat error result shapes.
  expect(images.stopReason).toBe("error");
  expect(images.errorMessage).toContain("Subscription-only mode blocks");
  expect(classified.stopReason).toBe("error");
  expect(classified.errorMessage).toContain("Subscription-only mode blocks");
  expect(calls).toBe(0);
});
