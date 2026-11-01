import { expect, test } from "bun:test";
import { StorageError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { SessionDeletionCandidate } from "../agents/session-registry.ts";
import type { DeletionReceipt } from "../workspace/deletion.ts";
import type { CleanupReceipt } from "./daemon-protocol.ts";
import type { DeletedScopes } from "./protocol.ts";
import { cleanupToken, type CleanupReport, type WorkspaceCleanup } from "./workspace-cleanup.ts";
import { WorkspaceDeletion, type BlockedScope } from "./workspace-deletion.ts";

const evidence: DeletionReceipt = {
  version: 1,
  id: "evidence-1",
  kind: "worktree",
  repositoryId: "/repo/.git",
  evidence: "darwin-kqueue-note-delete",
  directories: [],
  scopes: [{ worktreeId: "/linked", path: "/linked", identity: null }],
};

function receipt(state: CleanupReceipt["state"]): CleanupReceipt {
  return {
    token: cleanupToken(evidence.id),
    repositoryId: evidence.repositoryId,
    kind: "worktrees",
    worktrees: [{ id: "/linked", path: "/linked" }],
    sessionIds: ["old-session"],
    revision: 1,
    state,
    updatedAt: 1,
  };
}

function report(complete: boolean): CleanupReport {
  return {
    token: cleanupToken(evidence.id),
    complete,
    receipt: receipt(complete ? "purged" : "fenced"),
    removed: [],
    rewritten: [],
    preserved: [],
    residuals: complete ? [] : [{ path: "/state/workspace.json", reason: "Unreadable" }],
  };
}

// Records the order of every phase across the cleanup port and the daemon hooks.
function harness(options: { durable?: Result<CleanupReceipt, ExpectedError>[] } = {}) {
  const calls: string[] = [];
  const purges: boolean[] = [];
  const candidates: SessionDeletionCandidate[] = [];
  const purgedCandidates: SessionDeletionCandidate[][] = [];
  const durable = options.durable ?? [ok(receipt("fenced"))];
  let queue: Promise<unknown> = Promise.resolve();
  const cleanup = {
    fence(_scope: unknown, token: string) {
      calls.push("fence");
      return { token, durable: Promise.resolve(durable.shift() ?? ok(receipt("fenced"))) };
    },
    async purge(_token: string, input: { candidates: readonly SessionDeletionCandidate[] }) {
      calls.push("purge");
      purgedCandidates.push([...input.candidates]);
      return ok(report(purges.shift() ?? true));
    },
    async reopen() {
      calls.push("reopen");
      return ok(receipt("reopened"));
    },
    async resume() {
      return ok([]);
    },
    deletedScopes(): DeletedScopes | undefined {
      return undefined;
    },
  } as unknown as WorkspaceCleanup;
  const fenced: BlockedScope[] = [];
  const deletion = new WorkspaceDeletion(cleanup, {
    fence: (scope) => {
      calls.push("block");
      fenced.push(scope);
    },
    acknowledge: (id) => calls.push(`acknowledge:${id}`),
    stopWriters: async () => {
      calls.push("stop");
      return ok({ candidates: [...candidates], release: async () => void calls.push("unreserve") });
    },
    purged: () => calls.push("adopt"),
    reopened: async () => {
      calls.push("release");
      return ok(undefined);
    },
    stopping: () => false,
    serialize: (task) => {
      const next = queue.then(task, task);
      queue = next.catch(() => undefined);
      return next;
    },
    changed: () => {},
  });

  return { calls, purges, fenced, deletion, candidates, purgedCandidates };
}

test("Confirmed deletion blocks synchronously and releases resources only after purge and reopen", async () => {
  // The fence must exist before the tracker listener returns.
  const { calls, fenced, deletion } = harness();

  deletion.receive(evidence);
  const blockedImmediately = deletion.blocked(evidence.repositoryId);
  await deletion.idle();

  expect(fenced.map((scope) => [...scope.worktreeIds])).toEqual([["/linked"]]);
  expect(blockedImmediately.worktreeIds.has("/linked")).toBe(true);
  expect(calls).toEqual([
    "block",
    "fence",
    "acknowledge:evidence-1",
    "stop",
    "purge",
    "unreserve",
    "adopt",
    "reopen",
    "release",
  ]);
  expect(deletion.blocked(evidence.repositoryId).worktreeIds.size).toBe(0);
  expect(deletion.notice).toBe("");
});

test("An incomplete purge keeps the scope fenced and visible until an idempotent retry", async () => {
  // Residuals are neither success nor rollback; the same token is retried.
  const { calls, purges, deletion } = harness();
  purges.push(false);

  deletion.receive(evidence);
  await deletion.idle();

  expect(deletion.blocked(evidence.repositoryId).worktreeIds.has("/linked")).toBe(true);
  expect(deletion.notice).toContain("CLEANUP_FAILED");
  expect(calls).not.toContain("reopen");
  expect(calls).not.toContain("release");

  deletion.retry();
  await deletion.idle();

  expect(calls.filter((call) => call === "purge")).toHaveLength(2);
  expect(calls.at(-1)).toBe("release");
  expect(deletion.blocked(evidence.repositoryId).worktreeIds.size).toBe(0);
});

test("A failed durable record keeps tracker evidence unacknowledged and stops before purge", async () => {
  // Without a durable receipt, a restart would have no authority; the proof stays pending.
  const { calls, deletion, candidates, purgedCandidates } = harness({
    durable: [err(new StorageError("Ledger write failed."))],
  });
  const late: SessionDeletionCandidate = {
    worktreeId: "/linked",
    sessionId: "late-tab",
    role: "main",
    conversationId: "late-sdk",
    sessionFile: "/state/sdk-sessions/late.jsonl",
    managed: true,
  };
  candidates.push(late);

  deletion.receive(evidence);
  await deletion.idle();

  expect(calls.some((call) => call.startsWith("acknowledge"))).toBe(false);
  expect(calls).not.toContain("purge");
  expect(calls).toContain("stop");
  expect(calls).toContain("unreserve");
  expect(deletion.notice).toContain("STORAGE_FAILED");
  expect(deletion.blocked(evidence.repositoryId).worktreeIds.has("/linked")).toBe(true);

  // The stopped host can disappear, but its late SDK identity must survive until a durable retry.
  candidates.length = 0;
  deletion.retry();
  await deletion.idle();

  expect(purgedCandidates[0]).toContainEqual(late);
  expect(calls).toContain("acknowledge:evidence-1");
  expect(calls.at(-1)).toBe("release");
});

test("Repeated evidence for the same proof starts one cleanup", async () => {
  // A stable token makes repeated tracker notifications idempotent.
  const { calls, deletion } = harness();

  deletion.receive(evidence);
  deletion.receive(evidence);
  await deletion.idle();

  expect(calls.filter((call) => call === "fence")).toHaveLength(1);
  expect(calls.filter((call) => call === "purge")).toHaveLength(1);
});
