import { expect, spyOn, test } from "bun:test";
import { RuntimeClient } from "./client.ts";
import { runtimePaths } from "./storage.ts";
import { emptyPreferences, protocolVersion, type RuntimeSnapshot } from "./protocol.ts";
import { expectError, expectOk } from "../testing/results.ts";
import type { ModelCatalog } from "../agents/model-selection.ts";

const state = (): RuntimeSnapshot => ({
  version: protocolVersion,
  pid: process.pid,
  instance: "instance",
  repositoryId: "repo",
  mode: "offline",
  repositories: [],
  details: { session: { conversationId: "conversation", status: null, output: "", error: null } },
  closingCount: 0,
  preferences: structuredClone(emptyPreferences),
  notice: "",
  capabilities: ["model-selection", "model-effort"],
});
const paths = runtimePaths("model-client-fixture", true, "/tmp/radian-model-client-test");
const catalog: ModelCatalog = {
  conversationId: "conversation",
  current: { provider: "first", id: "same-id" },
  effort: "high",
  models: [
    {
      provider: "first",
      id: "same-id",
      name: "First",
      contextWindow: 200000,
      reasoning: true,
      images: true,
      efforts: ["low", "high"],
      effort: "high",
    },
    {
      provider: "second",
      id: "same-id",
      name: "Second",
      contextWindow: 64000,
      reasoning: false,
      images: false,
      efforts: ["off"],
      effort: "off",
    },
  ],
};

test("Model IPC sends session/conversation/runtime IDs and distinguishes provider plus model ID", async () => {
  // Replace only network responses while verifying actual transmitted protocols.
  const requests: { path: string; headers: Headers; body?: unknown }[] = [];
  const mocked = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
        const url = new URL(input instanceof Request ? input.url : input);
        requests.push({
          path: url.pathname + url.search,
          headers: new Headers(options?.headers),
          ...(options?.body ? { body: JSON.parse(await new Response(options.body).text()) } : {}),
        });
        return Response.json(url.pathname === "/models" ? catalog : { ok: true, value: null });
      },
      { preconnect: fetch.preconnect },
    ),
  );
  const client = new RuntimeClient(paths, state());
  try {
    expect(expectOk(await client.models("session", "conversation"))).toEqual(catalog);
    expectOk(
      await client.selectModel(
        "session",
        "conversation",
        { provider: "second", id: "same-id" },
        "off",
      ),
    );

    expect(requests[0]!.path).toBe("/models?sessionId=session&conversationId=conversation");
    expect(requests[0]!.headers.get("X-Radian-Instance")).toBe("instance");
    expect(requests[1]!.body).toEqual({
      type: "model-select",
      sessionId: "session",
      conversationId: "conversation",
      model: { provider: "second", id: "same-id" },
      effort: "off",
    });
  } finally {
    await client.disconnect();
    mocked.mockRestore();
  }
});

test("Legacy services and raw model commands never fall back to paid prompts, restart, or other commands", async () => {
  const snapshot = state();
  snapshot.capabilities = [];
  const mocked = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      () => {
        throw new Error("Unsupported model controls must not transmit");
      },
      { preconnect: fetch.preconnect },
    ),
  );
  const client = new RuntimeClient(paths, snapshot);
  try {
    expect(expectError(await client.models("session", "conversation")).code).toBe(
      "UNSUPPORTED_CAPABILITY",
    );
    expect(
      expectError(
        await client.selectModel("session", "conversation", { provider: "second", id: "same-id" }),
      ).code,
    ).toBe("UNSUPPORTED_CAPABILITY");
    expect(expectError(await client.prompt("session", "/model")).code).toBe(
      "UNSUPPORTED_CAPABILITY",
    );
    expect(expectError(await client.prompt("session", "/model second/same-id")).code).toBe(
      "INVALID_INPUT",
    );
    expect(mocked).not.toHaveBeenCalled();
  } finally {
    await client.disconnect();
    mocked.mockRestore();
  }
});

test("Model-only legacy services never receive requests that could ignore effort", async () => {
  const snapshot = state();
  snapshot.capabilities = ["model-selection"];
  const mocked = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      () => {
        throw new Error("Legacy service must not receive effort changes");
      },
      { preconnect: fetch.preconnect },
    ),
  );
  const client = new RuntimeClient(paths, snapshot);
  try {
    expect(expectError(await client.models("session", "conversation")).code).toBe(
      "UNSUPPORTED_CAPABILITY",
    );
    expect(
      expectError(
        await client.selectModel(
          "session",
          "conversation",
          { provider: "first", id: "same-id" },
          "high",
        ),
      ).code,
    ).toBe("UNSUPPORTED_CAPABILITY");
    expect(mocked).not.toHaveBeenCalled();
  } finally {
    await client.disconnect();
    mocked.mockRestore();
  }
});

test("Model responses with mismatched conversation identities are rejected", async () => {
  const mocked = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(async () => Response.json({ ...catalog, conversationId: "other-conversation" }), {
      preconnect: fetch.preconnect,
    }),
  );
  const client = new RuntimeClient(paths, state());
  try {
    expect(expectError(await client.models("session", "conversation")).code).toBe("PROTOCOL_ERROR");
  } finally {
    await client.disconnect();
    mocked.mockRestore();
  }
});
