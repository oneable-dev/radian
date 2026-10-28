import { expect, spyOn, test } from "bun:test";
import { expectError, expectOk } from "../testing/results.ts";
import { RuntimeClient } from "./client.ts";
import { emptyPreferences, protocolVersion, type RuntimeSnapshot } from "./protocol.ts";
import { runtimePaths } from "./storage.ts";

const snapshot = (supported = true): RuntimeSnapshot => ({
  version: protocolVersion,
  pid: 1234,
  instance: "resource-runtime",
  repositoryId: "/fixture/.git",
  mode: "offline",
  repositories: [],
  details: {},
  closingCount: 0,
  preferences: structuredClone(emptyPreferences),
  notice: "",
  capabilities: supported ? ["shared-daemon", "process-resources"] : [],
});
const paths = runtimePaths("/fixture/.git", true, "/tmp/radian-resource-client-test");
const sample = { pid: 1234, elapsedMs: 1000, cpuMicros: 500000, rssBytes: 320 * 1024 ** 2 };
const mockFetch = (
  implementation: (
    input: Parameters<typeof fetch>[0],
    options?: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
) =>
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(implementation, { preconnect: fetch.preconnect }),
  );

test("Resource requests validate runtime identity and counter values at the IPC boundary", async () => {
  // Only the registered runtime PID may contribute to the live sum.
  let data: unknown = sample;
  let status = 200;
  const request = mockFetch(async (input, options) => {
    expect(new URL(input instanceof Request ? input.url : input).pathname).toBe("/resources");
    expect(new Headers(options?.headers).get("X-Radian-Instance")).toBe("resource-runtime");

    return Response.json(data, { status });
  });
  const client = new RuntimeClient(paths, snapshot());
  try {
    expect(expectOk(await client.resources())).toEqual(sample);

    // Wrong PIDs and malformed counters must never become plausible resource totals.
    for (const invalid of [
      { ...sample, pid: 9 },
      { ...sample, cpuMicros: -1 },
      { ...sample, elapsedMs: null },
      { ...sample, rssBytes: 1.5 },
      {},
    ]) {
      data = invalid;
      expect(expectError(await client.resources()).code).toBe("PROTOCOL_ERROR");
    }

    data = {
      ok: false,
      error: {
        code: "RESOURCE_UNAVAILABLE",
        message: "OS counters unavailable",
        outcome: "rejected",
      },
    };
    status = 500;
    expect(expectError(await client.resources()).code).toBe("RESOURCE_UNAVAILABLE");
  } finally {
    await client.disconnect();
    request.mockRestore();
  }
});

test("Legacy runtimes and pre-cancelled resource reads never start or restart services", async () => {
  // Capability checks precede network access.
  const request = mockFetch(async () => {
    throw new Error("Unexpected network request");
  });
  const legacy = new RuntimeClient(paths, snapshot(false));
  const client = new RuntimeClient(paths, snapshot());
  try {
    const unsupported = expectError(await legacy.resources());
    const cancelled = expectError(await client.resources(AbortSignal.abort()));

    expect(unsupported.code).toBe("UNSUPPORTED_CAPABILITY");
    expect(cancelled.code).toBe("CANCELLED");
    expect(request).not.toHaveBeenCalled();
  } finally {
    await legacy.disconnect();
    await client.disconnect();
    request.mockRestore();
  }
});

test("Closing an in-flight resource request returns typed cancellation", async () => {
  // Native fetch rejects on abort rather than returning a Result.
  const request = mockFetch(
    async (_input, options) =>
      new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  const client = new RuntimeClient(paths, snapshot());
  const abort = new AbortController();
  try {
    const pending = client.resources(abort.signal);
    abort.abort();

    expect(expectError(await pending).code).toBe("CANCELLED");
  } finally {
    await client.disconnect();
    request.mockRestore();
  }
});
