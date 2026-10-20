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
  // 모델 선택은 실제 SDK를 사용하되 모델 응답만 로컬 픽스처로 대체한다.
  const { model: _model, ...rest } = options;
  const registry = new SessionRegistry([fixture.repository], piSessionFactory({ ...rest,
    settings: { defaultProvider: "radian-offline", defaultModel: "fixture" },
    streamFn: (model, context, request) => { requested.push(`${model.provider}/${model.id}`); efforts.push(request?.reasoning); return base(model, context, request); } }));
  const tree = fixture.repository.worktrees.find(tree => tree.path === fixture.main)!;
  return { ...fixture, registry, tree, requested, efforts, runtime, async close() { await registry.shutdown(); await fixture.cleanup(); } };
}

test("model 명령은 팝업 명령으로만 인식하고 인수를 모델 프롬프트로 보내지 않는다", () => {
  // 모델 이름 인수나 유사 명령은 팝업 명령과 명확히 구분한다.
  expect(expectOk(parseModelCommand("/model"))).toBe(true);
  expect(expectOk(parseModelCommand("/model \n"))).toBe(true);
  expect(expectOk(parseModelCommand("/models"))).toBe(false);
  expect(expectError(parseModelCommand("/model provider/model")).code).toBe("INVALID_INPUT");
});

test("선택한 모델은 현재 SDK 세션의 다음 요청·메타데이터·재개 기록에 반영되고 다른 세션과 기본값은 유지된다", async () => {
  const app = await mount();
  try {
    const id = expectOk(await app.registry.create(app.tree.id)), other = expectOk(await app.registry.create(app.tree.id));
    const conversation = app.registry.details(id)!.conversationId!;
    const catalog = expectOk(await app.registry.models(id, conversation));
    expect(catalog.current).toEqual({ provider: "radian-offline", id: "fixture" });
    expect(catalog.models.some(model => model.provider === "other-fixture" && model.id === "fixture")).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain("PRIVATE_FIXTURE_KEY"); expect(JSON.stringify(catalog)).not.toContain("127.0.0.1");
    expect(expectOk(await app.registry.complete(id, { kind: "command", query: "model" })).items.some(item => item.value === "model")).toBe(true);

    // 같은 ID라도 provider가 다른 모델을 현재 세션에만 적용한다.
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

test("모델과 effort는 최종 조합만 발행하며 effort만 바꿔도 다음 요청과 재개 기록에 적용된다", async () => {
  // SDK 자동 보정은 low를 거치지만 호스트에는 사용자가 고른 high만 보여야 한다.
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

    // effort는 실제 SDK 요청과 복구된 세션에 남고 새 세션의 기본값은 바뀌지 않는다.
    expect(app.efforts).toEqual(["high", "low"]);
    const record = app.registry.records.find(record => record.id === id)!;
    expectOk(await app.registry.close(id)); expectOk(await app.registry.restore(record));
    expect(app.registry.details(id)!.telemetry?.effort).toBe("low");
    const fresh = expectOk(await app.registry.create(app.tree.id)); expect(app.registry.details(fresh)!.telemetry?.effort).toBe("off");
  } finally { await app.close(); }
});

test("SDK 모델 교체가 진행 중일 때 별도 조회도 중간 effort가 아닌 이전 조합을 읽는다", async () => {
  // SDK 모델 교체와 명시적 effort 적용 사이를 지연시켜 다른 클라이언트의 조회를 재현한다.
  const app = await mount(), switched = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const original = AgentSession.prototype.setModel;
  const switching = spyOn(AgentSession.prototype, "setModel").mockImplementation(async function (this: AgentSession, model, options) {
    await original.call(this, model, options);
    if (model.provider === "other-fixture" && model.id === "reasoner") { switched.resolve(); await release.promise; }
  });
  try {
    const id = expectOk(await app.registry.create(app.tree.id)), conversation = app.registry.details(id)!.conversationId!;
    const pending = app.registry.selectModel(id, conversation, { provider: "other-fixture", id: "reasoner" }, "high"); await switched.promise;

    // 다른 세션의 갱신이나 직접 snapshot/catalog 조회도 아직 적용되지 않은 조합을 내보내면 안 된다.
    expect(app.registry.details(id)!.telemetry?.model).toBe("fixture"); expect(app.registry.details(id)!.telemetry?.effort).toBe("off");
    const during = expectOk(await app.registry.models(id, conversation));
    expect(during.current?.provider).toBe("radian-offline"); expect(during.effort).toBe("off");
    release.resolve(); expectOk(await pending);

    expect(app.registry.details(id)!.telemetry?.model).toBe("reasoner"); expect(app.registry.details(id)!.telemetry?.effort).toBe("high");
  } finally { release.resolve(); switching.mockRestore(); await app.close(); }
});

test("지원하지 않는 effort는 모델을 바꾸기 전에 거절하고 원래 조합을 보존한다", async () => {
  const app = await mount();
  try {
    const id = expectOk(await app.registry.create(app.tree.id)), conversation = app.registry.details(id)!.conversationId!;

    const rejected = await app.registry.selectModel(id, conversation, { provider: "other-fixture", id: "fixture" }, "high");

    expect(expectError(rejected).code).toBe("INVALID_INPUT");
    expect(app.registry.details(id)!.telemetry?.provider).toBe("radian-offline");
    expect(app.registry.details(id)!.telemetry?.effort).toBe("off"); expect(app.requested).toEqual([]);
  } finally { await app.close(); }
});

test("effort 기록 저장이 실패해도 라이브 모델·effort 적용을 성공과 저장 경고로 구분한다", async () => {
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

test("SDK가 모델 적용 뒤 기록 저장에 실패하면 적용된 모델을 되돌렸다고 보고하지 않고 경고한다", async () => {
  const app = await mount();
  const original = SessionManager.prototype.appendModelChange;
  const saved = spyOn(SessionManager.prototype, "appendModelChange").mockImplementation(function (this: SessionManager, provider, modelId) {
    if (provider === "other-fixture") throw new StorageError("Fixture write failed", "ENOSPC");
    return original.call(this, provider, modelId);
  });
  try {
    const id = expectOk(await app.registry.create(app.tree.id)), conversation = app.registry.details(id)!.conversationId!;

    // SDK가 먼저 바꾼 라이브 모델은 수락된 결과로 유지하고 저장 경고를 별도로 전달한다.
    const warning = expectOk(await app.registry.selectModel(id, conversation, { provider: "other-fixture", id: "fixture" }));
    expect(warning).toContain("STORAGE_FAILED");
    expect(app.registry.details(id)!.telemetry?.provider).toBe("other-fixture");
  } finally { saved.mockRestore(); await app.close(); }
});

test("모델 SDK의 프로그래밍 오류는 인증 오류로 숨기지 않고 원래 예외로 전달한다", async () => {
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

test("실행 중·잘못된 모델·교체된 대화의 모델 선택은 기존 실행을 중단하거나 다른 대화를 변경하지 않는다", async () => {
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

    // 실행 중에는 선택을 거절하고 원래 요청이 계속 같은 모델로 동작하게 한다.
    expect(expectError(await app.registry.selectModel(id, conversation, { provider: "other-fixture", id: "fixture" })).code).toBe("SESSION_BUSY");
    expect(app.registry.details(id)!.status).toBe("working"); expect(app.registry.details(id)!.telemetry?.provider).toBe("radian-offline");
    expectOk(await app.registry.interrupt(id)); await run;
    expect(expectError(await app.registry.prompt(id, "/model")).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(app.requested).toEqual(["radian-offline/fixture"]);
  } finally { await app.close(); }
});
