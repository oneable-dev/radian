import { expect, spyOn, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offlineRuntime } from "../testing/offline-runtime.ts";
import { expectOk } from "../testing/results.ts";
import { piSessionFactory } from "./pi-session-adapter.ts";
import type { SessionExecutor } from "./session-registry.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "radian-fast-mode-"));
  const options = await offlineRuntime(join(directory, "agent"));
  const runtime = options.modelRuntime!;
  const models = ["alpha", "beta"].map((id) => ({
    id,
    name: id,
    reasoning: true,
    input: ["text" as const],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
  for (const provider of ["fast-fixture", "other-fast-fixture"]) {
    runtime.registerProvider(provider, {
      api: "openai-codex-responses",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "offline",
      models,
    });
  }

  options.model = runtime.getModel("fast-fixture", "alpha")!;
  const scripted = options.streamFn!;
  const payloads: unknown[] = [];
  options.streamFn = async (model, context, request) => {
    payloads.push(await request?.onPayload?.({ model: model.id, service_tier: "priority" }, model));

    return scripted(model, context, request);
  };
  const executors: SessionExecutor[] = [];

  return {
    payloads,
    async open(sessionFile?: string) {
      // Each open creates a fresh factory, as a new runtime does after restart.
      const executor = await piSessionFactory(options)({
        cwd: directory,
        role: "main",
        isUiActive: () => true,
        ...(sessionFile ? { sessionFile } : {}),
        spawnSubagent: async () => {
          throw new Error("Unexpected fixture delegation");
        },
      });
      executors.push(executor);

      return executor;
    },
    async cleanup() {
      for (const executor of executors) {
        expectOk(await executor.close());
      }

      await rm(directory, { recursive: true, force: true });
    },
  };
}

test.each([true, false])(
  "Reopening a saved conversation restores its latest explicit Fast choice (%s) without model requests",
  async (enabled) => {
    // Opt-in before the first turn must be saved with that conversation, not globally.
    const app = await fixture();
    try {
      const first = await app.open();
      expectOk(await first.prompt("/fast on"));
      expect(app.payloads).toHaveLength(0);
      expectOk(await first.prompt("Persist this offline conversation."));
      if (!enabled) {
        expectOk(await first.prompt("/fast off"));
      }

      const file = first.sessionFile!;
      const conversation = first.savedSessionId;
      const sections = first.state.sections?.map(({ kind, text }) => ({ kind, text }));
      expectOk(await first.close());

      // Recreate the SDK session from disk without carrying any FastMode instance over.
      const restored = await app.open(file);
      const fresh = await app.open();

      // Restore the explicit request choice before the next turn; new sessions still default off.
      expect(restored.savedSessionId).toBe(conversation);
      expect(restored.state.telemetry?.fast).toBe(enabled);
      expect(restored.state.sections?.map(({ kind, text }) => ({ kind, text }))).toEqual(sections);
      expect(fresh.state.telemetry?.fast).toBe(false);
      expect(app.payloads).toHaveLength(1);
      const stored = await Bun.file(file).text();
      expectOk(await restored.prompt("/fast status"));
      expect(await Bun.file(file).text()).toBe(stored);
      expect(app.payloads).toHaveLength(1);

      expectOk(await restored.prompt("Check the restored request tier."));
      expect(app.payloads.at(-1)).toEqual({
        model: "alpha",
        ...(enabled ? { service_tier: "priority" } : {}),
      });
    } finally {
      await app.cleanup();
    }
  },
);

test("Fast restoration keeps explicit choices isolated by provider and model", async () => {
  // One conversation can opt in on one model and explicitly opt out on another.
  const app = await fixture();
  try {
    const first = await app.open();
    expectOk(await first.prompt("/fast on"));
    expectOk(await first.prompt("Persist model-specific choices."));
    expectOk(await first.selectModel!({ provider: "fast-fixture", id: "beta" }));
    expectOk(await first.prompt("/fast on"));
    expectOk(await first.prompt("/fast off"));
    const file = first.sessionFile!;
    expectOk(await first.close());

    const restored = await app.open(file);

    // Switching models after restoration must not inherit another model or provider's opt-in.
    expect(restored.state.telemetry?.fast).toBe(true);
    expectOk(await restored.selectModel!({ provider: "fast-fixture", id: "beta" }));
    expect(restored.state.telemetry?.fast).toBe(false);
    expectOk(await restored.prompt("Check the restored opt-out."));
    expect(app.payloads.at(-1)).toEqual({ model: "beta" });
    expectOk(await restored.selectModel!({ provider: "other-fast-fixture", id: "alpha" }));
    expect(restored.state.telemetry?.fast).toBe(false);
    expectOk(await restored.selectModel!({ provider: "fast-fixture", id: "alpha" }));
    expect(restored.state.telemetry?.fast).toBe(true);
    expect(app.payloads).toHaveLength(2);
  } finally {
    await app.cleanup();
  }
});

test("Fast restoration ignores malformed state and choices from abandoned branches", async () => {
  // Custom session entries are an external storage boundary, not trusted typed data.
  const app = await fixture();
  try {
    const first = await app.open();
    expectOk(await first.prompt("/fast on"));
    expectOk(await first.prompt("Persist the active branch."));
    const file = first.sessionFile!;
    expectOk(await first.close());
    const manager = SessionManager.open(file);
    const branch = manager.getLeafId()!;
    manager.appendCustomEntry("radian.fast-mode.v1", {
      provider: "fast-fixture",
      api: "openai-codex-responses",
      id: "alpha",
      enabled: false,
    });
    manager.branch(branch);
    for (const data of [
      null,
      [],
      { provider: "fast-fixture", api: "openai-codex-responses", id: "alpha", enabled: "off" },
      { provider: "fast-fixture", api: "openai-completions", id: "alpha", enabled: false },
      { provider: "fast-fixture", id: "alpha", enabled: false },
    ]) {
      manager.appendCustomEntry("radian.fast-mode.v1", data);
    }

    const restored = await app.open(file);

    // Only valid entries on the active branch may restore an explicit request choice.
    expect(restored.state.telemetry?.fast).toBe(true);
    expect(app.payloads).toHaveLength(1);
  } finally {
    await app.cleanup();
  }
});

test("Observed priority tiers never become persisted Fast opt-ins", async () => {
  // A request transform can report priority without the user opting in through /fast.
  const app = await fixture();
  try {
    const first = await app.open();
    expectOk(await first.prompt("Observe the fixture's priority tier."));
    expect(first.state.telemetry?.fast).toBe(true);
    const file = first.sessionFile!;
    expectOk(await first.close());

    const restored = await app.open(file);

    // Provider observations must not authorize priority requests in a later runtime.
    expect(restored.state.telemetry?.fast).toBe(false);
    expect(app.payloads).toHaveLength(1);
  } finally {
    await app.cleanup();
  }
});

test("Fast persistence failures retain the accepted choice and report a warning", async () => {
  // Limit the failure to SDK persistence after the conversation has already been saved.
  const app = await fixture();
  try {
    const executor = await app.open();
    expectOk(await executor.prompt("Persist before the storage failure."));
    const save = spyOn(SessionManager.prototype, "appendCustomEntry").mockImplementation(() => {
      throw Object.assign(new Error("Fixture storage failure"), { code: "ENOSPC" });
    });
    try {
      expectOk(await executor.prompt("/fast on"));

      // A storage warning is not a rejected toggle or a new model run.
      expect(executor.state.telemetry?.fast).toBe(true);
      expect(executor.extensionUi?.notifications.at(-1)).toMatchObject({
        level: "warning",
        message: expect.stringContaining("could not be saved"),
      });
      expect(app.payloads).toHaveLength(1);
    } finally {
      save.mockRestore();
    }
  } finally {
    await app.cleanup();
  }
});
