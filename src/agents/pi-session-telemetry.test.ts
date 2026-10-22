import { expect, spyOn, test } from "bun:test";
import { ManualClock } from "@opentui/core/testing";
import { UsageMonitor } from "../usage/monitor.ts";
import { err, ok } from "../result.ts";
import { UsageError } from "../errors.ts";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Api, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offlineRuntime, fixtureMessage } from "../testing/offline-runtime.ts";
import { expectOk, expectError } from "../testing/results.ts";
import { FastMode } from "./fast-mode.ts";
import { CommandDiagnostics } from "./session-commands.ts";
import { PiSessionExecutor } from "./pi-session-adapter.ts";

type Script = (request: SimpleStreamOptions | undefined, model: Model<Api>) => Promise<void>;
async function mount(script: Script, extensions: InlineExtension[] = [], usage?: UsageMonitor, fast?: FastMode) {
  const directory = await mkdtemp(join(tmpdir(), "radian-telemetry-"));
  const options = await offlineRuntime(directory);
  const modelRuntime = options.modelRuntime!;
  modelRuntime.registerProvider("telemetry-fixture", { api: "openai-codex-responses", baseUrl: "http://127.0.0.1:1", apiKey: "offline",
    models: [{ id: "model-fixture", name: "Telemetry fixture", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const model = modelRuntime.getModel("telemetry-fixture", "model-fixture")!;
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
    noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, extensionFactories: [...(fast ? [fast.extension] : []), ...extensions] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime, model, thinkingLevel: "high",
    settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(directory) });
  session.agent.streamFunction = async (model, _context, request) => {
    await script(request, model);
    const stream = createAssistantMessageEventStream();
    const message = fixtureMessage(model.api, model.provider, model.id);
    message.content = [{ type: "text", text: "Fixture completed without a network request." }];
    message.usage.input = 72000; message.usage.totalTokens = 72000;
    stream.push({ type: "done", reason: "stop", message }); stream.end(); return stream;
  };
  const diagnostics = new CommandDiagnostics();
  await session.bindExtensions({ onError: diagnostics.report });
  const original = { payload: session.agent.onPayload, response: session.agent.onResponse, event: session.agent.onProviderStreamEvent };
  const executor = new PiSessionExecutor(session, usage, diagnostics, fast);
  return { executor, session, original, async close() { expectOk(await executor.close()); await rm(directory, { recursive: true, force: true }); } };
}

const futureReset = () => Math.floor(Date.now() / 1000) + 3600;
const headers = (reset: number): Record<string, string> => ({ "x-codex-secondary-used-percent": "18", "x-codex-secondary-window-minutes": "10080",
  "x-codex-secondary-reset-at": String(reset) });

test("Fast는 모델 호출 전부터 off이며 명시적 명령만 상태와 실제 전송 tier를 바꾼다", async () => {
  const fast = new FastMode(); let requests = 0, outgoing: unknown;
  const app = await mount(async (request, model) => {
    requests++;
    outgoing = await request?.onPayload?.({ model: model.id, service_tier: "priority" }, model);
  }, [], undefined, fast);
  try {
    expect(app.executor.state.telemetry?.fast).toBe(false);
    expect(app.executor.commands().filter((command) => command.value === "fast")).toHaveLength(1);
    const before = app.session.messages.length;

    expectOk(await app.executor.prompt("/fast on"));
    expect(app.executor.state.telemetry?.fast).toBe(true); expect(requests).toBe(0); expect(app.session.messages).toHaveLength(before);
    expectOk(await app.executor.prompt("ordinary request"));
    expect(outgoing).toEqual({ model: "model-fixture", service_tier: "priority" });

    expectOk(await app.executor.prompt("/fast off"));
    expect(app.executor.state.telemetry?.fast).toBe(false); expect(requests).toBe(1);
    expectOk(await app.executor.prompt("ordinary standard request"));
    expect(outgoing).toEqual({ model: "model-fixture" }); expect(requests).toBe(2);
    expect(app.executor.state.telemetry?.effort).toBe("high");
  } finally { await app.close(); }
});

test.each([false, true])("이전 대화가 %s여도 Fast 명령은 중간 Working 상태나 새 모델 실행을 만들지 않는다", async seeded => {
  // Fast only changes request configuration, including before the first model turn.
  const fast = new FastMode(); let requests = 0;
  const app = await mount(async () => { requests++; }, [], undefined, fast);
  const statuses: ("working" | "complete" | "failure" | null)[] = [];
  let unsubscribe = () => {};
  try {
    if (seeded) expectOk(await app.executor.prompt("Previous actual request"));
    const expected = seeded ? "complete" : null, messages = app.session.messages.length;
    expect(app.executor.state.status).toBe(expected);
    unsubscribe = app.executor.subscribe(() => statuses.push(app.executor.state.status));

    // Observe every published snapshot, not only the restored state after command completion.
    for (const action of ["on", "off", "status"]) {
      statuses.length = 0;
      expectOk(await app.executor.prompt(`/fast ${action}`));

      expect(statuses.length).toBeGreaterThan(0);
      expect(statuses.every(status => status === expected)).toBe(true);
      expect(app.executor.state.status).toBe(expected);
      expect(app.executor.state.telemetry?.fast).toBe(action === "on");
      expect(requests).toBe(seeded ? 1 : 0); expect(app.session.messages).toHaveLength(messages);
      expect(app.executor.state.runTiming).toBeUndefined();
    }
  } finally { unsubscribe(); await app.close(); }
});

test("Fast 명령 검증은 요청을 보내지 않고 모델별·세션별 상태를 분리한다", async () => {
  const fast = new FastMode(); let requests = 0;
  const app = await mount(async () => { requests++; }, [], undefined, fast);
  const other = await mount(async () => { requests++; }, [], undefined, new FastMode());
  try {
    expect(expectError(fast.command("invalid", app.session.model)).code).toBe("INVALID_INPUT");
    expectOk(await app.executor.prompt("/fast on")); expect(app.executor.state.telemetry?.fast).toBe(true);
    expect(other.executor.state.telemetry?.fast).toBe(false);
    expect(fast.read({ ...app.session.model!, id: "another-model" })).toBe(false);
    const redirected = { model: "another-model" };
    expect(fast.apply(redirected, app.session.model!)).toBe(redirected);
    expect(expectError(fast.command("on", { ...app.session.model!, api: "openai-completions" })).code).toBe("UNSUPPORTED_CAPABILITY");
    expectOk(await app.executor.prompt("/fast status")); expect(requests).toBe(0);
  } finally { await app.close(); await other.close(); }
});

test("이미 설치된 /fast 확장은 Radian 기본 명령을 대체하고 기존 요청 변환을 유지한다", async () => {
  let handled = false;
  const app = await mount(async (request, model) => { await request?.onPayload?.({}, model); }, [(pi) => {
    pi.registerCommand("fast", { description: "Existing Fast control", handler: async () => { handled = true; } });
    pi.on("before_provider_request", () => ({ service_tier: "priority" }));
  }], undefined, new FastMode());
  try {
    expect(app.executor.commands().filter((command) => command.value === "fast")).toHaveLength(1);
    expect(app.executor.state.telemetry?.fast).toBeNull();
    expectOk(await app.executor.prompt("/fast on")); expect(handled).toBe(true);
    expectOk(await app.executor.prompt("ordinary request"));
    expect(app.executor.state.telemetry?.fast).toBe(true);
  } finally { await app.close(); }
});

test("기존 요청 훅의 null 대체 값도 원본 payload로 되돌리지 않는다", async () => {
  let outgoing: unknown = "not observed";
  const app = await mount(async (request, model) => { outgoing = await request?.onPayload?.({ model: model.id }, model); },
    [(pi) => { pi.on("before_provider_request", () => null); }], undefined, new FastMode());
  try {
    expectOk(await app.executor.prompt("/fast on"));

    expectOk(await app.executor.prompt("scripted request"));

    expect(outgoing).toBeNull();
  } finally { await app.close(); }
});

test("SDK 세션은 프롬프트 전에도 usage를 받고 작업이 최종 완료되면 다시 갱신한다", async () => {
  // A real SDK session observes an injected account source without making a model request for usage.
  const clock = new ManualClock(); let lookups = 0, prompts = 0;
  const usage = new UsageMonitor(async () => ok({ key: "private-account", provider: "acme", load: async () => {
    lookups++; return ok([{ id: "period", usedPercent: 10, periodMs: 604800000, resetsAt: 604800000 }]);
  } }), clock);
  const app = await mount(async () => { prompts++; }, [], usage);
  const settle = async () => { for (let i = 0; i < 70; i++) await Promise.resolve(); };
  try {
    expect(app.executor.state.telemetry?.usage?.status).toBe("loading"); await settle();
    expect(app.executor.state.telemetry?.usage?.windows[0]?.usedPercent).toBe(10);
    expect(prompts).toBe(0); expect(lookups).toBe(1);

    clock.advance(2500); expectOk(await app.executor.prompt("ordinary model request")); await settle();

    expect(prompts).toBe(1); expect(lookups).toBe(2);
  } finally { await app.close(); await usage.stop(); }
});

test.each(["인증", "사용량"] as const)("/reload만 %s backoff를 우회하고 작업 완료 갱신은 기존 대기를 지킨다", async stage => {
  // 실제 SDK 세션의 관리 명령과 작업 완료 이벤트가 서로 다른 갱신 정책을 사용해야 한다.
  const clock = new ManualClock(); let lookups = 0, prompts = 0;
  const succeeds = () => ++lookups > 1;
  const failure = err(new UsageError("USAGE_QUERY_FAILED", "Temporary failure"));
  const usage = new UsageMonitor(async () => stage === "인증" && !succeeds() ? failure
    : ok({ key: "account", provider: "fixture", load: async () => stage === "사용량" && !succeeds() ? failure
      : ok([{ id: "weekly", usedPercent: 42, periodMs: 604800000, resetsAt: 604800000 }]) }), clock, () => 0);
  const app = await mount(async () => { prompts++; }, [], usage);
  const settle = async () => { for (let i = 0; i < 70; i++) await Promise.resolve(); };
  try {
    expect(app.executor.state.telemetry?.usage?.status).toBe("loading"); await settle();
    expect(app.executor.state.telemetry?.usage?.status).toBe("error"); expect(lookups).toBe(1);

    // 같은 시각에 작업이 완료되어도 자동 갱신은 실패 대기를 우회하지 않는다.
    expectOk(await app.executor.prompt("ordinary work")); await settle(); expect(lookups).toBe(1);
    const before = app.session.messages.length;
    expectOk(await app.executor.reload()); await settle();

    // 리로드만 즉시 usage를 복구하며 추가 모델 요청이나 대화 메시지는 만들지 않는다.
    expect(lookups).toBe(2); expect(app.executor.state.telemetry?.usage?.status).toBe("ready");
    expect(app.executor.state.telemetry?.usage?.windows[0]?.usedPercent).toBe(42);
    expect(prompts).toBe(1); expect(app.session.messages).toHaveLength(before);
  } finally { await app.close(); await usage.stop(); }
});

test("SDK 모델·effort·컨텍스트를 전달하고 Fast를 임의로 활성화하지 않는다", async () => {
  // The real SDK supplies context accounting; only the provider boundary is scripted.
  const outgoing = { model: "model-fixture" };
  let sent: unknown;
  const app = await mount(async (request, model) => { sent = await request?.onPayload?.(outgoing, model); });
  try {
    expect(app.executor.state.telemetry?.fast).toBeNull();

    expectOk(await app.executor.prompt("observe metadata"));

    const telemetry = app.executor.state.telemetry!;
    expect(telemetry.model).toBe("model-fixture"); expect(telemetry.effort).toBe("high");
    expect(telemetry.context).toEqual({ usedTokens: 72000, maxTokens: 200000 });
    expect(telemetry.fast).toBe(false); expect(telemetry.weekly).toBeNull();
    expect(sent).toBe(outgoing); expect(outgoing).toEqual({ model: "model-fixture" });
  } finally { await app.close(); }
});

test("압축 직후에는 남은 컨텍스트만 로컬 추정하고 다음 정상 응답의 사용량으로 교체한다", async () => {
  // 압축 전 사용량과 삭제된 기록을 섞지 않고 시스템·요약·유지 메시지만 합산해야 한다.
  let requests = 0;
  const app = await mount(async () => { requests++; });
  const manager = app.session.sessionManager;
  try {
    manager.appendMessage({ role: "system", content: "s".repeat(800), timestamp: 0 });
    manager.appendMessage({ role: "user", content: "omitted".repeat(40000), timestamp: 1 });
    const kept = manager.appendMessage({ role: "user", content: [{ type: "text", text: "u".repeat(4000) },
      { type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 2 });
    const assistant = fixtureMessage("openai-codex-responses", "telemetry-fixture", "model-fixture");
    assistant.content = [{ type: "text", text: "a".repeat(400) }];
    assistant.usage.input = 72000; assistant.usage.totalTokens = 72000;
    manager.appendMessage(assistant);
    manager.appendCompaction("c".repeat(8000), kept, 72000);
    expect(app.session.getContextUsage()?.tokens).toBeNull();

    // SDK가 미확정 값을 반환해도 추가 모델 호출 없이 압축 후 크기를 제공한다.
    const context = app.executor.state.telemetry?.context;

    // 시스템 200 + 요약 2000 + 입력 1000 + 이미지 1200 + 답변 100 토큰이다.
    expect(context).toEqual({ usedTokens: 4500, maxTokens: 200000 });
    expect(requests).toBe(0);

    // 새 응답의 사용량이 확보되면 로컬 추정치나 압축 전 캐시를 유지하지 않는다.
    expectOk(await app.executor.prompt("Continue with measured usage"));
    expect(app.executor.state.telemetry?.context).toEqual({ usedTokens: 72000, maxTokens: 200000 });
    expect(requests).toBe(1);
  } finally { await app.close(); }
});

test("추정 컨텍스트는 반복 조회에서 캐시하고 확정 메시지·내용 수정·시스템 변경 때만 갱신한다", async () => {
  // 압축 이후 사용량을 받을 때까지 화면 갱신마다 전체 컨텍스트를 재구성하지 않아야 한다.
  const app = await mount(async () => {}), manager = app.session.sessionManager;
  manager.appendCompaction("c".repeat(400), null, 72000);
  const projection = spyOn(manager, "buildSessionProjection");
  try {
    expect(app.executor.state.telemetry?.context).toEqual({ usedTokens: 100, maxTokens: 200000 });
    const reads = projection.mock.calls.length;

    // 같은 대화 위치를 조회하는 스냅샷은 기존 추정치를 그대로 재사용한다.
    for (let i = 0; i < 50; i++) expect(app.executor.state.telemetry?.context?.usedTokens).toBe(100);
    expect(projection.mock.calls.length).toBe(reads);

    // 확정 입력과 append-only 수정은 새 대화 위치이므로 즉시 반영한다.
    const user = manager.appendMessage({ role: "user", content: "u".repeat(400), timestamp: 1 });
    expect(app.executor.state.telemetry?.context?.usedTokens).toBe(200);
    manager.appendContextEdit(user, { content: "u".repeat(800) });
    expect(app.executor.state.telemetry?.context?.usedTokens).toBe(300);

    // 시스템 패치는 이전 내용을 누적하지 않고 현재 유효한 프롬프트로 합산한다.
    manager.appendMessage({ role: "system", content: "", sections: { instruction: "s".repeat(400) }, timestamp: 2 });
    expect(app.executor.state.telemetry?.context?.usedTokens).toBe(400);
    manager.appendMessage({ role: "system", content: "", sections: { instruction: "s".repeat(800) }, timestamp: 3 });
    expect(app.executor.state.telemetry?.context?.usedTokens).toBe(500);
  } finally { projection.mockRestore(); await app.close(); }
});

test("실제 SDK 수동 압축이 완료되면 다음 요청 없이 컨텍스트 잔량을 다시 제공한다", async () => {
  // 공급자 경계만 오프라인으로 대체하고 SDK의 실제 압축·체크포인트 생성을 사용한다.
  const app = await mount(async () => {});
  try {
    app.session.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 128 } });
    expectOk(await app.executor.prompt("Compact this conversation"));

    // 수동 압축 직후 SDK 토큰 수는 null이지만 Radian은 현재 체크포인트를 추정한다.
    expectOk(await app.executor.compact());

    const context = app.executor.state.telemetry?.context;
    expect(app.session.getContextUsage()?.tokens).toBeNull();
    expect(context?.usedTokens).toBeGreaterThan(0);
    expect(context?.usedTokens).toBeLessThan(72000); expect(context?.maxTokens).toBe(200000);
    expect(app.executor.state.status).toBe("complete");
    expect(app.executor.state.sections?.at(-1)?.title).toBe("Context compacted");
  } finally { await app.close(); }
});

test("모델 한도가 없으면 압축 기록이 있어도 컨텍스트를 임의로 채우지 않는다", async () => {
  // SDK 모델이 미확정인 경우에는 추정 토큰이 있어도 잔여 비율의 분모를 만들 수 없다.
  const app = await mount(async () => {});
  app.session.sessionManager.appendCompaction("c".repeat(400), null, 72000);
  const usage = spyOn(app.session, "getContextUsage").mockReturnValue(undefined);
  try {
    // 모델 메타데이터가 없는 상태로 읽어도 100%나 임의의 총한도로 대체하지 않는다.
    const context = app.executor.state.telemetry?.context;

    expect(context).toBeNull();
  } finally { usage.mockRestore(); await app.close(); }
});

test("확장의 기존 요청 변환과 응답 관찰을 보존하면서 Fast와 weekly 헤더를 읽는다", async () => {
  // Priority comes from an existing extension, not the Radian status display.
  let responses = 0, events = 0, sent: unknown;
  const reset = futureReset();
  const outgoing = { model: "model-fixture" };
  const app = await mount(async (request, model) => {
    sent = await request?.onPayload?.(outgoing, model);
    await request?.onResponse?.({ status: 200, headers: headers(reset) }, model);
    await request?.onProviderStreamEvent?.({ type: "response.created" }, model);
  }, [(pi) => {
    pi.on("before_provider_request", (event) => ({ ...event.payload as object, service_tier: "priority" }));
    pi.on("after_provider_response", () => { responses++; });
    pi.on("provider_stream_event", () => { events++; });
  }]);
  try {
    expectOk(await app.executor.prompt("observe extension"));

    expect(sent).toEqual({ model: "model-fixture", service_tier: "priority" });
    expect(outgoing).toEqual({ model: "model-fixture" });
    expect(responses).toBe(1); expect(events).toBe(1);
    expect(app.executor.state.telemetry?.fast).toBe(true);
    expect(app.executor.state.telemetry?.weekly?.remainingPercent).toBe(82);
    expect(app.executor.state.telemetry?.weekly?.resetsAt).toBe(reset * 1000);
    expectOk(await app.executor.close());
    expect(app.session.agent.onPayload).toBe(app.original.payload);
    expect(app.session.agent.onResponse).toBe(app.original.response);
    expect(app.session.agent.onProviderStreamEvent).toBe(app.original.event);
  } finally { await app.close(); }
});

test("WebSocket 원본 quota 이벤트에서는 primary·secondary 순서가 아닌 기간으로 weekly를 찾는다", async () => {
  // A primary seven-day window and secondary five-hour window reverse the common ordering.
  const reset = futureReset();
  const app = await mount(async (request, model) => {
    await request?.onPayload?.({}, model);
    await request?.onProviderStreamEvent?.({ type: "codex.rate_limits", rate_limits: {
      primary: { used_percent: 36, window_minutes: 10080, reset_at: reset },
      secondary: { used_percent: 99, window_minutes: 300, reset_at: reset },
    } }, model);
  });
  try {
    expectOk(await app.executor.prompt("observe websocket quota"));

    expect(app.executor.state.telemetry?.weekly?.remainingPercent).toBe(64);
    expect(app.executor.state.telemetry?.weekly?.resetsAt).toBe(reset * 1000);
  } finally { await app.close(); }
});

test("누락·손상·만료된 quota는 이전 잔량이나 0%로 대체하지 않고 실행은 계속한다", async () => {
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

    for (const next of [{}, { ...headers(reset), "x-codex-secondary-used-percent": "NaN" },
      { ...headers(reset), "x-codex-secondary-used-percent": "101" },
      { ...headers(reset), "x-codex-secondary-used-percent": "-1" },
      { ...headers(reset), "x-codex-secondary-reset-at": String(Number.MAX_SAFE_INTEGER) },
      { ...headers(reset), "x-codex-secondary-window-minutes": "300" }, headers(Math.floor(Date.now() / 1000) - 1)]) {
      responseHeaders = next;
      expectOk(await app.executor.prompt("unknown quota"));

      expect(app.executor.state.telemetry?.weekly).toBeNull();
      expect(app.executor.state.status).toBe("complete");
    }
  } finally { await app.close(); }
});
