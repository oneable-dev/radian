import { expect, test } from "bun:test";
import { ManualClock } from "@opentui/core/testing";
import { UsageMonitor } from "../usage/monitor.ts";
import { ok } from "../result.ts";
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
