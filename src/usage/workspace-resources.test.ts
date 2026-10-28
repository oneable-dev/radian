import { expect, test } from "bun:test";
import { CancelledError, ResourceError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { readWorkspaceResources, type WorkspaceResourceScope } from "./workspace-resources.ts";

const start = "Mon Sep 14 19:01:31 2026";
const row = (pid: number, parent: number, rss = 10, cpu = "0:01.00") =>
  `${pid} ${parent} ${rss} ${cpu} ${start}`;
const scope = (id: string, ...pids: number[]): WorkspaceResourceScope => ({
  id,
  name: `Project / ${id}`,
  roots: pids.map((pid) => ({ pid, parentPid: 10 })),
});

test("Workspace resources follow editor and terminal descendants without counting shared or unrelated processes", async () => {
  // Duplicate ownership entries must not count a terminal tree twice.
  const scopes = [scope("main", 100, 100, 200), scope("feature", 300)];
  const output = [
    row(10, 1),
    row(100, 10),
    row(101, 100),
    row(102, 101),
    row(200, 10),
    row(201, 200),
    row(300, 10),
    row(999, 1),
  ].join("\n");

  const samples = expectOk(
    await readWorkspaceResources(scopes, new AbortController().signal, async () => ok(output)),
  );

  // The shared Runtime and processes from other applications never enter workspace totals.
  expect(samples[0]!.processes?.map((process) => process.pid).sort((a, b) => a - b)).toEqual([
    100, 101, 102, 200, 201,
  ]);
  expect(samples[1]!.processes?.map((process) => process.pid)).toEqual([300]);
  expect(samples[0]!.processes?.reduce((sum, process) => sum + process.rssBytes, 0)).toBe(
    50 * 1024,
  );
});

test.each([
  ["1:02.50", 62500000],
  ["123:04.09", 7384090000],
  ["2:03:04", 7384000000],
  ["1-02:03:04.01", 93784010000],
] as const)("Process CPU time %s converts to %i cumulative microseconds", async (time, micros) => {
  // BSD and Linux expose different process time formats through the same ps column.
  const samples = expectOk(
    await readWorkspaceResources([scope("main", 100)], new AbortController().signal, async () =>
      ok(row(100, 10, 2048, time)),
    ),
  );

  // Preserve cumulative counters and convert RSS from KiB to bytes without lifetime percentages.
  expect(samples[0]!.processes?.[0]).toMatchObject({
    pid: 100,
    cpuMicros: micros,
    rssBytes: 2097152,
    started: start,
  });
});

test("Missing or recycled roots stay unavailable while known idle workspaces report no processes", async () => {
  // A recycled editor PID now belongs to another parent, and a second editor has disappeared.
  const scopes = [
    scope("recycled", 100),
    scope("ended", 200),
    scope("idle"),
    { ...scope("offline"), roots: null },
  ];
  const samples = expectOk(
    await readWorkspaceResources(scopes, new AbortController().signal, async () =>
      ok(row(100, 999)),
    ),
  );

  // Unknown ownership is distinct from an observed empty workspace; it must never look like zero.
  expect(samples.map((sample) => [sample.id, sample.processes])).toEqual([
    ["recycled", null],
    ["ended", null],
    ["idle", []],
    ["offline", null],
  ]);
});

test("Idle and disconnected workspaces need no OS process inspection", async () => {
  // Cold repositories have no editor or terminal roots to inspect.
  const samples = expectOk(
    await readWorkspaceResources(
      [scope("idle"), { ...scope("offline"), roots: null }],
      new AbortController().signal,
      async () => {
        throw new Error("Unexpected process inspection");
      },
    ),
  );

  // Reading metrics cannot allocate runtime execution resources for an idle workspace.
  expect(samples.map((sample) => sample.processes)).toEqual([[], null]);
});

test.each([
  "",
  "100 10 12 invalid start",
  row(100, 10, -1),
  row(100, 10, 10, "0:65"),
  `${row(100, 10)}\n${row(100, 10)}`,
])(
  "Malformed process counters return typed failures instead of empty success: %s",
  async (output) => {
    // An OS response that cannot be trusted must not become plausible CPU/RAM readings.
    const result = await readWorkspaceResources(
      [scope("main", 100)],
      new AbortController().signal,
      async () => ok(output),
    );

    expect(expectError(result).code).toBe("RESOURCE_UNAVAILABLE");
  },
);

test("Cancelled inspection and OS failures preserve their distinct failure contracts", async () => {
  // The scanner may finish after its owning Usage screen has already closed.
  const abort = new AbortController();
  const pending = Promise.withResolvers<Result<string, ResourceError>>();
  const result = readWorkspaceResources([scope("main", 100)], abort.signal, () => pending.promise);
  abort.abort();
  pending.resolve(ok(row(100, 10)));

  expect(expectError(await result)).toBeInstanceOf(CancelledError);

  // A pre-cancelled read never launches ps, and a real inspection failure retains its cause.
  const failure = new ResourceError("Process lookup failed");
  expect(
    expectError(
      await readWorkspaceResources([scope("main", 100)], AbortSignal.abort(), async () => {
        throw new Error("Unexpected inspection");
      }),
    ).code,
  ).toBe("CANCELLED");
  expect(
    expectError(
      await readWorkspaceResources([scope("main", 100)], new AbortController().signal, async () =>
        err(failure),
      ),
    ),
  ).toBe(failure);
});
