import { expect, test } from "bun:test";
import { PreloadedData } from "./preload.ts";
import { demoWorkspace } from "../workspace/demo.ts";
import { ok, err, type Result } from "../result.ts";
import { HistoryError, type ExpectedError } from "../errors.ts";
import type { HistoryItem } from "../agents/history.ts";
import type { ModelCatalog } from "../agents/model-selection.ts";
import type { AccountsCatalog } from "../accounts/model.ts";
import { expectOk } from "../testing/results.ts";

type Client = ConstructorParameters<typeof PreloadedData>[0];
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const model: ModelCatalog = {
  conversationId: "conversation",
  current: null,
  effort: "off",
  models: [],
};
const account = (tree: string): AccountsCatalog => ({
  revision: 0,
  worktreeId: tree,
  selections: {},
  accounts: [],
  providers: [],
});
const item = (
  id: string,
  tree = "demo:main",
  modified = "2026-10-14T12:34:00.000Z",
): HistoryItem => ({
  id,
  worktreeId: tree,
  modified,
  title: id,
  messageCount: 1,
  openSessionId: null,
  unavailableReason: null,
});
function fixture(overrides: Partial<Client> = {}) {
  const calls = {
    models: [] as string[],
    accounts: [] as string[],
    history: [] as string[],
    previews: [] as string[],
  };
  const revisions = { models: 0, accounts: 0, history: 0 };
  let rows = [item("first"), item("second")];
  const repositories = demoWorkspace();
  const client: Client = {
    snapshot: {
      repositories,
      details: {
        a1: { conversationId: "conversation", status: "complete", output: "", error: null },
      },
      preferences: { selection: { worktreeId: "demo:main", sessions: {} }, drafts: {} },
      closingCount: 0,
      terminalClosingCount: 0,
      notice: "",
      editors: [],
      terminals: [],
      extensionUi: [],
    },
    dataIdentity: (tree, kind) =>
      tree === "demo:main" ? `instance:${revisions[kind]}` : undefined,
    completionIdentity: () => "conversation:0",
    models: async (id) => {
      calls.models.push(id);
      return ok(model);
    },
    accounts: async (request) => {
      calls.accounts.push(request.worktreeId);
      return ok({ kind: "catalog", catalog: account(request.worktreeId) });
    },
    listHistory: async (tree) => {
      calls.history.push(tree);
      return ok(rows);
    },
    previewHistory: async (tree, id) => {
      calls.previews.push(id);
      return ok({ worktreeId: tree, id, text: `Preview ${id}`, truncated: false });
    },
    ...overrides,
  };
  const failures: unknown[] = [];
  const data = new PreloadedData(client, (error) => failures.push(error));
  const preload = () => {
    data.preloadModels();
    data.preloadAccounts();
    data.preloadHistory();
  };
  return {
    client,
    calls,
    revisions,
    failures,
    data,
    preload,
    setRows: (next: HistoryItem[]) => {
      rows = next;
    },
  };
}

test("Startup preloads active catalogs and previews without activating cold worktrees", async () => {
  // Cold repositories and sessions without a conversation must stay unallocated.
  const app = fixture();
  try {
    app.preload();
    await flush();

    expect(app.calls.models).toEqual(["a1"]);
    expect(app.calls.accounts).toEqual(["demo:main"]);
    expect(app.calls.history).toEqual(["demo:main"]);
    expect(app.calls.previews).toEqual(["first", "second"]);
    expect(app.data.cachedModels("a1", "conversation")).toEqual(ok(model));
    expect(app.data.cachedAccounts("demo:main")).toEqual(ok(account("demo:main")));
    expect(app.data.previews.read("demo:main", "second")?.kind).toBe("ready");

    // Repeated runtime snapshots and popup reads must not repeat discovery.
    for (let i = 0; i < 10; i++) app.preload();
    await app.data.listHistory("demo:main");
    await app.data.listModels("a1", "conversation");
    await flush();
    expect(app.calls.history).toHaveLength(1);
    expect(app.calls.models).toHaveLength(1);
    expect(app.calls.previews).toHaveLength(2);
    expect(app.failures).toEqual([]);
  } finally {
    app.data.dispose();
  }
});

test("Services without invalidation support keep on-demand reads instead of frozen caches", async () => {
  // Older running services must remain usable without an automatic daemon restart.
  const app = fixture({ dataIdentity: () => undefined });
  try {
    app.preload();
    await flush();
    expect(app.calls.models).toEqual([]);
    expect(app.calls.accounts).toEqual([]);
    expect(app.calls.history).toEqual([]);

    expectOk(await app.data.listModels("a1", "conversation"));
    expectOk(await app.data.listHistory("demo:main"));
    expectOk(await app.data.requestAccounts({ type: "list", worktreeId: "demo:main" }));
    expect(app.calls.models).toEqual(["a1"]);
    expect(app.calls.accounts).toEqual(["demo:main"]);
    expect(app.calls.history).toEqual(["demo:main"]);
    expect(app.data.cachedHistory("demo:main")).toBeUndefined();
  } finally {
    app.data.dispose();
  }
});

test("Unexpected preload failures are reported once while retaining their original rejection", async () => {
  // Snapshot heartbeats must not repeatedly report the same programming failure.
  const failure = new TypeError("Broken model metadata");
  const app = fixture({
    models: async () => {
      throw failure;
    },
  });
  try {
    app.preload();
    await flush();
    app.preload();
    await flush();
    expect(app.failures).toEqual([failure]);
    await expect(app.data.listModels("a1", "conversation")).rejects.toBe(failure);
  } finally {
    app.data.dispose();
  }
});

test("Closing a popup cancels its wait without cancelling shared startup preparation", async () => {
  // A slow shared request should survive one popup closing and be reusable later.
  const pending = Promise.withResolvers<Result<ModelCatalog, ExpectedError>>();
  let request: AbortSignal | undefined,
    calls = 0;
  const app = fixture({
    models: async (_id, _conversation, signal) => {
      calls++;
      request = signal;
      return pending.promise;
    },
  });
  try {
    app.data.preloadModels();
    await flush();
    const popup = new AbortController();
    const waiting = app.data.listModels("a1", "conversation", popup.signal);
    popup.abort();
    expect((await waiting).ok).toBe(false);
    expect(request?.aborted).toBe(false);

    pending.resolve(ok(model));
    await flush();
    expect(app.data.cachedModels("a1", "conversation")).toEqual(ok(model));
    expect(calls).toBe(1);
  } finally {
    app.data.dispose();
    pending.resolve(ok(model));
  }
});

test("Account generations fence old model replies and reload the affected catalogs", async () => {
  // The old account's in-flight metadata must never populate the replacement account's cache.
  const pending = Promise.withResolvers<Result<ModelCatalog, ExpectedError>>();
  const signals: AbortSignal[] = [];
  let requests = 0;
  const fresh = {
    ...model,
    models: [
      {
        provider: "fixture",
        id: "fresh",
        name: "Fresh",
        contextWindow: 1000,
        images: false,
        reasoning: false,
        efforts: ["off" as const],
        effort: "off" as const,
      },
    ],
  };
  const app = fixture({
    models: async (_id, _conversation, signal) => {
      signals.push(signal!);
      return ++requests === 1 ? pending.promise : ok(fresh);
    },
  });
  try {
    app.preload();
    await flush();
    app.revisions.models++;
    app.revisions.accounts++;
    app.preload();
    await flush();
    pending.resolve(ok(model));
    await flush();

    expect(signals[0]?.aborted).toBe(true);
    expect(app.data.cachedModels("a1", "conversation")).toEqual(ok(fresh));
    expect(app.calls.accounts).toHaveLength(2);
    expect(app.calls.history).toHaveLength(1);
  } finally {
    app.data.dispose();
    pending.resolve(ok(model));
  }
});

test("History changes reload only changed previews while retaining unchanged cache entries", async () => {
  // A single edited file should not reread every conversation body.
  const app = fixture();
  try {
    app.preload();
    await flush();
    app.setRows([item("first", "demo:main", "2026-10-14T12:35:00.000Z"), item("second")]);
    app.revisions.history++;
    app.data.preloadHistory();
    await flush();

    expect(app.calls.history).toHaveLength(2);
    expect(app.calls.previews).toEqual(["first", "second", "first"]);
    expect(app.data.previews.read("demo:main", "second")?.kind).toBe("ready");
    expect(app.calls.models).toHaveLength(1);
    expect(app.calls.accounts).toHaveLength(1);
  } finally {
    app.data.dispose();
  }
});

test("Manual refresh and reload replace cached data without silently retrying cached failures", async () => {
  // Expected discovery failures remain inspectable until a deliberate refresh or invalidation.
  let healthy = false,
    calls = 0;
  const app = fixture({
    listHistory: async () => {
      calls++;
      return healthy
        ? ok([item("recovered")])
        : err(new HistoryError("HISTORY_UNAVAILABLE", "Unavailable history"));
    },
  });
  try {
    app.preload();
    await flush();
    app.preload();
    await flush();
    expect(app.data.cachedHistory("demo:main")?.ok).toBe(false);
    expect(calls).toBe(1);

    healthy = true;
    expect(expectOk(await app.data.listHistory("demo:main", undefined, true))[0]?.id).toBe(
      "recovered",
    );
    await flush();
    expect(app.data.previews.read("demo:main", "recovered")?.kind).toBe("ready");
    app.data.reload();
    await flush();
    expect(calls).toBe(3);
    expect(app.calls.accounts).toHaveLength(2);
    expect(app.calls.models).toHaveLength(2);
  } finally {
    app.data.dispose();
  }
});

test("Disposal cancels background reads and late completions cannot revive caches", async () => {
  // Detaching the app owns cancellation, unlike merely hiding a popup.
  const pending = Promise.withResolvers<Result<ModelCatalog, ExpectedError>>();
  let signal: AbortSignal | undefined;
  const app = fixture({
    models: async (_id, _conversation, abort) => {
      signal = abort;
      return pending.promise;
    },
  });
  app.data.preloadModels();
  await flush();
  app.data.dispose();
  pending.resolve(ok(model));
  await flush();
  expect(signal?.aborted).toBe(true);
  expect(app.data.cachedModels("a1", "conversation")).toBeUndefined();
});
