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
import { expectOk, expectError } from "../testing/results.ts";

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
    expectOk(await app.registry.prompt(id, "read"));
    expectOk(await app.registry.prompt(id, "/fixture-command"));
    expect(app.registry.details(id)?.status).toBe("complete");
  } finally { await app.cleanup(); }
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
    const savedId = SessionManager.open(file).getSessionId();

    // Close and reopen use a new display ID but the original persisted session file.
    await app.registry.close(original);
    const reopened = expectOk(await app.registry.create(app.main.id, file));

    // SDK restoration, not transcript copying, reconstructs the conversation.
    expect(reopened).not.toBe(original);
    expect(app.registry.sessionFile(reopened)).toBe(file);
    expect(app.executors.at(-1)!.savedSessionId).toBe(savedId);
    expect(app.registry.details(reopened)?.output).toContain("main-worktree-marker");
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
    app.streams.gates.get("B")!.finish("B complete");
    expectOk(await running);

    // Both turns belong to the original SDK session and settle only after B.
    expect(app.executors).toHaveLength(1);
    expect(app.registry.details(id)?.output).toContain("B complete");
    expect(app.registry.details(id)?.status).toBe("complete");
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
    app.streams.gates.get("Retry")!.finish("retry succeeded");
    await running; unsubscribe();

    // Completion appears only once Pi settles the successful recovery.
    expect(app.registry.details(id)?.status).toBe("complete");
    expect(app.registry.details(id)?.error).toBeNull();
  } finally { await app.cleanup(); }
});

test("실제 SDK bash 작업은 닫기 시 취소되고 소속 shell 프로세스가 남지 않는다", async () => {
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
    await Promise.all([app.registry.close(id), running]);

    // Abort propagation and tool completion include process cleanup before close resolves.
    expect(() => process.kill(pid, 0)).toThrow();
    expect(app.registry.closingCount).toBe(0);
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
