import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider, InMemoryCredentialStore, type Credential } from "@earendil-works/pi-ai";
import { AccountManager } from "./manager.ts";
import type { ProviderUsage, UsageGroupSubscription } from "../usage/model.ts";
import { expectOk } from "../testing/results.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const oauth = (access: string, expires = Date.now() + 3600000): Credential => ({
  type: "oauth",
  access,
  refresh: `refresh-${access}`,
  expires,
});
const account = (id: string, access: string, expires?: number) => ({
  id,
  provider: "anthropic",
  label: id,
  credential: oauth(`sk-ant-oat01-${access}`, expires),
});
const openAiToken = `header.${Buffer.from(
  JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "fixture-openai-account" },
  }),
).toString("base64url")}.signature`;

type StoredAccount = ReturnType<typeof account>;
type FetchCall = { url: string; authorization: string | null };
type Usage = Readonly<Record<string, ProviderUsage>>;

async function fixture(
  options: {
    accounts?: StoredAccount[];
    selections?: Record<string, Record<string, string>>;
    defaults?: Record<string, Credential>;
    onFetch?: (call: FetchCall) => Promise<void>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "radian-account-usage-"));
  await writeFile(
    join(directory, "accounts.json"),
    JSON.stringify({
      version: 1,
      revision: 0,
      accounts: options.accounts ?? [],
      selections: options.selections ?? {},
    }),
    { mode: 0o600 },
  );
  const defaults = new InMemoryCredentialStore();
  for (const [provider, credential] of Object.entries(options.defaults ?? {})) {
    await defaults.modify(provider, async () => credential);
  }
  const providers = ["anthropic", "openai-codex"].map((id) =>
    createProvider({
      id,
      name: id,
      models: [],
      auth: {
        oauth: {
          name: "OAuth",
          login: async () => {
            throw new Error("No interactive login expected");
          },
          refresh: async (credential) => ({
            ...credential,
            access: `${credential.access}-renewed`,
            expires: Date.now() + 3600000,
          }),
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
      api: {
        stream: () => {
          throw new Error("No inference request expected");
        },
        streamSimple: () => {
          throw new Error("No inference request expected");
        },
      },
    }),
  );
  const calls: FetchCall[] = [];
  const manager = expectOk(
    await AccountManager.open(directory, {
      offline: true,
      defaultCredentials: defaults,
      providers,
      usageFetch: async (url, request) => {
        const authorization = new Headers(request.headers).get("authorization");
        calls.push({ url, authorization });
        await options.onFetch?.({ url, authorization });
        if (url === "https://api.anthropic.com/api/oauth/usage") {
          const used = authorization?.includes("second")
            ? 37
            : authorization?.includes("default")
              ? 63
              : 12;

          return Response.json({
            five_hour: { utilization: 4, resets_at: new Date(Date.now() + 3600000).toISOString() },
            seven_day: {
              utilization: used,
              resets_at: new Date(Date.now() + 86400000).toISOString(),
            },
          });
        }
        if (url === "https://chatgpt.com/backend-api/wham/usage") {
          return Response.json({
            rate_limit: {
              secondary_window: {
                used_percent: 21,
                limit_window_seconds: 604800,
                reset_at: Math.floor(Date.now() / 1000) + 86400,
              },
            },
          });
        }

        throw new Error(`Unexpected quota endpoint: ${url}`);
      },
    }),
  );
  cleanups.push(async () => {
    expectOk(await manager.stop());
    await rm(directory, { recursive: true, force: true });
  });

  return { directory, manager, calls, defaults };
}

async function observe(manager: AccountManager, worktreeId = "one") {
  const view = await manager.workspace(worktreeId);
  const waiting = new Set<{
    accepts: (value: Usage) => boolean;
    resolve: (value: Usage) => void;
  }>();
  let subscription: UsageGroupSubscription;
  subscription = view.usage.watchAll(() => {
    const value = subscription.read();
    for (const waiter of waiting) {
      if (waiter.accepts(value)) {
        waiting.delete(waiter);
        waiter.resolve(value);
      }
    }
  });
  cleanups.push(async () => subscription.dispose());

  return {
    view,
    subscription,
    until(accepts: (value: Usage) => boolean): Promise<Usage> {
      const value = subscription.read();
      if (accepts(value)) {
        return Promise.resolve(value);
      }
      const result = Promise.withResolvers<Usage>();
      waiting.add({ accepts, resolve: result.resolve });

      return result.promise;
    },
  };
}

const weekly = (usage: ProviderUsage | undefined) =>
  usage?.windows.find((window) => window.periodMs === 604800000)?.usedPercent;

test("Connected default subscriptions report Claude and OpenAI usage without an active model", async () => {
  // Each connected OAuth provider has its own source and normalized account windows.
  const { manager, calls } = await fixture({
    defaults: {
      anthropic: oauth("sk-ant-oat01-claude-default"),
      "openai-codex": oauth(openAiToken),
    },
  });
  const observer = await observe(manager);

  const value = await observer.until(
    (snapshots) =>
      snapshots.anthropic?.status === "ready" && snapshots["openai-codex"]?.status === "ready",
  );

  // Discovery must not require switching models or send either credential to the other endpoint.
  expect(weekly(value.anthropic)).toBe(63);
  expect(weekly(value["openai-codex"])).toBe(21);
  expect(calls).toHaveLength(2);
  expect(calls.find((call) => call.url.includes("anthropic"))?.authorization).toBe(
    "Bearer sk-ant-oat01-claude-default",
  );
  expect(calls.find((call) => call.url.includes("chatgpt"))?.authorization).toBe(
    `Bearer ${openAiToken}`,
  );
  expect(JSON.stringify(value)).not.toMatch(
    /claude-default|fixture-openai-account|authorization|refresh-/u,
  );
});

test("Saved but unselected Claude accounts expose usage without activating request authentication", async () => {
  // The oldest saved connection supplies passive quota when no selected or default connection exists.
  const { manager, calls } = await fixture({ accounts: [account("personal", "first-account")] });
  const observer = await observe(manager);

  const value = await observer.until((snapshots) => snapshots.anthropic?.status === "ready");

  expect(weekly(value.anthropic)).toBe(12);
  expect(calls[0]?.authorization).toBe("Bearer sk-ant-oat01-first-account");
  expect((await manager.catalog("one")).selections).toEqual({});
  expect(await observer.view.runtime.getAuth("anthropic")).toBeUndefined();
});

test("Selected Claude accounts override defaults without changing another workspace's quota", async () => {
  // Both workspaces share saved credentials, but only one explicitly selects a named account.
  const { manager } = await fixture({
    accounts: [account("personal", "first-account"), account("team", "second-account")],
    selections: { one: { anthropic: "team" } },
    defaults: { anthropic: oauth("sk-ant-oat01-claude-default") },
  });
  const one = await observe(manager, "one");
  const two = await observe(manager, "two");
  await one.until((value) => weekly(value.anthropic) === 37);
  await two.until((value) => weekly(value.anthropic) === 63);

  // An accepted selection refreshes only that workspace's account-bound usage.
  expectOk(
    await manager.handle({
      type: "select",
      worktreeId: "one",
      provider: "anthropic",
      accountId: "personal",
      revision: (await manager.catalog("one")).revision,
    }),
  );
  const changed = await one.until((value) => weekly(value.anthropic) === 12);

  expect(weekly(changed.anthropic)).toBe(12);
  expect(weekly(two.subscription.read().anthropic)).toBe(63);
  expect((await manager.catalog("one")).selections.anthropic).toBe("personal");
  expect((await manager.catalog("two")).selections).toEqual({});
});

test("Deleting the displayed fallback account retains other accounts and replaces its quota", async () => {
  // Multiple stored accounts for one service still render one passive quota source.
  const { manager, calls } = await fixture({
    accounts: [account("personal", "first-account"), account("team", "second-account")],
  });
  const observer = await observe(manager);
  await observer.until((value) => weekly(value.anthropic) === 12);

  expectOk(
    await manager.handle({
      type: "delete",
      worktreeId: "one",
      accountId: "personal",
      revision: (await manager.catalog("one")).revision,
    }),
  );
  const value = await observer.until((snapshots) => weekly(snapshots.anthropic) === 37);

  // Removing one connection must not delete another or leave the old account's percentage visible.
  expect(weekly(value.anthropic)).toBe(37);
  expect((await manager.catalog("one")).accounts.map((entry) => entry.id)).toEqual(["team"]);
  expect(calls.map((call) => call.authorization)).toEqual([
    "Bearer sk-ant-oat01-first-account",
    "Bearer sk-ant-oat01-second-account",
  ]);
});

test.each(["default", "named"] as const)(
  "The same Claude %s account shares quota requests and cooldowns across workspaces",
  async (kind) => {
    // A new worktree is not a new provider account or permission to bypass its request limit.
    const { manager, calls } = await fixture(
      kind === "default"
        ? { defaults: { anthropic: oauth("sk-ant-oat01-first-account") } }
        : {
            accounts: [account("personal", "first-account")],
            selections: { one: { anthropic: "personal" }, two: { anthropic: "personal" } },
          },
    );
    const [one, two] = await Promise.all([observe(manager, "one"), observe(manager, "two")]);

    await Promise.all([
      one.until((value) => weekly(value.anthropic) === 12),
      two.until((value) => weekly(value.anthropic) === 12),
    ]);
    one.subscription.refresh("manual");
    two.subscription.refresh("manual");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(calls).toHaveLength(1);
    expect(weekly(one.subscription.read().anthropic)).toBe(12);
    expect(weekly(two.subscription.read().anthropic)).toBe(12);
  },
);

test("Discovering a new default connection replaces the saved fallback despite an unchanged provider list", async () => {
  // Both identities belong to the same provider, so watching provider names alone cannot detect the change.
  const { manager, defaults } = await fixture({ accounts: [account("personal", "first-account")] });
  const observer = await observe(manager);
  await observer.until((value) => weekly(value.anthropic) === 12);

  await defaults.modify("anthropic", async () => oauth("sk-ant-oat01-claude-default"));
  await manager.catalog("one");
  const value = await observer.until((snapshots) => weekly(snapshots.anthropic) === 63);

  expect(weekly(value.anthropic)).toBe(63);
  expect((await manager.catalog("one")).selections).toEqual({});
});

test("Removing default authentication rejects its late quota response and immediately uses the saved fallback", async () => {
  // The default account's request is still pending when discovery switches to a different saved account.
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { manager, defaults } = await fixture({
    accounts: [account("personal", "first-account")],
    defaults: { anthropic: oauth("sk-ant-oat01-claude-default") },
    onFetch: async ({ authorization }) => {
      if (authorization?.includes("default")) {
        started.resolve();
        await release.promise;
      }
    },
  });
  const observer = await observe(manager);
  try {
    observer.subscription.read();
    await started.promise;

    await defaults.delete("anthropic");
    await manager.catalog("one");
    const value = await observer.until((snapshots) => weekly(snapshots.anthropic) === 12);
    release.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    // A late success for the old account cannot replace the new account's known usage.
    expect(weekly(value.anthropic)).toBe(12);
    expect(weekly(observer.subscription.read().anthropic)).toBe(12);
    expect((await manager.catalog("one")).selections).toEqual({});
  } finally {
    release.resolve();
  }
});

test("Quota lookup refreshes expired saved OAuth without selecting the account or leaking its token", async () => {
  // Credential rotation uses the existing SDK store boundary, not a usage-specific token refresh flow.
  const { manager, directory, calls } = await fixture({
    accounts: [account("personal", "first-account", 0)],
  });
  const observer = await observe(manager);

  const value = await observer.until((snapshots) => snapshots.anthropic?.status === "ready");
  const stored = JSON.parse(await readFile(join(directory, "accounts.json"), "utf8"));

  expect(weekly(value.anthropic)).toBe(12);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.authorization).toBe("Bearer sk-ant-oat01-first-account-renewed");
  expect(stored.accounts[0].credential.access).toBe("sk-ant-oat01-first-account-renewed");
  expect((await manager.catalog("one")).selections).toEqual({});
  expect(JSON.stringify(value)).not.toContain("first-account");
});
