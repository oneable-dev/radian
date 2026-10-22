import { expect, test } from "bun:test";
import { ManualClock } from "@opentui/core/testing";
import { UsageMonitor } from "./monitor.ts";
import type { UsageWindow } from "./model.ts";
import { ok, type Result } from "../result.ts";
import type { UsageError } from "../errors.ts";

async function settle() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
test("명시적 계정 변경은 즉시 사용량을 비우고 늦은 이전 계정 응답으로 새 사용량을 덮어쓰지 않는다", async () => {
  // A의 느린 조회와 B의 즉시 조회가 겹치도록 외부 조회 경계만 제어한다.
  const clock = new ManualClock(), gate = Promise.withResolvers<Result<readonly UsageWindow[], UsageError>>(); let selected = "A";
  const window = (usedPercent: number): UsageWindow[] => [{ id: "weekly", usedPercent, periodMs: 604800000, resetsAt: 604800000 }];
  const monitor = new UsageMonitor(async () => {
    const account = selected; return ok({ provider: "fixture", key: account, load: async () => account === "A" ? gate.promise : ok(window(30)) });
  }, clock);
  const subscription = monitor.watch(() => {});
  try {
    subscription.read("fixture"); await settle();

    // 선택 변경 시 타이머나 기존 요청의 완료를 기다리지 않는다.
    selected = "B"; monitor.invalidate("fixture"); expect(subscription.read("fixture").windows).toEqual([]);
    await settle(); expect(subscription.read("fixture").windows[0]?.usedPercent).toBe(30);
    gate.resolve(ok(window(90))); await settle();

    // A가 늦게 완료되어도 B의 한도 표시를 유지한다.
    expect(subscription.read("fixture").windows[0]?.usedPercent).toBe(30);
  } finally { gate.resolve(ok([])); subscription.dispose(); await monitor.stop(); }
});
