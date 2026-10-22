import { expect, test } from "bun:test";
import { ManualClock } from "@opentui/core/testing";
import { UsageError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { UsageMonitor } from "./monitor.ts";
import type { UsageResolver, UsageWindow } from "./model.ts";

const windows = (usedPercent = 18): UsageWindow[] => [{ id: "weekly", usedPercent, periodMs: 604800000, resetsAt: 604800000 }];
async function settle() { for (let i = 0; i < 70; i++) await Promise.resolve(); }

test("정상 조회 뒤 인증 타임아웃이 나도 마지막 값을 보존하고 외부 조작 없이 복구한다", async () => {
  // 정상 응답 뒤 두 번째 인증만 멈추게 해 잠자기 전후의 조회 지연을 재현한다.
  const clock = new ManualClock(), gate = Promise.withResolvers<Awaited<ReturnType<UsageResolver>>>();
  let calls = 0;
  const account = () => ok({ provider: "fixture", key: "account", load: async () => ok(windows()) });
  const monitor = new UsageMonitor(async () => ++calls === 2 ? gate.promise : account(), clock, () => 0);
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("fixture"); monitor.setActive(true); await settle();
    const previous = subscription.read("fixture");

    // 60초 정기 조회가 10초 뒤 실패하면 재시도 가능 시점은 130초가 된다.
    clock.advance(60000); await settle(); clock.advance(10000); await settle();
    expect(subscription.read("fixture")).toEqual({ ...previous, status: "error", errorCode: "USAGE_TIMEOUT" });
    clock.advance(50000); await settle();
    expect(calls).toBe(2); expect(clock.pendingTimerCount).toBeGreaterThan(0);
    clock.advance(9999); await settle(); expect(calls).toBe(2);
    clock.advance(1); await settle();

    // 첫 정기 주기를 건너뛰어도 별도의 갱신 이벤트 없이 마지막 성공 상태를 되찾는다.
    expect(calls).toBe(3); expect(subscription.read("fixture").status).toBe("ready");
    gate.resolve(ok(null)); await settle();
    expect(subscription.read("fixture").status).toBe("ready");
  } finally { gate.resolve(ok(null)); subscription.dispose(); await monitor.stop(); }
});

for (const stage of ["인증", "사용량"] as const) {
  test(`첫 ${stage} 조회부터 실패해도 지수 backoff를 지키고 성공하면 정상 주기와 초기 대기로 복귀한다`, async () => {
    // 인증과 HTTP 조회의 실패 경로가 같은 재시도 정책을 따르는지 공개 구독으로 확인한다.
    const clock = new ManualClock(); let calls = 0;
    const failure = err(new UsageError("USAGE_QUERY_FAILED", "Temporary fixture failure"));
    const succeeds = () => { calls++; return calls === 6 || calls === 8; };
    const monitor = new UsageMonitor(async () => stage === "인증" && !succeeds() ? failure
      : ok({ provider: "fixture", key: "account", load: async () => stage === "사용량" && !succeeds() ? failure : ok(windows()) }), clock, () => 0);
    const subscription = monitor.watch(() => {});
    try {
      subscription.read("fixture"); monitor.setActive(true); await settle();
      expect(subscription.read("fixture").windows).toEqual([]);

      // 완료 이벤트가 와도 대기를 우회하지 않고, 대기는 최대 5분에서 멈춘다.
      for (const [index, delay] of [60000, 120000, 240000, 300000, 300000].entries()) {
        clock.advance(delay - 1); subscription.refresh(); await settle(); expect(calls).toBe(index + 1);
        clock.advance(1); await settle(); expect(calls).toBe(index + 2);
      }
      expect(subscription.read("fixture").status).toBe("ready");
      clock.advance(59999); await settle(); expect(calls).toBe(6);
      clock.advance(1); await settle(); expect(calls).toBe(7);
      expect(subscription.read("fixture").status).toBe("error");
      expect(subscription.read("fixture").windows).toEqual(windows());
      clock.advance(59999); await settle(); expect(calls).toBe(7);
      clock.advance(1); await settle();

      // 한 번 성공한 뒤의 새 실패는 누적된 5분이 아니라 다시 60초부터 대기한다.
      expect(calls).toBe(8); expect(subscription.read("fixture").status).toBe("ready");
    } finally { subscription.dispose(); await monitor.stop(); }
  });
}

test("계정 공유 재시도는 Retry-After를 지키고 다른 제공자의 정기 조회를 앞당기지 않는다", async () => {
  // 같은 계정의 두 구독과 독립적인 정상 계정을 함께 관찰한다.
  const clock = new ManualClock(); let sharedCalls = 0, quietCalls = 0;
  const monitor = new UsageMonitor(async (provider) => ok({ provider, key: provider === "quiet" ? "quiet" : "shared", load: async () => {
    if (provider === "quiet") { quietCalls++; return ok(windows()); }
    return ++sharedCalls === 1 ? err(new UsageError("USAGE_RATE_LIMITED", "Limited", 90000)) : ok(windows(42));
  } }), clock, () => 0);
  const a = monitor.watch(() => {}), b = monitor.watch(() => {}), quiet = monitor.watch(() => {});
  try {
    a.read("one"); b.read("two"); quiet.read("quiet"); monitor.setActive(true); await settle();

    // 정상 계정은 60초에 조회하고 제한된 계정은 90초까지 네트워크 요청을 공유하며 기다린다.
    clock.advance(60000); a.refresh(); b.refresh(); await settle();
    expect(sharedCalls).toBe(1); expect(quietCalls).toBe(2);
    clock.advance(30000); await settle();

    // 재시도 타이머 때문에 정상 계정을 30초 만에 다시 조회하지 않는다.
    expect(sharedCalls).toBe(2); expect(quietCalls).toBe(2);
    expect(a.read("one").windows[0]?.usedPercent).toBe(42);
    expect(b.read("two").windows[0]?.usedPercent).toBe(42);
  } finally { a.dispose(); b.dispose(); quiet.dispose(); await monitor.stop(); }
});

test("재시도에 jitter를 적용하고 UI가 분리되면 대기 타이머를 중단한다", async () => {
  // 고정 난수로 첫 backoff가 60초보다 약간 길어지는 상황을 재현한다.
  const clock = new ManualClock(); let calls = 0;
  const monitor = new UsageMonitor(async () => ++calls === 1 || calls === 3 ? err(new UsageError("USAGE_AUTH_REQUIRED", "Temporary auth failure"))
    : ok({ provider: "fixture", key: "account", load: async () => ok(windows()) }), clock, () => 0.5);
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("fixture"); monitor.setActive(true); await settle();

    // 첫 재시도는 3초 jitter 뒤에 실행하고, 다음 실패의 대기 중 UI를 분리한다.
    clock.advance(62999); await settle(); expect(calls).toBe(1);
    clock.advance(1); await settle(); expect(calls).toBe(2);
    clock.advance(60000); await settle(); expect(calls).toBe(3);
    monitor.setActive(false); clock.advance(600000); await settle();
    expect(calls).toBe(3); expect(clock.pendingTimerCount).toBe(0);
    monitor.setActive(true); await settle();

    // 화면이 없는 동안은 조회하지 않고 재접속하면 이미 지난 backoff를 즉시 재시도한다.
    expect(calls).toBe(4); expect(subscription.read("fixture").status).toBe("ready");
  } finally { subscription.dispose(); await monitor.stop(); }
});

for (const stage of ["인증", "사용량"] as const) {
  test(`수동 갱신은 ${stage} 단계의 backoff와 실패 캐시를 즉시 우회하고 자동 갱신은 대기를 유지한다`, async () => {
    // 첫 실패 직후에는 일반 갱신뿐 아니라 짧은 캐시 재사용도 수동 복구를 막아서는 안 된다.
    const clock = new ManualClock(); let calls = 0;
    const failure = err(new UsageError("USAGE_QUERY_FAILED", "Offline"));
    const succeeds = () => ++calls > 1;
    const monitor = new UsageMonitor(async () => stage === "인증" && !succeeds() ? failure
      : ok({ provider: "fixture", key: "account", load: async () => stage === "사용량" && !succeeds() ? failure : ok(windows(42)) }), clock, () => 0);
    const subscription = monitor.watch(() => {});
    try {
      subscription.read("fixture"); monitor.setActive(true); await settle();

      // 일반 완료 이벤트는 기존 대기를 지키지만 명시적 수동 갱신은 같은 시각에 바로 요청한다.
      subscription.refresh(); await settle(); expect(calls).toBe(1);
      subscription.refresh("manual"); await settle();

      expect(calls).toBe(2); expect(subscription.read("fixture").status).toBe("ready");
      expect(subscription.read("fixture").windows).toEqual(windows(42));
      clock.advance(60000); await settle(); expect(calls).toBe(3);
    } finally { subscription.dispose(); await monitor.stop(); }
  });

  test(`수동 ${stage} 갱신도 서버 Retry-After는 지키되 서버 대기가 끝나면 로컬 backoff를 우회한다`, async () => {
    // 서버는 30초를 지정하고 앱의 첫 backoff는 60초여서 두 대기 조건을 구분할 수 있다.
    const clock = new ManualClock(); let calls = 0;
    const failure = err(new UsageError("USAGE_RATE_LIMITED", "Limited", 30000));
    const succeeds = () => ++calls > 1;
    const monitor = new UsageMonitor(async () => stage === "인증" && !succeeds() ? failure
      : ok({ provider: "fixture", key: "account", load: async () => stage === "사용량" && !succeeds() ? failure : ok(windows(42)) }), clock, () => 0);
    const subscription = monitor.watch(() => {});
    try {
      subscription.read("fixture"); monitor.setActive(true); await settle();

      // 수동 갱신도 서버가 명시한 최소 시각 전에는 요청을 보내지 않는다.
      subscription.refresh("manual"); await settle(); expect(calls).toBe(1);
      clock.advance(29999); subscription.refresh("manual"); await settle(); expect(calls).toBe(1);
      clock.advance(1); subscription.refresh(); await settle(); expect(calls).toBe(1);
      subscription.refresh("manual"); await settle();

      expect(calls).toBe(2); expect(subscription.read("fixture").status).toBe("ready");
    } finally { subscription.dispose(); await monitor.stop(); }
  });
}

test("수동 재시도가 다시 실패해도 실패 횟수를 초기화하지 않고 늘어난 backoff에서 자동 복구한다", async () => {
  // 성공 없이 수동으로 대기만 우회했을 때 다음 자동 대기가 120초로 늘어나야 한다.
  const clock = new ManualClock(); let calls = 0;
  const monitor = new UsageMonitor(async () => ++calls <= 2 ? err(new UsageError("USAGE_AUTH_REQUIRED", "Unavailable"))
    : ok({ provider: "fixture", key: "account", load: async () => ok(windows()) }), clock, () => 0);
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("fixture"); monitor.setActive(true); await settle();

    // 수동 실패 직후 자동 이벤트와 첫 60초 주기가 backoff를 초기화하거나 우회하지 않는다.
    subscription.refresh("manual"); await settle(); expect(calls).toBe(2);
    clock.advance(60000); subscription.refresh(); await settle(); expect(calls).toBe(2);
    clock.advance(59999); await settle(); expect(calls).toBe(2);
    clock.advance(1); await settle();

    expect(calls).toBe(3); expect(subscription.read("fixture").status).toBe("ready");
  } finally { subscription.dispose(); await monitor.stop(); }
});

test("여러 구독의 수동 갱신도 진행 중인 계정 조회 하나를 공유한다", async () => {
  // 첫 실패 후의 수동 요청을 보류해 여러 제공자 별칭의 요청이 겹치도록 한다.
  const clock = new ManualClock(), gate = Promise.withResolvers<Result<readonly UsageWindow[], UsageError>>(); let calls = 0;
  const monitor = new UsageMonitor(async () => ok({ provider: "fixture", key: "shared", load: async () => ++calls === 1
    ? err(new UsageError("USAGE_QUERY_FAILED", "Offline")) : gate.promise }), clock, () => 0);
  const a = monitor.watch(() => {}), b = monitor.watch(() => {});
  try {
    a.read("one"); b.read("two"); await settle(); expect(calls).toBe(1);

    // 같은 제공자의 중복 호출과 서로 다른 별칭의 호출 모두 한 네트워크 조회에 합류한다.
    a.refresh("manual"); b.refresh("manual"); await settle();
    a.refresh("manual"); b.refresh("manual"); await settle(); expect(calls).toBe(2);
    gate.resolve(ok(windows(42))); await settle();

    expect(a.read("one").windows).toEqual(windows(42));
    expect(b.read("two").windows).toEqual(windows(42)); expect(calls).toBe(2);
  } finally { gate.resolve(ok([])); a.dispose(); b.dispose(); await monitor.stop(); }
});

test("다른 계정의 첫 조회가 실패하면 이전 계정의 성공값을 복구용으로 재사용하지 않는다", async () => {
  // 계정 A의 정상 값과 계정 B의 실패를 분리해 이전 계정 정보의 잔류를 막는다.
  const clock = new ManualClock(); let selected = "A";
  const monitor = new UsageMonitor(async () => ok({ provider: "fixture", key: selected,
    load: async () => selected === "A" ? ok(windows(90)) : err(new UsageError("USAGE_QUERY_FAILED", "Offline")) }), clock, () => 0);
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("fixture"); await settle(); expect(subscription.read("fixture").windows).toEqual(windows(90));

    // 새 계정을 확인한 시점부터는 실패하더라도 A의 바를 보존해서는 안 된다.
    selected = "B"; subscription.refresh(); await settle();

    expect(subscription.read("fixture").status).toBe("error");
    expect(subscription.read("fixture").windows).toEqual([]); expect(subscription.read("fixture").updatedAt).toBeNull();
  } finally { subscription.dispose(); await monitor.stop(); }
});
