import { expect, test } from "bun:test";
import { ManualClock } from "@opentui/core/testing";
import { UsageError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { UsageMonitor } from "./monitor.ts";
import type { UsageResolver, UsageWindow } from "./model.ts";

const windows = (usedPercent = 18): UsageWindow[] => [
  { id: "weekly", usedPercent, periodMs: 604800000, resetsAt: 604800000 },
];

async function settle() {
  for (let i = 0; i < 70; i++) {
    await Promise.resolve();
  }
}

test("Post-success authentication timeouts retain last values and recover without external actions", async () => {
  // Stall only second authentication to reproduce post-sleep lookup delays.
  const clock = new ManualClock();
  const gate = Promise.withResolvers<Awaited<ReturnType<UsageResolver>>>();
  let calls = 0;
  const account = () =>
    ok({ provider: "fixture", key: "account", load: async () => ok(windows()) });
  const monitor = new UsageMonitor(
    async () => (++calls === 2 ? gate.promise : account()),
    clock,
    () => 0,
  );
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("fixture");
    monitor.setActive(true);
    await settle();

    const previous = subscription.read("fixture");

    // Failure ten seconds into the 60-second refresh makes the next retry due at 130 seconds.
    clock.advance(60000);
    await settle();
    clock.advance(10000);
    await settle();
    expect(subscription.read("fixture")).toEqual({
      ...previous,
      status: "error",
      errorCode: "USAGE_TIMEOUT",
    });
    clock.advance(50000);
    await settle();
    expect(calls).toBe(2);
    expect(clock.pendingTimerCount).toBeGreaterThan(0);
    clock.advance(9999);
    await settle();
    expect(calls).toBe(2);
    clock.advance(1);
    await settle();

    // Recover the last success without extra refresh events despite skipping a polling cycle.
    expect(calls).toBe(3);
    expect(subscription.read("fixture").status).toBe("ready");
    gate.resolve(ok(null));
    await settle();
    expect(subscription.read("fixture").status).toBe("ready");
  } finally {
    gate.resolve(ok(null));
    subscription.dispose();
    await monitor.stop();
  }
});

for (const stage of ["authentication", "usage"] as const) {
  test(`Initial ${stage} failures honor exponential backoff and success restores normal polling and initial delays`, async () => {
    // Public subscriptions verify authentication/HTTP failures share retry policies.
    const clock = new ManualClock();
    let calls = 0;
    const failure = err(new UsageError("USAGE_QUERY_FAILED", "Temporary fixture failure"));
    const succeeds = () => {
      calls++;

      return calls === 6 || calls === 8;
    };
    const monitor = new UsageMonitor(
      async () =>
        stage === "authentication" && !succeeds()
          ? failure
          : ok({
              provider: "fixture",
              key: "account",
              load: async () => (stage === "usage" && !succeeds() ? failure : ok(windows())),
            }),
      clock,
      () => 0,
    );
    const subscription = monitor.watch(() => {});
    try {
      subscription.read("fixture");
      monitor.setActive(true);
      await settle();
      expect(subscription.read("fixture").windows).toEqual([]);

      // Completion never bypasses waits and backoff caps at five minutes.
      for (const [index, delay] of [60000, 120000, 240000, 300000, 300000].entries()) {
        clock.advance(delay - 1);
        subscription.refresh();
        await settle();
        expect(calls).toBe(index + 1);
        clock.advance(1);
        await settle();
        expect(calls).toBe(index + 2);
      }

      expect(subscription.read("fixture").status).toBe("ready");
      clock.advance(59999);
      await settle();
      expect(calls).toBe(6);
      clock.advance(1);
      await settle();
      expect(calls).toBe(7);
      expect(subscription.read("fixture").status).toBe("error");
      expect(subscription.read("fixture").windows).toEqual(windows());
      clock.advance(59999);
      await settle();
      expect(calls).toBe(7);
      clock.advance(1);
      await settle();

      // New failures after success restart at 60 seconds, not accumulated five-minute delays.
      expect(calls).toBe(8);
      expect(subscription.read("fixture").status).toBe("ready");
    } finally {
      subscription.dispose();
      await monitor.stop();
    }
  });
}

test("Account-shared retries honor Retry-After without accelerating other providers", async () => {
  // Observe two same-account subscriptions alongside an independent healthy account.
  const clock = new ManualClock();
  let sharedCalls = 0;
  let quietCalls = 0;
  const monitor = new UsageMonitor(
    async (provider) =>
      ok({
        provider,
        key: provider === "quiet" ? "quiet" : "shared",
        load: async () => {
          if (provider === "quiet") {
            quietCalls++;

            return ok(windows());
          }

          return ++sharedCalls === 1
            ? err(new UsageError("USAGE_RATE_LIMITED", "Limited", 90000))
            : ok(windows(42));
        },
      }),
    clock,
    () => 0,
  );
  const a = monitor.watch(() => {});
  const b = monitor.watch(() => {});
  const quiet = monitor.watch(() => {});
  try {
    a.read("one");
    b.read("two");
    quiet.read("quiet");
    monitor.setActive(true);
    await settle();

    // Healthy accounts refresh at 60 seconds while limited accounts share requests until 90 seconds.
    clock.advance(60000);
    a.refresh();
    b.refresh();
    await settle();
    expect(sharedCalls).toBe(1);
    expect(quietCalls).toBe(2);
    clock.advance(30000);
    await settle();

    // Retry timers must not refresh healthy accounts again after only 30 seconds.
    expect(sharedCalls).toBe(2);
    expect(quietCalls).toBe(2);
    expect(a.read("one").windows[0]?.usedPercent).toBe(42);
    expect(b.read("two").windows[0]?.usedPercent).toBe(42);
  } finally {
    a.dispose();
    b.dispose();
    quiet.dispose();
    await monitor.stop();
  }
});

test("Retries apply jitter and UI detach stops waiting timers", async () => {
  // Fixed randomness makes initial backoff slightly longer than 60 seconds.
  const clock = new ManualClock();
  let calls = 0;
  const monitor = new UsageMonitor(
    async () =>
      ++calls === 1 || calls === 3
        ? err(new UsageError("USAGE_AUTH_REQUIRED", "Temporary auth failure"))
        : ok({ provider: "fixture", key: "account", load: async () => ok(windows()) }),
    clock,
    () => 0.5,
  );
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("fixture");
    monitor.setActive(true);
    await settle();

    // Run first retry after three seconds of jitter, then detach during the next wait.
    clock.advance(62999);
    await settle();
    expect(calls).toBe(1);
    clock.advance(1);
    await settle();
    expect(calls).toBe(2);
    clock.advance(60000);
    await settle();
    expect(calls).toBe(3);
    monitor.setActive(false);
    clock.advance(600000);
    await settle();
    expect(calls).toBe(3);
    expect(clock.pendingTimerCount).toBe(0);
    monitor.setActive(true);
    await settle();

    // No queries while detached; reconnect immediately retries elapsed backoff.
    expect(calls).toBe(4);
    expect(subscription.read("fixture").status).toBe("ready");
  } finally {
    subscription.dispose();
    await monitor.stop();
  }
});

for (const stage of ["authentication", "usage"] as const) {
  test(`Manual refresh bypasses ${stage} backoff and failure caches while automatic refresh keeps waiting`, async () => {
    // Neither ordinary refresh nor brief cache reuse may block manual recovery after failure.
    const clock = new ManualClock();
    let calls = 0;
    const failure = err(new UsageError("USAGE_QUERY_FAILED", "Offline"));
    const succeeds = () => ++calls > 1;
    const monitor = new UsageMonitor(
      async () =>
        stage === "authentication" && !succeeds()
          ? failure
          : ok({
              provider: "fixture",
              key: "account",
              load: async () => (stage === "usage" && !succeeds() ? failure : ok(windows(42))),
            }),
      clock,
      () => 0,
    );
    const subscription = monitor.watch(() => {});
    try {
      subscription.read("fixture");
      monitor.setActive(true);
      await settle();

      // Completion respects waits while explicit manual refresh requests immediately at the same time.
      subscription.refresh();
      await settle();
      expect(calls).toBe(1);
      subscription.refresh("manual");
      await settle();

      expect(calls).toBe(2);
      expect(subscription.read("fixture").status).toBe("ready");
      expect(subscription.read("fixture").windows).toEqual(windows(42));
      clock.advance(60000);
      await settle();
      expect(calls).toBe(3);
    } finally {
      subscription.dispose();
      await monitor.stop();
    }
  });

  test(`Manual ${stage} refresh honors Retry-After then bypasses local backoff when server waits expire`, async () => {
    // Server 30-second waits differ from the app's initial 60-second backoff.
    const clock = new ManualClock();
    let calls = 0;
    const failure = err(new UsageError("USAGE_RATE_LIMITED", "Limited", 30000));
    const succeeds = () => ++calls > 1;
    const monitor = new UsageMonitor(
      async () =>
        stage === "authentication" && !succeeds()
          ? failure
          : ok({
              provider: "fixture",
              key: "account",
              load: async () => (stage === "usage" && !succeeds() ? failure : ok(windows(42))),
            }),
      clock,
      () => 0,
    );
    const subscription = monitor.watch(() => {});
    try {
      subscription.read("fixture");
      monitor.setActive(true);
      await settle();

      // Manual refresh also honors server-specified minimum retry times.
      subscription.refresh("manual");
      await settle();
      expect(calls).toBe(1);
      clock.advance(29999);
      subscription.refresh("manual");
      await settle();
      expect(calls).toBe(1);
      clock.advance(1);
      subscription.refresh();
      await settle();
      expect(calls).toBe(1);
      subscription.refresh("manual");
      await settle();

      expect(calls).toBe(2);
      expect(subscription.read("fixture").status).toBe("ready");
    } finally {
      subscription.dispose();
      await monitor.stop();
    }
  });
}

test("Repeated manual failures retain failure counts and recover automatically at increased backoff", async () => {
  // Bypassing waits without success increases the next automatic delay to 120 seconds.
  const clock = new ManualClock();
  let calls = 0;
  const monitor = new UsageMonitor(
    async () =>
      ++calls <= 2
        ? err(new UsageError("USAGE_AUTH_REQUIRED", "Unavailable"))
        : ok({ provider: "fixture", key: "account", load: async () => ok(windows()) }),
    clock,
    () => 0,
  );
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("fixture");
    monitor.setActive(true);
    await settle();

    // Automatic events and the first 60-second cycle never reset or bypass manual-failure backoff.
    subscription.refresh("manual");
    await settle();
    expect(calls).toBe(2);
    clock.advance(60000);
    subscription.refresh();
    await settle();
    expect(calls).toBe(2);
    clock.advance(59999);
    await settle();
    expect(calls).toBe(2);
    clock.advance(1);
    await settle();

    expect(calls).toBe(3);
    expect(subscription.read("fixture").status).toBe("ready");
  } finally {
    subscription.dispose();
    await monitor.stop();
  }
});

test("Manual refreshes across subscriptions share one active account lookup", async () => {
  // Delay postfailure manual requests to overlap provider-alias calls.
  const clock = new ManualClock();
  const gate = Promise.withResolvers<Result<readonly UsageWindow[], UsageError>>();
  let calls = 0;
  const monitor = new UsageMonitor(
    async () =>
      ok({
        provider: "fixture",
        key: "shared",
        load: async () =>
          ++calls === 1 ? err(new UsageError("USAGE_QUERY_FAILED", "Offline")) : gate.promise,
      }),
    clock,
    () => 0,
  );
  const a = monitor.watch(() => {});
  const b = monitor.watch(() => {});
  try {
    a.read("one");
    b.read("two");
    await settle();
    expect(calls).toBe(1);

    // Duplicate same-provider and alias calls join one network lookup.
    a.refresh("manual");
    b.refresh("manual");
    await settle();
    a.refresh("manual");
    b.refresh("manual");
    await settle();
    expect(calls).toBe(2);
    gate.resolve(ok(windows(42)));
    await settle();

    expect(a.read("one").windows).toEqual(windows(42));
    expect(b.read("two").windows).toEqual(windows(42));
    expect(calls).toBe(2);
  } finally {
    gate.resolve(ok([]));
    a.dispose();
    b.dispose();
    await monitor.stop();
  }
});

test("First failures on new accounts never reuse old successful values for recovery", async () => {
  // Separate healthy A values from failing B to prevent stale account information.
  const clock = new ManualClock();
  let selected = "A";
  const monitor = new UsageMonitor(
    async () =>
      ok({
        provider: "fixture",
        key: selected,
        load: async () =>
          selected === "A" ? ok(windows(90)) : err(new UsageError("USAGE_QUERY_FAILED", "Offline")),
      }),
    clock,
    () => 0,
  );
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("fixture");
    await settle();
    expect(subscription.read("fixture").windows).toEqual(windows(90));

    // Once the new account is identified, even failures must not preserve A's bar.
    selected = "B";
    subscription.refresh();
    await settle();

    expect(subscription.read("fixture").status).toBe("error");
    expect(subscription.read("fixture").windows).toEqual([]);
    expect(subscription.read("fixture").updatedAt).toBeNull();
  } finally {
    subscription.dispose();
    await monitor.stop();
  }
});
