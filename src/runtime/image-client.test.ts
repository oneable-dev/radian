import { expect, spyOn, test } from "bun:test";
import { RuntimeClient } from "./client.ts";
import { emptyPreferences, protocolVersion, type RuntimeSnapshot } from "./protocol.ts";
import { runtimePaths } from "./storage.ts";
import { maximumPreviewImageBytes } from "../agents/transcript-images.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { tinyPng } from "../testing/image.ts";
import type { ExecutionState } from "../agents/session-registry.ts";

const imageId = "a".repeat(64),
  paths = runtimePaths("/fixture/.git", true, "/tmp/radian-image-client-test");
function snapshot(capabilities = ["transcript-images"]): RuntimeSnapshot {
  return {
    version: protocolVersion,
    pid: process.pid,
    instance: "instance",
    repositoryId: "/fixture/.git",
    mode: "offline",
    capabilities,
    repositories: [],
    details: {
      session: { conversationId: "conversation", status: "complete", output: "", error: null },
    },
    closingCount: 0,
    preferences: structuredClone(emptyPreferences),
    notice: "",
  };
}
function stubFetch(
  implementation: (
    input: Parameters<typeof fetch>[0],
    options?: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
) {
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(implementation, { preconnect: fetch.preconnect }),
  );
}

test("Legacy services and invalid image IDs fail explicitly without queries or restarts", async () => {
  const fetchMock = stubFetch(async () => {
    throw new Error("Unsupported image request must not be transmitted");
  });
  const old = new RuntimeClient(paths, snapshot([])),
    current = new RuntimeClient(paths, snapshot());
  try {
    expect(expectError(await old.image("session", imageId)).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(expectError(await current.image("session", "../../private.png")).code).toBe(
      "INVALID_INPUT",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    await old.disconnect();
    await current.disconnect();
    fetchMock.mockRestore();
  }
});

test("Binary images remain bounded current-instance bytes without UTF-8 conversion", async () => {
  const bytes = tinyPng(),
    requests: { path: string; instance: string | null }[] = [];
  const fetchMock = stubFetch(async (input, options) => {
    requests.push({
      path: new URL(input instanceof Request ? input.url : input).pathname,
      instance: new Headers(options?.headers).get("X-Radian-Instance"),
    });
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
      { headers: { "Content-Type": "image/png" } },
    );
  });
  const client = new RuntimeClient(paths, snapshot());
  try {
    expect(expectOk(await client.image("session", imageId))).toEqual(bytes);
    expect(requests).toEqual([{ path: "/images", instance: "instance" }]);
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

test.each([true, false])(
  "Oversized image responses abort regardless of Content-Length presence %s",
  async (declared) => {
    let cancelled = false;
    const fetchMock = stubFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(declared ? 1 : maximumPreviewImageBytes + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
          {
            headers: {
              "Content-Type": "image/png",
              ...(declared ? { "Content-Length": String(maximumPreviewImageBytes + 1) } : {}),
            },
          },
        ),
    );
    const client = new RuntimeClient(paths, snapshot());
    try {
      expect(expectError(await client.image("session", imageId)).code).toBe("PROTOCOL_ERROR");
      expect(cancelled).toBe(true);
    } finally {
      await client.disconnect();
      fetchMock.mockRestore();
    }
  },
);

test("Conversation replacement prevents late images from belonging to new conversations", async () => {
  const pending = Promise.withResolvers<Response>();
  const fetchMock = stubFetch(async () => pending.promise);
  const details: Record<string, ExecutionState> = {
    session: { conversationId: "old", status: null, output: "", error: null },
  };
  const client = new RuntimeClient(paths, { ...snapshot(), details });
  try {
    const requested = client.image("session", imageId);
    details.session = { ...details.session!, conversationId: "new" };
    pending.resolve(new Response(tinyPng(), { headers: { "Content-Type": "image/png" } }));

    expect(expectError(await requested).code).toBe("CANCELLED");
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});
