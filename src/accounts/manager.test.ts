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

test("Adding an account updates the global list without changing selections or Pi default authentication", async () => {
  // Prepare an account separate from the existing default credentials.
  const { manager, defaults, directory } = await fixture();
  await defaults.modify("fixture", async () => ({ type: "api_key", key: "pi-original" }));

  // Accounts added in one workspace are visible in another.
  const account = await add(manager, "named-key");
  const other = await manager.catalog("two"), workspace = await manager.workspace("one");

  // Metadata excludes credentials, and adding an account does not overwrite defaults.
  expect(other.accounts.map(account => account.id)).toContain(account.id);
  expect(other.selections).toEqual({}); expect((await workspace.runtime.getAuth("fixture"))?.auth.apiKey).toBe("pi-original");
  expect(JSON.stringify(other)).not.toContain('"key"'); expect((await stat(join(directory, "accounts.json"))).mode & 0o777).toBe(0o600);
});

test("Account lists distinguish authenticated connections from available providers", async () => {
  // A supported provider without credentials is not a switchable account.
  const { manager, defaults } = await fixture();
  const before = await manager.catalog("one");
  expect(before.existingAccounts?.find(account => account.provider === "fixture")).toBeUndefined();
  expect(before.providers.find(provider => provider.id === "fixture")).toBeDefined();

  // Discover credentials registered in the existing store.
  await defaults.modify("fixture", async () => ({ type: "api_key", key: "private-existing-key" }));
  const connected = await manager.catalog("one");

  // Expose authentication types, not tokens or credential copies.
  expect(connected.existingAccounts).toContainEqual({ provider: "fixture", name: "Fixture", type: "api_key" });
  expect(connected.accounts).toEqual([]); expect(JSON.stringify(connected)).not.toContain("private-existing-key");
});

test("Connection checks preserve saved accounts and return sanitized warnings on failure", async () => {
  // A provider authentication check must not block switching to a valid account.
  const failing = provider(), { manager } = await fixture([failing]);
  const account = await add(manager, "saved-account");
  failing.auth.apiKey!.check = async () => { throw new Error("private-provider-response"); };

  const listed = await manager.catalog("one");

  // Do not present unchecked connections as authenticated or silently omit them.
  expect(listed.accounts.map(account => account.id)).toContain(account.id);
  expect(listed.existingAccounts?.find(account => account.provider === "fixture")).toBeUndefined();
  expect(listed.warning).toContain("could not be checked"); expect(JSON.stringify(listed)).not.toContain("private-provider-response");
});

test("Environment authentication appears only while configured", async () => {
  // Use credentials that do not overlap other tests or user settings.
  const variable = "RADIAN_TEST_ACCOUNT_KEY", previous = process.env[variable], ambient = provider();
  ambient.auth.apiKey!.resolve = async ({ ctx, credential }) => {
    const key = credential?.key || await ctx.env(variable);
    return key ? { auth: { apiKey: key } } : undefined;
  };
  delete process.env[variable];
  try {
    const { manager } = await fixture([ambient]);
    expect((await manager.catalog("one")).existingAccounts?.find(account => account.provider === "fixture")).toBeUndefined();

    // Set and unset environment authentication without restarting.
    process.env[variable] = "private-environment-key";
    const connected = await manager.catalog("one");
    delete process.env[variable];
    const disconnected = await manager.catalog("one");

    // Reflect current credentials, not supported providers or stale caches.
    expect(connected.existingAccounts).toContainEqual({ provider: "fixture", name: "Fixture", type: "api_key" });
    expect(JSON.stringify(connected)).not.toContain("private-environment-key");
    expect(disconnected.existingAccounts?.find(account => account.provider === "fixture")).toBeUndefined();
  } finally { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; }
});

test("Workspace selections isolate authentication and survive reopening", async () => {
  // Use different keys for two accounts from the same provider.
  const { manager, directory } = await fixture(); const a = await add(manager, "key-a"), b = await add(manager, "key-b");

  // Save each workspace selection independently.
  expectOk(await select(manager, "one", a.id)); expectOk(await select(manager, "two", b.id));
  const one = await manager.workspace("one"), two = await manager.workspace("two");
  const reopened = expectOk(await AccountManager.open(directory, { offline: true, defaultCredentials: new InMemoryCredentialStore(), providers: [provider()] }));
  cleanups.push(async () => { expectOk(await reopened.stop()); });

  // SDK objects and request authentication remain workspace-scoped.
  expect(one.runtime).not.toBe(two.runtime); expect((await one.runtime.getAuth("fixture"))?.auth.apiKey).toBe("key-a");
  expect((await two.runtime.getAuth("fixture"))?.auth.apiKey).toBe("key-b"); expect((await reopened.catalog("one")).selections.fixture).toBe(a.id);
});

test("Deleting active accounts and stale updates fails until explicit deselection", async () => {
  // Select the same account in another workspace.
  const { manager } = await fixture(); const account = await add(manager, "shared"); expectOk(await select(manager, "two", account.id));
  const catalog = await manager.catalog("one");

  // Attempt deletion while in use and an update with a stale revision.
  const used = await manager.handle({ type: "delete", worktreeId: "one", accountId: account.id, revision: catalog.revision });
  const stale = await manager.handle({ type: "select", worktreeId: "one", provider: "fixture", accountId: account.id, revision: catalog.revision - 1 });

  // Never change other workspaces automatically; require explicit deselection.
  expect(expectError(used).code).toBe("ACCOUNT_IN_USE"); expect(expectError(stale).code).toBe("ACCOUNT_CONFLICT");
  expect((await manager.catalog("two")).selections.fixture).toBe(account.id);
  expectOk(await select(manager, "two", null));
  expectOk(await manager.handle({ type: "delete", worktreeId: "one", accountId: account.id, revision: (await manager.catalog("one")).revision }));
  expect((await manager.catalog("two")).accounts).toEqual([]);
});

test("Missing selected accounts do not silently fall back to default authentication", async () => {
  // Store valid default credentials alongside a missing explicit selection.
  const { manager, directory, defaults } = await fixture(); await defaults.modify("fixture", async () => ({ type: "api_key", key: "ambient" }));
  await writeFile(join(directory, "accounts.json"), JSON.stringify({ version: 1, revision: 1, accounts: [], selections: { one: { fixture: "missing" } } }));
  const reopened = expectOk(await AccountManager.open(directory, { offline: true, defaultCredentials: defaults, providers: [provider()] })); cleanups.push(async () => { expectOk(await reopened.stop()); });

  // Workspace initialization checks the missing explicit account.
  const view = await reopened.workspace("one");
  const result = view.runtime.getAuth("fixture");

  // Return an authentication failure instead of using environment credentials.
  await expect(result).rejects.toBeInstanceOf(Error); expect((await manager.catalog("one")).accounts).toEqual([]);
});

test("OAuth URLs and input stay within login operations and cancellation adds no account", async () => {
  // The provider emits a URL and waits for manual code input.
  const { manager, directory } = await fixture([provider(async interaction => {
    interaction.notify({ type: "auth_url", url: "https://example.test/authorize?state=private" });
    await interaction.prompt({ type: "manual_code", message: "Paste code" });
    return { type: "oauth", access: "secret-access", refresh: "secret-refresh", expires: Date.now() + 3600000 };
  })]);

  // Only the owning workspace can access or cancel the login.
  const view = login(expectOk(await manager.handle({ type: "login", worktreeId: "one", provider: "fixture", method: "oauth", label: "OAuth" })));
  const foreign = await manager.handle({ type: "poll", worktreeId: "two", flowId: view.id, revision: 0 });
  expectOk(await manager.handle({ type: "cancel", worktreeId: "one", flowId: view.id }));

  // URLs and codes never enter account lists or storage.
  expect(view.events[0]?.url).toContain("state=private"); expect(expectError(foreign).code).toBe("ACCOUNT_NOT_FOUND");
  expect((await manager.catalog("one")).accounts).toEqual([]); expect(JSON.stringify(await manager.catalog("one"))).not.toContain("state=private");
  const stored = await readFile(join(directory, "accounts.json"), "utf8"); expect(stored).not.toContain("state=private"); expect(stored).not.toContain("secret-access");
});

test("Concurrent OAuth refreshes run once and persist to the original account after switching", async () => {
  // Delay A's refresh while both workspaces refresh and one switches to B.
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let refreshed = 0, next = "a";
  const oauth = provider(async () => ({ type: "oauth", access: next, refresh: `refresh-${next}`, expires: 0 }));
  oauth.auth.oauth!.refresh = async credential => { refreshed++; started.resolve(); await release.promise; return { ...credential, access: `${credential.access}-new`, expires: Date.now() + 3600000 }; };
  const { manager, directory } = await fixture([oauth]);
  const a = await finish(manager, login(expectOk(await manager.handle({ type: "login", worktreeId: "one", provider: "fixture", method: "oauth", label: "A" }))));
  next = "b"; const b = await finish(manager, login(expectOk(await manager.handle({ type: "login", worktreeId: "one", provider: "fixture", method: "oauth", label: "B" }))));
  expectOk(await select(manager, "one", a.id)); expectOk(await select(manager, "two", a.id));
  const one = await manager.workspace("one"), two = await manager.workspace("two");

  // Switch only the first workspace to B while A's requests wait.
  const first = one.runtime.getAuth("fixture"), second = two.runtime.getAuth("fixture"); await started.promise;
  expectOk(await select(manager, "one", b.id)); release.resolve();
  const results = await Promise.all([first, second]);

  // Existing requests finish with A without overwriting B's tokens or selection.
  expect(refreshed).toBe(1); expect(results.map(result => result?.auth.apiKey)).toEqual(["a-new", "a-new"]);
  expect((await manager.catalog("one")).selections.fixture).toBe(b.id);
  const stored = JSON.parse(await readFile(join(directory, "accounts.json"), "utf8"));
  expect(stored.accounts.find((account: { id: string }) => account.id === b.id).credential.access).toBe("b");
});

test("Selection persistence failures preserve existing selection and authentication", async () => {
  // Block the destination with a directory to reproduce atomic rename failure.
  const { manager, directory } = await fixture(); const a = await add(manager, "key-a"), b = await add(manager, "key-b");
  expectOk(await select(manager, "one", a.id)); const target = join(directory, "accounts.json");
  await rm(target); await mkdir(target);

  // Do not apply an unsaved selection to active authentication.
  const changed = await select(manager, "one", b.id);

  expect(expectError(changed).code).toBe("STORAGE_FAILED"); expect((await manager.catalog("one")).selections.fixture).toBe(a.id);
  expect((await (await manager.workspace("one")).runtime.getAuth("fixture"))?.auth.apiKey).toBe("key-a");
});

test("OAuth persistence failures retain rotated tokens in memory and return warnings", async () => {
  // File persistence failure cannot undo remote token rotation.
  const oauth = provider(async () => ({ type: "oauth", access: "old", refresh: "old-refresh", expires: 0 }));
  oauth.auth.oauth!.refresh = async credential => ({ ...credential, access: "rotated", refresh: "rotated-refresh", expires: Date.now() + 3600000 });
  const { manager, directory } = await fixture([oauth]);
  const account = await finish(manager, login(expectOk(await manager.handle({ type: "login", worktreeId: "one", provider: "fixture", method: "oauth", label: "Rotating" }))));
  expectOk(await select(manager, "one", account.id)); const target = join(directory, "accounts.json"); await rm(target); await mkdir(target);

  // Return usable new tokens without claiming successful persistence.
  const auth = await (await manager.workspace("one")).runtime.getAuth("fixture");

  expect(auth?.auth.apiKey).toBe("rotated"); expect(manager.warning).toContain("saving failed");
  const listed = expectOk(await manager.handle({ type: "list", worktreeId: "one" })); if (listed.kind !== "catalog") throw new Error("Expected catalog");
  expect(listed.warning).toContain("in memory");
  await rm(target, { recursive: true }); expectOk(await select(manager, "one", account.id));
  expect(manager.warning).toBe(""); expect(await readFile(target, "utf8")).toContain("rotated-refresh");
});

test("Concurrent login popups start only one operation and reject empty labels", async () => {
  // A single operation owns the OAuth callback port and login input.
  const { manager } = await fixture();

  const results = await Promise.all(["one", "two"].map(worktreeId => manager.handle({ type: "login", worktreeId, provider: "fixture", method: "api_key", label: "New" })));
  const blank = await manager.handle({ type: "login", worktreeId: "one", provider: "fixture", method: "api_key", label: " " });

  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(results.filter(result => !result.ok).map(result => result.ok ? null : result.error.code)).toEqual(["ACCOUNT_CONFLICT"]);
  expect(expectError(blank).code).toBe("INVALID_INPUT");
});

test("OAuth installation identifiers remain stable across restarts", async () => {
  // Providers such as ChatGPT require a stable installation ID.
  const ids: string[] = [], oauth = provider(async () => ({ type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 3600000 }));
  oauth.auth.oauth!.login = async (_interaction, options) => { ids.push(options!.getDeviceId!()); return { type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 3600000 }; };
  const { manager, directory } = await fixture([oauth]);

  // Reopen the store and recreate SDK login options.
  await finish(manager, login(expectOk(await manager.handle({ type: "login", worktreeId: "one", provider: "fixture", method: "oauth", label: "First" }))));
  const reopened = expectOk(await AccountManager.open(directory, { offline: true, defaultCredentials: new InMemoryCredentialStore(), providers: [oauth] }));
  cleanups.push(async () => { expectOk(await reopened.stop()); });
  await finish(reopened, login(expectOk(await reopened.handle({ type: "login", worktreeId: "one", provider: "fixture", method: "oauth", label: "Second" }))));

  expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]); expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/u);
});

test("Pi default OAuth refreshes once on authentication requests, never during listing", async () => {
  // Keep default authentication in the SDK store, not Radian account files.
  let refreshed = 0;
  const oauth = provider(async () => ({ type: "oauth", access: "unused", refresh: "unused", expires: 0 }));
  oauth.auth.oauth!.refresh = async credential => { refreshed++; return { ...credential, access: "pi-new", expires: Date.now() + 3600000 }; };
  const { manager, defaults } = await fixture([oauth]);
  await defaults.modify("fixture", async () => ({ type: "oauth", access: "pi-old", refresh: "pi-refresh", expires: 0 }));

  // Listing expired OAuth credentials reports connections without rotating tokens.
  const listed = await manager.catalog("one");
  expect(listed.existingAccounts).toContainEqual({ provider: "fixture", name: "Fixture", type: "oauth" });
  const one = await manager.workspace("one"), two = await manager.workspace("two"); expect(refreshed).toBe(0);
  const auth = await Promise.all([one.runtime.getAuth("fixture"), two.runtime.getAuth("fixture")]);

  expect(refreshed).toBe(1); expect(auth.map(result => result?.auth.apiKey)).toEqual(["pi-new", "pi-new"]);
  expect((await defaults.read("fixture"))?.type).toBe("oauth"); expect((await manager.catalog("one")).accounts).toEqual([]);
});

test("OAuth refresh errors never expose SDK tokens at the model boundary", async () => {
  // Some SDK providers embed remote response bodies in plain errors; sanitize them here.
  const oauth = provider(async () => ({ type: "oauth", access: "private-access", refresh: "private-refresh", expires: 0 }));
  oauth.auth.oauth!.refresh = async () => { throw new Error("Remote failure: private-access private-refresh"); };
  const { manager } = await fixture([oauth]);
  const account = await finish(manager, login(expectOk(await manager.handle({ type: "login", worktreeId: "one", provider: "fixture", method: "oauth", label: "Redacted" }))));
  expectOk(await select(manager, "one", account.id));

  // Remove secrets from top-level authentication errors shown in UI and conversations.
  const view = await manager.workspace("one");
  let message = "";
  try { await view.runtime.getAuth("fixture"); } catch (error) { if (!(error instanceof Error)) throw error; message = error.message; }

  expect(message).toContain("Could not refresh"); expect(message).not.toContain("private-access"); expect(message).not.toContain("private-refresh");
});

test("Duplicate remote OAuth accounts neither save under new names nor overwrite selections", async () => {
  // Stable SDK account IDs must not acquire multiple refresh owners.
  const oauth = provider(async () => ({ type: "oauth", accountId: "remote-account", access: "access", refresh: "refresh", expires: Date.now() + 3600000 }));
  const { manager } = await fixture([oauth]);
  const account = await finish(manager, login(expectOk(await manager.handle({ type: "login", worktreeId: "one", provider: "fixture", method: "oauth", label: "Original" }))));
  expectOk(await select(manager, "one", account.id));

  let duplicate = login(expectOk(await manager.handle({ type: "login", worktreeId: "two", provider: "fixture", method: "oauth", label: "Duplicate" })));
  while (duplicate.status === "pending") duplicate = login(expectOk(await manager.handle({ type: "poll", worktreeId: "two", flowId: duplicate.id, revision: duplicate.revision })));

  expect(duplicate.status).toBe("error"); expect(duplicate.error).toContain("already saved");
  expect((await manager.catalog("one")).accounts).toHaveLength(1); expect((await manager.catalog("one")).selections.fixture).toBe(account.id);
});

test("Personalized model lists never reuse another account's persisted cache", async () => {
  // Add account-scoped storage around the SDK's provider-scoped cache.
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

  // Save A's list, switch to B, then return to A.
  expectOk(await select(manager, "one", a.id));
  await manager.request("one", runtime => runtime.refresh({ providers: ["fixture"], allowNetwork: true }));
  const view = await manager.workspace("one"); expect(view.runtime.getModels("fixture").map(model => model.id)).toEqual(["model-A"]);
  expectOk(await select(manager, "one", b.id)); expect(view.runtime.getModels("fixture")).toEqual([]);
  await manager.request("one", runtime => runtime.refresh({ providers: ["fixture"], allowNetwork: true }));
  expect(view.runtime.getModels("fixture").map(model => model.id)).toEqual(["model-B"]);
  expectOk(await select(manager, "one", a.id));

  // Restore model lists only from the matching account's metadata.
  expect(view.runtime.getModels("fixture").map(model => model.id)).toEqual(["model-A"]);
});

test("OAuth credentials with empty refresh tokens preserve the SDK format", async () => {
  // The SDK may use empty refresh strings for non-expiring OAuth credentials.
  const oauth = provider(async () => ({ type: "oauth", access: "provider-access", refresh: "", expires: Number.MAX_SAFE_INTEGER }));
  const { manager, directory } = await fixture([oauth]);

  const account = await finish(manager, login(expectOk(await manager.handle({ type: "login", worktreeId: "one", provider: "fixture", method: "oauth", label: "No refresh token" }))));
  expectOk(await select(manager, "one", account.id));

  expect(account.type).toBe("oauth"); expect((await (await manager.workspace("one")).runtime.getAuth("fixture"))?.auth.apiKey).toBe("provider-access");
  const stored = JSON.parse(await readFile(join(directory, "accounts.json"), "utf8")); expect(stored.accounts[0].credential).toMatchObject({ type: "oauth", refresh: "" });
});
