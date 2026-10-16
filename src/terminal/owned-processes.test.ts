import { expect, test } from "bun:test";
import { OwnedProcesses, type ProcessOperations } from "./owned-processes.ts";
import { ok } from "../result.ts";
import { expectError, expectOk } from "../testing/results.ts";

const anchorPid = 2000000000, childPid = anchorPid - 1, otherPid = anchorPid - 2;
function fixture() {
  let alive = true;
  const live = new Set([childPid]); const signals: number[] = [];
  const ops: ProcessOperations = {
    sessionId: (pid) => pid === anchorPid || live.has(pid) ? anchorPid : 42,
    list: async () => ok([...live, -1, 0, 1, process.pid, process.ppid, anchorPid, otherPid].map((pid) => ({ pid, zombie: false }))),
    signal: (pid) => { signals.push(pid); live.delete(pid); },
  };
  return { ops, signals, live, anchor: { pid: anchorPid, alive: () => alive }, loseAnchor() { alive = false; } };
}

test.each([-1, 0, 1, process.pid, process.ppid, NaN, Infinity, 2147483648])("소유권 anchor로 금지된 PID %d를 받으면 신호 없이 거절한다", (pid) => {
  const app = fixture();
  expect(expectError(OwnedProcesses.capture({ pid, alive: () => true }, app.ops)).code).toBe("INVALID_INPUT");
  expect(app.signals).toEqual([]);
});

test("세션 식별자가 0이면 소유권으로 인정하지 않는다", () => {
  const app = fixture(); app.ops.sessionId = () => 0;
  expect(expectError(OwnedProcesses.capture(app.anchor, app.ops)).code).toBe("PTY_OWNERSHIP_LOST");
  expect(app.signals).toEqual([]);
});

test("종료는 현재 소유 세션의 양수 child PID에만 신호를 보내고 anchor와 무관한 프로세스를 보존한다", async () => {
  const app = fixture(); const owner = expectOk(OwnedProcesses.capture(app.anchor, app.ops));
  expectOk(await owner.stopChildren());
  expect(app.signals).toEqual([childPid]);
  expect(app.signals.every((pid) => pid > 1 && pid !== anchorPid && pid !== process.pid && pid !== process.ppid)).toBe(true);
});

test("조회 후 anchor가 사라지면 종료를 중단하며 추측해서 신호를 보내지 않는다", async () => {
  const app = fixture(); const owner = expectOk(OwnedProcesses.capture(app.anchor, app.ops));
  app.ops.list = async () => { app.loseAnchor(); return ok([{ pid: childPid, zombie: false }]); };
  expect(expectError(await owner.stopChildren()).code).toBe("PTY_OWNERSHIP_LOST");
  expect(app.signals).toEqual([]);
});

test("신호 직전 PID의 소유 세션이 바뀌면 해당 PID를 건너뛴다", async () => {
  const app = fixture(); let reads = 0;
  app.ops.sessionId = (pid) => pid === anchorPid ? anchorPid : pid === childPid && ++reads === 1 ? anchorPid : 42;
  const owner = expectOk(OwnedProcesses.capture(app.anchor, app.ops));
  expectOk(await owner.stopChildren()); expect(app.signals).toEqual([]);
});
