import { expect, spyOn, test } from "bun:test";
import { RuntimeClient } from "./client.ts";
import { runtimePaths } from "./storage.ts";
import { emptyPreferences, protocolVersion, type RuntimeSnapshot } from "./protocol.ts";
import { expectError, expectOk } from "../testing/results.ts";
import type { ModelCatalog } from "../agents/model-selection.ts";

const state = (): RuntimeSnapshot => ({ version: protocolVersion, pid: process.pid, instance: "instance", repositoryId: "repo", mode: "offline",
  repositories: [], details: { session: { conversationId: "conversation", status: null, output: "", error: null } },
  closingCount: 0, preferences: structuredClone(emptyPreferences), notice: "", capabilities: ["model-selection", "model-effort"] });
const paths = runtimePaths("model-client-fixture", true, "/tmp/radian-model-client-test");
const catalog: ModelCatalog = { conversationId: "conversation", current: { provider: "first", id: "same-id" }, effort: "high", models: [
  { provider: "first", id: "same-id", name: "First", contextWindow: 200000, reasoning: true, images: true, efforts: ["low", "high"], effort: "high" },
  { provider: "second", id: "same-id", name: "Second", contextWindow: 64000, reasoning: false, images: false, efforts: ["off"], effort: "off" },
] };

test("모델 목록과 변경 IPC는 세션·대화·런타임 식별자를 보내고 모델을 provider와 ID로 구분한다", async () => {
  // 실제 네트워크 대신 응답 경계만 대체하고 전송되는 프로토콜을 검증한다.
  const requests: { path: string; headers: Headers; body?: unknown }[] = [];
  const mocked = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    const url = new URL(String(input));
    requests.push({ path: url.pathname + url.search, headers: new Headers(options?.headers), ...(options?.body ? { body: JSON.parse(String(options.body)) } : {}) });
    return Response.json(url.pathname === "/models" ? catalog : { ok: true, value: null });
  }, { preconnect: fetch.preconnect }));
  const client = new RuntimeClient(paths, state());
  try {
    expect(expectOk(await client.models("session", "conversation"))).toEqual(catalog);
    expectOk(await client.selectModel("session", "conversation", { provider: "second", id: "same-id" }, "off"));

    expect(requests[0]!.path).toBe("/models?sessionId=session&conversationId=conversation");
    expect(requests[0]!.headers.get("X-Radian-Instance")).toBe("instance");
    expect(requests[1]!.body).toEqual({ type: "model-select", sessionId: "session", conversationId: "conversation", model: { provider: "second", id: "same-id" }, effort: "off" });
  } finally { await client.disconnect(); mocked.mockRestore(); }
});

test("구버전 서비스나 raw model 명령은 유료 프롬프트·자동 재시작·다른 명령으로 우회하지 않는다", async () => {
  const snapshot = state(); snapshot.capabilities = [];
  const mocked = spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => { throw new Error("Unsupported model controls must not transmit"); }, { preconnect: fetch.preconnect }));
  const client = new RuntimeClient(paths, snapshot);
  try {
    expect(expectError(await client.models("session", "conversation")).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(expectError(await client.selectModel("session", "conversation", { provider: "second", id: "same-id" })).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(expectError(await client.prompt("session", "/model")).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(expectError(await client.prompt("session", "/model second/same-id")).code).toBe("INVALID_INPUT");
    expect(mocked).not.toHaveBeenCalled();
  } finally { await client.disconnect(); mocked.mockRestore(); }
});

test("모델 변경만 지원하는 이전 서비스에는 effort를 무시할 수 있는 요청을 보내지 않는다", async () => {
  const snapshot = state(); snapshot.capabilities = ["model-selection"];
  const mocked = spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => { throw new Error("Legacy service must not receive effort changes"); }, { preconnect: fetch.preconnect }));
  const client = new RuntimeClient(paths, snapshot);
  try {
    expect(expectError(await client.models("session", "conversation")).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(expectError(await client.selectModel("session", "conversation", { provider: "first", id: "same-id" }, "high")).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(mocked).not.toHaveBeenCalled();
  } finally { await client.disconnect(); mocked.mockRestore(); }
});

test("모델 응답의 대화 식별자가 다르면 목록을 채택하지 않는다", async () => {
  const mocked = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ ...catalog, conversationId: "other-conversation" }), { preconnect: fetch.preconnect }));
  const client = new RuntimeClient(paths, state());
  try {
    expect(expectError(await client.models("session", "conversation")).code).toBe("PROTOCOL_ERROR");
  } finally { await client.disconnect(); mocked.mockRestore(); }
});
