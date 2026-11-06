import { expect, test } from "bun:test";
import { createAssistantMessageEventStream, type Api } from "@earendil-works/pi-ai";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubscriptionPolicyError } from "../errors.ts";
import { fixtureMessage, offlineRuntime } from "../testing/offline-runtime.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { piSessionFactory } from "./pi-session-adapter.ts";
import type { SessionContext, SessionExecutor } from "./session-registry.ts";

async function fixture(initialProvider = "openai-codex") {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "radian-subscription-routing-")));
  const options = await offlineRuntime(join(directory, "agent"));
  const runtime = options.modelRuntime!;
  const routes: { provider: string; api: Api; id: string; baseUrl: string }[] = [
    {
      provider: "openai-codex",
      api: "openai-codex-responses",
      id: "gpt-fixture",
      baseUrl: "https://chatgpt.com/backend-api",
    },
    {
      provider: "claude-code",
      api: "claude-code-stream-json",
      id: "claude-fixture",
      baseUrl: "process://claude-code",
    },
    {
      provider: "anthropic",
      api: "anthropic-messages",
      id: "claude-fixture",
      baseUrl: "https://api.anthropic.com",
    },
    {
      provider: "openai",
      api: "openai-responses",
      id: "gpt-fixture",
      baseUrl: "https://api.openai.com/v1",
    },
  ];
  for (const route of routes) {
    runtime.registerProvider(route.provider, {
      api: route.api,
      baseUrl: route.baseUrl,
      apiKey: "offline-subscription-fixture",
      models: [
        {
          id: route.id,
          name: route.id,
          reasoning: false,
          input: ["text"],
          contextWindow: 32000,
          maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
  }
  const initial = routes.find((route) => route.provider === initialProvider)!;
  options.model = runtime.getModel(initial.provider, initial.id)!;
  let calls = 0;
  let fail = false;
  options.streamFn = (model) => {
    calls++;
    const stream = createAssistantMessageEventStream();
    const message = fixtureMessage(model.api, model.provider, model.id);
    if (fail) {
      // Deliberately reuse policy wording: ordinary failures must never be classified by text.
      message.stopReason = "error";
      message.errorMessage = "Subscription-only mode blocks an unrelated fixture failure";
      stream.push({ type: "error", reason: "error", error: message });
    } else {
      message.content = [{ type: "text", text: "Offline subscription reply" }];
      stream.push({ type: "done", reason: "stop", message });
    }
    stream.end();
    return stream;
  };
  options.subscriptionsOnly = true;
  options.settings = { compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 128 } };
  const factory = piSessionFactory(options);
  const context: SessionContext = {
    cwd: directory,
    role: "main",
    spawnSubagent: async () => {
      throw new Error("No real child may be spawned in a routing fixture.");
    },
  };
  const executor = await factory(context);
  return {
    directory,
    runtime,
    executor,
    factory,
    context,
    calls: () => calls,
    fail: () => {
      fail = true;
    },
    async close() {
      await executor.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("subscription-only model discovery and selection reject native API routes without requests", async () => {
  // A mixed catalog includes the same Claude model name on two distinct providers.
  const app = await fixture();
  try {
    const catalog = expectOk(await app.executor.models!());
    const selection = await app.executor.selectModel!({
      provider: "anthropic",
      id: "claude-fixture",
    });

    // Filtering is not the permission boundary: direct selection is rejected independently.
    expect(catalog.models.map((model) => model.provider).sort()).toEqual([
      "claude-code",
      "openai-codex",
    ]);
    expect(expectError(selection).code).toBe("SUBSCRIPTION_ROUTE_BLOCKED");
    expect(app.calls()).toBe(0);
    expectOk(await app.executor.selectModel!({ provider: "claude-code", id: "claude-fixture" }));
    expect(app.calls()).toBe(0);
    expectOk(await app.executor.prompt("Run an isolated subscription request"));
    expect(app.calls()).toBe(1);
  } finally {
    await app.close();
  }
});

test("a restored native API selection is blocked before transport without silently changing models", async () => {
  // Existing conversations can retain a native API choice even after the picker is filtered.
  const app = await fixture("anthropic");
  try {
    const catalog = expectOk(await app.executor.models!());
    const blocked = await app.executor.prompt("Do not send a paid request");
    expect(expectError(blocked).code).toBe("SUBSCRIPTION_ROUTE_BLOCKED");

    // A useful failure leaves the user able to select an approved route and preserves the draft/history.
    expect(catalog.current?.provider).toBe("anthropic");
    expect(catalog.warning).toContain("Subscription-only mode blocks");
    expect(app.calls()).toBe(0);
    expect(app.executor.state.error ?? app.executor.state.output).toContain(
      "Subscription-only mode blocks",
    );
  } finally {
    await app.close();
  }
});

test.each(["new", "reopen"])(
  "%s sessions and inherited child defaults retain the request guard",
  async (reason) => {
    // Blocked historical/default choices must not be silently replaced by a different provider.
    const app = await fixture("anthropic");
    const opened: SessionExecutor[] = [];
    try {
      await app.executor.prompt("Preserve a blocked conversation");
      const replacement = await app.factory({
        ...app.context,
        ...(reason === "reopen"
          ? { sessionFile: app.executor.sessionFile! }
          : { startReason: "new", previousSessionFile: app.executor.sessionFile! }),
      });
      opened.push(replacement);
      const child = await app.factory({
        ...app.context,
        role: "subagent",
        agent: "default-agent",
        profile: {
          name: "default-agent",
          description: "Inherit the fixture's default model",
          skills: [],
          tools: [],
          prompt: "Use the configured model without substitution.",
          path: join(app.directory, "default-agent.md"),
        },
      });
      opened.push(child);

      // Each separately created agent owns a fresh guard, including a profile without model metadata.
      for (const executor of opened) {
        await executor.prompt("Do not send a paid request");
        expect(executor.state.error ?? executor.state.output).toContain(
          "Subscription-only mode blocks",
        );
        expect(expectOk(await executor.models!()).current?.provider).toBe("anthropic");
      }

      // Replacement, restoration and default profile resolution never invoke a transport or fallback.
      expect(app.calls()).toBe(0);
    } finally {
      for (const executor of opened) await executor.close();
      await app.close();
    }
  },
);

for (const role of ["main", "subagent"] as const) {
  test.each([
    ["anthropic", undefined, "SUBSCRIPTION_ROUTE_BLOCKED"],
    ["claude-code", " ", "SUBSCRIPTION_EXTRA_USAGE_ENABLED"],
  ] as const)(
    `${role} prompts expose %s policy codes without leaking into later failures`,
    async (provider, credits, code) => {
      // Main and inherited child sessions can restore a blocked default before any model selection.
      const previous = process.env.PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS;
      delete process.env.PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS;
      const app = await fixture(provider);
      let child: SessionExecutor | undefined;
      try {
        if (role === "subagent") {
          child = await app.factory({
            ...app.context,
            role,
            agent: "inherited",
            profile: {
              name: "inherited",
              description: "Inherit the current model",
              skills: [],
              tools: [],
              prompt: "Use the inherited model.",
              path: join(app.directory, "inherited.md"),
            },
          });
        }
        if (credits !== undefined) process.env.PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS = credits;
        const executor = child ?? app.executor;

        const blocked = expectError(await executor.prompt("Do not send"));

        // The public Result retains a typed policy error, and UI state keeps actionable guidance.
        expect(blocked).toBeInstanceOf(SubscriptionPolicyError);
        expect(blocked.code).toBe(code);
        expect(executor.state.error).toBe(blocked.message);
        expect(app.calls()).toBe(0);

        // A later normal transport failure, even with matching text, must not reuse the prior code.
        delete process.env.PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS;
        expectOk(await executor.selectModel!({ provider: "openai-codex", id: "gpt-fixture" }));
        app.fail();
        const normal = expectError(await executor.prompt("Run the offline failing transport"));
        expect(normal.code).toBe("AGENT_FAILED");
        expect(normal.message).toContain("Subscription-only mode blocks");
        expect(app.calls()).toBe(1);
      } finally {
        if (previous === undefined) delete process.env.PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS;
        else process.env.PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS = previous;
        await child?.close();
        await app.close();
      }
    },
  );
}

test("manual compaction cannot send a blocked historical model to a summary transport", async () => {
  // A restored conversation contains user context even when its next model request is blocked.
  const app = await fixture("anthropic");
  try {
    await app.executor.prompt("Preserve context that must not be sent to an API summarizer");
    await app.executor.prompt("Keep the next turn separate from the summarized context");

    // Summaries use the same guarded stream rather than an unguarded auxiliary client.
    const result = await app.executor.compact!();

    // Compaction reports a failure and never chooses a different provider to obtain a summary.
    expect(expectError(result).message).toContain("Subscription-only mode blocks");
    expect(app.calls()).toBe(0);
  } finally {
    await app.close();
  }
});

test("explicit agent profiles cannot bypass the subscription-only policy", async () => {
  // Profile configuration is an alternative model-entry point, not permission to use the API.
  const app = await fixture();
  let child: SessionExecutor | undefined;
  try {
    const creation = app
      .factory({
        ...app.context,
        role: "subagent",
        agent: "fixture-agent",
        profile: {
          name: "fixture-agent",
          description: "Offline native API profile",
          model: "anthropic/claude-fixture",
          skills: [],
          tools: [],
          prompt: "Do not make model requests.",
          path: join(app.directory, "fixture-agent.md"),
        },
      })
      .then((created) => {
        child = created;
        return created;
      });

    // Rejection happens during binding, before the provider is invoked or any fallback is selected.
    await expect(creation).rejects.toMatchObject({ code: "SUBSCRIPTION_ROUTE_BLOCKED" });
    expect(app.calls()).toBe(0);
  } finally {
    await child?.close();
    await app.close();
  }
});
