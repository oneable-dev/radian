import { expect, spyOn, test } from "bun:test";
import { ManualClock } from "@opentui/core/testing";
import { CancelledError, UsageError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { UsageMonitor } from "./monitor.ts";
import type { UsageResolver, UsageWindow } from "./model.ts";

const windows = (usedPercent = 10, resetsAt = 604800000): UsageWindow[] => [{ id: "period", usedPercent, periodMs: 604800000, resetsAt }];
async function settle() { for (let i = 0; i < 70; i++) await Promise.resolve(); }

test("새 세션은 프롬프트 없이 조회하고 같은 계정의 여러 에이전트는 한 요청을 공유한다", async () => {
  const clock = new ManualClock();
  const gate = Promise.withResolvers<Result<readonly UsageWindow[], UsageError>>();
  let calls = 0, changes = 0;
  const resolver: UsageResolver = async () => ok({ provider: "acme", key: "shared-private-account", load: async () => { calls++; return gate.promise; } });
  const monitor = new UsageMonitor(resolver, clock);
  const a = monitor.watch(() => { changes++; }), b = monitor.watch(() => { changes++; });
  try {
    expect(a.read("agent-one").status).toBe("loading"); b.read("agent-two"); await settle();
    expect(calls).toBe(1);

    gate.resolve(ok(windows())); await settle();

    expect(a.read("agent-one").status).toBe("ready");
    expect(b.read("agent-two").windows[0]?.usedPercent).toBe(10);
    expect(changes).toBeGreaterThan(0);
    expect(JSON.stringify(a.read("agent-one"))).not.toContain("shared-private-account");
  } finally { a.dispose(); b.dispose(); await monitor.stop(); }
});

test("화면 연결 중에만 주기 조회하고 재접속과 작업 완료도 캐시·요청 병합을 따른다", async () => {
  const clock = new ManualClock(); let calls = 0;
  const monitor = new UsageMonitor(async () => ok({ provider: "acme", key: "account", load: async () => ok(windows(++calls)) }), clock);
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("agent"); await settle();
    clock.advance(120000); await settle();
    expect(calls).toBe(1); // Bootstrap is allowed, but an unattached runtime must not poll forever.

    monitor.setActive(true); await settle();
    expect(calls).toBe(2);
    clock.advance(60000); await settle(); expect(calls).toBe(3);
    subscription.refresh(); subscription.refresh(); await settle(); expect(calls).toBe(3);
    clock.advance(2500); subscription.refresh(); await settle(); expect(calls).toBe(4);
    monitor.setActive(false); clock.advance(120000); await settle(); expect(calls).toBe(4);
    monitor.setActive(true); await settle(); expect(calls).toBe(5);
  } finally { subscription.dispose(); await monitor.stop(); }
  expect(clock.pendingTimerCount).toBe(0);
});

test("계정이 바뀌면 새 응답 전까지 이전 계정의 사용률을 표시하지 않는다", async () => {
  const clock = new ManualClock(); let account = "first";
  const gate = Promise.withResolvers<Result<readonly UsageWindow[], UsageError>>();
  const monitor = new UsageMonitor(async () => ok({ provider: "acme", key: account,
    load: async () => account === "first" ? ok(windows(20)) : gate.promise }), clock);
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("agent"); await settle(); expect(subscription.read("agent").windows[0]?.usedPercent).toBe(20);

    account = "second"; subscription.refresh(); await settle();

    expect(subscription.read("agent").status).toBe("loading"); expect(subscription.read("agent").windows).toEqual([]);
    gate.resolve(ok(windows(80))); await settle();
    expect(subscription.read("agent").windows[0]?.usedPercent).toBe(80);
  } finally { gate.resolve(ok([])); subscription.dispose(); await monitor.stop(); }
});

test("계정의 리셋 시각에도 새로 조회하며 새 한도를 임의로 100%로 채우지 않는다", async () => {
  const clock = new ManualClock(); let calls = 0;
  const monitor = new UsageMonitor(async () => ok({ provider: "acme", key: "account",
    load: async () => ok(windows(++calls === 1 ? 90 : 12, calls === 1 ? 5000 : 604800000)) }), clock);
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("agent"); monitor.setActive(true); await settle();

    clock.advance(5000); await settle();

    expect(calls).toBe(2); expect(subscription.read("agent").windows[0]?.usedPercent).toBe(12);
  } finally { subscription.dispose(); await monitor.stop(); }
});

test("자주 갱신하는 에이전트가 있어도 다른 제공자의 정기 조회를 계속한다", async () => {
  const clock = new ManualClock(); const calls: Record<string, number> = {};
  const monitor = new UsageMonitor(async (provider) => ok({ provider, key: provider, load: async () => {
    calls[provider] = (calls[provider] ?? 0) + 1; return ok(windows());
  } }), clock);
  const busy = monitor.watch(() => {}), quiet = monitor.watch(() => {});
  try {
    busy.read("busy"); quiet.read("quiet"); monitor.setActive(true); await settle();

    for (let i = 0; i < 6; i++) { clock.advance(10000); busy.refresh(); await settle(); }

    expect(calls.quiet).toBe(2); expect(calls.busy).toBeGreaterThan(2);
  } finally { busy.dispose(); quiet.dispose(); await monitor.stop(); }
});

test("조회 실패는 typed 상태로 전달하고 rate limit 재시도 대기 시간을 지킨다", async () => {
  const clock = new ManualClock(); let calls = 0;
  const monitor = new UsageMonitor(async () => ok({ provider: "acme", key: "account", load: async () => {
    calls++; return calls === 1 ? err(new UsageError("USAGE_RATE_LIMITED", "Limited", 120000)) : ok(windows(42));
  } }), clock);
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("agent"); monitor.setActive(true); await settle();
    expect(subscription.read("agent").errorCode).toBe("USAGE_RATE_LIMITED");

    clock.advance(60000); subscription.refresh(); await settle(); expect(calls).toBe(1);
    clock.advance(60000); await settle();

    expect(calls).toBe(2); expect(subscription.read("agent").windows[0]?.usedPercent).toBe(42);
  } finally { subscription.dispose(); await monitor.stop(); }
});

test("미지원 제공자는 값을 꾸미지 않으며 예상하지 못한 결함은 호스트 경계에 기록한다", async () => {
  const clock = new ManualClock(); const defect = new TypeError("fixture defect");
  const log = spyOn(console, "error").mockImplementation(() => {});
  const monitor = new UsageMonitor(async (provider) => { if (provider === "broken") throw defect; return ok(null); }, clock);
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("unsupported"); await settle(); expect(subscription.read("unsupported").status).toBe("unavailable");

    subscription.read("broken"); await settle();

    expect(subscription.read("broken").status).toBe("error");
    expect(log.mock.calls.some((args) => args.includes(defect))).toBe(true);
  } finally { subscription.dispose(); await monitor.stop(); log.mockRestore(); }
});

test("인증 실패도 반복 완료 이벤트마다 재시도하지 않고 다음 주기에 복구한다", async () => {
  const clock = new ManualClock(); let calls = 0;
  const monitor = new UsageMonitor(async () => ++calls === 1 ? err(new UsageError("USAGE_AUTH_REQUIRED", "Login unavailable"))
    : ok({ key: "account", provider: "acme", load: async () => ok(windows(30)) }), clock, () => 0);
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("agent"); monitor.setActive(true); await settle();
    expect(subscription.read("agent").errorCode).toBe("USAGE_AUTH_REQUIRED");

    subscription.refresh(); subscription.refresh(); await settle(); expect(calls).toBe(1);
    clock.advance(60000); await settle();

    expect(calls).toBe(2); expect(subscription.read("agent").windows[0]?.usedPercent).toBe(30);
  } finally { subscription.dispose(); await monitor.stop(); }
});

test("인증 단계가 지연돼도 조회 제한 시간이 지나면 오류 상태로 돌아온다", async () => {
  const clock = new ManualClock();
  const gate = Promise.withResolvers<Awaited<ReturnType<UsageResolver>>>();
  const monitor = new UsageMonitor(() => gate.promise, clock);
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("agent"); await settle();

    clock.advance(10000); await settle();

    expect(subscription.read("agent").errorCode).toBe("USAGE_TIMEOUT");
    gate.resolve(ok(null)); await settle();
    expect(subscription.read("agent").errorCode).toBe("USAGE_TIMEOUT");
  } finally { gate.resolve(ok(null)); subscription.dispose(); await monitor.stop(); }
});

test("시간 초과된 조회가 늦게 완료돼도 다음 조회의 캐시와 요청 소유권을 바꾸지 않는다", async () => {
  const clock = new ManualClock(); let calls = 0;
  const old = Promise.withResolvers<Result<readonly UsageWindow[], UsageError>>();
  const monitor = new UsageMonitor(async () => ok({ key: "account", provider: "acme", load: async () => ++calls === 1 ? old.promise : ok(windows(80)) }), clock, () => 0);
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("agent"); monitor.setActive(true); await settle();
    clock.advance(10000); await settle(); expect(subscription.read("agent").errorCode).toBe("USAGE_TIMEOUT");

    clock.advance(60000); subscription.refresh(); await settle();
    expect(subscription.read("agent").windows[0]?.usedPercent).toBe(80);
    old.resolve(ok(windows(10))); await settle();

    expect(calls).toBe(2); expect(subscription.read("agent").windows[0]?.usedPercent).toBe(80);
  } finally { old.resolve(ok([])); subscription.dispose(); await monitor.stop(); }
});

test("닫힌 세션의 늦은 인증 결과가 새로 열린 같은 제공자 세션을 덮어쓰지 않는다", async () => {
  const clock = new ManualClock(); let calls = 0;
  const old = Promise.withResolvers<Awaited<ReturnType<UsageResolver>>>();
  const monitor = new UsageMonitor(async () => ++calls === 1 ? old.promise : ok({ key: "new-account", provider: "acme", load: async () => ok(windows(80)) }), clock);
  const first = monitor.watch(() => {}), next = monitor.watch(() => {});
  try {
    first.read("agent"); await settle(); first.dispose();
    next.read("agent"); await settle(); expect(next.read("agent").windows[0]?.usedPercent).toBe(80);

    old.resolve(ok({ key: "old-account", provider: "acme", load: async () => ok(windows(10)) })); await settle();

    expect(next.read("agent").windows[0]?.usedPercent).toBe(80);
  } finally { old.resolve(ok(null)); next.dispose(); await monitor.stop(); }
});

test("조회 시작 전에 종료하면 인증이나 네트워크 작업을 뒤늦게 실행하지 않는다", async () => {
  const clock = new ManualClock(); let calls = 0;
  const monitor = new UsageMonitor(async () => { calls++; return ok(null); }, clock);
  monitor.watch(() => {}).read("agent");

  await monitor.stop(); await settle();

  expect(calls).toBe(0); expect(clock.pendingTimerCount).toBe(0);
});

test("종료는 진행 중 조회를 중단하고 늦은 응답과 타이머가 상태를 되살리지 못한다", async () => {
  const clock = new ManualClock(); let aborted = false, changes = 0;
  const monitor = new UsageMonitor(async () => ok({ provider: "acme", key: "account", load: (signal) => new Promise((resolve) => {
    signal.addEventListener("abort", () => { aborted = true; resolve(err(new CancelledError())); }, { once: true });
  }) }), clock);
  const subscription = monitor.watch(() => { changes++; });
  subscription.read("agent"); monitor.setActive(true); await settle(); const before = changes;

  await monitor.stop(); clock.advance(600000); await settle();

  expect(aborted).toBe(true); expect(changes).toBe(before); expect(clock.pendingTimerCount).toBe(0);
});
