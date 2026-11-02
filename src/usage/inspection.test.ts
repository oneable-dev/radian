import { expect, spyOn, test } from "bun:test";
import { ManualClock } from "@opentui/core/testing";
import { CancelledError, UsageError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { assessAuthentication } from "../accounts/auth-assessment.ts";
import type { ProviderUsage, UsageResolver, UsageWindow } from "./model.ts";
import { createUsageCache, UsageMonitor } from "./monitor.ts";
import { anthropicUsageResolver } from "./providers/anthropic.ts";
import { openAiUsageResolver } from "./providers/openai.ts";
import { providerUsageResolver } from "./providers/index.ts";

const windows = (usedPercent = 10): UsageWindow[] => [
  { id: "five_hour", usedPercent, periodMs: 18000000, resetsAt: null },
];
const signal = () => new AbortController().signal;
const snapshot = (result: Result<ProviderUsage, unknown>): ProviderUsage => {
  if (!result.ok) {
    throw new Error("Expected a settled usage snapshot.", { cause: result.error });
  }

  return result.value;
};
async function settle() {
  for (let i = 0; i < 70; i++) {
    await Promise.resolve();
  }
}

test("Concurrent inspections and normal subscriptions share a settled account request", async () => {
  // The explicit check joins polling instead of starting a second provider probe.
  const clock = new ManualClock();
  const cache = createUsageCache();
  const gate = Promise.withResolvers<Result<readonly UsageWindow[], UsageError>>();
  let loads = 0;
  const resolve: UsageResolver = async () =>
    ok({
      key: "account",
      credentialFingerprint: "credential",
      provider: "anthropic",
      load: async () => {
        loads++;
        return gate.promise;
      },
    });
  const first = new UsageMonitor(resolve, clock, undefined, cache);
  const second = new UsageMonitor(resolve, clock, undefined, cache);
  const subscription = first.watch(() => {});
  try {
    subscription.read("anthropic");
    await settle();
    let completed = false;
    const a = first.inspect("anthropic", signal());
    const b = second.inspect("anthropic", signal()).then((result) => {
      completed = true;
      return result;
    });
    await settle();
    expect(completed).toBe(false);
    expect(loads).toBe(1);

    // Inspection must wait for the real source outcome, never return a loading snapshot.
    gate.resolve(ok(windows(25)));
    const results = await Promise.all([a, b]);

    expect(results.map((result) => snapshot(result).status)).toEqual(["ready", "ready"]);
    expect(subscription.read("anthropic").windows).toEqual(windows(25));
    expect(clock.pendingTimerCount).toBe(0);
  } finally {
    gate.resolve(ok([]));
    subscription.dispose();
    await Promise.all([first.stop(), second.stop()]);
  }
});

test("Cancelling an inspecting caller releases only its wait and preserves shared completion", async () => {
  // The first inspector can own a source that another worktree is waiting on.
  const clock = new ManualClock();
  const cache = createUsageCache();
  const gate = Promise.withResolvers<Result<readonly UsageWindow[], UsageError>>();
  let requestSignal: AbortSignal | undefined;
  const resolve: UsageResolver = async () =>
    ok({
      key: "account",
      provider: "anthropic",
      load: async (signal) => {
        requestSignal = signal;
        return gate.promise;
      },
    });
  const first = new UsageMonitor(resolve, clock, undefined, cache);
  const second = new UsageMonitor(resolve, clock, undefined, cache);
  const caller = new AbortController();
  try {
    const cancelled = first.inspect("anthropic", caller.signal);
    await settle();
    const waiting = second.inspect("anthropic", signal());
    await settle();

    caller.abort();
    const result = await cancelled;

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(CancelledError);
    expect(requestSignal?.aborted).toBe(false);
    gate.resolve(ok(windows(42)));
    expect(snapshot(await waiting).windows).toEqual(windows(42));
    expect(clock.pendingTimerCount).toBe(0);
  } finally {
    gate.resolve(ok([]));
    await Promise.all([first.stop(), second.stop()]);
  }
});

test("Late shared-source defects are logged when the inspecting caller has already cancelled", async () => {
  // Caller cancellation must not hide a later programming defect from the host boundary.
  const clock = new ManualClock();
  const gate = Promise.withResolvers<Awaited<ReturnType<UsageResolver>>>();
  const defect = new TypeError("late fixture defect");
  const log = spyOn(console, "error").mockImplementation(() => {});
  const monitor = new UsageMonitor(() => gate.promise, clock);
  const caller = new AbortController();
  try {
    const pending = monitor.inspect("anthropic", caller.signal);
    caller.abort();
    expect(!(await pending).ok).toBe(true);

    gate.reject(defect);
    await settle();

    expect(log.mock.calls.some((args) => args.includes(defect))).toBe(true);
    expect(clock.pendingTimerCount).toBe(0);
  } finally {
    gate.resolve(ok(null));
    await monitor.stop();
    log.mockRestore();
  }
});

test.each(["resolver", "anthropic-auth", "openai-auth", "checkAuth", "load"])(
  "A timed-out %s inspection logs its late defect exactly once without claiming auth loss",
  async (boundary) => {
    // Cancellation must not turn a programming defect in an SDK adapter into an ordinary abort.
    const clock = new ManualClock();
    const gate = Promise.withResolvers<never>();
    const defect = new TypeError("late timed-out fixture defect");
    const log = spyOn(console, "error").mockImplementation(() => {});
    const auth = { isUsingOAuth: () => true, getAuth: () => gate.promise };
    const resolve: UsageResolver =
      boundary === "anthropic-auth"
        ? anthropicUsageResolver(auth)
        : boundary === "openai-auth"
          ? openAiUsageResolver(auth)
          : boundary === "checkAuth"
            ? providerUsageResolver({ checkAuth: () => gate.promise, getAuth: () => gate.promise })
            : boundary === "load"
              ? async () => ok({ key: "fixture", provider: "anthropic", load: () => gate.promise })
              : () => gate.promise;
    const monitor = new UsageMonitor(resolve, clock);
    try {
      const pending = monitor.inspect(
        boundary === "openai-auth" ? "openai-codex" : "anthropic",
        signal(),
      );
      await settle();
      clock.advance(10000);
      const result = await pending;
      expect(!result.ok && result.error.code).toBe("USAGE_TIMEOUT");

      gate.reject(defect);
      await settle();
      expect(log.mock.calls.filter((args) => args.includes(defect))).toHaveLength(1);
      expect(clock.pendingTimerCount).toBe(0);
    } finally {
      gate.reject(defect);
      await monitor.stop();
      log.mockRestore();
    }
  },
);

test("Changed credentials discard stale auth evidence but preserve account minimum and Retry-After", async () => {
  // A stable named account retains quota cooldowns across accepted credential replacement.
  const clock = new ManualClock();
  let credential = "old";
  let loads = 0;
  const monitor = new UsageMonitor(
    async () =>
      ok({
        key: "named-account",
        credentialFingerprint: credential,
        provider: "anthropic",
        minRefreshMs: 300000,
        load: async () => {
          loads++;
          return loads === 1
            ? err(new UsageError("USAGE_RATE_LIMITED", "Limited", 600000))
            : ok(windows(50));
        },
      }),
    clock,
    () => 0,
  );
  try {
    expect(snapshot(await monitor.inspect("anthropic", signal())).errorCode).toBe(
      "USAGE_RATE_LIMITED",
    );

    credential = "new";
    monitor.invalidate("anthropic", { credentialsChanged: true });
    const current = snapshot(await monitor.inspect("anthropic", signal()));

    expect(current).toEqual({
      provider: "anthropic",
      status: "unavailable",
      windows: [],
      updatedAt: null,
      errorCode: null,
    });
    expect(assessAuthentication(current).status).toBe("indeterminate");
    expect(loads).toBe(1);
    clock.advance(300000);
    expect(snapshot(await monitor.inspect("anthropic", signal())).status).toBe("unavailable");
    expect(loads).toBe(1);
    clock.advance(300000);
    expect(snapshot(await monitor.inspect("anthropic", signal())).status).toBe("ready");
    expect(loads).toBe(2);
  } finally {
    await monitor.stop();
  }
});

test.each(["ready", "auth-error"])(
  "Inspection resolves credentials before reusing stale %s evidence",
  async (state) => {
    // A changed private fingerprint is detected even without an explicit invalidation notification.
    const clock = new ManualClock();
    let credential = "old";
    let loads = 0;
    let resolves = 0;
    const monitor = new UsageMonitor(
      async () => {
        resolves++;
        return ok({
          key: "named-account",
          credentialFingerprint: credential,
          provider: "anthropic",
          minRefreshMs: 300000,
          load: async () => {
            loads++;
            return state === "ready"
              ? ok(windows())
              : err(new UsageError("USAGE_AUTH_REQUIRED", "Denied"));
          },
        });
      },
      clock,
      () => 0,
    );
    try {
      await monitor.inspect("anthropic", signal());

      credential = "new";
      const current = snapshot(await monitor.inspect("anthropic", signal()));

      expect(current.status).toBe("unavailable");
      expect(current.errorCode).toBeNull();
      expect(current.updatedAt).toBeNull();
      expect(resolves).toBe(2);
      expect(loads).toBe(1);
    } finally {
      await monitor.stop();
    }
  },
);

test("A late old-credential shared response cannot republish after replacement", async () => {
  // Both worktrees initially join the old credential request, which ignores cancellation.
  const clock = new ManualClock();
  const cache = createUsageCache();
  const old = Promise.withResolvers<Result<readonly UsageWindow[], UsageError>>();
  let credential = "old";
  let loads = 0;
  const resolve: UsageResolver = async () => {
    const selected = credential;
    return ok({
      key: "named-account",
      credentialFingerprint: selected,
      provider: "anthropic",
      minRefreshMs: 300000,
      load: async () => {
        loads++;
        return selected === "old" ? old.promise : ok(windows(80));
      },
    });
  };
  const first = new UsageMonitor(resolve, clock, undefined, cache);
  const second = new UsageMonitor(resolve, clock, undefined, cache);
  const subscription = second.watch(() => {});
  try {
    const previous = first.inspect("anthropic", signal());
    subscription.read("anthropic");
    await settle();

    credential = "new";
    first.invalidate("anthropic", { credentialsChanged: true });
    second.invalidate("anthropic", { credentialsChanged: true });
    expect(snapshot(await second.inspect("anthropic", signal())).status).toBe("unavailable");
    old.resolve(ok(windows(10)));
    expect((await previous).ok).toBe(false);
    await settle();

    expect(subscription.read("anthropic").windows).toEqual([]);
    expect(loads).toBe(1);
    clock.advance(300000);
    expect(snapshot(await second.inspect("anthropic", signal())).windows).toEqual(windows(80));
    expect(loads).toBe(2);
  } finally {
    old.resolve(ok([]));
    subscription.dispose();
    await Promise.all([first.stop(), second.stop()]);
  }
});

test("Accepted reauthentication invalidates old evidence even when the fingerprint is unchanged", async () => {
  // An explicit replacement event clears old denial without inventing an authenticated success.
  const clock = new ManualClock();
  let loads = 0;
  const monitor = new UsageMonitor(
    async () =>
      ok({
        key: "named-account",
        credentialFingerprint: "same",
        provider: "anthropic",
        minRefreshMs: 300000,
        load: async () => {
          loads++;
          return err(new UsageError("USAGE_AUTH_REQUIRED", "Denied"));
        },
      }),
    clock,
  );
  try {
    expect(snapshot(await monitor.inspect("anthropic", signal())).errorCode).toBe(
      "USAGE_AUTH_REQUIRED",
    );

    monitor.invalidate("anthropic", { credentialsChanged: true });
    const current = snapshot(await monitor.inspect("anthropic", signal()));

    expect(current.status).toBe("unavailable");
    expect(current.errorCode).toBeNull();
    expect(loads).toBe(1);
  } finally {
    await monitor.stop();
  }
});

test("Inspection bounds stalled SDK resolution and preserves unexpected exception identity", async () => {
  // The usage deadline also bounds an SDK source that ignores cancellation.
  const clock = new ManualClock();
  const gate = Promise.withResolvers<Awaited<ReturnType<UsageResolver>>>();
  const defect = new TypeError("fixture implementation defect");
  const monitor = new UsageMonitor((provider) => {
    if (provider === "broken") {
      throw defect;
    }
    return gate.promise;
  }, clock);
  try {
    const pending = monitor.inspect("anthropic", signal());
    await settle();

    clock.advance(10000);
    const result = await pending;

    expect(!result.ok && result.error.code).toBe("USAGE_TIMEOUT");
    await expect(monitor.inspect("broken", signal())).rejects.toBe(defect);
    gate.resolve(ok(null));
    await settle();
    expect(clock.pendingTimerCount).toBe(0);
  } finally {
    gate.resolve(ok(null));
    await monitor.stop();
  }
});

test("An authenticated empty response is valid while unsupported usage stays indeterminate", async () => {
  // Display availability alone cannot distinguish empty authenticated quotas from no integration.
  const clock = new ManualClock();
  const monitor = new UsageMonitor(
    async (provider) =>
      provider === "unsupported"
        ? ok(null)
        : ok({ key: "account", provider: "anthropic", load: async () => ok([]) }),
    clock,
  );
  try {
    const empty = snapshot(await monitor.inspect("anthropic", signal()));
    const unsupported = snapshot(await monitor.inspect("unsupported", signal()));

    expect(empty.status).toBe("unavailable");
    expect(empty.updatedAt).toBe(0);
    expect(assessAuthentication(empty).status).toBe("valid");
    expect(unsupported.updatedAt).toBeNull();
    expect(assessAuthentication(unsupported).status).toBe("indeterminate");
  } finally {
    await monitor.stop();
  }
});

test("Credential changes during result publication cancel the inspector instead of returning old evidence", async () => {
  // A successful SDK refresh can synchronously notify consumers while inspection is settling.
  const clock = new ManualClock();
  const gate = Promise.withResolvers<Result<readonly UsageWindow[], UsageError>>();
  const monitor = new UsageMonitor(
    async () =>
      ok({
        key: "account",
        credentialFingerprint: "old",
        provider: "anthropic",
        minRefreshMs: 300000,
        load: async () => gate.promise,
      }),
    clock,
  );
  let replaced = false;
  const subscription = monitor.watch(() => {
    if (!replaced && subscription.read("anthropic").status === "ready") {
      replaced = true;
      monitor.invalidate("anthropic", { credentialsChanged: true });
    }
  });
  try {
    subscription.read("anthropic");
    const pending = monitor.inspect("anthropic", signal());
    await settle();

    gate.resolve(ok(windows()));
    const result = await pending;

    expect(replaced).toBe(true);
    expect(!result.ok && result.error.code).toBe("CANCELLED");
    expect(snapshot(await monitor.inspect("anthropic", signal())).updatedAt).toBeNull();
  } finally {
    gate.resolve(ok([]));
    subscription.dispose();
    await monitor.stop();
  }
});

test("A pre-cancelled inspection never starts SDK resolution", async () => {
  // Caller cancellation is checked before any credential work is accepted.
  const clock = new ManualClock();
  let resolves = 0;
  const monitor = new UsageMonitor(async () => {
    resolves++;
    return ok(null);
  }, clock);
  const caller = new AbortController();
  caller.abort();
  try {
    const result = await monitor.inspect("anthropic", caller.signal);

    expect(!result.ok && result.error.code).toBe("CANCELLED");
    expect(resolves).toBe(0);
    expect(clock.pendingTimerCount).toBe(0);
  } finally {
    await monitor.stop();
  }
});
