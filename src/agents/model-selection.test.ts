import { expect, spyOn, test } from "bun:test";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { StorageError } from "../errors.ts";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { SessionRegistry } from "./session-registry.ts";
import { piSessionFactory } from "./pi-session-adapter.ts";
import { parseModelCommand } from "./model-selection.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { offlineRuntime } from "../testing/offline-runtime.ts";
import { expectError, expectOk } from "../testing/results.ts";

async function mount() {
  const fixture = await createWorktreeFixture(), options = await offlineRuntime(join(fixture.directory, "agent"));
  const runtime = options.modelRuntime!;
  runtime.registerProvider("other-fixture", { api: "openai-completions", apiKey: "PRIVATE_FIXTURE_KEY", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "fixture", name: "Other model", reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "reasoner", name: "Reasoning fixture", reasoning: true, input: ["text"], contextWindow: 64000, maxTokens: 8192,
        thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const requested: string[] = [], efforts: (string | undefined)[] = [], base = options.streamFn!;
  // Use the real SDK for model selection, replacing only model responses with fixtures.
  const { model: _model, ...rest } = options;
  const registry = new SessionRegistry([fixture.repository], piSessionFactory({ ...rest,
    settings: { defaultProvider: "radian-offline", defaultModel: "fixture" },
    streamFn: (model, context, request) => { requested.push(`${model.provider}/${model.id}`); efforts.push(request?.reasoning); return base(model, context, request); } }));
  const tree = fixture.repository.worktrees.find(tree => tree.path === fixture.main)!;
  return { ...fixture, registry, tree, requested, efforts, runtime, async close() { await registry.shutdown(); await fixture.cleanup(); } };
}

test("The model command is popup-only and never sends arguments as model prompts", () => {
  // Distinguish model-name arguments and similar commands from popup invocation.
  expect(expectOk(parseModelCommand("/model"))).toBe(true);
  expect(expectOk(parseModelCommand("/model \n"))).toBe(true);
  expect(expectOk(parseModelCommand("/models"))).toBe(false);
  expect(expectError(parseModelCommand("/model provider/model")).code).toBe("INVALID_INPUT");
});

test("Model selection updates the current SDK session's next request, metadata, and resumed history only", async () => {
  const app = await mount();
  try {
    const id = expectOk(await app.registry.create(app.tree.id)), other = expectOk(await app.registry.create(app.tree.id));
    const conversation = app.registry.details(id)!.conversationId!;
    const catalog = expectOk(await app.registry.models(id, conversation));
    expect(catalog.current).toEqual({ provider: "radian-offline", id: "fixture" });
    expect(catalog.models.some(model => model.provider === "other-fixture" && model.id === "fixture")).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain("PRIVATE_FIXTURE_KEY"); expect(JSON.stringify(catalog)).not.toContain("127.0.0.1");
    expect(expectOk(await app.registry.complete(id, { kind: "command", query: "model" })).items.some(item => item.value === "model")).toBe(true);

    // Apply a model with the same ID but a different provider only to the current session.
    expectOk(await app.registry.selectModel(id, conversation, { provider: "other-fixture", id: "fixture" }));
    expect(app.registry.details(id)!.telemetry?.provider).toBe("other-fixture");
    expect(app.registry.details(other)!.telemetry?.provider).toBe("radian-offline");
    expectOk(await app.registry.prompt(id, "Inspect fixture"));
    expect(app.requested).toEqual(["other-fixture/fixture"]);
    const file = app.registry.sessionFile(id)!;
    expect(await readFile(file, "utf8")).toContain('"provider":"other-fixture"');
    const record = app.registry.records.find(record => record.id === id)!;
    expectOk(await app.registry.close(id)); expectOk(await app.registry.restore(record));
    expect(app.registry.details(id)!.telemetry?.provider).toBe("other-fixture");
    expect(app.registry.details(id)!.conversationId).toBe(conversation);
    expect(expectOk(await app.registry.models(id, conversation)).current?.provider).toBe("other-fixture");
    const fresh = expectOk(await app.registry.create(app.tree.id));
    expect(app.registry.details(fresh)!.telemetry?.provider).toBe("radian-offline");
  } finally { await app.close(); }
});

test("Publish only the final model/effort pair and persist effort-only changes for requests and resume", async () => {
  // SDK normalization passes through low; the host must show only the chosen high effort.
  const app = await mount();
  const model = { provider: "other-fixture", id: "reasoner" };
  try {
    const id = expectOk(await app.registry.create(app.tree.id)), other = expectOk(await app.registry.create(app.tree.id));
    const conversation = app.registry.details(id)!.conversationId!;
    const catalog = expectOk(await app.registry.models(id, conversation));
    const entry = catalog.models.find(item => item.id === "reasoner")!;
    expect(entry.efforts).toEqual(["low", "medium", "high", "xhigh"]); expect(entry.effort).toBe("low");
    const updates: string[] = [];
    const unsubscribe = app.registry.subscribe(() => {
      const telemetry = app.registry.details(id)?.telemetry;
      if (telemetry?.model === "reasoner") updates.push(telemetry.effort!);
    });

    expectOk(await app.registry.selectModel(id, conversation, model, "high")); unsubscribe();
    expect(updates).toEqual(["high"]); expect(app.requested).toEqual([]);
    expect(app.registry.details(other)!.telemetry?.effort).toBe("off");
    expectOk(await app.registry.prompt(id, "First request"));
    const file = app.registry.sessionFile(id)!;
    const changes = (text: string) => text.split("\n").filter(line => line.includes('"type":"model_change"')).length;
    const before = changes(await readFile(file, "utf8"));
    expectOk(await app.registry.selectModel(id, conversation, model, "low"));
    expect(changes(await readFile(file, "utf8"))).toBe(before);
    expectOk(await app.registry.prompt(id, "Second request"));

    // Effort persists in SDK requests and resumed sessions without changing new-session defaults.
    expect(app.efforts).toEqual(["high", "low"]);
    const record = app.registry.records.find(record => record.id === id)!;
    expectOk(await app.registry.close(id)); expectOk(await app.registry.restore(record));
    expect(app.registry.details(id)!.telemetry?.effort).toBe("low");
    const fresh = expectOk(await app.registry.create(app.tree.id)); expect(app.registry.details(fresh)!.telemetry?.effort).toBe("off");
  } finally { await app.close(); }
});

test("Concurrent reads see the previous model/effort pair during SDK model replacement", async () => {
  // Pause between SDK model replacement and explicit effort application to simulate another reader.
  const app = await mount(), switched = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const original = AgentSession.prototype.setModel;
  const switching = spyOn(AgentSession.prototype, "setModel").mockImplementation(async function (this: AgentSession, model, options) {
    await original.call(this, model, options);
    if (model.provider === "other-fixture" && model.id === "reasoner") { switched.resolve(); await release.promise; }
  });
  try {
    const id = expectOk(await app.registry.create(app.tree.id)), conversation = app.registry.details(id)!.conversationId!;
    const pending = app.registry.selectModel(id, conversation, { provider: "other-fixture", id: "reasoner" }, "high"); await switched.promise;

    // Other sessions and direct snapshot/catalog queries must not expose uncommitted combinations.
    expect(app.registry.details(id)!.telemetry?.model).toBe("fixture"); expect(app.registry.details(id)!.telemetry?.effort).toBe("off");
    const during = expectOk(await app.registry.models(id, conversation));
    expect(during.current?.provider).toBe("radian-offline"); expect(during.effort).toBe("off");
    release.resolve(); expectOk(await pending);

    expect(app.registry.details(id)!.telemetry?.model).toBe("reasoner"); expect(app.registry.details(id)!.telemetry?.effort).toBe("high");
  } finally { release.resolve(); switching.mockRestore(); await app.close(); }
});

test("Unsupported effort is rejected before changing the model and preserves the original pair", async () => {
  const app = await mount();
  try {
    const id = expectOk(await app.registry.create(app.tree.id)), conversation = app.registry.details(id)!.conversationId!;

    const rejected = await app.registry.selectModel(id, conversation, { provider: "other-fixture", id: "fixture" }, "high");

    expect(expectError(rejected).code).toBe("INVALID_INPUT");
    expect(app.registry.details(id)!.telemetry?.provider).toBe("radian-offline");
    expect(app.registry.details(id)!.telemetry?.effort).toBe("off"); expect(app.requested).toEqual([]);
  } finally { await app.close(); }
});

test("Effort persistence failure distinguishes live application from persistence warnings", async () => {
  const app = await mount();
  const original = SessionManager.prototype.appendThinkingLevelChange;
  const saved = spyOn(SessionManager.prototype, "appendThinkingLevelChange").mockImplementation(function (this: SessionManager, level) {
    if (level === "high") throw new StorageError("Fixture thinking persistence failed", "ENOSPC");
    return original.call(this, level);
  });
  try {
    const id = expectOk(await app.registry.create(app.tree.id)), conversation = app.registry.details(id)!.conversationId!;

    const warning = expectOk(await app.registry.selectModel(id, conversation, { provider: "other-fixture", id: "reasoner" }, "high"));

    expect(warning).toContain("STORAGE_FAILED");
    expect(app.registry.details(id)!.telemetry?.model).toBe("reasoner"); expect(app.registry.details(id)!.telemetry?.effort).toBe("high");
  } finally { saved.mockRestore(); await app.close(); }
});

test("SDK persistence failures after model application warn without claiming rollback", async () => {
  const app = await mount();
  const original = SessionManager.prototype.appendModelChange;
  const saved = spyOn(SessionManager.prototype, "appendModelChange").mockImplementation(function (this: SessionManager, provider, modelId) {
    if (provider === "other-fixture") throw new StorageError("Fixture write failed", "ENOSPC");
    return original.call(this, provider, modelId);
  });
  try {
    const id = expectOk(await app.registry.create(app.tree.id)), conversation = app.registry.details(id)!.conversationId!;

    // Keep the SDK-applied live model as accepted and report persistence warnings separately.
    const warning = expectOk(await app.registry.selectModel(id, conversation, { provider: "other-fixture", id: "fixture" }));
    expect(warning).toContain("STORAGE_FAILED");
    expect(app.registry.details(id)!.telemetry?.provider).toBe("other-fixture");
  } finally { saved.mockRestore(); await app.close(); }
});

test("Model SDK programming errors propagate unchanged instead of becoming authentication errors", async () => {
  const app = await mount();
  const defect = new TypeError("Fixture SDK programming defect");
  const lookup = spyOn(app.runtime, "getAvailable");
  try {
    const id = expectOk(await app.registry.create(app.tree.id)), conversation = app.registry.details(id)!.conversationId!;
    lookup.mockRejectedValueOnce(defect);

    await expect(app.registry.selectModel(id, conversation, { provider: "other-fixture", id: "fixture" })).rejects.toBe(defect);
    expect(app.registry.details(id)!.telemetry?.provider).toBe("radian-offline");
    expectOk(await app.registry.selectModel(id, conversation, { provider: "other-fixture", id: "fixture" }));
  } finally { lookup.mockRestore(); await app.close(); }
});

test("Busy, invalid, or replaced-conversation model selections preserve active runs and other conversations", async () => {
  const app = await mount();
  try {
    const id = expectOk(await app.registry.create(app.tree.id)), conversation = app.registry.details(id)!.conversationId!;
    expect(expectError(await app.registry.selectModel(id, "old-conversation", { provider: "other-fixture", id: "fixture" })).code).toBe("SESSION_CONFLICT");
    expect(expectError(await app.registry.models(id, "old-conversation")).code).toBe("SESSION_CONFLICT");
    expect(expectError(await app.registry.selectModel(id, conversation, { provider: "other-fixture", id: "missing" })).code).toBe("MODEL_UNAVAILABLE");
    const cancelled = new AbortController(); cancelled.abort();
    expect(expectError(await app.registry.models(id, conversation, cancelled.signal)).code).toBe("CANCELLED");
    const accepted = Promise.withResolvers<void>();
    const run = app.registry.prompt(id, "slow", () => accepted.resolve()); await accepted.promise;

    // Reject selection while busy so the original request continues with its model.
    expect(expectError(await app.registry.selectModel(id, conversation, { provider: "other-fixture", id: "fixture" })).code).toBe("SESSION_BUSY");
    expect(app.registry.details(id)!.status).toBe("working"); expect(app.registry.details(id)!.telemetry?.provider).toBe("radian-offline");
    expectOk(await app.registry.interrupt(id)); await run;
    expect(expectError(await app.registry.prompt(id, "/model")).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(app.requested).toEqual(["radian-offline/fixture"]);
  } finally { await app.close(); }
});
