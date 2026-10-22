import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider, InMemoryCredentialStore, isModelType, type Api, type Credential, type Model, type Provider, type ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { AccountManager } from "./manager.ts";
import type { AccountReply, LoginView } from "./model.ts";
import { expectError, expectOk } from "../testing/results.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function provider(login?: (interaction: ProviderAuthInteraction) => Promise<Credential>): Provider {
  return createProvider({ id: "fixture", name: "Fixture", models: [], auth: {
    apiKey: { name: "API key", login: async interaction => ({ type: "api_key", key: await interaction.prompt({ type: "secret", message: "Enter API key" }) }),
      resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key } } : undefined },
    ...(login ? { oauth: { name: "OAuth", login: async interaction => { const result = await login(interaction); if (result.type !== "oauth") throw new Error("Fixture expected OAuth"); return result; },
      refresh: async credential => ({ ...credential, expires: Date.now() + 3600000 }), toAuth: async credential => ({ apiKey: credential.access }) } } : {}),
  }, api: { stream: () => { throw new Error("No model request expected"); }, streamSimple: () => { throw new Error("No model request expected"); } } });
}
async function fixture(providers: readonly Provider[] = [provider()]) {
  const directory = await mkdtemp(join(tmpdir(), "radian-accounts-")), defaults = new InMemoryCredentialStore();
  const manager = expectOk(await AccountManager.open(directory, { offline: true, defaultCredentials: defaults, providers }));
  cleanups.push(async () => { expectOk(await manager.stop()); await rm(directory, { recursive: true, force: true }); });
  return { directory, defaults, manager };
}
function login(reply: AccountReply): LoginView { if (reply.kind !== "login") throw new Error("Expected login reply"); return reply.login; }
async function finish(manager: AccountManager, view: LoginView, worktreeId = "one") {
  let current = view;
  while (current.status === "pending") current = login(expectOk(await manager.handle({ type: "poll", worktreeId, flowId: current.id, revision: current.revision })));
  expect(current.status).toBe("complete"); return current.account!;
}
async function add(manager: AccountManager, key: string, worktreeId = "one") {
  const view = login(expectOk(await manager.handle({ type: "login", worktreeId, provider: "fixture", method: "api_key", label: key })));
  expect(view.prompt?.type).toBe("secret");
  return finish(manager, login(expectOk(await manager.handle({ type: "answer", worktreeId, flowId: view.id, promptId: view.prompt!.id, value: key }))), worktreeId);
}
async function select(manager: AccountManager, worktreeId: string, accountId: string | null) {
  return manager.handle({ type: "select", worktreeId, provider: "fixture", accountId, revision: (await manager.catalog(worktreeId)).revision });
}

test("계정을 추가하면 전역 목록에 나타나지만 기존 선택과 Pi 기본 인증은 바뀌지 않는다", async () => {
  // 기존 기본 인증과 별개의 새 계정을 준비한다.
  const { manager, defaults, directory } = await fixture();
  await defaults.modify("fixture", async () => ({ type: "api_key", key: "pi-original" }));

  // 한 작업 공간에서 추가한 계정을 다른 작업 공간에서도 조회한다.
  const account = await add(manager, "named-key");
  const other = await manager.catalog("two"), workspace = await manager.workspace("one");

  // 자격증명은 메타데이터 응답에 없고 추가만으로 기본 계정을 덮어쓰지 않는다.
  expect(other.accounts.map(account => account.id)).toContain(account.id);
  expect(other.selections).toEqual({}); expect((await workspace.runtime.getAuth("fixture"))?.auth.apiKey).toBe("pi-original");
  expect(JSON.stringify(other)).not.toContain('"key"'); expect((await stat(join(directory, "accounts.json"))).mode & 0o777).toBe(0o600);
});

test("작업 공간별 선택은 인증을 격리하며 저장 후 다시 열어도 유지한다", async () => {
  // 두 계정은 같은 제공자이지만 서로 다른 키를 사용한다.
  const { manager, directory } = await fixture(); const a = await add(manager, "key-a"), b = await add(manager, "key-b");

  // 각 작업 공간의 선택을 따로 저장한다.
  expectOk(await select(manager, "one", a.id)); expectOk(await select(manager, "two", b.id));
  const one = await manager.workspace("one"), two = await manager.workspace("two");
  const reopened = expectOk(await AccountManager.open(directory, { offline: true, defaultCredentials: new InMemoryCredentialStore(), providers: [provider()] }));
  cleanups.push(async () => { expectOk(await reopened.stop()); });

  // SDK 객체와 다음 요청의 인증 모두 작업 공간별로 구분된다.
  expect(one.runtime).not.toBe(two.runtime); expect((await one.runtime.getAuth("fixture"))?.auth.apiKey).toBe("key-a");
  expect((await two.runtime.getAuth("fixture"))?.auth.apiKey).toBe("key-b"); expect((await reopened.catalog("one")).selections.fixture).toBe(a.id);
});

test("사용 중인 계정 삭제와 오래된 변경 요청은 거절하고 명시적으로 해제한 계정만 삭제한다", async () => {
  // 한 계정이 다른 작업 공간에서도 선택된 상황을 준비한다.
  const { manager } = await fixture(); const account = await add(manager, "shared"); expectOk(await select(manager, "two", account.id));
  const catalog = await manager.catalog("one");

  // 사용 중 삭제와 잘못된 리비전의 변경을 시도한다.
  const used = await manager.handle({ type: "delete", worktreeId: "one", accountId: account.id, revision: catalog.revision });
  const stale = await manager.handle({ type: "select", worktreeId: "one", provider: "fixture", accountId: account.id, revision: catalog.revision - 1 });

  // 다른 작업 공간을 자동 변경하지 않으며 직접 해제한 후에만 삭제할 수 있다.
  expect(expectError(used).code).toBe("ACCOUNT_IN_USE"); expect(expectError(stale).code).toBe("ACCOUNT_CONFLICT");
  expect((await manager.catalog("two")).selections.fixture).toBe(account.id);
  expectOk(await select(manager, "two", null));
  expectOk(await manager.handle({ type: "delete", worktreeId: "one", accountId: account.id, revision: (await manager.catalog("one")).revision }));
  expect((await manager.catalog("two")).accounts).toEqual([]);
});

test("선택한 계정이 사라져도 기본 인증으로 조용히 넘어가지 않는다", async () => {
  // 유효한 기본 키와 존재하지 않는 명시적 계정 선택이 함께 저장되어 있다.
  const { manager, directory, defaults } = await fixture(); await defaults.modify("fixture", async () => ({ type: "api_key", key: "ambient" }));
  await writeFile(join(directory, "accounts.json"), JSON.stringify({ version: 1, revision: 1, accounts: [], selections: { one: { fixture: "missing" } } }));
  const reopened = expectOk(await AccountManager.open(directory, { offline: true, defaultCredentials: defaults, providers: [provider()] })); cleanups.push(async () => { expectOk(await reopened.stop()); });

  // 작업 공간 초기화의 인증 검사가 누락된 명시적 계정을 확인한다.
  const view = await reopened.workspace("one");
  const result = view.runtime.getAuth("fixture");

  // 환경 인증 대신 명확한 인증 실패를 반환한다.
  await expect(result).rejects.toBeInstanceOf(Error); expect((await manager.catalog("one")).accounts).toEqual([]);
});

test("OAuth URL과 입력은 로그인 작업에만 전달하고 취소 후에는 계정을 추가하지 않는다", async () => {
  // 제공자는 URL을 알리고 수동 코드 입력을 기다린다.
  const { manager, directory } = await fixture([provider(async interaction => {
    interaction.notify({ type: "auth_url", url: "https://example.test/authorize?state=private" });
    await interaction.prompt({ type: "manual_code", message: "Paste code" });
    return { type: "oauth", access: "secret-access", refresh: "secret-refresh", expires: Date.now() + 3600000 };
  })]);

  // 다른 작업 공간에서는 해당 로그인 작업에 접근할 수 없고 소유자가 취소한다.
  const view = login(expectOk(await manager.handle({ type: "login", worktreeId: "one", provider: "fixture", method: "oauth", label: "OAuth" })));
  const foreign = await manager.handle({ type: "poll", worktreeId: "two", flowId: view.id, revision: 0 });
  expectOk(await manager.handle({ type: "cancel", worktreeId: "one", flowId: view.id }));

  // URL과 코드는 계정 목록이나 저장소에 들어가지 않는다.
  expect(view.events[0]?.url).toContain("state=private"); expect(expectError(foreign).code).toBe("ACCOUNT_NOT_FOUND");
  expect((await manager.catalog("one")).accounts).toEqual([]); expect(JSON.stringify(await manager.catalog("one"))).not.toContain("state=private");
  const stored = await readFile(join(directory, "accounts.json"), "utf8"); expect(stored).not.toContain("state=private"); expect(stored).not.toContain("secret-access");
});

test("동일 계정의 동시 OAuth 갱신을 한 번만 수행하고 선택 변경 중에도 원래 계정에 저장한다", async () => {
  // 만료된 A 갱신을 지연시켜 두 작업 공간의 갱신과 B 전환을 겹친다.
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let refreshed = 0, next = "a";
  const oauth = provider(async () => ({ type: "oauth", access: next, refresh: `refresh-${next}`, expires: 0 }));
  oauth.auth.oauth!.refresh = async credential => { refreshed++; started.resolve(); await release.promise; return { ...credential, access: `${credential.access}-new`, expires: Date.now() + 3600000 }; };
  const { manager, directory } = await fixture([oauth]);
  const a = await finish(manager, login(expectOk(await manager.handle({ type: "login", worktreeId: "one", provider: "fixture", method: "oauth", label: "A" }))));
  next = "b"; const b = await finish(manager, login(expectOk(await manager.handle({ type: "login", worktreeId: "one", provider: "fixture", method: "oauth", label: "B" }))));
  expectOk(await select(manager, "one", a.id)); expectOk(await select(manager, "two", a.id));
  const one = await manager.workspace("one"), two = await manager.workspace("two");

  // A 요청들이 대기하는 동안 첫 작업 공간만 B로 전환한다.
  const first = one.runtime.getAuth("fixture"), second = two.runtime.getAuth("fixture"); await started.promise;
  expectOk(await select(manager, "one", b.id)); release.resolve();
  const results = await Promise.all([first, second]);

  // 이미 시작한 요청은 A로 끝나며 B의 토큰과 선택은 덮어쓰지 않는다.
  expect(refreshed).toBe(1); expect(results.map(result => result?.auth.apiKey)).toEqual(["a-new", "a-new"]);
  expect((await manager.catalog("one")).selections.fixture).toBe(b.id);
  const stored = JSON.parse(await readFile(join(directory, "accounts.json"), "utf8"));
  expect(stored.accounts.find((account: { id: string }) => account.id === b.id).credential.access).toBe("b");
});

test("선택 저장에 실패하면 기존 선택과 인증을 그대로 유지한다", async () => {
  // 저장 대상만 디렉터리로 막아 원자적 rename의 실패를 재현한다.
  const { manager, directory } = await fixture(); const a = await add(manager, "key-a"), b = await add(manager, "key-b");
  expectOk(await select(manager, "one", a.id)); const target = join(directory, "accounts.json");
  await rm(target); await mkdir(target);

  // 저장되지 않은 선택은 실행 중인 인증에도 적용하지 않는다.
  const changed = await select(manager, "one", b.id);

  expect(expectError(changed).code).toBe("STORAGE_FAILED"); expect((await manager.catalog("one")).selections.fixture).toBe(a.id);
  expect((await (await manager.workspace("one")).runtime.getAuth("fixture"))?.auth.apiKey).toBe("key-a");
});

test("OAuth 토큰 회전 후 저장 실패는 새 토큰을 메모리에 보존하고 저장 경고를 제공한다", async () => {
  // 원격 토큰 회전은 파일 저장 실패로 취소할 수 없다.
  const oauth = provider(async () => ({ type: "oauth", access: "old", refresh: "old-refresh", expires: 0 }));
  oauth.auth.oauth!.refresh = async credential => ({ ...credential, access: "rotated", refresh: "rotated-refresh", expires: Date.now() + 3600000 });
  const { manager, directory } = await fixture([oauth]);
  const account = await finish(manager, login(expectOk(await manager.handle({ type: "login", worktreeId: "one", provider: "fixture", method: "oauth", label: "Rotating" }))));
  expectOk(await select(manager, "one", account.id)); const target = join(directory, "accounts.json"); await rm(target); await mkdir(target);

  // 갱신은 사용 가능한 새 토큰을 반환하되 영속화 완료로 가장하지 않는다.
  const auth = await (await manager.workspace("one")).runtime.getAuth("fixture");

  expect(auth?.auth.apiKey).toBe("rotated"); expect(manager.warning).toContain("saving failed");
  const listed = expectOk(await manager.handle({ type: "list", worktreeId: "one" })); if (listed.kind !== "catalog") throw new Error("Expected catalog");
  expect(listed.warning).toContain("in memory");
  await rm(target, { recursive: true }); expectOk(await select(manager, "one", account.id));
  expect(manager.warning).toBe(""); expect(await readFile(target, "utf8")).toContain("rotated-refresh");
});

test("동시에 로그인 창을 열어도 하나만 시작하고 빈 라벨은 거절한다", async () => {
  // 고정 OAuth 콜백 포트와 로그인 입력의 소유권을 하나의 작업으로 제한한다.
  const { manager } = await fixture();

  const results = await Promise.all(["one", "two"].map(worktreeId => manager.handle({ type: "login", worktreeId, provider: "fixture", method: "api_key", label: "New" })));
  const blank = await manager.handle({ type: "login", worktreeId: "one", provider: "fixture", method: "api_key", label: " " });

  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(results.filter(result => !result.ok).map(result => result.ok ? null : result.error.code)).toEqual(["ACCOUNT_CONFLICT"]);
  expect(expectError(blank).code).toBe("INVALID_INPUT");
});

test("OAuth 로그인에 필요한 설치 식별자는 재시작해도 같은 값으로 전달한다", async () => {
  // ChatGPT 등의 OAuth가 요구하는 설치 ID는 로그인마다 달라지면 안 된다.
  const ids: string[] = [], oauth = provider(async () => ({ type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 3600000 }));
  oauth.auth.oauth!.login = async (_interaction, options) => { ids.push(options!.getDeviceId!()); return { type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 3600000 }; };
  const { manager, directory } = await fixture([oauth]);

  // 동일 저장소를 다시 열어 SDK 로그인 옵션을 다시 만든다.
  await finish(manager, login(expectOk(await manager.handle({ type: "login", worktreeId: "one", provider: "fixture", method: "oauth", label: "First" }))));
  const reopened = expectOk(await AccountManager.open(directory, { offline: true, defaultCredentials: new InMemoryCredentialStore(), providers: [oauth] }));
  cleanups.push(async () => { expectOk(await reopened.stop()); });
  await finish(reopened, login(expectOk(await reopened.handle({ type: "login", worktreeId: "one", provider: "fixture", method: "oauth", label: "Second" }))));

  expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]); expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/u);
});

test("Pi 기본 OAuth는 목록 조회에서 갱신하지 않고 실제 인증 요청에서 SDK 저장소에 한 번만 갱신한다", async () => {
  // 기본 인증은 Radian 계정 파일로 복사하지 않고 기존 SDK 저장소에 남긴다.
  let refreshed = 0;
  const oauth = provider(async () => ({ type: "oauth", access: "unused", refresh: "unused", expires: 0 }));
  oauth.auth.oauth!.refresh = async credential => { refreshed++; return { ...credential, access: "pi-new", expires: Date.now() + 3600000 }; };
  const { manager, defaults } = await fixture([oauth]);
  await defaults.modify("fixture", async () => ({ type: "oauth", access: "pi-old", refresh: "pi-refresh", expires: 0 }));

  const one = await manager.workspace("one"), two = await manager.workspace("two"); expect(refreshed).toBe(0);
  const auth = await Promise.all([one.runtime.getAuth("fixture"), two.runtime.getAuth("fixture")]);

  expect(refreshed).toBe(1); expect(auth.map(result => result?.auth.apiKey)).toEqual(["pi-new", "pi-new"]);
  expect((await defaults.read("fixture"))?.type).toBe("oauth"); expect((await manager.catalog("one")).accounts).toEqual([]);
});

test("OAuth 갱신 실패의 SDK 오류에 토큰이 있어도 모델 경계의 오류 메시지로 노출하지 않는다", async () => {
  // 일부 SDK 제공자는 원격 오류 본문을 평문 Error에 넣으므로 해당 경계에서 가린다.
  const oauth = provider(async () => ({ type: "oauth", access: "private-access", refresh: "private-refresh", expires: 0 }));
  oauth.auth.oauth!.refresh = async () => { throw new Error("Remote failure: private-access private-refresh"); };
  const { manager } = await fixture([oauth]);
  const account = await finish(manager, login(expectOk(await manager.handle({ type: "login", worktreeId: "one", provider: "fixture", method: "oauth", label: "Redacted" }))));
  expectOk(await select(manager, "one", account.id));

  // SDK의 인증 실패는 UI·대화에 전달되는 최상위 메시지에서 비밀 값을 제거한다.
  const view = await manager.workspace("one");
  let message = "";
  try { await view.runtime.getAuth("fixture"); } catch (error) { if (!(error instanceof Error)) throw error; message = error.message; }

  expect(message).toContain("Could not refresh"); expect(message).not.toContain("private-access"); expect(message).not.toContain("private-refresh");
});

test("동일한 원격 OAuth 계정은 다른 이름으로 중복 저장하거나 기존 선택을 덮어쓰지 않는다", async () => {
  // SDK가 안정적인 accountId를 제공하는 계정은 두 갱신 소유자로 나누지 않는다.
  const oauth = provider(async () => ({ type: "oauth", accountId: "remote-account", access: "access", refresh: "refresh", expires: Date.now() + 3600000 }));
  const { manager } = await fixture([oauth]);
  const account = await finish(manager, login(expectOk(await manager.handle({ type: "login", worktreeId: "one", provider: "fixture", method: "oauth", label: "Original" }))));
  expectOk(await select(manager, "one", account.id));

  let duplicate = login(expectOk(await manager.handle({ type: "login", worktreeId: "two", provider: "fixture", method: "oauth", label: "Duplicate" })));
  while (duplicate.status === "pending") duplicate = login(expectOk(await manager.handle({ type: "poll", worktreeId: "two", flowId: duplicate.id, revision: duplicate.revision })));

  expect(duplicate.status).toBe("error"); expect(duplicate.error).toContain("already saved");
  expect((await manager.catalog("one")).accounts).toHaveLength(1); expect((await manager.catalog("one")).selections.fixture).toBe(account.id);
});

test("제공자의 개인화된 모델 목록은 다른 계정의 저장 캐시를 재사용하지 않는다", async () => {
  // 제공자별로만 저장하는 SDK 캐시 위에 계정별 저장 공간을 연결한다.
  const dynamic = provider(); let models: readonly Model<Api>[] = [];
  dynamic.getModels = () => models; dynamic.getAllModels = () => models;
  dynamic.refreshModels = async context => {
    await context.publish({ update: () => { models = (context.stored?.models ?? []).filter(model => isModelType(model, "chat")); } });
    if (!context.allowNetwork) return;
    const key = context.credential?.type === "api_key" ? context.credential.key : "missing";
    const model: Model<"openai-completions"> = { id: `model-${key}`, name: `Model ${key}`, provider: "fixture", api: "openai-completions", baseUrl: "http://127.0.0.1:1", reasoning: false,
      input: ["text"], contextWindow: 64000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    await context.publish({ persist: { models: [model] }, update: () => { models = [model]; } });
  };
  const { manager } = await fixture([dynamic]); const a = await add(manager, "A"), b = await add(manager, "B");

  // A의 목록을 저장한 다음 B로 전환하고 다시 A로 돌아간다.
  expectOk(await select(manager, "one", a.id));
  await manager.request("one", runtime => runtime.refresh({ providers: ["fixture"], allowNetwork: true }));
  const view = await manager.workspace("one"); expect(view.runtime.getModels("fixture").map(model => model.id)).toEqual(["model-A"]);
  expectOk(await select(manager, "one", b.id)); expect(view.runtime.getModels("fixture")).toEqual([]);
  await manager.request("one", runtime => runtime.refresh({ providers: ["fixture"], allowNetwork: true }));
  expect(view.runtime.getModels("fixture").map(model => model.id)).toEqual(["model-B"]);
  expectOk(await select(manager, "one", a.id));

  // 모델 목록은 해당 계정의 저장된 메타데이터로만 복원된다.
  expect(view.runtime.getModels("fixture").map(model => model.id)).toEqual(["model-A"]);
});

test("OpenRouter처럼 갱신 토큰이 빈 OAuth 자격증명도 SDK 형식을 그대로 저장한다", async () => {
  // SDK는 만료되지 않는 OAuth 자격증명에 빈 refresh 문자열을 사용할 수 있다.
  const oauth = provider(async () => ({ type: "oauth", access: "provider-access", refresh: "", expires: Number.MAX_SAFE_INTEGER }));
  const { manager, directory } = await fixture([oauth]);

  const account = await finish(manager, login(expectOk(await manager.handle({ type: "login", worktreeId: "one", provider: "fixture", method: "oauth", label: "No refresh token" }))));
  expectOk(await select(manager, "one", account.id));

  expect(account.type).toBe("oauth"); expect((await (await manager.workspace("one")).runtime.getAuth("fixture"))?.auth.apiKey).toBe("provider-access");
  const stored = JSON.parse(await readFile(join(directory, "accounts.json"), "utf8")); expect(stored.accounts[0].credential).toMatchObject({ type: "oauth", refresh: "" });
});
