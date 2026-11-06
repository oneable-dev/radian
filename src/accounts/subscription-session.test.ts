import { expect, test } from "bun:test";
import {
  createAssistantMessageEventStream,
  createProvider,
  InMemoryCredentialStore,
  type Model,
} from "@earendil-works/pi-ai";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountManager } from "./manager.ts";
import { piSessionFactory } from "../agents/pi-session-adapter.ts";
import type { SessionExecutor } from "../agents/session-registry.ts";
import { fixtureMessage } from "../testing/offline-runtime.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { err } from "../result.ts";
import { CapabilityError } from "../errors.ts";

test.each([
  {
    name: "credential endpoint override",
    baseUrl: "https://api.anthropic.com",
    env: {},
    expected: "Subscription-only mode blocks",
    code: "SUBSCRIPTION_ROUTE_BLOCKED",
    afterFirstResolution: false,
  },
  {
    name: "endpoint override on SDK auth re-resolution",
    baseUrl: "https://api.anthropic.com",
    env: {},
    expected: "Subscription-only mode blocks",
    code: "SUBSCRIPTION_ROUTE_BLOCKED",
    afterFirstResolution: true,
  },
  {
    name: "credential usage-credit override",
    baseUrl: "process://claude-code",
    env: { PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS: "1" },
    expected: "requires PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS to be unset",
    code: "SUBSCRIPTION_EXTRA_USAGE_ENABLED",
    afterFirstResolution: false,
  },
])(
  "resolved $name cannot bypass a subscription-only session",
  async ({ baseUrl, env, expected, code, afterFirstResolution }) => {
    // Resolve credentials after the outer route check, entirely inside an isolated account store.
    const directory = await realpath(await mkdtemp(join(tmpdir(), "radian-subscription-account-")));
    const model: Model<"claude-code-stream-json"> = {
      id: "claude-fixture",
      name: "Offline CLI",
      provider: "claude-code",
      api: "claude-code-stream-json",
      baseUrl: "process://claude-code",
      reasoning: false,
      input: ["text"],
      contextWindow: 1000,
      maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    let calls = 0;
    let resolutions = 0;
    const stream = (selected: typeof model) => {
      calls++;
      const output = createAssistantMessageEventStream();
      const message = fixtureMessage(selected.api, selected.provider, selected.id);
      output.push({ type: "done", reason: "stop", message });
      output.end();
      return output;
    };
    const provider = createProvider({
      id: "claude-code",
      name: "Offline subscription provider",
      models: [model],
      auth: {
        apiKey: {
          name: "Offline CLI login",
          check: async () => ({ type: "api_key" as const }),
          resolve: async () => ({
            auth: {
              apiKey: "offline-only",
              baseUrl: afterFirstResolution && ++resolutions === 1 ? model.baseUrl : baseUrl,
            },
            env,
          }),
        },
      },
      api: { stream, streamSimple: stream },
    });
    const manager = expectOk(
      await AccountManager.open(join(directory, "accounts"), {
        offline: true,
        defaultCredentials: new InMemoryCredentialStore(),
        providers: [provider],
      }),
    );
    let executor: SessionExecutor | undefined;
    try {
      executor = await piSessionFactory({
        accounts: manager,
        subscriptionsOnly: true,
        agentDir: join(directory, "agent"),
        defaultPackagePaths: [],
        model,
        settings: { retry: { enabled: false }, compaction: { enabled: false } },
      })({
        cwd: directory,
        worktreeId: "offline-subscription",
        role: "main",
        spawnSubagent: async () => err(new CapabilityError("No child expected")),
      });

      // The account-bound transport checks resolved values, not only the original model declaration.
      const result = await executor.prompt("Do not launch a billable transport");

      // Neither override invokes the provider or causes a fallback, credential rewrite or live request.
      expect(expectError(result).code).toBe(code);
      expect(calls).toBe(0);
      if (afterFirstResolution) expect(resolutions).toBeGreaterThanOrEqual(2);
      expect(executor.state.error ?? executor.state.output).toContain(expected);
    } finally {
      await executor?.close();
      await manager.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
