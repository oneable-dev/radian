import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, createProvider, InMemoryCredentialStore, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { AccountManager } from "./manager.ts";
import type { AccountReply, LoginView } from "./model.ts";
import { piSessionFactory } from "../agents/pi-session-adapter.ts";
import { fixtureMessage } from "../testing/offline-runtime.ts";
import { expectOk } from "../testing/results.ts";
import { err } from "../result.ts";
import { CapabilityError } from "../errors.ts";

function login(reply: AccountReply): LoginView { if (reply.kind !== "login") throw new Error("Expected login"); return reply.login; }
async function add(manager: AccountManager, key: string) {
  let flow = login(expectOk(await manager.handle({ type: "login", worktreeId: "one", provider: "fixture", method: "api_key", label: key })));
  flow = login(expectOk(await manager.handle({ type: "answer", worktreeId: "one", flowId: flow.id, promptId: flow.prompt!.id, value: key })));
  while (flow.status === "pending") flow = login(expectOk(await manager.handle({ type: "poll", worktreeId: "one", flowId: flow.id, revision: flow.revision })));
  expect(flow.status).toBe("complete"); return flow.account!.id;
}
async function select(manager: AccountManager, worktreeId: string, accountId: string) {
  expectOk(await manager.handle({ type: "select", worktreeId, provider: "fixture", accountId, revision: (await manager.catalog(worktreeId)).revision }));
}

test("응답 중 계정 전환은 기존 요청·도구·대화를 유지하고 다음 모델 호출부터 새 인증과 연결 범위를 사용한다", async () => {
  // 실제 SDK 세션과 파일 도구를 사용하되 모델 전송 경계만 로컬 스크립트로 대체한다.
  const directory = await mkdtemp(join(tmpdir(), "radian-account-session-"));
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const calls: { key: string | undefined; sessionId: string | undefined }[] = [];
  let reads = 0, oldQuota: unknown;
  const model: Model<"openai-codex-responses"> = { id: "fixture-model", name: "Fixture", api: "openai-codex-responses", provider: "fixture", baseUrl: "http://127.0.0.1:1", reasoning: false,
    input: ["text"], contextWindow: 64000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const stream = (selected: typeof model, _context: unknown, options?: SimpleStreamOptions) => {
    const output = createAssistantMessageEventStream(), message = fixtureMessage(selected.api, selected.provider, selected.id), first = calls.length === 0;
    calls.push({ key: options?.apiKey, sessionId: options?.sessionId });
    output.push({ type: "start", partial: message });
    void (async () => {
      await options?.onPayload?.({}, selected);
      if (first) { started.resolve(); await finish.promise; }
      await options?.onResponse?.({ status: 200, headers: { "x-codex-secondary-used-percent": first ? "80" : "30", "x-codex-secondary-window-minutes": "10080", "x-codex-secondary-reset-at": String(Math.floor(Date.now() / 1000) + 3600) } }, selected);
      if (first) oldQuota = executor?.state.telemetry?.weekly ?? null;
      if (first) { message.content.push({ type: "toolCall", id: "read-once", name: "read", arguments: { path: "workspace.txt" } }); message.stopReason = "toolUse"; }
      else { message.content.push({ type: "text", text: "Finished with the new account." }); message.stopReason = "stop"; }
      output.push({ type: "done", reason: first ? "toolUse" : "stop", message }); output.end();
    })();
    return output;
  };
  const provider = createProvider({ id: "fixture", name: "Fixture", models: [model], auth: { apiKey: { name: "API key",
    login: async interaction => ({ type: "api_key", key: await interaction.prompt({ type: "secret", message: "Key" }) }),
    resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key } } : undefined } }, api: { stream, streamSimple: stream } });
  const manager = expectOk(await AccountManager.open(join(directory, "accounts"), { offline: true, defaultCredentials: new InMemoryCredentialStore(), providers: [provider] }));
  let executor: Awaited<ReturnType<ReturnType<typeof piSessionFactory>>> | undefined;
  try {
    await writeFile(join(directory, "workspace.txt"), "Retained tool result");
    const a = await add(manager, "key-secret-A"), b = await add(manager, "key-secret-B");
    await select(manager, "one", a); await select(manager, "two", a);
    executor = await piSessionFactory({ accounts: manager, agentDir: join(directory, "agent"), model, settings: { retry: { enabled: false }, compaction: { enabled: false } } })({ cwd: directory, worktreeId: "one", role: "main", spawnSubagent: async () => err(new CapabilityError("No child expected")) });
    const unsubscribe = executor.subscribe(() => { reads = executor!.state.sections?.filter(section => section.kind === "tool" && section.title.includes("read")).length ?? 0; });

    // A 응답을 지연한 상태에서 첫 작업 공간만 B로 바꾼다.
    const pending = executor.prompt("Read workspace.txt and finish."); await started.promise;
    await select(manager, "one", b);
    expect((await (await manager.workspace("two")).runtime.getAuth("fixture"))?.auth.apiKey).toBe("key-secret-A");
    expect(executor.state.status).toBe("working"); finish.resolve(); expectOk(await pending); unsubscribe();

    // 같은 작업의 다음 호출은 B이며 대화와 도구 결과, 기존 요청의 완료를 보존한다.
    expect(calls.map(call => call.key)).toEqual(["key-secret-A", "key-secret-B"]); expect(calls[0]!.sessionId).not.toBe(calls[1]!.sessionId);
    expect(executor.state.sections?.some(section => section.text.includes("Retained tool result"))).toBe(true);
    expect(executor.state.sections?.some(section => section.text.includes("Finished with the new account"))).toBe(true); expect(reads).toBe(1); expect(oldQuota).toBeNull(); expect(executor.state.telemetry?.weekly?.remainingPercent).toBe(70);
    const saved = await readFile(executor.sessionFile!, "utf8"); expect(saved).not.toContain("key-secret-A"); expect(saved).not.toContain("key-secret-B");
  } finally { finish.resolve(); await executor?.close(); await manager.stop(); await rm(directory, { recursive: true, force: true }); }
});
