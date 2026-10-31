import { expect, test } from "bun:test";
import { ManualClock } from "@opentui/core/testing";
import { CancelledError, UsageError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { UsageMonitor } from "./monitor.ts";
import type { UsageResolver, UsageWindow } from "./model.ts";

const windows = (usedPercent = 10, resetsAt = 604800000): UsageWindow[] => [
  { id: "weekly", usedPercent, periodMs: 604800000, resetsAt },
];

async function settle() {
  for (let i = 0; i < 70; i++) {
    await Promise.resolve();
  }
}

test("Groups follow connected providers without reentrant reads or detached polling", async () => {
  // Discovery alone must not start usage work before a consumer reads the group.
  const clock = new ManualClock();
  const calls: Record<string, number> = {};
  const monitor = new UsageMonitor(async (provider) => {
    calls[provider] = (calls[provider] ?? 0) + 1;

    return provider === "local"
      ? ok(null)
      : ok({ key: `private-${provider}`, provider, load: async () => ok(windows()) });
  }, clock);
  let changes = 0;
  let reading = false;
  let reentered = false;
  const group = monitor.watchAll(() => {
    changes++;
    reentered ||= reading;
    group.read();
  });
  try {
    monitor.setProviders(["anthropic", "openai", "anthropic"]);
    expect(calls).toEqual({});

    // Bootstrap returns both loading snapshots before any publication can reenter its caller.
    reading = true;
    const initial = group.read();
    reading = false;
    expect(Object.keys(initial)).toEqual(["anthropic", "openai"]);
    expect(Object.values(initial).map((value) => value.status)).toEqual(["loading", "loading"]);
    expect(changes).toBe(0);
    await settle();
    expect(group.read().anthropic?.status).toBe("ready");
    expect(group.read().openai?.status).toBe("ready");
    expect(reentered).toBe(false);
    expect(JSON.stringify(group.read())).not.toContain("private-");
    clock.advance(120000);
    await settle();
    expect(calls).toEqual({ anthropic: 1, openai: 1 });

    // Reordering and duplicate IDs do not restart work or publish redundant list changes.
    const before = changes;
    monitor.setProviders(["openai", "anthropic", "openai"]);
    expect(changes).toBe(before);
    monitor.setActive(true);
    await settle();
    const retained = group.read().openai;
    monitor.setProviders(["openai", "local"]);
    expect(Object.keys(group.read())).toEqual(["openai", "local"]);
    expect(group.read().openai).toBe(retained);
    expect(group.read().local?.status).toBe("loading");
    await settle();
    clock.advance(60000);
    await settle();

    // Removed providers lose polling ownership while unsupported providers remain explicitly unknown.
    expect(calls.anthropic).toBe(2);
    expect(calls.openai).toBe(3);
    expect(group.read().local?.status).toBe("unavailable");
    monitor.setProviders([]);
    expect(group.read()).toEqual({});
    expect(clock.pendingTimerCount).toBe(0);
    const stoppedCalls = { ...calls };
    clock.advance(600000);
    await settle();
    expect(calls).toEqual(stoppedCalls);
  } finally {
    group.dispose();
    await monitor.stop();
  }
});

test("Group callbacks can dispose consumers during discovery and usage publication", async () => {
  // Both consumers are registered before discovery, and one closes the other from the shared notification boundary.
  const clock = new ManualClock();
  let firstChanges = 0;
  let secondChanges = 0;
  let close = false;
  const monitor = new UsageMonitor(
    async (provider) => ok({ provider, key: provider, load: async () => ok(windows()) }),
    clock,
  );
  const first = monitor.watchAll(() => {
    firstChanges++;
    second.dispose();
    if (close) {
      first.dispose();
    } else {
      first.read();
    }
  });
  const second = monitor.watchAll(() => {
    secondChanges++;
  });
  try {
    first.read();
    second.read();

    // A disposed group in an in-progress discovery notification must not register fresh subscriptions.
    monitor.setProviders(["anthropic", "openai"]);
    monitor.setActive(true);
    await settle();
    expect(first.read().anthropic?.status).toBe("ready");
    expect(first.read().openai?.status).toBe("ready");
    expect(secondChanges).toBe(0);
    const before = firstChanges;
    close = true;
    clock.advance(2500);
    first.refresh("manual");
    await settle();

    // Disposing during the next publication also cancels sibling callbacks and releases the poll timer.
    expect(firstChanges).toBe(before + 1);
    expect(secondChanges).toBe(0);
    expect(clock.pendingTimerCount).toBe(0);
    expect(first.read()).toEqual({});
  } finally {
    first.dispose();
    second.dispose();
    await monitor.stop();
  }
});

test.each(["current", "group"] as const)(
  "Disposing the %s subscription preserves another subscription with the same callback",
  async (first) => {
    // Current-model and connected-provider consumers intentionally share their publication callback.
    const clock = new ManualClock();
    const calls: Record<string, number> = {};
    let changes = 0;
    const changed = () => {
      changes++;
    };
    const monitor = new UsageMonitor(
      async (provider) =>
        ok({
          provider,
          key: provider,
          load: async () => {
            calls[provider] = (calls[provider] ?? 0) + 1;

            return ok(windows(calls[provider]));
          },
        }),
      clock,
    );
    const current = monitor.watch(changed);
    const group = monitor.watchAll(changed);
    try {
      monitor.setProviders(["anthropic", "openai"]);
      current.read("openai");
      group.read();
      monitor.setActive(true);
      await settle();
      expect(calls).toEqual({ openai: 1, anthropic: 1 });

      // Removing either owner must leave the other's callback and cached account attached.
      const remaining = first === "current" ? group : current;
      (first === "current" ? current : group).dispose();
      const before = changes;
      remaining.refresh("manual");
      await settle();
      expect(changes).toBeGreaterThan(before);
      expect(current.read("openai").windows).toEqual(windows(2));
      if (first === "current") {
        expect(group.read().anthropic?.windows).toEqual(windows(2));
      }
      clock.advance(60000);
      await settle();
      expect(calls.anthropic).toBe(first === "current" ? 3 : 1);
      remaining.dispose();

      // Once the last owner leaves, neither discovery updates nor active polling revive the subscriptions.
      const finalChanges = changes;
      const finalCalls = { ...calls };
      monitor.setProviders(["new-provider"]);
      clock.advance(600000);
      await settle();
      expect(changes).toBe(finalChanges);
      expect(calls).toEqual(finalCalls);
      expect(clock.pendingTimerCount).toBe(0);
    } finally {
      current.dispose();
      group.dispose();
      await monitor.stop();
    }
  },
);

test("Provider aliases in groups share account-keyed loads and overlapping manual refreshes", async () => {
  // Distinct public provider IDs can resolve to the same private usage account.
  const clock = new ManualClock();
  let calls = 0;
  let gate = Promise.withResolvers<Result<readonly UsageWindow[], UsageError>>();
  const monitor = new UsageMonitor(
    async () =>
      ok({
        provider: "openai",
        key: "private-shared-account",
        load: async () => {
          calls++;

          return gate.promise;
        },
      }),
    clock,
  );
  const group = monitor.watchAll(() => {});
  try {
    monitor.setProviders(["openai", "openai-codex"]);
    group.read();
    await settle();
    expect(calls).toBe(1);
    gate.resolve(ok(windows(25)));
    await settle();
    expect(group.read().openai?.windows).toEqual(windows(25));
    expect(group.read()["openai-codex"]?.windows).toEqual(windows(25));

    // Both aliases and repeated refresh events join the same in-flight manual request.
    gate = Promise.withResolvers<Result<readonly UsageWindow[], UsageError>>();
    group.refresh("manual");
    await settle();
    group.refresh("manual");
    await settle();
    expect(calls).toBe(2);
    gate.resolve(ok(windows(42)));
    await settle();

    expect(Object.values(group.read()).map((value) => value.windows[0]?.usedPercent)).toEqual([
      42, 42,
    ]);
  } finally {
    gate.resolve(ok([]));
    group.dispose();
    await monitor.stop();
  }
});

test.each(["authentication", "usage"] as const)(
  "A provider's %s retry never blocks another provider's ready snapshots or reset refresh",
  async (stage) => {
    // The failing provider has its own Retry-After deadline while the healthy provider resets sooner.
    const clock = new ManualClock();
    let failures = 0;
    let healthy = 0;
    const failure = err(new UsageError("USAGE_RATE_LIMITED", "Limited", 90000));
    const succeeds = () => ++failures > 1;
    const monitor = new UsageMonitor(
      async (provider) => {
        if (provider === "anthropic" && stage === "authentication" && !succeeds()) {
          return failure;
        }

        return ok({
          provider,
          key: provider,
          load: async () => {
            if (provider === "anthropic") {
              return stage === "usage" && !succeeds() ? failure : ok(windows(42));
            }

            return ok(windows(++healthy, healthy === 1 ? 5000 : 604800000));
          },
        });
      },
      clock,
      () => 0,
    );
    const group = monitor.watchAll(() => {});
    try {
      monitor.setProviders(["anthropic", "openai"]);
      group.read();
      monitor.setActive(true);
      await settle();
      expect(group.read().anthropic?.errorCode).toBe("USAGE_RATE_LIMITED");
      expect(group.read().openai?.status).toBe("ready");

      // A reset and manual group refresh may update healthy usage, but cannot bypass the failed provider's wait.
      clock.advance(5000);
      await settle();
      expect(healthy).toBe(2);
      group.refresh("manual");
      await settle();
      expect(failures).toBe(1);
      expect(group.read().anthropic?.status).toBe("error");
      expect(group.read().openai?.windows[0]?.usedPercent).toBe(3);
      clock.advance(85000);
      await settle();

      expect(failures).toBe(2);
      expect(group.read().anthropic?.windows).toEqual(windows(42));
      expect(group.read().openai?.status).toBe("ready");
    } finally {
      group.dispose();
      await monitor.stop();
    }
  },
);

test("Removing and readding a provider rejects its stale pending authentication", async () => {
  // A disconnected provider's delayed account resolution must not overwrite its new identity.
  const clock = new ManualClock();
  const old = Promise.withResolvers<Awaited<ReturnType<UsageResolver>>>();
  let calls = 0;
  const monitor = new UsageMonitor(async (provider) => {
    if (provider === "anthropic" && ++calls === 1) {
      return old.promise;
    }

    return ok({ key: provider, provider, load: async () => ok(windows(80)) });
  }, clock);
  const group = monitor.watchAll(() => {});
  try {
    monitor.setProviders(["anthropic", "openai"]);
    group.read();
    await settle();

    // Replacing the provider list releases its old generation even though the lookup has not settled.
    monitor.setProviders(["openai"]);
    expect(group.read().anthropic).toBeUndefined();
    monitor.setProviders(["openai", "anthropic"]);
    await settle();
    old.resolve(
      ok({ key: "old-private-account", provider: "anthropic", load: async () => ok(windows(10)) }),
    );
    await settle();

    expect(group.read().anthropic?.windows).toEqual(windows(80));
    expect(group.read().openai?.windows).toEqual(windows(80));
  } finally {
    old.resolve(ok(null));
    group.dispose();
    await monitor.stop();
  }
});

test("Disposing a group before registration settles prevents new lookup work", async () => {
  // Bootstrap jobs are deferred so a closed consumer need not perform authentication or network work.
  const clock = new ManualClock();
  let calls = 0;
  const monitor = new UsageMonitor(async () => {
    calls++;

    return ok(null);
  }, clock);
  const group = monitor.watchAll(() => {});
  try {
    monitor.setProviders(["anthropic", "openai"]);
    group.read();
    group.dispose();
    monitor.setProviders(["another"]);
    monitor.setActive(true);
    await settle();

    expect(calls).toBe(0);
    expect(group.read()).toEqual({});
    expect(clock.pendingTimerCount).toBe(0);
  } finally {
    group.dispose();
    await monitor.stop();
  }
});

test("Stopping the monitor aborts every group lookup without publishing or leaving timers", async () => {
  // Each connected account is waiting on an abort-aware offline source.
  const clock = new ManualClock();
  const aborted: string[] = [];
  let changes = 0;
  const monitor = new UsageMonitor(
    async (provider) =>
      ok({
        provider,
        key: provider,
        load: (signal) =>
          new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted.push(provider);
                resolve(err(new CancelledError()));
              },
              { once: true },
            );
          }),
      }),
    clock,
  );
  const group = monitor.watchAll(() => {
    changes++;
  });
  monitor.setProviders(["anthropic", "openai"]);
  group.read();
  monitor.setActive(true);
  await settle();
  const before = changes;

  await monitor.stop();
  group.refresh("manual");
  clock.advance(600000);
  await settle();

  expect(aborted.sort()).toEqual(["anthropic", "openai"]);
  expect(changes).toBe(before);
  expect(group.read()).toEqual({});
  expect(clock.pendingTimerCount).toBe(0);
  group.dispose();
});

test("Provider minimum intervals throttle cached, automatic and manual loads across aliases and expired resets", async () => {
  // This source permits a usage lookup only every five minutes, even after an earlier quota reset.
  const clock = new ManualClock();
  let loads = 0;
  let resolutions = 0;
  const monitor = new UsageMonitor(async () => {
    resolutions++;

    return ok({
      provider: "anthropic",
      key: "shared-private-account",
      minRefreshMs: 300000,
      load: async () => ok(windows(++loads, clock.now() + 5000)),
    });
  }, clock);
  const group = monitor.watchAll(() => {});
  try {
    monitor.setProviders(["anthropic"]);
    group.read();
    monitor.setActive(true);
    await settle();
    clock.advance(5000);

    // Neither explicit refresh mode nor a newly registered alias can bypass the account-wide minimum.
    group.refresh();
    await settle();
    group.refresh("manual");
    await settle();
    monitor.setProviders(["anthropic", "claude-alias"]);
    await settle();
    expect(loads).toBe(1);
    const attempts = resolutions;
    clock.advance(294999);
    await settle();
    expect(loads).toBe(1);
    expect(resolutions).toBe(attempts);
    clock.advance(1);
    await settle();

    // Scheduling waits for the minimum instead of repeatedly retrying the expired reset timestamp.
    expect(loads).toBe(2);
    expect(group.read().anthropic?.windows[0]?.usedPercent).toBe(2);
    expect(group.read()["claude-alias"]?.windows[0]?.usedPercent).toBe(2);
    const refreshedAttempts = resolutions;
    clock.advance(299999);
    await settle();
    expect(loads).toBe(2);
    expect(resolutions).toBe(refreshedAttempts);
    clock.advance(1);
    await settle();
    expect(loads).toBe(3);
  } finally {
    group.dispose();
    await monitor.stop();
  }
});

test("Provider minimum intervals preserve timeout errors until another request is allowed", async () => {
  // A stalled first request must not turn back into loading when a throttled manual refresh cannot retry yet.
  const clock = new ManualClock();
  const old = Promise.withResolvers<Result<readonly UsageWindow[], UsageError>>();
  let calls = 0;
  let resolutions = 0;
  const monitor = new UsageMonitor(
    async () => {
      resolutions++;

      return ok({
        provider: "anthropic",
        key: "account",
        minRefreshMs: 300000,
        load: async () => (++calls === 1 ? old.promise : ok(windows(42))),
      });
    },
    clock,
    () => 0,
  );
  const group = monitor.watchAll(() => {});
  try {
    monitor.setProviders(["anthropic"]);
    group.read();
    monitor.setActive(true);
    await settle();
    clock.advance(10000);
    await settle();
    expect(group.read().anthropic?.errorCode).toBe("USAGE_TIMEOUT");

    // Explicit refresh respects the account minimum and retains the failure rather than its loading cache.
    group.refresh("manual");
    await settle();
    expect(calls).toBe(1);
    expect(resolutions).toBe(1);
    expect(group.read().anthropic?.errorCode).toBe("USAGE_TIMEOUT");
    clock.advance(290000);
    await settle();
    old.resolve(ok(windows(10)));
    await settle();

    expect(calls).toBe(2);
    expect(group.read().anthropic?.windows).toEqual(windows(42));
  } finally {
    old.resolve(ok([]));
    group.dispose();
    await monitor.stop();
  }
});

test("Server retry deadlines remain binding when a provider minimum interval has elapsed", async () => {
  // A rate limit may require a longer wait than the source's ordinary five-minute minimum.
  const clock = new ManualClock();
  let calls = 0;
  const monitor = new UsageMonitor(
    async () =>
      ok({
        provider: "anthropic",
        key: "account",
        minRefreshMs: 300000,
        load: async () =>
          ++calls === 1
            ? err(new UsageError("USAGE_RATE_LIMITED", "Limited", 600000))
            : ok(windows(42)),
      }),
    clock,
    () => 0,
  );
  const group = monitor.watchAll(() => {});
  try {
    monitor.setProviders(["anthropic"]);
    group.read();
    monitor.setActive(true);
    await settle();

    // Manual refresh cannot treat an elapsed provider minimum as permission to ignore Retry-After.
    clock.advance(300000);
    group.refresh("manual");
    await settle();
    expect(calls).toBe(1);
    expect(group.read().anthropic?.errorCode).toBe("USAGE_RATE_LIMITED");
    clock.advance(299999);
    await settle();
    expect(calls).toBe(1);
    clock.advance(1);
    await settle();

    expect(calls).toBe(2);
    expect(group.read().anthropic?.windows).toEqual(windows(42));
  } finally {
    group.dispose();
    await monitor.stop();
  }
});
