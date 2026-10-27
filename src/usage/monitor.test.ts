import { expect, spyOn, test } from "bun:test";
import { ManualClock } from "@opentui/core/testing";
import { CancelledError, UsageError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { UsageMonitor } from "./monitor.ts";
import type { UsageResolver, UsageWindow } from "./model.ts";

const windows = (usedPercent = 10, resetsAt = 604800000): UsageWindow[] => [
  { id: "period", usedPercent, periodMs: 604800000, resetsAt },
];
async function settle() {
  for (let i = 0; i < 70; i++) await Promise.resolve();
}

test("New sessions query without prompts and same-account agents share requests", async () => {
  const clock = new ManualClock();
  const gate = Promise.withResolvers<Result<readonly UsageWindow[], UsageError>>();
  let calls = 0,
    changes = 0;
  const resolver: UsageResolver = async () =>
    ok({
      provider: "acme",
      key: "shared-private-account",
      load: async () => {
        calls++;
        return gate.promise;
      },
    });
  const monitor = new UsageMonitor(resolver, clock);
  const a = monitor.watch(() => {
      changes++;
    }),
    b = monitor.watch(() => {
      changes++;
    });
  try {
    expect(a.read("agent-one").status).toBe("loading");
    b.read("agent-two");
    await settle();
    expect(calls).toBe(1);

    gate.resolve(ok(windows()));
    await settle();

    expect(a.read("agent-one").status).toBe("ready");
    expect(b.read("agent-two").windows[0]?.usedPercent).toBe(10);
    expect(changes).toBeGreaterThan(0);
    expect(JSON.stringify(a.read("agent-one"))).not.toContain("shared-private-account");
  } finally {
    a.dispose();
    b.dispose();
    await monitor.stop();
  }
});

test("Polling runs only while attached and reconnection/completion respect caches and coalescing", async () => {
  const clock = new ManualClock();
  let calls = 0;
  const monitor = new UsageMonitor(
    async () => ok({ provider: "acme", key: "account", load: async () => ok(windows(++calls)) }),
    clock,
  );
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("agent");
    await settle();
    clock.advance(120000);
    await settle();
    expect(calls).toBe(1); // Bootstrap is allowed, but an unattached runtime must not poll forever.

    monitor.setActive(true);
    await settle();
    expect(calls).toBe(2);
    clock.advance(60000);
    await settle();
    expect(calls).toBe(3);
    subscription.refresh();
    subscription.refresh();
    await settle();
    expect(calls).toBe(3);
    clock.advance(2500);
    subscription.refresh();
    await settle();
    expect(calls).toBe(4);
    monitor.setActive(false);
    clock.advance(120000);
    await settle();
    expect(calls).toBe(4);
    monitor.setActive(true);
    await settle();
    expect(calls).toBe(5);
  } finally {
    subscription.dispose();
    await monitor.stop();
  }
  expect(clock.pendingTimerCount).toBe(0);
});

test("Account changes hide previous usage until fresh responses arrive", async () => {
  const clock = new ManualClock();
  let account = "first";
  const gate = Promise.withResolvers<Result<readonly UsageWindow[], UsageError>>();
  const monitor = new UsageMonitor(
    async () =>
      ok({
        provider: "acme",
        key: account,
        load: async () => (account === "first" ? ok(windows(20)) : gate.promise),
      }),
    clock,
  );
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("agent");
    await settle();
    expect(subscription.read("agent").windows[0]?.usedPercent).toBe(20);

    account = "second";
    subscription.refresh();
    await settle();

    expect(subscription.read("agent").status).toBe("loading");
    expect(subscription.read("agent").windows).toEqual([]);
    gate.resolve(ok(windows(80)));
    await settle();
    expect(subscription.read("agent").windows[0]?.usedPercent).toBe(80);
  } finally {
    gate.resolve(ok([]));
    subscription.dispose();
    await monitor.stop();
  }
});

test("Account reset times trigger refresh without fabricating 100% fresh limits", async () => {
  const clock = new ManualClock();
  let calls = 0;
  const monitor = new UsageMonitor(
    async () =>
      ok({
        provider: "acme",
        key: "account",
        load: async () => ok(windows(++calls === 1 ? 90 : 12, calls === 1 ? 5000 : 604800000)),
      }),
    clock,
  );
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("agent");
    monitor.setActive(true);
    await settle();

    clock.advance(5000);
    await settle();

    expect(calls).toBe(2);
    expect(subscription.read("agent").windows[0]?.usedPercent).toBe(12);
  } finally {
    subscription.dispose();
    await monitor.stop();
  }
});

test("Frequent agent updates never starve other providers' scheduled polling", async () => {
  const clock = new ManualClock();
  const calls: Record<string, number> = {};
  const monitor = new UsageMonitor(
    async (provider) =>
      ok({
        provider,
        key: provider,
        load: async () => {
          calls[provider] = (calls[provider] ?? 0) + 1;
          return ok(windows());
        },
      }),
    clock,
  );
  const busy = monitor.watch(() => {}),
    quiet = monitor.watch(() => {});
  try {
    busy.read("busy");
    quiet.read("quiet");
    monitor.setActive(true);
    await settle();

    for (let i = 0; i < 6; i++) {
      clock.advance(10000);
      busy.refresh();
      await settle();
    }

    expect(calls.quiet).toBe(2);
    expect(calls.busy).toBeGreaterThan(2);
  } finally {
    busy.dispose();
    quiet.dispose();
    await monitor.stop();
  }
});

test("Lookup failures report typed state and honor rate-limit retry delays", async () => {
  const clock = new ManualClock();
  let calls = 0;
  const monitor = new UsageMonitor(
    async () =>
      ok({
        provider: "acme",
        key: "account",
        load: async () => {
          calls++;
          return calls === 1
            ? err(new UsageError("USAGE_RATE_LIMITED", "Limited", 120000))
            : ok(windows(42));
        },
      }),
    clock,
  );
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("agent");
    monitor.setActive(true);
    await settle();
    expect(subscription.read("agent").errorCode).toBe("USAGE_RATE_LIMITED");

    clock.advance(60000);
    subscription.refresh();
    await settle();
    expect(calls).toBe(1);
    clock.advance(60000);
    await settle();

    expect(calls).toBe(2);
    expect(subscription.read("agent").windows[0]?.usedPercent).toBe(42);
  } finally {
    subscription.dispose();
    await monitor.stop();
  }
});

test("Unsupported providers never invent values and unexpected bugs log at host boundaries", async () => {
  const clock = new ManualClock();
  const defect = new TypeError("fixture defect");
  const log = spyOn(console, "error").mockImplementation(() => {});
  const monitor = new UsageMonitor(async (provider) => {
    if (provider === "broken") throw defect;
    return ok(null);
  }, clock);
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("unsupported");
    await settle();
    expect(subscription.read("unsupported").status).toBe("unavailable");

    subscription.read("broken");
    await settle();

    expect(subscription.read("broken").status).toBe("error");
    expect(log.mock.calls.some((args) => args.includes(defect))).toBe(true);
  } finally {
    subscription.dispose();
    await monitor.stop();
    log.mockRestore();
  }
});

test("Authentication failures recover next cycle without retrying every completion event", async () => {
  const clock = new ManualClock();
  let calls = 0;
  const monitor = new UsageMonitor(
    async () =>
      ++calls === 1
        ? err(new UsageError("USAGE_AUTH_REQUIRED", "Login unavailable"))
        : ok({ key: "account", provider: "acme", load: async () => ok(windows(30)) }),
    clock,
    () => 0,
  );
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("agent");
    monitor.setActive(true);
    await settle();
    expect(subscription.read("agent").errorCode).toBe("USAGE_AUTH_REQUIRED");

    subscription.refresh();
    subscription.refresh();
    await settle();
    expect(calls).toBe(1);
    clock.advance(60000);
    await settle();

    expect(calls).toBe(2);
    expect(subscription.read("agent").windows[0]?.usedPercent).toBe(30);
  } finally {
    subscription.dispose();
    await monitor.stop();
  }
});

test("Authentication delays return error state after lookup deadlines", async () => {
  const clock = new ManualClock();
  const gate = Promise.withResolvers<Awaited<ReturnType<UsageResolver>>>();
  const monitor = new UsageMonitor(() => gate.promise, clock);
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("agent");
    await settle();

    clock.advance(10000);
    await settle();

    expect(subscription.read("agent").errorCode).toBe("USAGE_TIMEOUT");
    gate.resolve(ok(null));
    await settle();
    expect(subscription.read("agent").errorCode).toBe("USAGE_TIMEOUT");
  } finally {
    gate.resolve(ok(null));
    subscription.dispose();
    await monitor.stop();
  }
});

test("Late timed-out queries never change later cache or request ownership", async () => {
  const clock = new ManualClock();
  let calls = 0;
  const old = Promise.withResolvers<Result<readonly UsageWindow[], UsageError>>();
  const monitor = new UsageMonitor(
    async () =>
      ok({
        key: "account",
        provider: "acme",
        load: async () => (++calls === 1 ? old.promise : ok(windows(80))),
      }),
    clock,
    () => 0,
  );
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("agent");
    monitor.setActive(true);
    await settle();
    clock.advance(10000);
    await settle();
    expect(subscription.read("agent").errorCode).toBe("USAGE_TIMEOUT");

    clock.advance(60000);
    subscription.refresh();
    await settle();
    expect(subscription.read("agent").windows[0]?.usedPercent).toBe(80);
    old.resolve(ok(windows(10)));
    await settle();

    expect(calls).toBe(2);
    expect(subscription.read("agent").windows[0]?.usedPercent).toBe(80);
  } finally {
    old.resolve(ok([]));
    subscription.dispose();
    await monitor.stop();
  }
});

test("Late closed-session authentication never overwrites new same-provider sessions", async () => {
  const clock = new ManualClock();
  let calls = 0;
  const old = Promise.withResolvers<Awaited<ReturnType<UsageResolver>>>();
  const monitor = new UsageMonitor(
    async () =>
      ++calls === 1
        ? old.promise
        : ok({ key: "new-account", provider: "acme", load: async () => ok(windows(80)) }),
    clock,
  );
  const first = monitor.watch(() => {}),
    next = monitor.watch(() => {});
  try {
    first.read("agent");
    await settle();
    first.dispose();
    next.read("agent");
    await settle();
    expect(next.read("agent").windows[0]?.usedPercent).toBe(80);

    old.resolve(ok({ key: "old-account", provider: "acme", load: async () => ok(windows(10)) }));
    await settle();

    expect(next.read("agent").windows[0]?.usedPercent).toBe(80);
  } finally {
    old.resolve(ok(null));
    next.dispose();
    await monitor.stop();
  }
});

test("Closing before lookup starts prevents late authentication/network work", async () => {
  const clock = new ManualClock();
  let calls = 0;
  const monitor = new UsageMonitor(async () => {
    calls++;
    return ok(null);
  }, clock);
  monitor.watch(() => {}).read("agent");

  await monitor.stop();
  await settle();

  expect(calls).toBe(0);
  expect(clock.pendingTimerCount).toBe(0);
});

test("Closing aborts active queries and prevents late responses/timers from reviving state", async () => {
  const clock = new ManualClock();
  let aborted = false,
    changes = 0;
  const monitor = new UsageMonitor(
    async () =>
      ok({
        provider: "acme",
        key: "account",
        load: (signal) =>
          new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve(err(new CancelledError()));
              },
              { once: true },
            );
          }),
      }),
    clock,
  );
  const subscription = monitor.watch(() => {
    changes++;
  });
  subscription.read("agent");
  monitor.setActive(true);
  await settle();
  const before = changes;

  await monitor.stop();
  clock.advance(600000);
  await settle();

  expect(aborted).toBe(true);
  expect(changes).toBe(before);
  expect(clock.pendingTimerCount).toBe(0);
});
