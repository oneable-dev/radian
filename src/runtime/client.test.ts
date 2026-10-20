import { expect, jest, spyOn, test } from "bun:test";
import { RuntimeClient } from "./client.ts";
import { emptyPreferences, maxFrameBytes, protocolVersion, type RuntimeSnapshot, type PtyFrame } from "./protocol.ts";
import { runtimePaths } from "./storage.ts";
import { expectError, expectOk } from "../testing/results.ts";

const paths = runtimePaths("/fixture/.git", true, "/tmp/radian-reconnect-unit-test");
const snapshot = (): RuntimeSnapshot => ({ version: protocolVersion, pid: process.pid, instance: "first", repositoryId: "/fixture/.git", mode: "offline",
  repositories: [], details: {}, closingCount: 0, preferences: structuredClone(emptyPreferences), notice: "", capabilities: ["history"] });
const encoder = new TextEncoder();
function stubFetch(implementation: (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(implementation, { preconnect: fetch.preconnect }));
}
async function settle(): Promise<void> { for (let i = 0; i < 40; i++) await Promise.resolve(); }
async function advance(milliseconds: number): Promise<void> { jest.advanceTimersByTime(milliseconds); await settle(); }

function events(value: unknown, signal?: AbortSignal | null, chunkBytes = Number.MAX_SAFE_INTEGER) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let open = true;
  const remove = () => { open = false; signal?.removeEventListener("abort", aborted); };
  const aborted = () => { if (open) { remove(); controller.error(signal?.reason); } };
  const enqueue = (value: unknown) => {
    const bytes = encoder.encode(JSON.stringify(value) + "\n");
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) controller.enqueue(bytes.subarray(offset, offset + chunkBytes));
  };
  const response = new Response(new ReadableStream<Uint8Array>({
    start(stream) {
      controller = stream;
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
      else if (value !== undefined) enqueue(value);
    },
    cancel: remove,
  }));
  return { response,
    frame(value: unknown) { if (open) enqueue(value); },
    end() { if (open) { remove(); controller.close(); } },
    fail(error: unknown) { if (open) { remove(); controller.error(error); } },
  };
}

test("여러 세션의 큰 상태가 8MiB를 넘어도 대화·초안·History 연결을 손상시키지 않는다", async () => {
  // 실제 장애처럼 각각은 작은 섹션들이 합쳐진 9MiB 이상의 상태를 조각내 전송한다.
  const large: RuntimeSnapshot = { ...snapshot(), preferences: { ...structuredClone(emptyPreferences), drafts: { unsent: "keep this draft" } },
    details: { conversation: { status: "working", output: "", error: null,
      sections: Array.from({ length: 2200 }, (_, index) => ({ id: `section-${index}`, kind: "assistant", title: "Agent", text: `${index}:한글👩🏽‍💻 ${"x".repeat(4096)}`, status: "complete" })) } } };
  expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(maxFrameBytes);
  const requests: string[] = [];
  const fetchMock = stubFetch(async (input, options) => {
    const path = new URL(String(input)).pathname; requests.push(path);
    return path === "/events" ? events(large, options?.signal, 65533).response : Response.json([]);
  });
  const client = new RuntimeClient(paths, snapshot());
  try {
    expectOk(await client.attach());
    expect(client.snapshot.details.conversation?.sections).toHaveLength(2200);
    expect(client.snapshot.details.conversation?.sections?.at(-1)?.text).toBe(large.details.conversation!.sections!.at(-1)!.text);
    expect(client.snapshot.preferences.drafts).toEqual({ unsent: "keep this draft" });
    expect(expectOk(await client.listHistory("worktree"))).toEqual([]); expect(client.connected).toBe(true);
    expect(client.snapshot.notice).toBe(""); expect(requests).toEqual(["/events", "/history"]);
  } finally { await client.disconnect(); fetchMock.mockRestore(); }
});

test("구버전의 new와 compact는 모델 프롬프트나 자동 재시작으로 우회하지 않는다", async () => {
  // The old service would treat an unknown slash command as paid model input.
  const fetchMock = stubFetch(async () => { throw new Error("Must not transmit unsupported session commands"); });
  const client = new RuntimeClient(paths, snapshot());
  try {
    for (const text of ["/new", "/compact", "/compact preserve this plan"]) {
      expect(expectError(await client.prompt("session", text)).code).toBe("UNSUPPORTED_CAPABILITY");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  } finally { await client.disconnect(); fetchMock.mockRestore(); }
});

test("중단은 capability와 현재 대화 ID를 확인하고 정확한 세션에만 전송한다", async () => {
  // An older service must not receive an unknown command or be restarted automatically.
  const details: Record<string, RuntimeSnapshot["details"][string]> = {};
  const state = { ...snapshot(), details }, sent: unknown[] = [];
  const fetchMock = stubFetch(async (_input, options) => { sent.push(JSON.parse(String(options?.body))); return Response.json({ ok: true, value: null }); });
  const client = new RuntimeClient(paths, state);
  try {
    expect(expectError(await client.interrupt("session")).code).toBe("UNSUPPORTED_CAPABILITY");
    state.capabilities = ["agent-interrupt"];
    expect(expectError(await client.interrupt("session")).code).toBe("PROTOCOL_ERROR");
    details.session = { conversationId: "conversation", status: "working", output: "", error: null };

    expectOk(await client.interrupt("session"));

    expect(sent).toEqual([{ type: "interrupt", sessionId: "session", conversationId: "conversation" }]);
  } finally { await client.disconnect(); fetchMock.mockRestore(); }
});

test("세션 명령과 일반 입력은 현재 대화 ID를 지정하고 첨부·잘못된 new는 전송하지 않는다", async () => {
  // A stable tab ID alone cannot fence an operation after /new replaces its conversation.
  const state: RuntimeSnapshot = { ...snapshot(), capabilities: ["session-controls", "prompt-images"],
    details: { session: { conversationId: "conversation-1", status: null, output: "", error: null } } };
  const sent: unknown[] = [];
  const fetchMock = stubFetch(async (_input, options) => { sent.push(JSON.parse(String(options?.body))); return Response.json({ ok: true, value: null }); });
  const client = new RuntimeClient(paths, state);
  try {
    expectOk(await client.prompt("session", "/compact keep the plan"));
    expectOk(await client.prompt("session", "/new"));
    expectOk(await client.prompt("session", "ordinary prompt"));
    expect(expectError(await client.prompt("session", "/new not supported")).code).toBe("INVALID_INPUT");
    expect(expectError(await client.prompt("session", "/new", ["/image.png"])).code).toBe("INVALID_INPUT");
    expect(expectError(await client.prompt("session", "/compact", ["/image.png"])).code).toBe("INVALID_INPUT");

    expect(sent).toEqual([
      { type: "session-control", sessionId: "session", conversationId: "conversation-1", action: "compact", instructions: "keep the plan" },
      { type: "session-control", sessionId: "session", conversationId: "conversation-1", action: "new" },
      { type: "prompt", sessionId: "session", conversationId: "conversation-1", text: "ordinary prompt" },
    ]);
  } finally { await client.disconnect(); fetchMock.mockRestore(); }
});

test("이전 런타임의 이미지와 큰 입력은 전송·자동 재시작 없이 보존 가능한 실패로 거부한다", async () => {
  const fetchMock = stubFetch(async () => { throw new Error("Must not send unsupported input"); });
  const client = new RuntimeClient(paths, snapshot());
  try {
    expect(expectError(await client.prompt("session", "[Image #1]", ["/tmp/image.png"])).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(expectError(await client.prompt("session", "x".repeat(1000001))).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {await client.disconnect(); fetchMock.mockRestore();}
});

test("이미지 지원 런타임에는 같은 prompt 명령에 이미지 참조를 명시적으로 전송한다", async () => {
  const state = snapshot(); state.capabilities = ["prompt-images"];
  const sent: unknown[] = [];
  const fetchMock = stubFetch(async (_input, options) => {
    sent.push(JSON.parse(String(options?.body))); return Response.json({ok:true,value:null});
  });
  const client = new RuntimeClient(paths, state);
  try {
    expectOk(await client.prompt("session", "Inspect [Image #1]", ["/tmp/image.png"]));
    expect(sent).toEqual([{type:"prompt",sessionId:"session",text:"Inspect [Image #1]",images:["/tmp/image.png"]}]);
  } finally {await client.disconnect(); fetchMock.mockRestore();}
});

test("이전 런타임의 /fast는 일반 모델 프롬프트로 보내지 않고 명시적으로 거부한다", async () => {
  const fetchMock = stubFetch(async () => { throw new Error("Settings must not become model input"); });
  const client = new RuntimeClient(paths, snapshot());
  try {
    const result = await client.prompt("session", "/fast on");

    expect(expectError(result).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(fetchMock).not.toHaveBeenCalled();
  } finally { await client.disconnect(); fetchMock.mockRestore(); }
});

for (const registered of [false, true]) {
  test(`기존 확장 /fast 등록 여부 ${registered}는 읽기 조회로 확인하고 있을 때만 명령을 보낸다`, async () => {
    const state = snapshot(); state.capabilities = ["prompt-completion"];
    const requests: string[] = [];
    const fetchMock = stubFetch(async (input) => {
      const path = new URL(String(input)).pathname; requests.push(path);
      return path === "/completions" ? Response.json({ items: registered ? [{ kind: "command", value: "fast", description: "Existing Fast control" }] : [], truncated: false })
        : Response.json({ ok: true, value: null });
    });
    const client = new RuntimeClient(paths, state);
    try {
      const result = await client.prompt("session", "/fast off");

      if (registered) expectOk(result);
      else expect(expectError(result).code).toBe("UNSUPPORTED_CAPABILITY");
      expect(requests).toEqual(registered ? ["/completions", "/command"] : ["/completions"]);
    } finally { await client.disconnect(); fetchMock.mockRestore(); }
  });
}

test("이전 런타임의 자동완성은 요청이나 재시작 없이 지원 부족 Result로 안내한다", async () => {
  const fetchMock = stubFetch(async () => { throw new Error("Must not contact an older service"); });
  const client = new RuntimeClient(paths, snapshot());
  try {
    expect(expectError(await client.complete("session", { kind: "command", query: "" })).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(fetchMock).not.toHaveBeenCalled();
  } finally { await client.disconnect(); fetchMock.mockRestore(); }
});

test("자동완성은 instance가 지정된 읽기 요청이며 잘못된 응답을 정상 후보로 사용하지 않는다", async () => {
  const state = snapshot(); state.capabilities = ["prompt-completion"];
  let malformed = false; const requests: string[] = [];
  const fetchMock = stubFetch(async (input, options) => {
    const url = new URL(String(input)); requests.push(url.pathname);
    expect(url.searchParams.get("query")).toBe("문서/a b"); expect(new Headers(options?.headers).get("X-Radian-Instance")).toBe("first");
    return Response.json(malformed ? { items: [{ value: "missing-kind" }], truncated: false }
      : { items: [{ kind: "file", value: "문서/a b.ts", description: "File" }], truncated: false });
  });
  const client = new RuntimeClient(paths, state);
  try {
    expect(expectOk(await client.complete("session", { kind: "file", query: "문서/a b" })).items[0]?.value).toBe("문서/a b.ts");
    malformed = true; expect(expectError(await client.complete("session", { kind: "file", query: "문서/a b" })).code).toBe("PROTOCOL_ERROR");
    expect(requests).toEqual(["/completions", "/completions"]);
  } finally { await client.disconnect(); fetchMock.mockRestore(); }
});

test("사용자가 취소한 자동완성 fetch는 예외나 빈 성공 대신 CANCELLED를 반환한다", async () => {
  const state = snapshot(); state.capabilities = ["prompt-completion"];
  const fetchMock = stubFetch(async (_input, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
  }));
  const client = new RuntimeClient(paths, state); const abort = new AbortController();
  try {
    const request = client.complete("session", { kind: "command", query: "" }, abort.signal); abort.abort();
    expect(expectError(await request).code).toBe("CANCELLED");
  } finally { await client.disconnect(); fetchMock.mockRestore(); }
});

for (const failure of ["eof", "reset"] as const) {
  test(`이벤트 ${failure} 후 최신 snapshot으로 복구하며 변경 명령을 재전송하지 않는다`, async () => {
    // Only the transport boundary is replaced; public client actions and stream parsing remain real.
    jest.useFakeTimers();
    const initial = snapshot(); initial.capabilities = [];
    const fresh = snapshot(); fresh.instance = "restarted"; fresh.preferences.drafts = { session: "restored" };
    const streams: ReturnType<typeof events>[] = [];
    const commands: string[] = [];
    const fetchMock = stubFetch(async (input, options) => {
      const path = new URL(String(input)).pathname;
      if (path === "/events") { const stream = events(streams.length ? fresh : initial, options?.signal); streams.push(stream); return stream.response; }
      if (path === "/history") return Response.json([]);
      const command = JSON.parse(String(options?.body)); commands.push(command.type);
      if (command.type === "prompt") throw Object.assign(new Error("Acknowledgement lost"), { code: "ECONNRESET" });
      return Response.json({ ok: true, value: command.type === "create" ? "session" : null });
    });
    const client = new RuntimeClient(paths, initial);
    try {
      expectOk(await client.attach());
      expectOk(await client.create("worktree"));
      expect(expectError(await client.prompt("session", "run")).message).toContain("outcome is unknown");
      expectOk(await client.closeSession("session"));

      // EOF and reset both permit read-only resubscription, never a replay of an uncertain action.
      if (failure === "eof") streams[0]!.end();
      else streams[0]!.fail(Object.assign(new Error("stream reset"), { code: "ECONNRESET" }));
      await settle();
      expect(client.snapshot.notice).toContain("Reconnecting");
      expect(expectError(await client.create("worktree")).code).toBe("CONNECTION_FAILED");
      await advance(250);

      // The fresh service identity/capabilities replace the stale snapshot and history works again.
      expect(streams).toHaveLength(2);
      expect(client.snapshot.instance).toBe("restarted");
      expect(client.snapshot.preferences.drafts).toEqual({ session: "restored" });
      expect(expectOk(await client.listHistory("worktree"))).toEqual([]);
      expect(commands).toEqual(["create", "prompt", "close"]);
    } finally { await client.disconnect(); fetchMock.mockRestore(); jest.useRealTimers(); }
  });
}

test("반복되는 짧은 연결은 snapshot 하나만 받아도 재시도 횟수를 무한 초기화하지 않는다", async () => {
  // A peer that accepts a stream and immediately closes must not cause an endless reconnect loop.
  jest.useFakeTimers();
  const streams: ReturnType<typeof events>[] = [];
  const fetchMock = stubFetch(async (_input, options) => {
    const stream = events(snapshot(), options?.signal); streams.push(stream); return stream.response;
  });
  const client = new RuntimeClient(paths, snapshot());
  try {
    expectOk(await client.attach());

    // Four retries use increasing delays; short successful handshakes do not reset that budget.
    for (const delay of [250, 500, 1000, 2000]) { streams.at(-1)!.end(); await settle(); await advance(delay); }
    streams.at(-1)!.end(); await settle(); await advance(60000);

    expect(streams).toHaveLength(5);
    expect(client.snapshot.notice).toContain("Reconnection stopped");
    expect(client.snapshot.notice).toContain("configured detach command");
    expect(client.snapshot.notice).not.toContain("Ctrl+C");
    expect(expectError(await client.listHistory("worktree")).code).toBe("CONNECTION_FAILED");
  } finally { await client.disconnect(); fetchMock.mockRestore(); jest.useRealTimers(); }
});

test("첫 snapshot을 보내지 않는 서비스도 연결 제한 시간과 재시도 예산을 따른다", async () => {
  // HTTP headers alone do not prove that a valid event subscription is ready.
  jest.useFakeTimers();
  const streams: ReturnType<typeof events>[] = [];
  const fetchMock = stubFetch(async (_input, options) => {
    const stream = events(streams.length ? undefined : snapshot(), options?.signal); streams.push(stream); return stream.response;
  });
  const client = new RuntimeClient(paths, snapshot());
  try {
    expectOk(await client.attach()); streams[0]!.end(); await settle();

    // Every retry bounds both headers and the first snapshot, not the established idle connection.
    for (const delay of [250, 500, 1000, 2000]) { await advance(delay); await advance(2000); }
    await advance(60000);

    expect(streams).toHaveLength(5);
    expect(client.snapshot.notice).toContain("Reconnection stopped");
    expect(client.snapshot.notice).toContain("timed out");
  } finally { await client.disconnect(); fetchMock.mockRestore(); jest.useRealTimers(); }
});

test("UI 분리 시 재접속 대기를 취소하고 추가 연결을 시작하지 않는다", async () => {
  // Detaching is a terminal client action, unlike an accidental transport failure.
  jest.useFakeTimers();
  const stream = events(snapshot());
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(stream.response);
  const client = new RuntimeClient(paths, snapshot());
  try {
    expectOk(await client.attach()); stream.end(); await settle();

    await client.disconnect();
    await advance(60000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(expectError(await client.attach()).code).toBe("CONNECTION_FAILED");
  } finally { await client.disconnect(); fetchMock.mockRestore(); jest.useRealTimers(); }
});

test("첫 snapshot을 기다리는 중 UI를 분리해도 연결 작업과 타이머가 종료된다", async () => {
  // A stalled initial handshake must not prevent the configured detach action from disposing the client.
  jest.useFakeTimers();
  const fetchMock = stubFetch(async (_input, options) => events(undefined, options?.signal).response);
  const client = new RuntimeClient(paths, snapshot());
  try {
    const attached = client.attach(); await settle();

    await client.disconnect();
    const result = await attached; await advance(60000);

    expect(expectError(result).code).toBe("CONNECTION_FAILED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { await client.disconnect(); fetchMock.mockRestore(); jest.useRealTimers(); }
});

for (const mismatch of ["repository", "mode"] as const) {
  test(`재접속 대상의 ${mismatch}가 다르면 명령을 허용하거나 연결을 재시도하지 않는다`, async () => {
    // A replacement instance is allowed only within the original workspace identity and live/test mode.
    jest.useFakeTimers();
    const first = events(snapshot()); const other = snapshot();
    if (mismatch === "repository") other.repositoryId = "/other/.git"; else other.mode = "live";
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(first.response).mockResolvedValueOnce(events(other).response);
    const client = new RuntimeClient(paths, snapshot());
    try {
      expectOk(await client.attach()); first.end(); await settle();

      await advance(250); await advance(60000);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(client.snapshot.instance).toBe("first");
      expect(client.snapshot.notice).toContain("identity");
      expect(expectError(await client.prompt("session", "run")).code).toBe("CONNECTION_FAILED");
    } finally { await client.disconnect(); fetchMock.mockRestore(); jest.useRealTimers(); }
  });
}

test("충분히 안정된 연결 뒤의 새 단절에는 별도의 재연결 예산을 부여한다", async () => {
  // A previous brief outage should not permanently consume the budget for later independent outages.
  jest.useFakeTimers();
  const streams: ReturnType<typeof events>[] = [];
  const fetchMock = stubFetch(async (_input, options) => {
    const stream = events(snapshot(), options?.signal); streams.push(stream); return stream.response;
  });
  const client = new RuntimeClient(paths, snapshot());
  try {
    expectOk(await client.attach()); streams[0]!.end(); await settle(); await advance(250);

    // The recovered connection stays healthy through the stability window before another outage.
    await advance(10000); streams[1]!.end(); await settle(); await advance(250);

    expect(streams).toHaveLength(3);
    expect(client.connected).toBe(true);
    expect(client.snapshot.notice).toBe("");
  } finally { await client.disconnect(); fetchMock.mockRestore(); jest.useRealTimers(); }
});

test("이벤트 연결의 권한 실패는 재시도하지 않고 typed 오류로 반환한다", async () => {
  // Retrying a permission denial cannot repair ownership and must not launch another service.
  jest.useFakeTimers();
  const original = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(original);
  const client = new RuntimeClient(paths, snapshot());
  try {
    const result = await client.attach(); await advance(60000);

    expect(expectError(result).code).toBe("CONNECTION_FAILED");
    expect(expectError(result).cause).toBe(original);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { await client.disconnect(); fetchMock.mockRestore(); jest.useRealTimers(); }
});

test("초기 연결의 내부 버그는 같은 예외로 전파하고 재접속하지 않는다", async () => {
  // The initiating caller owns diagnostics until a client is attached successfully.
  jest.useFakeTimers();
  const defect = new TypeError("initial attachment defect");
  const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(defect);
  const client = new RuntimeClient(paths, snapshot());
  try {
    await expect(client.attach()).rejects.toBe(defect); await advance(60000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { await client.disconnect(); fetchMock.mockRestore(); jest.useRealTimers(); }
});

test("예상하지 못한 스트림 오류는 원인을 기록하고 자동 재시도로 숨기지 않는다", async () => {
  // An internal defect is not a transient connection error even if it occurs while reading a stream.
  jest.useFakeTimers();
  const defect = new TypeError("unexpected stream defect");
  const stream = events(snapshot());
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(stream.response);
  const log = spyOn(console, "error").mockImplementation(() => {});
  const client = new RuntimeClient(paths, snapshot());
  try {
    expectOk(await client.attach());

    stream.fail(defect); await settle(); await advance(60000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.some((args) => args.includes(defect))).toBe(true);
    expect(client.snapshot.notice).toContain("Unexpected");
  } finally { await client.disconnect(); log.mockRestore(); fetchMock.mockRestore(); jest.useRealTimers(); }
});

test("같은 runtime으로 복구돼도 끊긴 PTY의 대기 입력과 detach를 뒤늦게 전송하지 않는다", async () => {
  // One input is already in flight; later keys have not crossed the transport boundary.
  jest.useFakeTimers();
  const state = snapshot(); state.capabilities = ["history", "terminal-tabs"];
  const mainStreams: ReturnType<typeof events>[] = [];
  const commands: { type: string; data?: string; lease?: string }[] = [];
  const acknowledgement = Promise.withResolvers<Response>();
  let inputs = 0;
  const fetchMock = stubFetch(async (input, options) => {
    const path = new URL(String(input)).pathname;
    if (path === "/events") { const stream = events(state, options?.signal); mainStreams.push(stream); return stream.response; }
    if (path === "/terminal/events") {
      const frame: PtyFrame = { id: "shell", worktreeId: "tree", pid: 123, exited: false, exitCode: null, cols: 80, rows: 24, revision: 0, ansi: "" };
      expect(new Headers(options?.headers).get("X-Radian-Instance")).toBe("first");
      return events(frame, options?.signal).response;
    }
    const command = JSON.parse(String(options?.body)); commands.push(command);
    if (command.type === "terminal-input" && ++inputs === 1) return acknowledgement.promise;
    return Response.json({ ok: true, value: null });
  });
  const client = new RuntimeClient(paths, state); const failures: unknown[] = [];
  try {
    expectOk(await client.attach());
    const old = expectOk(await client.attachTerminal("shell", () => {}, (error) => failures.push(error)));
    old.input(encoder.encode("sent-once")); old.input(encoder.encode("must-not-run")); await settle();
    expect(commands).toHaveLength(1);

    mainStreams[0]!.end(); await settle(); await advance(250);
    expect(client.connected).toBe(true);
    acknowledgement.resolve(Response.json({ ok: true, value: null })); await old.closed;
    old.input(encoder.encode("old-handle")); await settle();

    expect(commands.map((command) => command.type)).toEqual(["terminal-input"]);
    expect(Buffer.from(commands[0]!.data!, "base64").toString()).toBe("sent-once");
    expect(failures).toHaveLength(1);
    const fresh = expectOk(await client.attachTerminal("shell", () => {}, () => {}));
    expect(fresh.lease).not.toBe(old.lease);
    fresh.input(encoder.encode("explicit-new-input")); await settle();
    expect(commands.filter((command) => command.type === "terminal-input").map((command) => Buffer.from(command.data!, "base64").toString())).toEqual(["sent-once", "explicit-new-input"]);
  } finally { acknowledgement.resolve(Response.json({ ok: true, value: null })); await client.disconnect(); fetchMock.mockRestore(); jest.useRealTimers(); }
});

test("PTY 입력 응답 대기 중 분리해도 재연결은 즉시 중단하고 마지막 preferences만 flush한다", async () => {
  jest.useFakeTimers();
  const state = snapshot(); state.capabilities = ["terminal-tabs"];
  const acknowledgement = Promise.withResolvers<Response>();
  const commands: string[] = []; let subscriptions = 0;
  const fetchMock = stubFetch(async (input, options) => {
    const path = new URL(String(input)).pathname;
    if (path === "/events") { subscriptions++; return events(state, options?.signal).response; }
    if (path === "/terminal/events") return events({ id: "shell", worktreeId: "tree", pid: 123, exited: false, exitCode: null, cols: 80, rows: 24, revision: 0, ansi: "" }, options?.signal).response;
    const command = JSON.parse(String(options?.body)); commands.push(command.type);
    return command.type === "terminal-input" ? acknowledgement.promise : Response.json({ ok: true, value: null });
  });
  const client = new RuntimeClient(paths, state);
  try {
    expectOk(await client.attach()); const terminal = expectOk(await client.attachTerminal("shell", () => {}, () => {}));
    terminal.input(encoder.encode("accepted-before-detach")); await settle();

    client.beginDetach(); client.beginDetach(); terminal.input(encoder.encode("too-late")); await advance(10000);
    expect(client.connected).toBe(false); expect(subscriptions).toBe(1);
    expect(expectError(await client.create("tree")).code).toBe("CONNECTION_FAILED");
    expectOk(await client.savePreferences({ ...state.preferences, drafts: { saved: "last draft" } }));
    acknowledgement.resolve(Response.json({ ok: true, value: null })); await client.disconnect();

    expect(commands).toEqual(["terminal-input", "preferences", "terminal-detach"]);
    expect(expectError(await client.savePreferences(state.preferences)).code).toBe("CONNECTION_FAILED");
  } finally { acknowledgement.resolve(Response.json({ ok: true, value: null })); await client.disconnect(); fetchMock.mockRestore(); jest.useRealTimers(); }
});

test("PTY 첫 헤더 대기 중 분리는 취소 Result로 끝나며 명령을 보내지 않는다", async () => {
  const state = snapshot(); state.capabilities = ["terminal-tabs"];
  const commands: string[] = [];
  const fetchMock = stubFetch(async (input, options) => {
    if (new URL(String(input)).pathname === "/events") return events(state, options?.signal).response;
    if (new URL(String(input)).pathname === "/terminal/events") return new Promise((_resolve, reject) => {
      const aborted = () => reject(options?.signal?.reason);
      if (options?.signal?.aborted) aborted(); else options?.signal?.addEventListener("abort", aborted, { once: true });
    });
    commands.push(String(options?.body)); return Response.json({ ok: true, value: null });
  });
  const client = new RuntimeClient(paths, state);
  try {
    expectOk(await client.attach());
    const pending = client.attachTerminal("shell", () => {}, () => {}); await settle();
    await client.disconnect();
    expect(expectError(await pending).code).toBe("CONNECTION_FAILED");
    expect(commands).toEqual([]);
  } finally { await client.disconnect(); fetchMock.mockRestore(); }
});

test("handshake timeout과 동시에 발생한 내부 버그도 timeout으로 숨기지 않는다", async () => {
  jest.useFakeTimers();
  const defect = new TypeError("defect racing timeout");
  const fetchMock = stubFetch(async (_input, options) => new Promise((_resolve, reject) => {
    if (options?.signal?.aborted) reject(defect);
    else options?.signal?.addEventListener("abort", () => reject(defect), { once: true });
  }));
  const client = new RuntimeClient(paths, snapshot());
  try {
    const attached = client.attach().catch((error: unknown) => error);
    await settle(); await advance(2000);
    expect(await attached).toBe(defect);
    await advance(60000); expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { await client.disconnect(); fetchMock.mockRestore(); jest.useRealTimers(); }
});

test("하나의 스트림 안에서 instance가 바뀌면 거부하고 재시도하지 않는다", async () => {
  jest.useFakeTimers();
  const stream = events(snapshot());
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(stream.response);
  const client = new RuntimeClient(paths, snapshot());
  try {
    expectOk(await client.attach());
    stream.frame({ ...snapshot(), instance: "unexpected" }); await settle(); await advance(60000);
    expect(client.snapshot.instance).toBe("first"); expect(client.connected).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.snapshot.notice).toContain("within the event stream");
  } finally { await client.disconnect(); fetchMock.mockRestore(); jest.useRealTimers(); }
});
