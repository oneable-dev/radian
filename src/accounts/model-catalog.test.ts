import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProvider,
  InMemoryCredentialStore,
  ModelsError,
  type Model,
} from "@earendil-works/pi-ai";
import { AccountManager } from "./manager.ts";
import { piSessionFactory } from "../agents/pi-session-adapter.ts";
import { CapabilityError } from "../errors.ts";
import { err } from "../result.ts";
import { expectError, expectOk } from "../testing/results.ts";

function provider(id: string) {
  const model: Model<"openai-completions"> = {
    provider: id,
    id: "fixture",
    name: id,
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1",
    reasoning: false,
    input: ["text"],
    contextWindow: 64000,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const stream = () => {
    throw new Error("Model browsing must not send a prompt");
  };

  return createProvider({
    id,
    models: [model],
    auth: {
      apiKey: {
        name: "Fixture key",
        resolve: async ({ credential }) =>
          credential?.key ? { auth: { apiKey: credential.key } } : undefined,
      },
    },
    api: { stream, streamSimple: stream },
  });
}

test("A failed provider refresh leaves healthy models selectable and recovers on explicit refresh", async () => {
  // The failed provider still exposes a cached model; it must not become selectable by accident.
  const directory = await mkdtemp(join(tmpdir(), "radian-model-catalog-"));
  const healthy = provider("healthy-fixture");
  const failing = provider("failing-fixture");
  let unavailable = false;
  let refreshes = 0;
  failing.refreshModels = async () => {
    refreshes++;
    if (unavailable) throw new ModelsError("oauth", "PRIVATE refresh failure");
  };
  const credentials = new InMemoryCredentialStore();
  for (const candidate of [healthy, failing]) {
    await credentials.modify(candidate.id, async () => ({ type: "api_key", key: "PRIVATE" }));
  }
  const manager = expectOk(
    await AccountManager.open(join(directory, "accounts"), {
      offline: true,
      defaultCredentials: credentials,
      providers: [healthy, failing],
    }),
  );
  let executor: Awaited<ReturnType<ReturnType<typeof piSessionFactory>>> | undefined;
  try {
    executor = await piSessionFactory({
      accounts: manager,
      agentDir: join(directory, "agent"),
      defaultPackagePaths: [],
      model: healthy.getModels()[0]!,
      settings: { retry: { enabled: false }, compaction: { enabled: false } },
    })({
      cwd: directory,
      worktreeId: "one",
      role: "main",
      spawnSubagent: async () => err(new CapabilityError("No child expected")),
    });
    unavailable = true;
    const conversation = executor.state.conversationId;

    // Opening the catalog must isolate the failed provider rather than rejecting the whole popup.
    const catalog = expectOk(await executor.models!());
    expect(catalog.models.map((model) => model.provider)).toEqual([healthy.id]);
    expect(catalog.warning).toContain(failing.id);
    expect(catalog.warning).toContain("/accounts");
    expect(JSON.stringify(catalog)).not.toContain("PRIVATE");
    const afterFailure = refreshes;
    expect(expectOk(await executor.models!()).warning).toBe(catalog.warning);
    expect(refreshes).toBe(afterFailure);
    expect(
      expectError(await executor.selectModel!({ provider: failing.id, id: "fixture" })).code,
    ).toBe("MODEL_UNAVAILABLE");
    expectOk(await executor.selectModel!({ provider: healthy.id, id: "fixture" }));
    expect(executor.state.conversationId).toBe(conversation);

    // Explicit retry restores the repaired provider and clears the partial-discovery warning.
    unavailable = false;
    const recovered = expectOk(await executor.models!(undefined, true));
    expect(recovered.warning).toBeUndefined();
    expect(recovered.models.map((model) => model.provider)).toEqual([healthy.id, failing.id]);
    expectOk(await executor.selectModel!({ provider: failing.id, id: "fixture" }));
    expect(executor.state.telemetry?.provider).toBe(failing.id);
  } finally {
    await executor?.close();
    expectOk(await manager.stop());
    await rm(directory, { recursive: true, force: true });
  }
});
