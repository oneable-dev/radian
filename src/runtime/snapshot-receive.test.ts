import { expect, spyOn, test } from "bun:test";
import { fetchSnapshot, RuntimeClient } from "./client.ts";
import {
  emptyPreferences,
  maxFrameBytes,
  maxSnapshotBytes,
  parseSnapshot,
  protocolVersion,
  type RuntimeSnapshot,
} from "./protocol.ts";
import { readJson } from "./transport.ts";
import { runtimePaths } from "./storage.ts";
import { expectError, expectOk } from "../testing/results.ts";

const paths = runtimePaths("/fixture/.git", true, "/tmp/radian-snapshot-receive-unit");
const encoder = new TextEncoder();
const state = (): RuntimeSnapshot => ({
  version: protocolVersion,
  pid: process.pid,
  instance: "fixture",
  repositoryId: "/fixture/.git",
  mode: "offline",
  repositories: [],
  details: {},
  closingCount: 0,
  notice: "",
  preferences: structuredClone(emptyPreferences),
  capabilities: ["history", "prompt-images"],
});

function stubFetch(implementation: () => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(implementation, { preconnect: fetch.preconnect }),
  );
}

test("Receive legacy snapshots without summaries alongside new snapshots with attachment summaries", () => {
  const legacy = {
    id: "request",
    kind: "user" as const,
    title: "You",
    text: "Original full request",
    status: "complete" as const,
  };
  const snapshot = {
    ...state(),
    details: {
      session: { status: "complete" as const, output: "", error: null, sections: [legacy] },
    },
  };

  expect(expectOk(parseSnapshot(snapshot)).details.session?.sections?.[0]?.request).toBeUndefined();

  const request = { text: "Inspect", images: 2, files: 1, fileName: "panel.ts" };
  const current = {
    ...snapshot,
    details: { session: { ...snapshot.details.session, sections: [{ ...legacy, request }] } },
  };

  expect(expectOk(parseSnapshot(current)).details.session?.sections?.[0]?.request).toEqual(request);
  expect(
    expectError(
      parseSnapshot({
        ...snapshot,
        details: {
          session: {
            ...snapshot.details.session,
            sections: [{ ...legacy, request: { ...request, images: -1 } }],
          },
        },
      }),
    ).code,
  ).toBe("PROTOCOL_ERROR");
});

test("Compaction metadata stays backward-compatible and rejects unknown activities", () => {
  // Existing services omit compaction activity, so fields remain optional.
  const legacy = {
    ...state(),
    details: { session: { status: "working", output: "", error: null } },
  };
  expect(expectOk(parseSnapshot(legacy)).details.session).not.toHaveProperty("activity");

  // IPC parsers preserve actual compaction lifetimes from new services.
  const current = {
    ...legacy,
    details: { session: { ...legacy.details.session, activity: "compacting" } },
  };
  expect(expectOk(parseSnapshot(current)).details.session).toHaveProperty("activity", "compacting");

  // Reject invalid activity strings instead of letting UI guess.
  expect(
    expectError(
      parseSnapshot({
        ...current,
        details: { session: { ...current.details.session, activity: "unknown" } },
      }),
    ).code,
  ).toBe("PROTOCOL_ERROR");
});

test("Initial HTTP snapshots preserve multiple sessions exceeding 8 MiB", async () => {
  const large: RuntimeSnapshot = {
    ...state(),
    details: Object.fromEntries(
      Array.from({ length: 4 }, (_, index) => [
        `session-${index}`,
        {
          status: "complete",
          output: "",
          error: null,
          sections: [
            {
              id: `section-${index}`,
              kind: "assistant",
              title: "Agent",
              text: "x".repeat(2300000),
              status: "complete",
            },
          ],
        },
      ]),
    ),
  };
  const bytes = encoder.encode(JSON.stringify(large));

  expect(bytes.byteLength).toBeGreaterThan(maxFrameBytes);

  const fetchMock = stubFetch(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let offset = 0; offset < bytes.length; offset += 65533) {
              controller.enqueue(bytes.subarray(offset, offset + 65533));
            }

            controller.close();
          },
        }),
      ),
  );
  try {
    const snapshot = expectOk(await fetchSnapshot(paths));
    expect(Object.keys(snapshot!.details)).toHaveLength(4);
    expect(snapshot!.details["session-3"]!.sections![0]!.text).toBe(
      large.details["session-3"]!.sections![0]!.text,
    );
  } finally {
    fetchMock.mockRestore();
  }
});

test("HTTP snapshots beyond dedicated limits discard bodies and return protocol errors", async () => {
  let cancelled = false;
  const fetchMock = stubFetch(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("{}"));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Length": String(maxSnapshotBytes + 1) } },
      ),
  );
  try {
    expect(expectError(await fetchSnapshot(paths)).code).toBe("PROTOCOL_ERROR");
    expect(cancelled).toBe(true);
  } finally {
    fetchMock.mockRestore();
  }
});

test("Responses without Content-Length enforce actual byte limits and clean active streams", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("1234567890"));
        controller.enqueue(encoder.encode("1234567890"));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );

  expect(expectError(await readJson(response, { maximumBytes: 16 })).code).toBe("PROTOCOL_ERROR");
  expect(cancelled).toBe(true);
});

test("Larger snapshot limits never permit oversized commands or model execution", async () => {
  const fetchMock = stubFetch(async () => {
    throw new Error("Oversized command must not reach transport");
  });
  const client = new RuntimeClient(paths, state());
  try {
    expect(expectError(await client.prompt("session", "x".repeat(maxFrameBytes))).code).toBe(
      "INVALID_INPUT",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    await client.disconnect();
    fetchMock.mockRestore();
  }
});

test("Invalid UTF-8 never becomes replacement characters and network failures differ from bugs", async () => {
  expect(expectError(await readJson(new Response(Uint8Array.of(0xff)))).code).toBe(
    "PROTOCOL_ERROR",
  );

  const connection = Object.assign(new Error("fixture reset"), { code: "ECONNRESET" });
  const failed = (error: Error) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(error);
        },
      }),
    );

  expect(expectError(await readJson(failed(connection))).code).toBe("CONNECTION_FAILED");

  const defect = new TypeError("fixture programming defect");
  await expect(readJson(failed(defect))).rejects.toBe(defect);
});
