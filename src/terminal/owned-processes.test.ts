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

test.each([-1, 0, 1, process.pid, process.ppid, NaN, Infinity, 2147483648])("Forbidden ownership-anchor PID %d is rejected without signals", (pid) => {
  const app = fixture();
  expect(expectError(OwnedProcesses.capture({ pid, alive: () => true }, app.ops)).code).toBe("INVALID_INPUT");
  expect(app.signals).toEqual([]);
});

test("Zero session identifiers never establish ownership", () => {
  const app = fixture(); app.ops.sessionId = () => 0;
  expect(expectError(OwnedProcesses.capture(app.anchor, app.ops)).code).toBe("PTY_OWNERSHIP_LOST");
  expect(app.signals).toEqual([]);
});

test("Termination signals only positive children in owned sessions while preserving anchors and unrelated processes", async () => {
  const app = fixture(); const owner = expectOk(OwnedProcesses.capture(app.anchor, app.ops));
  expectOk(await owner.stopChildren());
  expect(app.signals).toEqual([childPid]);
  expect(app.signals.every((pid) => pid > 1 && pid !== anchorPid && pid !== process.pid && pid !== process.ppid)).toBe(true);
});

test("Missing anchors after lookup abort termination without guessed signals", async () => {
  const app = fixture(); const owner = expectOk(OwnedProcesses.capture(app.anchor, app.ops));
  app.ops.list = async () => { app.loseAnchor(); return ok([{ pid: childPid, zombie: false }]); };
  expect(expectError(await owner.stopChildren()).code).toBe("PTY_OWNERSHIP_LOST");
  expect(app.signals).toEqual([]);
});

test("Changed PID session ownership immediately before signaling skips that PID", async () => {
  const app = fixture(); let reads = 0;
  app.ops.sessionId = (pid) => pid === anchorPid ? anchorPid : pid === childPid && ++reads === 1 ? anchorPid : 42;
  const owner = expectOk(OwnedProcesses.capture(app.anchor, app.ops));
  expectOk(await owner.stopChildren()); expect(app.signals).toEqual([]);
});
