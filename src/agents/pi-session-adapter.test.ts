import { expect, spyOn, test } from "bun:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { offlineRuntime, fixtureMessage } from "../testing/offline-runtime.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { WorkspaceSelection } from "../app/workspace-selection.ts";
import { SessionRegistry, type SessionExecutor } from "./session-registry.ts";
import { piSessionFactory, type PiSessionOptions } from "./pi-session-adapter.ts";
import { runCompletionEntryType } from "./run-completion.ts";
import { summarizeRequest } from "./request-summary.ts";
import { expectOk, expectError } from "../testing/results.ts";
import { tinyPng } from "../testing/image.ts";
import { ok } from "../result.ts";

function controlledStreams(options: PiSessionOptions) {
  const gates = new Map<string, { aborted: boolean; abortReceived: Promise<void>; finish(text: string): void }>();
  const started = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const waitFor = (key: string) => {
    if (gates.has(key)) return Promise.resolve();
    const gate = started.get(key) ?? Promise.withResolvers<void>();
    started.set(key, gate); return gate.promise;
  };
  const base = options.streamFn!;
  const streamFn: NonNullable<PiSessionOptions["streamFn"]> = (model, context, request) => {
    const last = context.messages.at(-1);
    const user = context.messages.findLast((message) => message.role === "user");
    const input = last?.role !== "toolResult" && user?.role === "user" ? (typeof user.content === "string" ? user.content : user.content.filter((part) => part.type === "text").map((part) => part.text).join("")) : "";
    const key = input === "slow" ? "child" : input.startsWith("hold ") ? input.slice(5) : null;
    if (!key) return base(model, context, request);
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = fixtureMessage(model.api, model.provider, model.id);
    const aborted = Promise.withResolvers<void>();
    const gate = { aborted: false, abortReceived: aborted.promise, finish(text: string) {
      request?.signal?.removeEventListener("abort", cancel);
      message.content = [{ type: "text", text }];
      message.stopReason = gate.aborted ? "aborted" : "stop";
      if (gate.aborted) stream.push({ type: "error", reason: "aborted", error: message });
      else stream.push({ type: "done", reason: "stop", message });
      stream.end();
    } };
    const cancel = () => { gate.aborted = true; aborted.resolve(); };
    request?.signal?.addEventListener("abort", cancel, { once: true });
    if (request?.signal?.aborted) cancel();
    gates.set(key, gate);
    stream.push({ type: "start", partial: message });
    started.get(key)?.resolve();
    return stream;
  };
  return { gates, waitFor, streamFn, releaseAll() { for (const gate of gates.values()) gate.finish("fixture released"); } };
}

async function sdkFixture(controlled = false, configure?: (options: PiSessionOptions) => PiSessionOptions) {
  const fixture = await createWorktreeFixture();
  const options = await offlineRuntime(join(fixture.directory, "agent"));
  const streams = controlledStreams(options);
  const executors: SessionExecutor[] = [];
  const factoryOptions = { ...options, ...(controlled ? { streamFn: streams.streamFn } : {}) };
  const factory = piSessionFactory(configure?.(factoryOptions) ?? factoryOptions);
  const registry = new SessionRegistry([fixture.repository], async (context) => {
    const executor = await factory(context); executors.push(executor); return executor;
  });
  const selection = new WorkspaceSelection(registry.snapshot);
  const unsubscribe = registry.subscribe(() => selection.replaceSnapshot(registry.snapshot));
  const main = fixture.repository.worktrees.find((tree) => tree.path === fixture.main)!;
  const feature = fixture.repository.worktrees.find((tree) => tree.path === fixture.feature)!;
  return { ...fixture, registry, selection, executors, streams, main, feature, async cleanup() {
    // Signal cancellation before releasing provider acknowledgements to prevent new requests.
    const shutdown = registry.shutdown();
    streams.releaseAll();
    await shutdown; unsubscribe(); await fixture.cleanup();
  } };
}

async function commandExtension(directory: string) {
  const extensions = join(directory, "agent", "extensions"); await mkdir(extensions, { recursive: true });
  await writeFile(join(extensions, "commands.ts"), `export default function (pi) {
    pi.registerCommand("fixture-command", { description: "Fixture slash command", handler: async (args) => { pi.appendEntry("command-probe", { args }); } });
    pi.registerCommand("fixture-broken", { handler: async () => { throw new Error("Fixture command failure"); } });
    pi.registerCommand("fixture-wait", { handler: async (_args, ctx) => { await ctx.waitForIdle(); } });
  }`);
}

test("실제 SDK는 경로 라벨이 아닌 이미지 바이트를 사용자 메시지에 전달하고 저장한다", async () => {
  const observed: string[] = [];
  const app = await sdkFixture(false, (options) => ({ ...options, model: { ...options.model!, input: ["text", "image"] },
    streamFn: (model, context, request) => {
      const user = context.messages.findLast((message) => message.role === "user");
      if (user?.role === "user" && typeof user.content !== "string") observed.push(...user.content.flatMap((part) => part.type === "image" ? [part.data] : []));
      return options.streamFn!(model, context, request);
    } }));
  try {
    const path = join(app.directory, "image.png"); await writeFile(path, tinyPng());
    const id = expectOk(await app.registry.create(app.main.id));
    expectOk(await app.registry.prompt(id, "Inspect [Image #1]", undefined, [path]));

    expect(observed).toHaveLength(1); expect(Buffer.from(observed[0]!, "base64")).toEqual(tinyPng());
    const file = app.registry.sessionFile(id)!;
    const saved = await readFile(file, "utf8"); expect(saved).toContain('"type":"image"'); expect(saved).not.toContain(path);
    expect(app.registry.details(id)?.status).toBe("complete");
    expectOk(await app.registry.close(id)); const restored = expectOk(await app.registry.create(app.main.id, file));
    expect(app.registry.details(restored)?.sections?.some(section => section.kind === "user")).toBe(true);
    expect(observed).toHaveLength(1);
  } finally { await app.cleanup(); }
});

test("느린 이미지 준비 중에도 나중에 보낸 텍스트가 먼저 수락되거나 대화 순서를 바꾸지 않는다", async () => {
  const preparing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const admissions: string[] = [], contexts: string[][] = [];
  const app = await sdkFixture(false, (options) => ({ ...options, model: { ...options.model!, input: ["text", "image"] },
    imageLoader: async () => { preparing.resolve(); await release.promise; return ok([{ type: "image" as const, data: tinyPng().toString("base64"), mimeType: "image/png" }]); },
    streamFn: (model, context, request) => {
      contexts.push(context.messages.flatMap(message => message.role === "user" ? [typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("")] : []));
      return options.streamFn!(model, context, request);
    } }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const first = app.registry.prompt(id, "first image input", () => admissions.push("first"), ["/fixture/image.png"]); await preparing.promise;
    const second = app.registry.prompt(id, "later text input", () => admissions.push("second"));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(contexts).toEqual([]); expect(admissions).toEqual([]);
    release.resolve(); expectOk(await first); expectOk(await second);

    // SDK는 첫 모델 호출 전에 받은 steer를 함께 반영할 수 있다. 호출 횟수를
    // 강제하지 않고 수락과 실제 사용자 메시지의 순서가 보존되는지 확인한다.
    expect(admissions).toEqual(["first", "second"]);
    expect(app.registry.details(id)?.sections?.filter(section => section.kind === "user").map(section => section.text)).toEqual(["first image input[Image: image/png]", "later text input"]);
    expect(contexts.at(-1)).toEqual(["first image input", "later text input"]);
  } finally { release.resolve(); await app.cleanup(); }
});

test("이미지 steer도 현재 도구·응답을 중단하지 않고 같은 SDK 세션의 다음 입력으로 반영한다", async () => {
  const observed: string[] = [];
  const app = await sdkFixture(true, (options) => ({ ...options, model: { ...options.model!, input: ["text", "image"] },
    streamFn: (model, context, request) => {
      const user = context.messages.findLast((message) => message.role === "user");
      if (user?.role === "user" && typeof user.content !== "string") observed.push(...user.content.flatMap((part) => part.type === "image" ? [part.data] : []));
      return options.streamFn!(model, context, request);
    } }));
  try {
    const path = join(app.directory, "queued.png"); await writeFile(path, tinyPng());
    const id = expectOk(await app.registry.create(app.main.id));
    const first = app.registry.prompt(id, "hold A"); await app.streams.waitFor("A");
    const accepted = Promise.withResolvers<void>();
    const second = app.registry.prompt(id, "hold B", accepted.resolve, [path]); await accepted.promise;
    expect(app.streams.gates.get("A")!.aborted).toBe(false); expect(app.streams.gates.has("B")).toBe(false);
    app.streams.gates.get("A")!.finish("A finished"); await app.streams.waitFor("B");
    expect(observed).toHaveLength(1); expect(app.executors).toHaveLength(1);
    app.streams.gates.get("B")!.finish("B finished"); expectOk(await first); expectOk(await second);
    expect(app.registry.details(id)?.status).toBe("complete");
  } finally { await app.cleanup(); }
});

test("복원한 세션의 이미지 준비가 거절되면 기존 복구 경고와 저장된 출력은 사라지지 않는다", async () => {
  const app = await sdkFixture(false, (options) => ({ ...options, model: { ...options.model!, input: ["text", "image"] } }));
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const record = app.registry.records.find(item => item.id === id)!;
    expectOk(await app.registry.close(id));
    expectOk(await app.registry.restore({ ...record, state: { ...record.state, status: "working", output: record.state.output + "\nRetained host recovery output" } }));
    const before = app.registry.details(id); let accepted = 0;
    expect(expectError(await app.registry.prompt(id, "Inspect image", () => accepted++, [join(app.directory, "missing.png")])).code).toBe("STORAGE_FAILED");
    expect(accepted).toBe(0); expect(app.registry.details(id)?.error).toBe(before?.error);
    expect(app.registry.details(id)?.output).toBe(before?.output); expect(before?.output).toContain("Retained host recovery output");
  } finally { await app.cleanup(); }
});

test("이미지 미지원 모델과 첨부를 받지 않는 설정 명령은 수락 전에 거절하고 실행을 시작하지 않는다", async () => {
  const plain = await sdkFixture();
  try {
    const id = expectOk(await plain.registry.create(plain.main.id)); let accepted = 0;
    expect(expectError(await plain.registry.prompt(id, "Inspect image", () => accepted++, [join(plain.directory, "missing.png")])).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(accepted).toBe(0); expect(plain.registry.details(id)?.output).toBe("");
  } finally { await plain.cleanup(); }
  const app = await sdkFixture(false, (options) => ({ ...options, model: { ...options.model!, input: ["text", "image"] } }));
  try {
    await commandExtension(app.directory); const path = join(app.directory, "image.png"); await writeFile(path, tinyPng());
    const id = expectOk(await app.registry.create(app.main.id)); let accepted = 0;
    expect(expectError(await app.registry.prompt(id, "/fixture-command", () => accepted++, [path])).code).toBe("INVALID_INPUT");
    expect(accepted).toBe(0); expect(app.registry.details(id)?.output).toBe(""); expect(app.registry.details(id)?.status).toBeNull();
  } finally { await app.cleanup(); }
});

test("SDK 명령 목록 조회와 실행은 모델을 호출하지 않고 이전 실행 상태를 보존한다", async () => {
  const app = await sdkFixture();
  try {
    await commandExtension(app.directory);
    const id = expectOk(await app.registry.create(app.main.id));
    const items = expectOk(await app.registry.complete(id, { kind: "command", query: "fixture-command" })).items;
    expect(items.map((item) => [item.value, item.description])).toEqual([["fixture-command", "Fixture slash command"]]);
    let accepted = 0;
    expectOk(await app.registry.prompt(id, "/fixture-command argument", () => accepted++));
    expect(app.registry.details(id)?.status).toBeNull(); expect(app.registry.details(id)?.output).toBe(""); expect(accepted).toBe(1);
    expect(app.registry.details(id)?.sections?.some((section) => section.completion)).toBe(false);
    expectOk(await app.registry.prompt(id, "read"));
    const completed = app.registry.details(id)?.sections?.at(-1)?.completion;
    expectOk(await app.registry.prompt(id, "/fixture-command"));
    expect(app.registry.details(id)?.status).toBe("complete");
    expect(app.registry.details(id)?.sections?.at(-1)?.completion).toEqual(completed);
    expect(app.registry.details(id)?.sections?.filter((section) => section.completion)).toHaveLength(1);
  } finally { await app.cleanup(); }
});

test.each([true, false])("부가 완료 기록 저장 실패는 완료된 요청을 거절로 바꾸지 않고 경고로 구분한다: %j", async (expected) => {
  // 실제 모델·도구 처리가 끝난 뒤 부가 메타데이터의 저장 경계만 실패시킨다.
  const app = await sdkFixture();
  const original = SessionManager.prototype.appendCustomEntry;
  const failure = Object.assign(new Error("Timing persistence fixture"), expected ? { code: "EIO" } : {});
  const log = spyOn(console, "error").mockImplementation(() => {});
  const append = spyOn(SessionManager.prototype, "appendCustomEntry").mockImplementation(function (this: SessionManager, type, data) {
    if (type === runCompletionEntryType) throw failure;
    return original.call(this, type, data);
  });
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    expectOk(await app.registry.prompt(id, "read"));
    // 완료와 저장 경고를 분리하고 예상 밖 버그는 원래 오류 객체와 스택으로 기록한다.
    expect(app.registry.details(id)?.status).toBe("complete"); expect(app.registry.details(id)?.error).toBeNull();
    const completion = app.registry.details(id)?.sections?.at(-1)?.completion;
    expect(completion?.outcome).toBe("complete");
    expect(completion?.warning).toContain(expected ? "STORAGE_FAILED" : "Unexpected run timing persistence");
    if (expected) expect(log).not.toHaveBeenCalled();
    else expect(log.mock.calls.some((call) => call.includes(failure))).toBe(true);
  } finally { append.mockRestore(); log.mockRestore(); await app.cleanup(); }
});

test("SDK가 알림으로 보고한 명령 실패는 성공 수락으로 숨기지 않고 Result로 반환한다", async () => {
  const app = await sdkFixture(); const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    await commandExtension(app.directory); const id = expectOk(await app.registry.create(app.main.id));
    let accepted = false;
    const failure = expectError(await app.registry.prompt(id, "/fixture-broken", () => { accepted = true; }));
    expect(failure.code).toBe("AGENT_FAILED"); expect(failure.message).toContain("Fixture command failure");
    expect(accepted).toBe(false); expect(app.registry.details(id)?.status).toBeNull(); expect(log).not.toHaveBeenCalled();
  } finally { log.mockRestore(); await app.cleanup(); }
});

test("모델 완료를 기다리는 명령은 완료 상태를 working으로 되돌리지 않고 닫기에도 교착하지 않는다", async () => {
  const app = await sdkFixture(true);
  try {
    await commandExtension(app.directory); const id = expectOk(await app.registry.create(app.main.id));
    const run = app.registry.prompt(id, "hold A"); await app.streams.waitFor("A");
    const command = app.registry.prompt(id, "/fixture-wait");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    app.streams.gates.get("A")!.finish("finished");
    expectOk(await run); expectOk(await command); expect(app.registry.details(id)?.status).toBe("complete");

    const next = app.registry.prompt(id, "hold B"); await app.streams.waitFor("B");
    const waiting = app.registry.prompt(id, "/fixture-wait");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const close = app.registry.close(id); const gate = app.streams.gates.get("B")!;
    await gate.abortReceived; gate.finish("aborted");
    await Promise.all([next, waiting]); expectOk(await close); expect(app.registry.details(id)).toBeNull();
  } finally { await app.cleanup(); }
});

test("SDK 세션은 지정한 agentDir의 확장을 발견하고 등록된 도구를 실행한다", async () => {
  // Isolate extension discovery from the user's packages, credentials and external services.
  const app = await sdkFixture(false, (options) => ({ ...options, streamFn: (model, context, request) => {
    if (context.messages.at(-1)?.role !== "user") return options.streamFn!(model, context, request);
    const stream = createAssistantMessageEventStream();
    const message = fixtureMessage(model.api, model.provider, model.id);
    message.content = [{ type: "toolCall", id: "extension-probe", name: "extension_probe", arguments: {} }];
    message.stopReason = "toolUse";
    stream.push({ type: "done", reason: "toolUse", message }); stream.end(); return stream;
  } }));
  try {
    const directory = join(app.directory, "agent", "extensions");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "probe.ts"), `
      import { Type } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
      export default function (pi) {
        pi.registerTool({ name: "extension_probe", label: "Extension probe", description: "Isolated extension probe",
          parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "EXTENSION_PROBE_OK" }], details: {} }) });
      }
    `);

    const id = expectOk(await app.registry.create(app.main.id));
    expectOk(await app.registry.prompt(id, "run extension probe"));

    const tool = app.registry.details(id)?.sections?.find((section) => section.kind === "tool" && section.title === "extension_probe");
    expect(tool?.status).toBe("complete"); expect(tool?.text).toContain("EXTENSION_PROBE_OK");
  } finally { await app.cleanup(); }
});

test("Fast 명령은 모델 호출 없이 처리되고 native Codex HTTP 요청에 priority를 실제로 적용·제거한다", async () => {
  // A loopback SSE server exercises the real provider encoder without a paid model or user credentials.
  const bodies: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const bytes = Buffer.from(await request.arrayBuffer());
    const json = request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes;
    const body = JSON.parse(json.toString("utf8")) as Record<string, unknown>; bodies.push(body);
    const message = { id: "msg-fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Native fixture response", annotations: [] }] };
    const response = { id: `resp-${bodies.length}`, status: "completed", model: "native-fixture", output: [message],
      service_tier: body.service_tier ?? "default", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
    const events = [{ type: "response.created", response: { id: response.id, status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Native fixture response" },
      { type: "response.output_item.done", output_index: 0, item: message }, { type: "response.completed", response }];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  } });
  const app = await sdkFixture(false, (options) => {
    const modelRuntime = options.modelRuntime!;
    const apiKey = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
    modelRuntime.registerProvider("native-fast-fixture", { api: "openai-codex-responses", apiKey, baseUrl: server.url.origin,
      models: [{ id: "native-fixture", name: "Native fixture", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
    const configured: PiSessionOptions = { ...options, model: modelRuntime.getModel("native-fast-fixture", "native-fixture")!,
      settings: { transport: "sse", defaultThinkingLevel: "high", retry: { enabled: false }, compaction: { enabled: false } } };
    delete configured.streamFn;
    return configured;
  });
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    expect(app.registry.details(id)?.telemetry?.fast).toBe(false);
    expectOk(await app.registry.prompt(id, "/fast on")); expect(bodies).toHaveLength(0);

    expectOk(await app.registry.prompt(id, "priority fixture request"));

    expect(bodies[0]?.service_tier).toBe("priority"); expect(bodies[0]?.reasoning).toMatchObject({ effort: "high" });
    expect(app.registry.details(id)?.telemetry?.fast).toBe(true);
    expectOk(await app.registry.prompt(id, "/fast off")); expect(bodies).toHaveLength(1);
    expect(app.registry.details(id)?.telemetry?.fast).toBe(false);
    expectOk(await app.registry.prompt(id, "standard fixture request"));
    expect(bodies).toHaveLength(2); expect(bodies[1]).not.toHaveProperty("service_tier");
    expect(bodies[1]?.reasoning).toMatchObject({ effort: "high" });
  } finally { await app.cleanup(); await server.stop(true); }
});

test("실제 SDK read/write는 선택한 워크트리의 cwd를 사용하며 다른 워크트리를 변경하지 않는다", async () => {
  // Real Git worktrees and SDK built-in tools are used; only model responses are scripted.
  const app = await sdkFixture();
  try {
    const a = expectOk(await app.registry.create(app.main.id));
    const b = expectOk(await app.registry.create(app.feature.id));
    const originalCwd = process.cwd();

    // Concurrent prompts route identical relative paths to different workspace handles.
    await Promise.all([app.registry.prompt(a, "read"), app.registry.prompt(b, "read")]);
    app.selection.selectSession(app.feature.id, b);
    await app.registry.prompt(b, "write");

    // Repository discovery, tool cwd and process cwd remain independent of display selection.
    expect(app.registry.details(a)?.output).toContain("main-worktree-marker");
    expect(app.registry.details(b)?.output).toContain("feature-worktree-marker");
    expect(await Bun.file(join(app.feature.path, "radian-probe.txt")).text()).toBe("Offline SDK write probe\n");
    expect(await Bun.file(join(app.main.path, "radian-probe.txt")).exists()).toBe(false);
    expect(process.cwd()).toBe(originalCwd);
    expect(app.registry.details(a)?.status).toBe("complete");
    const read = app.registry.details(a)?.sections?.find((section) => section.kind === "tool" && section.title === "read");
    expect(read?.status).toBe("complete");
    expect(read?.text).toContain("main-worktree-marker");
    expect(read?.text).toContain("Arguments:");
    expect(app.registry.details(a)?.sections?.some((section) => section.kind === "user")).toBe(true);
  } finally { await app.cleanup(); }
});

test("실제 SDK 실행 두 개가 워크트리 전환 중 유지되고 비선택 결과가 마지막 선택으로 복원된다", async () => {
  // Provider completion is held explicitly, so switching cannot accidentally occur after work ended.
  const app = await sdkFixture(true);
  try {
    const a = expectOk(await app.registry.create(app.main.id));
    const b = expectOk(await app.registry.create(app.feature.id));
    const runA = app.registry.prompt(a, "hold A");
    const runB = app.registry.prompt(b, "hold B");
    await Promise.all([app.streams.waitFor("A"), app.streams.waitFor("B")]);

    // A continues on its original SDK handle while B is the visible workspace.
    app.selection.selectSession(app.feature.id, b);
    expect(app.registry.details(a)?.status).toBe("working");
    app.streams.gates.get("A")!.finish("A finished in the background");
    await runA;
    expect(app.selection.sessionId).toBe(b);
    app.selection.selectWorktree(app.main.id);

    // Returning restores A without an abort, replacement, or a second provider request.
    expect(app.selection.sessionId).toBe(a);
    expect(app.registry.details(a)?.output).toContain("A finished in the background");
    expect(app.streams.gates.get("A")!.aborted).toBe(false);
    expect(app.streams.gates.get("B")!.aborted).toBe(false);
    expect(app.executors).toHaveLength(2);
    app.streams.gates.get("B")!.finish("B done");
    await runB;
  } finally { await app.cleanup(); }
});

test("실제 SDK 부모와 subagent는 즉시 숨겨지고 백그라운드 종료되며 다른 세션은 계속 실행한다", async () => {
  // The registered custom tool starts an actual owned SDK child, not a display-only fixture.
  const app = await sdkFixture(true);
  try {
    const parent = expectOk(await app.registry.create(app.main.id));
    const other = expectOk(await app.registry.create(app.feature.id));
    const delegating = app.registry.prompt(parent, "delegate");
    const unrelated = app.registry.prompt(other, "hold B");
    await Promise.all([app.streams.waitFor("child"), app.streams.waitFor("B")]);
    expect(app.registry.snapshot[0]!.worktrees[0]!.sessions[0]!.subagents).toHaveLength(1);
    const file = app.registry.sessionFile(parent)!;
    expect(expectError(await app.registry.create(app.main.id, app.executors[2]!.sessionFile!)).code).toBe("SESSION_CONFLICT");

    // UI removal is synchronous, while the child deliberately delays its cancellation acknowledgement.
    const closing = app.registry.close(parent);
    expect(app.registry.details(parent)).toBeNull();
    expect(app.registry.closingCount).toBe(1);
    await app.streams.gates.get("child")!.abortReceived;
    expect(expectError(await app.registry.create(app.main.id, file)).code).toBe("SESSION_CONFLICT");
    expect(app.streams.gates.get("B")!.aborted).toBe(false);
    app.streams.gates.get("child")!.finish("child cancelled");
    const [closed, cancelled] = await Promise.all([closing, delegating]);
    expectOk(closed);
    expect(expectError(cancelled).code).toBe("CANCELLED");

    // Cleanup completes for the owned family, preserves history, and leaves B untouched.
    expect(app.registry.closingCount).toBe(0);
    expect(await Bun.file(file).exists()).toBe(true);
    expect(app.registry.details(other)?.status).toBe("working");
    app.streams.gates.get("B")!.finish("B complete");
    await unrelated;
  } finally { await app.cleanup(); }
});

test("닫은 SDK 세션을 다시 열면 동일 저장 ID와 대화 기록을 복원하고 fork하지 않는다", async () => {
  // A finalized user/assistant exchange has been persisted in an isolated session directory.
  const app = await sdkFixture();
  try {
    const original = expectOk(await app.registry.create(app.main.id));
    await app.registry.prompt(original, "read");
    const file = app.registry.sessionFile(original)!;
    const completion = app.registry.details(original)?.sections?.at(-1)?.completion;
    expect(completion?.outcome).toBe("complete"); expect(completion?.durationMs).toBeGreaterThanOrEqual(0);
    const saved = SessionManager.open(file), savedId = saved.getSessionId();
    expect(saved.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === runCompletionEntryType)).toMatchObject({ data: completion });
    expect(JSON.stringify(saved.buildSessionContext().messages)).not.toContain(runCompletionEntryType);

    // Close and reopen use a new display ID but the original persisted session file.
    await app.registry.close(original);
    const reopened = expectOk(await app.registry.create(app.main.id, file));

    // SDK restoration, not transcript copying, reconstructs the conversation.
    expect(reopened).not.toBe(original);
    expect(app.registry.sessionFile(reopened)).toBe(file);
    expect(app.executors.at(-1)!.savedSessionId).toBe(savedId);
    expect(app.registry.details(reopened)?.output).toContain("main-worktree-marker");
    expect(app.registry.details(reopened)?.sections?.at(-1)?.completion).toEqual(completion);
    expect(app.registry.details(reopened)?.sections?.find((section) => section.kind === "tool")?.text).toContain("main-worktree-marker");
    expect((await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.type === "session")).toHaveLength(1);
  } finally { await app.cleanup(); }
});

test("실행 중 SDK 입력은 현재 응답 뒤에 대기하고 세션을 교체하지 않는다", async () => {
  // Hold the real provider response so admission cannot be confused with completion.
  const app = await sdkFixture(true);
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const running = app.registry.prompt(id, "hold A");
    await app.streams.waitFor("A");
    const accepted = Promise.withResolvers<void>();

    // Pi queues B without aborting A or waiting for A's completion to acknowledge it.
    expectOk(await app.registry.prompt(id, "hold B", accepted.resolve));
    await accepted.promise;
    expect(app.streams.gates.has("B")).toBe(false);
    expect(app.registry.details(id)?.status).toBe("working");
    expect(app.streams.gates.get("A")!.aborted).toBe(false);
    app.streams.gates.get("A")!.finish("A complete");
    await app.streams.waitFor("B");
    expect(app.registry.details(id)?.status).toBe("working");
    expect(app.registry.details(id)?.sections?.some((section) => section.completion)).toBe(false);
    app.streams.gates.get("B")!.finish("B complete");
    expectOk(await running);

    // Both turns belong to the original SDK session and settle only after B.
    expect(app.executors).toHaveLength(1);
    expect(app.registry.details(id)?.output).toContain("B complete");
    expect(app.registry.details(id)?.status).toBe("complete");
    expect(app.registry.details(id)?.sections?.filter((section) => section.completion)).toHaveLength(1);
  } finally { await app.cleanup(); }
});

test("중단은 세션을 유지하고 대기 입력 전체를 줄바꿈으로 합쳐 한 번만 전달한다", async () => {
  // Hold A so neither queued message can be delivered before the interrupt.
  const app = await sdkFixture(true);
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const running = app.registry.prompt(id, "hold A"); await app.streams.waitFor("A");
    expectOk(await app.registry.prompt(id, "second")); expectOk(await app.registry.prompt(id, "third"));
    expect(app.registry.details(id)?.pendingMessages?.map((message) => message.text)).toEqual(["second", "third"]);
    expect(app.registry.details(id)?.runTiming?.elapsedMs).toBeGreaterThanOrEqual(0);

    // Repeated Esc coalesces while the provider is still acknowledging cancellation.
    const settled = Promise.withResolvers<void>();
    const unsubscribe = app.registry.subscribe(() => { if (app.registry.details(id)?.status === "complete") settled.resolve(); });
    const interrupt = app.registry.interrupt(id), repeated = app.registry.interrupt(id);
    await app.streams.gates.get("A")!.abortReceived;
    expect(app.registry.details(id)?.pendingMessages?.map((message) => message.text)).toEqual(["second", "third"]);
    app.streams.gates.get("A")!.finish("interrupted");
    expectOk(await interrupt); expectOk(await repeated); expect(expectError(await running).code).toBe("CANCELLED");
    await settled.promise; unsubscribe();

    // Only delivered input is persisted; the two queue entries become one user message.
    const messages = SessionManager.open(app.registry.sessionFile(id)!).getBranch().flatMap((entry) => entry.type === "message" && entry.message.role === "user"
      ? [typeof entry.message.content === "string" ? entry.message.content : entry.message.content.filter((part) => part.type === "text").map((part) => part.text).join("")] : []);
    expect(messages).toEqual(["hold A", "second\nthird"]);
    expect(app.executors).toHaveLength(1); expect(app.registry.details(id)?.pendingMessages).toEqual([]);
    expectOk(await app.registry.prompt(id, "continue in the same conversation"));
  } finally { await app.cleanup(); }
});

test("대기 입력을 합쳐 재전달해도 이미지 바이트와 중복 입력 순서를 보존한다", async () => {
  // Two equal texts still represent two accepted messages, each with its own image.
  const app = await sdkFixture(true, (options) => ({ ...options, model: { ...options.model!, input: ["text", "image"] } }));
  try {
    const id = expectOk(await app.registry.create(app.main.id)), path = join(app.directory, "queued.png");
    await writeFile(path, tinyPng());
    const running = app.registry.prompt(id, "hold A"); await app.streams.waitFor("A");
    expectOk(await app.registry.prompt(id, "same", undefined, [path])); expectOk(await app.registry.prompt(id, "same", undefined, [path]));
    expect(app.registry.details(id)?.pendingMessages).toEqual([summarizeRequest("same", 1), summarizeRequest("same", 1)]);
    const settled = Promise.withResolvers<void>();
    const unsubscribe = app.registry.subscribe(() => { if (app.registry.details(id)?.status === "complete") settled.resolve(); });

    const interrupted = app.registry.interrupt(id); await app.streams.gates.get("A")!.abortReceived;
    app.streams.gates.get("A")!.finish("cancelled"); expectOk(await interrupted); await running; await settled.promise; unsubscribe();

    const users = SessionManager.open(app.registry.sessionFile(id)!).getBranch().flatMap((entry) => entry.type === "message" && entry.message.role === "user" ? [entry.message] : []);
    const last = users.at(-1)!;
    expect(users).toHaveLength(2);
    expect(typeof last.content === "string" ? last.content : last.content.filter((part) => part.type === "text").map((part) => part.text).join("")).toBe("same\nsame");
    expect(typeof last.content === "string" ? [] : last.content.filter((part) => part.type === "image").map((part) => part.data)).toEqual([tinyPng().toString("base64"), tinyPng().toString("base64")]);
  } finally { await app.cleanup(); }
});

test("중단은 수동 compact도 취소하고 기존 대화와 세션을 보존한다", async () => {
  // Only the summary request waits; ordinary conversation uses the real offline SDK path.
  let summarizing = false;
  const started = Promise.withResolvers<void>();
  const app = await sdkFixture(false, (options) => ({ ...options,
    settings: { compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 128 } },
    streamFn: (model, context, request) => {
      if (!summarizing) return options.streamFn!(model, context, request);
      const stream = createAssistantMessageEventStream(), message = fixtureMessage(model.api, model.provider, model.id);
      const cancel = () => { message.stopReason = "aborted"; stream.push({ type: "error", reason: "aborted", error: message }); stream.end(); };
      if (request?.signal?.aborted) cancel();
      else request?.signal?.addEventListener("abort", cancel, { once: true });
      started.resolve();
      return stream;
    },
  }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    expectOk(await app.registry.prompt(id, "first")); expectOk(await app.registry.prompt(id, "second"));
    const before = app.registry.details(id)!; summarizing = true;
    const compact = app.registry.compact(id); await started.promise;

    expectOk(await app.registry.interrupt(id));

    expect(expectError(await compact).code).toBe("CANCELLED");
    expect(app.registry.details(id)?.sections?.at(-1)).toMatchObject({ title: "Compaction cancelled", status: "cancelled" });
    expect(app.registry.details(id)?.conversationId).toBe(before.conversationId); expect(app.registry.details(id)?.runTiming).toBeUndefined();
    expect(app.registry.details(id)?.sections?.slice(0, before.sections!.length)).toEqual([...before.sections!]);
    summarizing = false; expectOk(await app.registry.prompt(id, "continue"));
  } finally { await app.cleanup(); }
});

test("중단 전에 준비 중이던 미수락 이미지 입력은 뒤늦게 실행하지 않는다", async () => {
  // Image decoding is an SDK/OS boundary that can finish after the user presses Esc.
  const loading = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const app = await sdkFixture(true, (options) => ({ ...options, model: { ...options.model!, input: ["text", "image"] },
    imageLoader: async () => { loading.resolve(); await release.promise; return ok([]); },
  }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const running = app.registry.prompt(id, "hold A"); await app.streams.waitFor("A");
    let accepted = false;
    const preparing = app.registry.prompt(id, "Late image input", () => { accepted = true; }, ["/fixture/image.png"]);
    await loading.promise;

    const interrupted = app.registry.interrupt(id); await app.streams.gates.get("A")!.abortReceived;
    release.resolve(); app.streams.gates.get("A")!.finish("cancelled"); expectOk(await interrupted);

    expect(expectError(await preparing).code).toBe("CANCELLED"); expect(accepted).toBe(false); await running;
    expect(app.registry.details(id)?.pendingMessages).toEqual([]); expect(app.registry.details(id)?.output).not.toContain("Late image input");
  } finally { release.resolve(); await app.cleanup(); }
});

test("중단은 소유한 서브에이전트의 취소 확인도 기다리고 부모 세션은 닫지 않는다", async () => {
  const app = await sdkFixture(true);
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const running = app.registry.prompt(id, "delegate"); await app.streams.waitFor("child");

    const interrupted = app.registry.interrupt(id); await app.streams.gates.get("child")!.abortReceived;
    app.streams.gates.get("child")!.finish("cancelled child"); expectOk(await interrupted);

    expect(expectError(await running).code).toBe("CANCELLED");
    expect(app.registry.details(id)).not.toBeNull(); expect(app.registry.closingCount).toBe(0);
    expectOk(await app.registry.prompt(id, "Continue after cancellation"));
  } finally { await app.cleanup(); }
});

test("대기 입력 없는 중단은 선택한 실행만 취소하고 다른 탭은 유지한다", async () => {
  // Two independent sessions prove this is not runtime shutdown or session close.
  const app = await sdkFixture(true);
  try {
    const a = expectOk(await app.registry.create(app.main.id)), b = expectOk(await app.registry.create(app.main.id));
    const first = app.registry.prompt(a, "hold A"), second = app.registry.prompt(b, "hold B");
    await Promise.all([app.streams.waitFor("A"), app.streams.waitFor("B")]);

    const interrupt = app.registry.interrupt(a); await app.streams.gates.get("A")!.abortReceived;
    app.streams.gates.get("A")!.finish("cancelled"); expectOk(await interrupt);

    expect(expectError(await first).code).toBe("CANCELLED"); expect(app.streams.gates.get("B")!.aborted).toBe(false);
    expect(app.registry.snapshot[0]?.worktrees.find((tree) => tree.id === app.main.id)?.sessions).toHaveLength(2);
    expect(app.registry.details(a)?.runTiming).toBeUndefined();
    app.streams.gates.get("B")!.finish("finished"); expectOk(await second);
  } finally { await app.cleanup(); }
});

test("동시에 보낸 SDK 입력은 수락 경계를 직렬화하고 실제 대기열 순서를 보존한다", async () => {
  // Startup includes asynchronous SDK preflight; no stream is active at invocation time.
  const app = await sdkFixture();
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const admissions = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];

    // Concurrent callers must not create three overlapping initial runs.
    const runs = ["A", "B", "C"].map((name, i) => app.registry.prompt(id, `hold ${name}`, admissions[i]!.resolve));
    await Promise.all(admissions.map((item) => item.promise));
    for (const result of await Promise.all(runs)) expectOk(result);

    // Early steering may join the initial request; finalized user-message order is authoritative.
    const messages = SessionManager.open(app.registry.sessionFile(id)!).getBranch().flatMap((entry) => {
      if (entry.type !== "message" || entry.message.role !== "user") return [];
      const content = entry.message.content;
      return [typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("")];
    });
    expect(messages).toEqual(["hold A", "hold B", "hold C"]);
    expect(app.executors).toHaveLength(1);
  } finally { await app.cleanup(); }
});

test("SDK 자동 재시도 사이의 agent_end는 완료로 표시하지 않고 최종 settled 결과만 반영한다", async () => {
  // The first scripted response is retryable; the second remains held until explicitly released.
  let requests = 0;
  const app = await sdkFixture(true, (options) => ({
    ...options, settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 } },
    streamFn: (model, context, request) => {
      if (++requests !== 1) return options.streamFn!(model, context, request);
      const stream = createAssistantMessageEventStream();
      const error = fixtureMessage(model.api, model.provider, model.id);
      error.stopReason = "error"; error.errorMessage = "429 Too Many Requests";
      stream.push({ type: "error", reason: "error", error }); stream.end();
      return stream;
    },
  }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const observed: (string | null)[] = [];
    const unsubscribe = app.registry.subscribe(() => { observed.push(app.registry.details(id)?.status ?? null); });

    // Pi performs the retry; radian does not implement a second retry engine.
    const running = app.registry.prompt(id, "hold Retry");
    await app.streams.waitFor("Retry");
    expect(requests).toBe(2);
    expect(observed).not.toContain("complete");
    expect(app.registry.details(id)?.status).toBe("working");
    expect(app.registry.details(id)?.sections?.some((section) => section.completion)).toBe(false);
    app.streams.gates.get("Retry")!.finish("retry succeeded");
    await running; unsubscribe();

    // Completion appears only once Pi settles the successful recovery.
    expect(app.registry.details(id)?.status).toBe("complete");
    expect(app.registry.details(id)?.error).toBeNull();
    expect(app.registry.details(id)?.sections?.filter((section) => section.completion)).toHaveLength(1);
  } finally { await app.cleanup(); }
});

test.each(["close", "interrupt"] as const)("실제 SDK bash 작업은 %s 시 취소되고 소속 shell 프로세스가 남지 않는다", async (operation) => {
  // The only spawned shell and filesystem changes belong to an isolated test worktree.
  const app = await sdkFixture(false, (options) => ({
    ...options, streamFn: (model, context, request) => {
      const last = context.messages.at(-1);
      if (last?.role !== "user") return options.streamFn!(model, context, request);
      const stream = createAssistantMessageEventStream();
      const message = fixtureMessage(model.api, model.provider, model.id);
      message.stopReason = "toolUse";
      message.content.push({ type: "toolCall", id: crypto.randomUUID(), name: "bash", arguments: {
        command: "echo $$ > .bash-probe.pid; echo BASH_STARTED; while :; do sleep 1; done",
      } });
      stream.push({ type: "done", reason: "toolUse", message }); stream.end(); return stream;
    },
  }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const started = Promise.withResolvers<void>();
    const unsubscribe = app.registry.subscribe(() => {
      if (app.registry.details(id)?.output.includes("BASH_STARTED")) started.resolve();
    });

    // Await the actual SDK tool update, not a guessed process-start delay.
    const running = app.registry.prompt(id, "bash probe");
    await started.promise; unsubscribe();
    const pid = Number.parseInt(await readFile(join(app.main.path, ".bash-probe.pid"), "utf8"), 10);
    expect(process.kill(pid, 0)).toBe(true);
    const [stopped] = await Promise.all([app.registry[operation](id), running]); expectOk(stopped);

    // Abort propagation and tool completion include process cleanup before control resolves.
    expect(() => process.kill(pid, 0)).toThrow();
    expect(app.registry.closingCount).toBe(0);
    if (operation === "interrupt") expect(app.registry.details(id)).not.toBeNull();
  } finally { await app.cleanup(); }
});

test("별도 sessionDir를 지정하지 않아도 SDK 기록은 지정한 agentDir 내부에 저장된다", async () => {
  // Default SDK session-directory selection must not escape into the user's global history.
  const app = await sdkFixture(false, (options) => {
    const scoped = { ...options }; delete scoped.sessionDir; return scoped;
  });
  try {
    const id = expectOk(await app.registry.create(app.main.id));

    // The SDK chooses its own cwd-encoded directory under the explicit agent directory.
    await app.registry.prompt(id, "read");

    // No hand-written encoding or accidental global SessionManager default is used.
    expect(app.registry.sessionFile(id)?.startsWith(join(app.directory, "agent", "sessions") + "/")).toBe(true);
  } finally { await app.cleanup(); }
});

test("SDK가 보고한 최종 provider 실패는 AgentRunError Result이며 취소와 구분된다", async () => {
  // The SDK reports a terminal provider failure through its actual event contract, not a thrown bug.
  const app = await sdkFixture(false, (options) => ({ ...options, streamFn: (model) => {
    const stream = createAssistantMessageEventStream();
    const message = fixtureMessage(model.api, model.provider, model.id);
    message.stopReason = "error"; message.errorMessage = "Provider rejected this test request";
    stream.push({ type: "error", reason: "error", error: message }); stream.end(); return stream;
  } }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));

    // A settled failed run produces an explicit domain value instead of a generic rejection.
    const result = await app.registry.prompt(id, "fixture request");

    expect(expectError(result).code).toBe("AGENT_FAILED");
    expect(app.registry.details(id)?.status).toBe("failure");
    expect(app.registry.details(id)?.error).toBe("Provider rejected this test request");
  } finally { await app.cleanup(); }
});

test("자동 압축은 전용 활동을 알리고 압축 종료 시 일반 실행으로 복귀한 뒤 한 번만 완료한다", async () => {
  // 낮은 압축 임계값으로 실제 SDK의 threshold 압축을 유도하고 요약 provider만 잠시 멈춘다.
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const app = await sdkFixture(false, (options) => ({ ...options,
    settings: { compaction: { enabled: true, keepRecentTokens: 0, reserveTokens: 199900 } },
    streamFn: async (model, context, request) => {
      const first = context.messages[0];
      const system = first?.role === "system" ? typeof first.content === "string" ? first.content : first.content.map((part) => part.text).join("") : "";
      if (system.startsWith("You are a context summarization assistant.")) { started.resolve(); await release.promise; }
      return options.streamFn!(model, context, request);
    },
  }));
  let unsubscribe = () => {};
  const resumed: boolean[] = [];
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const pending = app.registry.prompt(id, "Preserve the implementation plan. ".repeat(500));
    await Promise.race([started.promise, pending.then((result) => { expectOk(result); throw new Error("SDK run ended without entering compaction."); })]);
    expect(app.registry.details(id)).toMatchObject({ status: "working", activity: "compacting" });
    unsubscribe = app.registry.subscribe(() => { const state = app.registry.details(id); resumed.push(state?.status === "working" && !("activity" in state)); });

    // SDK의 compaction_end 시점에는 isCompacting이 아직 true일 수 있어도 UI 활동은 끝나야 한다.
    release.resolve(); expectOk(await pending);

    expect(resumed).toContain(true); expect(app.registry.details(id)).not.toHaveProperty("activity");
    expect(app.registry.details(id)?.status).toBe("complete");
    expect(app.registry.details(id)?.sections?.filter((section) => section.completion)).toHaveLength(1);
  } finally { release.resolve(); unsubscribe(); await app.cleanup(); }
});

test.each(["complete", "error"] as const)("수동 압축의 전체 수명 동안 전용 활동을 유지하고 %s 종료 후 제거한다", async (outcome) => {
  // 실제 SDK 요약 스트림만 멈춰 두어 압축 중 상태를 확정적으로 관찰한다.
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let summarizing = false;
  const app = await sdkFixture(false, (options) => ({ ...options,
    settings: { compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 128 } },
    streamFn: async (model, context, request) => {
      if (!summarizing) return options.streamFn!(model, context, request);
      started.resolve(); await release.promise;
      const stream = createAssistantMessageEventStream(), message = fixtureMessage(model.api, model.provider, model.id);
      message.content = [{ type: "text", text: "Retain the fixture implementation plan" }];
      if (outcome === "complete") { message.stopReason = "stop"; stream.push({ type: "done", reason: "stop", message }); }
      else {
        message.stopReason = "error"; message.errorMessage = "Offline compaction fixture";
        stream.push({ type: "error", reason: message.stopReason, error: message });
      }
      stream.end(); return stream;
    },
  }));
  const observed: string[] = [];
  let unsubscribe = () => {};
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    expectOk(await app.registry.prompt(id, "first request")); expectOk(await app.registry.prompt(id, "second request"));
    const before = app.registry.details(id)!;
    unsubscribe = app.registry.subscribe(() => { const state = app.registry.details(id); if (state?.status === "working") observed.push("activity" in state ? String(state.activity) : "missing"); });
    summarizing = true;

    // 명령 수락부터 SDK의 종료 이벤트까지 이전 요청의 Working on 상태로 되돌아가면 안 된다.
    const pending = app.registry.compact(id);
    await Promise.race([started.promise, pending.then((result) => { expectOk(result); throw new Error("SDK compaction ended before the summary provider started."); })]);
    expect(app.registry.details(id)).toMatchObject({ status: "working", activity: "compacting", conversationId: before.conversationId });
    release.resolve(); const result = await pending;

    if (outcome === "complete") expectOk(result);
    else expect(expectError(result).code).toBe("AGENT_FAILED");
    expect(observed.length).toBeGreaterThan(0); expect(observed.every((activity) => activity === "compacting")).toBe(true);
    expect(app.registry.details(id)).not.toHaveProperty("activity"); expect(app.registry.details(id)?.status).toBe(before.status);
    expect(app.registry.details(id)?.sections?.slice(0, before.sections!.length)).toEqual([...before.sections!]);
  } finally { release.resolve(); unsubscribe(); await app.cleanup(); }
});

test("수동 압축은 실제 SDK 요약을 저장하면서 대화·요청 ID와 같은 탭을 보존한다", async () => {
  // A small retained tail makes this offline conversation eligible without a paid model call.
  const requests: string[] = [];
  const app = await sdkFixture(false, (options) => ({ ...options,
    settings: { compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 128 } },
    streamFn: (model, context, request) => { requests.push(JSON.stringify(context.messages)); return options.streamFn!(model, context, request); },
  }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    expectOk(await app.registry.prompt(id, "Keep the current implementation plan"));
    expectOk(await app.registry.prompt(id, "Continue the fixture work"));
    const before = app.registry.details(id)!, file = app.registry.sessionFile(id)!, calls = requests.length;
    let accepted = 0;
    const commands = expectOk(await app.registry.complete(id, { kind: "command", query: "" })).items;
    expect(commands.map((item) => item.value)).toEqual(expect.arrayContaining(["new", "compact"]));

    // Instructions go to SDK summarization, never into a new user/model turn.
    expectOk(await app.registry.compact(id, "Preserve the implementation plan", () => accepted++));

    expect(accepted).toBe(1); expect(requests.length).toBeGreaterThan(calls);
    expect(requests.slice(calls).join("\n")).toContain("Preserve the implementation plan");
    const after = app.registry.details(id)!;
    expect(after.conversationId).toBe(before.conversationId); expect(app.registry.sessionFile(id)).toBe(file);
    expect(after.sections?.slice(0, before.sections!.length)).toEqual([...before.sections!]);
    expect(after.sections?.at(-1)?.title).toBe("Context compacted"); expect(after.status).toBe("complete");
    expect(SessionManager.open(file).getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
    expect(app.selection.worktree?.sessions.map((session) => session.id)).toEqual([id]);
  } finally { await app.cleanup(); }
});

test("빈 세션과 너무 작은 대화의 수동 압축은 모델 호출 없이 입력 오류로 거부한다", async () => {
  let calls = 0;
  const app = await sdkFixture(false, (options) => ({ ...options, streamFn: (model, context, request) => {
    calls++; return options.streamFn!(model, context, request);
  } }));
  try {
    const id = expectOk(await app.registry.create(app.main.id)); let accepted = 0;
    expect(expectError(await app.registry.compact(id, undefined, () => accepted++)).code).toBe("INVALID_INPUT");
    expect(calls).toBe(0);
    expectOk(await app.registry.prompt(id, "tiny fixture")); const before = calls;

    expect(expectError(await app.registry.compact(id, undefined, () => accepted++)).code).toBe("INVALID_INPUT");

    expect(calls).toBe(before); expect(accepted).toBe(0); expect(app.registry.details(id)?.status).toBe("complete");
  } finally { await app.cleanup(); }
});

test("실행 중 수동 압축은 원래 모델 실행을 중단하거나 입력을 대기열에 넣지 않는다", async () => {
  // Hold a real SDK response so refusal can be distinguished from abort-and-restart.
  const app = await sdkFixture(true);
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const run = app.registry.prompt(id, "hold compact-busy"); await app.streams.waitFor("compact-busy");

    expect(expectError(await app.registry.compact(id)).code).toBe("SESSION_BUSY");

    expect(app.streams.gates.get("compact-busy")!.aborted).toBe(false);
    app.streams.gates.get("compact-busy")!.finish("original result"); expectOk(await run);
    expect(app.registry.details(id)?.sections?.some((section) => section.text === "original result")).toBe(true);
  } finally { await app.cleanup(); }
});

test("압축 모델의 실패는 기존 대화를 유지하고 수락된 명령의 대화 안에 기록한다", async () => {
  let failSummary = false;
  const app = await sdkFixture(false, (options) => ({ ...options,
    settings: { compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 128 } },
    streamFn: (model, context, request) => {
      if (!failSummary) return options.streamFn!(model, context, request);
      const stream = createAssistantMessageEventStream(), message = fixtureMessage(model.api, model.provider, model.id);
      message.stopReason = "error"; message.errorMessage = "Offline summary rejected";
      stream.push({ type: "error", reason: "error", error: message }); stream.end(); return stream;
    },
  }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    expectOk(await app.registry.prompt(id, "first")); expectOk(await app.registry.prompt(id, "second"));
    const before = app.registry.details(id)!; let accepted = 0; failSummary = true;

    const result = await app.registry.compact(id, undefined, () => accepted++);

    expect(expectError(result).code).toBe("AGENT_FAILED"); expect(accepted).toBe(1);
    expect(app.registry.details(id)?.sections?.slice(0, before.sections!.length)).toEqual([...before.sections!]);
    expect(app.registry.details(id)?.sections?.at(-1)).toMatchObject({ title: "Compaction failed", status: "error" });
    expect(app.registry.details(id)?.sections?.at(-1)?.text).toContain("Offline summary rejected");
    expect(SessionManager.open(app.registry.sessionFile(id)!).getBranch().some((entry) => entry.type === "compaction")).toBe(false);
    expect(app.registry.details(id)?.status).toBe("complete");
  } finally { await app.cleanup(); }
});

test("압축 중 프로그래밍 결함은 일반 입력 오류로 바꾸지 않고 같은 예외로 전파한다", async () => {
  let broken = false;
  const defect = new TypeError("Offline compaction defect", { cause: new Error("Original cause") });
  const app = await sdkFixture(false, (options) => ({ ...options,
    settings: { compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 128 } },
    streamFn: (model, context, request) => { if (broken) throw defect; return options.streamFn!(model, context, request); },
  }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    expectOk(await app.registry.prompt(id, "first")); expectOk(await app.registry.prompt(id, "second")); broken = true;

    await expect(app.registry.compact(id)).rejects.toBe(defect);

    expect(app.registry.details(id)?.status).toBe("failure");
    expect(app.registry.details(id)?.error).toContain("Unexpected compaction failure");
  } finally { await app.cleanup(); }
});

test("new는 현재 탭의 실행을 중단·저장한 뒤 같은 위치의 새 대화로 바꾸고 다른 탭을 유지한다", async () => {
  const app = await sdkFixture(true);
  try {
    const id = expectOk(await app.registry.create(app.main.id)), other = expectOk(await app.registry.create(app.main.id));
    const first = app.registry.prompt(id, "hold previous-conversation"); await app.streams.waitFor("previous-conversation");
    const second = app.registry.prompt(other, "hold other-tab"); await app.streams.waitFor("other-tab");
    const conversation = app.registry.details(id)!.conversationId, oldFile = app.registry.sessionFile(id)!;
    app.selection.selectSession(app.main.id, id);
    const accepted = Promise.withResolvers<void>();

    const replacement = app.registry.newSession(id, () => accepted.resolve()); await accepted.promise;
    await app.streams.gates.get("previous-conversation")!.abortReceived;
    expect(expectError(await app.registry.prompt(id, "during replacement")).code).toBe("SESSION_BUSY");
    app.streams.gates.get("previous-conversation")!.finish("persisted cancellation");
    expect(expectError(await first).code).toBe("CANCELLED"); expectOk(await replacement);

    expect(app.selection.sessionId).toBe(id); expect(app.selection.worktree?.sessions.map((session) => session.id)).toEqual([id, other]);
    expect(app.registry.details(id)?.conversationId).not.toBe(conversation); expect(app.registry.details(id)?.sections).toEqual([]);
    expect(app.registry.sessionFile(id)).not.toBe(oldFile);
    expect(app.registry.historyOwnership(oldFile)).toEqual({ openSessionId: null, unavailableReason: null });
    expect(SessionManager.open(oldFile).getBranch().some((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "aborted")).toBe(true);
    expect(app.streams.gates.get("other-tab")!.aborted).toBe(false);
    app.streams.gates.get("other-tab")!.finish("unrelated tab result"); expectOk(await second);
    expectOk(await app.registry.prompt(id, "fresh conversation"));
    expect(app.registry.details(id)?.sections?.some((section) => section.text === "hold previous-conversation")).toBe(false);
  } finally { await app.cleanup(); }
});

test("new는 현재 탭 소유의 하위 작업도 정리하고 원래 대화에서 취소 결과를 저장한다", async () => {
  const app = await sdkFixture(true);
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const run = app.registry.prompt(id, "delegate"); await app.streams.waitFor("child");
    const accepted = Promise.withResolvers<void>();

    const replacement = app.registry.newSession(id, () => accepted.resolve()); await accepted.promise;
    await app.streams.gates.get("child")!.abortReceived;
    app.streams.gates.get("child")!.finish("cancelled owned child");
    await run; expectOk(await replacement);

    expect(app.registry.records[0]?.subagents).toEqual([]); expect(app.registry.details(id)?.sections).toEqual([]);
    expect(app.executors).toHaveLength(3);
  } finally { await app.cleanup(); }
});

test("new는 확장의 전환 취소를 존중하고 진행 중인 모델을 중단하지 않는다", async () => {
  const app = await sdkFixture(true);
  try {
    const extensions = join(app.directory, "agent", "extensions"); await mkdir(extensions, { recursive: true });
    await writeFile(join(extensions, "cancel-new.ts"), `export default (pi) => {
      pi.on("session_before_switch", (event) => event.reason === "new" ? { cancel: true } : undefined);
    };`);
    const id = expectOk(await app.registry.create(app.main.id));
    const run = app.registry.prompt(id, "hold cancelled-new"); await app.streams.waitFor("cancelled-new");
    const conversation = app.registry.details(id)!.conversationId; let accepted = false;

    const result = await app.registry.newSession(id, () => { accepted = true; });

    expect(expectError(result).code).toBe("CANCELLED"); expect(accepted).toBe(false);
    expect(app.registry.details(id)?.conversationId).toBe(conversation); expect(app.executors).toHaveLength(1);
    expect(app.streams.gates.get("cancelled-new")!.aborted).toBe(false);
    app.streams.gates.get("cancelled-new")!.finish("continued original"); expectOk(await run);
  } finally { await app.cleanup(); }
});

test("new의 SDK 시작·종료 훅은 startup이나 quit가 아니라 세션 교체 이유를 받는다", async () => {
  const app = await sdkFixture();
  try {
    const extensions = join(app.directory, "agent", "extensions"); await mkdir(extensions, { recursive: true });
    await writeFile(join(extensions, "lifecycle.ts"), `export default (pi) => {
      pi.on("session_start", (event) => { pi.appendEntry("start-reason", event); });
      pi.on("session_shutdown", (event) => { pi.appendEntry("shutdown-reason", event); });
    };`);
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "original work"));
    const oldFile = app.registry.sessionFile(id)!;

    expectOk(await app.registry.newSession(id));

    const oldEntries = SessionManager.open(oldFile).getBranch();
    // Pi buffers an empty conversation's metadata until its first actual turn.
    expectOk(await app.registry.prompt(id, "first fresh conversation turn"));
    const newEntries = SessionManager.open(app.registry.sessionFile(id)!).getBranch();
    expect(oldEntries.filter((entry) => entry.type === "custom" && entry.customType === "shutdown-reason").map((entry) => entry.type === "custom" ? entry.data : null)).toEqual([{ type: "session_shutdown", reason: "new" }]);
    expect(newEntries.filter((entry) => entry.type === "custom" && entry.customType === "start-reason").map((entry) => entry.type === "custom" ? entry.data : null)).toEqual([{ type: "session_start", reason: "new", previousSessionFile: oldFile }]);
  } finally { await app.cleanup(); }
});
