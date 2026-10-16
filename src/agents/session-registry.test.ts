import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoWorkspace } from "../workspace/demo.ts";
import { WorkspaceSelection } from "../app/workspace-selection.ts";
import { SessionRegistry, type ExecutionState, type SessionContext, type SessionExecutor } from "./session-registry.ts";
import { expectOk, expectError } from "../testing/results.ts";
import { err, ok, type Result } from "../result.ts";
import { StorageError, type ExpectedError } from "../errors.ts";

class ControlledExecutor implements SessionExecutor {
  readonly savedSessionId = crypto.randomUUID();
  state: ExecutionState = { status: null, output: "", error: null };
  readonly listeners = new Set<() => void>();
  readonly closeStarted = Promise.withResolvers<void>();
  readonly finishClose = Promise.withResolvers<void>();
  closeCalls = 0;
  promptCalls = 0;
  failClose = false;
  constructor(readonly sessionFile: string | undefined = undefined) {}
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async prompt(): Promise<Result<void, ExpectedError>> { this.promptCalls++; this.update({ status: "working", output: "running", error: null }); return ok(undefined); }
  update(state: ExecutionState) { this.state = state; for (const listener of this.listeners) listener(); }
  async close(): Promise<Result<void, ExpectedError>> {
    this.closeCalls++; this.closeStarted.resolve();
    if (this.failClose) return err(new StorageError("controlled cleanup failure"));
    await this.finishClose.promise; return ok(undefined);
  }
}

function setup() {
  const executors: ControlledExecutor[] = [];
  const contexts: SessionContext[] = [];
  const repositories = demoWorkspace().map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => ({ ...tree, sessions: [] })) }));
  const registry = new SessionRegistry(repositories, async (context) => {
    const executor = new ControlledExecutor(context.sessionFile);
    contexts.push(context); executors.push(executor);
    return executor;
  });
  const selection = new WorkspaceSelection(registry.snapshot);
  const unsubscribe = registry.subscribe(() => selection.replaceSnapshot(registry.snapshot));
  return { registry, selection, executors, contexts, async cleanup() {
    executors.forEach((executor) => { executor.failClose = false; executor.finishClose.resolve(); });
    await registry.shutdown(); unsubscribe();
  } };
}

test("워크트리 전환과 비선택 실행의 갱신은 기존 실행 핸들을 종료하거나 다시 만들지 않는다", async () => {
  // Registry snapshots, not view selection, own the executor instances.
  const app = setup();
  try {
    const a = expectOk(await app.registry.create("demo:main"));
    const b = expectOk(await app.registry.create("demo:feature"));
    expectOk(await app.registry.prompt(a, "continue"));

    // Leaving A does not unsubscribe A's background events.
    app.selection.selectSession("demo:feature", b);
    app.executors[0]!.update({ status: "complete", output: "background result", error: null });
    app.selection.selectWorktree("demo:main");

    // The original handle, result and per-worktree selection survive.
    expect(app.selection.sessionId).toBe(a);
    expect(app.registry.details(a)?.output).toBe("background result");
    expect(app.executors).toHaveLength(2);
    expect(app.executors.map((executor) => executor.closeCalls)).toEqual([0, 0]);
    expect(app.contexts.map((context) => context.cwd)).toEqual(["/demo/radian", "/demo/radian-ui"]);
  } finally { await app.cleanup(); }
});

test("닫기는 즉시 표시 항목을 제거하고 종료 완료까지 핸들을 보관하며 중복 요청을 합친다", async () => {
  // Cleanup is deliberately blocked so optimistic UI behavior is independently observable.
  const app = setup();
  try {
    const a = expectOk(await app.registry.create("demo:main"));
    const b = expectOk(await app.registry.create("demo:main"));
    app.selection.selectSession("demo:main", a);

    // The display changes synchronously, before the executor acknowledges cancellation.
    const closing = app.registry.close(a);
    expect(app.registry.close(a)).toBe(closing);
    expect(app.selection.sessionId).toBe(b);
    expect(app.registry.closingCount).toBe(1);
    await app.executors[0]!.closeStarted.promise;
    app.executors[0]!.update({ status: "working", output: "late event", error: null });
    expect(expectError(await app.registry.prompt(a, "late prompt")).code).toBe("SESSION_NOT_OPEN");
    expect(expectError(await app.contexts[0]!.spawnSubagent("late", "task")).code).toBe("SESSION_NOT_OPEN");

    // Late events cannot resurrect the row or close an unrelated session.
    expect(app.selection.worktree?.sessions.map((session) => session.id)).toEqual([b]);
    expect(app.executors[1]!.closeCalls).toBe(0);
    app.executors[0]!.finishClose.resolve();
    await closing;
    expect(app.registry.closingCount).toBe(0);
    expect(app.executors[0]!.listeners.size).toBe(0);
    expect(app.executors[0]!.closeCalls).toBe(1);
  } finally { await app.cleanup(); }
});

test("주 agent와 소속 자식의 취소를 함께 시작해 부모가 자식을 기다리는 교착을 피한다", async () => {
  // A child remains owned while its cleanup is blocked.
  const app = setup();
  try {
    const id = expectOk(await app.registry.create("demo:main"));
    const started = Promise.withResolvers<void>();
    const unsubscribe = app.registry.subscribe(() => {
      if (app.registry.snapshot[0]?.worktrees[0]?.sessions[0]?.subagents[0]?.status === "working") started.resolve();
    });
    const child = app.contexts[0]!.spawnSubagent("child", "task");
    // The child prompt finishes but its owned cleanup has not yet completed.
    await started.promise;
    unsubscribe();
    await app.executors[1]!.closeStarted.promise;

    // Parent close must start without first waiting for the child to finish cleanup.
    const closing = app.registry.close(id);
    await app.executors[0]!.closeStarted.promise;
    app.executors[0]!.finishClose.resolve();
    app.executors[1]!.finishClose.resolve();
    await Promise.all([child, closing]);

    // Both owned handles are cleaned once and no hidden execution remains.
    expect(app.executors.map((executor) => executor.closeCalls)).toEqual([1, 1]);
    expect(app.registry.closingCount).toBe(0);
  } finally { await app.cleanup(); }
});

test("종료 실패는 숨겨진 핸들을 잃지 않고 재시도할 수 있으며 성공으로 처리하지 않는다", async () => {
  // The first cleanup attempt fails instead of acknowledging termination.
  const app = setup();
  try {
    const id = expectOk(await app.registry.create("demo:main"));
    app.executors[0]!.failClose = true;

    // The row disappears, but the rejected close remains visible to its caller.
    expect(expectError(await app.registry.close(id)).code).toBe("CLEANUP_FAILED");
    expect(app.registry.snapshot[0]!.worktrees[0]!.sessions).toEqual([]);
    expect(app.registry.closingCount).toBe(1);
    app.executors[0]!.failClose = false;
    app.executors[0]!.finishClose.resolve();
    await app.registry.close(id);

    // Retry cleans the retained handle; it does not manufacture a replacement execution.
    expect(app.executors[0]!.closeCalls).toBe(2);
    expect(app.registry.closingCount).toBe(0);
  } finally { await app.cleanup(); }
});

test("shutdown과 생성이 겹쳐도 늦게 생성된 실행을 정리하고 열린 항목으로 되살리지 않는다", async () => {
  // Factory completion is under test control rather than a timing-dependent sleep.
  const ready = Promise.withResolvers<SessionExecutor>();
  const executor = new ControlledExecutor();
  executor.finishClose.resolve();
  const registry = new SessionRegistry(demoWorkspace(), () => ready.promise);
  const creation = registry.create("demo:main");
  const creationOutcome = creation;

  // Shutdown takes ownership before the factory supplies its handle.
  const shutdown = registry.shutdown();
  ready.resolve(executor);
  const [creationResult, shutdownResult] = await Promise.all([creationOutcome, shutdown]);
  expect(expectError(creationResult).code).toBe("CANCELLED");
  expectOk(shutdownResult);

  // No new work can enter and no late factory result is leaked.
  expect(executor.closeCalls).toBe(1);
  expect(registry.snapshot[0]!.worktrees[0]!.sessions).toEqual([]);
  expect(expectError(await registry.create("demo:main")).code).toBe("RUNTIME_STOPPING");
});

test("부모 닫기와 자식 생성이 겹치면 늦은 자식을 실행하지 않고 정리한다", async () => {
  // The parent exists while its child's factory is held at the creation boundary.
  const childReady = Promise.withResolvers<SessionExecutor>();
  const parent = new ControlledExecutor();
  const child = new ControlledExecutor();
  parent.finishClose.resolve(); child.finishClose.resolve();
  let context: SessionContext | undefined;
  const registry = new SessionRegistry(demoWorkspace(), async (input) => {
    if (input.role === "subagent") return childReady.promise;
    context = input; return parent;
  });
  const id = expectOk(await registry.create("demo:main"));
  const spawning = context!.spawnSubagent("pending", "task");
  const spawnOutcome = spawning;

  // Close removes the root immediately, then awaits the pending child's eventual handle.
  const closing = registry.close(id);
  childReady.resolve(child);
  const [closed, spawnResult] = await Promise.all([closing, spawnOutcome]);
  expectOk(closed);
  expect(expectError(spawnResult).code).toBe("SESSION_NOT_OPEN");

  // The child cannot start work after its owner closes.
  expect(child.promptCalls).toBe(0);
  expect(child.closeCalls).toBe(1);
  expect(registry.closingCount).toBe(0);
  await registry.shutdown();
});

test("동일 저장 파일과 심볼릭 링크의 중복 열기는 종료가 끝날 때까지 차단한다", async () => {
  // Canonical identity, not UI IDs or spelling of the path, protects a saved history writer.
  const directory = await mkdtemp(join(tmpdir(), "radian-registry-file-"));
  const file = join(directory, "session.jsonl");
  const alias = join(directory, "alias.jsonl");
  const executor = new ControlledExecutor(file);
  const registry = new SessionRegistry(demoWorkspace(), async () => executor);
  try {
    await writeFile(file, "existing history\n"); await symlink(file, alias);
    const id = expectOk(await registry.create("demo:main", file));

    // A closing row is hidden, but its writer reservation remains until cleanup completes.
    expect(expectError(await registry.create("demo:main", alias)).code).toBe("SESSION_CONFLICT");
    const closing = registry.close(id);
    expect(expectError(await registry.create("demo:main", alias)).code).toBe("SESSION_CONFLICT");
    executor.finishClose.resolve();
    await closing;
    const reopened = expectOk(await registry.create("demo:main", alias));

    // Reopening uses the original file instead of cloning or deleting it.
    expect(registry.sessionFile(reopened)).toBe(file);
    expect(await Bun.file(file).text()).toBe("existing history\n");
  } finally { executor.finishClose.resolve(); await registry.shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test("런타임 복구는 저장된 Fast·weekly 대신 새 SDK 텔레메트리를 사용한다", async () => {
  // A previous process's account allowance and request tier are not current measurements.
  const executor = new ControlledExecutor();
  const fresh: NonNullable<ExecutionState["telemetry"]> = { provider: "provider", model: "current-model", effort: "high", fast: null,
    context: { usedTokens: 1000, maxTokens: 200000 }, weekly: null };
  executor.state = { status: "complete", output: "", error: null, telemetry: fresh };
  const registry = new SessionRegistry(demoWorkspace(), async () => executor);
  try {
    expectOk(await registry.restore({ id: "restored", name: "Restored", worktreeId: "demo:main", subagents: [],
      state: { status: "complete", output: "", error: null, telemetry: { ...fresh, model: "old-model", fast: true,
        weekly: { remainingPercent: 82, observedAt: 1800000000000, resetsAt: 1800003600000 } } } }));

    expect(registry.details("restored")?.telemetry).toEqual(fresh);
    expect(registry.records[0]?.state.telemetry?.weekly).toBeNull();
  } finally { executor.finishClose.resolve(); await registry.shutdown(); }
});

test("생성 실패는 빈 워크트리를 유지하며 자동 재생성하지 않는다", async () => {
  // Factory failure is a user-visible failure, not an invented placeholder session.
  let calls = 0;
  const registry = new SessionRegistry(demoWorkspace(), async () => { calls++; throw new StorageError("factory failed"); });

  // The explicit creation request is rejected and its reservation is cleaned.
  expect(expectError(await registry.create("demo:main")).code).toBe("STORAGE_FAILED");
  await registry.shutdown();

  // No ghost item or automatic retry changes the user's empty workspace.
  expect(calls).toBe(1);
  expect(registry.snapshot[0]!.worktrees[0]!.sessions).toEqual([]);
  expect(registry.closingCount).toBe(0);
});

test("subagent 생성 실패도 부모의 표시 snapshot에 실패로 남고 미보고나 완료로 숨기지 않는다", async () => {
  // A child factory failure has no executor state from which to infer its outcome.
  const parent = new ControlledExecutor();
  parent.finishClose.resolve();
  let context: SessionContext | undefined;
  const registry = new SessionRegistry(demoWorkspace(), async (input) => {
    if (input.role === "subagent") throw new StorageError("child setup failed");
    context = input; return parent;
  });
  await registry.create("demo:main");

  // Delegation surfaces the setup error and retains a normalized failure outcome.
  expect(expectError(await context!.spawnSubagent("failed child", "task")).code).toBe("STORAGE_FAILED");

  // The failure wins in the existing UI aggregation even though no child handle was created.
  expect(registry.snapshot[0]!.worktrees[0]!.sessions[0]!.subagents[0]?.status).toBe("failure");
  await registry.shutdown();
});
