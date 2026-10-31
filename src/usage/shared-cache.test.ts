import { expect, test } from "bun:test";
import { ManualClock } from "@opentui/core/testing";
import { UsageError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { createUsageCache, UsageMonitor } from "./monitor.ts";
import type { UsageResolver, UsageWindow } from "./model.ts";

const windows = (usedPercent = 10, resetsAt = 604800000): UsageWindow[] => [
  { id: "weekly", usedPercent, periodMs: 604800000, resetsAt },
];

async function settle() {
  for (let i = 0; i < 70; i++) {
    await Promise.resolve();
  }
}

test("Worktree monitors share initial and manual account loads without merging subscriptions", async () => {
  // Worktrees share one Claude account but have independent accounts for another provider.
  const clock = new ManualClock();
  const cache = createUsageCache();
  const calls: Record<string, number> = {};
  let gate = Promise.withResolvers<Result<readonly UsageWindow[], UsageError>>();
  const resolve =
    (worktree: string): UsageResolver =>
    async (provider) => {
      const key = provider === "anthropic" ? "shared-private-account" : worktree;

      return ok({
        provider,
        key,
        load: async () => {
          calls[key] = (calls[key] ?? 0) + 1;

          return provider === "anthropic" ? gate.promise : ok(windows(calls[key]));
        },
      });
    };
  const first = new UsageMonitor(resolve("first"), clock, undefined, cache);
  const second = new UsageMonitor(resolve("second"), clock, undefined, cache);
  let firstChanges = 0;
  let secondChanges = 0;
  const firstGroup = first.watchAll(() => firstChanges++);
  const secondGroup = second.watchAll(() => secondChanges++);
  try {
    first.setProviders(["anthropic", "openai"]);
    second.setProviders(["anthropic", "openai"]);
    firstGroup.read();
    secondGroup.read();
    await settle();
    expect(calls).toEqual({ "shared-private-account": 1, first: 1, second: 1 });

    // Both waiting monitors must publish the shared result through their own callbacks.
    const before = [firstChanges, secondChanges];
    gate.resolve(ok(windows(25)));
    await settle();
    expect(firstGroup.read().anthropic?.windows).toEqual(windows(25));
    expect(secondGroup.read().anthropic?.windows).toEqual(windows(25));
    expect(firstChanges).toBeGreaterThan(before[0]!);
    expect(secondChanges).toBeGreaterThan(before[1]!);

    // Staggered manual refreshes join the pending load while unrelated accounts refresh independently.
    gate = Promise.withResolvers<Result<readonly UsageWindow[], UsageError>>();
    firstGroup.refresh("manual");
    await settle();
    secondGroup.refresh("manual");
    await settle();
    expect(calls).toEqual({ "shared-private-account": 2, first: 2, second: 2 });
    gate.resolve(ok(windows(42)));
    await settle();

    expect(firstGroup.read().anthropic?.windows).toEqual(windows(42));
    expect(secondGroup.read().anthropic?.windows).toEqual(windows(42));
    expect(JSON.stringify(secondGroup.read())).not.toContain("shared-private-account");
    first.setProviders([]);
    expect(firstGroup.read()).toEqual({});
    expect(Object.keys(secondGroup.read())).toEqual(["anthropic", "openai"]);
  } finally {
    gate.resolve(ok([]));
    firstGroup.dispose();
    secondGroup.dispose();
    await Promise.all([first.stop(), second.stop()]);
    cache.clear();
  }
});

test("Account minimum intervals span monitor registration, manual refresh and polling", async () => {
  // An expired quota window cannot bypass the account-wide five-minute request minimum.
  const clock = new ManualClock();
  const cache = createUsageCache();
  let loads = 0;
  const resolve: UsageResolver = async () =>
    ok({
      provider: "anthropic",
      key: "account",
      minRefreshMs: 300000,
      load: async () => ok(windows(++loads, clock.now() + 5000)),
    });
  const first = new UsageMonitor(resolve, clock, undefined, cache);
  const second = new UsageMonitor(resolve, clock, undefined, cache);
  const firstSubscription = first.watch(() => {});
  const secondSubscription = second.watch(() => {});
  try {
    firstSubscription.read("anthropic");
    first.setActive(true);
    await settle();
    clock.advance(5000);
    secondSubscription.read("anthropic");
    second.setActive(true);
    firstSubscription.refresh("manual");
    await settle();
    secondSubscription.refresh("manual");
    await settle();
    expect(loads).toBe(1);
    expect(secondSubscription.read("anthropic").windows).toEqual(windows(1, 5000));

    // Both pollers reach the same account deadline and coalesce that next allowed request.
    clock.advance(294999);
    await settle();
    expect(loads).toBe(1);
    clock.advance(1);
    await settle();
    expect(loads).toBe(2);
    expect(firstSubscription.read("anthropic").windows).toEqual(windows(2, 305000));
    expect(secondSubscription.read("anthropic").windows).toEqual(windows(2, 305000));

    // An inactive monitor pulls a newer shared snapshot without bypassing the next minimum.
    second.setActive(false);
    clock.advance(300000);
    await settle();
    expect(loads).toBe(3);
    secondSubscription.refresh("manual");
    await settle();
    expect(loads).toBe(3);
    expect(secondSubscription.read("anthropic").windows).toEqual(windows(3, 605000));

    // Stopping one worktree must not discard the cache or its account cooldown.
    await first.stop();
    second.invalidate("anthropic");
    await settle();
    expect(loads).toBe(3);
    expect(secondSubscription.read("anthropic").windows).toEqual(windows(3, 605000));
  } finally {
    firstSubscription.dispose();
    secondSubscription.dispose();
    await Promise.all([first.stop(), second.stop()]);
    cache.clear();
  }

  expect(clock.pendingTimerCount).toBe(0);
});

test("Shared Retry-After deadlines block manual loads in other monitors but not other accounts", async () => {
  // The server requires ten minutes, longer than this source's ordinary five-minute minimum.
  const clock = new ManualClock();
  const cache = createUsageCache();
  let limited = 0;
  let healthy = 0;
  const resolve: UsageResolver = async (provider) =>
    ok({
      provider,
      key: provider,
      minRefreshMs: provider === "anthropic" ? 300000 : 0,
      load: async () =>
        provider === "anthropic"
          ? ++limited === 1
            ? err(new UsageError("USAGE_RATE_LIMITED", "Limited", 600000))
            : ok(windows(42))
          : ok(windows(++healthy)),
    });
  const first = new UsageMonitor(resolve, clock, () => 0, cache);
  const second = new UsageMonitor(resolve, clock, () => 0, cache);
  const firstGroup = first.watchAll(() => {});
  const secondGroup = second.watchAll(() => {});
  try {
    first.setProviders(["anthropic"]);
    firstGroup.read();
    first.setActive(true);
    await settle();
    clock.advance(300000);
    second.setProviders(["anthropic", "openai"]);
    secondGroup.read();
    second.setActive(true);
    await settle();

    // A newly registered worktree inherits both the failure snapshot and its server deadline.
    firstGroup.refresh("manual");
    secondGroup.refresh("manual");
    await settle();
    expect(limited).toBe(1);
    expect(healthy).toBe(2);
    expect(secondGroup.read().anthropic?.errorCode).toBe("USAGE_RATE_LIMITED");
    expect(secondGroup.read().openai?.status).toBe("ready");
    clock.advance(299999);
    await settle();
    expect(limited).toBe(1);
    clock.advance(1);
    secondGroup.refresh("manual");
    await settle();

    expect(limited).toBe(2);
    expect(firstGroup.read().anthropic?.windows).toEqual(windows(42));
    expect(secondGroup.read().anthropic?.windows).toEqual(windows(42));
  } finally {
    firstGroup.dispose();
    secondGroup.dispose();
    await Promise.all([first.stop(), second.stop()]);
    cache.clear();
  }
});

test("Shared snapshots do not hide a monitor's authentication failure during its own retry deadline", async () => {
  // Account usage is shared, but authentication failures and retries remain local to each monitor.
  const clock = new ManualClock();
  const cache = createUsageCache();
  let unavailable = false;
  const resolve: UsageResolver = async () =>
    ok({ provider: "anthropic", key: "account", load: async () => ok(windows(42)) });
  const first = new UsageMonitor(
    async (provider, signal) =>
      unavailable
        ? err(new UsageError("USAGE_AUTH_REQUIRED", "Unavailable", 90000))
        : resolve(provider, signal),
    clock,
    () => 0,
    cache,
  );
  const second = new UsageMonitor(resolve, clock, () => 0, cache);
  const failing = first.watch(() => {});
  const healthy = second.watch(() => {});
  try {
    failing.read("anthropic");
    healthy.read("anthropic");
    await settle();
    unavailable = true;
    failing.refresh("manual");
    await settle();

    // A throttled local retry cannot replace its error with an unrelated cached success.
    failing.refresh("manual");
    failing.refresh();
    await settle();
    expect(failing.read("anthropic").errorCode).toBe("USAGE_AUTH_REQUIRED");
    expect(failing.read("anthropic").windows).toEqual(windows(42));
    expect(healthy.read("anthropic").status).toBe("ready");
  } finally {
    failing.dispose();
    healthy.dispose();
    await Promise.all([first.stop(), second.stop()]);
    cache.clear();
  }
});

test("Stopping a waiting monitor does not cancel the shared load owned by another monitor", async () => {
  // Only the monitor that starts the account load owns its AbortSignal.
  const clock = new ManualClock();
  const cache = createUsageCache();
  const gate = Promise.withResolvers<Result<readonly UsageWindow[], UsageError>>();
  let sourceSignal: AbortSignal | undefined;
  let loads = 0;
  const resolve: UsageResolver = async () =>
    ok({
      provider: "anthropic",
      key: "account",
      load: async (signal) => {
        sourceSignal = signal;
        loads++;

        return gate.promise;
      },
    });
  const first = new UsageMonitor(resolve, clock, undefined, cache);
  const second = new UsageMonitor(resolve, clock, undefined, cache);
  const owner = first.watch(() => {});
  let changes = 0;
  const waiting = second.watch(() => changes++);
  try {
    owner.read("anthropic");
    await settle();
    waiting.read("anthropic");
    await settle();
    const before = changes;

    // The waiting monitor releases its own deadline without affecting the owner's source.
    await second.stop();
    expect(sourceSignal?.aborted).toBe(false);
    gate.resolve(ok(windows(42)));
    await settle();

    expect(loads).toBe(1);
    expect(owner.read("anthropic").windows).toEqual(windows(42));
    expect(waiting.read("anthropic").status).toBe("unavailable");
    expect(changes).toBe(before);
    expect(clock.pendingTimerCount).toBe(0);
  } finally {
    gate.resolve(ok([]));
    owner.dispose();
    waiting.dispose();
    await Promise.all([first.stop(), second.stop()]);
    cache.clear();
  }
});

test.each([0, 300000])(
  "Owner cancellation releases shared waiters and preserves a %dms minimum on re-registration",
  async (minRefreshMs) => {
    // An abort-ignoring old source must not hold shared waiters or overwrite a later registration.
    const clock = new ManualClock();
    const cache = createUsageCache();
    const old = Promise.withResolvers<Result<readonly UsageWindow[], UsageError>>();
    let loads = 0;
    let sourceSignal: AbortSignal | undefined;
    const resolve: UsageResolver = async () =>
      ok({
        provider: "anthropic",
        key: "account",
        minRefreshMs,
        load: async (signal) => {
          sourceSignal ??= signal;

          return ++loads === 1 ? old.promise : ok(windows(80));
        },
      });
    const first = new UsageMonitor(resolve, clock, undefined, cache);
    const second = new UsageMonitor(resolve, clock, undefined, cache);
    const owner = first.watch(() => {});
    const waiting = second.watch(() => {});
    const registered = second.watch(() => {});
    try {
      owner.read("anthropic");
      await settle();
      waiting.read("anthropic");
      await settle();
      await first.stop();
      await settle();
      expect(sourceSignal?.aborted).toBe(true);
      expect(clock.pendingTimerCount).toBe(0);
      expect(waiting.read("anthropic").errorCode).toBeNull();

      // Re-registering the provider retains the attempt minimum but not a cancelled pending job.
      waiting.dispose();
      registered.read("anthropic");
      await settle();
      if (minRefreshMs) {
        registered.refresh("manual");
        await settle();
        expect(loads).toBe(1);
        clock.advance(minRefreshMs);
        registered.refresh("manual");
        await settle();
      }
      old.resolve(ok(windows(10)));
      await settle();

      expect(loads).toBe(2);
      expect(registered.read("anthropic").windows).toEqual(windows(80));
      expect(clock.pendingTimerCount).toBe(0);
    } finally {
      old.resolve(ok([]));
      owner.dispose();
      waiting.dispose();
      registered.dispose();
      await Promise.all([first.stop(), second.stop()]);
      cache.clear();
    }
  },
);

test("Clearing an externally owned cache after shutdown prevents late loads from resurrecting it", async () => {
  // Shutdown must settle even when a source ignores abort and its result arrives after cache reuse.
  const clock = new ManualClock();
  const cache = createUsageCache();
  const old = Promise.withResolvers<Result<readonly UsageWindow[], UsageError>>();
  let loads = 0;
  let changes = 0;
  const resolve: UsageResolver = async () =>
    ok({
      provider: "anthropic",
      key: "account",
      minRefreshMs: 300000,
      load: async () => (++loads === 1 ? old.promise : ok(windows(80))),
    });
  const first = new UsageMonitor(resolve, clock, undefined, cache);
  const second = new UsageMonitor(resolve, clock, undefined, cache);
  const replacement = new UsageMonitor(resolve, clock, undefined, cache);
  const firstSubscription = first.watch(() => changes++);
  const secondSubscription = second.watch(() => changes++);
  const replacementSubscription = replacement.watch(() => {});
  try {
    firstSubscription.read("anthropic");
    secondSubscription.read("anthropic");
    first.setActive(true);
    second.setActive(true);
    await settle();
    const before = changes;
    await Promise.all([first.stop(), second.stop()]);
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);

    // A new owner can populate the cleared cache without inheriting the old request's cooldown.
    replacementSubscription.read("anthropic");
    await settle();
    old.resolve(ok(windows(10)));
    clock.advance(600000);
    await settle();
    expect(loads).toBe(2);
    expect(changes).toBe(before);
    expect(replacementSubscription.read("anthropic").windows).toEqual(windows(80));
    expect(cache.size).toBe(1);
    expect(clock.pendingTimerCount).toBe(0);
    await replacement.stop();
    cache.clear();
    await settle();
    expect(cache.size).toBe(0);
  } finally {
    old.resolve(ok([]));
    firstSubscription.dispose();
    secondSubscription.dispose();
    replacementSubscription.dispose();
    await Promise.all([first.stop(), second.stop(), replacement.stop()]);
    cache.clear();
  }
});
