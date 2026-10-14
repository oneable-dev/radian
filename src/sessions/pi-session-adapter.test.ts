import { expect, test } from "bun:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { offlineRuntime, fixtureMessage } from "../testing/offline-runtime.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { WorkspaceSelection } from "../workspace/selection.ts";
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
    expect((await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.type === "session")).toHaveLength(1);
  } finally { await app.cleanup(); }
});

test("실행 중인 SDK 세션의 추가 입력은 실패로 명시하고 다른 실행을 교체하지 않는다", async () => {
  // An active provider stream holds the current run open.
  const app = await sdkFixture(true);
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const running = app.registry.prompt(id, "hold A");
    await app.streams.waitFor("A");

    // No implicit steering/follow-up policy is invented for a second submission.
    expect(expectError(await app.registry.prompt(id, "read")).code).toBe("SESSION_BUSY");
    app.streams.gates.get("A")!.finish("original run completed");
    await running;

    // The original request remains the only request and completes normally.
    expect(app.streams.gates.size).toBe(1);
    expect(app.registry.details(id)?.status).toBe("complete");
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
