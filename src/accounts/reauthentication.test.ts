import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createProvider,
  InMemoryCredentialStore,
  type Credential,
  type OAuthCredential,
  type ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { AccountManager } from "./manager.ts";
import { accountRequestSchema, type AccountReply, type LoginView } from "./model.ts";
import { Value } from "typebox/value";
import { RuntimeClient } from "../runtime/client.ts";
import { runtimePaths } from "../runtime/storage.ts";
import { emptyPreferences, protocolVersion } from "../runtime/protocol.ts";
import { rejected } from "../runtime/repository-host.ts";
import { expectError, expectOk } from "../testing/results.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const oauth = (
  access: string,
  accountId: string | null = "remote-a",
  expires = Date.now() + 3600000,
): OAuthCredential => ({
  type: "oauth",
  access: `sk-ant-oat01-${access}`,
  refresh: `refresh-${access}`,
  expires,
  ...(accountId ? { accountId } : {}),
});

async function fixture(
  options: {
    provider?: string;
    credential?: Credential;
    selections?: Record<string, Record<string, string>>;
    login?: (interaction: ProviderAuthInteraction) => Promise<OAuthCredential>;
    refresh?: (credential: OAuthCredential) => Promise<OAuthCredential>;
    fetch?: () => Promise<Response>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "radian-reauth-"));
  const providerId = options.provider ?? "anthropic";
  const accounts = [
    {
      id: "a",
      provider: providerId,
      label: "Personal",
      credential: options.credential ?? oauth("old"),
    },
    { id: "b", provider: providerId, label: "Work", credential: oauth("work", "remote-b") },
  ];
  await writeFile(
    join(directory, "accounts.json"),
    JSON.stringify({
      version: 1,
      deviceId: crypto.randomUUID(),
      revision: 1,
      accounts,
      selections: options.selections ?? { one: { [providerId]: "a" }, two: { [providerId]: "a" } },
    }),
  );
  let calls = 0;
  let probes = 0;
  const provider = createProvider({
    id: providerId,
    name: "Fixture",
    models: [],
    auth: {
      oauth: {
        name: "OAuth",
        login: async (interaction) => {
          calls++;
          return options.login ? options.login(interaction) : oauth("new");
        },
        refresh:
          options.refresh ??
          (async (credential) => ({
            ...credential,
            access: `${credential.access}-rotated`,
            expires: Date.now() + 3600000,
          })),
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
    api: {
      stream: () => {
        throw new Error("No inference expected");
      },
      streamSimple: () => {
        throw new Error("No inference expected");
      },
    },
  });
  const manager = expectOk(
    await AccountManager.open(directory, {
      offline: true,
      providers: [provider],
      defaultCredentials: new InMemoryCredentialStore(),
      usageFetch: async () => {
        probes++;
        return options.fetch
          ? options.fetch()
          : Response.json({
              five_hour: {
                utilization: 5,
                resets_at: new Date(Date.now() + 3600000).toISOString(),
              },
            });
      },
    }),
  );
  cleanups.push(async () => {
    expectOk(await manager.stop());
    await rm(directory, { recursive: true, force: true });
  });

  return { manager, directory, providerId, calls: () => calls, probes: () => probes };
}

function login(reply: AccountReply): LoginView {
  if (reply.kind !== "login") throw new Error("Expected login");
  return reply.login;
}

async function current(manager: AccountManager, view: LoginView): Promise<LoginView> {
  while (view.status === "pending" && !view.prompt) {
    view = login(
      expectOk(
        await manager.handle({
          type: "poll",
          worktreeId: "one",
          flowId: view.id,
          revision: view.revision,
        }),
      ),
    );
  }
  return view;
}

async function start(
  manager: AccountManager,
  provider = "anthropic",
  type: "reauthenticate" | "check" = "reauthenticate",
  accountId = "a",
) {
  return manager.handle({
    type,
    worktreeId: "one",
    provider,
    accountId,
    revision: manager.revision,
  });
}

async function answer(manager: AccountManager, view: LoginView, value: string) {
  return current(
    manager,
    login(
      expectOk(
        await manager.handle({
          type: "answer",
          worktreeId: "one",
          flowId: view.id,
          promptId: view.prompt!.id,
          value,
        }),
      ),
    ),
  );
}

async function access(manager: AccountManager, provider = "anthropic", worktree = "one") {
  return manager.request(
    worktree,
    async (runtime) => (await runtime.getAuth(provider))?.auth.apiKey,
  );
}

test("Manual reauthentication preserves IDs, labels, selections and notifies every selected consumer", async () => {
  // Both worktrees share the same managed account, but credential replacement is not selection.
  const { manager, directory } = await fixture();
  const one = await manager.workspace("one");
  const two = await manager.workspace("two");
  const notifications: string[] = [];
  one.listeners.add((provider) => notifications.push(`one:${provider}`));
  two.listeners.add((provider) => notifications.push(`two:${provider}`));

  const result = await current(manager, login(expectOk(await start(manager))));

  // The same local entry is updated and persisted without exposing the new secret in the view.
  expect(result.status).toBe("complete");
  expect(result.intent).toBe("reauthenticate");
  expect(result.account).toMatchObject({ id: "a", label: "Personal", usedBy: ["one", "two"] });
  expect((await manager.catalog("one")).accounts).toHaveLength(2);
  expect((await manager.catalog("two")).selections).toEqual({ anthropic: "a" });
  expect(await access(manager)).toBe("sk-ant-oat01-new");
  expect(notifications.sort()).toEqual(["one:anthropic", "two:anthropic"]);
  expect(await readFile(join(directory, "accounts.json"), "utf8")).toContain("refresh-new");
  expect(JSON.stringify(result)).not.toContain("sk-ant-oat01-new");
});

test("Manual reauthentication can replace an inactive account without switching it or passive consumers", async () => {
  // An unselected fallback workspace must observe replacement without becoming explicitly selected.
  const { manager } = await fixture({ selections: { one: { anthropic: "b" }, two: {} } });
  const passive = await manager.workspace("two");
  const notifications: string[] = [];
  passive.listeners.add((provider) => notifications.push(provider));

  const result = await current(manager, login(expectOk(await start(manager))));

  expect(result.status).toBe("complete");
  expect((await manager.catalog("one")).selections).toEqual({ anthropic: "b" });
  expect((await manager.catalog("two")).selections).toEqual({});
  expect(await access(manager)).toBe("sk-ant-oat01-work");
  expect(notifications).toEqual(["anthropic"]);
});

test.each([
  ["different remote user", "remote-other"],
  ["another stored user", "remote-b"],
])("Reauthentication rejects %s without replacing the credential", async (_name, identity) => {
  // Known identities cannot be overridden even by explicit manual reauthentication.
  const { manager } = await fixture({ login: async () => oauth("wrong", identity) });

  const result = await current(manager, login(expectOk(await start(manager))));

  expect(result.status).toBe("error");
  expect(result.error).toContain("different remote account");
  expect(await access(manager)).toBe("sk-ant-oat01-old");
});

test.each(["keep", "replace"])(
  "Missing remote identity requires explicit %s confirmation",
  async (choice) => {
    // Claude's SDK may omit accountId; omission must never silently authorize replacement.
    const { manager } = await fixture({ login: async () => oauth("unverified", null) });
    const pending = await current(manager, login(expectOk(await start(manager))));
    expect(pending.prompt?.type).toBe("select");
    expect(pending.prompt?.message).toContain("cannot verify");
    expect(await access(manager)).toBe("sk-ant-oat01-old");

    const result = await answer(manager, pending, choice);

    expect(result.status).toBe(choice === "replace" ? "complete" : "cancelled");
    expect(await access(manager)).toBe(
      choice === "replace" ? "sk-ant-oat01-unverified" : "sk-ant-oat01-old",
    );
  },
);

test("A missing old identity also requires confirmation and rejects duplicate known identities", async () => {
  // Knowing only the new identity is insufficient, and another saved identity remains reserved.
  const { manager } = await fixture({
    credential: oauth("old", null),
    login: async () => oauth("duplicate", "remote-b"),
  });
  const pending = await current(manager, login(expectOk(await start(manager))));

  const result = await answer(manager, pending, "replace");

  expect(result.status).toBe("error");
  expect(result.error).toContain("already saved");
  expect(await access(manager)).toBe("sk-ant-oat01-old");
});

test("Cancellation before confirmation retains the old credential and late provider completion cannot add an account", async () => {
  // Browser completion may arrive after the popup was cancelled.
  const remote = Promise.withResolvers<OAuthCredential>();
  const { manager } = await fixture({ login: async () => remote.promise });
  const view = login(expectOk(await start(manager)));

  const cancelled = login(
    expectOk(await manager.handle({ type: "cancel", worktreeId: "one", flowId: view.id })),
  );
  remote.resolve(oauth("late"));
  await Promise.resolve();

  expect(cancelled.status).toBe("cancelled");
  expect(await access(manager)).toBe("sk-ant-oat01-old");
  expect((await manager.catalog("one")).accounts).toHaveLength(2);
});

test("A newer SDK rotation during browser login wins over a stale reauthentication result", async () => {
  // Browser interaction must not hold the account lock or prevent normal request refresh.
  const remote = Promise.withResolvers<OAuthCredential>();
  const { manager } = await fixture({
    credential: oauth("old", "remote-a", 0),
    login: async () => remote.promise,
  });
  const pending = login(expectOk(await start(manager)));
  expect(await access(manager)).toBe("sk-ant-oat01-old-rotated");

  remote.resolve(oauth("stale"));
  const result = await current(manager, pending);

  expect(result.status).toBe("error");
  expect(result.error).toContain("newer credential was retained");
  expect(await access(manager)).toBe("sk-ant-oat01-old-rotated");
});

test("Cancellation while replacement waits for an SDK refresh lock cannot overwrite the rotated token", async () => {
  // The browser flow may finish while another request still owns the credential write lock.
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { manager } = await fixture({
    credential: oauth("old", "remote-a", 0),
    refresh: async (credential) => {
      entered.resolve();
      await release.promise;
      return { ...credential, access: "sk-ant-oat01-rotated", expires: Date.now() + 3600000 };
    },
  });
  const refreshing = access(manager);
  await entered.promise;
  const pending = login(expectOk(await start(manager)));

  const result = login(
    expectOk(await manager.handle({ type: "cancel", worktreeId: "one", flowId: pending.id })),
  );
  release.resolve();

  expect(result.status).toBe("cancelled");
  expect(await refreshing).toBe("sk-ant-oat01-rotated");
  expect(await access(manager)).toBe("sk-ant-oat01-rotated");
});

test("Deleting a non-active target during browser login cannot resurrect it", async () => {
  // Local deletion is allowed while the provider interaction is outstanding.
  const remote = Promise.withResolvers<OAuthCredential>();
  const { manager } = await fixture({
    selections: { one: { anthropic: "b" } },
    login: async () => remote.promise,
  });
  const pending = login(expectOk(await start(manager)));
  expectOk(
    await manager.handle({
      type: "delete",
      worktreeId: "one",
      accountId: "a",
      revision: manager.revision,
    }),
  );

  remote.resolve(oauth("late"));
  const result = await current(manager, pending);

  expect(result.status).toBe("error");
  expect(result.error).toContain("deleted");
  expect((await manager.catalog("one")).accounts.map((account) => account.id)).toEqual(["b"]);
});

test("Renaming during reauthentication preserves the latest label and every selection", async () => {
  // Label updates do not invalidate the captured credential version.
  const remote = Promise.withResolvers<OAuthCredential>();
  const { manager } = await fixture({ login: async () => remote.promise });
  const pending = login(expectOk(await start(manager)));
  expectOk(
    await manager.handle({
      type: "rename",
      worktreeId: "one",
      provider: "anthropic",
      accountId: "a",
      label: "Renamed",
      revision: manager.revision,
    }),
  );

  remote.resolve(oauth("new"));
  const result = await current(manager, pending);

  expect(result.status).toBe("complete");
  expect(result.account?.label).toBe("Renamed");
  expect((await manager.catalog("two")).selections).toEqual({ anthropic: "a" });
});

test("Accepted replacement survives persistence failure with an authoritative in-memory credential and warning", async () => {
  // Force only the local write to fail after remote login has already succeeded.
  const remote = Promise.withResolvers<OAuthCredential>();
  const { manager, directory } = await fixture({ login: async () => remote.promise });
  const pending = login(expectOk(await start(manager)));
  const target = join(directory, "accounts.json");
  await rm(target);
  await mkdir(target);
  try {
    remote.resolve(oauth("accepted"));
    const result = await current(manager, pending);
    const cancelled = login(
      expectOk(await manager.handle({ type: "cancel", worktreeId: "one", flowId: result.id })),
    );

    // A completed remote action is never described as cancelled or rolled back.
    expect(result.status).toBe("complete");
    expect(result.warning).toContain("in memory");
    expect(cancelled.status).toBe("complete");
    expect(await access(manager)).toBe("sk-ant-oat01-accepted");
    expect(manager.warning).toContain("saving failed");
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test.each(["check", "reauthenticate"] as const)(
  "%s rejects stale revision, wrong provider and API keys",
  async (type) => {
    // IPC schemas constrain shape; manager also enforces current target semantics.
    const { manager, calls } = await fixture({
      credential: { type: "api_key", key: "private-key" },
    });

    const stale = await manager.handle({
      type,
      worktreeId: "one",
      provider: "anthropic",
      accountId: "a",
      revision: 0,
    });
    const wrong = await start(manager, "other", type);
    const apiKey = await start(manager, "anthropic", type);

    expect(expectError(stale).code).toBe("ACCOUNT_CONFLICT");
    expect(expectError(wrong).code).toBe("ACCOUNT_NOT_FOUND");
    expect(expectError(apiKey).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(calls()).toBe(0);
  },
);

test("Automatic checks reject inactive targets rather than probing fallback or external accounts", async () => {
  // Passive usage is not permission to reauthenticate a saved but unselected account.
  const { manager, probes, calls } = await fixture({ selections: {} });

  const result = await start(manager, "anthropic", "check");

  expect(expectError(result).code).toBe("ACCOUNT_CONFLICT");
  expect(probes()).toBe(0);
  expect(calls()).toBe(0);
});

test.each([200, 401, 403, 429, 500])(
  "Automatic Claude assessment handles HTTP %i without treating generic failure as authentication loss",
  async (status) => {
    // Only a confirmed post-resolution 401 starts the SDK browser flow.
    const { manager, calls } = await fixture({
      fetch: async () =>
        status === 200
          ? Response.json({
              five_hour: {
                utilization: 5,
                resets_at: new Date(Date.now() + 3600000).toISOString(),
              },
            })
          : new Response("private remote response", { status }),
    });

    const result = expectOk(await start(manager, "anthropic", "check"));

    expect(result.kind).toBe(status === 401 ? "login" : "catalog");
    if (result.kind === "catalog") {
      expect(Boolean(result.warning)).toBe(status !== 200);
      expect(JSON.stringify(result)).not.toContain("private remote response");
    }
    expect(calls()).toBe(status === 401 ? 1 : 0);
  },
);

test("Failed SDK getAuth is indeterminate and does not start reauthentication", async () => {
  // A refresh error is not evidence of a rejected access token from the usage endpoint.
  const { manager, probes, calls } = await fixture({
    credential: oauth("expired", "remote-a", 0),
    refresh: async () => {
      throw new Error("private-refresh-token");
    },
  });

  const result = expectOk(await start(manager, "anthropic", "check"));

  expect(result.kind).toBe("catalog");
  if (result.kind === "catalog") expect(result.warning).toBeTruthy();
  expect(JSON.stringify(result)).not.toContain("private-refresh-token");
  expect(calls()).toBe(0);
  expect(probes()).toBe(0);
});

test("Missing resolved OAuth credentials start the existing account recovery flow", async () => {
  // A confirmed missing credential is different from an opaque SDK failure.
  const gate = Promise.withResolvers<OAuthCredential>();
  const { manager, calls } = await fixture({ login: () => gate.promise });
  const view = await manager.workspace("one");
  const missing = spyOn(view.runtime, "getAuth").mockResolvedValue(undefined);
  try {
    const result = login(
      expectOk(
        await manager.handle({
          type: "check",
          worktreeId: "one",
          provider: "anthropic",
          accountId: "a",
          revision: manager.revision,
        }),
      ),
    );

    expect(result.intent).toBe("reauthenticate");
    expect(calls()).toBe(1);
    gate.resolve(oauth("new"));
    expect((await current(manager, result)).account?.id).toBe("a");
    expect((await manager.catalog("one")).accounts).toHaveLength(2);
  } finally {
    missing.mockRestore();
    gate.resolve(oauth("new"));
  }
});

test("An initiating request abort cancels recovery until the client acknowledges the flow", async () => {
  // Receipt ownership must prevent any remote interaction while the reply can still be lost.
  const caller = new AbortController();
  const gate = Promise.withResolvers<OAuthCredential>();
  const { manager, directory, calls } = await fixture({
    fetch: async () => new Response(null, { status: 401 }),
    login: async () => gate.promise,
  });
  const before = await readFile(join(directory, "accounts.json"), "utf8");
  const flow = login(
    expectOk(
      await manager.handle(
        {
          type: "check",
          worktreeId: "one",
          provider: "anthropic",
          accountId: "a",
          revision: manager.revision,
        },
        caller.signal,
      ),
    ),
  );

  expect(flow.status).toBe("pending");
  expect(calls()).toBe(0);
  caller.abort();
  const cancelled = login(
    expectOk(
      await manager.handle({
        type: "poll",
        worktreeId: "one",
        flowId: flow.id,
        revision: flow.revision,
      }),
    ),
  );
  expect(cancelled.status).toBe("cancelled");
  expect(calls()).toBe(0);
  gate.resolve(oauth("late"));
  await manager.stop();
  expect(await readFile(join(directory, "accounts.json"), "utf8")).toBe(before);
});

test("Acknowledged recovery outlives the initiating request and retains its own cancellation", async () => {
  // Normal request timeouts must not cancel an interactive flow that the client already adopted.
  const caller = new AbortController();
  let providerSignal: AbortSignal | undefined;
  const { manager } = await fixture({
    login: async (interaction) => {
      providerSignal = interaction.signal;
      await interaction.prompt({ type: "manual_code", message: "Fixture code" });
      return oauth("new");
    },
  });
  const flow = login(
    expectOk(
      await manager.handle(
        {
          type: "reauthenticate",
          worktreeId: "one",
          provider: "anthropic",
          accountId: "a",
          revision: manager.revision,
        },
        caller.signal,
      ),
    ),
  );
  const acknowledged = login(
    expectOk(
      await manager.handle({
        type: "poll",
        worktreeId: "one",
        flowId: flow.id,
        revision: 0,
      }),
    ),
  );
  expect(acknowledged.prompt).toBeDefined();
  caller.abort();
  expect(providerSignal?.aborted).toBe(false);

  expectOk(await manager.handle({ type: "cancel", worktreeId: "one", flowId: flow.id }));
  expect(providerSignal?.aborted).toBe(true);
});

test("Real account IPC hands off confirmed recovery and replaces the same account", async () => {
  // A synthetic provider still exercises actual Unix-socket response delivery and follow-up ownership.
  const { manager, directory, calls } = await fixture({
    fetch: async () => new Response(null, { status: 401 }),
    login: async (interaction) => {
      await interaction.prompt({
        type: "manual_code",
        message: "Enter fixture authorization code",
      });
      return oauth("ipc-renewed");
    },
  });
  const paths = runtimePaths("reauth-ipc", true, directory);
  await mkdir(dirname(paths.socket), { recursive: true, mode: 0o700 });
  const server = Bun.serve({
    unix: paths.socket,
    fetch: async (request) => {
      const input: unknown = await request.json();
      if (!Value.Check(accountRequestSchema, input)) return new Response(null, { status: 400 });
      const result = await manager.handle(input, request.signal);
      return result.ok ? Response.json(result.value) : rejected(result.error);
    },
  });
  const client = new RuntimeClient(paths, {
    version: protocolVersion,
    pid: process.pid,
    instance: "fixture",
    repositoryId: "reauth-ipc",
    mode: "offline",
    repositories: [],
    details: {},
    closingCount: 0,
    preferences: structuredClone(emptyPreferences),
    notice: "",
    capabilities: ["accounts", "account-reauthentication"],
  });
  const caller = new AbortController();
  try {
    const started = login(
      expectOk(
        await client.accounts(
          {
            type: "check",
            worktreeId: "one",
            provider: "anthropic",
            accountId: "a",
            revision: manager.revision,
          },
          caller.signal,
        ),
      ),
    );
    expect(started.status).toBe("pending");
    expect(calls()).toBe(0);
    const acknowledged = login(
      expectOk(
        await client.accounts({
          type: "poll",
          worktreeId: "one",
          flowId: started.id,
          revision: 0,
        }),
      ),
    );
    expect(acknowledged.prompt?.type).toBe("manual_code");
    expect(calls()).toBe(1);
    caller.abort();
    const answered = login(
      expectOk(
        await client.accounts({
          type: "answer",
          worktreeId: "one",
          flowId: started.id,
          promptId: acknowledged.prompt!.id,
          value: "synthetic-code",
        }),
      ),
    );
    let completed = answered;
    while (completed.status === "pending") {
      completed = login(
        expectOk(
          await client.accounts({
            type: "poll",
            worktreeId: "one",
            flowId: started.id,
            revision: completed.revision,
          }),
        ),
      );
    }

    expect(completed.status).toBe("complete");
    expect(completed.account?.id).toBe("a");
    expect(completed.intent).toBe("reauthenticate");
    expect((await manager.catalog("one")).accounts).toHaveLength(2);
    expect((await manager.catalog("one")).selections.anthropic).toBe("a");
    expect((await manager.catalog("two")).selections.anthropic).toBe("a");
    const stored = JSON.parse(await readFile(join(directory, "accounts.json"), "utf8"));
    expect(stored.accounts[0].credential.access).toBe("sk-ant-oat01-ipc-renewed");
    expect(JSON.stringify(completed)).not.toMatch(/sk-ant|synthetic-code|refresh-/u);
  } finally {
    await client.disconnect();
    await server.stop(true);
  }
});

test("A fully delivered Unix socket reply discarded after abort never starts provider login", async () => {
  // Bun stops propagating client abort to Request.signal once the full response is delivered.
  const late = Promise.withResolvers<OAuthCredential>();
  const { manager, directory, calls } = await fixture({ login: () => late.promise });
  const before = await readFile(join(directory, "accounts.json"), "utf8");
  const paths = runtimePaths("reauth-lost-reply", true, directory);
  await mkdir(dirname(paths.socket), { recursive: true, mode: 0o700 });
  let initiatingSignal: AbortSignal | undefined;
  let flowId = "";
  const requests: string[] = [];
  const server = Bun.serve({
    unix: paths.socket,
    fetch: async (request) => {
      const input: unknown = await request.json();
      if (!Value.Check(accountRequestSchema, input)) return new Response(null, { status: 400 });
      requests.push(input.type);
      if (input.type === "reauthenticate") initiatingSignal = request.signal;
      const result = await manager.handle(input, request.signal);
      if (result.ok && result.value.kind === "login") flowId = result.value.login.id;
      return result.ok ? Response.json(result.value) : rejected(result.error);
    },
  });
  const client = new RuntimeClient(paths, {
    version: protocolVersion,
    pid: process.pid,
    instance: "original",
    repositoryId: "fixture",
    mode: "offline",
    repositories: [],
    details: {},
    closingCount: 0,
    preferences: structuredClone(emptyPreferences),
    notice: "",
    capabilities: ["accounts", "account-reauthentication"],
  });
  const caller = new AbortController();
  const nativeFetch = globalThis.fetch;
  let fullyReceived = false;
  const intercepted = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        const response = await nativeFetch(...args);
        if (
          typeof args[1]?.body === "string" &&
          JSON.parse(args[1].body).type === "reauthenticate"
        ) {
          const bytes = await response.arrayBuffer();
          fullyReceived = true;
          // Discard only after actual native socket delivery, before RuntimeClient decodes/accepts it.
          caller.abort();
          return new Response(bytes, { status: response.status, headers: response.headers });
        }
        return response;
      },
      { preconnect: nativeFetch.preconnect },
    ),
  );
  try {
    const result = await client.accounts(
      {
        type: "reauthenticate",
        worktreeId: "one",
        provider: "anthropic",
        accountId: "a",
        revision: manager.revision,
      },
      caller.signal,
    );

    // Independent cleanup reaches the original daemon even though its initiating signal stayed live.
    expect(fullyReceived).toBe(true);
    expect(initiatingSignal?.aborted).toBe(false);
    expect(expectError(result).code).toBe("CANCELLED");
    expect(requests).toEqual(["reauthenticate", "cancel"]);
    expect(calls()).toBe(0);
    expect(
      login(
        expectOk(
          await manager.handle({
            type: "poll",
            worktreeId: "one",
            flowId,
            revision: 0,
          }),
        ),
      ).status,
    ).toBe("cancelled");
    late.resolve(oauth("late"));
    expect(await readFile(join(directory, "accounts.json"), "utf8")).toBe(before);

    // An abandoned receipt does not monopolize the single interactive login slot.
    const next = login(expectOk(await start(manager)));
    expect(next.id).not.toBe(flowId);
    expectOk(await manager.handle({ type: "cancel", worktreeId: "one", flowId: next.id }));
  } finally {
    late.resolve(oauth("late"));
    intercepted.mockRestore();
    await client.disconnect();
    await server.stop(true);
  }
});

test("Unreceived recovery expires in ten seconds without calling the provider or blocking future login", async () => {
  // No client can send cleanup if transport or body decoding never exposes a flow ID.
  const { manager, calls } = await fixture();
  jest.useFakeTimers();
  try {
    const begin = () =>
      manager.handle(
        {
          type: "reauthenticate",
          worktreeId: "one",
          provider: "anthropic",
          accountId: "a",
          revision: manager.revision,
        },
        new AbortController().signal,
      );
    const pending = login(expectOk(await begin()));
    expect(calls()).toBe(0);
    jest.advanceTimersByTime(9999);
    expect(expectError(await begin()).code).toBe("ACCOUNT_CONFLICT");

    // Receipt expiry releases exclusivity without ever starting remote login.
    jest.advanceTimersByTime(1);
    expect(
      expectError(
        await manager.handle({
          type: "poll",
          worktreeId: "one",
          flowId: pending.id,
          revision: 0,
        }),
      ).code,
    ).toBe("ACCOUNT_NOT_FOUND");
    const next = login(expectOk(await begin()));
    expect(next.status).toBe("pending");
    expect(calls()).toBe(0);
    expectOk(await manager.stop());
    expect(calls()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

test("Receipt adoption starts a fresh fifteen minute interactive timeout", async () => {
  // Browser time is measured from adoption, not from the original request or receipt deadline.
  const caller = new AbortController();
  let providerSignal: AbortSignal | undefined;
  const { manager, calls } = await fixture({
    login: async (interaction) => {
      providerSignal = interaction.signal;
      await interaction.prompt({ type: "manual_code", message: "Fixture code" });
      return oauth("new");
    },
  });
  jest.useFakeTimers();
  try {
    const pending = login(
      expectOk(
        await manager.handle(
          {
            type: "reauthenticate",
            worktreeId: "one",
            provider: "anthropic",
            accountId: "a",
            revision: manager.revision,
          },
          caller.signal,
        ),
      ),
    );
    jest.advanceTimersByTime(9000);
    const acknowledged = login(
      expectOk(
        await manager.handle({
          type: "poll",
          worktreeId: "one",
          flowId: pending.id,
          revision: 0,
        }),
      ),
    );
    expect(acknowledged.prompt).toBeDefined();
    expect(calls()).toBe(1);
    caller.abort();

    // Neither the old receipt deadline nor the initiating request timeout owns adopted work.
    jest.advanceTimersByTime(15 * 60 * 1000 - 1);
    expect(providerSignal?.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    expect(providerSignal?.aborted).toBe(true);
    expect(await access(manager)).toBe("sk-ant-oat01-old");
  } finally {
    jest.useRealTimers();
  }
});

test("Normal expiry refresh is allowed to settle before automatic assessment", async () => {
  // A successful normal rotation should recover without a manual browser roundtrip.
  const { manager, calls } = await fixture({ credential: oauth("expired", "remote-a", 0) });

  const result = expectOk(await start(manager, "anthropic", "check"));

  expect(result.kind).toBe("catalog");
  if (result.kind === "catalog") expect(result.warning).toBeUndefined();
  expect(calls()).toBe(0);
  expect(await access(manager)).toBe("sk-ant-oat01-expired-rotated");
});

test("Cancelling an identity confirmation stays cancelled without unexpected-error logging", async () => {
  // Expected prompt rejection must not be mistaken for an SDK or programming failure.
  const { manager } = await fixture({ login: async () => oauth("unknown", null) });
  const pending = await current(manager, login(expectOk(await start(manager))));
  const logged = spyOn(console, "error");
  try {
    const cancelled = login(
      expectOk(await manager.handle({ type: "cancel", worktreeId: "one", flowId: pending.id })),
    );
    await manager.stop();

    expect(cancelled.status).toBe("cancelled");
    expect(logged).not.toHaveBeenCalled();
  } finally {
    logged.mockRestore();
  }
});

test("Cancellation during accepted-state publication cannot roll back replacement", async () => {
  // Catalog listeners can close their popup before the login task publishes its completed view.
  const remote = Promise.withResolvers<OAuthCredential>();
  const { manager } = await fixture({ login: async () => remote.promise });
  const pending = login(expectOk(await start(manager)));
  let cancelled: Promise<unknown> | undefined;
  const unsubscribe = manager.subscribe(() => {
    cancelled = manager.handle({ type: "cancel", worktreeId: "one", flowId: pending.id });
  });

  remote.resolve(oauth("accepted"));
  const result = await current(manager, pending);
  await cancelled;
  unsubscribe();

  expect(result.status).toBe("complete");
  expect(await access(manager)).toBe("sk-ant-oat01-accepted");
});

test("Pinned request contexts keep their account when replacement and a worktree switch overlap", async () => {
  // A request pinned to A must never acquire B's authentication after the workspace switches.
  const { manager } = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const request = manager.request("one", async (runtime) => {
    entered.resolve();
    await release.promise;
    return (await runtime.getAuth("anthropic"))?.auth.apiKey;
  });
  await entered.promise;

  expect((await current(manager, login(expectOk(await start(manager))))).status).toBe("complete");
  expectOk(
    await manager.handle({
      type: "select",
      worktreeId: "one",
      provider: "anthropic",
      accountId: "b",
      revision: manager.revision,
    }),
  );
  release.resolve();

  expect(await request).toBe("sk-ant-oat01-new");
  expect(await access(manager)).toBe("sk-ant-oat01-work");
});

test("A healthy automatic assessment still reports accepted SDK rotation persistence warnings", async () => {
  // Normal expiry recovery can succeed remotely even when the local storage write fails.
  const { manager, directory, calls } = await fixture({ credential: oauth("old", "remote-a", 0) });
  const target = join(directory, "accounts.json");
  await rm(target);
  await mkdir(target);
  try {
    const result = expectOk(await start(manager, "anthropic", "check"));

    expect(result.kind).toBe("catalog");
    if (result.kind === "catalog") expect(result.warning).toContain("refreshed in memory");
    expect(await access(manager)).toBe("sk-ant-oat01-old-rotated");
    expect(calls()).toBe(0);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test("Caller cancellation during inspection does not start a browser flow", async () => {
  // The shared usage operation may finish later, but the closed caller no longer owns a login.
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const { manager, calls } = await fixture({
    fetch: async () => {
      entered.resolve();
      return response.promise;
    },
  });
  const controller = new AbortController();
  const checking = manager.handle(
    {
      type: "check",
      worktreeId: "one",
      provider: "anthropic",
      accountId: "a",
      revision: manager.revision,
    },
    controller.signal,
  );
  await entered.promise;

  controller.abort();
  const result = await checking;
  response.resolve(new Response("denied", { status: 401 }));

  expect(expectError(result).code).toBe("CANCELLED");
  expect(calls()).toBe(0);
});

test("Cancellation between confirmed assessment and asynchronous login preparation prevents SDK login", async () => {
  // A popup may close after inspection but while begin awaits its workspace dependency.
  const { manager, calls } = await fixture({
    fetch: async () => new Response("denied", { status: 401 }),
  });
  await manager.workspace("one");
  const original = manager.workspace.bind(manager);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let resolutions = 0;
  const workspace = spyOn(manager, "workspace").mockImplementation(async (worktree) => {
    if (++resolutions === 2) {
      entered.resolve();
      await release.promise;
    }
    return original(worktree);
  });
  const controller = new AbortController();
  try {
    const checking = manager.handle(
      {
        type: "check",
        worktreeId: "one",
        provider: "anthropic",
        accountId: "a",
        revision: manager.revision,
      },
      controller.signal,
    );
    await entered.promise;

    controller.abort();
    release.resolve();
    const result = await checking;

    expect(expectError(result).code).toBe("CANCELLED");
    expect(calls()).toBe(0);
  } finally {
    release.resolve();
    workspace.mockRestore();
  }
});

test("Manager shutdown during asynchronous login preparation cannot start an orphaned browser flow", async () => {
  // Shutdown can finish while an incoming command is still waiting to acquire its workspace.
  const { manager, calls } = await fixture();
  await manager.workspace("one");
  const original = manager.workspace.bind(manager);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const workspace = spyOn(manager, "workspace").mockImplementation(async (worktree) => {
    entered.resolve();
    await release.promise;
    return original(worktree);
  });
  try {
    const starting = start(manager);
    await entered.promise;

    expectOk(await manager.stop());
    release.resolve();
    const result = await starting;

    expect(expectError(result).code).toBe("CANCELLED");
    expect(calls()).toBe(0);
  } finally {
    release.resolve();
    workspace.mockRestore();
  }
});

test("Switching away while inspection is in flight rejects the obsolete target", async () => {
  // Even a confirmed failure of the old selection cannot open login for the new selection.
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const { manager, calls } = await fixture({
    fetch: async () => {
      entered.resolve();
      return response.promise;
    },
  });
  const checking = start(manager, "anthropic", "check");
  await entered.promise;

  expectOk(
    await manager.handle({
      type: "select",
      worktreeId: "one",
      provider: "anthropic",
      accountId: "b",
      revision: manager.revision,
    }),
  );
  response.resolve(new Response("denied", { status: 401 }));
  const result = await checking;

  expect(expectError(result).code).toBe("ACCOUNT_CONFLICT");
  expect(calls()).toBe(0);
  expect(await access(manager)).toBe("sk-ant-oat01-work");
});

test("Accepted replacement invalidates old authentication evidence without bypassing provider cooldown", async () => {
  // A cached rejected token must not cause another login after the credential was replaced.
  const { manager, calls, probes } = await fixture({
    fetch: async () => new Response("denied", { status: 401 }),
  });
  const first = login(expectOk(await start(manager, "anthropic", "check")));
  expect((await current(manager, first)).status).toBe("complete");

  const checked = expectOk(await start(manager, "anthropic", "check"));

  expect(checked.kind).toBe("catalog");
  if (checked.kind === "catalog") expect(checked.warning).toBeTruthy();
  expect(calls()).toBe(1);
  expect(probes()).toBe(1);
});

test("An old in-flight 401 cannot restore superseded evidence after manual replacement", async () => {
  // Replacement invalidates the old account-keyed pending entry, not just the visible snapshot.
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const { manager, calls, probes } = await fixture({
    fetch: async () => {
      entered.resolve();
      return response.promise;
    },
  });
  const checking = start(manager, "anthropic", "check");
  await entered.promise;
  const replacement = await current(manager, login(expectOk(await start(manager))));
  expect(replacement.status).toBe("complete");

  response.resolve(new Response("denied", { status: 401 }));
  const result = expectOk(await checking);

  expect(result.kind).toBe("catalog");
  expect(calls()).toBe(1);
  expect(probes()).toBe(1);
  expect(await access(manager)).toBe("sk-ant-oat01-new");
});

test("Unsupported automatic providers remain indeterminate while manual OAuth reauthentication works", async () => {
  // This release deliberately supports automatic assessment only for Claude.
  const { manager, probes, calls } = await fixture({ provider: "fixture" });

  const checked = expectOk(await start(manager, "fixture", "check"));
  const manual = await current(manager, login(expectOk(await start(manager, "fixture"))));

  expect(checked.kind).toBe("catalog");
  if (checked.kind === "catalog") expect(checked.warning).toContain("not supported");
  expect(manual.status).toBe("complete");
  expect(probes()).toBe(0);
  expect(calls()).toBe(1);
});
