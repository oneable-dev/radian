import { expect, test } from "bun:test";
import { ManualClock } from "@opentui/core/testing";
import { UsageMonitor } from "./monitor.ts";
import type { UsageWindow } from "./model.ts";
import { ok, type Result } from "../result.ts";
import type { UsageError } from "../errors.ts";

async function settle() {
  for (let i = 0; i < 60; i++) {
    await Promise.resolve();
  }
}

test("Explicit account changes clear usage immediately and reject stale previous-account responses", async () => {
  // Control only external queries to overlap slow A and immediate B results.
  const clock = new ManualClock();
  const gate = Promise.withResolvers<Result<readonly UsageWindow[], UsageError>>();
  let selected = "A";
  const window = (usedPercent: number): UsageWindow[] => [
    { id: "weekly", usedPercent, periodMs: 604800000, resetsAt: 604800000 },
  ];
  const monitor = new UsageMonitor(async () => {
    const account = selected;

    return ok({
      provider: "fixture",
      key: account,
      load: async () => (account === "A" ? gate.promise : ok(window(30))),
    });
  }, clock);
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("fixture");
    await settle();

    // Selection changes wait for neither timers nor pending requests.
    selected = "B";
    monitor.invalidate("fixture");
    expect(subscription.read("fixture").windows).toEqual([]);
    await settle();
    expect(subscription.read("fixture").windows[0]?.usedPercent).toBe(30);
    gate.resolve(ok(window(90)));
    await settle();

    // Late A completion must preserve B's limit display.
    expect(subscription.read("fixture").windows[0]?.usedPercent).toBe(30);
  } finally {
    gate.resolve(ok([]));
    subscription.dispose();
    await monitor.stop();
  }
});
