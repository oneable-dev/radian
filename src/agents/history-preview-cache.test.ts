import { expect, test } from "bun:test";
import { HistoryPreviewCache } from "./history-preview-cache.ts";
import type { HistoryPreview } from "./history-preview.ts";
import { HistoryError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

const preview = (id: string, worktreeId = "tree"): HistoryPreview => ({
  worktreeId,
  id,
  text: `Preview ${id}`,
  truncated: false,
});
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const unexpected = (error: unknown): string => {
  throw error;
};

test("Concurrent previews share requests and completed previews reuse cache without timers", async () => {
  // Repeated selection during a file read must not duplicate I/O.
  const pending = Promise.withResolvers<Result<HistoryPreview, HistoryError>>();
  let calls = 0,
    changed = 0;
  const cache = new HistoryPreviewCache(
    async () => {
      calls++;
      return pending.promise;
    },
    () => {
      changed++;
    },
    unexpected,
  );
  try {
    cache.select("tree", "a");
    cache.select("tree", "a");
    await flush();
    expect(calls).toBe(1);
    expect(cache.read("tree", "a")?.kind).toBe("pending");
    pending.resolve(ok(preview("a")));
    await flush();

    // Revisiting completed data returns immediately from the same cache slot.
    expect(cache.select("tree", "a")).toEqual({ kind: "ready", value: preview("a") });
    expect(calls).toBe(1);
    expect(changed).toBe(1);
  } finally {
    cache.clear();
    pending.resolve(ok(preview("a")));
    await flush();
  }
});

test("Preview concurrency is limited to two with only the latest queued selection", async () => {
  // Do not read every transient selection in FIFO order.
  const requests: string[] = [],
    pending = new Map<
      string,
      ReturnType<typeof Promise.withResolvers<Result<HistoryPreview, HistoryError>>>
    >();
  const cache = new HistoryPreviewCache(
    async (_tree, id) => {
      requests.push(id);
      const task = Promise.withResolvers<Result<HistoryPreview, HistoryError>>();
      pending.set(id, task);
      return task.promise;
    },
    () => {},
    unexpected,
  );
  try {
    for (const id of ["a", "b", "c", "d"]) cache.select("tree", id);
    await flush();
    expect(requests).toEqual(["a", "b"]);
    expect(cache.read("tree", "c")).toBeUndefined();
    pending.get("a")!.resolve(ok(preview("a")));
    await flush();

    // When a slot opens, fetch current selection D instead of discarded C.
    expect(requests).toEqual(["a", "b", "d"]);
    expect(cache.read("tree", "b")?.kind).toBe("pending");
    pending.get("d")!.resolve(ok(preview("d")));
    await flush();
    pending.get("b")!.resolve(ok(preview("b")));
    await flush();
    expect(cache.read("tree", "d")).toEqual({ kind: "ready", value: preview("d") });
    expect(cache.select("tree", "a")).toEqual({ kind: "ready", value: preview("a") });
  } finally {
    cache.clear();
    for (const [id, task] of pending) task.resolve(ok(preview(id)));
    await flush();
  }
});

test("Old responses cannot overwrite new cache entries after clearing and reloading the same ID", async () => {
  // Closing and refreshing create new generations even for identical IDs.
  const old = Promise.withResolvers<Result<HistoryPreview, HistoryError>>();
  const signals: AbortSignal[] = [];
  let calls = 0;
  const cache = new HistoryPreviewCache(
    async (_tree, id, signal) => {
      signals.push(signal);
      return ++calls === 1 ? old.promise : ok({ ...preview(id), text: "Fresh" });
    },
    () => {},
    unexpected,
  );
  try {
    cache.select("tree", "a");
    await flush();
    cache.clear();
    cache.select("tree", "a");
    await flush();
    expect(signals[0]!.aborted).toBe(true);
    old.resolve(ok({ ...preview("a"), text: "Stale" }));
    await flush();
    expect(cache.read("tree", "a")).toEqual({
      kind: "ready",
      value: { ...preview("a"), text: "Fresh" },
    });
  } finally {
    cache.clear();
    old.resolve(ok(preview("a")));
    await flush();
  }
});

test("Identical saved IDs in different worktrees use separate cache slots and preserve errors", async () => {
  // Global ID-only caching could reuse another worktree's results or failures.
  const failure = new HistoryError("HISTORY_UNAVAILABLE", "Deleted saved conversation");
  let calls = 0;
  const cache = new HistoryPreviewCache(
    async (tree, id) => {
      calls++;
      return tree === "gone" ? err(failure) : ok(preview(id, tree));
    },
    () => {},
    unexpected,
  );
  try {
    cache.select("tree", "a");
    await flush();
    cache.select("gone", "a");
    await flush();
    expect(cache.read("tree", "a")).toEqual({ kind: "ready", value: preview("a") });
    expect(cache.read("gone", "a")).toEqual({ kind: "error", error: failure });
    expect(calls).toBe(2);
  } finally {
    cache.clear();
  }
});

test("Capacity eviction removes old results but preserves current selection and active requests", async () => {
  // Exceed the serialized-text budget rather than measuring actual heap usage.
  const text = "x".repeat(3 * 1024 * 1024);
  const cache = new HistoryPreviewCache(
    async (tree, id) => ok({ ...preview(id, tree), text }),
    () => {},
    unexpected,
  );
  try {
    for (const id of ["a", "b", "c"]) {
      cache.select("tree", id);
      await flush();
    }
    expect(cache.read("tree", "a")).toBeUndefined();
    expect(cache.read("tree", "b")?.kind).toBe("ready");
    expect(cache.read("tree", "c")?.kind).toBe("ready");
  } finally {
    cache.clear();
  }
});

test("Background previews are ready before selection and invalidate only changed versions", async () => {
  // Metadata versions allow unchanged conversations to survive external file notifications.
  const calls: string[] = [];
  const cache = new HistoryPreviewCache(
    async (tree, id) => {
      calls.push(id);
      return ok(preview(id, tree));
    },
    () => {},
    unexpected,
  );
  try {
    cache.preload("tree", [
      { id: "a", revision: "1" },
      { id: "b", revision: "1" },
    ]);
    await flush();
    expect(cache.select("tree", "b").kind).toBe("ready");
    cache.unselect();
    expect(calls).toEqual(["a", "b"]);

    // A changed body is replaced while unchanged B remains immediately available.
    cache.preload("tree", [
      { id: "a", revision: "2" },
      { id: "b", revision: "1" },
    ]);
    await flush();
    expect(calls).toEqual(["a", "b", "a"]);
    expect(cache.read("tree", "b")?.kind).toBe("ready");
    cache.preload("tree", [{ id: "b", revision: "1" }]);
    expect(cache.read("tree", "a")).toBeUndefined();
  } finally {
    cache.clear();
  }
});

test("Visible selection takes priority over queued background previews within two read slots", async () => {
  // Startup preparation must not force the user to wait behind a long FIFO queue.
  const calls: string[] = [],
    pending = new Map<
      string,
      ReturnType<typeof Promise.withResolvers<Result<HistoryPreview, HistoryError>>>
    >();
  const cache = new HistoryPreviewCache(
    async (_tree, id) => {
      calls.push(id);
      const task = Promise.withResolvers<Result<HistoryPreview, HistoryError>>();
      pending.set(id, task);
      return task.promise;
    },
    () => {},
    unexpected,
  );
  try {
    cache.preload(
      "tree",
      ["a", "b", "c", "d"].map((id) => ({ id, revision: "1" })),
    );
    await flush();
    expect(calls).toEqual(["a", "b"]);
    cache.select("tree", "d");
    pending.get("a")!.resolve(ok(preview("a")));
    await flush();
    expect(calls).toEqual(["a", "b", "d"]);
  } finally {
    cache.clear();
    for (const [id, task] of pending) task.resolve(ok(preview(id)));
    await flush();
  }
});

test("Unexpected failures reach the UI boundary unchanged instead of becoming lookup errors", async () => {
  // Programming errors must remain observable for logging, not become empty previews.
  const error = new TypeError("Broken loader"),
    reported: unknown[] = [];
  const cache = new HistoryPreviewCache(
    async () => {
      throw error;
    },
    () => {},
    (failure) => {
      reported.push(failure);
      return "Unexpected preview failure";
    },
  );
  try {
    cache.select("tree", "a");
    await flush();
    expect(reported).toEqual([error]);
    expect(cache.read("tree", "a")).toEqual({
      kind: "unexpected",
      message: "Unexpected preview failure",
    });
  } finally {
    cache.clear();
  }
});
